# Design Twin

This repo *builds* the Design Twin Figma→code workflow (the `dtwin` CLI, the `figma-mcp` server, and
the `designtwin` Claude Code plugin). Its own Claude Code sessions do **not** have the
`designtwin` plugin installed — that plugin (`claude-plugin/`) is meant for *consumer* projects, so
working in this repo doesn't auto-load `/designtwin:help` / `/designtwin:extract` /
`/designtwin:audit-design` / `/designtwin:build-screen`.

If a task here involves connecting to a running Figma plugin, pulling a design, or checking the
CLI/MCP surface, read these directly rather than guessing:

- `bridge/README.md` — the full CLI + MCP surface: install, bridge token, every `figma-pull` (`dtwin`)
  flag, `--list-clients`/`--whoami`/`--list-libraries`/`--as-library`, the `--serve` daemon, MCP tools,
  `writeToDisk`, limits.
- `claude-plugin/skills/help/SKILL.md` — orientation, one-time setup, the three export paths
  (manual / CLI / daemon / MCP), troubleshooting (port 8787, bridge token, 401, stale snapshot, etc).
- `claude-plugin/skills/extract/SKILL.md` — how to actually run an export (discover-then-scope order).
- `ARCHITECTURE.md` — the two front-ends over one bridge (CLI = batch reads to disk; MCP = the same
  reads as live tools + the only write path, `figma_write`), plugin two-context model, security.

In this repo, `dtwin` is `node bridge/figma-pull.js` (not on PATH unless the package is installed
elsewhere) — e.g. `node bridge/figma-pull.js --list`.
