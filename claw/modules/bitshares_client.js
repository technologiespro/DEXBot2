const BitSharesLib = require('btsdex');
const { TIMING } = require('../../modules/constants');

const DEFAULT_TIMEOUT_MS = TIMING.CONNECTION_TIMEOUT_MS;
const DEFAULT_CHECK_INTERVAL_MS = TIMING.CHECK_INTERVAL_MS;

let connected = false;
let suppressConnectionLog = false;
let connectionListenersAttached = false;

function attachConnectionListeners() {
  if (connectionListenersAttached) {
    return;
  }

  if (typeof BitSharesLib.subscribe !== 'function') {
    return;
  }

  try {
    BitSharesLib.subscribe('connected', () => {
      connected = true;
      if (!suppressConnectionLog) {
        console.log('BitShares shared client connected');
      }
    });

    BitSharesLib.subscribe('disconnected', () => {
      connected = false;
      if (!suppressConnectionLog) {
        console.warn('BitShares shared client disconnected');
      }
    });
  } catch (_) {
    // Some runtimes may not expose subscription hooks at require time.
  }

  connectionListenersAttached = true;
}

function ensureConnectionListeners() {
  attachConnectionListeners();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setSuppressConnectionLog(suppress) {
  suppressConnectionLog = Boolean(suppress);
}

async function waitForConnected(timeoutMs = DEFAULT_TIMEOUT_MS) {
  ensureConnectionListeners();
  const start = Date.now();

  while (!connected) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for BitShares connection after ${timeoutMs}ms`);
    }
    await sleep(DEFAULT_CHECK_INTERVAL_MS);
  }
}

function createAccountClient(accountName, privateKey) {
  if (!accountName) {
    throw new Error('accountName is required');
  }
  if (!privateKey) {
    throw new Error('privateKey is required');
  }

  return new BitSharesLib(accountName, privateKey);
}

module.exports = {
  BitShares: BitSharesLib,
  createAccountClient,
  getNodeManager: () => null,
  getNodeStats: () => null,
  getNodeSummary: () => null,
  isConnected: () => connected,
  setSuppressConnectionLog,
  waitForConnected
};
