#!/usr/bin/env node

const { main } = require('./claw_bridge');

main('nullclaw', 'tsx scripts/nullclaw_bridge.ts').catch((err: any) => {
  console.error(err && err.stack ? err.stack : err.message);
  process.exit(1);
});
export {};
