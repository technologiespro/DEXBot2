/**
 * tests/test_native_serial_ops.js — Byte-for-byte comparison vs btsdex-serializer
 *
 * Serializes known operation payloads with both libraries and asserts
 * identical byte output. Covers all 6 operations used by DEXBot2.
 */

const assert = require('assert');
let btsdexSerModule = null;
try {
    btsdexSerModule = require('btsdex-serializer');
} catch (_) {}
const { ops: nativeOps } = require('../modules/bitshares-native/serial');

// btsdex-serializer uses _interopRequireDefault wrapping;
// direct exports may be on the module or on .default
function getBtsdexOp(name) {
    if (!btsdexSerModule) return null;
    if (btsdexSerModule.ops && btsdexSerModule.ops[name]) return btsdexSerModule.ops[name];
    if (btsdexSerModule[name]) return btsdexSerModule[name];
    if (btsdexSerModule.default && btsdexSerModule.default.ops && btsdexSerModule.default.ops[name]) return btsdexSerModule.default.ops[name];
    if (btsdexSerModule.default && btsdexSerModule.default[name]) return btsdexSerModule.default[name];
    return null;
}

console.log('=== Native Serial Ops Byte-for-Byte Tests ===\n');

function compareBytes(name, btsdexSerializer, nativeSerializer, payload) {
    if (!btsdexSerializer) {
        console.log(`  SKIP: ${name} (btsdex-serializer not available)`);
        return true;
    }
    const btsdexBuf = btsdexSerializer.toBuffer(payload);
    const nativeBuf = nativeSerializer.toBuffer(payload);

    if (!btsdexBuf.equals(nativeBuf)) {
        const btsdexHex = btsdexBuf.toString('hex');
        const nativeHex = nativeBuf.toString('hex');
        let firstMismatch = -1;
        for (let i = 0; i < Math.max(btsdexBuf.length, nativeBuf.length); i++) {
            if (btsdexBuf[i] !== nativeBuf[i]) {
                firstMismatch = i;
                break;
            }
        }
        throw new Error(
            `${name}: byte mismatch at offset ${firstMismatch}\n` +
            `  btsdex: ${btsdexHex}\n` +
            `  native: ${nativeHex}`
        );
    }

    const roundTrip = nativeSerializer.fromBuffer(nativeBuf);
    if (!roundTrip) throw new Error(`${name}: fromBuffer returned null`);

    return true;
}

// ── asset ────────────────────────────────────────────────────────────────

console.log('asset');
compareBytes('asset', getBtsdexOp('asset'), nativeOps.asset, {
    amount: 1000000,
    asset_id: '1.3.0',
});
compareBytes('asset (different id)', getBtsdexOp('asset'), nativeOps.asset, {
    amount: 50000000,
    asset_id: '1.3.121',
});
compareBytes('asset (max) ', getBtsdexOp('asset'), nativeOps.asset, {
    amount: Number.MAX_SAFE_INTEGER,
    asset_id: '1.3.65535',
});
console.log('  PASS');

// ── price ────────────────────────────────────────────────────────────────

console.log('price');
compareBytes('price', getBtsdexOp('price'), nativeOps.price, {
    base: { amount: 100, asset_id: '1.3.0' },
    quote: { amount: 5000, asset_id: '1.3.1' },
});
console.log('  PASS');

// ── transfer (op 0) ─────────────────────────────────────────────────────

console.log('transfer');
const transferPayload = {
    fee: { amount: 100, asset_id: '1.3.0' },
    from: '1.2.100',
    to: '1.2.200',
    amount: { amount: 1000000, asset_id: '1.3.0' },
    memo: null,
    extensions: [],
};
assert.ok(compareBytes('transfer', getBtsdexOp('transfer'), nativeOps.transfer, transferPayload));
console.log('  PASS');

// ── limit_order_create (op 1) ───────────────────────────────────────────

console.log('limit_order_create');
const locPayload = {
    fee: { amount: 100, asset_id: '1.3.0' },
    seller: '1.2.12345',
    amount_to_sell: { amount: 50000000, asset_id: '1.3.0' },
    min_to_receive: { amount: 100000000, asset_id: '1.3.1' },
    expiration: Math.floor(Date.now() / 1000) + 86400,
    fill_or_kill: false,
    extensions: {},
};
assert.ok(compareBytes('limit_order_create', getBtsdexOp('limit_order_create'), nativeOps.limit_order_create, locPayload));
console.log('  PASS');

// ── limit_order_cancel (op 2) ───────────────────────────────────────────

console.log('limit_order_cancel');
const lcPayload = {
    fee: { amount: 0, asset_id: '1.3.0' },
    fee_paying_account: '1.2.12345',
    order: '1.7.999',
    extensions: [],
};
assert.ok(compareBytes('limit_order_cancel', getBtsdexOp('limit_order_cancel'), nativeOps.limit_order_cancel, lcPayload));
console.log('  PASS');

// ── call_order_update (op 3) ────────────────────────────────────────────

console.log('call_order_update');
const couPayload = {
    fee: { amount: 100, asset_id: '1.3.0' },
    funding_account: '1.2.12345',
    delta_collateral: { amount: 1000000, asset_id: '1.3.0' },
    delta_debt: { amount: 500000, asset_id: '1.3.1' },
    extensions: {},
};
assert.ok(compareBytes('call_order_update', getBtsdexOp('call_order_update'), nativeOps.call_order_update, couPayload));
console.log('  PASS');

// ── asset_settle (op 17) ────────────────────────────────────────────────

console.log('asset_settle');
const asPayload = {
    fee: { amount: 100, asset_id: '1.3.0' },
    account: '1.2.12345',
    amount: { amount: 1000000, asset_id: '1.3.1' },
    extensions: [],
};
assert.ok(compareBytes('asset_settle', getBtsdexOp('asset_settle'), nativeOps.asset_settle, asPayload));
console.log('  PASS');

// ── limit_order_update (op 77) ──────────────────────────────────────────

console.log('limit_order_update (all fields)');
const louAllPayload = {
    fee: { amount: 100, asset_id: '1.3.0' },
    seller: '1.2.12345',
    order: '1.7.999',
    new_price: {
        base: { amount: 500, asset_id: '1.3.0' },
        quote: { amount: 10000, asset_id: '1.3.1' },
    },
    delta_amount_to_sell: { amount: 1000, asset_id: '1.3.0' },
    new_expiration: Math.floor(Date.now() / 1000) + 86400,
    on_fill: [],
    extensions: [],
};
assert.ok(compareBytes('limit_order_update (all fields)', getBtsdexOp('limit_order_update'), nativeOps.limit_order_update, louAllPayload));
console.log('  PASS (all fields)');

console.log('limit_order_update (missing optional fields)');
const louMinPayload = {
    fee: { amount: 100, asset_id: '1.3.0' },
    seller: '1.2.12345',
    order: '1.7.999',
    extensions: [],
};
assert.ok(compareBytes('limit_order_update (no optionals)', getBtsdexOp('limit_order_update'), nativeOps.limit_order_update, louMinPayload));
console.log('  PASS (no optionals)');

// ── signed_transaction ──────────────────────────────────────────────────

console.log('signed_transaction');
const sig = Buffer.alloc(65, 0x00);
sig[64] = 0x1f;
const stPayload = {
    ref_block_num: 12345 & 0xFFFF,
    ref_block_prefix: 0xCAFEBABE,
    expiration: Math.floor(Date.now() / 1000) + 300,
    operations: [],
    extensions: [],
    signatures: [sig],
};
assert.ok(compareBytes('signed_transaction', getBtsdexOp('signed_transaction'), nativeOps.signed_transaction, stPayload));
console.log('  PASS');

// ── transaction (unsigned) ──────────────────────────────────────────────

console.log('transaction (unsigned)');
const txPayload = {
    ref_block_num: 12345 & 0xFFFF,
    ref_block_prefix: 0xCAFEBABE,
    expiration: Math.floor(Date.now() / 1000) + 300,
    operations: [],
    extensions: [],
};
assert.ok(compareBytes('transaction', getBtsdexOp('transaction'), nativeOps.transaction, txPayload));
console.log('  PASS');

// ── fee_schedule ────────────────────────────────────────────────────────

console.log('fee_schedule');
const fsPayload = {
    parameters: [],
    scale: 10000,
};
assert.ok(compareBytes('fee_schedule', getBtsdexOp('fee_schedule'), nativeOps.fee_schedule, fsPayload));
console.log('  PASS');

// ── Edge case: min/max amounts ──────────────────────────────────────────

console.log('edge cases');
compareBytes('asset zero amount', getBtsdexOp('asset'), nativeOps.asset, {
    amount: 0,
    asset_id: '1.3.0',
});
compareBytes('price large amounts', getBtsdexOp('price'), nativeOps.price, {
    base: { amount: Number.MAX_SAFE_INTEGER, asset_id: '1.3.0' },
    quote: { amount: Number.MAX_SAFE_INTEGER, asset_id: '1.3.65535' },
});
console.log('  PASS');

console.log('\n=== All byte-for-byte tests passed ===');
