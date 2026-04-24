'use strict';

const { smoothKalmanVelocityPoint } = require('./kalman_velocity_smoothing');

/**
 * Kalman Trend Analyzer
 *
 * Implements a Constant Velocity Kalman Filter to estimate price and velocity.
 * Projects tangential "beams" (trajectories) forward in time.
 *
 * The Kalman filter is optimal for "State Estimation" in noisy environments
 * (like crypto markets). It separates the "true" price and velocity from
 * the high-frequency "noise" (wicks).
 */

class KalmanFilter {
    /**
     * @param {Object} opts
     * @param {number} opts.R - Measurement noise (trust in price data)
     * @param {number} opts.Q - Process noise (trust in the velocity model)
     */
    constructor(opts = {}) {
        // R represents our confidence in the data (High R = ignore noise, but more lag)
        this.R = opts.R ?? 0.05;

        // Q represents how much we expect the velocity to change (High Q = adapt faster)
        this.Q = opts.Q ?? 0.005;

        // State vector [x, v]: [position, velocity]
        this.x = 0;
        this.v = 0;

        // Covariance matrix P (estimates error in our state)
        // Initialized with high values as we are uncertain at start
        this.P00 = 1; this.P01 = 0;
        this.P10 = 0; this.P11 = 1;

        this.isInitialized = false;
    }

    /**
     * Update filter with a new price measurement
     * @param {number} z - Measured price
     * @returns {Object} { x, v } Estimated state
     */
    update(z) {
        if (!this.isInitialized) {
            this.x = z;
            this.v = 0;
            this.isInitialized = true;
            return { x: this.x, v: this.v };
        }

        // 1. Predict (Time Update)
        // x_new = x + v * dt (assuming dt = 1 bar)
        // v_new = v
        const x_p = this.x + this.v;
        const v_p = this.v;

        // P_new = F * P * F' + Q
        // F (Transition) = [[1, 1], [0, 1]]
        // This is a manual 2x2 matrix expansion for performance
        let p00 = this.P00 + this.P01 + this.P10 + this.P11 + this.Q;
        let p01 = this.P01 + this.P11 + this.Q;
        let p10 = this.P10 + this.P11 + this.Q;
        let p11 = this.P11 + this.Q;

        // 2. Update (Measurement Update)
        const y = z - x_p;      // Innovation (error between measurement and prediction)
        const s = p00 + this.R; // Innovation covariance

        // Kalman Gain K = P * H' * S^-1
        // H (Observation) = [[1, 0]]
        const k0 = p00 / s;
        const k1 = p10 / s;

        // Corrected State
        this.x = x_p + k0 * y;
        this.v = v_p + k1 * y;

        // Corrected Covariance P = (I - K * H) * P
        this.P00 = (1 - k0) * p00;
        this.P01 = (1 - k0) * p01;
        this.P10 = -k1 * p00 + p10;
        this.P11 = -k1 * p01 + p11;

        return { x: this.x, v: this.v };
    }
}

class KalmanTrendAnalyzer {
    /**
     * @param {Object} config
     * @param {number} config.rNoise - Measurement noise (default 0.05)
     * @param {number} config.qTactical - Process noise for tactical filter (default 0.01)
     * @param {number} config.qModal - Process noise for modal filter (default 0.0001)
     * @param {number} config.beamCount - Number of historical beams to track
     */
    constructor(config = {}) {
        // Tactical Filter: For short-term heading and inflections
        this.tacticalKf = new KalmanFilter({
            R: config.rNoise ?? 0.05,
            Q: config.qTactical ?? 0.01
        });

        // Modal Filter: For long-term equilibrium (The "Center of Gravity")
        this.modalKf = new KalmanFilter({
            R: config.rNoise ?? 0.05,
            Q: config.qModal ?? 0.0001
        });

        this.beams = [];
        this.inflections = [];
        this.maxBeams = config.beamCount ?? 100;
        this.warmupBars = Number.isInteger(config.warmupBars) && config.warmupBars >= 0
            ? config.warmupBars
            : 20;
        this.updateCount = 0;

        this.currPrice = null;
        this.tactical = { x: 0, v: 0 };
        this.modal = { x: 0, v: 0 };
        this.velocityFilteredPct = null;
    }

    /**
     * Update with a new market price
     */
    update(price) {
        if (!Number.isFinite(price) || price <= 0) {
            throw new Error('price must be a positive finite number');
        }

        this.currPrice = price;
        const prevTactical = { ...this.tactical };

        this.tactical = this.tacticalKf.update(price);
        this.modal = this.modalKf.update(price);

        // Detect Inflections (Velocity Change)
        // We look for significant changes in heading to spawn new beams
        const velChange = Math.abs(this.tactical.v - prevTactical.v);
        const isInflection = velChange > (price * 0.001); // 0.1% price movement in velocity

        if (isInflection || this.updateCount % 20 === 0) {
            this.beams.push({
                originX: this.updateCount,
                originY: this.tactical.x,
                velocity: this.tactical.v,
                type: this.tactical.v > 0 ? 'BULL' : 'BEAR'
            });
            if (this.beams.length > this.maxBeams) this.beams.shift();
        }

        const displacementPct = this.modal.x > 0
            ? ((this.currPrice - this.modal.x) / this.modal.x) * 100
            : 0;
        const rawVelocityPct = this.modal.x > 0
            ? (this.tactical.v / this.modal.x) * 100
            : 0;
        // Keep the analyzer's filtered velocity on the same smoothing path that the
        // research chart and live market adapter use at their default knob values.
        const smoothingResult = smoothKalmanVelocityPoint(
            rawVelocityPct,
            displacementPct,
            this.velocityFilteredPct
        );
        this.velocityFilteredPct = smoothingResult.smoothedVelocityPct;

        this.updateCount++;
        return this.getAnalysis();
    }

    getAnalysis() {
        const displacement = this.currPrice - this.modal.x;
        const displacementPct = this.modal.x > 0 ? (displacement / this.modal.x) * 100 : 0;
        const rawVelocityPct = this.modal.x > 0 ? (this.tactical.v / this.modal.x) * 100 : 0;

        // Signal Regime Logic
        let signal = 'NEUTRAL';
        if (displacementPct > 0.5 && this.tactical.v > 0) signal = 'BULLISH_DISPLACEMENT';
        if (displacementPct < -0.5 && this.tactical.v < 0) signal = 'BEARISH_DISPLACEMENT';
        if (Math.abs(displacementPct) < 0.2) signal = 'EQUILIBRIUM';

        return {
            isReady: this.updateCount > this.warmupBars,
            price: this.currPrice,
            kalmanPrice: Math.round(this.tactical.x * 1e8) / 1e8,
            modalPrice: Math.round(this.modal.x * 1e8) / 1e8,
            velocity: Math.round(this.tactical.v * 1e8) / 1e8,
            velocityPct: Math.round(rawVelocityPct * 100) / 100,
            velocityRawPct: rawVelocityPct,
            velocityFilteredPct: this.velocityFilteredPct == null ? null : Math.round(this.velocityFilteredPct * 100) / 100,
            velocityFilteredRawPct: this.velocityFilteredPct,
            displacementPct: Math.round(displacementPct * 100) / 100,
            displacementRawPct: displacementPct,
            signal,
            updateCount: this.updateCount,
            beams: this.beams,
            projections: {
                modal: this.modal.x + (this.modal.v * 50),
                tactical: this.tactical.x + (this.tactical.v * 50)
            }
        };
    }

    reset() {
        this.tacticalKf = new KalmanFilter();
        this.modalKf = new KalmanFilter();
        this.beams = [];
        this.updateCount = 0;
        this.velocityFilteredPct = null;
    }
}

module.exports = { KalmanTrendAnalyzer, KalmanFilter };
