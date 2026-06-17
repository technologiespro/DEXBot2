'use strict';

const fs = require('fs');
const { isPidAlive } = require('./bot_supervisor');

const STATUS_COLORS = {
    reset: '\x1b[0m',
    title: '\x1b[1;33m',
    label: '\x1b[38;5;208m',
    ok: '\x1b[1;92m',
    warn: '\x1b[1;31m',
    muted: '\x1b[97m',
};

function colorStatus(text: string, color: string, stream: any = process.stdout): string {
    return stream.isTTY && !process.env.NO_COLOR ? `${color}${text}${STATUS_COLORS.reset}` : text;
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
    return colorStatus(text, STATUS_COLORS.warn, process.stderr);
}

function readProcStat(pid) {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const lastParen = stat.lastIndexOf(')');
        if (lastParen === -1) return null;
        const fields = stat.slice(lastParen + 2).split(/\s+/);
        return {
            utime: parseInt(fields[11], 10) || 0,
            stime: parseInt(fields[12], 10) || 0,
            starttime: parseInt(fields[19], 10) || 0,
        };
    } catch {
        return null;
    }
}

function readProcMemMB(pid) {
    try {
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
        if (match) {
            return `${Math.round(parseInt(match[1], 10) / 1024)}MB`;
        }
    } catch {}
    return '-';
}

function readProcCpuTotal(pid) {
    try {
        const stat = readProcStat(pid);
        if (!stat) return null;
        return (stat.utime + stat.stime) / 100;
    } catch {
        return null;
    }
}

function readProcCpuTime(pid) {
    try {
        const totalSec = readProcCpuTotal(pid);
        if (totalSec == null) return '-';
        if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
        const m = Math.floor(totalSec / 60);
        const s = Math.floor(totalSec % 60);
        if (m < 60) return `${m}m ${s}s`;
        const h = Math.floor(m / 60);
        return `${h}h ${m % 60}m`;
    } catch {
        return '-';
    }
}

async function readProcCpuPercent(pid, samples = 2, intervalMs = 400) {
    try {
        const snap = () => {
            const stat = readProcStat(pid);
            if (!stat) return null;
            return { pidCpu: stat.utime + stat.stime, ts: Date.now() };
        };
        let prev = snap();
        if (!prev) return '-';
        for (let i = 0; i < samples - 1; i++) {
            await new Promise(r => setTimeout(r, intervalMs));
        }
        const cur = snap();
        if (!cur) return '-';
        const dt = (cur.ts - prev.ts) / 1000;
        const dcpu = (cur.pidCpu - prev.pidCpu) / 100;
        if (dt <= 0) return '-';
        const pct = (dcpu / dt) * 100;
        return `${pct.toFixed(1)}%`;
    } catch {
        return '-';
    }
}

function readProcCmdline(pid) {
    return readProcArgs(pid).join(' ');
}

function readProcArgs(pid) {
    if (!isPidAlive(pid)) return [];
    try {
        return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    } catch {
        return [];
    }
}

function readProcUptime(pid) {
    try {
        const stat = readProcStat(pid);
        if (!stat) return '-';
        const uptimeSec = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0]);
        const clkTck = 100;
        const processStartSec = stat.starttime / clkTck;
        const uptimeMs = (uptimeSec - processStartSec) * 1000;
        return formatControlUptime(uptimeMs);
    } catch {
        return '-';
    }
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
