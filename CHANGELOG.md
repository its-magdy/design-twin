# Changelog

What changed in each release of Design Twin: the `dtwin` CLI and MCP server (`@design-twin/dtwin` on npm and
Homebrew), the Figma plugin and the Claude Code plugin. All three ship with one version number.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Every GitHub Release starts with its entry from this file, followed by the
list of merged PRs.

## [Unreleased]

### Changed

- `figma_export_url` and `figma_export_selection` now answer inline with a screen outline: one line per node, with
  repeated styles hoisted into tables (about a third of the compact JSON on the real screens in the test fixtures).
  When it is too big it falls back to layout only, then a list of sections, and the first line says which level came
  back and how to get more. Bindings and truncation notes stay on the outline or are counted in a "Not shown" line.
  Pass `format: "json"` for the old inline JSON; `writeToDisk: true` is unchanged, and a screen too big to return as
  JSON is still written to disk on its own, now with its outline beside the index.
- Export JSON is compact: about 3.2× fewer bytes and a third fewer tokens than before, with one node per line, so a
  300-node screen fits in one Read. MCP results are compact too. The first pull after upgrading rewrites every export
  file, so a committed `design/export/` shows one large diff. The inline limit now counts compact JSON's token density:
  the default stays 48,000 characters, and a lowered `MAX_MCP_OUTPUT_TOKENS` allows fewer characters per token.
- Each `figma_write` call is now its own Cmd-Z step in Figma. Before, one Cmd-Z undid every write since the plugin
  started. A failed write no longer ends with an empty "0 earlier op(s) ... NOT rolled back" list, and one whose mode
  changes were put back lists them.

### Added

- A `createTree` spec can name the file's design system instead of raw values: an `INSTANCE` node names a component
  (by exact name, key or id) with its property values, a paint or a spacing, radius or stroke field names a variable,
  and a text names a text style. Every name is resolved before anything runs; one that matches nothing or several
  things, a variable of the wrong type, or a property or variant value the component lacks refuses the whole batch,
  listing every problem with up to three candidates. A library variable is found by name and a library component or
  text style by key; importing it is a write, so it runs only once the whole batch resolved and "Allow edits" is on.
  Raw values still work and the reply counts them as `unbound`. On the write-cost suite's new-screen job this sends
  412 tokens of spec instead of 638.
- `figma_write` can create a whole screen in one op: `createTree` takes one nested spec of frames, auto-layout and text,
  written with the read export's field names and no ids, and an optional `page`. Everything is checked before the
  file is touched (the spec, the page name and the fonts, each miss listed with candidates), and the tree lands whole
  or not at all, beside the existing frames unless it has coordinates. The reply is the root id, the counts and the
  ids of the nodes the spec gave a `handle`; a read field a write cannot set yet is refused by name. What the read
  writes on an ordinary frame or text (variable-font axes, `strokesInLayout`, the derived `weightValue` and
  `renderBox`) is accepted, so a read node can be fed back in. The dry run describes the screen in one sentence.
- A write-cost suite (`bun test/write-cost.test.ts`) measures what an agent spends to write to Figma: estimated tokens
  out and in, and round trips, for the six jobs of the write-plane design (new screen, several similar screens, fix
  one node, the same change on many screens, a colour update, a fault in a repeated part). It runs the real MCP server
  against a fake file, with no live Figma, and records today's four-op route as the baseline later routes are
  compared with.
- `figma_write` can set a node's variable mode: `setVariableMode` (`nodeId`, `collection`, `mode`) makes a dark or
  brand version of a screen one op on its frame, and `clearVariableMode` (`nodeId`, `collection`) puts it back on the
  mode it inherits. Collections and modes are given by exact name or id. A name that matches nothing or several
  things refuses the whole batch before anything runs, with up to three candidates. If a later op in the batch
  fails, the mode changes are put back. A library collection the file doesn't use yet is refused by name.
- `dtwin outline <screen.json> [--budget N]` prints the same outline for a screen already on disk.
- `plan-skeleton` now gives each instance the component map covers a ready `codeUsage`: the module and export (a
  matching `variantOverrides` target included), the code props with translated values, and the slots. Anything the map
  can't translate, such as a variant option with no code mapping, is left out and listed in `codeUsageWarnings` and on
  stderr instead of being guessed.
- `verify-screen --compare` catches the wrong image or icon. The web probe records what draws each exported asset (the
  `<img>` source, the inline `<svg>`) and its content hash, and the compare checks that against the export's assets: the
  expected file passes (renamed by a bundler or inlined too), another exported file is a high delta naming both, and
  what cannot be matched (a re-encoded image, an optimised SVG, a CSS background, a native build) is reported as
  unverified, never passed or failed.
- Extended variable collections export their inherited and override values, and their parent, root and parent modes.
  Generated tokens write a brand's overrides as a layer of their own (CSS under `[data-theme-<collection>="<mode>"]`,
  DTCG and the resolver as override data), and native output gets one full token type per brand.
- The design-system style catalog includes the values of library styles a pull used, as `remote:true` rows. Nothing is
  imported into the Figma file.

### Fixed

- A GitHub Release's notes keep a nested list item on its own line. Before, a CHANGELOG entry's sub-list was run
  into its parent item as one paragraph (as in 0.1.6's notes, since corrected by hand).
- The logo reads on every theme: the npm page and the GitHub README now show the wordmark on its own white tile.
  Before, npm's dark mode hid the dark ink, and GitHub's light theme under an OS dark setting showed the white one.
- The plugin export loses less. An OpenType feature the designer turned off now reaches the IR as `font.openTypeOff`
  (before, only enabled ones survived); each layout grid carries its own variable bindings as `tokens`, on frames and
  grid styles; and an annotation carries its Dev Mode category's label as `category` beside `categoryId`.

## [0.1.6] - 2026-11-02

### Changed

- `dtwin mcp --help` now lists all 15 MCP tools by name, grouped as live reads, the one write and the two that read
  the export on disk. Before, it named some and shortened the export tools to `figma_export_*`.
- Internal: one module now decides where a dtwin is installed (a repo checkout, the npm package, a Homebrew keg or a
  bunx cache). `dtwin init`, `dtwin plugin`, the MCP server and the package build all use it, so the paths they hand
  out cannot drift apart. A test now checks that the MCP tool list, `dtwin mcp --help` and the docs name the same
  tools and the same counts.
- When no Figma plugin is connected, the CLI, the MCP server, `dtwin doctor` and `dtwin init` now give the same next
  step: in Figma desktop, open the file and run Plugins → Development → Design Twin, and keep its window open. The
  steps for picking one of several connected files and for pasting the bridge token are also worded the same
  everywhere.
- `figma_whoami` now says who holds the bridge in a `connectionFrom` field, as `dtwin whoami` does ("this process" or
  "the daemon (pid N)"). It used to put a `via` field inside `connection`.
- The dry run of `figma_write` no longer waits for a named `client` that is not connected yet. It reports "Allow
  edits" as unknown instead.
- The web probe's `--ready` screen gate (what each page load waits for, and how a page without the frame's tag is
  judged) is now one module with its own tests. The probe's output is unchanged.
- `verify-screen --compare` checks every property of a node from one table: one row per property (a single radius
  and per-corner radii are one row, as are a single border width and per-side widths). Every gap ("not reported",
  null, unreadable, impossible) is worded in one place. Findings and their wording are the same as before, except
  for the fixes below.
- README: an illustrated demo loop under the intro (`assets/demo.gif`).

### Fixed

- `dtwin pull --help` now names the folder an `--as-library` pull really writes, `libraries/<slug>-<fileKey8>/`
  (it said `libraries/<slug>/`).
- `dtwin whoami` through a daemon too old to relay its socket stats no longer says no daemon is running.
- A component's `visuals.radius` in `design-system/components.local.json` is now written the way a page pull writes
  a node's radius. A fully rounded (pill) component used to show Figma's raw `1000000000`, and a resized one could
  show float dust like `12.000000476837158`. It is now half the shorter side with `radiusFull: true`, or the radius
  rounded to 2 decimal places.
- Docs: the npm page now lists every `dtwin pull` flag (including `--motion`, `--plugin-data`, `--shared-data` and
  `--no-assets`) and `dtwin version`, and says once how `--timeout` works. The Figma plugin README no longer claims
  token suggestions (`inferredVariables`) are exported, and the docs now agree on what blocks an audit, where
  generated token files go and where a library pull lands.
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
- `/designtwin:verify`'s behaviour checks now open an overlay the way the interaction drive does: scrolled into view,
  the pointer on the click point first, and the same guards. An opener that is hover-revealed or only clickable while
  hovered used to end the dialog checks with "the check could not run", though the drive had opened it. The two
  probes also wait for a slow dialog by one rule: up to 0.5 s after it first shows.
- Hover points and the submit guard now see inside open shadow roots, as the click check already did. A web
  component's own button in a corner is no longer taken as a free hover point, and an element inside a shadow root
  is no longer reported as covered by its own host.

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

[Unreleased]: https://github.com/its-magdy/design-twin/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/its-magdy/design-twin/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/its-magdy/design-twin/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/its-magdy/design-twin/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/its-magdy/design-twin/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/its-magdy/design-twin/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/its-magdy/design-twin/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/its-magdy/design-twin/releases/tag/v0.1.0
