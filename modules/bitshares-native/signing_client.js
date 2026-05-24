'use strict';

const { createTransactionBuilder } = require('./tx/builder');

function createSigningClient(chainClient, accountName, privateKey) {
    if (!chainClient) throw new Error('chainClient is required');
    if (!accountName) throw new Error('accountName is required');
    if (!privateKey) throw new Error('privateKey is required');

    let _accountId = null;
    let _initResolved = false;
    let _initPromise = null;

    _initPromise = (async () => {
        try {
            const full = await chainClient.db.get_full_accounts([accountName], false);
            if (full && full[0]) {
                if (full[0][1] && full[0][1].account && full[0][1].account.id) {
                    _accountId = full[0][1].account.id;
                }
            }
            _initResolved = true;
        } catch (err) {
            console.warn(`[signing_client] Failed to resolve account ${accountName}: ${err.message}`);
            _initResolved = true;
        }
    })();

    function newTx() {
        const tx = createTransactionBuilder(chainClient);

        const origSign = tx.sign.bind(tx);
        tx.sign = function() {
            return origSign(Buffer.isBuffer(privateKey)
                ? privateKey
                : wifToBuffer(privateKey));
        };

        return wrapTxForBtsdexCompat(tx, chainClient, privateKey);
    }

    function wifToBuffer(wif) {
        if (typeof wif !== 'string') return wif;
        try {
            const { wifDecode } = require('./crypto/ecc');
            return wifDecode(wif).privateKey;
        } catch (_) {
            return Buffer.from(wif, 'hex');
        }
    }

    function wrapTxForBtsdexCompat(tx, client, key) {
        const wrapped = {
            initPromise: _initPromise,

            limit_order_create(data) {
                if (data.on_fill && Array.isArray(data.on_fill)) {
                    data.extensions = data.extensions || {};
                    data.extensions.on_fill = data.on_fill;
                }
                delete data.on_fill;
                return tx.limit_order_create(data);
            },

            limit_order_cancel(data) { return tx.limit_order_cancel(data); },
            limit_order_update(data) { return tx.limit_order_update(data); },
            call_order_update(data) { return tx.call_order_update(data); },
            asset_settle(data) { return tx.asset_settle(data); },
            transfer(data) { return tx.transfer(data); },

            addOperation(type, params) { return tx.addOperation(type, params); },

            async broadcast() {
                await tx.prepare();
                const keyBuf = wifToBuffer(key);
                const signed = tx.sign(keyBuf);
                const broadcast = client.broadcast || {};
                const broadcastFn = typeof broadcast.broadcast_transaction_synchronous === 'function'
                    ? broadcast.broadcast_transaction_synchronous.bind(broadcast)
                    : typeof broadcast.broadcast_transaction === 'function'
                        ? broadcast.broadcast_transaction.bind(broadcast)
                        : null;
                if (!broadcastFn) {
                    throw new Error('Broadcast API does not support transaction broadcast');
                }
                const result = await broadcastFn(signed.signedTxObject);

                const opResults = (result && Array.isArray(result.operation_results))
                    ? result.operation_results
                    : (result && result.trx && Array.isArray(result.trx.operation_results))
                        ? result.trx.operation_results
                        : (Array.isArray(result) && result[0] && result[0].trx && Array.isArray(result[0].trx.operation_results))
                            ? result[0].trx.operation_results
                            : [];

                if (Array.isArray(result)) {
                    return { raw: result, operation_results: opResults };
                }

                return { ...result, operation_results: opResults };
            },

            setRequiredFees(feeAssetId) {
                return tx.setRequiredFees(feeAssetId);
            },

            getOperationCount() { return tx.getOperationCount(); },
        };

        return new Proxy(wrapped, {
            get(target, prop) {
                if (typeof prop === 'string' && !(prop in target)) {
                    return (data) => tx.addOperation(prop, data);
                }
                return target[prop];
            },
        });
    }

    async function broadcast(operation) {
        const tx = newTx();
        if (operation && operation.op_name && typeof tx[operation.op_name] === 'function') {
            tx[operation.op_name](operation.op_data);
        } else if (operation && operation.op_name) {
            tx.addOperation(operation.op_name, operation.op_data);
        } else {
            throw new Error('Operation must have op_name and op_data');
        }
        return tx.broadcast();
    }

    return {
        client: {
            initPromise: _initPromise,
            newTx,
            broadcast,
            accountId: _accountId,
            accountName,
        },
        newTx,
        broadcast,
        accountName,
        accountId() { return _accountId; },
    };
}

module.exports = { createSigningClient };
