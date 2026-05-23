'use strict';

class BufferWriter {
    constructor() {
        this.buf = Buffer.alloc(0);
    }

    get length() { return this.buf.length; }

    toBuffer() { return this.buf; }

    write(array) {
        this.buf = Buffer.concat([this.buf, Buffer.isBuffer(array) ? array : Buffer.from(array)]);
        return this;
    }

    writeUint8(v) {
        const b = Buffer.allocUnsafe(1);
        b.writeUInt8(v, 0);
        this.buf = Buffer.concat([this.buf, b]);
        return this;
    }

    writeUint16(v) {
        const b = Buffer.allocUnsafe(2);
        b.writeUInt16LE(v, 0);
        this.buf = Buffer.concat([this.buf, b]);
        return this;
    }

    writeUint32(v) {
        const b = Buffer.allocUnsafe(4);
        b.writeUInt32LE(v, 0);
        this.buf = Buffer.concat([this.buf, b]);
        return this;
    }

    writeInt16(v) {
        const b = Buffer.allocUnsafe(2);
        b.writeInt16LE(v, 0);
        this.buf = Buffer.concat([this.buf, b]);
        return this;
    }

    writeInt32(v) {
        const b = Buffer.allocUnsafe(4);
        b.writeInt32LE(v, 0);
        this.buf = Buffer.concat([this.buf, b]);
        return this;
    }

    writeInt64(v) {
        const b = Buffer.allocUnsafe(8);
        b.writeBigInt64LE(BigInt(v), 0);
        this.buf = Buffer.concat([this.buf, b]);
        return this;
    }

    writeUint64(v) {
        const b = Buffer.allocUnsafe(8);
        b.writeBigUInt64LE(BigInt(v), 0);
        this.buf = Buffer.concat([this.buf, b]);
        return this;
    }

    writeVarint32(v) {
        v = v >>> 0;
        do {
            let b = v & 0x7F;
            v >>>= 7;
            if (v === 0) {
                this.writeUint8(b);
                return this;
            }
            b |= 0x80;
            this.writeUint8(b);
        } while (true);
    }

    writeVarint64(v) {
        v = BigInt(v);
        if (v < 0x80n) {
            return this.writeUint8(Number(v));
        }
        if (v < 0x4000n) {
            return this.writeUint16(Number(v | 0x8000n));
        }
        if (v < 0x20000000n) {
            return this.writeUint32(Number(v | 0xc0000000n));
        }
        return this.writeUint8(0xf0 | Number((v >> 28n) & 0x0fn))
                   .writeUint16(Number((v >> 12n) & 0xffffn))
                   .writeUint32(Number(v & 0xffffffffn));
    }

    flip() {
        return this;
    }

    append(src) {
        if (src instanceof BufferWriter) {
            this.buf = Buffer.concat([this.buf, src.buf]);
        } else if (Buffer.isBuffer(src)) {
            this.buf = Buffer.concat([this.buf, src]);
        }
        return this;
    }
}

class BufferReader {
    constructor(buffer, offset = 0) {
        if (!Buffer.isBuffer(buffer)) {
            throw new Error('BufferReader requires a Buffer');
        }
        this.buffer = buffer;
        this.offset = offset;
    }

    get length() { return this.buffer.length - this.offset; }
    isEnd() { return this.offset >= this.buffer.length; }

    read(length) {
        if (this.offset + length > this.buffer.length) {
            throw new Error(`BufferReader: attempted to read ${length} bytes at offset ${this.offset} (buffer size: ${this.buffer.length})`);
        }
        const slice = this.buffer.slice(this.offset, this.offset + length);
        this.offset += length;
        return slice;
    }

    skip(length) {
        this.offset += length;
    }

    readUint8() {
        const v = this.buffer.readUInt8(this.offset);
        this.offset += 1;
        return v;
    }

    readUint16() {
        const v = this.buffer.readUInt16LE(this.offset);
        this.offset += 2;
        return v;
    }

    readUint32() {
        const v = this.buffer.readUInt32LE(this.offset);
        this.offset += 4;
        return v;
    }

    readInt32() {
        const v = this.buffer.readInt32LE(this.offset);
        this.offset += 4;
        return v;
    }

    readInt64() {
        const v = this.buffer.readBigInt64LE(this.offset);
        this.offset += 8;
        return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(v)
            : v.toString();
    }

    readUint64() {
        const v = this.buffer.readBigUInt64LE(this.offset);
        this.offset += 8;
        return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
    }

    readVarint32() {
        let v = 0, b, shift = 0;
        do {
            b = this.readUint8();
            v |= (b & 0x7F) << shift;
            shift += 7;
            if (!(b & 0x80)) break;
        } while (shift < 35);
        return v | 0;
    }

    readVarint64() {
        return BigInt(this.readVarint32());
    }

    copy(offset, end) {
        return this.buffer.slice(offset, end);
    }

    toString(encoding) {
        return this.buffer.slice(this.offset).toString(encoding || 'hex');
    }
}

function Serializer(operation_name, types) {
    const typeKeys = Object.keys(types);

    const s = { _name: operation_name, _types: types, _keys: typeKeys };

    s.fromByteBuffer = function(b) {
        const result = {};
        for (const key of typeKeys) {
            result[key] = types[key].fromByteBuffer(b);
        }
        return result;
    };

    s.appendByteBuffer = function(b, obj) {
        if (!obj) throw new Error(`missing object for ${operation_name}`);
        for (const key of typeKeys) {
            const val = obj[key];
            types[key].appendByteBuffer(b, val);
        }
    };

    s.toObject = function(obj, debug) {
        if (!obj) {
            if (debug && debug.use_default) {
                const result = {};
                for (const key of typeKeys) {
                    result[key] = types[key].toObject(undefined, debug);
                }
                return result;
            }
            throw new Error(`missing object for ${operation_name}`);
        }
        const result = {};
        for (const key of typeKeys) {
            result[key] = types[key].toObject(obj[key], debug);
        }
        return result;
    };

    s.fromObject = function(obj) {
        if (!obj) throw new Error(`missing object for ${operation_name}`);
        const result = {};
        for (const key of typeKeys) {
            result[key] = types[key].fromObject(obj[key]);
        }
        return result;
    };

    s.toBuffer = function(obj) {
        const w = new BufferWriter();
        s.appendByteBuffer(w, obj);
        return w.toBuffer();
    };

    s.fromBuffer = function(buf) {
        return s.fromByteBuffer(new BufferReader(buf));
    };

    s.toHex = function(obj) {
        return s.toBuffer(obj).toString('hex');
    };

    s.fromHex = function(hex) {
        return s.fromBuffer(Buffer.from(hex, 'hex'));
    };

    return s;
}

module.exports = { Serializer, BufferWriter, BufferReader };
