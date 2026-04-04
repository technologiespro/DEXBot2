---
name: trend-detection
description: Shared DEXBot/Claw trend-detection service for candle-driven signals, parameter tuning, and bot-setting updates.
---

# Trend Detection

Use this skill when the task is about the shared trend service rather than margin-trading specifically.

This skill covers:

- candle-fed trend detection and signal monitoring
- tuning trend-detection parameters and general settings
- applying signal-driven bot-setting updates for `gridPriceOffsetPct` and `weightDistribution`

## Workflow

1. Inspect the current trend signal, confidence, and premium/discount state.
2. Check the candle source and the active bot context.
3. Adjust trend-detection parameters in the appropriate configuration surface.
4. Preview the bot-settings patch before applying it.
5. Apply the update only when the signal and validation agree.
6. Monitor the next cycle through the adapter state and recalc trigger files.

## Boundaries

- Keep signal generation in `analysis/trend_detection/` and `market_adapter/`.
- Keep setting updates in the Claw/Dexbot profile layer.
- Do not tie the service to margin-trading-only policy or order placement.

## Reference

See [references/service.md](references/service.md) for the signal model, control surfaces, and tuning boundaries.
