# Names come from Figma, not from you

Build-screen step 2 names every token, component and asset after the designer's name in the export. This file is
the why, the three ways it goes wrong, and what to do when Figma has no name.

## The rule

A token's `value` is what it resolves to in the one mode this screen was exported in. Its **name is what it
actually is**, and that name is the designer's, carried in the export — use it. Derive the code identifier from it
mechanically (`Schemes/On Primary` → `on-primary` / `onPrimary`, in whatever form the profile gives) so anyone can
read the name in either direction and land on the same token. The same goes for component names (the Figma
component / `figma.name` in `design/codeconnect.local.json`).

Assets follow the same rule, and the export makes it easy: an exported file is named after its own Figma layer
(`icons/linear/arrow-down` → `arrow-down.svg`), and the same artwork reached through several instance paths is ONE
file with every node id recorded on it. That name is the producer's — keep it as is inside `design/export/assets/`,
because it is how a re-pull knows which icon changed — and keeping it in the app too costs nothing and keeps
`sync-design`'s change list followable. If you must rename a copy, note the mapping in the plan. Read the screen's
`.assets.json` for the duplicate groups rather than diffing bytes yourself.

## Three ways this goes wrong

All three render perfectly in the exported mode:

- **Merging two Figma tokens because their values coincide.** `Schemes/On Primary` and `Schemes/On Surface` are
  `#ffffff` and `#1b1b21` in Light — and swap in Dark. A build that sees one hex and writes one token has made theme
  switching wrong, invisibly. One Figma name, one code token; the Stop hook flags a `codeToken` reached from two
  different `figmaName`s. When sharing really is right (two names for one type-scale step that agree in every
  mode), say so once on the sharing row — `"acknowledged": "<why>"` — and the hook stops repeating it.
- **Renaming by role or usage.** A colour named `Outline Variant` that you happen to use on text is still
  `outline-variant`, not `text-outline-variant`. Re-labelling it hides which token it is and makes the next
  person's grep fail. (One real build named `Scheme/On Surface` "on-primary" and `Scheme/On Primary` "on-surface"
  — the two ended up exactly inverted, and it looked right.)
- **Inventing a name for a value that has one.** If the export binds it, the name exists; go and read it rather
  than describing the colour you see.

## When Figma genuinely has no name

A raw unbound value, an ad-hoc gradient stop — there is no name to be faithful to, and inventing one silently is how
a codebase ends up with `gray-2` next to `medium-gray`. Treat it as the decision it is: **ask the user what to call
it**, offering the name you'd pick and where you'd put it. If you're mid-build and it's small, name it, but record
the name and its origin in that row's `decision` and **list every such invented name in your step-6 report** so the
user can rename before it spreads. The generated theme file (`tokens.js`) derives its names straight from Figma,
which is the other reason to prefer it over hand-writing one.
