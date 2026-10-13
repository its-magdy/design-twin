# Tokens → a theme file the app can import

The one copy of how to turn exported variables into the stack's theme file: which input to feed `tokens.js`, what
it writes, how to check a generated file is current, and what its warnings mean. The extract skill links it, and
build-screen links it for the token map. `<scripts>` below is the plugin's scripts folder — the skill that sent
you here gives its real path.

## Contents
- Choose the input by what the theme is for
- Generate
- Is the generated file current? Which variable is this colour?
- Pick the output by stack
- Read the warnings
- Wiring it into the app

## Choose the input by what the theme is for

The choice changes values, not just coverage:

1. `design/export/libraries/<slug>/tokens.json` (from `--as-library`) when the screens CONSUME a
   library — the library's own definition of every token, one variable per name.
   `design/export/design-system/tokens.json` is that only when it was pulled from the file that DEFINES
   the tokens (its variables are not `remote: true`); pulled from a consuming file it holds just the
   library variables something there references.
2. Otherwise, the screen's own `design/export/pages/<Page>/<Screen>__<id>.vars.json` — the variables
   that screen's file references, so its names mean what that screen means.
3. `design/export/variables.json` (the union of every pull) only when you need every screen's tokens
   in one file — a shell shared by several screens does — and then read its `_conflicts` first, and pick, per
   key-suffixed name, the key each screen's `.vars.json` carries (record it in the plan's token row).

Why not the union by default: names repeat across screens' libraries. A union can hold two
`Space 4` — say 24 (the design system's) and 16 (one screen's local copy); a theme generated from the
union cannot give both screens the plain `space-4`, so each is emitted under its key
(`space-4-<first 8 of key A>`, `space-4-<first 8 of key B>`) and the screen that binds 24 must pick that one. Generated from
that screen's own `.vars.json`, it is simply `space-4: 24px`.

## Generate

```bash
node "<scripts>/tokens.js" design/export/design-system/tokens.json design/export/   # DTCG json + tokens.css + a tokens/ set dir
node "<scripts>/tokens.js" design/export/design-system/tokens.json <css dir> --web tailwind
node "<scripts>/tokens.js" design/export/design-system/tokens.json <theme dir> --native swiftui   # or compose | flutter | react-native
```

It writes more than a theme file: `tokens.dtcg.json`, `tokens.css`, `tokens.resolver.json` and a
`tokens/` directory of per-collection/per-mode set files — around 20 files for a real system. Point
it at a directory you are happy to have filled. With a `--web`/`--native` target, `tokens.js` writes
only that target's file to the given directory by default — pass `--also-generic` if you also want the
generic handoff set (`tokens.dtcg.json`, `tokens.css`, `tokens.resolver.json`, `tokens/`) written
there, and keep that set under `design/`, not the app's source tree.

## Is the generated file current? Which variable is this colour?

Each CSS / native file starts with a `designtwin-source: <dir>/<input> · <n> variables · sha256 <12>` line.
`node "<scripts>/tokens.js" <tokens.json> --check <generated file>` writes nothing and
says whether the file is still current (exit 0), stale after a re-pull (1) or has no such line (2,
regenerate once) — also 2 when it was generated from a different file (it names that file: check against it,
never regenerate from a narrower one; a design-system and a library `tokens.json` are told apart by their parent
directory) or the command line is wrong (usage errors in `--check`/`--lookup` are 2, never 1); a later pull that
merges new variables says the generated file is now behind.

To find the variable behind a colour: `node "<scripts>/tokens.js" <library tokens.json> --lookup <hex>` (repeatable;
COLOR variables, per mode, through aliases; exit 1 when none, 2 on a usage error; pass `ffbc1c` or a quoted
`'#ffbc1c'` — an unquoted `#` starts a shell comment).

## Pick the output by stack

The build-screen profile for the stack says which flag and what the
generated names look like. `tokens.css` (no flag) is plain `:root` custom properties for CSS
Modules or vanilla CSS; `--web tailwind` writes a Tailwind v4 `theme.css`; `--native <profile>`
writes one native token file. Import the result as the app's theme. Generate it rather than hand-writing a theme
from bound token names: hand-writing is the per-screen re-mapping this step exists to stop.

## Read the warnings

Nothing is dropped, but one warning changes names: `N
different Figma variables share the name 'X' … resolve DIFFERENTLY` means both were emitted, each
suffixed with the first 8 characters of its key, and the warning lists each key's values and the
screens it came from. Pick the one the screen binds (by key, via the screen's `.vars.json`) — or
regenerate from that screen's own `.vars.json`, where the plain name usually survives. `… resolve
identically in every mode — emitted ONCE` and the rest — a name sanitised for CSS, a resolver file
renamed to avoid a collision — are informational.

## Wiring it into the app

The file is generated: say where it landed and how to wire it in (its header comment shows the one
line), leave it unedited, and re-run it after the next token pull. Variables only — text styles and
shadows are not emitted yet. If the project already has a theme file, keep it and its names, and add no second
one beside it; show the user the difference and ask which is the source of truth. A new file moves into the app's
source tree (ask where), is listed in the plan's `files[]`, and every screen imports it.
