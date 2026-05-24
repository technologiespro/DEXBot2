// @ts-nocheck
const fs = require('fs');
const path = require('path');
const { NODE_MANAGEMENT } = require('./constants');

const DEFAULT_HEALTH_CACHE_FILE = path.join(__dirname, '..', 'profiles', 'node_health_cache.json');

function resolveHealthCacheFile(config = {}) {
    if (typeof config.healthCacheFile === 'string' && config.healthCacheFile.trim()) {
        return config.healthCacheFile;
    }
    if (typeof config.stateDir === 'string' && config.stateDir.trim()) {
        return path.join(config.stateDir, 'node_health_cache.json');
    }
    return DEFAULT_HEALTH_CACHE_FILE;
}

function normalizeNodeList(nodes) {
    return Array.isArray(nodes)
        ? nodes.filter((node) => typeof node === 'string' && node.trim())
        : [];
}

function buildHealthCachePayload(stats, now = Date.now()) {
    const nodes = Array.from(stats || [])
        .filter((stat) => stat && (stat.status === 'healthy' || stat.status === 'slow'))
        .map((stat) => ({
            url: stat.url,
            status: stat.status,
            latencyMs: Number.isFinite(stat.latencyMs) ? stat.latencyMs : null,
            lastCheckTime: stat.lastCheckTime || null,
        }))
        .filter((stat) => typeof stat.url === 'string' && stat.url.trim());

    nodes.sort((a, b) => {
        if (a.status !== b.status) return a.status === 'healthy' ? -1 : 1;
        return (a.latencyMs || Infinity) - (b.latencyMs || Infinity);
    });

    return {
        version: 1,
        updatedAt: new Date(now).toISOString(),
        updatedAtMs: now,
        nodes,
    };
}

function writeHealthCache(stats, options = {}) {
    const file = resolveHealthCacheFile(options);
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const payload = buildHealthCachePayload(stats, now);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return payload;
}

function readHealthCache(options = {}) {
    const file = resolveHealthCacheFile(options);
    const maxAgeMs = Number.isFinite(options.maxAgeMs)
        ? options.maxAgeMs
        : NODE_MANAGEMENT.HEALTH_CHECK_INTERVAL_MS;
    const now = Number.isFinite(options.now) ? options.now : Date.now();

    try {
        if (!fs.existsSync(file)) return null;
        const raw = fs.readFileSync(file, 'utf8');
        const payload = JSON.parse(raw);
        if (!payload || payload.version !== 1 || !Array.isArray(payload.nodes)) return null;
        if (!Number.isFinite(payload.updatedAtMs)) return null;
        if (maxAgeMs >= 0 && now - payload.updatedAtMs > maxAgeMs) return null;

        const nodes = payload.nodes
            .filter((node) => node && (node.status === 'healthy' || node.status === 'slow'))
            .filter((node) => typeof node.url === 'string' && node.url.trim())
            .sort((a, b) => {
                if (a.status !== b.status) return a.status === 'healthy' ? -1 : 1;
                return (a.latencyMs || Infinity) - (b.latencyMs || Infinity);
            });

        return {
            ...payload,
            nodes,
        };
    } catch (_: any) {
        return null;
    }
}

function orderNodesFromHealthCache(configuredNodes, options = {}) {
    const configured = normalizeNodeList(configuredNodes);
    const configuredSet = new Set(configured);
    const cache = readHealthCache(options);
    if (!cache || cache.nodes.length === 0) return configured;

    const ordered = [];
    for (const node of cache.nodes) {
        if (!configuredSet.has(node.url) || ordered.includes(node.url)) continue;
        ordered.push(node.url);
    }
    for (const node of configured) {
        if (!ordered.includes(node)) ordered.push(node);
    }
    return ordered;
}

function resolveConfiguredNodes(settings) {
    const nodeSettings = settings?.NODES;
    const configuredNodes = normalizeNodeList(nodeSettings?.list);
    return configuredNodes.length > 0
        ? configuredNodes
        : NODE_MANAGEMENT.DEFAULT_NODES;
}

function resolveHealthCacheMaxAgeMs(settings) {
    const configuredInterval = settings?.NODES?.healthCheck?.intervalMs;
    return Number.isFinite(configuredInterval)
        ? configuredInterval
        : NODE_MANAGEMENT.HEALTH_CHECK_INTERVAL_MS;
}

function orderNodesForSettings(settings, options = {}) {
    if (settings?.NODES?.healthCheck?.enabled === false) {
        return resolveConfiguredNodes(settings);
    }
    return orderNodesFromHealthCache(resolveConfiguredNodes(settings), {
        ...options,
        maxAgeMs: Number.isFinite(options.maxAgeMs)
            ? options.maxAgeMs
            : resolveHealthCacheMaxAgeMs(settings),
    });
}

export = {
    DEFAULT_HEALTH_CACHE_FILE,
    buildHealthCachePayload,
    orderNodesFromHealthCache,
    orderNodesForSettings,
    readHealthCache,
    resolveConfiguredNodes,
    resolveHealthCacheFile,
    resolveHealthCacheMaxAgeMs,
    writeHealthCache,
};
