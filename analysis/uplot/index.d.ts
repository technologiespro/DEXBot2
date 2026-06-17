declare class uPlot {
    constructor(
        opts: uPlot.Options,
        data: uPlot.Data,
        el: HTMLElement
    );

    setSize(size: { width: number; height: number }): void;
    setScale(scale: string, limits: { min: number; max: number }): void;
    setData(data: uPlot.Data): void;
    batch(fn: () => void): void;

    posToVal(pos: number, scale: string): number;
    valToPos(val: number, scale: string): number;

    readonly bbox: { left: number; top: number; width: number; height: number };
    readonly pxRatio: number;
    readonly scales: Record<string, { min?: number; max?: number }>;
    readonly cursor: { idx: number };
    readonly over: HTMLElement;
    readonly root: HTMLElement;

    destroy(): void;

    static paths: {
        bars: (opts?: { size?: number[]; align?: number }) => uPlot.Series.PathBuilder;
    };
    static assign<T extends object>(target: T, ...sources: Partial<T>[]): T;
}

declare namespace uPlot {
    type Data = [
        number[],
        ...Array<(number | null)[]>
    ];

    interface Options {
        title?: string;
        id?: string;
        class?: string;
        width?: number;
        height?: number;
        series: Series[];
        scales?: Record<string, Scale>;
        axes?: Axis[];
        legend?: Legend;
        cursor?: Cursor;
        hooks?: Hooks;
        plugins?: Plugin[];
    }

    interface Series {
        label: string;
        value?: (self: uPlot, raw: number) => string | number;
        class?: string;
        width?: number;
        dash?: number[];
        color?: string;
        fill?: string;
        paths?: (u: uPlot, seriesIdx: number, idx0: number, idx1: number) => Paths | null;
        points?: { show: boolean };
        scale?: string;
        spanGaps?: boolean;
        alpha?: number;
    }

    type PathBuilder = (u: uPlot, seriesIdx: number, idx0: number, idx1: number) => Paths | null;

    interface Paths {
        path: CanvasRenderingContext2D | Path2D | null;
        clip: CanvasRenderingContext2D | Path2D | null;
        _fill?: string;
    }

    interface Scale {
        time?: boolean;
        auto?: boolean;
        range?: (u: uPlot, min: number, max: number) => [number, number];
        distr?: number;
        log?: number;
        dir?: number;
        or?: number;
    }

    interface Axis {
        scale?: string;
        show?: boolean;
        size?: number;
        label?: string;
        values?: (u: uPlot, vals: number[], ticks: number[]) => string[];
        stroke?: string;
        grid?: { show: boolean; stroke?: string; width?: number };
        ticks?: { show: boolean; stroke?: string; width?: number };
    }

    interface Legend {
        show?: boolean;
        live?: boolean;
    }

    interface Cursor {
        show?: boolean;
        lock?: boolean;
        idx?: number;
        bind?: { mousedown?: string; mouseup?: string; click?: string; dblclick?: string };
        sync?: { key: string; setSeries?: boolean; scales?: boolean };
        drag?: { x?: boolean; y?: boolean; uni?: boolean; dist?: number };
    }

    interface Hooks {
        init?: Array<(self: uPlot) => void>;
        setSize?: Array<(self: uPlot) => void>;
        setScale?: Array<(self: uPlot) => void>;
        setSeries?: Array<(self: uPlot) => void>;
        draw?: Array<(self: uPlot) => void>;
        drawAxes?: Array<(self: uPlot) => void>;
        drawSeries?: Array<(self: uPlot) => void>;
        ready?: Array<(self: uPlot) => void>;
        prepend?: Array<(self: uPlot, canvas: HTMLCanvasElement) => void>;
    }

    interface Plugin {
        hooks: Hooks;
    }
}

export = uPlot;
export as namespace uPlot;
