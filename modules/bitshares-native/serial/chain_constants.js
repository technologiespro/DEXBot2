'use strict';

const GRAPHENE_BLOCKCHAIN_PRECISION = 100000;
const GRAPHENE_DEFAULT_MAX_TRANSACTION_SIZE = 262144;
const GRAPHENE_DEFAULT_MAX_TIME_UNTIL_EXPIRATION = 86400;
const GRAPHENE_ADDRESS_PREFIX = 'BTS';
const GRAPHENE_CHAIN_ID = '4018d7844c78f6a6c41c6a552b898022310fc5dec06da467ee7905a8dad512c8';
const GRAPHENE_100_PERCENT = 10000;
const GRAPHENE_1_PERCENT = 100;

const OP_TRANSFER = 0;
const OP_LIMIT_ORDER_CREATE = 1;
const OP_LIMIT_ORDER_CANCEL = 2;
const OP_CALL_ORDER_UPDATE = 3;
const OP_FILL_ORDER = 4;
const OP_ASSET_SETTLE = 17;
const OP_LIMIT_ORDER_UPDATE = 77;

const OPERATION_NAMES = [
    'transfer',
    'limit_order_create',
    'limit_order_cancel',
    'call_order_update',
    'fill_order',
];

OPERATION_NAMES[OP_ASSET_SETTLE] = 'asset_settle';
OPERATION_NAMES[OP_LIMIT_ORDER_UPDATE] = 'limit_order_update';

const RESERVED_SPACES = {
    relative_protocol_ids: 0,
    protocol_ids: 1,
    implementation_ids: 2,
};

const OBJECT_TYPE = {
    null: 0,
    base: 1,
    account: 2,
    asset: 3,
    force_settlement: 4,
    committee_member: 5,
    witness: 6,
    limit_order: 7,
    call_order: 8,
    custom: 9,
    proposal: 10,
    operation_history: 11,
    withdraw_permission: 12,
    vesting_balance: 13,
    worker: 14,
    balance: 15,
    htlc: 16,
    ticket: 17,
    liquidity_pool: 18,
    samet_fund: 19,
    credit_offer: 20,
    credit_deal: 21,
};

const OBJECT_SPACE_TYPE = {};
for (const [name, id] of Object.entries(OBJECT_TYPE)) {
    OBJECT_SPACE_TYPE[`1.${id}`] = name;
}

const DB_MAX_INSTANCE_ID = BigInt(2) ** BigInt(48) - BigInt(1);

module.exports = {
    GRAPHENE_BLOCKCHAIN_PRECISION,
    GRAPHENE_DEFAULT_MAX_TRANSACTION_SIZE,
    GRAPHENE_DEFAULT_MAX_TIME_UNTIL_EXPIRATION,
    GRAPHENE_ADDRESS_PREFIX,
    GRAPHENE_CHAIN_ID,
    GRAPHENE_100_PERCENT,
    GRAPHENE_1_PERCENT,
    OP_TRANSFER,
    OP_LIMIT_ORDER_CREATE,
    OP_LIMIT_ORDER_CANCEL,
    OP_CALL_ORDER_UPDATE,
    OP_FILL_ORDER,
    OP_ASSET_SETTLE,
    OP_LIMIT_ORDER_UPDATE,
    OPERATION_NAMES,
    RESERVED_SPACES,
    OBJECT_TYPE,
    OBJECT_SPACE_TYPE,
    DB_MAX_INSTANCE_ID,
};
