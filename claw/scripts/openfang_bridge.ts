#!/usr/bin/env node

const { main } = require('./claw_bridge');

main('openfang', 'tsx scripts/openfang_bridge.ts').catch((err: any) => {
  console.error(err && err.stack ? err.stack : err.message);
  process.exit(1);
});
export {};
