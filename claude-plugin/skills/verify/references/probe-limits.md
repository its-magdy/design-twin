# What the probe's behaviour battery and visual diff can and cannot see

Read this when you report the behaviour or visual-diff result and need to say how far to trust it: which checks
the battery refuses, what it cannot see, and when a visual diff is not run or not reliable. Neither result changes
the fidelity verdict.

## Contents
- Behaviour battery limits (write block, the drive, keyboard activation, an opener's own content, refusals, misses)
- Visual diff: when it is not run
- Visual diff: limits

## Behaviour battery limits

The paragraphs below are one list, in the order the probe applies it; a semicolon ends each item.

Limits: destructive paths never run (the battery's pages cannot write: per unit, from its first key press, click,
scroll, hover or resize on, every request but GET/HEAD/OPTIONS — from the page, its frames, workers, shared workers
and service workers alike — is blocked browser-wide, every WebSocket message the page sends is dropped and a
WebSocket it opens then never reaches the server, which makes every check of that unit from its first action on
`not-run` "the page tried to write";

the screen's own load and `--steps` may write, as in the measurement pass, and a battery page that then shows other
tagged elements than the measured one, or misses the opener or destination the check uses, is `not-run` "the page
reached for this check differs from the measured page";

the probe's drive of the interactions (before the battery) has no write block: it never clicks an opener that would
submit a form or whose click point is another control inside it — an activating control (also under a focusable
glyph or an editable label inside it), a label's control or a nested page (an iframe, object or embed), open shadow
roots included — but it does not see a control in a closed shadow root or one that is only a click listener with no
role (an icon with an onclick, a bare `<svg onclick>`), and clicks those;

a submitting control is never clicked;

Enter/Space are pressed only on the opener itself when it is a button-like control (or the button its tagged label
sits in, or the one button-like control of a cell or card opener whose centre it fills and that shows nothing of its
own outside it — no visible text, image, icon (a CSS mask too), generated content or filled block (a swatch, a
status dot), open shadow roots and positioned labels escaping a clip included;

a tooltip at opacity 0 out of flow, an sr-only label (clipped, or off the page at left:-9999px) and a filled wrapper
or hover tint over the control show nothing, but a label at opacity 0 in flow (a reveal-on-scroll entrance yet to
play) counts, and so do a progress bar, a meter and a list marker (its own too);

not read: the page inside an iframe (the iframe itself counts), a closed shadow root, a clip-path other than inset()
(what it hides counts);

and it shows nothing of its own by its pixels too: the opener, hovered first so a control shown only on hover is at
its click point, is screenshotted with only that control hidden and with all its content hidden — the content of its
open shadow roots, its own list marker and its other pseudo-elements (a first letter, a placeholder, a file button,
a details' content, scroll buttons and markers) included, and everything outside the opener, its ancestors too,
hidden in both shots so a toast, a ticker or a parent repainted by script never decides — any painted difference
counts (a dot, a swatch, a band, a progress bar, a stripe or a 1-px divider);

decoration is only its own background colour, a border in one colour (a 1-px divider on one side too) and its
shadow, and a fill over all of it or a wrapper within 8 px of the control when, screenshotted alone (filters,
clip-paths and masks of the opener and its ancestors off), they paint one plain colour (pixel-verified against their
real rounded outline; a 1.5-px anti-aliased edge allowed — a clip-path flag, a background-clip stripe, a progress
ring, a shadow ring or a second colour is content, and so is a wrapper with its own small shadow or a 1-px frame in
another colour, which is refused);

also content: the opener's own background image (a gradient, a url — a progress fill), its border in two colours or
a stripe 2 px wider than its other sides, a scroll button, and a label, image or generated label laid at least half
over the opener from outside its element (a positioned sibling, a parent's `::after`) — unless it is fixed or sticky
(a toast or banner is ignored) or hit-testing shows it under the opener's opaque background;

an ancestor's own paint (a row's gradient behind a transparent cell) is not the opener's;

a page rule that keeps something showing against the probe's hiding rule (an inline or cascade-layer `!important`)
refuses;

not seen: a closed shadow root, foreign content inside an ancestor's shadow root, a shadow root attached after the
check started, a part of the opener still outside the viewport once scrolled in, content revealed only after a
delay, a generated label of an element lying elsewhere on the page;

the probe's init CSS (no transitions) is lost when a page replaces `document.adoptedStyleSheets` after its load
under a strict style CSP;

an sr-only label at `right:-9999px` in a right-to-left page counts as content (that cell is refused);

and since every opener is hovered first, a `mouseenter` / `mouseover` side effect also fires on an opener the drive
then refuses (no write block in the drive);

also content — the opener's own inset box-shadow offset 2 px or more or blurred (a stripe, a progress fill, an inner
glow), sharp box-shadow ring layers in more than one colour (the ring layers only — its border does not count, nor
does a layer in its own background colour where that cannot show: an outer one, a ring-offset, or an inset one over
an opaque `border-box` / `padding-box` background) and its own paint under a mask or a clip-path other than a
rounded `inset(0)`;

never foreign content — a tooltip revealed by the probe's hover (a `[role=tooltip]` element, or the element the
control's `aria-describedby` names, not shown before the hover; one already on screen is the opener's own label and
refuses) and a label at effective opacity 0;

a label counts as under the opener only when no opacity below 1 or blend mode sits on the opener or above it;

an element the page mounts in the opener while it is screenshotted (a re-render in the shot's own frame) refuses
("the opener's content changed while it was compared");

refused by rule: a page with more than 500,000 elements (the walk for a label laid over the opener stops there), an
opener whose content is re-created while it is compared (an empty spacer a framework re-creates, marks a
morphdom-style patch strips, a placeholder mounted on `mouseleave`; it can differ between runs), an opener inside a
shadow root, a role-less tooltip or other popover laid over the opener (a JS tooltip appended to the body without
`role="tooltip"` or `aria-describedby`; with a show delay the result can differ between runs), a cell whose sole
control has a tooltip pre-mounted but hidden by `transform: scale(0)` or moved off-screen (it counts as shown before
the hover), and a label under an opener whose background is `oklch()`, `lab()` or `color()` (never proven opaque);

not seen (known misses, the drive can write): a sibling's relative `::before` shifted over the opener from
elsewhere, text overflowing a 0-height wrapper beside it, a `display: contents` `[role=tooltip]` or
`aria-describedby` target laid over the opener, a label the page re-creates as a new element on the hover with
tooltip semantics (`role="tooltip"`, or the control's `aria-describedby` target), and a page that defines
`window.__dtTipPre` itself first turns the record of what was shown before the hover off (an adversarial page);

the focused element outside the opener stays shown in both shots;

every refusal names its reason (`… — not driven (its own content: …)`);

its own background colour is decoration — the control the mouse open clicks) — never on another control inside a
card or row opener, never in a form field or on a focusable row or card around it;

a click outside a dialog lands only on its backdrop or scrim — with nothing to click there the check is `not-run`;

the safe close is a button clicked with the mouse, or a link only when its `href` is `#`, empty or `javascript:`;

not covered: a GET with a side effect, a WebSocket opened inside a worker, or a write the page defers past the
unit's end — an undo window over about 1 s: it never leaves, the unit's page is closed first, but the check that
caused it is judged as if nothing was written), an opener inside a closed menu or `<details>` is `not-run` for
keyboard reach, iframes are not scanned, safe-close detection is English-only ("Close", "Dismiss", "Cancel", …), and
only dialogs the design or the plan names get the battery.

## Visual diff: when it is not run

The reference is read from the project that owns the expectation (the folder above `design/verify/`, so a monorepo
whose `design/` is at the root works with `--project <app dir>`), and must stay inside its `design/export/`. A
not-run diff says why:

- a discovery thumbnail is no reference — re-pull the screen;
- the reference PNG changed since `--expect`;
- an expectation written before the visual diff existed has no `referenceImage` — re-run `--expect` (the
  expectation sha changes once);
- no time left within `--max-time`;
- a reference PNG whose size is not the frame's render bounds at the reference's scale (refused at `--expect`), or a
  capture whose shape differs from the reference's — re-pull, then re-run `--expect`.

A `colorProfile` note (a Display P3 document, or an iCCP profile in the reference) means colours are compared
without colour management and colour differences are unreliable.

## Visual diff: limits

- Text-edge rasteriser noise of about 1–3 % is normal, which is why the number is never judged.
- No masking: animated or random content shows as a region.
- Only the first frame at rest — no hover, dialog or overlay diffs.
- `grid "1x"` (capture and reference crop differ by more than 2 px) is resampled and can hide a difference.
- The 0.2 threshold is blind to luminance steps under about a fifth (light borders, background tints, disabled
  greys) and anti-aliasing detection absorbs much of a thin line's difference, so a clean diff does not clear lines
  or tints.
- A reference whose render bounds lie inside the frame box is placed at the frame's top-left with a note (alignment
  unverified).
- The decode and diff run after the browser closes, outside `--max-time` (bounded by a 4096×4096 decode cap); the
  capture runs before the battery, takes from its time and replays `--steps` once more.
- Region attribution uses the expectation's x/y, which for some nodes are render-bounds origins (a few px off).
- A build frame taller or shorter than the design is compared only within the design window, with a note.
- The capture is a separate render after the drive, so subpixel layout can differ from the DPR-1 measurement, and
  server state the drive changed shows.
- Attribution needs the measurement's selectors (unmatched areas name only `designed` ids; TEXT without `y` has no
  designed rect).
- Diffs from different headless channels are not comparable.
- At a fractional scale the outermost device-px ring is not counted for regions (a wrong 1-px border on the frame
  itself shows in the percentage but never as a region).
- The hot-region total includes rasteriser-noise fragments — read the listed regions (the largest first), not the
  count.
- The metric is not perceptual (no SSIM).
