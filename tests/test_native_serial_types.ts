/**
 * tests/test_native_serial_types.js — Unit tests for serial primitive types
 *
 * Tests round-trip serialize/deserialize for every primitive type used by
 * the BitShares binary protocol, including edge cases.
 */

const assert = require('assert');
const { Serializer, BufferWriter, BufferReader } = require('../modules/bitshares-native/serial/serializer');
const types = require('../modules/bitshares-native/serial/types');

console.log('=== Native Serial Types Tests ===\n');

// ── BufferWriter / BufferReader ──────────────────────────────────────────

console.log('BufferWriter/BufferReader basics');

const w = new BufferWriter();
w.writeUint8(255).writeUint16(65535).writeUint32(4294967295).writeVarint32(127).writeVarint32(128).writeVarint32(16384);
const buf = w.toBuffer();
const r = new BufferReader(buf);
assert.strictEqual(r.readUint8(), 255);
assert.strictEqual(r.readUint16(), 65535);
assert.strictEqual(r.readUint32(), 4294967295);
assert.strictEqual(r.readVarint32(), 127);
assert.strictEqual(r.readVarint32(), 128);
assert.strictEqual(r.readVarint32(), 16384);
console.log('  PASS: BufferWriter/BufferReader round-trips');

// ── uint8 ────────────────────────────────────────────────────────────────

console.log('uint8');
const u8w = new BufferWriter();
types.uint8.appendByteBuffer(u8w, 42);
assert.deepStrictEqual(u8w.toBuffer(), Buffer.from([42]));
const u8v = types.uint8.fromByteBuffer(new BufferReader(Buffer.from([255])));
assert.strictEqual(u8v, 255);
assert.strictEqual(types.uint8.toObject(42), 42);
console.log('  PASS');

// ── uint16 ───────────────────────────────────────────────────────────────

console.log('uint16');
const u16w = new BufferWriter();
types.uint16.appendByteBuffer(u16w, 65535);
const u16b = u16w.toBuffer();
assert.strictEqual(u16b.length, 2);
assert.strictEqual(u16b.readUInt16LE(0), 65535);
const u16v = types.uint16.fromByteBuffer(new BufferReader(u16b));
assert.strictEqual(u16v, 65535);
console.log('  PASS');

// ── uint32 ───────────────────────────────────────────────────────────────

console.log('uint32');
const u32w = new BufferWriter();
types.uint32.appendByteBuffer(u32w, 4294967295);
const u32b = u32w.toBuffer();
assert.strictEqual(u32b.length, 4);
const u32v = types.uint32.fromByteBuffer(new BufferReader(u32b));
assert.strictEqual(u32v, 4294967295);
console.log('  PASS');

// ── varint32 ─────────────────────────────────────────────────────────────

console.log('varint32');
const var32w = new BufferWriter();
types.varint32.appendByteBuffer(var32w, 0);
types.varint32.appendByteBuffer(var32w, 1);
types.varint32.appendByteBuffer(var32w, 127);
types.varint32.appendByteBuffer(var32w, 128);
types.varint32.appendByteBuffer(var32w, 16383);
types.varint32.appendByteBuffer(var32w, 16384);
types.varint32.appendByteBuffer(var32w, 2097151);
types.varint32.appendByteBuffer(var32w, 268435455);
const var32b = var32w.toBuffer();
const var32r = new BufferReader(var32b);
assert.strictEqual(types.varint32.fromByteBuffer(var32r), 0);
assert.strictEqual(types.varint32.fromByteBuffer(var32r), 1);
assert.strictEqual(types.varint32.fromByteBuffer(var32r), 127);
assert.strictEqual(types.varint32.fromByteBuffer(var32r), 128);
assert.strictEqual(types.varint32.fromByteBuffer(var32r), 16383);
assert.strictEqual(types.varint32.fromByteBuffer(var32r), 16384);
assert.strictEqual(types.varint32.fromByteBuffer(var32r), 2097151);
assert.strictEqual(types.varint32.fromByteBuffer(var32r), 268435455);
console.log('  PASS');

// ── int64 ────────────────────────────────────────────────────────────────

console.log('int64');
const i64w = new BufferWriter();
types.int64.appendByteBuffer(i64w, 1000000);
const i64b = i64w.toBuffer();
assert.strictEqual(i64b.length, 8);
const i64v = types.int64.fromByteBuffer(new BufferReader(i64b));
assert.strictEqual(i64v, 1000000);
// Negative value in separate writer
const i64negW = new BufferWriter();
types.int64.appendByteBuffer(i64negW, -1);
const i64neg = types.int64.fromByteBuffer(new BufferReader(i64negW.toBuffer()));
assert.strictEqual(i64neg, -1);
console.log('  PASS');

// ── string ───────────────────────────────────────────────────────────────

console.log('string');
const strw = new BufferWriter();
types.string.appendByteBuffer(strw, 'hello');
const strb = strw.toBuffer();
const strv = types.string.fromByteBuffer(new BufferReader(strb));
assert.strictEqual(strv, 'hello');
// Empty string
const sew = new BufferWriter();
types.string.appendByteBuffer(sew, '');
const ser = new BufferReader(sew.toBuffer());
assert.strictEqual(types.string.fromByteBuffer(ser), '');
console.log('  PASS');

// ── bool ─────────────────────────────────────────────────────────────────

console.log('bool');
const bw1 = new BufferWriter();
types.bool.appendByteBuffer(bw1, true);
assert.deepStrictEqual(bw1.toBuffer(), Buffer.from([1]));
const bw0 = new BufferWriter();
types.bool.appendByteBuffer(bw0, false);
assert.deepStrictEqual(bw0.toBuffer(), Buffer.from([0]));
const bv = types.bool.fromByteBuffer(new BufferReader(Buffer.from([1])));
assert.strictEqual(bv, true);
console.log('  PASS');

// ── bytes ────────────────────────────────────────────────────────────────

console.log('bytes');
const bytesV = types.bytes();
const bytesF = types.bytes(32);
// Variable-sized
const bvw = new BufferWriter();
bytesV.appendByteBuffer(bvw, Buffer.from([1, 2, 3]));
const bvb = bvw.toBuffer();
const bvr = new BufferReader(bvb);
const bvv = bytesV.fromByteBuffer(bvr);
assert.deepStrictEqual(bvv, Buffer.from([1, 2, 3]));
// Fixed-sized
const bfw = new BufferWriter();
bytesF.appendByteBuffer(bfw, Buffer.alloc(32, 0xff));
const bfb = bfw.toBuffer();
assert.strictEqual(bfb.length, 32);
const bfr = new BufferReader(bfb);
const bfv = bytesF.fromByteBuffer(bfr);
assert.strictEqual(bfv.length, 32);
assert.strictEqual(bfv[0], 0xff);
console.log('  PASS');

// ── time_point_sec ───────────────────────────────────────────────────────

console.log('time_point_sec');
const ts = Math.floor(Date.now() / 1000);
const tsw = new BufferWriter();
types.time_point_sec.appendByteBuffer(tsw, ts);
const tsb = tsw.toBuffer();
assert.strictEqual(tsb.length, 4);
const tsv = types.time_point_sec.fromByteBuffer(new BufferReader(tsb));
assert.strictEqual(tsv, ts);
// Date input
const dtw = new BufferWriter();
const dt = new Date(ts * 1000);
types.time_point_sec.appendByteBuffer(dtw, dt);
const dtv = types.time_point_sec.fromByteBuffer(new BufferReader(dtw.toBuffer()));
assert.strictEqual(dtv, ts);
assert.strictEqual(types.time_point_sec.fromObject('2026-05-25T12:34:56'), 1779712496);
assert.strictEqual(types.time_point_sec.fromObject('2026-05-25 12:34:56'), 1779712496);
console.log('  PASS');

// ── optional ─────────────────────────────────────────────────────────────

console.log('optional');
const opt = types.optional(types.uint8);
// Present
const ow1 = new BufferWriter();
opt.appendByteBuffer(ow1, 42);
const ow1b = ow1.toBuffer();
assert.strictEqual(ow1b[0], 1);
const or1 = new BufferReader(ow1b);
assert.strictEqual(opt.fromByteBuffer(or1), 42);
// Absent
const ow0 = new BufferWriter();
opt.appendByteBuffer(ow0, null);
const ow0b = ow0.toBuffer();
assert.strictEqual(ow0b[0], 0);
const or0 = new BufferReader(ow0b);
assert.strictEqual(opt.fromByteBuffer(or0), undefined);
console.log('  PASS');

// ── static_variant ───────────────────────────────────────────────────────

console.log('static_variant');
const sv = types.static_variant([types.uint8, types.uint16, types.uint32]);
const svw = new BufferWriter();
sv.appendByteBuffer(svw, [1, 42]);
const svb = svw.toBuffer();
const svr = new BufferReader(svb);
const svRes = sv.fromByteBuffer(svr);
assert.deepStrictEqual(svRes, [1, 42]);
console.log('  PASS');

// ── protocol_id_type ─────────────────────────────────────────────────────

console.log('protocol_id_type');
const pid = types.protocol_id_type('asset');
const pidw = new BufferWriter();
pid.appendByteBuffer(pidw, '1.3.0');
const pidb = pidw.toBuffer();
const pidr = new BufferReader(pidb);
const pidv = pid.fromByteBuffer(pidr);
assert.strictEqual(pidv, 0);
assert.strictEqual(pid.toObject(0), '1.3.0');
console.log('  PASS');

// ── array ────────────────────────────────────────────────────────────────

console.log('array');
const arr = types.array(types.uint8);
const arrw = new BufferWriter();
arr.appendByteBuffer(arrw, [1, 2, 3]);
const arrb = arrw.toBuffer();
const arrr = new BufferReader(arrb);
const arrv = arr.fromByteBuffer(arrr);
assert.deepStrictEqual(arrv, [1, 2, 3]);
console.log('  PASS');

// ── set ──────────────────────────────────────────────────────────────────

console.log('set');
const st = types.set(types.uint8);
const stw = new BufferWriter();
st.appendByteBuffer(stw, [3, 1, 2]);
const stb = stw.toBuffer();
const str = new BufferReader(stb);
const stv = st.fromByteBuffer(str);
assert.deepStrictEqual(stv, [1, 2, 3]);
console.log('  PASS');

// ── extension ────────────────────────────────────────────────────────────

console.log('extension');
const ext = types.extension([
    { name: 'field_a', type: types.uint8 },
    { name: 'field_b', type: types.uint16 },
]);
const extw1 = new BufferWriter();
ext.appendByteBuffer(extw1, { field_a: 5, field_b: 300 });
const extb1 = extw1.toBuffer();
const extr1 = new BufferReader(extb1);
const extRes1 = ext.fromByteBuffer(extr1);
assert.deepStrictEqual(extRes1, { field_a: 5, field_b: 300 });
// Empty extensions
const extw0 = new BufferWriter();
ext.appendByteBuffer(extw0, {});
const extb0 = extw0.toBuffer();
const extr0 = new BufferReader(extb0);
const extRes0 = ext.fromByteBuffer(extr0);
assert.strictEqual(extRes0, undefined);
console.log('  PASS');

// ── object_id_type ───────────────────────────────────────────────────────

console.log('object_id_type');
const oidw = new BufferWriter();
types.object_id_type.appendByteBuffer(oidw, '1.7.12345');
const oidb = oidw.toBuffer();
const oidr = new BufferReader(oidb);
types.object_id_type.fromByteBuffer(oidr);  // returns a Long-like number
const oidStr = types.object_id_type.toObject(types.object_id_type.fromByteBuffer(new BufferReader(oidb)));
assert.ok(oidStr.startsWith('1.7.'));
console.log('  PASS');

console.log('\n=== All serial type tests passed ===');
