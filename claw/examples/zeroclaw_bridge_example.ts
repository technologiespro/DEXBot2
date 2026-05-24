// @ts-nocheck
const { createZeroClawBridge, describeZeroClawBridge } = require('../modules/zeroclaw_bridge');

async function main() {
  const bridge = createZeroClawBridge({
    runtime: {
      name: 'zeroclaw-example'
    }
  });

  const manifest = describeZeroClawBridge({
    accountName: bridge.runtime.accountName
  });

  const market = await bridge.market.readMarketSnapshot('BTS', 'USD', 5);
  const honest = await bridge.honest.buildContext({
    discoverPairs: [['HONEST.MONEY', 'BTS']]
  });

  console.log(JSON.stringify({
    honest: {
      bridge: honest.bridge,
      summary: honest.summary
    },
    manifest,
    market: {
      asks: Array.isArray(market.orderBook.asks) ? market.orderBook.asks.length : 0,
      bids: Array.isArray(market.orderBook.bids) ? market.orderBook.bids.length : 0,
      latest: market.ticker ? market.ticker.latest : null
    },
    runtime: bridge.runtime
  }, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
export {};
