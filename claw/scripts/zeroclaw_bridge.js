#!/usr/bin/env node

const { main } = require('./claw_bridge');

main('zeroclaw').catch((err) => {
  console.error(err && err.stack ? err.stack : err.message);
  process.exit(1);
});
