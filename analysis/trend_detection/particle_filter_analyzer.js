'use strict';

/**
 * Particle Filter Trend Analyzer
 *
 * Implements a Sequential Monte Carlo (Particle Filter) to estimate price and velocity.
 * Uses a swarm of N particles to represent the state distribution, making it
 * robust to non-linear dynamics and non-Gaussian noise — unlike Kalman which
 * assumes both.
 *
 * Motion model (same as Kalman): x_new = x + v, v_new = v + noise(Q)
 * Observation model: z = x + noise(R)
 *
 * Resampling: systematic resampling when Neff/N < threshold
 */

function randn() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function gaussianPDF(x, mean, stddev) {
    const d = x - mean;
    return Math.exp(-0.5 * d * d / (stddev * stddev)) / (stddev * Math.sqrt(2 * Math.PI));
}

function effectiveSampleSize(weights) {
    let sumW = 0, sumWW = 0;
    for (let i = 0; i < weights.length; i++) {
        sumW += weights[i];
        sumWW += weights[i] * weights[i];
    }
    return sumW * sumW / sumWW;
}

function systematicResample(weights, n) {
    const out = new Array(n);
    const cumsum = new Array(weights.length);
    let running = 0;
    for (let i = 0; i < weights.length; i++) {
        running += weights[i];
        cumsum[i] = running;
    }

    const step = running / n;
    let mass = step * Math.random();
    let idx = 0;

    for (let i = 0; i < n; i++) {
        while (mass > cumsum[idx] && idx < cumsum.length - 1) {
            idx++;
        }
        if (idx >= cumsum.length) idx = cumsum.length - 1;
        out[i] = idx;
        mass += step;
    }
    return out;
}

class ParticleFilter {
    constructor(opts = {}) {
        this.N = opts.nParticles ?? 200;
        this.Q = opts.processNoise ?? 0.005;
        this.R = opts.measurementNoise ?? 0.05;
        this.resampleThreshold = opts.resampleThreshold ?? 0.5;

        this.x     = new Array(this.N);  // position
        this.v     = new Array(this.N);  // velocity
        this.weights = new Array(this.N);

        this.isInitialized = false;
        this.updateCount = 0;
        this.currPrice = null;

        this._meanX = 0;
        this._meanV = 0;
        this._lastNeff = this.N;
    }

    _initialize(price) {
        const initV = 0;
        for (let i = 0; i < this.N; i++) {
            this.x[i] = price * (1 + (Math.random() - 0.5) * 0.001);
            this.v[i] = initV;
            this.weights[i] = 1 / this.N;
        }
        this.isInitialized = true;
        this._meanX = price;
        this._meanV = initV;
    }

    update(z) {
        if (!Number.isFinite(z) || z <= 0) {
            throw new Error('price must be a positive finite number');
        }

        if (!this.isInitialized) {
            this._initialize(z);
            this.currPrice = z;
            this.updateCount++;
            return this._getState();
        }

        this.currPrice = z;

        // 1. Predict — move particles forward
        const processStd = Math.sqrt(this.Q) * this.currPrice;
        for (let i = 0; i < this.N; i++) {
            this.x[i] = this.x[i] + this.v[i];
            this.v[i] = this.v[i] + processStd * randn();
        }

        // 2. Update — weight by likelihood of observation
        const measStd = Math.sqrt(this.R) * this.currPrice;
        let sumW = 0;
        for (let i = 0; i < this.N; i++) {
            this.weights[i] = gaussianPDF(z, this.x[i], measStd);
            sumW += this.weights[i];
        }

        // Degenerate case: no particle explains the observation
        if (sumW === 0 || !Number.isFinite(sumW)) {
            for (let i = 0; i < this.N; i++) this.weights[i] = 1 / this.N;
            sumW = 1;
        } else {
            for (let i = 0; i < this.N; i++) this.weights[i] /= sumW;
        }

        // 3. Resample if Neff too low — store pre-resample Neff as the useful diagnostic
        this._lastNeff = effectiveSampleSize(this.weights);
        if (this._lastNeff / this.N < this.resampleThreshold) {
            this._resample();
        }

        // 4. Compute weighted mean state (weights already normalized to sumW=1)
        let sumXW = 0, sumVW = 0;
        for (let i = 0; i < this.N; i++) {
            sumXW += this.x[i] * this.weights[i];
            sumVW += this.v[i] * this.weights[i];
        }
        this._meanX = sumXW;
        this._meanV = sumVW;

        this.updateCount++;
        return this._getState();
    }

    _resample() {
        const indices = systematicResample(this.weights, this.N);
        const newX = new Array(this.N);
        const newV = new Array(this.N);
        for (let i = 0; i < this.N; i++) {
            const j = indices[i];
            newX[i] = this.x[j];
            newV[i] = this.v[j];
            this.weights[i] = 1 / this.N;
        }
        this.x = newX;
        this.v = newV;
    }

    _getState() {
        return { x: this._meanX, v: this._meanV };
    }
}

class ParticleFilterTrendAnalyzer {
    /**
     * @param {Object} config
     * @param {number} config.nParticles       - Number of particles (default 200)
     * @param {number} config.processNoise     - Q: velocity diffusion (default 0.005)
     * @param {number} config.measurementNoise - R: measurement noise (default 0.05)
     * @param {number} config.resampleThreshold - Neff/N threshold to trigger resample (default 0.5)
     * @param {number} config.maxVelocityRatio - Cap on velocity as fraction of price (default 0.05)
     * @param {number} config.velocityAlpha    - EMA smoothing for velocity output, 0–1 (default 0.2)
     *                                           Lower = smoother but more lag. Reduces Monte Carlo noise
     *                                           inherent in the particle mean estimate.
     */
    constructor(config = {}) {
        this.pf = new ParticleFilter({
            nParticles: config.nParticles ?? 200,
            processNoise: config.processNoise ?? 0.005,
            measurementNoise: config.measurementNoise ?? 0.05,
            resampleThreshold: config.resampleThreshold ?? 0.5,
        });

        this.currPrice = null;
        this.tactical = { x: 0, v: 0 };
        this.updateCount = 0;
        this.maxVelocityRatio = config.maxVelocityRatio ?? 0.05;
        this.velocityAlpha = config.velocityAlpha ?? 0.2;
        this._smoothedV = 0;
    }

    update(price) {
        if (!Number.isFinite(price) || price <= 0) {
            throw new Error('price must be a positive finite number');
        }

        this.currPrice = price;

        const state = this.pf.update(price);

        const maxV = price * this.maxVelocityRatio;
        const cappedV = Math.max(-maxV, Math.min(maxV, state.v));

        // EMA smoothing on velocity to suppress Monte Carlo readout noise
        this._smoothedV = this.velocityAlpha * cappedV + (1 - this.velocityAlpha) * this._smoothedV;

        this.tactical = { x: state.x, v: this._smoothedV };

        this.updateCount++;
        return this.getAnalysis();
    }

    getAnalysis() {
        const displacement = this.currPrice - this.pf._meanX;
        const displacementPct = this.pf._meanX !== 0
            ? (displacement / this.pf._meanX) * 100
            : 0;

        let signal = 'NEUTRAL';
        if (displacementPct > 0.5 && this.tactical.v > 0) signal = 'BULLISH_DISPLACEMENT';
        if (displacementPct < -0.5 && this.tactical.v < 0) signal = 'BEARISH_DISPLACEMENT';
        if (Math.abs(displacementPct) < 0.2) signal = 'EQUILIBRIUM';

        return {
            isReady: this.updateCount >= 20,
            price: this.currPrice,
            pfPrice: Math.round(this.tactical.x * 1e8) / 1e8,
            velocity: Math.round(this.tactical.v * 1e8) / 1e8,
            velocityPct: Math.round((this.tactical.v / this.currPrice) * 10000) / 100,
            displacementPct: Math.round(displacementPct * 100) / 100,
            signal,
            updateCount: this.updateCount,
            Neff: Math.round(this.pf._lastNeff),
        };
    }

    reset() {
        this.pf = new ParticleFilter({
            nParticles: this.pf.N,
            processNoise: this.pf.Q,
            measurementNoise: this.pf.R,
            resampleThreshold: this.pf.resampleThreshold,
        });
        this._smoothedV = 0;
        this.updateCount = 0;
    }
}

module.exports = { ParticleFilterTrendAnalyzer, ParticleFilter };