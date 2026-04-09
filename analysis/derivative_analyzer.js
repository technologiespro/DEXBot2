'use strict';

/**
 * Derivative Analyzer
 *
 * Trend detection from the sign (and magnitude) of derivatives:
 *   SMA derivative  > 0 → UP,  < 0 → DOWN
 *   KAMA derivative > 0 → UP,  < 0 → DOWN
 *   LRS slope       > 0 → UP,  < 0 → DOWN
 *
 * Each indicator is optional and independent.
 * Primary `trend` field follows KAMA when present, else LRS, else SMA.
 */

const { AMA } = require('./ama_fitting/ama');

// ─── Simple Moving Average ───────────────────────────────────────────────────

class SMA {
    constructor(period) {
        this.period = period;
        this.values = [];
    }

    update(price) {
        this.values.push(price);
        if (this.values.length > this.period) this.values.shift();
        if (this.values.length < this.period) return null;
        return this.values.reduce((a, b) => a + b, 0) / this.period;
    }

    isReady() { return this.values.length >= this.period; }

    reset(period) { this.period = period; this.values = []; }
}

// ─── ALMA (Arnaud Legoux Moving Average) ─────────────────────────────────────

class ALMA {
    /**
     * Gaussian-weighted moving average with tuneable lag.
     *
     * @param {number} period – window size
     * @param {number} offset – 0–1, shifts bell toward recent bars (default 0.85)
     *                          higher = less lag, lower = smoother
     * @param {number} sigma  – bell width (default 6)
     *                          lower = sharper/faster, higher = smoother
     */
    constructor(period, offset = 0.85, sigma = 6) {
        this.period = period;
        this.offset = offset;
        this.sigma  = sigma;
        this.values = [];
        this._buildWeights();
    }

    _buildWeights() {
        const n = this.period;
        const m = this.offset * (n - 1);
        const s = n / this.sigma;
        this._weights = new Array(n);
        let wSum = 0;
        for (let i = 0; i < n; i++) {
            this._weights[i] = Math.exp(-((i - m) ** 2) / (2 * s * s));
            wSum += this._weights[i];
        }
        this._wSum = wSum;
    }

    update(price) {
        this.values.push(price);
        if (this.values.length > this.period) this.values.shift();
        if (this.values.length < this.period) return null;
        let sum = 0;
        for (let i = 0; i < this.period; i++) sum += this._weights[i] * this.values[i];
        return sum / this._wSum;
    }

    isReady() { return this.values.length >= this.period; }

    reset(period, offset, sigma) {
        this.period = period ?? this.period;
        this.offset = offset ?? this.offset;
        this.sigma  = sigma  ?? this.sigma;
        this.values = [];
        this._buildWeights();
    }
}

// ─── Exponential Moving Average ──────────────────────────────────────────────

class EMA {
    constructor(period) {
        this.period = period;
        this.multiplier = 2 / (period + 1);
        this.value = null;
        this.count = 0;
        this._sum = 0;
    }

    update(price) {
        this.count++;
        if (this.count < this.period) {
            this._sum += price;
            return null;
        }
        if (this.count === this.period) {
            this._sum += price;
            this.value = this._sum / this.period;
            return this.value;
        }
        this.value = price * this.multiplier + this.value * (1 - this.multiplier);
        return this.value;
    }

    isReady() { return this.count >= this.period; }

    reset(period) {
        this.period = period ?? this.period;
        this.multiplier = 2 / (this.period + 1);
        this.value = null;
        this.count = 0;
        this._sum = 0;
    }
}

// ─── MACD ─────────────────────────────────────────────────────────────────────

class MACD {
    /**
     * Moving Average Convergence Divergence
     * macdLine  = EMA(fast) - EMA(slow)
     * signal    = EMA(signalPeriod) of macdLine
     * histogram = macdLine - signal
     */
    constructor(fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        this.fastPeriod   = fastPeriod;
        this.slowPeriod   = slowPeriod;
        this.signalPeriod = signalPeriod;
        this.fastEma   = new EMA(fastPeriod);
        this.slowEma   = new EMA(slowPeriod);
        this.signalEma = new EMA(signalPeriod);
    }

    update(price) {
        const fast = this.fastEma.update(price);
        const slow = this.slowEma.update(price);
        if (fast === null || slow === null) return null;
        const macdLine = fast - slow;
        const signal   = this.signalEma.update(macdLine);
        if (signal === null) return null;
        return { macd: macdLine, signal, histogram: macdLine - signal };
    }

    isReady() { return this.slowEma.isReady() && this.signalEma.isReady(); }

    reset(fastPeriod, slowPeriod, signalPeriod) {
        this.fastPeriod   = fastPeriod   ?? this.fastPeriod;
        this.slowPeriod   = slowPeriod   ?? this.slowPeriod;
        this.signalPeriod = signalPeriod ?? this.signalPeriod;
        this.fastEma.reset(this.fastPeriod);
        this.slowEma.reset(this.slowPeriod);
        this.signalEma.reset(this.signalPeriod);
    }
}

// ─── RSI ──────────────────────────────────────────────────────────────────────

class RSI {
    /**
     * Relative Strength Index (Wilder smoothing)
     * Overbought > 70, Oversold < 30
     */
    constructor(period = 14) {
        this.period    = period;
        this.count     = 0;
        this.prevPrice = null;
        this.avgGain   = 0;
        this.avgLoss   = 0;
    }

    update(price) {
        if (this.prevPrice === null) { this.prevPrice = price; return null; }
        const change = price - this.prevPrice;
        this.prevPrice = price;
        const gain = change > 0 ?  change : 0;
        const loss = change < 0 ? -change : 0;
        this.count++;
        if (this.count < this.period) {
            this.avgGain += gain;
            this.avgLoss += loss;
            return null;
        }
        if (this.count === this.period) {
            this.avgGain = (this.avgGain + gain) / this.period;
            this.avgLoss = (this.avgLoss + loss) / this.period;
        } else {
            this.avgGain = (this.avgGain * (this.period - 1) + gain) / this.period;
            this.avgLoss = (this.avgLoss * (this.period - 1) + loss) / this.period;
        }
        if (this.avgLoss === 0) return 100;
        return 100 - (100 / (1 + this.avgGain / this.avgLoss));
    }

    isReady() { return this.count >= this.period; }

    reset(period) {
        this.period    = period ?? this.period;
        this.count     = 0;
        this.prevPrice = null;
        this.avgGain   = 0;
        this.avgLoss   = 0;
    }
}

// ─── Linear Regression Slope ─────────────────────────────────────────────────

class LRS {
    /**
     * Fits y = a + b*x over a rolling window of `period` bars.
     * Returns the slope b, normalised as % of mean price per bar.
     * Also exposes the regression line endpoint as `value` (for price overlay).
     *
     * @param {number} period
     */
    constructor(period) {
        this.period = period;
        this.values = [];
        this._precompute(period);
    }

    _precompute(n) {
        // x = [0, 1, ..., n-1]
        this._sumX  = n * (n - 1) / 2;
        this._sumX2 = n * (n - 1) * (2 * n - 1) / 6;
        this._denom = n * this._sumX2 - this._sumX * this._sumX;
    }

    update(price) {
        this.values.push(price);
        if (this.values.length > this.period) this.values.shift();
        if (this.values.length < this.period) return null;

        const n   = this.period;
        let sumY  = 0;
        let sumXY = 0;
        for (let i = 0; i < n; i++) {
            sumY  += this.values[i];
            sumXY += i * this.values[i];
        }

        const slope     = (n * sumXY - this._sumX * sumY) / this._denom;
        const intercept = (sumY - slope * this._sumX) / n;
        const meanY     = sumY / n;

        // Regression line endpoint (last bar)
        const endValue  = intercept + slope * (n - 1);

        // Normalised slope: % change per bar relative to mean price
        const normSlope = meanY !== 0 ? (slope / meanY) * 100 : 0;

        return { slope: normSlope, value: endValue };
    }

    isReady() { return this.values.length >= this.period; }

    reset(period) {
        this.period = period;
        this.values = [];
        this._precompute(period);
    }
}

// ─── Derivative Analyzer ─────────────────────────────────────────────────────

class DerivativeAnalyzer {
    /**
     * @param {Object} config
     * @param {number}  config.slowSmaPeriod          – SMA period (null to disable)
     * @param {number}  config.fastKamaErPeriod        – KAMA ER period (null to disable)
     * @param {number}  config.fastKamaFastPeriod      – KAMA fast period
     * @param {number}  config.fastKamaSlowPeriod      – KAMA slow period
     * @param {number}  config.lrsPeriod               – LRS window (null to disable)
     * @param {number}  config.minBarsForConfirmation  – Bars to confirm trend (default 3)
     */
    constructor(config = {}) {
        this.minBarsForConfirmation = config.minBarsForConfirmation || 3;

        // SMA (slow)
        this.slowSmaPeriod = config.slowSmaPeriod ?? 800;
        this.sma = this.slowSmaPeriod ? new SMA(this.slowSmaPeriod) : null;

        // SMA (fast)
        this.fastSmaPeriod = config.fastSmaPeriod ?? null;
        this.fastSma = this.fastSmaPeriod ? new SMA(this.fastSmaPeriod) : null;

        // KAMA
        this.kamaConfig = {
            erPeriod:   config.fastKamaErPeriod   ?? 100,
            fastPeriod: config.fastKamaFastPeriod  ?? 2,
            slowPeriod: config.fastKamaSlowPeriod  ?? 300,
        };
        this.kama = (config.fastKamaErPeriod !== null && config.fastKamaErPeriod !== undefined)
            ? new AMA(this.kamaConfig.erPeriod, this.kamaConfig.fastPeriod, this.kamaConfig.slowPeriod)
            : null;

        // ALMA
        this.almaConfig = {
            period: config.almaPeriod ?? null,
            offset: config.almaOffset ?? 0.85,
            sigma:  config.almaSigma  ?? 6,
        };
        this.alma = this.almaConfig.period
            ? new ALMA(this.almaConfig.period, this.almaConfig.offset, this.almaConfig.sigma)
            : null;

        // LRS
        this.lrsPeriod = config.lrsPeriod ?? null;
        this.lrs = this.lrsPeriod ? new LRS(this.lrsPeriod) : null;

        // MACD
        this.macdConfig = {
            fastPeriod:   config.macdFastPeriod   ?? 12,
            slowPeriod:   config.macdSlowPeriod   ?? 26,
            signalPeriod: config.macdSignalPeriod ?? 9,
        };
        this.macd = config.macdEnabled
            ? new MACD(this.macdConfig.fastPeriod, this.macdConfig.slowPeriod, this.macdConfig.signalPeriod)
            : null;
        this.currMacd = null;
        this.prevMacd = null;

        // RSI
        this.rsiPeriod = config.rsiPeriod ?? 14;
        this.rsi = config.rsiEnabled ? new RSI(this.rsiPeriod) : null;
        this.currRsi = null;
        this.prevRsi = null;

        // Interpretation state
        this.interpConfirmBars   = config.interpConfirmBars ?? 3;
        this.interpHoldBars      = config.interpHoldBars    ?? 0;
        this.rsiOverboughtLevel  = config.rsiOverboughtLevel ?? 70;
        this.rsiOversoldLevel    = config.rsiOversoldLevel   ?? 30;
        this.rsiBullThreshold    = config.rsiBullThreshold   ?? 55;
        this.rsiBearThreshold    = config.rsiBearThreshold   ?? 45;
        this.macdMinHist         = config.macdMinHist        ?? 0;
        this.trendFilterEnabled  = config.trendFilterEnabled ?? false;
        this.trendFilterMinBars  = config.trendFilterMinBars ?? 3;
        this.momentumGateEnabled = config.momentumGateEnabled ?? false;
        this.momentumGateMinBars = config.momentumGateMinBars ?? 3;
        this.momentumGateRsiZone = config.momentumGateRsiZone ?? 35;
        this.barsInMacdDivergence = 0;
        this.barsInRsiDivergence  = 0;
        this.opt10CommitmentBars = config.opt10CommitmentBars ?? 2;
        this.prevRawInterp       = null;
        this.barsInRawInterp     = 0;
        this.currInterpretation    = 'NEUTRAL';
        this.currInterpretationRaw = 'NEUTRAL';
        this.pendingInterp         = null;
        this.pendingInterpBars     = 0;

        // Previous / current MA values (for derivative)
        this.prevSma     = null; this.currSma     = null;
        this.prevFastSma = null; this.currFastSma = null;
        this.prevKama    = null; this.currKama    = null;
        this.prevAlma    = null; this.currAlma    = null;
        this.currLrsSlope = null; this.currLrsValue = null;
        this.prevPrice = null;
        this.currPrice = null;

        // Opt 10 price/MA commitment tracking
        this.barsAboveFastSma = 0;  // consecutive bars price > fastSMA
        this.barsBelowFastSma = 0;  // consecutive bars price < fastSMA

        // Independent trend states
        this.prevRawSmaTrend     = null; this.barsInSmaTrend     = 0;
        this.prevRawFastSmaTrend = null; this.barsInFastSmaTrend = 0;
        this.prevRawKamaTrend    = null; this.barsInKamaTrend    = 0;
        this.prevRawAlmaTrend    = null; this.barsInAlmaTrend    = 0;
        this.prevRawLrsTrend     = null; this.barsInLrsTrend     = 0;

        this.updateCount = 0;
    }

    update(price, timestamp = null) {
        if (!Number.isFinite(price) || price <= 0) {
            throw new Error('price must be a positive finite number');
        }

        // Update current price at the start of the bar (before interpretation)
        this.prevPrice = this.currPrice;
        this.currPrice = price;

        // SMA (slow)
        if (this.sma) {
            this.prevSma = this.currSma;
            this.currSma = this.sma.update(price);
        }

        // SMA (fast)
        if (this.fastSma) {
            this.prevFastSma = this.currFastSma;
            this.currFastSma = this.fastSma.update(price);
        }

        // KAMA
        if (this.kama) {
            this.prevKama = this.currKama;
            this.currKama = this.kama.update(price);
        }

        // ALMA
        if (this.alma) {
            this.prevAlma = this.currAlma;
            this.currAlma = this.alma.update(price);
        }

        // LRS
        if (this.lrs) {
            const r = this.lrs.update(price);
            this.currLrsSlope = r ? r.slope : null;
            this.currLrsValue = r ? r.value : null;
        }

        // MACD — normalized as % of price so scale is comparable across all price levels
        if (this.macd) {
            this.prevMacd = this.currMacd;
            const raw = this.macd.update(price);
            if (raw !== null && price > 0) {
                this.currMacd = {
                    macd:      (raw.macd      / price) * 100,
                    signal:    (raw.signal    / price) * 100,
                    histogram: (raw.histogram / price) * 100,
                };
            } else {
                this.currMacd = null;
            }
        }

        // RSI
        if (this.rsi) {
            this.prevRsi = this.currRsi;
            this.currRsi = this.rsi.update(price);
        }

        // Advance momentum divergence counters (for Momentum Gate optimization)
        this._advanceMomentumDivergence();

        // Track consecutive bars price is above/below fastSMA (for Opt 10 commitment)
        this._advancePriceFastSmaPosition();

        // Interpretation (computed after MACD + RSI are updated)
        if (this.macd || this.rsi) {
            const rawInterp = this.trendFilterEnabled
                ? this._applyTrendFilter(this._computeInterpretation())
                : this._computeInterpretation();
            this.currInterpretationRaw = rawInterp;
            // BULL/BEAR require confirmation bars; other states are immediate
            if (rawInterp === 'BULL' || rawInterp === 'BEAR') {
                if (rawInterp === this.prevRawInterp) {
                    this.barsInRawInterp++;
                } else {
                    this.prevRawInterp   = rawInterp;
                    this.barsInRawInterp = 1;
                }
                const confirmed = this.barsInRawInterp >= this.interpConfirmBars
                    ? rawInterp : 'NEUTRAL';
                this._applyWithHysteresis(confirmed);
            } else {
                this.prevRawInterp   = rawInterp;
                this.barsInRawInterp = 0;
                this._applyWithHysteresis(rawInterp);
            }
        }

        this.updateCount++;

        // Update trend states
        const smaRaw     = this._rawSmaTrend();
        const fastSmaRaw = this._rawFastSmaTrend();
        const kamaRaw    = this._rawKamaTrend();
        const almaRaw    = this._rawAlmaTrend();
        const lrsRaw     = this._rawLrsTrend();

        this._advanceTrend(smaRaw,     'Sma');
        this._advanceTrend(fastSmaRaw, 'FastSma');
        this._advanceTrend(kamaRaw,    'Kama');
        this._advanceTrend(almaRaw,    'Alma');
        this._advanceTrend(lrsRaw,     'Lrs');

        const result = this.getAnalysis();
        if (timestamp !== null) result.timestamp = timestamp;
        return result;
    }

    _advanceTrend(raw, key) {
        const prevKey = `prevRaw${key}Trend`;
        const barsKey = `barsIn${key}Trend`;
        if (raw !== this[prevKey]) {
            this[prevKey] = raw;
            this[barsKey] = 1;
        } else {
            this[barsKey]++;
        }
    }

    // ── Derivative signs ───────────────────────────────────────

    _rawSmaTrend() {
        if (!this.sma || this.prevSma === null || this.currSma === null) return 'NEUTRAL';
        if (this.currSma > this.prevSma) return 'UP';
        if (this.currSma < this.prevSma) return 'DOWN';
        return 'NEUTRAL';
    }

    _rawFastSmaTrend() {
        if (!this.fastSma || this.prevFastSma === null || this.currFastSma === null) return 'NEUTRAL';
        if (this.currFastSma > this.prevFastSma) return 'UP';
        if (this.currFastSma < this.prevFastSma) return 'DOWN';
        return 'NEUTRAL';
    }

    _rawKamaTrend() {
        if (!this.kama || this.prevKama === null || this.currKama === null) return 'NEUTRAL';
        if (this.currKama > this.prevKama) return 'UP';
        if (this.currKama < this.prevKama) return 'DOWN';
        return 'NEUTRAL';
    }

    _rawAlmaTrend() {
        if (!this.alma || this.prevAlma === null || this.currAlma === null) return 'NEUTRAL';
        if (this.currAlma > this.prevAlma) return 'UP';
        if (this.currAlma < this.prevAlma) return 'DOWN';
        return 'NEUTRAL';
    }

    _rawLrsTrend() {
        if (!this.lrs || this.currLrsSlope === null) return 'NEUTRAL';
        if (this.currLrsSlope > 0) return 'UP';
        if (this.currLrsSlope < 0) return 'DOWN';
        return 'NEUTRAL';
    }

    _advanceMomentumDivergence() {
        if (!this.momentumGateEnabled || !this.macd || !this.rsi || !this.sma) return;
        if (this.currMacd === null || this.currRsi === null) return;

        const slowDir = this._rawSmaTrend();
        if (slowDir === 'NEUTRAL') {
            this.barsInMacdDivergence = 0;
            this.barsInRsiDivergence  = 0;
            return;
        }

        const macdOpposes =
            (slowDir === 'UP'   && this.currMacd.histogram < -this.macdMinHist) ||
            (slowDir === 'DOWN' && this.currMacd.histogram >  this.macdMinHist);

        const rsiOpposes =
            (slowDir === 'UP'   && this.currRsi < this.momentumGateRsiZone) ||
            (slowDir === 'DOWN' && this.currRsi > (100 - this.momentumGateRsiZone));

        this.barsInMacdDivergence = macdOpposes ? this.barsInMacdDivergence + 1 : 0;
        this.barsInRsiDivergence  = rsiOpposes  ? this.barsInRsiDivergence  + 1 : 0;
    }

    _advancePriceFastSmaPosition() {
        // Track consecutive bars where price is above/below fastSMA
        // Used for Opt 10: price/MA commitment validation
        if (!this.fastSma || this.currFastSma === null || this.currPrice === null) {
            this.barsAboveFastSma = 0;
            this.barsBelowFastSma = 0;
            return;
        }

        const priceAbove = this.currPrice > this.currFastSma;

        if (priceAbove) {
            this.barsAboveFastSma++;
            this.barsBelowFastSma = 0;
        } else {
            this.barsBelowFastSma++;
            this.barsAboveFastSma = 0;
        }
    }

    // ── Trend filter ─────────────────────────────────────────

    _applyTrendFilter(interp) {
        // OB/OS are exit signals — not suppressed by trend direction
        if (interp === 'OVERBOUGHT' || interp === 'OVERSOLD') return interp;

        // Compute fast MA direction and sustained bars count
        let fastDir, fastBarsInDir;
        if (this.fastSma) {
            fastDir       = this._rawFastSmaTrend();
            fastBarsInDir = (fastDir === this.prevRawFastSmaTrend ? this.barsInFastSmaTrend + 1 : 1);
        } else if (this.sma) {
            fastDir       = this._rawSmaTrend();
            fastBarsInDir = (fastDir === this.prevRawSmaTrend ? this.barsInSmaTrend + 1 : 1);
        } else {
            return interp;
        }

        if (fastDir === 'NEUTRAL') return interp;

        // Primary gate: fast MA sustained in opposite direction → suppress to NEUTRAL
        if (fastBarsInDir >= this.trendFilterMinBars) {
            if (fastDir === 'UP'   && (interp === 'BEAR' || interp === 'BEAR_WEAK')) return 'NEUTRAL';
            if (fastDir === 'DOWN' && (interp === 'BULL' || interp === 'BULL_WEAK')) return 'NEUTRAL';
        }

        // Momentum Gate (Opt 11): if MACD + RSI both diverge from SMA(500) for
        // >= momentumGateMinBars, allow signal through as WEAK instead of suppressing to NEUTRAL.
        if (this.momentumGateEnabled && this.sma) {
            const slowDir  = this._rawSmaTrend();
            const macdConf = this.barsInMacdDivergence >= this.momentumGateMinBars;
            const rsiConf  = this.barsInRsiDivergence  >= this.momentumGateMinBars;

            if (macdConf && rsiConf && slowDir !== 'NEUTRAL') {
                if (slowDir === 'UP'   && interp === 'NEUTRAL' && this.currMacd?.histogram < -this.macdMinHist) {
                    interp = 'BEAR_WEAK';
                }
                if (slowDir === 'DOWN' && interp === 'NEUTRAL' && this.currMacd?.histogram >  this.macdMinHist) {
                    interp = 'BULL_WEAK';
                }
            }
        }

        // Macro regime gate: when fastSMA and SMA(slow) are both present and disagree,
        // cap full BULL/BEAR to WEAK — a short-term dip/bounce against the macro trend
        // does not warrant a confirmed directional signal.
        //   fastSMA DOWN + SMA UP  → BEAR capped to BEAR_WEAK
        //   fastSMA UP   + SMA DOWN → BULL capped to BULL_WEAK
        if (this.fastSma && this.sma) {
            const slowDir       = this._rawSmaTrend();
            const slowBarsInDir = (slowDir === this.prevRawSmaTrend ? this.barsInSmaTrend + 1 : 1);
            if (slowDir !== 'NEUTRAL' && slowBarsInDir >= this.trendFilterMinBars && fastDir !== slowDir) {
                if (interp === 'BULL') return 'BULL_WEAK';
                if (interp === 'BEAR') return 'BEAR_WEAK';
            }
        }

        // Opt 10 — Price vs fast MA cross-check (N-bar commitment required)
        // Requires price to have been beyond fastSMA for ≥ opt10CommitmentBars consecutive bars.
        // Default: 2 bars. Adjust to tune responsiveness vs. wick filtering.
        //   1 = loose (responds to current bar position)
        //   2 = moderate (default, requires 2-bar confirmation)
        //   3+ = strict (requires sustained multi-bar position)
        if (this.fastSma && this.currFastSma !== null && this.currPrice !== null) {
            if (interp === 'BULL') {
                // BULL requires price sustained ABOVE fastSMA for ≥N bars
                if (this.barsAboveFastSma < this.opt10CommitmentBars) return 'BULL_WEAK';
            }
            if (interp === 'BEAR') {
                // BEAR requires price sustained BELOW fastSMA for ≥N bars
                if (this.barsBelowFastSma < this.opt10CommitmentBars) return 'BEAR_WEAK';
            }
        }

        return interp;
    }

    // ── Hysteresis ────────────────────────────────────────────

    _applyWithHysteresis(newInterp) {
        // OB/OS are exit signals — always immediate, bypass hold
        if (newInterp === 'OVERBOUGHT' || newInterp === 'OVERSOLD') {
            this.currInterpretation = newInterp;
            this.pendingInterp      = null;
            this.pendingInterpBars  = 0;
            return;
        }

        const curr = this.currInterpretation;
        const isDowngrade = (curr === 'BULL' && newInterp !== 'BULL')
                         || (curr === 'BEAR' && newInterp !== 'BEAR');

        if (!isDowngrade || this.interpHoldBars <= 0) {
            this.currInterpretation = newInterp;
            this.pendingInterp      = null;
            this.pendingInterpBars  = 0;
            return;
        }

        // Debounce the downgrade — must hold for interpHoldBars bars
        if (newInterp === this.pendingInterp) {
            this.pendingInterpBars++;
            if (this.pendingInterpBars >= this.interpHoldBars) {
                this.currInterpretation = newInterp;
                this.pendingInterp      = null;
                this.pendingInterpBars  = 0;
            }
        } else {
            this.pendingInterp     = newInterp;
            this.pendingInterpBars = 1;
        }
    }

    // ── Interpretation ────────────────────────────────────────

    _computeInterpretation() {
        const hist     = this.currMacd?.histogram ?? null;
        const macdLine = this.currMacd?.macd      ?? null;
        const macdSig  = this.currMacd?.signal    ?? null;
        const prevHist     = this.prevMacd?.histogram ?? null;
        const prevMacdLine = this.prevMacd?.macd      ?? null;
        const rsi = this.currRsi;

        if (hist === null && rsi === null) return 'NEUTRAL';

        // 1. MACD histogram sign with minimum magnitude filter
        const histBull = hist !== null && hist >  this.macdMinHist;
        const histBear = hist !== null && hist < -this.macdMinHist;

        // 2. MACD histogram momentum
        const histMom           = (hist !== null && prevHist !== null) ? hist - prevHist : null;
        const histWeakeningBull = histBull && histMom !== null && histMom < 0;
        const histWeakeningBear = histBear && histMom !== null && histMom > 0;

        // 3. MACD zero-line position
        const macdAboveZero = macdLine !== null && macdLine > 0;
        const macdBelowZero = macdLine !== null && macdLine < 0;

        // 5. MACD line slope — is the MACD line itself rising or falling?
        const macdLineSlope   = (macdLine !== null && prevMacdLine !== null) ? macdLine - prevMacdLine : null;
        const macdLineRising  = macdLineSlope !== null && macdLineSlope > 0;
        const macdLineFalling = macdLineSlope !== null && macdLineSlope < 0;

        // 6. RSI extremes (highest priority — exit signals)
        const rsiOverbought = rsi !== null && rsi > this.rsiOverboughtLevel;
        const rsiOversold   = rsi !== null && rsi < this.rsiOversoldLevel;

        // 7. RSI direction — rising or falling?
        const rsiSlope   = (rsi !== null && this.prevRsi !== null) ? rsi - this.prevRsi : null;
        const rsiRising  = rsiSlope !== null && rsiSlope > 0;
        const rsiFalling = rsiSlope !== null && rsiSlope < 0;

        // 8. RSI counter-trend: in opposing zone AND not recovering (direction confirms divergence)
        const rsiCounterBull = rsi !== null && rsi < this.rsiBearThreshold && !rsiRising;
        const rsiCounterBear = rsi !== null && rsi > this.rsiBullThreshold && !rsiFalling;

        // Base signal driven by MACD histogram (RSI no longer hard-gates)
        let raw = 'NEUTRAL';
        if (histBull) raw = 'BULL';
        if (histBear) raw = 'BEAR';

        // RSI extreme exit — override immediately
        if (raw === 'BULL' && rsiOverbought) return 'OVERBOUGHT';
        if (raw === 'BEAR' && rsiOversold)   return 'OVERSOLD';

        // Weak conditions:
        //   histFading:  histogram shrinking AND MACD line not supporting (any zero position)
        //   dualWeak:    histogram positive but MACD line still on wrong side of zero AND not recovering
        //   rsiCounter:  RSI in counter-trend territory AND direction confirms (standalone)
        //
        // Note: histogram = MACD line − Signal line, so macdBelowSignal is always false when
        // histBull is true. Signal line crossover is not a valid structural check here.
        const histFadingBull = histWeakeningBull && !macdLineRising;
        const histFadingBear = histWeakeningBear && !macdLineFalling;
        const dualWeakBull   = histBull && macdBelowZero && !macdLineRising;
        const dualWeakBear   = histBear && macdAboveZero && !macdLineFalling;

        const bullWeak = histFadingBull || dualWeakBull || rsiCounterBull;
        const bearWeak = histFadingBear || dualWeakBear || rsiCounterBear;

        if (raw === 'BULL' && bullWeak) return 'BULL_WEAK';
        if (raw === 'BEAR' && bearWeak) return 'BEAR_WEAK';

        return raw;
    }

    // ── Analysis ───────────────────────────────────────────────

    getAnalysis() {
        const warmupNeeded = Math.max(
            this.sma     ? this.slowSmaPeriod : 0,
            this.fastSma ? this.fastSmaPeriod : 0,
            this.kama    ? this.kamaConfig.erPeriod + 1 : 0,
            this.alma    ? this.almaConfig.period : 0,
            this.lrs     ? this.lrsPeriod : 0,
            this.macd    ? this.macdConfig.slowPeriod + this.macdConfig.signalPeriod : 0,
            this.rsi     ? this.rsiPeriod + 1 : 0
        );

        if (this.updateCount < warmupNeeded) {
            return {
                isReady: false,
                reason:  `Warming up: ${this.updateCount}/${warmupNeeded} candles`,
                trend: 'NEUTRAL', confidence: 0, isConfirmed: false,
                ...this._emptySignals(),
                price: this.currPrice, updateCount: this.updateCount,
            };
        }

        const smaRaw     = this._rawSmaTrend();
        const fastSmaRaw = this._rawFastSmaTrend();
        const kamaRaw    = this._rawKamaTrend();
        const almaRaw    = this._rawAlmaTrend();
        const lrsRaw     = this._rawLrsTrend();

        const smaConf     = this._conf(smaRaw,     this.barsInSmaTrend);
        const fastSmaConf = this._conf(fastSmaRaw, this.barsInFastSmaTrend);
        const kamaConf    = this._conf(kamaRaw,    this.barsInKamaTrend);
        const almaConf    = this._conf(almaRaw,    this.barsInAlmaTrend);
        const lrsConf     = this._conf(lrsRaw,     this.barsInLrsTrend);

        const smaConfirmed     = smaRaw     !== 'NEUTRAL' && this.barsInSmaTrend     >= this.minBarsForConfirmation;
        const fastSmaConfirmed = fastSmaRaw !== 'NEUTRAL' && this.barsInFastSmaTrend >= this.minBarsForConfirmation;
        const kamaConfirmed    = kamaRaw    !== 'NEUTRAL' && this.barsInKamaTrend    >= this.minBarsForConfirmation;
        const almaConfirmed    = almaRaw    !== 'NEUTRAL' && this.barsInAlmaTrend    >= this.minBarsForConfirmation;
        const lrsConfirmed     = lrsRaw     !== 'NEUTRAL' && this.barsInLrsTrend     >= this.minBarsForConfirmation;

        // Primary: ALMA > KAMA > LRS > fastSMA > SMA
        const primary     = this.alma ? almaRaw  : this.kama ? kamaRaw  : this.lrs ? lrsRaw  : this.fastSma ? fastSmaRaw  : smaRaw;
        const primConf    = this.alma ? almaConf : this.kama ? kamaConf : this.lrs ? lrsConf : this.fastSma ? fastSmaConf : smaConf;
        const primConfirm = this.alma ? almaConfirmed : this.kama ? kamaConfirmed : this.lrs ? lrsConfirmed : this.fastSma ? fastSmaConfirmed : smaConfirmed;

        return {
            isReady: true,
            trend:       primConfirm ? primary : 'NEUTRAL',
            confidence:  primConf,
            isConfirmed: primConfirm,
            rawTrend:    primary,
            barsInTrend: this.alma ? this.barsInAlmaTrend : this.kama ? this.barsInKamaTrend : this.lrs ? this.barsInLrsTrend : this.fastSma ? this.barsInFastSmaTrend : this.barsInSmaTrend,
            // SMA (slow)
            smaRawTrend:    smaRaw,
            smaTrend:       smaConfirmed ? smaRaw : 'NEUTRAL',
            smaBarsInTrend: this.barsInSmaTrend,
            smaConfidence:  smaConf,
            // SMA (fast)
            fastSmaRawTrend:    fastSmaRaw,
            fastSmaTrend:       fastSmaConfirmed ? fastSmaRaw : 'NEUTRAL',
            fastSmaBarsInTrend: this.barsInFastSmaTrend,
            fastSmaConfidence:  fastSmaConf,
            // KAMA
            kamaRawTrend:    kamaRaw,
            kamaTrend:       kamaConfirmed ? kamaRaw : 'NEUTRAL',
            kamaBarsInTrend: this.barsInKamaTrend,
            kamaConfidence:  kamaConf,
            // ALMA
            almaRawTrend:    almaRaw,
            almaTrend:       almaConfirmed ? almaRaw : 'NEUTRAL',
            almaBarsInTrend: this.barsInAlmaTrend,
            almaConfidence:  almaConf,
            // LRS
            lrsRawTrend:    lrsRaw,
            lrsTrend:       lrsConfirmed ? lrsRaw : 'NEUTRAL',
            lrsBarsInTrend: this.barsInLrsTrend,
            lrsConfidence:  lrsConf,
            lrsSlope:       this.currLrsSlope !== null ? Math.round(this.currLrsSlope * 1e6) / 1e6 : null,
            // MACD
            macdLine:      this.currMacd ? Math.round(this.currMacd.macd      * 1e8) / 1e8 : null,
            macdSignal:    this.currMacd ? Math.round(this.currMacd.signal    * 1e8) / 1e8 : null,
            macdHistogram: this.currMacd ? Math.round(this.currMacd.histogram * 1e8) / 1e8 : null,
            macdTrend: this.currMacd
                ? (this.currMacd.histogram > 0 ? 'BULL' : this.currMacd.histogram < 0 ? 'BEAR' : 'NEUTRAL')
                : null,
            // RSI
            rsi: this.currRsi !== null ? Math.round(this.currRsi * 100) / 100 : null,
            rsiZone: this.currRsi !== null
                ? (this.currRsi > this.rsiOverboughtLevel ? 'OVERBOUGHT' : this.currRsi < this.rsiOversoldLevel ? 'OVERSOLD' : 'NEUTRAL')
                : null,
            // Combined interpretation
            interpretation:    this.currInterpretation,
            interpretationRaw: this.currInterpretationRaw,
            interpretationBars: this.barsInRawInterp,
            // Values
            price:       this.currPrice,
            slowSma:     this.currSma     !== null ? Math.round(this.currSma     * 1e6) / 1e6 : null,
            fastSmaValue: this.currFastSma !== null ? Math.round(this.currFastSma * 1e6) / 1e6 : null,
            fastKama:    this.currKama    !== null ? Math.round(this.currKama    * 1e6) / 1e6 : null,
            almaValue:   this.currAlma    !== null ? Math.round(this.currAlma    * 1e6) / 1e6 : null,
            lrsValue:    this.currLrsValue !== null ? Math.round(this.currLrsValue * 1e6) / 1e6 : null,
            updateCount: this.updateCount,
        };
    }

    _conf(raw, bars) {
        return raw !== 'NEUTRAL' ? Math.min(100, Math.round((bars / 20) * 100)) : 0;
    }

    _emptySignals() {
        return {
            smaRawTrend: 'NEUTRAL', smaTrend: 'NEUTRAL', smaBarsInTrend: 0, smaConfidence: 0,
            fastSmaRawTrend: 'NEUTRAL', fastSmaTrend: 'NEUTRAL', fastSmaBarsInTrend: 0, fastSmaConfidence: 0,
            kamaRawTrend: 'NEUTRAL', kamaTrend: 'NEUTRAL', kamaBarsInTrend: 0, kamaConfidence: 0,
            almaRawTrend: 'NEUTRAL', almaTrend: 'NEUTRAL', almaBarsInTrend: 0, almaConfidence: 0,
            lrsRawTrend: 'NEUTRAL', lrsTrend: 'NEUTRAL', lrsBarsInTrend: 0, lrsConfidence: 0,
            lrsSlope: null, slowSma: null, fastSmaValue: null, fastKama: null, almaValue: null, lrsValue: null,
            macdLine: null, macdSignal: null, macdHistogram: null, macdTrend: null,
            rsi: null, rsiZone: null,
            interpretation: 'NEUTRAL', interpretationRaw: 'NEUTRAL', interpretationBars: 0,
        };
    }

    reset() {
        if (this.sma)     this.sma.reset(this.slowSmaPeriod);
        if (this.fastSma) this.fastSma.reset(this.fastSmaPeriod);
        if (this.kama)    this.kama = new AMA(this.kamaConfig.erPeriod, this.kamaConfig.fastPeriod, this.kamaConfig.slowPeriod);
        if (this.alma)    this.alma.reset(this.almaConfig.period, this.almaConfig.offset, this.almaConfig.sigma);
        if (this.lrs)     this.lrs.reset(this.lrsPeriod);
        if (this.macd)    this.macd.reset(this.macdConfig.fastPeriod, this.macdConfig.slowPeriod, this.macdConfig.signalPeriod);
        if (this.rsi)     this.rsi.reset(this.rsiPeriod);
        this.currMacd = null; this.prevMacd = null;
        this.currRsi  = null;
        this.prevRawInterp = null; this.barsInRawInterp = 0;
        this.currInterpretation = 'NEUTRAL'; this.currInterpretationRaw = 'NEUTRAL';
        this.prevSma     = null; this.currSma     = null;
        this.prevFastSma = null; this.currFastSma = null;
        this.prevKama    = null; this.currKama    = null;
        this.prevAlma    = null; this.currAlma    = null;
        this.currLrsSlope = null; this.currLrsValue = null;
        this.currPrice = null;
        this.prevRawSmaTrend     = null; this.barsInSmaTrend     = 0;
        this.prevRawFastSmaTrend = null; this.barsInFastSmaTrend = 0;
        this.prevRawKamaTrend    = null; this.barsInKamaTrend    = 0;
        this.prevRawAlmaTrend    = null; this.barsInAlmaTrend    = 0;
        this.prevRawLrsTrend     = null; this.barsInLrsTrend     = 0;
        this.updateCount = 0;
    }

    getUpdateCount() { return this.updateCount; }
}

module.exports = { DerivativeAnalyzer, SMA, LRS };
