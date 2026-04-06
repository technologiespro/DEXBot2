/**
 * Average True Range (ATR) Service
 * Computes market volatility for symmetrical weight shifts.
 */
'use strict';

/**
 * Calculates ATR from candles (High, Low, Close).
 * @param {Array} candles - Array of [timestamp, open, high, low, close, volume]
 * @param {number} period - ATR period
 */
function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;

  let tr = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i][2];
    const low = candles[i][3];
    const prevClose = candles[i - 1][4];
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
  }
  return atr;
}

module.exports = { calculateATR };
