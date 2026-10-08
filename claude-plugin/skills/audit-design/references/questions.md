# Writing questions for the designer

Questions are the audit's most valuable output: each one replaces a decision the engineer would
otherwise invent. A designer should be able to answer each in under a minute without opening a
meeting.

## Shape of a good question
- **One decision per question.** "What happens on error?" is five questions.
- **Point at the node**: name + id (`'Email input' 1:6`) so they can click to it.
- **Offer options, recommend one, state the default** you'll build if there's no answer. The default
  should come from the design system or platform convention, never taste.
- **A default must never be an approximation of a value that is already in the design.** "Bind to the
  nearest 4px step", "use the closest existing token", "round 14 up to 16" all ask the build to
  silently change what the designer drew — and build-screen forbids exactly that (its rule 5: an
  approximate match is hardcoding by proxy). For an off-grid or unbound value the default is always
  *use the exact value and flag it*; the question is whether the DESIGN should change, which only the
  designer can answer. Same for a colour with no token: the default is the literal plus a recorded
  decision, never the nearest palette entry.
- **Say why it matters** in a few words when it isn't obvious (clips at 200% text, fails AA, can't be
  built on Android < 12).
- **Order by what blocks the build**: core-flow states and blockers first, polish last.
- **Group** by screen, then by checklist section. Merge duplicates across components into one
  question listing all affected nodes.
- **Skip questions the export already answers** (annotations, other frames, hidden layers). If a
  convention is well established in the codebase, assume it and list it under "Assumptions" instead.

## Template

```markdown
## Questions for the designer

### Blocking
1. **Loading state for 'Orders' (2:14)** — nothing is drawn. Skeleton rows matching the list item, or a
   centered spinner? → *Default: skeleton of 5 rows, shown after 300 ms.*

### Before release
2. **Long names in 'Profile header' (3:2)** — the name is a fixed-width box. Wrap to 2 lines or truncate
   with ellipsis? (German labels run ~35% longer.) → *Default: 2 lines, then ellipsis.*
3. **'Primary Button' (1:7) has no pressed or disabled variant.** Use the system state layers (pressed
   = 12% overlay of on-primary, disabled = 38% opacity)? → *Default: yes, derived from tokens.*

### Translation notes (confirm the approximation)
4. **Card shadow spread 2 (1:7) on iOS** — SwiftUI shadows have no spread; we'll pad the shadow shape
   by 2pt. Acceptable? → *Default: yes.*

## Assumptions (no answer needed unless you disagree)
- Focus rings use the design system focus token on every interactive element.
- Status bar and home indicator frames are system chrome, not built.
```

## Example questions by area

| Area | Question | Typical default |
|---|---|---|
| Empty | First-use empty vs no-results empty for 'Search' — same design? | Separate: first-use explains + CTA; no-results echoes the query + clear filters |
| Error | Network failure while loading 'Feed' — inline banner with retry, or full-screen? | Full-screen with retry if nothing cached; banner if stale data shown |
| Validation | When does 'Email' show the error — on blur or on submit? | On blur, cleared on edit |
| Font scale | At the largest text size, should 'Stats row' (3 columns) stack vertically? | Stack at accessibility sizes |
| Touch | 'Close' (1:8) is 32×32 — keep visual size and expand the hit area? | Yes, 44/48 hit area |
| Contrast | 'Subtitle' #bbbbbb on white is 1.9:1 — darken to the secondary text token? | Use `color/text-secondary` |
| Dark mode | Only light is drawn — derive dark from token modes? Illustration variants? | Tokens yes; ask for illustration variants |
| RTL | Should the progress chevron in 'Stepper' mirror in Arabic? | Mirror directional icons |
| Motion | Smart-animate between 'Card' and 'Detail' — shared-element transition required or nice-to-have? | Nice-to-have; cross-fade fallback |
| Native | Draw a custom switch or use the platform Toggle/Switch styled with tokens? | Platform control |
| Responsive | Desktop only drawn at 1440 — max content width and behavior at 768/1024? | Max 1200, single column below 768 |
| Content | Price 'Total' — currency format, and how are values over 1M shown? | Locale currency, no abbreviation |

## Audit findings that are questions by design

These codes come out of `audit.js` as heuristics or measured failures; each becomes one question
(merge the same one across screens), with the default below.

| Finding | Ask | Default |
|---|---|---|
| `default-copy-in-instance` | 'Field Card' > 'Label' (1:23) still says "Description" — the component's default — where the other instance says "Units". The intended copy, or a placeholder left in? | Build the copy as drawn and list it |
| `undesigned-open-state` | 'Category' (1:40) reads "Select a category" but no open list is drawn. The platform's native picker, or a designed list (which frame)? | The native control, styled with the field's tokens |
| `near-token-color` | The footer fill #1a1b20 is ΔE 0.8 from `gray/900` (#1a1b21). A typo of the token, or deliberate? | The literal exactly as drawn, flagged — never the token (that would be an approximation) |
| `duplicate-root-subtree` | A second 'Footer' (1:90) is laid absolutely over the frame on top of the in-flow one (1:12). A leftover copy? | Build the in-flow one; record the copy as a design artefact |
| `non-text-contrast` | The input border `border/default` (#4a4a52) is 1.8:1 against the page around it (WCAG 1.4.11 needs 3:1). A darker border token, or a fill that sets the field apart? | Build it to pass (a border or fill reaching 3:1), recorded as a deviation |

A measured contrast failure — text (1.4.3, placeholders too) or a control's boundary (1.4.11) — is never
offered "keep as designed" as an option or a default: build-screen cannot waive it (its accessibility rule),
so the question is only which passing value the designer wants.
