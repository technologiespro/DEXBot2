'use strict';

const { GRAPHENE_CHAIN_ID } = require('../serial/chain_constants');
const { ops: serialOps } = require('../serial');
const { sha256, sign } = require('../crypto/ecc');

const MAX_TX_SIZE = 64000;
const MAX_OPS_PER_TX = 200;
const DEFAULT_EXPIRE_SEC = 300;
const TX_EXPIRATION_MAX_SEC = 86400;

class TransactionTooLargeError extends Error {
    constructor(message) {
        super(message);
        this.code = 'TX_TOO_LARGE';
    }
}

class BroadcastError extends Error {
    constructor(message, result) {
        super(message);
        this.code = 'BROADCAST_ERROR';
        this.result = result;
    }
}

function getChainIdBuffer(chainClient) {
    const chainId = chainClient?.getConfig?.()?.chainId || GRAPHENE_CHAIN_ID;
    if (typeof chainId !== 'string' || !/^[0-9a-fA-F]{64}$/.test(chainId)) {
        throw new Error(`Invalid chain id for transaction signing: ${chainId}`);
    }
    return Buffer.from(chainId, 'hex');
}

function assertTxSize(buffer) {
    if (buffer.length > MAX_TX_SIZE) {
        throw new TransactionTooLargeError(`Serialized transaction size ${buffer.length} exceeds max ${MAX_TX_SIZE}`);
    }
}

function createTransactionBuilder(chainClient) {
    const ops = [];
    let refBlockNum = 0;
    let refBlockPrefix = 0;
    let expiration = null;
    let feesSet = false;

    const tx = {
        addOperation(type, params) {
            if (ops.length >= MAX_OPS_PER_TX) {
                throw new TransactionTooLargeError(`Max operations per tx (${MAX_OPS_PER_TX}) exceeded`);
            }
            ops.push({ type, params });
            feesSet = false;
            return this;
        },

        limit_order_create(data) {
            return this.addOperation('limit_order_create', data);
        },
        limit_order_cancel(data) {
            return this.addOperation('limit_order_cancel', data);
        },
        limit_order_update(data) {
            return this.addOperation('limit_order_update', data);
        },
        call_order_update(data) {
            return this.addOperation('call_order_update', data);
        },
        asset_settle(data) {
            return this.addOperation('asset_settle', data);
        },
        transfer(data) {
            return this.addOperation('transfer', data);
        },

        async setRequiredFees(feeAssetId = '1.3.0') {
            if (ops.length === 0) return;

            try {
                const opList = this._getSerializedOps();
                const fees = await chainClient.db.call('get_required_fees', [opList, feeAssetId]);
                if (Array.isArray(fees) && fees.length === ops.length) {
                    for (let i = 0; i < ops.length; i++) {
                        ops[i].params.fee = fees[i];
                    }
                }
                feesSet = true;
            } catch (err) {
                throw new Error(`Failed to fetch required fees: ${err.message}`);
            }
        },

        async fetchRefBlock() {
            try {
                const globals = await chainClient.db.get_objects(['2.0.0', '2.1.0']);
                if (globals && globals.length >= 2) {
                    const dgp = globals[1];
                    if (dgp) {
                        refBlockNum = Number(dgp.head_block_number) & 0xFFFF;
                        refBlockPrefix = Buffer.from(dgp.head_block_id, 'hex').readUInt32LE(4);
                        return;
                    }
                }
            } catch (_) {}

            try {
                const dgp = await chainClient.db.get_dynamic_global_properties();
                if (dgp) {
                    refBlockNum = Number(dgp.head_block_number) & 0xFFFF;
                    try {
                        refBlockPrefix = Buffer.from(dgp.head_block_id, 'hex').readUInt32LE(4);
                    } catch (_) {
                        refBlockPrefix = 0;
                    }
                    return;
                }
            } catch (_) {}

            throw new Error('Failed to fetch reference block for transaction');
        },

        setExpiration(seconds = DEFAULT_EXPIRE_SEC) {
            const expireSeconds = Math.min(seconds, TX_EXPIRATION_MAX_SEC);
            const expireDate = new Date(Date.now() + expireSeconds * 1000);
            expiration = Math.floor(expireDate.getTime() / 1000);
        },

        async prepare(feeAssetId = '1.3.0') {
            await this.fetchRefBlock();
            if (!expiration) this.setExpiration();
            await this.setRequiredFees(feeAssetId);
            return this._serializeUnsigned();
        },



        _serializeUnsigned() {
            const unsignedOps = [];
            for (const { type, params } of ops) {
                unsignedOps.push(this._buildSerializedOp(type, params));
            }

            const txData = {
                ref_block_num: refBlockNum,
                ref_block_prefix: refBlockPrefix,
                expiration: expiration || (Math.floor(Date.now() / 1000) + DEFAULT_EXPIRE_SEC),
                operations: unsignedOps,
                extensions: [],
            };

            const buffer = serialOps.transaction.toBuffer(txData);
            assertTxSize(buffer);
            return buffer;
        },

        _buildSerializedOp(type, params) {
            const opTypeIds = {
                transfer: 0,
                limit_order_create: 1,
                limit_order_cancel: 2,
                call_order_update: 3,
                fill_order: 4,
                asset_settle: 17,
                limit_order_update: 77,
            };

            const typeId = opTypeIds[type];
            const serializer = serialOps[type];

            if (!serializer) {
                throw new Error(`Unknown operation type: ${type}`);
            }

            const castFn = this._castParamsToSerializable(type, params);

            return [typeId, castFn];
        },

        _castParamsToSerializable(type, params) {
            const result = { ...params };

            result.fee = result.fee || { amount: 0, asset_id: '1.3.0' };

            if (result.delta_amount_to_sell) {
                result.delta_amount_to_sell = { ...result.delta_amount_to_sell };
            }

            if (type === 'limit_order_update') {
                if (result.new_price) {
                    result.new_price = {
                        ...result.new_price,
                        base: { ...result.new_price.base },
                        quote: { ...result.new_price.quote },
                    };
                }
            }

            if (result.amount_to_sell) result.amount_to_sell = { ...result.amount_to_sell };
            if (result.min_to_receive) result.min_to_receive = { ...result.min_to_receive };
            if (result.amount) result.amount = { ...result.amount };

            return result;
        },

        sign(privateKey) {
            const unsignedTx = this._serializeUnsigned();
            const digest = sha256(Buffer.concat([getChainIdBuffer(chainClient), unsignedTx]));

            const sig = sign(digest, privateKey);

            const opList = [];
            for (const { type, params } of ops) {
                opList.push(this._buildSerializedOp(type, params));
            }

            const txData = {
                ref_block_num: refBlockNum,
                ref_block_prefix: refBlockPrefix,
                expiration: expiration || (Math.floor(Date.now() / 1000) + DEFAULT_EXPIRE_SEC),
                operations: opList,
                extensions: [],
                signatures: [sig],
            };

            const signedTx = serialOps.signed_transaction.toBuffer(txData);
            assertTxSize(signedTx);

            const txDataForJson = {
                ...txData,
                signatures: [sig.toString('hex')],
            };
            const signedTxObject = serialOps.signed_transaction.toObject(txDataForJson);

            return {
                signedTx,
                signedTxObject,
                digest,
                signature: sig,
            };
        },

        async broadcast() {
            return null;
        },

        _getSerializedOps() {
            return ops.map(o => this._buildSerializedOp(o.type, o.params));
        },

        getOperationCount() { return ops.length; },
        getOperations() { return [...ops]; },
    };

    return tx;
}

module.exports = {
    createTransactionBuilder,
    TransactionTooLargeError,
    BroadcastError,
    MAX_TX_SIZE,
    MAX_OPS_PER_TX,
};
