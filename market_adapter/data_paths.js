'use strict';

const path = require('path');

const MARKET_ADAPTER_DIR = path.resolve(__dirname);
const MARKET_ADAPTER_DATA_DIR = path.join(MARKET_ADAPTER_DIR, 'data');

module.exports = {
    MARKET_ADAPTER_DATA_DIR,
    MARKET_ADAPTER_DIR,
};
