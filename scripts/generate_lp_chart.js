'use strict';

const {
    runLpChartCli,
} = require('../market_adapter/lp_chart_runner');

function run() {
    runLpChartCli(process.argv.slice(2), { logger: console });
}

if (require.main === module) {
    run();
}
