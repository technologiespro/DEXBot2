// @ts-nocheck
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
     * @param {number} opts.dt - Time step between observations, in bars
     */
    constructor(opts = {}) {
        // R represents our confidence in the data (High R = ignore noise, but more lag)
        this.R = opts.R ?? 0.05;

        // Q represents acceleration noise spectral density (High Q = adapt faster)
        this.Q = opts.Q ?? 0.005;
        this.dt = Number.isFinite(opts.dt) && opts.dt > 0 ? opts.dt : 1;

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
        if (!Number.isFinite(z)) {
            return { x: this.x, v: this.v };
        }

        if (!this.isInitialized) {
            this.x = z;
            this.v = 0;
            const scale = z * z;
            this.P00 = scale * 100;
            this.P01 = 0;
            this.P10 = 0;
            this.P11 = scale;
            this.isInitialized = true;
            return { x: this.x, v: this.v };
        }

        // 1. Predict (Time Update)
        // x_new = x + v * dt
        // v_new = v
        const dt = this.dt;
        const x_p = this.x + (this.v * dt);
        const v_p = this.v;

        // P_new = F * P * F' + Q_matrix
        // F (Transition) = [[1, dt], [0, 1]]
        // Q_matrix = [[dt^3/3*q, dt^2/2*q], [dt^2/2*q, dt*q]]
        // This is a manual 2x2 matrix expansion for performance
        const q00 = ((dt * dt * dt) / 3) * this.Q;
        const q01 = ((dt * dt) / 2) * this.Q;
        const q11 = dt * this.Q;
        let p00 = this.P00 + (dt * this.P01) + (dt * this.P10) + (dt * dt * this.P11) + q00;
        let p01 = this.P01 + (dt * this.P11) + q01;
        let p10 = this.P10 + (dt * this.P11) + q01;
        let p11 = this.P11 + q11;

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

        // Corrected Covariance using Joseph form:
        // P = (I - K * H) * P * (I - K * H)' + K * R * K'
        const ikh00 = 1 - k0;
        const ikh01 = 0;
        const ikh10 = -k1;
        const ikh11 = 1;
        const t00 = ikh00 * p00 + ikh01 * p10;
        const t01 = ikh00 * p01 + ikh01 * p11;
        const t10 = ikh10 * p00 + ikh11 * p10;
        const t11 = ikh10 * p01 + ikh11 * p11;
        this.P00 = t00 * ikh00 + t01 * ikh01 + k0 * this.R * k0;
        this.P01 = t00 * ikh10 + t01 * ikh11 + k0 * this.R * k1;
        this.P10 = t10 * ikh00 + t11 * ikh01 + k1 * this.R * k0;
        this.P11 = t10 * ikh10 + t11 * ikh11 + k1 * this.R * k1;

        return { x: this.x, v: this.v };
    }
}

const MIN_PRICE_DENOMINATOR = 1e-10;

function safePct(numerator, denominator) {
    const pct = Math.abs(denominator) > MIN_PRICE_DENOMINATOR
        ? (numerator / denominator) * 100
        : 0;
    return Number.isFinite(pct) ? pct : 0;
}

class KalmanTrendAnalyzer {
    /**
     * @param {Object} config
     * @param {number} [config.rNoise=0.05] - Measurement noise
     * @param {number} [config.qTactical=0.01] - Process noise for tactical filter
     * @param {number} [config.qModal=0.0001] - Process noise for modal filter
     * @param {number} [config.qNoise] - Legacy fallback for qTactical/qModal when unset
     * @param {number} [config.beamCount=100] - Number of historical beams to track
     * @param {number} [config.dt=1] - Time step between observations, in bars
     * @param {number} [config.warmupBars=20] - Warmup bars before analysis
     */
    constructor(config = {}) {
        this.config = { ...config };
        const rNoise = config.rNoise ?? 0.05;
        const qTactical = config.qTactical ?? config.qNoise ?? 0.01;
        const qModal = config.qModal ?? config.qNoise ?? 0.0001;
        const dt = Number.isFinite(config.dt) && config.dt > 0 ? config.dt : 1;

        // Tactical Filter: For short-term heading and inflections
        this.tacticalKf = new KalmanFilter({
            R: rNoise,
            Q: qTactical,
            dt
        });

        // Modal Filter: For long-term equilibrium (The "Center of Gravity")
        this.modalKf = new KalmanFilter({
            R: rNoise,
            Q: qModal,
            dt
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

        const displacementPct = safePct(this.currPrice - this.modal.x, this.modal.x);
        const rawVelocityPct = safePct(this.tactical.v, this.modal.x);
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
        const displacementPct = safePct(displacement, this.modal.x);
        const rawVelocityPct = safePct(this.tactical.v, this.modal.x);

        // Signal Regime Logic
        let signal = 'NEUTRAL';
        if (displacementPct > 0.5 && this.tactical.v > 0) signal = 'BULLISH_DISPLACEMENT';
        if (displacementPct < -0.5 && this.tactical.v < 0) signal = 'BEARISH_DISPLACEMENT';
        if (Math.abs(displacementPct) < 0.2) signal = 'EQUILIBRIUM';

        let trend = 'FLAT';
        if (this.tactical.v > 0) trend = 'UP';
        else if (this.tactical.v < 0) trend = 'DOWN';

        // Confidence rises with warmup progress and signal clarity (velocity magnitude)
        const warmupRatio = Math.min(1, this.updateCount / (this.warmupBars || 1));
        const confidence = Math.min(100, Math.round(
            warmupRatio * 60 + Math.min(40, Math.abs(rawVelocityPct) * 8)
        ));

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
            trend,
            confidence,
            updateCount: this.updateCount,
            beams: this.beams,
            projections: {
                modal: this.modal.x + (this.modal.v * 50),
                tactical: this.tactical.x + (this.tactical.v * 50)
            }
        };
    }

    reset() {
        const rNoise = this.config.rNoise ?? 0.05;
        const qTactical = this.config.qTactical ?? this.config.qNoise ?? 0.01;
        const qModal = this.config.qModal ?? this.config.qNoise ?? 0.0001;
        const dt = Number.isFinite(this.config.dt) && this.config.dt > 0 ? this.config.dt : 1;
        this.tacticalKf = new KalmanFilter({ R: rNoise, Q: qTactical, dt });
        this.modalKf = new KalmanFilter({ R: rNoise, Q: qModal, dt });
        this.beams = [];
        this.updateCount = 0;
        this.currPrice = null;
        this.tactical = { x: 0, v: 0 };
        this.modal = { x: 0, v: 0 };
        this.velocityFilteredPct = null;
    }
}

export = { KalmanTrendAnalyzer, KalmanFilter };
