const { MarketAdapterService } = require('../market_adapter/core/market_adapter_service');
const { KalmanTrendAnalyzer } = require('../analysis/trend_detection/kalman_trend_analyzer');
const { calculateATR } = require('../market_adapter/core/strategies/atr/calculator');

console.log('Testing MarketAdapterService structure...');

const service = new MarketAdapterService();
console.log('Service instantiated:', !!service);

const trend = new KalmanTrendAnalyzer();
console.log('TrendDetection instantiated:', !!trend);

const candles = [[1, 10, 15, 5, 12, 100], [2, 12, 18, 8, 15, 100], [3, 15, 20, 10, 18, 100]];
const atr = calculateATR(candles, 2);
console.log('ATR calculated:', atr);

console.log('All modular components initialized successfully.');
