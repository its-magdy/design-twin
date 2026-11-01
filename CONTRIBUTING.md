# Contributing

Thanks for helping. Bug reports, fixes and new stack profiles are all welcome. For anything larger than a fix, open an
issue first so the approach can be agreed before you write the code.

## Setup

You need [Bun](https://bun.sh/install) 1.4.2+ and git (no Node: every script, suite and tool here runs on Bun). The Figma desktop app is needed only for live exports.

```sh
git clone https://github.com/its-magdy/design-twin.git
cd design-twin
bun install --frozen-lockfile
bunx --bun playwright install chromium   # the browser suites; without it they are skipped locally
```

[ARCHITECTURE.md](ARCHITECTURE.md) explains how the pieces fit, [bridge/README.md](bridge/README.md) covers the
CLI and MCP surface, and [TESTING.md](TESTING.md) covers the test layers, including live tests against Figma.

## Tests

```sh
bun run test                              # every suite (~20 min)
bun run test:fast                         # all but the slow browser e2e suites (~3 min)
bun test/run-suites.ts bridge audit       # only the named suites
bun run typecheck
```

A bare `bun test` is not the suite run: it is Bun's own test runner, which `bunfig.toml` points at `test/spawn-stress/`
only (the spawn-stress workflow's bun:test files). The type and lint gates (`lint:any`, `lint:types`) run as the first two suites. Run `bun run test` before opening a pull
request; CI runs the same suites, split across several runners.

- `bun run test` runs every suite in order (serially, output live) and ends with a summary: one row per suite, exit 1
  if any failed, and no suite is skipped after a failure.
- `bun run test:fast` skips four of the slow browser (probe e2e) suites and says so loudly at the end; CI's other
  matrix legs run them.
- One suite runs on its own too: `bun test/harness.ts` (the Figma plugin extractor, against a mock `figma`),
  `bun test/bridge.test.ts` (CLI + bridge), `bun test/design-to-code.test.ts` (tokens, maps, drift-lint), and every
  other `test/*.test.ts` the same way.
- `DT_E2E_POOL=<n>` sets how many probes the browser suites run at once.
- [TESTING.md](TESTING.md) lists each suite; the run-suites summary is the authority for check counts.

`bun run build` runs each workspace's own build — esbuild → `figma-plugin/code.js` and `figma-plugin/ui.html` for the
plugin (the bridge has nothing to build: it runs and ships as TypeScript) — and then `bun claude-plugin/build-scripts.ts`
to re-bundle `claude-plugin/scripts/`.

## Rules the checks enforce

- **Committed build output stays in sync.** `figma-plugin/code.js`, `figma-plugin/ui.html` and `claude-plugin/scripts/*.js`
  are committed. After changing `figma-plugin/src`, `figma-plugin/ui.template.html`, `bridge/src` or `design-to-code`,
  run `bun run build` and commit the result;
  CI fails on any difference.
- **No real names.** Fixtures, docs and comments use invented file, company and layer names; a test guards this.
  Never paste a real client design, a token or an export from a private file into an issue or a fixture.
- **Strict TypeScript.** No `any` and no `as unknown as` (the `lint:any` suite lists the rules).
- **New `dtwin` flags are registered** as one row in `bridge/src/cli-commands.ts` — a command (its flag, the
  family whose guards it joins, the read it plans, its `dtwin <verb>` spellings; parsing, the guards, dispatch
  and help follow from it, and figma-pull.ts will not compile until the row has a runner) or a modifier — and
  read options in `bridge/src/read-opts.ts`
  (with the read scopes that take them — `read-plan.ts` and each MCP tool's schema follow from that row);
  the npm package ships `bridge/src/` whole, so a runtime file the bridge needs from anywhere else must be added to
  `bridge/package.json` `files` (or copied in at pack time by `bridge/pack.ts`).
- **Dependencies.** `bun.lock` is the lockfile (`bun install --frozen-lockfile` in CI); `bunfig.toml` holds back any
  version published less than 7 days ago, as Dependabot's cooldown does. The npm package ships a `bun.lock` of its
  own, derived from the root one at pack time (`bridge/pack.ts`), and the release installs the packed tarball from it
  before publishing (`bridge/verify-pack.ts`).

## Commits and pull requests

- Commit messages follow `type(scope): summary` (`fix`, `feat`, `refactor`, `test`, `docs`, `chore`), with the why in
  the body. Git history is the changelog.
- Keep a pull request to one concern, and fill in the template.
- CI must be green; the required check is **test result**.

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
