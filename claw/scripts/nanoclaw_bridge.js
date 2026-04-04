#!/usr/bin/env node

const { main } = require('./claw_bridge');

main('nanoclaw', 'node scripts/nanoclaw_bridge.js').catch((err) => {
  console.error(err && err.stack ? err.stack : err.message);
  process.exit(1);
});
