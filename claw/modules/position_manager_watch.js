const { PositionManager, DEFAULT_STATE_PATH } = require('./position_manager');
const { waitForConnected } = require('./bitshares_client');

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function parsePositionManagerWatchArgs(argv = [], env = process.env) {
  const options = {
    accountName: env.BITSHARES_ACCOUNT || null,
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
    statePath: options.statePath || DEFAULT_STATE_PATH,
    syncIntervalMs: Number.isFinite(Number(options.syncIntervalMs)) && Number(options.syncIntervalMs) > 0
      ? Number(options.syncIntervalMs)
      : 300000
  };

  const manager = new PositionManager({ statePath: resolvedOptions.statePath });
  let running = false;
  let syncTimer = null;
  let unsubscribe = null;

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
  };

  const start = async () => {
    if (running) {
      return {
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

    await manager.syncAllPositions().catch((err) => {
      logger.warn('[position-manager-watch] initial sync failed:', err.message);
    });

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

      manager.syncAllPositions().catch((err) => {
        logger.warn('[position-manager-watch] periodic sync failed:', err.message);
      });
    }, resolvedOptions.syncIntervalMs);

    logger.info('[position-manager-watch] running');
    return {
      manager,
      options: resolvedOptions,
      stop
    };
  };

  return {
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
