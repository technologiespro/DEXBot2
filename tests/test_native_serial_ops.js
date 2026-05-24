/**
 * tests/test_native_serial_ops.js - Native operation serialization snapshots.
 *
 * These snapshots pin the wire bytes for the operation types DEXBot2 signs.
 * Mainnet corpus validation is handled by the native release gate.
 */

const assert = require('assert');
const { ops: nativeOps } = require('../modules/bitshares-native/serial');

console.log('=== Native Serial Ops Snapshot Tests ===\n');

function assertSnapshot(name, serializer, payload, expectedHex) {
    const buffer = serializer.toBuffer(payload);
    const actualHex = buffer.toString('hex');
    assert.strictEqual(actualHex, expectedHex, `${name} serialized hex changed`);

    const roundTrip = serializer.fromBuffer(buffer);
    assert.ok(roundTrip, `${name}: fromBuffer returned null`);
}

const CASES = [
    ['asset', nativeOps.asset, {
        amount: 1000000,
        asset_id: '1.3.0',
    }, '40420f000000000000'],

    ['price', nativeOps.price, {
        base: { amount: 100, asset_id: '1.3.0' },
        quote: { amount: 5000, asset_id: '1.3.1' },
    }, '640000000000000000881300000000000001'],

    ['transfer', nativeOps.transfer, {
        fee: { amount: 100, asset_id: '1.3.0' },
        from: '1.2.100',
        to: '1.2.200',
        amount: { amount: 1000000, asset_id: '1.3.0' },
        memo: null,
        extensions: [],
    }, '64000000000000000064c80140420f0000000000000000'],

    ['limit_order_create', nativeOps.limit_order_create, {
        fee: { amount: 100, asset_id: '1.3.0' },
        seller: '1.2.12345',
        amount_to_sell: { amount: 50000000, asset_id: '1.3.0' },
        min_to_receive: { amount: 100000000, asset_id: '1.3.1' },
        expiration: 1700000000,
        fill_or_kill: false,
        extensions: {},
    }, '640000000000000000b96080f0fa02000000000000e1f505000000000100f153650000'],

    ['limit_order_cancel', nativeOps.limit_order_cancel, {
        fee: { amount: 0, asset_id: '1.3.0' },
        fee_paying_account: '1.2.12345',
        order: '1.7.999',
        extensions: [],
    }, '000000000000000000b960e70700'],

    ['call_order_update', nativeOps.call_order_update, {
        fee: { amount: 100, asset_id: '1.3.0' },
        funding_account: '1.2.12345',
        delta_collateral: { amount: 1000000, asset_id: '1.3.0' },
        delta_debt: { amount: 500000, asset_id: '1.3.1' },
        extensions: {},
    }, '640000000000000000b96040420f00000000000020a10700000000000100'],

    ['asset_settle', nativeOps.asset_settle, {
        fee: { amount: 100, asset_id: '1.3.0' },
        account: '1.2.12345',
        amount: { amount: 1000000, asset_id: '1.3.1' },
        extensions: [],
    }, '640000000000000000b96040420f00000000000100'],

    ['limit_order_update_all', nativeOps.limit_order_update, {
        fee: { amount: 100, asset_id: '1.3.0' },
        seller: '1.2.12345',
        order: '1.7.999',
        new_price: {
            base: { amount: 500, asset_id: '1.3.0' },
            quote: { amount: 10000, asset_id: '1.3.1' },
        },
        delta_amount_to_sell: { amount: 1000, asset_id: '1.3.0' },
        new_expiration: 1700000000,
        on_fill: [],
        extensions: [],
    }, '640000000000000000b960e70701f4010000000000000010270000000000000101e803000000000000000100f15365010000'],

    ['limit_order_update_min', nativeOps.limit_order_update, {
        fee: { amount: 100, asset_id: '1.3.0' },
        seller: '1.2.12345',
        order: '1.7.999',
        extensions: [],
    }, '640000000000000000b960e7070000000000'],

    ['transaction', nativeOps.transaction, {
        ref_block_num: 12345 & 0xFFFF,
        ref_block_prefix: 0xCAFEBABE,
        expiration: 1700000300,
        operations: [],
        extensions: [],
    }, '3930bebafeca2cf253650000'],

    ['signed_transaction', nativeOps.signed_transaction, {
        ref_block_num: 12345 & 0xFFFF,
        ref_block_prefix: 0xCAFEBABE,
        expiration: 1700000300,
        operations: [],
        extensions: [],
        signatures: [Buffer.concat([Buffer.from([0x1f]), Buffer.alloc(64)])],
    }, '3930bebafeca2cf253650000011f00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'],

    ['fee_schedule', nativeOps.fee_schedule, {
        parameters: [],
        scale: 10000,
    }, '0010270000'],
];

for (const [name, serializer, payload, expectedHex] of CASES) {
    assertSnapshot(name, serializer, payload, expectedHex);
    console.log(`  PASS: ${name}`);
}

console.log('\n=== All native serial op snapshots passed ===');
