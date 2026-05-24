# Docker Build and Shipping

DEXBot2 now ships container images only for release tags matching `v*.*.*`.

## Published image tags

- `latest` - most recent stable release build (not updated for pre-release tags)
- `vX.Y.Z` - release tag image
- `sha-<commit>` - immutable commit build

Images are published to:

`ghcr.io/froooze/dexbot2`

## Local build

```bash
docker build -t dexbot2:local .
docker run --rm -it dexbot2:local node dist/dexbot.js --help
```

## Secure startup

For production and best secret hygiene without PM2, use the bundled unlock launcher:

```bash
tsx unlock-start.ts
```

- Enter the master password once interactively.
- Password stays in daemon memory (RAM) and is not stored in `.env`.
- Bot processes request private keys through the daemon socket.
- If the credential daemon stops, rerun the launcher to unlock it again.

To start only one bot:

```bash
tsx unlock-start.ts <bot-name>
```

For claw-only workflows that only need credentials, use:

```bash
tsx unlock-start.ts --claw-only
```

For PM2-managed credential-daemon-only startup:

```bash
node pm2 claw-only
```

## Run with Docker Compose

1. Create a `.env` file in the project root for non-secret Docker Compose runtime values:

```dotenv
BOT_NAME=my-bot
OPEN_ORDERS_SYNC_LOOP_MS=5000
# Optional: match container user to host UID/GID for volume permissions
DEXBOT_UID=1000
DEXBOT_GID=1000
```

2. Ensure the host directories exist with matching ownership:

```bash
mkdir -p profiles market_adapter/data market_adapter/state
```

3. Start the bot:

```bash
docker compose up
```

This compose mode runs `unlock-start.ts`, which starts the credential daemon and may prompt for the master password. If `BOT_NAME` is empty, it starts all active bots from `profiles/bots.json`.

3. View logs:

```bash
docker compose logs -f dexbot
```

4. Stop:

```bash
docker compose down
```

## Notes

- Persist bot state/config by mounting `./profiles:/app/profiles`.
- Persist market adapter runtime state and candle caches by mounting `./market_adapter/state:/app/market_adapter/state` and `./market_adapter/data:/app/market_adapter/data`.
- The image runs as the bundled `node` user (UID 1000 by default). To avoid permission issues with bind mounts, either:
  - Pre-create host directories (`mkdir -p profiles market_adapter/data market_adapter/state`) so they inherit your host user's ownership, or
  - Set `DEXBOT_UID` and `DEXBOT_GID` in `.env` to match your host user (`id -u` / `id -g`).
- Keep `.env` for non-sensitive runtime values (for example `BOT_NAME`, `OPEN_ORDERS_SYNC_LOOP_MS`).
- Do not store the master password in `.env`. The secure launchers prompt once and keep it only in process memory.
- If you prefer immutable pinning, replace `latest` in `docker-compose.yml` with a `sha-<commit>` tag.
