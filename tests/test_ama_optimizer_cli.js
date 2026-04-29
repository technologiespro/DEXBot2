const assert = require('assert');

const { parseArgs } = require('../analysis/ama_fitting/optimizer_high_resolution');

{
    const args = parseArgs([
        '--data', 'market_adapter/data/lp/1_3_5537_1_3_0/lp_pool_133_iob.xrp_bts_1h.json',
    ]);

    assert.strictEqual(args.writeProfiles, false, 'optimizer should not update market_profiles.json by default');
    assert.strictEqual(
        args.dataFile,
        'market_adapter/data/lp/1_3_5537_1_3_0/lp_pool_133_iob.xrp_bts_1h.json',
        'optimizer should keep the provided data file path'
    );
}

{
    const args = parseArgs([
        '--data', 'market_adapter/data/lp/1_3_5537_1_3_0/lp_pool_133_iob.xrp_bts_1h.json',
        '--write-profiles',
    ]);

    assert.strictEqual(args.writeProfiles, true, '--write-profiles should opt in to profile export');
}

console.log('AMA optimizer CLI tests passed');
