# Contributing

Thanks for helping. Bug reports, fixes and new stack profiles are all welcome. For anything larger than a fix, open an
issue first so the approach can be agreed before you write the code.

## Setup

You need Node.js 24.2+ and git. The Figma desktop app is needed only for live exports.

```sh
git clone https://github.com/its-magdy/design-twin.git
cd design-twin
npm ci
npx playwright install chromium   # the browser suites; without it they are skipped locally
```

[ARCHITECTURE.md](ARCHITECTURE.md) explains how the pieces fit, [bridge/README.md](bridge/README.md) covers the
CLI and MCP surface, and [TESTING.md](TESTING.md) covers the test layers, including live tests against Figma.

## Tests

```sh
npm test                                  # everything (~10 min)
npm run test:fast                         # all but the slow browser e2e suites (~3 min)
node test/run-suites.ts bridge audit      # only the named suites
npm run typecheck
```

The type and lint gates (`lint:any`, `lint:types`) run as the first two suites. Run `npm test` before opening a pull
request; CI runs the same suites, split across several runners.

## Rules the checks enforce

- **Committed build output stays in sync.** `figma-plugin/code.js` and `claude-plugin/scripts/*.js` are committed.
  After changing `figma-plugin/src`, `bridge/src` or `design-to-code`, run `npm run build` and commit the result;
  CI fails on any difference.
- **No real names.** Fixtures, docs and comments use invented file, company and layer names; a test guards this.
  Never paste a real client design, a token or an export from a private file into an issue or a fixture.
- **Strict TypeScript.** No `any` and no `as unknown as` (the `lint:any` suite lists the rules).
- **New `dtwin` flags are registered** in the argument parser and read options in `bridge/src/read-opts.ts`;
  new runtime modules of the bridge go in `bridge/package.json` `files`.

## Commits and pull requests

- Commit messages follow `type(scope): summary` (`fix`, `feat`, `refactor`, `test`, `docs`, `chore`), with the why in
  the body. Git history is the changelog.
- Keep a pull request to one concern, and fill in the template.
- CI must be green; the required check is **test result**.

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
