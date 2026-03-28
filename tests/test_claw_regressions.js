const assert = require('assert');

function clearModule(modulePath) {
  delete require.cache[modulePath];
}

function testZeroClawSkillQuotesPayloadPlaceholders() {
  const skillPath = require.resolve('../claw/modules/zeroclaw_skill');
  const catalogPath = require.resolve('../claw/modules/zeroclaw_catalog');
  const manifestPath = require.resolve('../claw/modules/zeroclaw_manifest');
  clearModule(catalogPath);
  clearModule(manifestPath);
  clearModule(skillPath);
  const { buildZeroClawCommandExamples, listZeroClawCommandNames } = require('../claw/modules/zeroclaw_catalog');
  const { describeZeroClawBridge } = require('../claw/modules/zeroclaw_manifest');
  const { buildZeroClawSkillToml } = require('../claw/modules/zeroclaw_skill');

  const toml = buildZeroClawSkillToml({
    profileRoot: '/tmp/profile root',
    repoRoot: '/tmp/repo root'
  });

  assert(
    toml.includes("'--payload' '{{payload_json}}'"),
    'generated skill commands must shell-quote payload placeholders'
  );
  assert(
    toml.includes("'--profile-root' '/tmp/profile root'"),
    'generated skill commands must shell-quote profile roots with spaces'
  );

  const manifest = describeZeroClawBridge();
  assert.deepStrictEqual(
    manifest.commands,
    listZeroClawCommandNames(),
    'manifest command list must stay in sync with the shared ZeroClaw catalog'
  );
  assert.deepStrictEqual(
    manifest.commandExamples,
    buildZeroClawCommandExamples(),
    'manifest examples must stay in sync with the shared ZeroClaw catalog'
  );
}

function testLiquidityPoolWrapperInjectsSharedBitSharesClient() {
  const bitsharesPath = require.resolve('../claw/modules/bitshares_client');
  const dexbotBridgePath = require.resolve('../claw/modules/dexbot_bridge');
  const liquidityPoolsPath = require.resolve('../claw/modules/liquidity_pools');
  const sharedBitShares = { name: 'shared-bitshares-client' };
  let capturedPoolArgs = null;
  let capturedPriceArgs = null;

  require.cache[bitsharesPath] = {
    id: bitsharesPath,
    filename: bitsharesPath,
    loaded: true,
    exports: { BitShares: sharedBitShares }
  };
  require.cache[dexbotBridgePath] = {
    id: dexbotBridgePath,
    filename: dexbotBridgePath,
    loaded: true,
    exports: {
      getDexbot2Root: () => '/tmp',
      loadDexbotOrderSystemUtils: () => ({
        cloneMap: (value) => value,
        deepFreeze: (value) => value,
        derivePoolPrice: (...args) => {
          capturedPoolArgs = args;
          return 'pool-price';
        },
        derivePrice: (...args) => {
          capturedPriceArgs = args;
          return 'derived-price';
        },
        loadAmaCenterPrice: () => null,
        lookupAsset: () => null
      }),
      requireDexbot2Module: () => null
    }
  };
  clearModule(liquidityPoolsPath);

  const liquidityPools = require('../claw/modules/liquidity_pools');

  assert.strictEqual(liquidityPools.derivePoolPrice('HONEST.USD', 'BTS'), 'pool-price');
  assert.deepStrictEqual(
    capturedPoolArgs,
    [sharedBitShares, 'HONEST.USD', 'BTS'],
    'derivePoolPrice wrapper must inject the shared BitShares client'
  );

  assert.strictEqual(liquidityPools.derivePrice('HONEST.USD', 'BTS', 'pool'), 'derived-price');
  assert.deepStrictEqual(
    capturedPriceArgs,
    [sharedBitShares, 'HONEST.USD', 'BTS', 'pool'],
    'derivePrice wrapper must inject the shared BitShares client'
  );

  clearModule(liquidityPoolsPath);
  clearModule(dexbotBridgePath);
  clearModule(bitsharesPath);
}

function main() {
  testZeroClawSkillQuotesPayloadPlaceholders();
  testLiquidityPoolWrapperInjectsSharedBitSharesClient();
  console.log('claw regression tests passed');
}

main();
