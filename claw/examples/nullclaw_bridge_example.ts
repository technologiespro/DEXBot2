// @ts-nocheck
const { createNullClawBridge, describeNullClawBridge } = require('../modules/nullclaw_bridge');

function main() {
  const bridge = createNullClawBridge({
    runtime: {
      name: 'nullclaw-example'
    }
  });
  const manifest = describeNullClawBridge({
    accountName: bridge.runtime.accountName
  });

  console.log(JSON.stringify({
    manifest,
    runtime: bridge.runtime
  }, null, 2));
}

if (require.main === module) {
  main();
}
export {};
