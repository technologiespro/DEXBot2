'use strict';

const assert = require('assert');
const { KalmanTrendAnalyzer, KalmanFilter } = require('../kalman_trend_analyzer');

/**
 * Test Suite for Kalman Trend Detection
 */

async function runTests() {
    console.log('Running Kalman Trend Analyzer tests...');

    testFilterInitialization();
    testConstantTrendConvergence();
    testNoiseFiltering();
    testTrajectoryProjection();
    testTrendDetectionSign();

    console.log('All Kalman tests passed!');
}

function testFilterInitialization() {
    console.log(' - Testing initialization');
    const kf = new KalmanFilter();
    const state = kf.update(100);
    assert.strictEqual(state.x, 100);
    assert.strictEqual(state.v, 0);
}

function testConstantTrendConvergence() {
    console.log(' - Testing constant trend convergence');
    const analyzer = new KalmanTrendAnalyzer({ rNoise: 0.01, qNoise: 0.01 });
    
    // Simulate price moving from 100 to 200 in 100 steps (velocity = 1.0)
    let price = 100;
    let lastAnalysis;
    for (let i = 0; i < 100; i++) {
        price += 1.0;
        lastAnalysis = analyzer.update(price);
    }

    // Velocity should be very close to 1.0
    assert.ok(Math.abs(lastAnalysis.velocity - 1.0) < 0.05, `Velocity ${lastAnalysis.velocity} should be near 1.0`);
    assert.strictEqual(lastAnalysis.trend, 'UP');
}

function testNoiseFiltering() {
    console.log(' - Testing noise filtering (wicks)');
    const analyzer = new KalmanTrendAnalyzer({ rNoise: 10.0, qNoise: 0.01 }); // High R = ignore noise
    
    let price = 100;
    // 50 steps of steady price
    for (let i = 0; i < 50; i++) analyzer.update(100);

    // One big "wick" to 150
    const noisyAnalysis = analyzer.update(150);

    // Kalman price should NOT jump to 150 immediately due to high R
    assert.ok(noisyAnalysis.kalmanPrice < 115, `Kalman price ${noisyAnalysis.kalmanPrice} should stay low despite noise`);
}

function testTrajectoryProjection() {
    console.log(' - Testing trajectory projection (beams)');
    const analyzer = new KalmanTrendAnalyzer();
    
    // Upward trend: velocity 2.0
    for (let i = 0; i < 50; i++) analyzer.update(100 + (i * 2.0));

    const analysis = analyzer.getAnalysis();
    const p10 = analyzer.project(10);
    
    // Current price is ~200. Projected 10 bars forward @ 2.0/bar should be ~220
    assert.ok(Math.abs(p10 - (analysis.kalmanPrice + 20)) < 1.0, `Projected price ${p10} incorrect`);
    assert.strictEqual(analysis.projections.p10, p10);
}

function testTrendDetectionSign() {
    console.log(' - Testing trend detection signs');
    const analyzer = new KalmanTrendAnalyzer();
    
    for (let i = 0; i < 20; i++) analyzer.update(100 - i); // Downward
    assert.strictEqual(analyzer.getAnalysis().trend, 'DOWN');

    analyzer.reset();
    for (let i = 0; i < 20; i++) analyzer.update(100 + i); // Upward
    assert.strictEqual(analyzer.getAnalysis().trend, 'UP');
}

runTests().catch(err => {
    console.error('Tests failed!');
    console.error(err);
    process.exit(1);
});
