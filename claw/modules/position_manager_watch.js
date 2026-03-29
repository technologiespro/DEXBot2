const fsPromises = require('fs/promises');
const path = require('path');
const { PositionManager, DEFAULT_STATE_PATH } = require('./position_manager');
const { waitForConnected } = require('./bitshares_client');

const DEFAULT_HEALTH_PATH = path.join(process.cwd(), 'data', 'watcher-health.json');
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function parsePositionManagerWatchArgs(argv = [], env = process.env) {
  const options = {
    accountName: env.BITSHARES_ACCOUNT || null,
    healthPath: DEFAULT_HEALTH_PATH,
    maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
    statePath: DEFAULT_STATE_PATH,
    syncIntervalMs: 300000
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--account' && next) {
      options.accountName = next;
      i += 1;
    } else if (arg === '--state' && next) {
      options.statePath = next;
      i += 1;
    } else if (arg === '--sync-interval' && next) {
      options.syncIntervalMs = Number(next);
      i += 1;
    } else if (arg === '--health-path' && next) {
      options.healthPath = next;
      i += 1;
    } else if (arg === '--max-failures' && next) {
      options.maxConsecutiveFailures = Number(next);
      i += 1;
    }
  }

  return options;
}

async function main(argv = process.argv.slice(2), env = process.env, logger = console) {
  const options = parsePositionManagerWatchArgs(argv, env);
  const watcher = await runPositionManagerWatch({
    ...options,
    logger
  });

  const handleSignal = () => {
    watcher.stop().finally(() => process.exit(0));
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
}

function resolveLogger(logger) {
  const fallback = console;
  return {
    info: typeof logger?.info === 'function' ? logger.info.bind(logger) : fallback.log.bind(fallback),
    warn: typeof logger?.warn === 'function' ? logger.warn.bind(logger) : fallback.warn.bind(fallback),
    error: typeof logger?.error === 'function' ? logger.error.bind(logger) : fallback.error.bind(fallback)
  };
}

function createPositionManagerWatcher(options = {}) {
  const logger = resolveLogger(options.logger);
  const resolvedOptions = {
    accountName: options.accountName || process.env.BITSHARES_ACCOUNT || null,
    healthPath: options.healthPath || DEFAULT_HEALTH_PATH,
    maxConsecutiveFailures: Number.isFinite(Number(options.maxConsecutiveFailures))
      ? Number(options.maxConsecutiveFailures)
      : DEFAULT_MAX_CONSECUTIVE_FAILURES,
    statePath: options.statePath || DEFAULT_STATE_PATH,
    syncIntervalMs: Number.isFinite(Number(options.syncIntervalMs)) && Number(options.syncIntervalMs) > 0
      ? Number(options.syncIntervalMs)
      : 300000
  };

  const manager = new PositionManager({ statePath: resolvedOptions.statePath });
  let running = false;
  let syncTimer = null;
  let unsubscribe = null;

  // Health tracking state
  let consecutiveFailures = 0;
  let lastSuccessAt = null;
  let lastFailureAt = null;
  let lastFailureMessage = null;
  let healthWriteChain = Promise.resolve();

  function getHealth() {
    return {
      checkedAt: new Date().toISOString(),
      consecutiveFailures,
      lastFailureAt,
      lastFailureMessage,
      lastSuccessAt,
      running,
      // Informational only — the watcher continues syncing regardless of status
      status: consecutiveFailures >= resolvedOptions.maxConsecutiveFailures ? 'unhealthy' : 'healthy'
    };
  }

  async function writeHealth() {
    try {
      const healthDir = path.dirname(resolvedOptions.healthPath);
      await fsPromises.mkdir(healthDir, { recursive: true });
      const tmpPath = `${resolvedOptions.healthPath}.tmp.${process.pid}.${Date.now()}`;
      await fsPromises.writeFile(tmpPath, JSON.stringify(getHealth(), null, 2) + '\n', 'utf8');
      await fsPromises.rename(tmpPath, resolvedOptions.healthPath);
    } catch {
      // Best-effort — do not let health writes break the watcher
    }
  }

  function queueHealthWrite() {
    healthWriteChain = healthWriteChain.then(() => writeHealth()).catch(() => null);
    return healthWriteChain;
  }

  async function recordSyncSuccess() {
    consecutiveFailures = 0;
    lastSuccessAt = new Date().toISOString();
    await queueHealthWrite();
  }

  async function recordSyncFailure(err) {
    consecutiveFailures += 1;
    lastFailureAt = new Date().toISOString();
    lastFailureMessage = err.message || String(err);

    if (consecutiveFailures >= resolvedOptions.maxConsecutiveFailures) {
      logger.error(`[position-manager-watch] sync failed ${consecutiveFailures} consecutive times: ${lastFailureMessage}`);
    } else {
      logger.warn(`[position-manager-watch] sync failed (${consecutiveFailures}/${resolvedOptions.maxConsecutiveFailures}): ${lastFailureMessage}`);
    }
    await queueHealthWrite();
  }

  const stop = async () => {
    if (!running) {
      return;
    }

    running = false;
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
    if (typeof unsubscribe === 'function') {
      await unsubscribe().catch(() => null);
      unsubscribe = null;
    }
    await queueHealthWrite();
  };

  const start = async () => {
    if (running) {
      return {
        getHealth,
        manager,
        options: resolvedOptions,
        stop
      };
    }

    if (!resolvedOptions.accountName) {
      throw new Error('accountName is required. Pass --account or set BITSHARES_ACCOUNT.');
    }

    running = true;
    logger.info(`[position-manager-watch] starting for ${resolvedOptions.accountName}`);

    await waitForConnected().catch((err) => {
      throw new Error(`BitShares connection not ready: ${err.message}`);
    });

    await manager.syncAllPositions()
      .then(() => recordSyncSuccess())
      .catch((err) => recordSyncFailure(err));

    unsubscribe = await manager.watchAccount(resolvedOptions.accountName, async (position) => {
      logger.info(`[position-manager-watch] fill observed for ${position.id}`);
      if (typeof options.onFill === 'function') {
        await options.onFill(clone(position));
      }
    });

    syncTimer = setInterval(() => {
      if (!running) {
        return;
      }

      manager.syncAllPositions()
        .then(() => recordSyncSuccess())
        .catch((err) => recordSyncFailure(err));
    }, resolvedOptions.syncIntervalMs);

    logger.info('[position-manager-watch] running');
    return {
      getHealth,
      manager,
      options: resolvedOptions,
      stop
    };
  };

  return {
    getHealth,
    manager,
    options: resolvedOptions,
    start,
    stop
  };
}

async function runPositionManagerWatch(options = {}) {
  const watcher = createPositionManagerWatcher(options);
  return watcher.start();
}

module.exports = {
  DEFAULT_HEALTH_PATH,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  createPositionManagerWatcher,
  parsePositionManagerWatchArgs,
  runPositionManagerWatch,
  main
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
