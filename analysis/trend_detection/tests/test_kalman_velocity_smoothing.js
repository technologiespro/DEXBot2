'use strict';

const assert = require('assert');
const { smoothKalmanVelocityPoint } = require('../kalman_velocity_smoothing');

const baseline = smoothKalmanVelocityPoint(
    0,
    1,
    10,
    {
        kalmanSmoothPct: 100,
        kalmanDispScaleMult: 1.5,
        kalmanDispThresholdMult: 1.5,
        kalmanSmoothSpanPct: 100,
    }
);

const maxed = smoothKalmanVelocityPoint(
    0,
    1,
    10,
    {
        kalmanSmoothPct: 200,
        kalmanDispScaleMult: 1.5,
        kalmanDispThresholdMult: 1.5,
        kalmanSmoothSpanPct: 100,
    }
);

const clamped = smoothKalmanVelocityPoint(
    0,
    1,
    10,
    {
        kalmanSmoothPct: 300,
        kalmanDispScaleMult: 1.5,
        kalmanDispThresholdMult: 1.5,
        kalmanSmoothSpanPct: 100,
    }
);

assert.ok(baseline.smoothedVelocityPct > 0 && baseline.smoothedVelocityPct < 10);
assert.strictEqual(clamped.smoothedVelocityPct, maxed.smoothedVelocityPct);
assert.ok(clamped.smoothedVelocityPct > baseline.smoothedVelocityPct);

console.log('kalman_velocity_smoothing tests passed');
