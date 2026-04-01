# Claw Runtime Comparison

This note compares the four runtime families supported by the Claw bridge layer:

- OpenClaw
- NanoBot
- PicoClaw
- ZeroClaw

The comparison is based on the current `claw/` bridge design and runtime metadata. It is a practical analysis, not a formal benchmark report.

## What The Bridge Optimizes For

The bridge is trying to satisfy four different operating modes with one shared BitShares surface:

- very small footprint and fast startup
- broad assistant and plugin coverage
- simple MCP-based integration
- low-cost hardware and launcher-based workflows

That means each runtime is a different compromise, not a strict upgrade path.

## Comparison Axes

The useful axes are:

- runtime footprint
- startup latency
- integration style
- developer ergonomics
- ecosystem breadth
- operational complexity

## Deep Dive

### OpenClaw

OpenClaw is the broadest and heaviest option.

Strengths:

- Richest runtime surface.
- Native plugin model is a strong fit for extension-heavy workflows.
- Broadest assistant-style experience among the four.
- Best when the bridge needs to live inside a feature-rich product rather than a small runtime shim.

Tradeoffs:

- Highest operational complexity.
- Largest dependency and runtime footprint.
- More moving parts means more integration surface to keep aligned.

Best fit:

- Desktop or server environments where footprint is less important.
- Teams that value extensibility and a mature assistant ecosystem.
- Workflows that benefit from plugin registration over a narrow CLI surface.

### NanoBot

NanoBot sits between OpenClaw and PicoClaw in spirit, but it is a different tradeoff: a smaller Python codebase with MCP integration.

Strengths:

- Easier to inspect and adapt than a large feature-rich assistant stack.
- MCP gives a simple external-tool boundary.
- Good for lightweight assistant workflows and rapid iteration.

Tradeoffs:

- Slower startup and heavier runtime cost than Go or Rust.
- Python dependency management adds operational friction compared with a static or near-static binary workflow.
- Less suited to very small hardware or always-on resource-constrained deployments.

Best fit:

- Teams that want a lightweight assistant they can reason about quickly.
- Environments where Python ergonomics matter more than the absolute smallest footprint.
- MCP-first integrations with moderate complexity.

### PicoClaw

PicoClaw is the smallest Go-based option in the set and is the most launcher-oriented.

Strengths:

- Small binary deployment model.
- Good fit for low-cost boards and constrained Linux targets.
- MCP-based tool integration keeps the external surface consistent.
- Web launcher support makes it friendlier for desktop-style setup and usage.

Tradeoffs:

- The platform is still evolving quickly, so behavior and footprint can shift more often.
- Less mature than the longer-running ecosystems around OpenClaw or the broader upstream Rust tooling around ZeroClaw.
- The launcher and workspace behavior add some setup expectations that are easy to miss without good docs.

Best fit:

- Small-board deployments.
- Users who want a low-footprint Go runtime with a practical launcher.
- Deployments where the assistant needs to be easy to bootstrap, not just tiny.

### ZeroClaw

ZeroClaw is the smallest and most constrained option.

Strengths:

- Best cold-start behavior.
- Best fit for small, static, local deployments.
- Clear skill-manifest model with `SKILL.toml`.
- Best when the bridge should feel tiny and deterministic rather than broad.

Tradeoffs:

- Rust-oriented integration is more specialized than the other options.
- The workflow is more manifest-driven, so the runtime surface is less flexible than plugin-first systems.
- Better for fast, narrow automation than for a broad assistant shell.

Best fit:

- Edge devices.
- Minimal local automation.
- Users who want the most predictable, lowest-overhead runtime.

## Recommendation Matrix

If you optimize primarily for:

- **Lowest footprint**: ZeroClaw
- **Broadest feature set**: OpenClaw
- **Simplest external tool boundary**: NanoBot or PicoClaw, depending on whether you want Python or Go
- **Lowest-cost hardware**: PicoClaw, then ZeroClaw
- **Most mature assistant ecosystem**: OpenClaw
- **Fastest local command-style integration**: ZeroClaw

## Practical Rule Of Thumb

- Choose **OpenClaw** if the bridge should live inside a larger assistant product with rich extension points.
- Choose **NanoBot** if you want a compact Python assistant that is easy to modify.
- Choose **PicoClaw** if you want a small Go runtime with MCP and launcher support.
- Choose **ZeroClaw** if the bridge must be tiny and deterministic.

## Source Of Truth

The executable behavior lives in the `claw/` modules and scripts. This comparison is documentation only and should be kept aligned with:

- `modules/claw_runtime_matrix.js`
- `modules/claw_catalog.js`
- `modules/claw_manifest.js`
- `modules/claw_skill_md.js`
- `scripts/claw_skill_md.js`
- `scripts/zeroclaw_skill.js`
