'use strict';

const { Serializer } = require('./serializer');
const {
    uint8, uint16, uint32, int64, uint64,
    string: string_type, bytes: bytesType, bool: bool_type,
    array: arrayType, protocol_id_type, object_id_type,
    static_variant: staticVariantType, set: setType,
    optional: optionalType, extension: extensionType,
    time_point_sec,
    void: void_type,
    map: mapType, public_key, address,
} = require('./types');

const future_extensions = void_type;

const operation = staticVariantType([]);

const transfer_operation_fee_parameters = new Serializer('transfer_operation_fee_parameters', {
    fee: uint64,
    price_per_kbyte: uint32,
});

const limit_order_create_operation_fee_parameters = new Serializer('limit_order_create_operation_fee_parameters', {
    fee: uint64,
});

const limit_order_cancel_operation_fee_parameters = new Serializer('limit_order_cancel_operation_fee_parameters', {
    fee: uint64,
});

const call_order_update_operation_fee_parameters = new Serializer('call_order_update_operation_fee_parameters', {
    fee: uint64,
});

const fill_order_operation_fee_parameters = new Serializer('fill_order_operation_fee_parameters', {});

const asset_settle_operation_fee_parameters = new Serializer('asset_settle_operation_fee_parameters', {
    fee: uint64,
});

const limit_order_update_operation_fee_parameters = new Serializer('limit_order_update_operation_fee_parameters', {
    fee: uint64,
});

const liquidity_pool_exchange_operation_fee_parameters = new Serializer('liquidity_pool_exchange_operation_fee_parameters', {
    fee: uint64,
});

const credit_offer_accept_operation_fee_parameters = new Serializer('credit_offer_accept_operation_fee_parameters', {
    fee: uint64,
});

const credit_deal_repay_operation_fee_parameters = new Serializer('credit_deal_repay_operation_fee_parameters', {
    fee: uint64,
});

const credit_deal_update_operation_fee_parameters = new Serializer('credit_deal_update_operation_fee_parameters', {
    fee: uint64,
});

const fee_parameters = staticVariantType([
    transfer_operation_fee_parameters,
    limit_order_create_operation_fee_parameters,
    limit_order_cancel_operation_fee_parameters,
    call_order_update_operation_fee_parameters,
    fill_order_operation_fee_parameters,
]);

fee_parameters.st_operations[17] = asset_settle_operation_fee_parameters;
fee_parameters.st_operations[72] = credit_offer_accept_operation_fee_parameters;
fee_parameters.st_operations[73] = credit_deal_repay_operation_fee_parameters;
fee_parameters.st_operations[76] = credit_deal_update_operation_fee_parameters;
fee_parameters.st_operations[63] = liquidity_pool_exchange_operation_fee_parameters;
fee_parameters.st_operations[77] = limit_order_update_operation_fee_parameters;

const fee_schedule = new Serializer('fee_schedule', {
    parameters: setType(fee_parameters),
    scale: uint32,
});

const void_result = new Serializer('void_result', {});

const asset = new Serializer('asset', {
    amount: int64,
    asset_id: protocol_id_type('asset'),
});

const price = new Serializer('price', {
    base: asset,
    quote: asset,
});

const memo_data = new Serializer('memo_data', {
    from: public_key,
    to: public_key,
    nonce: uint64,
    message: bytesType(),
});

const create_take_profit_order_action = new Serializer('create_take_profit_order_action', {
    fee_asset_id: protocol_id_type('asset'),
    spread_percent: uint16,
    size_percent: uint16,
    expiration_seconds: uint32,
    repeat: bool_type,
    extensions: setType(void_type),
});

const limit_order_auto_action = staticVariantType([create_take_profit_order_action]);

const limit_order_create = new Serializer('limit_order_create', {
    fee: asset,
    seller: protocol_id_type('account'),
    amount_to_sell: asset,
    min_to_receive: asset,
    expiration: time_point_sec,
    fill_or_kill: bool_type,
    extensions: extensionType([
        { name: 'on_fill', type: arrayType(limit_order_auto_action) },
    ]),
});

const limit_order_cancel = new Serializer('limit_order_cancel', {
    fee: asset,
    fee_paying_account: protocol_id_type('account'),
    order: protocol_id_type('limit_order'),
    extensions: setType(future_extensions),
});

const call_order_update = new Serializer('call_order_update', {
    fee: asset,
    funding_account: protocol_id_type('account'),
    delta_collateral: asset,
    delta_debt: asset,
    extensions: extensionType([
        { name: 'target_collateral_ratio', type: uint16 },
    ]),
});

const fill_order = new Serializer('fill_order', {
    fee: asset,
    order_id: object_id_type,
    account_id: protocol_id_type('account'),
    pays: asset,
    receives: asset,
    fill_price: price,
    is_maker: bool_type,
});

const asset_settle = new Serializer('asset_settle', {
    fee: asset,
    account: protocol_id_type('account'),
    amount: asset,
    extensions: setType(future_extensions),
});

const transfer = new Serializer('transfer', {
    fee: asset,
    from: protocol_id_type('account'),
    to: protocol_id_type('account'),
    amount: asset,
    memo: optionalType(memo_data),
    extensions: setType(future_extensions),
});

const limit_order_update = new Serializer('limit_order_update', {
    fee: asset,
    seller: protocol_id_type('account'),
    order: protocol_id_type('limit_order'),
    new_price: optionalType(price),
    delta_amount_to_sell: optionalType(asset),
    new_expiration: optionalType(time_point_sec),
    on_fill: optionalType(arrayType(limit_order_auto_action)),
    extensions: setType(future_extensions),
});

const credit_offer_accept = new Serializer('credit_offer_accept', {
    fee: asset,
    borrower: protocol_id_type('account'),
    offer_id: protocol_id_type('credit_offer'),
    borrow_amount: asset,
    collateral: asset,
    max_fee_rate: uint32,
    min_duration_seconds: uint32,
    extensions: extensionType([
        { name: 'auto_repay', type: uint8 },
    ]),
});

const credit_deal_repay = new Serializer('credit_deal_repay', {
    fee: asset,
    account: protocol_id_type('account'),
    deal_id: protocol_id_type('credit_deal'),
    repay_amount: asset,
    credit_fee: asset,
    extensions: setType(future_extensions),
});

const credit_deal_update = new Serializer('credit_deal_update', {
    fee: asset,
    account: protocol_id_type('account'),
    deal_id: protocol_id_type('credit_deal'),
    auto_repay: uint8,
    extensions: setType(future_extensions),
});

const liquidity_pool_exchange = new Serializer('liquidity_pool_exchange', {
    fee: asset,
    account: protocol_id_type('account'),
    pool: protocol_id_type('liquidity_pool'),
    amount_to_sell: asset,
    min_to_receive: asset,
    extensions: setType(future_extensions),
});

operation.st_operations = [
    transfer,
    limit_order_create,
    limit_order_cancel,
    call_order_update,
    fill_order,
];

operation.st_operations[17] = asset_settle;
operation.st_operations[72] = credit_offer_accept;
operation.st_operations[73] = credit_deal_repay;
operation.st_operations[76] = credit_deal_update;
operation.st_operations[63] = liquidity_pool_exchange;
operation.st_operations[77] = limit_order_update;

const generic_operation_result = new Serializer('generic_operation_result', {
    new_objects: setType(object_id_type),
    updated_objects: setType(object_id_type),
    removed_objects: setType(object_id_type),
});

const generic_exchange_operation_result = new Serializer('generic_exchange_operation_result', {
    paid: arrayType(asset),
    received: arrayType(asset),
    fees: arrayType(asset),
});

const extendable_operation_result = extensionType([
    { name: 'impacted_accounts', type: setType(protocol_id_type('account')) },
    { name: 'new_objects', type: setType(object_id_type) },
    { name: 'updated_objects', type: setType(object_id_type) },
    { name: 'removed_objects', type: setType(object_id_type) },
    { name: 'paid', type: arrayType(asset) },
    { name: 'received', type: arrayType(asset) },
    { name: 'fees', type: arrayType(asset) },
]);

const operation_result = staticVariantType([
    void_result,
    object_id_type,
    asset,
    generic_operation_result,
    generic_exchange_operation_result,
    extendable_operation_result,
]);

const transaction = new Serializer('transaction', {
    ref_block_num: uint16,
    ref_block_prefix: uint32,
    expiration: time_point_sec,
    operations: arrayType(operation),
    extensions: setType(future_extensions),
});

const signed_transaction = new Serializer('signed_transaction', {
    ref_block_num: uint16,
    ref_block_prefix: uint32,
    expiration: time_point_sec,
    operations: arrayType(operation),
    extensions: setType(future_extensions),
    signatures: arrayType(bytesType(65)),
});

const processed_transaction = new Serializer('processed_transaction', {
    ref_block_num: uint16,
    ref_block_prefix: uint32,
    expiration: time_point_sec,
    operations: arrayType(operation),
    extensions: setType(future_extensions),
    signatures: arrayType(bytesType(65)),
    operation_results: arrayType(operation_result),
});

export = {
    operation,
    transaction,
    signed_transaction,
    processed_transaction,
    transfer,
    limit_order_create,
    limit_order_cancel,
    call_order_update,
    fill_order,
    asset_settle,
    limit_order_update,
    credit_offer_accept,
    credit_deal_repay,
    credit_deal_update,
    liquidity_pool_exchange,
    fee_schedule,
    fee_parameters,
    asset,
    price,
    void_result,
    transfer_operation_fee_parameters,
    limit_order_create_operation_fee_parameters,
    limit_order_cancel_operation_fee_parameters,
    call_order_update_operation_fee_parameters,
    fill_order_operation_fee_parameters,
    asset_settle_operation_fee_parameters,
    limit_order_update_operation_fee_parameters,
    credit_offer_accept_operation_fee_parameters,
    credit_deal_repay_operation_fee_parameters,
    credit_deal_update_operation_fee_parameters,
    liquidity_pool_exchange_operation_fee_parameters,
};
