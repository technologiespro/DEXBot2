/**
 * KIBANA ELASTICSEARCH CLIENT
 *
 * Shared HTTP client for querying the BitShares Kibana instance.
 * Extracted from kibana_source.js and kibana_bot_queries.js to
 * eliminate duplication.
 *
 * All Kibana-consuming modules should use this client instead of
 * maintaining their own HTTP implementation.
 *
 * Data source:
 *   Kibana: https://kibana.bitshares.dev
 *   Index:  bitshares-*  (time field: block_data.block_time)
 */

'use strict';

const https = require('https');

const KIBANA_URL = 'https://kibana.bitshares.dev';
const INDEX      = 'bitshares-*';

const DEFAULT_CONFIG = Object.freeze({
  kibanaUrl:  KIBANA_URL,
  apiKey:     null,     // 'base64(id:key)' if auth required
  timeout:    15000,
});

const PROXY_PATH = (index) =>
  `/api/console/proxy?path=${encodeURIComponent(index + '/_search')}&method=POST`;

/**
 * ES fixed_interval string from seconds.
 * calendar_interval only supports 1m, 1h, 1d, 1w, 1M, 1q, 1y —
 * anything else (4h, 15m, 5m …) silently fails and returns no buckets.
 */
function toFixedInterval(seconds) {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600  === 0) return `${seconds / 3600}h`;
  if (seconds % 60    === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/**
 * Execute an Elasticsearch query against the Kibana proxy.
 *
 * @param {Object} config   – { kibanaUrl, apiKey, timeout }
 * @param {Object} esQuery  – Elasticsearch query body
 * @returns {Promise<Object>} Parsed JSON response
 */
function kibanaSearch(config, esQuery) {
  return new Promise((resolve, reject) => {
    const cfg  = { ...DEFAULT_CONFIG, ...config };
    const body = JSON.stringify(esQuery);
    const url  = new URL(cfg.kibanaUrl);

    const headers = {
      'Content-Type':   'application/json',
      'kbn-xsrf':       'true',
      'Content-Length': Buffer.byteLength(body),
    };
    if (cfg.apiKey) headers['Authorization'] = `ApiKey ${cfg.apiKey}`;

    const req = https.request({
      hostname: url.hostname,
      port:     url.port || 443,
      path:     PROXY_PATH(INDEX),
      method:   'POST',
      headers,
      timeout:  cfg.timeout,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new Error(
            `Kibana auth required (HTTP ${res.statusCode}). ` +
            `Set config.apiKey — generate in Kibana → Stack Management → API Keys.`
          ));
          return;
        }
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message}\n${raw.slice(0, 200)}`)); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Kibana request timed out')); });
    req.write(body);
    req.end();
  });
}

module.exports = {
  DEFAULT_CONFIG,
  INDEX,
  KIBANA_URL,
  kibanaSearch,
  toFixedInterval,
};
