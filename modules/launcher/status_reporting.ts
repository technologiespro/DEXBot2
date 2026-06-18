'use strict';

const { getProcessDiscovery } = require('../process_discovery');
const { Config } = require('../config');
const { runtime } = require('../runtime');

const STATUS_COLORS = {
    reset: '\x1b[0m',
    title: '\x1b[1;33m',
    label: '\x1b[38;5;208m',
    ok: '\x1b[1;92m',
    warn: '\x1b[1;31m',
    muted: '\x1b[97m',
};

function colorStatus(text: string, color: string, stream: any = runtime.stdout): string {
    return stream.isTTY && !Config.NO_COLOR ? `${color}${text}${STATUS_COLORS.reset}` : text;
}

function statusTitle(text) {
    return colorStatus(text, STATUS_COLORS.title);
}

function statusLabel(text) {
    return colorStatus(text, STATUS_COLORS.label);
}

function statusBool(value) {
    return colorStatus(value ? 'yes' : 'no', value ? STATUS_COLORS.ok : STATUS_COLORS.warn);
}

function statusActiveBotName(name) {
    return colorStatus(name, STATUS_COLORS.ok);
}

function statusSuccess(text) {
    return colorStatus(text, STATUS_COLORS.ok);
}

function statusError(text) {
    return colorStatus(text, STATUS_COLORS.warn, runtime.stderr);
}

function readProcStat(pid) {
    return getProcessDiscovery().readStat(pid);
}

function readProcMemMB(pid) {
    return getProcessDiscovery().readMemMB(pid);
}

function readProcCpuTotal(pid) {
    const stat = readProcStat(pid);
    if (!stat) return null;
    return (stat.utime + stat.stime) / 100;
}

function readProcCpuTime(pid) {
    return getProcessDiscovery().readCpuTime(pid);
}

async function readProcCpuPercent(pid, samples = 2, intervalMs = 400) {
    return getProcessDiscovery().readCpuPercent(pid, samples, intervalMs);
}

function readProcCmdline(pid) {
    return getProcessDiscovery().readCmdline(pid);
}

function readProcArgs(pid) {
    return getProcessDiscovery().readArgs(pid);
}

function readProcUptime(pid) {
    return getProcessDiscovery().readUptime(pid);
}

function formatControlUptime(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
}

function formatMemoryWithUptime(memory, uptime) {
    return uptime && uptime !== '-' ? `${memory} (${uptime})` : memory;
}

function printControlStatus(status: any) {
    const entries = Object.entries(status);
    if (entries.length === 0) {
        console.log('No bots');
        return;
    }
    const nameWidth = Math.max(...entries.map(([n]: any) => n.length), 8);
    const header = `${'NAME'.padEnd(nameWidth)} | STATUS    | PID   | RESTARTS | UPTIME`;
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const [name, s] of entries as [string, any][]) {
        const uptime = s.uptimeMs ? formatControlUptime(s.uptimeMs) : '-';
        console.log(
            `${name.padEnd(nameWidth)} | ${(s.status || '-').padEnd(9)} | ${String(s.pid || '-').padEnd(5)} | ${String(s.restarts).padEnd(8)} | ${uptime}`
        );
    }
}

export = {
    STATUS_COLORS,
    colorStatus,
    statusTitle,
    statusLabel,
    statusBool,
    statusActiveBotName,
    statusSuccess,
    statusError,
    readProcStat,
    readProcMemMB,
    readProcCpuTotal,
    readProcCpuTime,
    readProcCpuPercent,
    readProcCmdline,
    readProcArgs,
    readProcUptime,
    formatControlUptime,
    formatMemoryWithUptime,
    printControlStatus,
};
