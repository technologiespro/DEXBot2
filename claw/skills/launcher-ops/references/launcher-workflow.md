# Launcher Workflow

Use this reference for DEXBot2 startup and PM2 orchestration work.

## Commands

- `node unlock-start` - single-prompt local startup.
- `node unlock-start --claw-only` - credential daemon only, no bot startup.
- `node pm2` - PM2 startup for all active bots.
- `node pm2 <bot-name>` - PM2 startup for one active bot.
- `node pm2 claw-only` - PM2 credential daemon only.

## Rules

- Keep `claw-only` free of bot config and BitShares connectivity checks.
- Keep parsing in `modules/launcher/launch_modes.js`.
- Keep daemon lifecycle in `modules/launcher/credential_daemon.js`.

## Validation

- `node tests/test_launcher_exports.js`
- `node tests/test_pm2_logic.js`
- `npm test`
