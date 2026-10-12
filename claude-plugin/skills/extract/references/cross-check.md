# Is this screen even from that design system? — reading `cross-check`

The one copy of what `cross-check.js` reports and what each answer changes. The extract skill runs it after a pull
that produced a screen and a design system, build-screen runs it in step 1, and audit-design merges the same
findings into its report. `<scripts>` below is the plugin's scripts folder — the skill that sent you here gives its
real path.

## Contents
- Why it matters
- Running it
- Token collisions
- `foreign-token-library` — read the offline counts first
- `catalog-covers-nothing`
- `catalog-rekeyed` — proposals the user confirms
- A name match is a lead, not a mapping

## Why it matters

Pulling a design system and then pulling a screen does **not** mean the two are related. Both may be copies of one
original — duplicating a Figma file re-keys every collection and every component while leaving names and values
identical — or the screen may consume a library nobody exported. That failure is invisible in either file alone and
produces a build that looks plausible and is themed from the wrong source. On the live run that produced this
check, 0 of 65 instance keys on the screen matched any of the 318 components in the catalog beside it, and 12 of
13 variable collections were foreign; nothing said so, and the build generated 24 "new" components with invented
names that reproduce the visuals and are not a port of the catalog.

## Running it

```bash
node "<scripts>/cross-check.js" design/export/pages/<Page>/<Screen>__<id>.json \
  --design-system design/export/design-system [--out design/audit/<Screen>__<id>.cross]
```

Run it after any pull that produced both, and before anything that depends on the answer. Report its blockers and
every warning that carries a `confirm` question (asked, with the default the build takes) before offering to build
— a `catalog-covers-nothing`, `foreign-token-library` or `catalog-rekeyed` warning changes what happens next.
`--out <base>` writes `<base>.json` and `<base>.md`; without it the report only prints.

## Token collisions

It reads the screen's own `.vars.json` beside it, so a token collision is judged against the screen that actually
carries the colliding variable: a `token-name-collision` is this screen's problem (a blocker when a visible layer
binds the token, a warning otherwise); a `token-name-collision-elsewhere` note names another screen, and this
screen's value is not "fixed" to match it. A token *name* collision with a different value is a finding
(`(Space 3)` = 12 on the screen vs `Space 3` = 16 in the design system — slug them together and you silently get
16), while identical values under different keys are safe and are not reported.

## `foreign-token-library` — read the offline counts first

The message carries "Offline check (no Figma needed): of the N variables in those collections, A … D … U … M …"
(the same counts are the finding's `nameMap {agree, differ, undecidable, absent}`; the counts are absent, and
`nameMap` all zero, when no screen variable sits in the flagged collections): A have a design-system variable of the
same name resolving the same in every shared mode, D resolve differently (each listed as `token-name-collision`), U
cannot be compared (no shared mode), M have no same-name variable.

- **D = 0 → mapping by NAME is safe for the A**: record that in the plan and carry on; the screen's own `.vars.json`
  is the ground truth for names and values.
- A = 0 with M = N → none of them exists here by name, so this is not the screen's library: pull the one it uses.

The counts go by collection and variable NAME, not key: when the screen uses two collections of one name (two
`Spacing`, different keys) and only one is flagged, the other's variables are counted in too. The live route is
only for finding the owning file — right-click an instance in Figma → **Go to main component**, connect that file,
`dtwin list libraries` if needed, then `dtwin pull --as-library "<name>"` (CLI only); take it when A is 0 or you
need the library's values.

## `catalog-covers-nothing`

The screen's instances match nothing in the catalog beside it. Ask its `confirm` question before building. If the
user would rather proceed, that is fine — but then every instance really is `verdict:"new"`, and the build's report
says why.

## `catalog-rekeyed` — proposals the user confirms

`catalog-rekeyed` is the other answer to 0% by key, and it means the opposite of "wrong design system": duplicating
a Figma file re-mints every component key while names and prop signatures survive. Cross-check then lists name +
prop-signature matches under `componentProposals` in its JSON (`--out design/audit/<screen>.cross` writes it), every
one `"confirmed": false`. With `--map design/codeconnect.local.json` (found by default) each proposal is labelled
`alreadyMapped` (a key of it is already in the map — confirm only the others) or `sharedWith: N` (N other exported
screens use the same component; confirm once, it covers them all). The report lists them in that order — shared,
this screen only, already mapped — and nothing is confirmed for you.

Show the user the list — instance name → catalog name and id, and the evidence (`name+signature`, or the weaker
`name+no-props`) — and let them accept entries. Set `"confirmed": true` on exactly those, then

```bash
node "<scripts>/map-bootstrap.js" design/export/design-system/components.local.json \
  --out design/codeconnect.local.json --from-proposals design/audit/<screen>.cross.json
```

stubs only them, filed under the screen's own instance keys so a lookup by key finds them. Confirmed ones are ports
of the catalog (reuse its variant/prop matrix); the rest stay `verdict:"new"`. The confirmation is the user's: it is
the only thing that separates a real match from two components that share a name, and shared generic names
(`Component 1`, `Header`) are exactly where a wrong match hides.

## A name match is a lead, not a mapping

When keys don't line up, cross-check offers `name-matched-components` entries carrying `verified: false` — a
component whose exact name exists in the catalog and whose prop signature agrees (the name rule `plan-skeleton`
shares; a name found only in a library catalog is not a match). Use them to decide what to *call* things and how to
shape props, and mark each such plan row `verdict:"new"` with `matchedByName: "<catalog name>"` — not "reused".
Names like `Component 1`, `Header`, `Tabs` are reported separately as *ambiguous* and are left unmatched on purpose:
several catalog entries share them, and binding one by name is a coin flip.
