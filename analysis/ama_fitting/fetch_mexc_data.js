/**
 * MEXC DATA FETCHER — 4-HOUR CANDLES
 *
 * Fetches 4-hour candles from MEXC for XRP/USDT and BTS/USDT,
 * then calculates synthetic XRP/BTS pair.
 *
 * Output:
 * - data/XRP_USDT.json
 * - data/BTS_USDT.json
 * - data/XRP_BTS_SYNTHETIC.json
 */

const fs = require('fs');
const path = require('path');
const { fetchFromMEXC, generateSyntheticPair } = require('../mexc_fetcher');

const DATA_DIR = path.join(__dirname, 'data');
const INTERVAL = '4h';

async function run() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }

        console.log(`Fetching ${INTERVAL} candle data from MEXC...\n`);

        const [xrpData, btsData] = await Promise.all([
            fetchFromMEXC('XRPUSDT', INTERVAL),
            fetchFromMEXC('BTSUSDT', INTERVAL)
        ]);

        console.log(`\nData fetched:`);
        console.log(`  XRP/USDT: ${xrpData.length} candles (oldest: ${new Date(xrpData[0][0]).toISOString()}, newest: ${new Date(xrpData[xrpData.length - 1][0]).toISOString()})`);
        console.log(`  BTS/USDT: ${btsData.length} candles (oldest: ${new Date(btsData[0][0]).toISOString()}, newest: ${new Date(btsData[btsData.length - 1][0]).toISOString()})`);

        console.log('\nGenerating XRP/BTS synthetic pair...');
        const synthetic = generateSyntheticPair(xrpData, btsData);

        fs.writeFileSync(
            path.join(DATA_DIR, 'XRP_USDT.json'),
            JSON.stringify(xrpData, null, 2)
        );
        fs.writeFileSync(
            path.join(DATA_DIR, 'BTS_USDT.json'),
            JSON.stringify(btsData, null, 2)
        );
        fs.writeFileSync(
            path.join(DATA_DIR, 'XRP_BTS_SYNTHETIC.json'),
            JSON.stringify(synthetic, null, 2)
        );

        console.log(`\nData saved:`);
        console.log(`   - data/XRP_USDT.json (${xrpData.length} ${INTERVAL} candles)`);
        console.log(`   - data/BTS_USDT.json (${btsData.length} ${INTERVAL} candles)`);
        console.log(`   - data/XRP_BTS_SYNTHETIC.json (${synthetic.length} ${INTERVAL} candles)`);

        console.log(`\nSynthetic pair date range:`);
        console.log(`  Start: ${new Date(synthetic[0][0]).toISOString()}`);
        console.log(`  End:   ${new Date(synthetic[synthetic.length - 1][0]).toISOString()}`);
        console.log(`  Total: ${(synthetic.length * 4 / 24).toFixed(1)} days of data`);

        console.log('\nReady for optimization!');

    } catch (error) {
        console.error('\nError:', error.message);
        process.exit(1);
    }
}

run();
