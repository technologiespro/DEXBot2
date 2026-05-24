const { createVariantDescribeFn } = require('./claw_manifest');

const describeHermesBridge = createVariantDescribeFn(
  'hermes',
  'Hermes',
  'node scripts/claw_bridge.js',
  'Hermes consumes Claw through the shared MCP server and optional skill guidance; AI-Bot handles signing through DEXBot2'
);

export = { describeHermesBridge };
