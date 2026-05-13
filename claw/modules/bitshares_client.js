const BitSharesLib = require('btsdex');
const btsdexEventPatch = require('../../modules/btsdex_event_patch');
const { TIMING } = require('../../modules/constants');

const DEFAULT_TIMEOUT_MS = TIMING.CONNECTION_TIMEOUT_MS;
const DEFAULT_CHECK_INTERVAL_MS = TIMING.CHECK_INTERVAL_MS;

let connected = false;
let suppressConnectionLog = false;
let connectionListenersAttached = false;

function handleConnectionStatus(status) {
  if (status === 'open') {
    connected = true;
    if (!suppressConnectionLog) {
      console.log('BitShares shared client connected');
    }
  }
  if (status === 'closed' || status === 'closing') {
    connected = false;
    if (!suppressConnectionLog) {
      console.warn('BitShares shared client disconnected');
    }
  }
}

function attachConnectionListeners() {
  if (connectionListenersAttached) {
    return;
  }

  try {
    if (typeof btsdexEventPatch.addStatusCallback === 'function') {
      btsdexEventPatch.addStatusCallback(handleConnectionStatus);
    }
  } catch (_) {
    // Some runtimes may not expose subscription hooks at require time.
  }

  connectionListenersAttached = true;
}

function ensureConnectionListeners() {
  attachConnectionListeners();
}

const { sleep } = require('../../modules/order/utils/system');

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

async function createAccountClient(accountName, privateKey) {
  if (!accountName) {
    throw new Error('accountName is required');
  }
  if (!privateKey) {
    throw new Error('privateKey is required');
  }

  await waitForConnected();
  const feeSymbol = (BitSharesLib.chain && BitSharesLib.chain.coreAsset) || 'BTS';
  return new BitSharesLib(accountName, privateKey, feeSymbol);
}

module.exports = {
  BitShares: BitSharesLib,
  createAccountClient,
  isConnected: () => connected,
  setSuppressConnectionLog,
  waitForConnected
};
