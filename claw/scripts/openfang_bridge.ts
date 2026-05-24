#!/usr/bin/env node

const { main } = require('./claw_bridge');

main('openfang', 'node scripts/openfang_bridge.js').catch((err) => {
  console.error(err && err.stack ? err.stack : err.message);
  process.exit(1);
});
export {};
