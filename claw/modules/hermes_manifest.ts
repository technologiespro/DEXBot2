const { createVariantDescribeFn } = require('./claw_manifest');

const describeHermesBridge = createVariantDescribeFn(
  'hermes',
  'Hermes',
  'tsx scripts/claw_bridge.ts',
  'Hermes consumes Claw through the shared MCP server and optional skill guidance; AI-Bot handles signing through DEXBot2'
);

export = { describeHermesBridge };
