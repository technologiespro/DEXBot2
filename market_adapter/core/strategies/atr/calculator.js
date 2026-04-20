/**
 * Average True Range (ATR) Service
 * Computes market volatility for symmetrical weight shifts.
 */
'use strict';

const { normalizeAtrPeriod } = require('../../config_normalizers');

/**
 * Calculates ATR from candles (High, Low, Close).
 * @param {Array} candles - Array of [timestamp, open, high, low, close, volume]
 * @param {number} period - ATR period
 */
function calculateATR(candles, period = 14) {
  const safePeriod = normalizeAtrPeriod(period);
  if (candles.length < safePeriod + 1) return 0;

  let tr = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i][2];
    const low = candles[i][3];
    const prevClose = candles[i - 1][4];
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  let atr = tr.slice(0, safePeriod).reduce((a, b) => a + b, 0) / safePeriod;
  for (let i = safePeriod; i < tr.length; i++) {
    atr = (atr * (safePeriod - 1) + tr[i]) / safePeriod;
  }
  return atr;
}

module.exports = { calculateATR };
