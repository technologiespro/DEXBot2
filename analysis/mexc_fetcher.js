/**
 * SHARED MEXC DATA FETCHER
 *
 * Fetches OHLCV candles from MEXC for given symbols and interval,
 * then calculates a synthetic pair (e.g. XRP/BTS = XRP_price / BTS_price).
 *
 * Used by:
 *   analysis/ama_fitting/fetch_mexc_data.js   (4h candles)
 *   analysis/trend_detection/fetch_1day_candles.js (1d candles)
 */

const https = require('https');

function fetchFromMEXC(symbol, interval = '4h', limit = 500) {
    return new Promise((resolve, reject) => {
        console.log(`  Fetching ${symbol} ${interval} candles from MEXC...`);

        const url = `https://api.mexc.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;

        https.get(url, { timeout: 10000 }, (res) => {
            let data = '';

            res.on('data', chunk => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const json = JSON.parse(data);

                    if (!Array.isArray(json) || json.length === 0) {
                        throw new Error(`No data for ${symbol}`);
                    }

                    // MEXC klines format: [time, open, high, low, close, volume, ...]
                    const candles = json.map(candle => [
                        parseInt(candle[0]),  // timestamp
                        parseFloat(candle[1]),  // open
                        parseFloat(candle[2]),  // high
                        parseFloat(candle[3]),  // low
                        parseFloat(candle[4]),  // close
                        parseFloat(candle[5])   // volume
                    ]);

                    console.log(`    Got ${candles.length} ${interval} candles for ${symbol}`);
                    resolve(candles);
                } catch (e) {
                    reject(new Error(`${symbol}: ${e.message}`));
                }
            });
        }).on('error', reject);
    });
}

function generateSyntheticPair(xrpData, btsData) {
    const xrpMap = new Map();
    const btsMap = new Map();

    xrpData.forEach(candle => xrpMap.set(candle[0], candle));
    btsData.forEach(candle => btsMap.set(candle[0], candle));

    const commonTimestamps = [];
    for (const [ts] of xrpMap) {
        if (btsMap.has(ts)) {
            commonTimestamps.push(ts);
        }
    }

    console.log(`\n  Common timestamps: ${commonTimestamps.length}`);

    commonTimestamps.sort((a, b) => a - b);

    // XRP/BTS = XRP / BTS
    // High = XRP_high / BTS_low (maximize ratio)
    // Low = XRP_low / BTS_high (minimize ratio)
    const synthetic = [];

    for (const ts of commonTimestamps) {
        const xrp = xrpMap.get(ts);
        const bts = btsMap.get(ts);

        synthetic.push([
            ts,
            xrp[1] / bts[1],  // open: XRP_open / BTS_open
            xrp[2] / bts[3],  // high: XRP_high / BTS_low
            xrp[3] / bts[2],  // low: XRP_low / BTS_high
            xrp[4] / bts[4],  // close: XRP_close / BTS_close
            0  // volume (combined, set to 0)
        ]);
    }

    return synthetic;
}

module.exports = { fetchFromMEXC, generateSyntheticPair };
