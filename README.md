# DEXBot2

A market making bot for the BitShares Decentralized Exchange (DEX), implementing optimized staggered order strategies for automated trading.

![Grid Bot Order Distribution](docs/DEXBot2_0.6.0_grid_graphic.svg)

## 🚀 Features

- **Geometric Grid Trading** with configurable weight distribution (mountain/valley) and fund-driven recalculation
- **Constant Spread Maintenance** with fixed bid-ask gap that adapts to market movement
- **Copy-on-Write Grid Architecture** — immutable master grid, isolated working copies, transactional commit after blockchain confirmation ([details](docs/COPY_ON_WRITE_MASTER_PLAN.md))
- **Adaptive Fill Batching** — groups 1-4 fills per broadcast, reducing processing from ~90s to ~24s for 29 fills
- **Self-Healing Recovery** — periodic retries (max 5, 60s interval) with automatic state reset
- **Dust Partial Auto-Cancellation** — configurable delay before auto-cancelling small remainders on-chain
- **Boundary-Crawl Rebalancing** — closed-loop algorithm with periodic grid regeneration and fund invariant verification
- **AES-Encrypted Key Storage** with RAM-only password handling
- **PM2 Integration** for multi-bot management with auto-updates and monitoring

## 🔥 Quick Start

```bash
# 1. Clone and install
git clone https://github.com/froooze/DEXBot2.git && cd DEXBot2 && npm install

# 2. Set up your master password, keys and add bots
node dexbot keys
node dexbot bots

# 3. Start with PM2 or directly
node pm2           # For production
node unlock-start.js  # Single prompt, no PM2
node dexbot start  # For testing
```

For detailed setup, see [Installation](#installation) or [Updating](#updating-dexbot2) sections below.

### Disclaimer — Use At Your Own Risk

- This software is in beta stage and provided "as-is" without warranty.
- Secure your keys and secrets. Do not commit private keys or passwords to anyone.
- The authors and maintainers are not responsible for losses.

## 📥 Installation

### Prerequisites

You'll need **Git** and **Node.js** installed on your system.

#### Windows Users

1. Install **Node.js LTS** from [nodejs.org](https://nodejs.org/) (accept defaults, restart after)
2. Install **Git** from [git-scm.com](https://git-scm.com/) (accept defaults, restart after)
3. Verify installation in Command Prompt:
   ```bash
   node --version && npm --version && git --version
   ```
   All three should display version numbers.

#### macOS Users

Use Homebrew to install Node.js and Git:
```bash
# Install Homebrew if not already installed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Node.js and Git
brew install node git
```

#### Linux Users

Use your package manager:
```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install nodejs npm git

# Fedora/RHEL
sudo dnf install nodejs npm git
```

### Clone and Setup DEXBot2

```bash
# Clone the repository and switch to folder
git clone https://github.com/froooze/DEXBot2.git
cd DEXBot2

# Install dependencies
npm install

# Set up your master password and keyring
node dexbot keys

# Create and configure your bots
node dexbot bots
```

### Updating DEXBot2

To update DEXBot2 to the latest version from the main branch:

```bash
# Run the update script from project root
node dexbot update
```

The update script automatically:
- Fetches and pulls the latest code
- Installs any new dependencies
- Reloads PM2 processes if running
- Ensures your `profiles/` directory is protected and unchanged
- Logs all operations to `update.log`

## 🔧 Configuration

### Bot Options

Configuration options from `node dexbot bots`, stored in `profiles/bots.json`:

| Parameter | Type | Description |
| :--- | :--- | :--- |
| **`assetA`** | string | Base asset |
| **`assetB`** | string | Quote asset |
| **`name`** | string | Friendly name for logging and CLI selection |
| **`active`** | boolean | `false` to keep config without running |
| **`dryRun`** | boolean | Simulate orders without broadcasting |
| **`preferredAccount`** | string | BitShares account name for trading |
| **`startPrice`** | num \| str | Initial price. `"pool"` (liquidity pool), `"market"` (order book), or numeric `A/B` ratio |
| **`minPrice`** | num \| str | Lower bound. Number or multiplier (e.g., `"2x"` = `startPrice / 2`) |
| **`maxPrice`** | num \| str | Upper bound. Number or multiplier (e.g., `"2x"` = `startPrice * 2`) |
| **`gridPrice`** | num \| str \| null | Reference price for bound calculations. `null` (uses `startPrice`), numeric, or AMA keyword (`"ama"`, `"ama1"`-`"ama4"`) |
| **`incrementPercent`** | number | Geometric step between layers (e.g., `0.5` = 0.5%) |
| **`targetSpreadPercent`** | number | Width of the empty spread zone between buy and sell orders |
| **`weightDistribution`** | object | Sizing: `{ "sell": 1.0, "buy": 1.0 }`. Range `-1` (super valley) to `2` (super mountain), `0.5` = neutral |
| **`botFunds`** | object | Capital: `{ "sell": "100%", "buy": 1000 }`. Numbers or percentage strings |
| **`activeOrders`** | object | Max concurrent orders per side: `{ "sell": 5, "buy": 5 }` |

### General Options (Global)

Global settings via `node dexbot bots`, stored in `profiles/general.settings.json`:

- **Grid Health**: Grid Cache Regeneration % (default `3%`), RMS Divergence Threshold % (default `14.3%`), AMA Delta Threshold % (default `2.5%`), Partial Dust Threshold % (default `5%`), Dust Cancel Delay (default `5 min`, `-1` = off, `0` = instant)
- **Order Recovery**: Min Spread Factor (default `2.1x` of `incrementPercent`), Min Spread Orders (default `2`)
- **Timing (Core)**: Blockchain Fetch Interval (default `240 min`), Sync Delay (default `500ms`), Lock Timeout (default `10s`)
- **Timing (Fill)**: Dedupe Window (default `5s`), Cleanup Interval (default `10s`), Record Retention (default `60 min`)
- **Log Level**: `debug`, `info`, `warn`, `error`. Fine-grained category control via `LOGGING_CONFIG` (see [Logging](docs/LOGGING.md))
- **Updater**: Active (default `ON`), Branch (`auto`/`main`/`dev`/`test`), Interval (default `1 day`), Time (default `00:00`)

## 🎯 PM2 Process Management

For production use with automatic restart and monitoring. Use `node pm2` to start — it handles connection, config generation, authentication (RAM-only), and PM2 startup automatically.

```bash
# Start all active bots with PM2
node pm2

# Start a specific bot
node pm2 <bot-name>

# Or via CLI
node dexbot pm2

# View status and resource usage
pm2 status

# View real-time logs
pm2 logs [<bot-name>]

# Restart processes
pm2 restart {all|<bot-name>}

# Stop processes
pm2 stop {all|<bot-name>}

# Delete processes
pm2 delete {all|<bot-name>}

# Stop/delete only dexbot processes (via wrapper)
node pm2 stop {all|<bot-name>}
node pm2 delete {all|<bot-name>}

# Reset grid (regenerate orders)
node dexbot reset {all|[<bot-name>]}

# Disable a bot in config
node dexbot disable {all|[<bot-name>]}

# Show pm2.js usage
node pm2.js help
```

Bot logs are written to `profiles/logs/<bot-name>.log` (errors to `<bot-name>-error.log`). Restart policy: max 13 restarts, 1 day min uptime, 3s restart delay.

## 📚 Documentation

For architecture, fund accounting, rotation mechanics, and development guides, see the **[docs/](docs/)** folder:

- **[FUND_MOVEMENT_AND_ACCOUNTING.md](docs/FUND_MOVEMENT_AND_ACCOUNTING.md)** - Fund accounting, grid topology, rotation mechanics
- **[architecture.md](docs/architecture.md)** - System design, fill processing pipeline, testing strategy
- **[COPY_ON_WRITE_MASTER_PLAN.md](docs/COPY_ON_WRITE_MASTER_PLAN.md)** - Copy-on-Write grid architecture
- **[developer_guide.md](docs/developer_guide.md)** - Development guide, environment variables, examples, glossary
- **[LOGGING.md](docs/LOGGING.md)** - Logging system documentation
- **[WORKFLOW.md](docs/WORKFLOW.md)** - Project workflow and contribution guide

## 🤝 Contributing

1. Fork the repository and create a feature branch
2. Make your changes and test with `npm test`
3. For Jest tests: `./scripts/dev-install.sh` then `npm run test:unit`
4. Submit a pull request

**Development Setup:** `npm install` then optionally `./scripts/dev-install.sh` for Jest testing framework

## 📄 License

MIT License - see LICENSE file for details

## 🔗 Links

- [![Telegram](https://img.shields.io/badge/Telegram-%40DEXBot__2-26A5E4?logo=telegram&logoColor=white)](https://t.me/DEXBot_2)
- [![Website](https://img.shields.io/badge/Website-dexbot.org-4FC08D?logo=internet-explorer&logoColor=white)](https://dexbot.org/)
- [![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/froooze/DEXBot2)
- [![Awesome BitShares](https://camo.githubusercontent.com/9d49598b873146ec650fb3f275e8a532c765dabb1f61d5afa25be41e79891aa7/68747470733a2f2f617765736f6d652e72652f62616467652e737667)](https://github.com/bitshares/awesome-bitshares)
- [![Reddit](https://img.shields.io/badge/Reddit-r%2FBitShares-ff4500?logo=reddit&logoColor=white)](https://www.reddit.com/r/BitShares/)
