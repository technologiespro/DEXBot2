#!/usr/bin/env node
'use strict';

/**
 * Quick lifecycle test for adapter_client — connect → query → disconnect → repeat
 */

const { BitShares, connectClient, disconnectClient, isConnected, getNodeUrl } = require('../market_adapter/utils/adapter_client');

const CYCLES = 3;

function ts() { return new Date().toISOString(); }
function log(msg) { console.log(`${ts()}: ${msg}`); }

async function cycle(n) {
    log(`── cycle ${n} ──`);
    
    log(`connecting...`);
    await connectClient();
    log(`connected -> ${getNodeUrl()}, isConnected=${isConnected()}`);
    
    log(`querying assets...`);
    const assets = await BitShares.db.lookup_asset_symbols(['IOB.XRP', 'BTS']);
    log(`assets: ${assets.map(a => a.symbol).join(', ')}`);
    
    log(`querying pool history...`);
    const ops = await BitShares.history.get_liquidity_pool_history('1.19.133', null, null, 3, 1);
    log(`pool swaps: ${ops.length}`);
    
    disconnectClient();
    log(`disconnected, isConnected=${isConnected()}`);
}

(async () => {
    log(`Adapter client lifecycle test — ${CYCLES} cycles\n`);
    for (let i = 1; i <= CYCLES; i++) {
        await cycle(i);
        if (i < CYCLES) {
            log(`sleeping 2s...\n`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    log(`\nDone.`);
    process.exit(0);
})().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
