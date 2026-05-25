#!/usr/bin/env node

const { main } = require('./claw_bridge');

main('openfang', 'node scripts/openfang_bridge.js').catch((err: any) => {
  console.error(err && err.stack ? err.stack : err.message);
  process.exit(1);
});
export {};
