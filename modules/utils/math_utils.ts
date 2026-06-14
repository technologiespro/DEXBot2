function roundTo(value: number, factor: number): number {
    if (!Number.isFinite(value)) return NaN;
    return Math.round(value * factor) / factor;
}

function fixedTo(value: number | string, decimals: number): string {
    return Number(value).toFixed(decimals);
}

function roundToDecimals(value: number, decimals: number): number {
    if (!Number.isFinite(value)) return NaN;
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
}

export = { roundTo, fixedTo, roundToDecimals };
