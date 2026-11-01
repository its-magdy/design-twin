# Changelog

What changed in each release of Design Twin: the `dtwin` CLI and MCP server (`@design-twin/dtwin` on npm and
Homebrew), the Figma plugin and the Claude Code plugin. All three ship with one version number.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Every GitHub Release starts with its entry from this file, followed by the
list of merged PRs.

## [Unreleased]

### Changed

- `verify-screen --compare` checks every property of a node from one table: one row per property (a single radius
  and per-corner radii are one row, as are a single border width and per-side widths). Every gap ("not reported",
  null, unreadable, impossible) is worded in one place. Findings and their wording are the same as before, except
  for the fixes below.

### Fixed

- `verify-screen --compare` now applies its element rules the same way to every property:
  - Padding on a leaf element, an inline element or a `<tr>` says why it is not compared even when the probe left
    padding out. Before, it said "the probe did not report this property" and counted as lost coverage.
  - The same holds for a TEXT's box width on a container element (a padded element, a `<td>`, a `<button>`).
  - A negative box width is a measuring artefact, as a negative width already was. Before, it was compared.
  - A per-corner radius on a leaf or inline element counts toward coverage, as a single radius already did.
  - A layer drawn in a hover state that renders 0×0 at rest now lists every property it states as not measured,
    including padding, per-corner radii, per-side borders and its copy. Before, only the single-value fields were
    listed.
- A waiver on one side of a border (`border-width (bottom)`) now matches within the border tolerance, as one on
  `border-width` does. Before, it had to match exactly.

## [0.1.5] - 2026-11-01

### Added

- The Claude Code plugin has an icon: Bo, the Design Twin mark (#136).

### Fixed

- The npm description and the extract skill no longer say design data never leaves your machine. The Figma plugin
  sends it only to the local bridge, but your coding agent then sends it to its model. They now say what the README
  says: no REST API key, and no cloud service in between (#136).
- `dtwin list`, `pull` and the other commands no longer print "plugin connected — …" when no plugin connected. With
  Figma closed, or with a plugin whose bridge token does not match, they now go straight to the "no Figma plugin
  connected" error and its next step (#137).

## [0.1.4] - 2026-11-01

### Added

- Bo, the Design Twin mark. It appears in the README header, the Figma plugin window (beside the status line, so no
  control moves) and the repository's social card. `dtwin --version` draws it beside the version on an interactive
  terminal; piped output, `--json`, `NO_COLOR` or `TERM=dumb` get the bare version (#132).
- `docs/setup.md`: every way to install, what `dtwin init` writes, step-by-step setup for a coding agent, and
  upgrading (#134).
- This changelog.

### Changed

- The README is rewritten for first-time users: a 5-minute first screen, why Design Twin, and its known limitations
  and platform support (#133, #134).
- Each help page and hint now matches what the code does: `dtwin plugin uninstall`, all 15 MCP tools, the plugin copy
  `dtwin init` makes, the bridge token's section, the real marketplace name, and `design/export/` for manual
  downloads (#131).

### Fixed

- `dtwin init --mcp` gave the wrong next step: it said to enable the MCP server with `/mcp`. It now says to restart
  Claude Code and approve the server when asked; `/mcp` only shows its status (#134).

## [0.1.3] - 2026-10-31

### Fixed

- Homebrew installs the exact dependency tree the release was tested with: the npm package now ships a pinned
  `bun.lock`, and the formula installs from it with `--frozen-lockfile` (#128).

## [0.1.2] - 2026-10-31

### Added

- `dtwin plugin install` puts the Figma plugin in a per-user folder that never moves. You import it into Figma once;
  upgrades update it in place with no re-import (#123).

### Fixed

- The plugin tells you to reopen it with hot reload on. A live check found that Figma keeps running the old code when
  hot reload is off, and picks up new permissions when it is on (#127).

## [0.1.1] - 2026-10-31

### Added

- Install with Homebrew: `brew install its-magdy/tap/dtwin`. Each release updates the formula automatically. `dtwin
  init` and `dtwin doctor` write paths that survive `brew upgrade` (#121).
- The Figma plugin changes nothing in a file until the designer ticks **Allow edits** (#122).

## [0.1.0] - 2026-10-31

The first release on npm: `@design-twin/dtwin`, published from CI with provenance (#118, #119).

- `dtwin` CLI: exports a Figma file to `design/export/` through the Design Twin Figma plugin. It works on the free
  Figma plan with no REST API key. There is also a `dtwin serve` daemon, available on Windows over a named pipe (#61).
- `figma-mcp`: the same reads as live MCP tools, plus `figma_write`, the only write path.
- Claude Code plugin `designtwin`: the help, extract, audit-design, build-screen, verify and sync-design skills, with
  build-screen's core loop condensed (#116).
- Verify: compares a built screen with the design, including per-side borders and inset rings (#114), form-control
  values (#85), focus and hover states (#115), and the cause of size differences (#117).

[Unreleased]: https://github.com/its-magdy/design-twin/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/its-magdy/design-twin/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/its-magdy/design-twin/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/its-magdy/design-twin/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/its-magdy/design-twin/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/its-magdy/design-twin/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/its-magdy/design-twin/releases/tag/v0.1.0
