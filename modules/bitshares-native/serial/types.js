'use strict';

const { BufferWriter, BufferReader, Serializer } = require('./serializer');
const { RESERVED_SPACES, DB_MAX_INSTANCE_ID } = require('./chain_constants');

const isDigits = (v) => /^-?\d+$/.test(String(v));
const toNumber = (v) => {
    if (typeof v === 'number') return v;
    return isDigits(v) ? Number(v) : NaN;
};
const int64ToSafeValue = (n) => (
    n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(n)
        : n.toString()
);
const unsigned = (v) => (v >>> 0);
const $required = (obj, name) => { if (obj == null) throw new Error(`${name || 'value'} required`); };
const requireRange = (min, max, v, name) => {
    if (v < min || v > max) throw new Error(`${name || 'value'} out of range [${min}, ${max}]: ${v}`);
};

const strCmp = (a, b) => a > b ? 1 : a < b ? -1 : 0;
const firstEl = (el) => Array.isArray(el) ? el[0] : el;

function sortOperation(array, st_operation) {
    if (!st_operation) return array;
    if (st_operation.nosort) return array;
    if (st_operation.compare) {
        return array.sort((a, b) => st_operation.compare(firstEl(a), firstEl(b)));
    }
    return array.sort((a, b) => {
        const fa = firstEl(a);
        const fb = firstEl(b);
        if (typeof fa === 'number' && typeof fb === 'number') return fa - fb;
        if (Buffer.isBuffer(fa) && Buffer.isBuffer(fb)) return strCmp(fa.toString('hex'), fb.toString('hex'));
        return strCmp(String(fa), String(fb));
    });
}

const void_type = {
    fromByteBuffer() { throw new Error('(void) undefined type'); },
    appendByteBuffer() { throw new Error('(void) undefined type'); },
    fromObject() { throw new Error('(void) undefined type'); },
    toObject(object, debug) {
        if (debug && debug.use_default && object === undefined) return undefined;
        throw new Error('(void) undefined type');
    },
};

const uint8 = {
    fromByteBuffer(b) { return b.readUint8(); },
    appendByteBuffer(b, v) { requireRange(0, 0xFF, v, 'uint8'); b.writeUint8(v); },
    fromObject(v) { requireRange(0, 0xFF, v, 'uint8'); return v; },
    toObject(v, debug) {
        if (debug && debug.use_default && v === undefined) return 0;
        requireRange(0, 0xFF, v, 'uint8');
        return parseInt(v, 10);
    },
};

const uint16 = {
    fromByteBuffer(b) { return b.readUint16(); },
    appendByteBuffer(b, v) { requireRange(0, 0xFFFF, v, 'uint16'); b.writeUint16(v); },
    fromObject(v) { requireRange(0, 0xFFFF, v, 'uint16'); return v; },
    toObject(v, debug) {
        if (debug && debug.use_default && v === undefined) return 0;
        requireRange(0, 0xFFFF, v, 'uint16');
        return parseInt(v, 10);
    },
};

const uint32 = {
    fromByteBuffer(b) { return b.readUint32(); },
    appendByteBuffer(b, v) { requireRange(0, 0xFFFFFFFF, v, 'uint32'); b.writeUint32(v); },
    fromObject(v) { requireRange(0, 0xFFFFFFFF, v, 'uint32'); return v; },
    toObject(v, debug) {
        if (debug && debug.use_default && v === undefined) return 0;
        requireRange(0, 0xFFFFFFFF, v, 'uint32');
        return parseInt(v, 10);
    },
};

const varint32 = {
    fromByteBuffer(b) { return b.readVarint32(); },
    appendByteBuffer(b, v) {
        requireRange(-2147483648, 2147483647, v, 'varint32');
        b.writeVarint32(v);
    },
    fromObject(v) {
        requireRange(-2147483648, 2147483647, v, 'varint32');
        return v;
    },
    toObject(v, debug) {
        if (debug && debug.use_default && v === undefined) return 0;
        requireRange(-2147483648, 2147483647, v, 'varint32');
        return parseInt(v, 10);
    },
};

const int64 = {
    fromByteBuffer(b) { return b.readInt64(); },
    appendByteBuffer(b, v) {
        $required(v, 'int64');
        const n = BigInt(String(v));
        if (n < -0x8000000000000000n || n > 0x7FFFFFFFFFFFFFFFn) {
            throw new Error(`int64 out of range [-9223372036854775808, 9223372036854775807]: ${v}`);
        }
        b.writeInt64(n);
    },
    fromObject(v) {
        $required(v, 'int64');
        const n = BigInt(String(v));
        if (n < -0x8000000000000000n || n > 0x7FFFFFFFFFFFFFFFn) {
            throw new Error(`int64 out of range [-9223372036854775808, 9223372036854775807]: ${v}`);
        }
        return int64ToSafeValue(n);
    },
    toObject(v, debug) {
        if (debug && debug.use_default && v === undefined) return '0';
        $required(v, 'int64');
        return String(v);
    },
};

const uint64 = {
    fromByteBuffer(b) { return b.readUint64(); },
    appendByteBuffer(b, v) {
        $required(v, 'uint64');
        const n = BigInt(String(v));
        if (n < 0n || n > 0xFFFFFFFFFFFFFFFFn) {
            throw new Error(`uint64 out of range [0, 18446744073709551615]: ${v}`);
        }
        const buf = Buffer.allocUnsafe(8);
        buf.writeBigUInt64LE(n, 0);
        b.write(buf);
    },
    fromObject(v) {
        $required(v, 'uint64');
        const n = BigInt(String(v));
        if (n < 0n || n > 0xFFFFFFFFFFFFFFFFn) {
            throw new Error(`uint64 out of range [0, 18446744073709551615]: ${v}`);
        }
        return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString();
    },
    toObject(v, debug) {
        if (debug && debug.use_default && v === undefined) return '0';
        $required(v, 'uint64');
        const n = BigInt(String(v));
        if (n < 0n || n > 0xFFFFFFFFFFFFFFFFn) {
            throw new Error(`uint64 out of range [0, 18446744073709551615]: ${v}`);
        }
        return String(n);
    },
};

const varuint64 = {
    fromByteBuffer(b) { return b.readVarint64(); },
    appendByteBuffer(b, v) { b.writeVarint64(BigInt(String(unsigned(v)))); },
    fromObject(v) { return Number(BigInt(String(unsigned(v)))); },
    toObject(v, debug) {
        if (debug && debug.use_default && v === undefined) return '0';
        return String(unsigned(v));
    },
};

const string_type = {
    fromByteBuffer(b) {
        const len = b.readVarint32();
        const data = b.read(len);
        return Buffer.from(data).toString('utf8');
    },
    appendByteBuffer(b, v) {
        $required(v, 'string');
        const buf = Buffer.from(String(v), 'utf8');
        b.writeVarint32(buf.length);
        b.write(buf);
    },
    fromObject(v) { $required(v, 'string'); return Buffer.from(String(v), 'utf8'); },
    toObject(v, debug) {
        if (debug && debug.use_default && v === undefined) return '';
        return String(v);
    },
};

function bytesType(size) {
    return {
        fromByteBuffer(b) {
            if (size === undefined) {
                const len = b.readVarint32();
                return b.read(len);
            }
            return b.read(size);
        },
        appendByteBuffer(b, v) {
            $required(v, 'bytes');
            let buf = Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'hex');
            if (size === undefined) b.writeVarint32(buf.length);
            b.write(buf);
        },
        fromObject(v) {
            $required(v, 'bytes');
            if (Buffer.isBuffer(v)) return v;
            return Buffer.from(String(v), 'hex');
        },
        toObject(v, debug) {
            if (debug && debug.use_default && v === undefined) {
                if (size) return '00'.repeat(size);
                return '';
            }
            $required(v, 'bytes');
            if (Buffer.isBuffer(v)) return v.toString('hex');
            return String(v);
        },
    };
}

const bool_type = {
    fromByteBuffer(b) { return b.readUint8() === 1; },
    appendByteBuffer(b, v) { b.writeUint8(v ? 1 : 0); },
    fromObject(v) { return !!v; },
    toObject(v, debug) {
        if (debug && debug.use_default && v === undefined) return false;
        return !!v;
    },
};

function arrayType(st_operation) {
    return {
        fromByteBuffer(b) {
            const size = b.readVarint32();
            const result = [];
            for (let i = 0; i < size; i++) {
                result.push(st_operation.fromByteBuffer(b));
            }
            return sortOperation(result, st_operation);
        },
        appendByteBuffer(b, v) {
            $required(v, 'array');
            const sorted = sortOperation(v, st_operation);
            b.writeVarint32(sorted.length);
            for (const item of sorted) {
                st_operation.appendByteBuffer(b, item);
            }
        },
        fromObject(v) {
            $required(v, 'array');
            const sorted = sortOperation(v, st_operation);
            return sorted.map(item => st_operation.fromObject(item));
        },
        toObject(v, debug) {
            if (debug && debug.use_default && v === undefined) {
                return [st_operation.toObject(undefined, debug)];
            }
            $required(v, 'array');
            const sorted = sortOperation(v, st_operation);
            return sorted.map(item => st_operation.toObject(item, debug));
        },
    };
}

const time_point_sec = {
    fromByteBuffer(b) { return b.readUint32(); },
    appendByteBuffer(b, v) {
        if (typeof v !== 'number') v = time_point_sec.fromObject(v);
        b.writeUint32(v);
    },
    fromObject(v) {
        $required(v, 'time_point_sec');
        if (typeof v === 'number') return v;
        if (v instanceof Date) return Math.floor(v.getTime() / 1000);
        if (typeof v !== 'string') throw new Error('Unknown date type: ' + v);
        return Math.floor(new Date(v).getTime() / 1000);
    },
    toObject(v, debug) {
        if (debug && debug.use_default && v === undefined) {
            return new Date(0).toISOString().split('.')[0];
        }
        $required(v, 'time_point_sec');
        if (typeof v === 'string') return v;
        if (v instanceof Date) return v.toISOString().split('.')[0];
        const int = parseInt(v, 10);
        requireRange(0, 0xFFFFFFFF, int, 'uint32');
        return new Date(int * 1000).toISOString().split('.')[0];
    },
};

function setType(st_operation) {
    function validate(arr) {
        const dup = {};
        for (const item of arr) {
            const key = (typeof item === 'number' || typeof item === 'string') ? item : undefined;
            if (key !== undefined && dup[key] !== undefined) {
                throw new Error('duplicate (set)');
            }
            if (key !== undefined) dup[key] = true;
        }
        return sortOperation(arr, st_operation);
    }

    return {
        validate,
        fromByteBuffer(b) {
            const size = b.readVarint32();
            const result = [];
            for (let i = 0; i < size; i++) {
                result.push(st_operation.fromByteBuffer(b));
            }
            return validate(result);
        },
        appendByteBuffer(b, v) {
            if (!v) v = [];
            const sorted = validate(v);
            b.writeVarint32(sorted.length);
            for (const item of sorted) {
                st_operation.appendByteBuffer(b, item);
            }
        },
        fromObject(v) {
            if (!v) v = [];
            return validate(v.map(item => st_operation.fromObject(item)));
        },
        toObject(v, debug) {
            if (debug && debug.use_default && v === undefined) {
                return [st_operation.toObject(undefined, debug)];
            }
            if (!v) v = [];
            return validate(v.map(item => st_operation.toObject(item, debug)));
        },
    };
}

function fixedArrayType(count, st_operation) {
    return {
        fromByteBuffer(b) {
            const result = [];
            for (let i = 0; i < count; i++) {
                result.push(st_operation.fromByteBuffer(b));
            }
            return sortOperation(result, st_operation);
        },
        appendByteBuffer(b, v) {
            if (count !== 0) {
                $required(v, 'fixed_array');
                v = sortOperation(v, st_operation);
            }
            for (let i = 0; i < count; i++) {
                st_operation.appendByteBuffer(b, v ? v[i] : undefined);
            }
        },
        fromObject(v) {
            if (count !== 0) $required(v, 'fixed_array');
            const result = [];
            for (let i = 0; i < count; i++) {
                result.push(st_operation.fromObject(v ? v[i] : undefined));
            }
            return result;
        },
        toObject(v, debug) {
            if (debug && debug.use_default && v === undefined) {
                const result = [];
                for (let i = 0; i < count; i++) {
                    result.push(st_operation.toObject(undefined, debug));
                }
                return result;
            }
            if (count !== 0) $required(v, 'fixed_array');
            const result = [];
            for (let i = 0; i < count; i++) {
                result.push(st_operation.toObject(v ? v[i] : undefined, debug));
            }
            return result;
        },
    };
}

function idType(reserved_spaces, object_type) {
    const { OBJECT_TYPE } = require('./chain_constants');
    const objectTypeId = OBJECT_TYPE[object_type] != null ? OBJECT_TYPE[object_type] : object_type;
    return {
        fromByteBuffer(b) { return b.readVarint32(); },
        appendByteBuffer(b, v) {
            $required(v, 'id_type');
            if (/^\d+\.\d+\.\d+$/.test(String(v))) {
                v = getInstance(reserved_spaces, object_type, v);
            }
            b.writeVarint32(toNumber(v));
        },
        fromObject(v) {
            $required(v, 'id_type');
            if (isDigits(v)) return toNumber(v);
            return getInstance(reserved_spaces, object_type, v);
        },
        toObject(v, debug) {
            if (debug && debug.use_default && v === undefined) {
                return `${reserved_spaces}.${objectTypeId}.0`;
            }
            $required(v, 'id_type');
            if (/^\d+\.\d+\.\d+$/.test(String(v))) {
                v = getInstance(reserved_spaces, object_type, v);
            }
            return `${reserved_spaces}.${objectTypeId}.${v}`;
        },
    };
}

function getInstance(reserved_spaces, object_type, object) {
    const parts = String(object).split('.');
    if (parts.length !== 3) throw new Error(`Invalid object ID: ${object}`);
    return parseInt(parts[2], 10);
}

function protocolIdType(name) {
    return idType(RESERVED_SPACES.protocol_ids, name);
}

const object_id_type = {
    fromByteBuffer(b) {
        const long = b.readUint64();
        return ObjectId.fromLong(long);
    },
    appendByteBuffer(b, v) {
        $required(v, 'object_id_type');
        const obj = ObjectId.fromString(String(v));
        obj.appendByteBuffer(b);
    },
    fromObject(v) {
        $required(v, 'object_id_type');
        return ObjectId.fromString(String(v));
    },
    toObject(v, debug) {
        if (debug && debug.use_default && v === undefined) return '0.0.0';
        $required(v, 'object_id_type');
        let obj = v;
        if (obj instanceof ObjectId) return obj.toString();
        try {
            obj = ObjectId.fromString(String(v));
        } catch (_) {
            if (typeof v === 'number') {
                obj = ObjectId.fromLong(v);
            } else {
                throw new Error(`Invalid object_id: ${v}`);
            }
        }
        return obj.toString();
    },
};

class ObjectId {
    constructor(space, type, instance) {
        this.space = Number(space);
        this.type = Number(type);
        this.instance = BigInt(String(instance));
        if (!isDigits(String(instance))) throw new Error('ObjectId instance must be digits');
    }

    static fromString(value) {
        if (typeof value !== 'string' || value.split('.').length !== 3) {
            throw new Error(`Invalid ObjectId: ${value}`);
        }
        const [space, type, instance] = value.split('.');
        return new ObjectId(space, type, instance);
    }

    static fromLong(long) {
        long = BigInt(long);
        const space = Number((long >> 56n) & 0xFFn);
        const type = Number((long >> 48n) & 0xFFn);
        const instance = long & 0xFFFFFFFFFFFFn;
        return new ObjectId(space, type, instance);
    }

    toString() {
        return `${this.space}.${this.type}.${this.instance}`;
    }

    toLong() {
        const space = BigInt(this.space) & 0xFFn;
        const type = BigInt(this.type) & 0xFFn;
        const instance = BigInt(this.instance) & 0xFFFFFFFFFFFFn;
        return (space << 56n) | (type << 48n) | instance;
    }

    appendByteBuffer(b) {
        const long = this.toLong();
        const buf = Buffer.allocUnsafe(8);
        buf.writeBigUInt64LE(long, 0);
        b.write(buf);
    }

    toBuffer() {
        const w = new BufferWriter();
        this.appendByteBuffer(w);
        return w.toBuffer();
    }
}

function optionalType(st_operation) {
    return {
        fromByteBuffer(b) {
            if (b.readUint8() !== 1) return undefined;
            return st_operation.fromByteBuffer(b);
        },
        appendByteBuffer(b, v) {
            if (v !== null && v !== undefined) {
                b.writeUint8(1);
                st_operation.appendByteBuffer(b, v);
            } else {
                b.writeUint8(0);
            }
        },
    fromObject(v) {
        if (v === undefined || v === null) return undefined;
        return st_operation.fromObject(v);
        },
    toObject(v, debug) {
        if (!debug || !debug.use_default) {
            if (v === undefined || v === null) return undefined;
        }
            const result = st_operation.toObject(v, debug);
            if (debug && debug.annotate) {
                if (typeof result === 'object') {
                    result.__optional = 'parent is optional';
                } else {
                    return { __optional: result };
                }
            }
            return result;
        },
    };
}

function extensionType(fields_def) {
    return {
        fromByteBuffer(b) {
            const count = b.readVarint32();
            if (count === 0) return undefined;

            const o = {};
            for (let i = 0; i < count; i++) {
                const index = b.readVarint32();
                if (index >= fields_def.length) throw new Error('extension index out of range: ' + index);
                const field = fields_def[index];
                o[field.name] = field.type.fromByteBuffer(b);
            }
            return o;
        },
        appendByteBuffer(b, v) {
            const temp = new BufferWriter();
            let count = 0;

            if (v) {
                fields_def.forEach((f, i) => {
                    if (v[f.name] !== undefined && v[f.name] !== null) {
                        temp.writeVarint32(i);
                        f.type.appendByteBuffer(temp, v[f.name]);
                        count++;
                    }
                });
            }

            b.writeVarint32(count);
            b.append(temp);
        },
        fromObject(v) {
            if (v === undefined) return undefined;
            const result = {};
            fields_def.forEach(f => {
                if (v[f.name] !== undefined && v[f.name] !== null) {
                    result[f.name] = f.type.fromObject(v[f.name]);
                }
            });
            return result;
        },
        toObject(v, debug) {
            if (v === undefined) return undefined;
            const result = {};
            fields_def.forEach(f => {
                if (v[f.name] !== undefined && v[f.name] !== null) {
                    result[f.name] = f.type.toObject(v[f.name], debug);
                }
            });
            return result;
        },
    };
}

function staticVariantType(st_operations) {
    return {
        nosort: true,
        st_operations,
        fromByteBuffer(b) {
            const type_id = b.readVarint32();
            const st_operation = this.st_operations[type_id];
            if (!st_operation) throw new Error(`Unknown static_variant type: ${type_id}`);
            return [type_id, st_operation.fromByteBuffer(b)];
        },
        appendByteBuffer(b, v) {
            $required(v, 'static_variant');
            const type_id = v[0];
            const st_operation = this.st_operations[type_id];
            if (!st_operation) throw new Error(`Unknown static_variant type: ${type_id}`);
            b.writeVarint32(type_id);
            st_operation.appendByteBuffer(b, v[1]);
        },
        fromObject(v) {
            $required(v, 'static_variant');
            const type_id = v[0];
            const st_operation = this.st_operations[type_id];
            if (!st_operation) throw new Error(`Unknown static_variant type: ${type_id}`);
            return [type_id, st_operation.fromObject(v[1])];
        },
        toObject(v, debug) {
            if (debug && debug.use_default && v === undefined) {
                const sto = this.st_operations[0];
                if (!sto) throw new Error('Unknown static_variant type: 0');
                return [0, sto.toObject(undefined, debug)];
            }
            $required(v, 'static_variant');
            const type_id = v[0];
            const st_operation = this.st_operations[type_id];
            if (!st_operation) throw new Error(`Unknown static_variant type: ${type_id}`);
            return [type_id, st_operation.toObject(v[1], debug)];
        },
    };
}

function mapType(key_st_operation, value_st_operation) {
    function validate(arr) {
        if (!Array.isArray(arr)) throw new Error('expecting array');
        const dup = {};
        for (const o of arr) {
            if (!(o.length === 2)) throw new Error('expecting two elements');
            const k = o[0];
            if (typeof k === 'number' || typeof k === 'string') {
                if (dup[k] !== undefined) throw new Error('duplicate (map)');
                dup[k] = true;
            }
        }
        return sortOperation(arr, key_st_operation);
    }

    return {
        validate,
        fromByteBuffer(b) {
            const size = b.readVarint32();
            const result = [];
            for (let i = 0; i < size; i++) {
                result.push([key_st_operation.fromByteBuffer(b), value_st_operation.fromByteBuffer(b)]);
            }
            return validate(result);
        },
        appendByteBuffer(b, v) {
            validate(v);
            b.writeVarint32(v.length);
            for (const [k, val] of v) {
                key_st_operation.appendByteBuffer(b, k);
                value_st_operation.appendByteBuffer(b, val);
            }
        },
        fromObject(v) {
            $required(v, 'map');
            const result = v.map(([k, val]) => [
                key_st_operation.fromObject(k),
                value_st_operation.fromObject(val),
            ]);
            return validate(result);
        },
        toObject(v, debug) {
            if (debug && debug.use_default && v === undefined) {
                return [[key_st_operation.toObject(undefined, debug), value_st_operation.toObject(undefined, debug)]];
            }
            $required(v, 'map');
            return validate(v.map(([k, val]) => [
                key_st_operation.toObject(k, debug),
                value_st_operation.toObject(val, debug),
            ]));
        },
    };
}

const vote_id = {
    TYPE: 0x000000FF,
    ID: 0xFFFFFF00,
    fromByteBuffer(b) {
        const val = b.readUint32();
        return { type: val & this.TYPE, id: (val & this.ID) >>> 8 };
    },
    appendByteBuffer(b, v) {
        $required(v, 'vote_id');
        if (typeof v === 'string') v = vote_id.fromObject(v);
        b.writeUint32((v.id << 8) | v.type);
    },
    fromObject(v) {
        $required(v, 'vote_id');
        if (typeof v === 'object') return v;
        const [type, id] = String(v).split(':');
        return { type: parseInt(type, 10), id: parseInt(id, 10) };
    },
    toObject(v, debug) {
        if (debug && debug.use_default && v === undefined) return '0:0';
        $required(v, 'vote_id');
        if (typeof v === 'string') v = vote_id.fromObject(v);
        return `${v.type}:${v.id}`;
    },
    compare(a, b) {
        if (typeof a !== 'object') a = vote_id.fromObject(a);
        if (typeof b !== 'object') b = vote_id.fromObject(b);
        return parseInt(a.id, 10) - parseInt(b.id, 10);
    },
};

const public_key_type = {
    _toPublic() {
        throw new Error('public_key type requires ecc module - import from index');
    },
    fromByteBuffer(b) {
        return b.read(33);
    },
    appendByteBuffer(b, v) {
        $required(v, 'public_key');
        const buf = Buffer.isBuffer(v) ? v : Buffer.from(v, 'hex');
        b.write(buf);
    },
    fromObject(v) {
        $required(v, 'public_key');
        if (Buffer.isBuffer(v)) return v;
        return Buffer.from(v, 'hex');
    },
    toObject(v, debug) {
        if (debug && debug.use_default && v === undefined) return '';
        $required(v, 'public_key');
        if (Buffer.isBuffer(v)) return v.toString('hex');
        return String(v);
    },
};

const address_type = {
    fromByteBuffer(b) { return b.read(20); },
    appendByteBuffer(b, v) {
        $required(v, 'address');
        const buf = Buffer.isBuffer(v) ? v : Buffer.from(v, 'hex');
        b.write(buf);
    },
    fromObject(v) {
        $required(v, 'address');
        if (Buffer.isBuffer(v)) return v;
        return Buffer.from(v, 'hex');
    },
    toObject(v, debug) {
        if (debug && debug.use_default && v === undefined) return '';
        $required(v, 'address');
        if (Buffer.isBuffer(v)) return v.toString('hex');
        return String(v);
    },
};

module.exports = {
    void: void_type,
    uint8,
    uint16,
    uint32,
    varint32,
    int64,
    uint64,
    varuint64,
    string: string_type,
    bytes: bytesType,
    bool: bool_type,
    array: arrayType,
    time_point_sec,
    set: setType,
    fixed_array: fixedArrayType,
    id_type: idType,
    protocol_id_type: protocolIdType,
    object_id_type,
    vote_id,
    optional: optionalType,
    extension: extensionType,
    static_variant: staticVariantType,
    map: mapType,
    public_key: public_key_type,
    address: address_type,
    future_extensions: void_type,
    ObjectId,
    sortOperation,
    firstEl,
    strCmp,
};
