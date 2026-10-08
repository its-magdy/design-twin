// probe-match.ts — which element is a spec's, decided in plain code (no DOM, no browser).
//
// probe-page.ts only reports what the page holds (paths, rects, visibility flags); this file picks, for
// each expectation row, the ONE element that is its — or says why there is none. Field test F-57: an
// ad-hoc probe that took "the first element with this text" measured a sidebar label on its <li>, a page
// title on the <h1> instead of the sidebar item with the same words, and a button label on the <h2> inside
// a CLOSED <dialog>: 18 of 25 high deltas were artefacts. So the order is fixed (D17 — no structural
// matching), every rule must yield exactly one element, and nothing is ever first-wins on text:
//
//   1. tag              [data-dt-node="<id>"], the first visible hit (selectorCount says how many)
//   2. tag-shared-path  one element tagged with ANOTHER instance's id for the same component-internal node
//                       (`I<a>;<suffix>` vs `I<b>;<suffix>`: a shared component built once, tagged once)
//   2b. tag-alias       one element tagged with one of the spec's aliases (D32: the same node of the same
//                       component, found by name path in a sibling screen's export at --expect) — still a tag (D17);
//                       two such elements → not measured. Lower confidence than a tag: compare caps it (D30).
//   3. text             the innermost visible owner of the spec's exact text (then case-insensitive), scoped
//                       to a tagged ancestor, tie-broken by the spec's x (≥ 8px clearer), then
//      text-ordinal     k specs sharing the text and exactly k visible owners → paired in document order
//   4. position         (--position only) the innermost element at the spec's frame-relative box, ±2px
//   5. otherwise        not measured, with the reason ("tag it")
//
// The frame root (F-63) is its own rule: [data-dt-node=<frame id>], else the outermost element of the
// frame's size that paints (a transparent <body> is not the frame), else the viewport.
import type { Candidate, CollectOutput, MeasureResult, Rect, SizedCandidate } from "./probe-page.ts";
import type { MeasuredNode, MeasuredStyles, PaintedBy, ProbeFrame, VerifySpec } from "./types.ts";

export type MatchedBy = "tag" | "tag-shared-path" | "tag-alias" | "text" | "text-ordinal" | "position" | "frame";
/** Every matchedBy the shipped probe writes, in rule order — the canonical list (D30's caps, the visual-verifier doc). */
export const CANONICAL_MATCHED_BY: readonly MatchedBy[] = ["tag", "tag-shared-path", "tag-alias", "text", "text-ordinal", "position", "frame"];
export interface Match {
  nodeId: string; matchedBy: MatchedBy; selector: string; selectorCount?: number; path: string; cand: Candidate | null;
  /** hover-only content not rendered at rest (`hidden group-hover:flex`): the tagged ancestor to hover to reveal it */
  hoverVia?: string;
  /** an input placeholder's spec: it shares the <input> with the field's own spec (the ::placeholder is part of it) */
  placeholder?: true;
  /** a TEXT spec whose label is written straight into its tagged ancestor's element: that ancestor's id */
  sharesWith?: string;
}
export interface NoMatch { nodeId: string; why: string }
export const isMatch = (m: Match | NoMatch): m is Match => "matchedBy" in m;
/** A resolved frame root: the ProbeFrame written to measured.json plus the element path to measure. */
export interface ResolvedFrame extends ProbeFrame { path: string; note?: string }

/** The text comparison both sides use: U+00A0 → space, whitespace collapsed, trimmed (case kept). */
export const normText = (s: string): string => s.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
/** `[data-dt-node="<id>"]` with the attribute value quoted for CSS. */
export const attrSelector = (id: string): string => `[data-dt-node="${id.replace(/["\\]/g, "\\$&")}"]`;
/** The component-internal part of an instance-scoped id (`I1:2;3:4;5:6` → `3:4;5:6`), as verify-screen.ts reads it. */
export const idSuffix = (id: string): string | null => { const i = id.indexOf(";"); return i === -1 ? null : id.slice(i + 1); };

/** The text a spec is found by: its characters, or an input placeholder's. */
export function specText(spec: VerifySpec): { text: string; placeholder: boolean } | null {
  if (typeof spec.placeholderText === "string" && normText(spec.placeholderText)) return { text: normText(spec.placeholderText), placeholder: true };
  if (typeof spec.text === "string" && normText(spec.text)) return { text: normText(spec.text), placeholder: false };
  return null;
}
const PAINT_TYPES = new Set<string>(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"]);
/** A spec whose colour is an SVG-style paint (verify-screen.ts writes `fill` only for those). */
export const isPaintSpec = (spec: VerifySpec): boolean => spec.fill !== undefined || PAINT_TYPES.has(spec.type);

// ---------------------------------------------------------------- the frame root (F-63)
const ALPHA_ZERO = /^transparent$|^rgba\([^)]*,\s*0(?:\.0+)?\)$/;
/** Whether a size-matched candidate paints: probe-page computes `paints`; a hand-built candidate may carry only the colour. */
const paints = (c: SizedCandidate): boolean => c.paints || (!ALPHA_ZERO.test(c.background.trim()) && c.background.trim() !== "") || (c.backgroundImage !== "" && c.backgroundImage !== "none");

/**
 * The element that IS the frame: tagged with the frame id (visible) → via "tag"; else the OUTERMOST element
 * within ±2px of the frame's w×h that paints (bg alpha > 0 or a background image) → via "size-and-fill";
 * else, when allowed (the first frame), the viewport → via "viewport". null = not rendered.
 */
export function resolveFrame(frame: { nodeId: string; w: number | null; h: number | null }, tagged: Candidate[], sized: SizedCandidate[], viewport: { w: number; h: number }, allowViewport: boolean): ResolvedFrame | null {
  const t = tagged.find((c) => c.dt === frame.nodeId && c.flags.box && c.flags.visible && !c.flags.inClosedDialog);
  if (t) return { nodeId: frame.nodeId, selector: attrSelector(frame.nodeId), via: "tag", rect: t.rect, path: t.path };
  if (frame.w !== null && frame.h !== null) {
    const fw = frame.w, fh = frame.h;
    const s = sized
      .filter((c) => c.flags.visible && Math.abs(c.rect.w - fw) <= 2 && Math.abs(c.rect.h - fh) <= 2 && paints(c))
      .sort((a, b) => a.depth - b.depth || a.order - b.order)[0];
    if (s) return { nodeId: frame.nodeId, selector: s.path, via: "size-and-fill", rect: s.rect, path: s.path };
  }
  if (!allowViewport) return null;
  return {
    nodeId: frame.nodeId, selector: "html", via: "viewport", rect: { x: 0, y: 0, w: viewport.w, h: viewport.h }, path: "html",
    note: `no element is tagged data-dt-node="${frame.nodeId}" and none of the frame's size (${frame.w ?? "?"}×${frame.h ?? "?"}) paints a background — positions are measured from the viewport origin; tag the frame root`,
  };
}

// ---------------------------------------------------------------- per-spec matching
export interface MatchPool {
  /** tagged elements by their data-dt-node, document order */
  byTag: Map<string, Candidate[]>;
  /** tagged elements whose id is NOT one of the expectation's, by the id's component-internal suffix */
  bySuffix: Map<string, Candidate[]>;
  collect: Pick<CollectOutput, "text" | "placeholders" | "positions">;
  /** the specs that share a text (and kind), in expectation order */
  sameText: Map<string, VerifySpec[]>;
  /** resolved frames by frame id (null = not rendered) */
  frames: Map<string, ResolvedFrame | null>;
  /** the expectation's first frame id */
  primaryFrameId: string | null;
  /** every spec/instance/hidden id the expectation names: an element tagged with one of them is THAT node's */
  expectedIds: ReadonlySet<string>;
}
export interface MatchOptions { position: boolean }

const textKey = (t: { text: string; placeholder: boolean }): string => (t.placeholder ? "placeholder:" : "text:") + t.text;

/** Index a collect pass for chooseMatch. `expectedIds`: every spec/instance/hidden id the expectation names. */
export function buildPool(collect: CollectOutput, specs: VerifySpec[], expectedIds: ReadonlySet<string>, frames: Map<string, ResolvedFrame | null>, primaryFrameId: string | null): MatchPool {
  const byTag = new Map<string, Candidate[]>(), bySuffix = new Map<string, Candidate[]>();
  for (const c of collect.tagged) {
    if (c.dt === null) continue;
    byTag.set(c.dt, [...(byTag.get(c.dt) || []), c]);
    const sfx = idSuffix(c.dt);
    if (sfx !== null && !expectedIds.has(c.dt)) bySuffix.set(sfx, [...(bySuffix.get(sfx) || []), c]);
  }
  const sameText = new Map<string, VerifySpec[]>();
  for (const s of specs) { const t = specText(s); if (t) sameText.set(textKey(t), [...(sameText.get(textKey(t)) || []), s]); }
  return { byTag, bySuffix, collect, sameText, frames, primaryFrameId, expectedIds };
}

/** Would a person see this element as the text's owner? (aria-hidden is NOT a reason: decorative ≠ invisible.) */
export function textUsable(c: Candidate, spec: VerifySpec): boolean {
  const f = c.flags;
  return f.box && f.visible && !f.zeroSize && !f.inClosedDialog && !f.inert && (!f.opacity0 || spec.drawnState !== undefined);
}
const tagVisible = (c: Candidate): boolean => c.flags.box && c.flags.visible && !c.flags.inClosedDialog;
const hiddenWhy = (cs: Candidate[]): string => {
  const n = (p: (c: Candidate) => boolean): number => cs.filter(p).length;
  const parts = [
    [n((c) => c.flags.inClosedDialog), "in a closed <dialog>"], [n((c) => !c.flags.box), "not rendered (display:none)"],
    [n((c) => c.flags.box && !c.flags.visible), "visibility hidden"], [n((c) => c.flags.inert), "inert"],
    [n((c) => c.flags.zeroSize), "0×0"], [n((c) => c.flags.opacity0), "opacity 0"],
  ] as const;
  return parts.filter(([k]) => k > 0).map(([k, w]) => `${k} ${w}`).join(", ");
};

/** The frame a spec belongs to (its frameId, else the first frame). */
export function frameOfSpec(spec: VerifySpec, pool: MatchPool): { id: string | null; frame: ResolvedFrame | null } {
  const id = spec.frameId ?? pool.primaryFrameId;
  return { id, frame: id === null ? null : pool.frames.get(id) ?? null };
}

/**
 * The ONE element a spec is measured on, or why there is none. Never first-wins on text: two visible
 * owners of the same words with nothing to tell them apart is a notMeasured ("tag it"), not a guess.
 */
export function chooseMatch(spec: VerifySpec, pool: MatchPool, opts: MatchOptions): Match | NoMatch {
  const id = spec.nodeId;
  const { id: frameId, frame } = frameOfSpec(spec, pool);
  if (frameId !== null && frame === null) return { nodeId: id, why: `frame ${frameId} not rendered (no data-dt-node="${frameId}" and no element of its size that paints)` };

  // the frame root itself
  if (frame && id === frame.nodeId) {
    const hits = pool.byTag.get(id) || [];
    return { nodeId: id, matchedBy: frame.via === "tag" ? "tag" : "frame", selector: frame.selector, ...(frame.via === "tag" ? { selectorCount: hits.length } : {}), path: frame.path, cand: hits.find(tagVisible) ?? null };
  }

  // 1. tag
  const hits = pool.byTag.get(id) || [];
  if (hits.length) {
    const vis = hits.find(tagVisible) ?? (spec.drawnState !== undefined ? hits.find((c) => c.flags.box && !c.flags.inClosedDialog) : undefined);
    if (vis) return { nodeId: id, matchedBy: "tag", selector: attrSelector(id), selectorCount: hits.length, path: vis.path, cand: vis };
    // Hover-only content that is display:none at rest (`hidden group-hover:flex`): measured through a hover of
    // its nearest visible tagged ancestor (the row it appears on), never rejected as hidden.
    const first = hits.find((c) => !c.flags.inClosedDialog);
    if (spec.drawnState === "hover" && first) {
      for (const a of spec.ancestorIds || []) {
        const anc = (pool.byTag.get(a) || []).find((c) => tagVisible(c) && !c.flags.zeroSize);
        if (anc) return { nodeId: id, matchedBy: "tag", selector: attrSelector(id), selectorCount: hits.length, path: first.path, cand: first, hoverVia: anc.path };
      }
    }
    return { nodeId: id, why: `hidden: data-dt-node="${id}" is on ${hits.length} element(s), none rendered (${hiddenWhy(hits)})` };
  }

  // 2. tag-shared-path
  const sfx = idSuffix(id);
  if (sfx !== null) {
    const shared = (pool.bySuffix.get(sfx) || []).filter(tagVisible);
    const only = shared.length === 1 ? shared[0] : undefined;
    if (only && only.dt !== null) return { nodeId: id, matchedBy: "tag-shared-path", selector: attrSelector(only.dt), selectorCount: 1, path: only.path, cand: only };
  }

  // 2b. tag-alias (D32): an element tagged with the id this node has in a sibling screen's export (a shared
  // shell built once, tagged with that screen's ids). An alias that is itself one of this expectation's ids is
  // that node's, never this one's. Exactly one visible element; several → not measured (no guess).
  const aliases = [...new Set(spec.aliases || [])].filter((a) => a !== id && !pool.expectedIds.has(a));
  if (aliases.length) {
    const hitsA = aliases.flatMap((a) => (pool.byTag.get(a) || []).filter(tagVisible));
    const onlyA = hitsA.length === 1 ? hitsA[0] : undefined;
    if (onlyA && onlyA.dt !== null) return { nodeId: id, matchedBy: "tag-alias", selector: attrSelector(onlyA.dt), selectorCount: 1, path: onlyA.path, cand: onlyA };
    if (hitsA.length > 1) {
      const tags = [...new Set(hitsA.map((c) => c.dt))].join(", ");
      return { nodeId: id, why: `ambiguous: ${hitsA.length} visible elements carry this node's aliases (${tags}) from other screens' exports; tag the one that is this node's with data-dt-node="${id}"` };
    }
  }

  // 3. text
  const t = specText(spec);
  let textWhy: string | null = null;
  if (t) {
    const found = t.placeholder ? { exact: pool.collect.placeholders[t.text] || [], caseless: [] } : pool.collect.text[t.text] || { exact: [], caseless: [] };
    // One element per spec: an owner tagged with ANOTHER node's id is that node's (a tag is the builder's
    // explicit claim) — never handed to this spec by text.
    // (A placeholder is the exception: it lives on the field's <input>, whoever's tag that carries.)
    // And a TEXT spec whose label sits straight in its NEAREST tagged ancestor's element (`<button
    // data-dt-node=X>Filter</button>`) may share X's element — only when that element's own text IS this text.
    const nearestTagged = (spec.ancestorIds || []).find((a) => (pool.byTag.get(a) || []).some(tagVisible)) ?? null;
    const sharesAncestor = (c: Candidate): boolean => !t.placeholder && spec.type === "TEXT" && c.dt !== null && c.dt === nearestTagged && c.ownText === t.text;
    const free = (c: Candidate): boolean => t.placeholder || c.dt === null || c.dt === id || !pool.expectedIds.has(c.dt) || sharesAncestor(c);
    let all = found.exact.filter(free);
    let cands = all.filter((c) => textUsable(c, spec));
    if (!cands.length && found.caseless.length) { all = found.caseless.filter(free); cands = all.filter((c) => textUsable(c, spec)); }
    // (a) scope to the nearest visible tagged ancestor; the text is not inside it → not this spec's (a page-wide
    // owner elsewhere is some other row's copy of the same words)
    let scope: string | null = null;
    for (const a of spec.ancestorIds || []) {
      if (!(pool.byTag.get(a) || []).some(tagVisible)) continue;
      if (cands.length) {
        // inside = below the ancestor's element, or that element itself (a placeholder on the tagged <input>, a label written into a tagged button)
        // (the element itself only when its OWN text is the spec's — `Fil<b>ter</b>` is not; a placeholder lives on it)
        const scoped = cands.filter((c) => (c.dt === a && (t.placeholder || c.ownText === t.text)) || c.taggedAncestors.includes(a));
        if (!scoped.length) return { nodeId: id, why: `text '${t.text}' is not inside data-dt-node="${a}" (its nearest tagged ancestor); tag it with data-dt-node="${id}"` };
        cands = scoped; scope = a;
      }
      break;
    }
    // (b) exactly one
    const one = cands.length === 1 ? cands[0] : undefined;
    if (one) return { nodeId: id, matchedBy: "text", selector: one.path, selectorCount: 1, path: one.path, cand: one, ...(t.placeholder ? { placeholder: true as const } : {}), ...(sharesAncestor(one) && one.dt !== null ? { sharesWith: one.dt } : {}) };
    if (cands.length > 1) {
      // (c) the spec's own position, when it has one, and only when it is clearly nearer
      if (typeof spec.x === "number" && frame) {
        const sx = spec.x, sy = spec.y;
        const dist = (c: Candidate): number => {
          const r: Rect = c.rangeRect ?? c.rect;
          return Math.abs(r.x - frame.rect.x - sx) + (typeof sy === "number" ? Math.abs(c.rect.y - frame.rect.y - sy) : 0);
        };
        const ranked = cands.map((c) => ({ c, d: dist(c) })).sort((a, b) => a.d - b.d);
        const [best, second] = ranked;
        if (best && second && second.d - best.d >= 8) return { nodeId: id, matchedBy: "text", selector: best.c.path, selectorCount: 1, path: best.c.path, cand: best.c };
      }
      // (d) ordinal: k specs share the text and exactly k visible owners → pair in document order
      // peers matched by their own tag are not in the count (their element is theirs, and is not a candidate here)
      const peers = (pool.sameText.get(textKey(t)) || []).filter((s) => (scope === null || (s.ancestorIds || []).includes(scope)) && (s.nodeId === id || !(pool.byTag.get(s.nodeId) || []).some(tagVisible)));
      const k = peers.findIndex((s) => s.nodeId === id);
      if (peers.length > 1 && peers.length === cands.length && k !== -1) {
        const c = [...cands].sort((a, b) => a.order - b.order)[k];
        if (c) return { nodeId: id, matchedBy: "text-ordinal", selector: c.path, selectorCount: 1, path: c.path, cand: c };
      }
      textWhy = `text '${t.text}' matched ${cands.length} visible elements${scope ? ` inside data-dt-node="${scope}"` : ""}; tag it with data-dt-node="${id}"`;
    } else if (all.length) {
      textWhy = `hidden: text '${t.text}' is only in ${all.length} element(s) a person cannot see (${hiddenWhy(all)}); tag the visible one with data-dt-node="${id}"`;
    } else {
      textWhy = `no data-dt-node="${id}" and no visible element holds the text '${t.text}'; tag it`;
    }
  }

  // 4. position (opt-in, low confidence)
  if (opts.position) {
    const at = (pool.collect.positions[id] || []).filter((c) => c.flags.box && c.flags.visible && !c.flags.inClosedDialog);
    const only = at.length === 1 ? at[0] : undefined;
    if (only) return { nodeId: id, matchedBy: "position", selector: only.path, selectorCount: 1, path: only.path, cand: only };
    if (at.length > 1 && !textWhy) return { nodeId: id, why: `${at.length} elements sit at this node's box; tag it with data-dt-node="${id}"` };
  }

  return { nodeId: id, why: textWhy ?? `no data-dt-node and no text; tag it with data-dt-node="${id}"` };
}

/**
 * One element, one spec (applied after every spec is matched): where several specs landed on the same element,
 * the one whose own tag is on it keeps it (a tag or the frame root); every other one becomes notMeasured.
 * Without a tagged owner, none keeps it — a shared element is a guess for all of them.
 */
export function claimOnce(results: Array<Match | NoMatch>): Array<Match | NoMatch> {
  const byPath = new Map<string, Match[]>();
  // A placeholder, and a label sharing its tagged ancestor's element, may share with that element's owner —
  // but only one such label per element (two would be a guess).
  const sharers = new Map<string, number>();
  for (const r of results) if (isMatch(r) && r.sharesWith !== undefined) sharers.set(r.path, (sharers.get(r.path) || 0) + 1);
  const exempt = (m: Match): boolean => m.placeholder === true || (m.sharesWith !== undefined && sharers.get(m.path) === 1);
  for (const r of results) if (isMatch(r) && !exempt(r)) byPath.set(r.path, [...(byPath.get(r.path) || []), r]);
  const owner = new Map<string, Match | null>();
  for (const [p, ms] of byPath) {
    if (ms.length < 2) continue;
    owner.set(p, ms.find((m) => (m.matchedBy === "tag" && m.cand?.dt === m.nodeId) || m.matchedBy === "frame") ?? null);
  }
  return results.map((r) => {
    if (!isMatch(r) || exempt(r) || !owner.has(r.path)) return r;
    const o = owner.get(r.path) ?? null;
    if (o === r) return r;
    const others = (byPath.get(r.path) || []).filter((m) => m !== r).map((m) => m.nodeId);
    return { nodeId: r.nodeId, why: o ? `its element ${r.selector} is data-dt-node="${o.nodeId}"'s; tag this node's own element with data-dt-node="${r.nodeId}"`
      : `the same element (${r.selector}) was matched for ${others.length + 1} specs (also ${others.join(", ")}); tag it with data-dt-node="${r.nodeId}"` };
  });
}

/**
 * F-74 (D111): what to hover for a spec whose drawn state is ANOTHER node's (`drawnStateFrom`: a control inside a row
 * drawn hovered) — the owner's visible tagged element, else the nearest visible tagged ancestor below the owner (its
 * :hover reaches the owner's element too). Hovering the control itself would turn on the control's OWN :hover, which the
 * design never drew. `none`: an own state or an old expectation (no drawnStateFrom) — hover as before; `untagged`: no
 * tagged element of the owner, or below it, is visible. (verify-probe then hovers it at a free point, freeHoverPoint.)
 * L1: `next` — the other visible tagged candidates below the owner, in the same order (nearest the measured element
 * first): verify-probe tries them when `path` has no free point (a same-box wrapper around the control).
 */
export type OwnerHover = { kind: "none" } | { kind: "owner"; id: string; path: string; next: Array<{ id: string; path: string }> } | { kind: "untagged"; owner: string };
export function ownerHover(spec: VerifySpec, m: Pick<Match, "path">, byTag: ReadonlyMap<string, Candidate[]>): OwnerHover {
  const owner = spec.drawnStateFrom;
  if (owner === undefined || owner === spec.nodeId) return { kind: "none" };
  const visible = (id: string): Candidate | undefined => (byTag.get(id) || []).find((c) => tagVisible(c) && !c.flags.zeroSize);
  // ancestorIds is nearest first and leaves the frame root out: the ones below the owner, or all of them when the owner is
  // not among them (the frame root)
  const anc = spec.ancestorIds || [];
  const at = anc.indexOf(owner);
  const found: Array<{ id: string; path: string }> = [];
  for (const id of [owner, ...(at === -1 ? anc : anc.slice(0, at))]) {
    const c = visible(id);
    if (!c || found.some((f) => f.path === c.path)) continue;
    // the measured element IS the hovered one (a label written into the owner's tagged element): its own hover, as before
    if (c.path === m.path) { if (!found.length) return { kind: "none" }; continue; }
    found.push({ id, path: c.path });
  }
  const [first, ...next] = found;
  return first ? { kind: "owner", id: first.id, path: first.path, next } : { kind: "untagged", owner };
}

/** The --position boxes (page coordinates) for specs that state a full frame-relative box. */
export function positionBoxes(specs: VerifySpec[], pool: Pick<MatchPool, "frames" | "primaryFrameId">): Array<{ nodeId: string; x: number; y: number; w: number; h: number }> {
  const out: Array<{ nodeId: string; x: number; y: number; w: number; h: number }> = [];
  for (const s of specs) {
    const f = pool.frames.get(s.frameId ?? pool.primaryFrameId ?? "");
    if (!f || typeof s.x !== "number" || typeof s.y !== "number" || typeof s.width !== "number" || typeof s.height !== "number") continue;
    out.push({ nodeId: s.nodeId, x: f.rect.x + s.x, y: f.rect.y + s.y, w: s.width, h: s.height });
  }
  return out;
}

// ---------------------------------------------------------------- the output contract (DT-23)
/**
 * One measured.json node: EVERY key in `keys` present in styles; a null always has its reason in
 * `unmeasured` (a probe that silently leaves a key out is how `fill` went unmeasured for a whole run).
 */
export function shapeNode(spec: VerifySpec, match: Match, raw: MeasureResult, keys: readonly string[]): MeasuredNode {
  const styles: MeasuredStyles = {};
  const unmeasured: Record<string, string> = {};
  for (const k of keys) {
    const v = raw.styles[k];
    if (v === undefined || v === null) {
      styles[k] = null;
      unmeasured[k] = raw.unmeasured[k] || (raw.found ? "the page reported no value" : "the element was gone when measured");
    } else styles[k] = v;
  }
  // D34: where a stroke was read — only on a node whose page result names it (never a null to explain)
  const from = raw.styles.strokeFrom, align = raw.styles.strokeAlign;
  if (from === "border" || from === "box-shadow" || from === "outline") {
    styles.strokeFrom = from;
    if (from !== "border" && (align === "inside" || align === "outside")) styles.strokeAlign = align;
  }
  // F-74 (D111) / F-69 (D114): optional keys — only when the page read them
  const pb = raw.styles.paintedBy;
  if (isPaintedBy(pb)) styles.paintedBy = pb;
  const tt = raw.styles.textTransform;
  if (typeof tt === "string" && tt !== "") styles.textTransform = tt;
  return {
    nodeId: spec.nodeId,
    matchedBy: match.matchedBy,
    selector: match.selector,
    ...(match.selectorCount !== undefined ? { selectorCount: match.selectorCount } : {}),
    ...(raw.textFrom !== undefined ? { textFrom: raw.textFrom } : {}),
    ...(raw.textFromMixed ? { textFromMixed: true } : {}),
    ...(raw.fillSource !== undefined ? { fillSource: raw.fillSource } : {}),
    styles,
    ...(Object.keys(unmeasured).length ? { unmeasured } : {}),
    ...(match.matchedBy === "position" ? { note: "matched by position (±2px) — low confidence; tag it with data-dt-node" }
      : match.matchedBy === "tag-alias" ? { note: `matched by another screen's id for this node (${match.selector}) — tag it with data-dt-node="${spec.nodeId}" to make it certain` } : {}),
  };
}

/** probe-page's styles.paintedBy, as JSON came back from the page. */
export function isPaintedBy(x: unknown): x is PaintedBy {
  return typeof x === "object" && x !== null && "backgroundColor" in x && typeof x.backgroundColor === "string" && "via" in x && (x.via === "ancestor" || x.via === "child")
    && "tag" in x && typeof x.tag === "string" && "depth" in x && typeof x.depth === "number" && (!("dt" in x) || typeof x.dt === "string");
}

/** The matching-strategy census written to measured.matchedByCensus. */
export interface MatchCensus { tag: number; sharedPath: number; tagAlias: number; text: number; textOrdinal: number; position: number; frame: number; notMeasured: number }
export function census(nodes: Array<Pick<MeasuredNode, "matchedBy">>, notMeasured: unknown[]): MatchCensus {
  const c: MatchCensus = { tag: 0, sharedPath: 0, tagAlias: 0, text: 0, textOrdinal: 0, position: 0, frame: 0, notMeasured: notMeasured.length };
  const KEY: Record<MatchedBy, keyof MatchCensus> = { tag: "tag", "tag-shared-path": "sharedPath", "tag-alias": "tagAlias", text: "text", "text-ordinal": "textOrdinal", position: "position", frame: "frame" };
  const isMatchedBy = (v: string | undefined): v is MatchedBy => v !== undefined && Object.hasOwn(KEY, v);
  for (const n of nodes) if (isMatchedBy(n.matchedBy)) c[KEY[n.matchedBy]]++;
  return c;
}
