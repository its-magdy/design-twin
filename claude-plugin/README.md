# `designtwin` — the Design Twin Claude Code plugin

This folder is the `designtwin` Claude Code plugin: the skills and agents that audit a Figma export, build a screen
from it in your stack, verify the build against the design, re-sync built code when the design changes, and design
in the Figma file itself through the MCP server's `figma_write`. It reads what the [`dtwin` CLI](../bridge/README.md) (or the MCP server) pulls into `design/export/`. The project
[README](../README.md) covers the whole workflow; [`skills/help/SKILL.md`](skills/help/SKILL.md) is the orientation
and troubleshooting entry point inside Claude Code (`/designtwin:help`).

## Install

```bash
claude plugin marketplace add its-magdy/design-twin
claude plugin install designtwin@designtwin-marketplace
```

It needs [Bun](https://bun.sh/install) ≥ 1.4.2 on PATH; the bundled scripts under `scripts/` run with it.

## Skills

| Skill | What it does |
|---|---|
| [`help`](skills/help/SKILL.md) | Orientation, one-time setup, connecting to Figma, troubleshooting |
| [`extract`](skills/extract/SKILL.md) | Pulls a design out of Figma onto disk as JSON + assets |
| [`audit-design`](skills/audit-design/SKILL.md) | Reviews an export for implementation gaps before any code is written |
| [`build-screen`](skills/build-screen/SKILL.md) | Builds a screen as production code in your stack from an export |
| [`verify`](skills/verify/SKILL.md) | Checks an already-built screen against its design without changing code |
| [`sync-design`](skills/sync-design/SKILL.md) | Patches already-built code after the design changed, instead of rebuilding |
| [`design-in-figma`](skills/design-in-figma/SKILL.md) | Makes or changes things in the open Figma file: a screen composed from its components and variables, a copy with only its differences, a fix by id, a variable, style or main component changed once |

## Agents

- [`screen-builder`](agents/screen-builder.md) — builds one screen in its own context (one per screen when several are built).
- [`visual-verifier`](agents/visual-verifier.md) — independently renders and measures a built screen against its export.
