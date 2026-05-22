const assert = require('assert');
const { validatePrivateKey } = require('../modules/chain_keys');

const cases = [
    {
        name: 'valid_wif_compressed_known_vector',
        key: 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn',
        valid: true,
    },
    {
        name: 'valid_wif_uncompressed_known_vector',
        key: '5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreAnchuDf',
        valid: true,
    },
    {
        name: 'invalid_wif_checksum',
        key: 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWm',
        valid: false,
    },
    {
        name: 'valid_pvt_k1',
        key: 'PVT_K1_123abcDEF',
        valid: true,
    },
    {
        name: 'valid_hex',
        key: 'a'.repeat(64),
        valid: true,
    },
    {
        name: 'invalid_short',
        key: '1234',
        valid: false,
    },
    {
        name: 'invalid_chars',
        key: '0OIl!@#$%',
        valid: false,
    },
];

for (const testCase of cases) {
    const out = validatePrivateKey(testCase.key);
    assert.strictEqual(out.valid, testCase.valid, `${testCase.name}: ${JSON.stringify(out)}`);
}

console.log('Key validation tests passed');
