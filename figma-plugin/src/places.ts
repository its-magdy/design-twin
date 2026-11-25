// Where a createTree lands (docs/write-plane-spec.md decision 13): its page, the section on it, and the ones it asks to
// make (bridge/src/place-spec.ts is the pure half: the fields, their check, the words).
//
// Resolved with the rest of the batch, before anything runs (resolveDests): a page by exact name or id (the current one
// by default), a section on that page (nested ones too) the same way — and a section given by id with no page is found
// wherever it is, its page then the op's (as every other id of a write is found on any page). A name that matches several is refused with their
// ids; one that matches nothing is refused with the closest names — unless the batch asks to make it (`createPage`,
// `createSection`), and then it is made once for the whole batch: every op of the batch naming that page (or that
// section on that page) lands in the one made, whether or not it asked. A batch makes at most MAX_NEW_PAGES pages and
// MAX_NEW_SECTIONS sections.
//
// Made when the first op that lands there runs (makeDest), as Changes on the batch's list: a failure later in the
// batch removes them again, newest first, after the frames in them — and never with a layer in them that the batch did
// not make (that one stays, and the reply says so). A page that is the current one when it goes is left first.
//
// Placed (land): on a page, right of everything on it, top-aligned (tree.ts did this before). In a section, the frame's
// x/y are the section's own (as Figma reads a section child's): beside what it holds — right of it, top-aligned, or on
// a new row below when growing right would run the section into one of its neighbours — at SECTION_PAD from its edges
// when it is empty. The section then grows (never shrinks) to hold the frame with that margin, and so does each section
// around it; the growth is put back with the frame (each side still the size it grew to: one the designer resized
// since keeps theirs, and the reply says so). A section that still runs into a neighbour is said in a warning,
// as is a frame whose given coordinates put it past its section's left or top edge (kept there; a section grows only
// right and down). Every box here is what a layer covers on the canvas, rotation included: the layers there by their
// absoluteBoundingBox (occupied), the frame placed by its footprint (its size through its relativeTransform; a copy
// keeps its source's turn), its computed x/y a whole pixel that stays clear of what it was placed beside.
//
// Every rule runs on a Canvas (what each page and section holds, each section's box), so the review card's Show me
// (landing) places by the write's own code: the write reads a fresh one for each node it lands, without the node itself
// (built hidden where Figma made it); the review plans the whole batch on one, op by op, so a later op is shown where it
// will land beside the earlier ones — the trees they land, and what they resize (a keyed re-send, a patch's box), move or
// make (a legacy createFrame) on a page or in a section. A legacy createText is not counted (its size is its font's,
// known only once built), nor a delete (deletes run after every other op).
//
// Plugin API facts this leans on (@figma/plugin-typings):
//   * figma.createPage appends a new page to the document; a file in a Starter-plan team stops at 3 pages (drafts
//     do not) and it throws then.
//   * figma.createSection makes a SECTION on the current page; appendChild moves it. A section is sized with
//     resizeWithoutConstraints (≥ 0.01 a side), and does not grow by itself when a plugin appends to it.
//   * Under documentAccess "dynamic-page" a page is loaded (loadAsync) before its children are read.
import { builtSize, type TreeNodeSpec } from "../../bridge/src/tree-spec.ts";
import type { WriteOp } from "../../bridge/src/commands.ts";
import { matchByName, quoteList } from "../../bridge/src/name-match.ts";
import { idLike, MAX_NEW_PAGES, MAX_NEW_SECTIONS, nodeIdLike, SECTION_PAD } from "../../bridge/src/place-spec.ts";
import { newRestorePass, RestoreStopped, type Change, type OpProblem, type RestorePass } from "./write-batch";
import { inDocument, nodeById, noNode } from "./node-lookup";

/** How far right of the rightmost existing frame a placed tree lands (Figma's usual gap between screens). */
export const PLACE_GAP = 100;

/** A page an op lands on: one the file has (`node`), or one the batch makes (`node` null until it is made). One object
 *  per page across the batch, so every op naming it shares what is made. */
export interface PageDest { name: string; node: PageNode | null; make: boolean; current: boolean }
/** A section an op lands in, on `page`: one the page has, or one the batch makes. One object per section. */
export interface SectionDest { name: string; node: SectionNode | null; make: boolean; page: PageDest }
export interface Dest { page: PageDest; section: SectionDest | null }

const label = (n: BaseNode): string => "'" + n.name + "' (" + n.id + ")";
const pageWords = (p: PageDest): string => (p.current ? "the current page '" + p.name + "'" : "page '" + p.name + "'");

/** What `dest` holds of the file (its page and section, found or made already) that is no longer in the document
 *  (node-lookup.ts): the error its lookup would have given, or null. */
export function destGone(dest: Dest): string | null {
  const p = dest.page.node, s = dest.section ? dest.section.node : null;
  if (p && !inDocument(p)) return noNode(p.id, "page");
  if (s && !inDocument(s)) return noNode(s.id, "section");
  return null;
}

/** `consent` for a build that lands in `dest` and holds it across its awaits (node-lookup.ts holding): each call checks
 *  its page and section are still in the document (destGone throws as missing), then consent. */
export function holdingDest(dest: Dest, consent: () => void): () => void {
  return () => {
    const gone = destGone(dest);
    if (gone !== null) throw new Error(gone);
    consent();
  };
}

/**
 * Where each createTree op of the batch lands, by op index, and every problem with it. Existing pages that an op lands
 * on are loaded. Nothing is made here.
 */
export async function resolveDests(ops: readonly WriteOp[]): Promise<{ dests: Map<number, Dest>; problems: OpProblem[] }> {
  const problems: OpProblem[] = [];
  const dests = new Map<number, Dest>();
  const pages = new Map<PageNode, PageDest>();
  const newPages = new Map<string, PageDest>();
  const pageOf = (p: PageNode): PageDest => {
    let d = pages.get(p);
    if (!d) { d = { name: p.name, node: p, make: false, current: p === figma.currentPage }; pages.set(p, d); }
    return d;
  };
  const trees = [...ops.entries()].filter(([, op]) => op.op === "createTree");
  // The pages to make: a name an op asks to make that the file has none of (one it has several of is refused below).
  // Past the limit, each name is said once, counted in turn; `overPages` holds them, and the op that said it.
  const overPages = new Map<string, number>();
  for (const [index, op] of trees) {
    if (op.createPage !== true || op.page === undefined || newPages.has(op.page) || overPages.has(op.page)) continue;
    if (matchByName(op.page, figma.root.children, (p) => p.name, (p) => [p.id]).kind !== "none") continue;
    if (newPages.size >= MAX_NEW_PAGES) {
      overPages.set(op.page, index);
      problems.push({ index, op: op.op, message: "the batch makes " + (newPages.size + overPages.size) + " pages; one batch makes at most " + MAX_NEW_PAGES + " (send the rest in another)" });
      continue;
    }
    newPages.set(op.page, { name: op.page, node: null, make: true, current: false });
  }
  const pageFor = new Map<number, PageDest>();
  for (const [index, op] of trees) {
    const bad = (message: string): void => { problems.push({ index, op: op.op, message }); };
    if (op.page === undefined) {
      // A section by id needs no page: the one that holds it (an id names one node of the whole file).
      const s = op.section !== undefined ? await sectionById(op.section) : null;
      const on = s ? pageHolding(s) : null;
      pageFor.set(index, pageOf(on || figma.currentPage));
      continue;
    }
    const m = matchByName(op.page, figma.root.children, (p) => p.name, (p) => [p.id]);
    if (m.kind === "one") { pageFor.set(index, pageOf(m.item)); continue; }
    if (m.kind === "many") { bad("page '" + op.page + "' matches " + m.matches.length + " pages — pass one's id: " + m.matches.slice(0, 3).map(label).join(", ")); continue; }
    const planned = newPages.get(op.page);
    if (planned) { pageFor.set(index, planned); continue; }
    // Past the limit: said above for the op that asked; another op naming it is not told to ask too.
    const over = overPages.get(op.page);
    if (over !== undefined) { if (over !== index) bad("page '" + op.page + "' matches no page in this file, and the batch already makes the most pages one batch may (" + MAX_NEW_PAGES + "); send the ops for it in another batch"); continue; }
    // An id in any form is never made (the wire check refuses one to make): what it is the id of instead.
    if (idLike(op.page)) { bad("page '" + op.page + "' matches no page in this file; " + await pageIdIs(op.page)); continue; }
    // At the limit, the flag would put it past it: the way to make it is another batch.
    const make = newPages.size >= MAX_NEW_PAGES
      ? "; the batch already makes the most pages one batch may (" + MAX_NEW_PAGES + "): to make it, send it with `createPage: true` in another batch"
      : "; to make it, add `createPage: true`";
    bad("page '" + op.page + "' matches no page in this file" + (m.candidates.length ? "; closest: " + quoteList(m.candidates) : "") + make);
  }
  // Every page an op lands on, loaded (dynamic-page) before its sections are read or anything is appended to it. One
  // deleted while an earlier one loaded is not loaded (its fields throw), and one deleted as it loads is not asked to
  // be: both are missing, below.
  for (const d of pages.values()) {
    if (!d.node || !inDocument(d.node)) continue;
    try { await d.node.loadAsync(); } catch (e) { if (inDocument(d.node)) throw e; }
  }
  // Held across those loads (node-lookup.ts): a page deleted meanwhile is missing, never read.
  for (const [index, page] of pageFor) {
    if (!page.node || inDocument(page.node)) continue;
    problems.push({ index, op: "createTree", message: noNode(page.node.id, "page") });
    pageFor.delete(index);
  }
  // The sections on each page, read once.
  const sectionsOn = new Map<PageDest, SectionNode[]>();
  const sectionsOf = (p: PageDest): SectionNode[] => {
    let list = sectionsOn.get(p);
    if (!list) { list = p.node ? p.node.findAllWithCriteria({ types: ["SECTION"] }) : []; sectionsOn.set(p, list); }
    return list;
  };
  const existing = new Map<SectionNode, SectionDest>();
  const sectionOf = (s: SectionNode, page: PageDest): SectionDest => {
    let d = existing.get(s);
    if (!d) { d = { name: s.name, node: s, make: false, page }; existing.set(s, d); }
    return d;
  };
  // The sections to make, per page: a name an op asks to make that its page has none of.
  const newSections = new Map<PageDest, Map<string, SectionDest>>();
  // Past the limit, per page as above: each name said once, counted in turn, by the op that said it.
  const overSections = new Map<PageDest, Map<string, number>>();
  let madeSections = 0, overCount = 0;
  for (const [index, op] of trees) {
    const page = pageFor.get(index);
    if (!page || op.createSection !== true || op.section === undefined) continue;
    const planned = newSections.get(page) || new Map<string, SectionDest>();
    const over = overSections.get(page) || new Map<string, number>();
    if (planned.has(op.section) || over.has(op.section)) continue;
    if (matchByName(op.section, sectionsOf(page), (s) => s.name, (s) => [s.id]).kind !== "none") continue;
    if (madeSections >= MAX_NEW_SECTIONS) {
      over.set(op.section, index);
      overSections.set(page, over);
      overCount++;
      problems.push({ index, op: op.op, message: "the batch makes " + (madeSections + overCount) + " sections; one batch makes at most " + MAX_NEW_SECTIONS + " (send the rest in another)" });
      continue;
    }
    planned.set(op.section, { name: op.section, node: null, make: true, page });
    newSections.set(page, planned);
    madeSections++;
  }
  for (const [index, op] of trees) {
    const page = pageFor.get(index);
    if (!page) continue;
    if (op.section === undefined) { dests.set(index, { page, section: null }); continue; }
    const bad = (message: string): void => { problems.push({ index, op: op.op, message }); };
    const m = matchByName(op.section, sectionsOf(page), (s) => s.name, (s) => [s.id]);
    if (m.kind === "one") { dests.set(index, { page, section: sectionOf(m.item, page) }); continue; }
    if (m.kind === "many") { bad("section '" + op.section + "' matches " + m.matches.length + " sections on " + pageWords(page) + " — pass one's id: " + m.matches.slice(0, 3).map(label).join(", ")); continue; }
    const planned = newSections.get(page);
    const made = planned ? planned.get(op.section) : undefined;
    if (made) { dests.set(index, { page, section: made }); continue; }
    const miss = "section '" + op.section + "' matches no section on " + pageWords(page);
    const pastLimit = overSections.get(page);
    const over = pastLimit ? pastLimit.get(op.section) : undefined;
    if (over !== undefined) { if (over !== index) bad(miss + ", and the batch already makes the most sections one batch may (" + MAX_NEW_SECTIONS + "); send the ops for it in another batch"); continue; }
    // An id is never made (the wire check refuses one to make): what it is the id of instead.
    if (nodeIdLike(op.section)) { bad(miss + "; " + await idIs(op.section)); continue; }
    // So is any other id form (a link's 6-2): looked up as a name, as above, and said as the id it looks like.
    if (idLike(op.section)) { bad(miss + "; " + await linkIdIs(op.section, page, op.page !== undefined)); continue; }
    const make = madeSections >= MAX_NEW_SECTIONS
      ? "; the batch already makes the most sections one batch may (" + MAX_NEW_SECTIONS + "): to make it, send it with `createSection: true` in another batch"
      : "; to make it, add `createSection: true`";
    bad(miss + (m.candidates.length ? "; closest: " + quoteList(m.candidates) : "") + make);
  }
  return { dests, problems };
}

/** What `ref` (an id-like page, in any form, that is no page's id) is the id of, as the refusal says it: a link's form
 *  (`0-1`) with its colon form to send when that is a page's. */
async function pageIdIs(ref: string): Promise<string> {
  const colon = ref.replace(/-/g, ":");
  const looks = colon === ref ? "it looks like a node id" : "it looks like a node id as a link writes it";
  let n: BaseNode | null = null;
  try { n = await nodeById(colon); } catch { n = null; }
  if (!n) return looks + ", and no layer of this file has " + (colon === ref ? "it" : "the id '" + colon + "'");
  if (n.type === "PAGE") return looks + ": page '" + n.name + "' is '" + colon + "' — send `page: '" + colon + "'`";
  return looks + ": '" + colon + "' is the id of '" + n.name + "' (" + n.type + "), not of a page";
}

/** What `ref` (an id-like section that is not on the op's page) is the id of, as the refusal says it. */
async function idIs(ref: string): Promise<string> {
  let n: BaseNode | null = null;
  try { n = await nodeById(ref); } catch { n = null; }
  if (!n) return "it looks like a node id, and no layer of this file has it";
  if (n.type !== "SECTION") return "it is the id of '" + n.name + "' (" + n.type + "), not of a section";
  const on = pageHolding(n);
  return "it is the id of section '" + n.name + "'" + (on ? " on page '" + on.name + "'" : "") + " — leave `page` out, or name that page";
}

/** What `ref` (an id-like section in another form than `12:34`: a link's `6-2`, an instance layer's) is the id of, as
 *  the refusal says it: with its colon form to send when it is a section's (and `page` to leave out when the op names
 *  another than the section's). An instance layer's id already in its colon form is said as idIs says it. */
async function linkIdIs(ref: string, page: PageDest, pageNamed: boolean): Promise<string> {
  const colon = ref.replace(/-/g, ":");
  if (colon === ref) return idIs(ref);
  const looks = "it looks like a node id as a link writes it";
  let n: BaseNode | null = null;
  try { n = await nodeById(colon); } catch { n = null; }
  if (!n) return looks + ", and no layer of this file has the id '" + colon + "'";
  if (n.type !== "SECTION") return looks + ": '" + colon + "' is the id of '" + n.name + "' (" + n.type + "), not of a section";
  const on = pageHolding(n);
  const away = pageNamed && on && on !== page.node ? on : null;
  return looks + ": section '" + n.name + "' is '" + colon + "' — send `section: '" + colon + "'`" + (away ? " and leave `page` out, or name page '" + away.name + "'" : "");
}

/** The section whose id is `ref` (on any page), or null: `ref` is no id, or not a section's. */
async function sectionById(ref: string): Promise<SectionNode | null> {
  if (!nodeIdLike(ref)) return null;
  let n: BaseNode | null = null;
  try { n = await nodeById(ref); } catch { n = null; }
  return n && n.type === "SECTION" ? n : null;
}

/** What a node covers in its parent's coordinates, rotation included: its canvas box (absoluteBoundingBox, page
 *  coordinates) less its parent's origin — a page's is 0,0, a section's its own canvas box (a section does not
 *  rotate). Its x/y/size when Figma gives no canvas box. */
function occupied(c: SceneNode): Box {
  const b = "absoluteBoundingBox" in c ? c.absoluteBoundingBox : null;
  const p = c.parent;
  const origin = !p ? null : p.type === "PAGE" ? { x: 0, y: 0 } : "absoluteBoundingBox" in p ? p.absoluteBoundingBox : null;
  return b && origin ? { x: b.x - origin.x, y: b.y - origin.y, width: b.width, height: b.height } : { x: c.x, y: c.y, width: c.width, height: c.height };
}
interface Box { x: number; y: number; width: number; height: number }
interface XY { x: number; y: number }
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** What a node will cover on the canvas, from its own x/y: the box `dx`, `dy` from it, `width`×`height` — its size
 *  through its turn (rotation, flip, skew), as Figma's absoluteBoundingBox measures it wherever it is put (a page or a
 *  section does not turn). Unturned, it is the node's own box. */
export interface Footprint { dx: number; dy: number; width: number; height: number }
/** The footprint of a `w`×`h` node turned as `turned` is (its relativeTransform; none: unturned). To a hundredth of a
 *  pixel, so a turn by a right angle covers whole pixels. */
export function footprint(w: number, h: number, turned?: BaseNode | null): Footprint {
  const t = turned && "relativeTransform" in turned ? turned.relativeTransform : null;
  if (!Array.isArray(t)) return { dx: 0, dy: 0, width: w, height: h };
  const [[a, c], [b, d]] = t;
  const xs = [0, a * w, c * h, a * w + c * h];
  const ys = [0, b * w, d * h, b * w + d * h];
  const hundredth = (v: number): number => Math.round(v * 100) / 100;
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  return { dx: hundredth(x0), dy: hundredth(y0), width: hundredth(Math.max(...xs) - x0), height: hundredth(Math.max(...ys) - y0) };
}
type At = { x?: number | undefined; y?: number | undefined };
/** The spec's own x/y as where the node's footprint will start. */
const wanted = (spec: At, fp: Footprint): At => ({ x: spec.x !== undefined ? spec.x + fp.dx : undefined, y: spec.y !== undefined ? spec.y + fp.dy : undefined });
/** A computed coordinate's choices, best first: the nearer whole pixel, the other one, then itself. */
function wholePixels(v: number): number[] {
  const near = Math.round(v);
  return near === v ? [v] : [near, near > v ? Math.floor(v) : Math.ceil(v), v];
}
/** The node's x/y for its footprint at `box` (a spot clear of every box in `held`): the spec's own where it gives them,
 *  as given; the rest a whole pixel — the nearer, unless that puts what it covers on one of `held` (rounding never
 *  moves it onto a layer the spot was chosen clear of) or before `floor` (a section's margin: rounding never starts it
 *  inside), then the other, else unrounded. */
function anchored(spec: At, box: XY, fp: Footprint, held: readonly Box[], floor = -Infinity): XY {
  // A choice whose cover starts before the floor (where the spot itself does not) is no choice; the unrounded one,
  // last in the list, always starts where the spot does.
  const clear = (vs: number[], d: number, at: number): number[] => vs.filter((v) => v + d >= Math.min(floor, at) - 1e-6);
  const xs = spec.x !== undefined ? [spec.x] : clear(wholePixels(box.x - fp.dx), fp.dx, box.x);
  const ys = spec.y !== undefined ? [spec.y] : clear(wholePixels(box.y - fp.dy), fp.dy, box.y);
  for (const x of xs) {
    for (const y of ys) {
      const covers = { x: x + fp.dx, y: y + fp.dy, width: fp.width, height: fp.height };
      if (!held.some((b) => overlaps(covers, b))) return { x, y };
    }
  }
  const first = (vs: number[], none: number): number => (vs.length && vs[0] !== undefined ? vs[0] : none);
  return { x: first(xs, Math.round(box.x - fp.dx)), y: first(ys, Math.round(box.y - fp.dy)) };
}

/**
 * Where a box of `w`×`h` goes among `held` (boxes in the same coordinates), by `at` — `pad` in from the edges when
 * nothing is held. Neither given: right of everything held, level with the topmost. Only `y`: right of everything held,
 * at that `y`. Only `x`: at that `x`, level with the topmost when that overlaps nothing, else below everything held in
 * its column. Only the given coordinates are kept; the other never lands on a layer, and is never less than `floor`
 * (in a section its margin: a layer that overhangs its left or top edge does not pull a new frame out with it).
 */
function besideHeld(held: readonly Box[], at: At, w: number, h: number, pad: number, floor = -Infinity): XY {
  if (!held.length) return { x: at.x !== undefined ? at.x : pad, y: at.y !== undefined ? at.y : pad };
  const top = Math.max(floor, Math.min(...held.map((b) => b.y)));
  if (at.x === undefined) return { x: Math.max(floor, Math.max(...held.map((b) => b.x + b.width)) + PLACE_GAP), y: at.y !== undefined ? at.y : top };
  const x = at.x;
  if (at.y !== undefined) return { x, y: at.y };
  if (!held.some((b) => overlaps({ x, y: top, width: w, height: h }, b))) return { x, y: top };
  const column = held.filter((b) => b.x < x + w && x < b.x + b.width);
  return { x, y: Math.max(floor, Math.max(...column.map((b) => b.y + b.height)) + PLACE_GAP) };
}

/** A box grown to `needW`×`needH` from its top-left (never shrunk); null when it already holds that. */
function grownBox(box: Box, needW: number, needH: number): Box | null {
  const w = Math.max(box.width, Math.ceil(needW));
  const h = Math.max(box.height, Math.ceil(needH));
  return w === box.width && h === box.height ? null : { x: box.x, y: box.y, width: w, height: h };
}

/** The warning when what a node covers in a section starts at `start` (the section's coordinates) left of or above its
 *  edge — only given coordinates put it there; they are kept, and a section grows only right and down — or null. */
function stickingOut(name: string, section: string, start: XY): string | null {
  const left = start.x < 0, top = start.y < 0;
  if (!left && !top) return null;
  const edges = left && top ? "left and top edges" : left ? "left edge" : "top edge";
  return "'" + name + "' sticks out past the " + edges + " of section '" + section + "': what it covers starts at " + start.x + ", " + start.y + " in it, and a section grows only right and down to hold its frames";
}

/** A layer as placing sees it: its id ("" for one the plan puts there that the file does not have yet), and what it
 *  covers in its holder's coordinates. A section's is its holder's own box. */
interface Item { id: string; name: string; box: Box }
/** A page or section as placing sees it: its box in its parent's coordinates (a page's is unused), the layers it holds
 *  (read off the file when first needed, then what the plan put in it), and the holder it is in. `node` null: a section
 *  the batch is still to make (only a plan has one: the write makes the section before it places in it). */
interface Holder { node: PageNode | SectionNode | null; section: boolean; name: string; box: Box; parent: Holder | null; items: Item[] | null }
/** Where a node is to land and what that does: its x/y in its holder, the sections it grows (innermost first, each to
 *  `width`×`height`), and the warnings to give. */
export interface Placed { holder: Holder; x: number; y: number; fp: Footprint; name: string; grows: Array<{ holder: Holder; width: number; height: number }>; warnings: string[] }

/**
 * The canvas as placing reads it: what each page and section holds, and each section's box. Every placing rule runs on
 * it, so the write and the review card's Show me place by the same code. The write reads a fresh one off the file each
 * time it lands a node (land) or makes a section (makeDest). The review card keeps one for the whole batch and plans each
 * op on it in order (commit), so a later op is placed beside what the earlier ones will land and in the sections they
 * make or grow, as the write will place it.
 */
export class Canvas {
  private readonly holders = new Map<object, Holder>();
  /** A node to leave out wherever it is (the node being placed: hidden where Figma made it until it lands). */
  private readonly skip: string;
  constructor(skip = "") { this.skip = skip; }

  /** The holder of a page or section of the file. */
  private of(n: PageNode | SectionNode): Holder {
    let h = this.holders.get(n);
    if (h) return h;
    h = { node: n, section: n.type === "SECTION", name: n.name, box: n.type === "SECTION" ? occupied(n) : { x: 0, y: 0, width: 0, height: 0 }, parent: null, items: null };
    this.holders.set(n, h);
    const p = n.type === "SECTION" ? n.parent : null;
    if (p && (p.type === "PAGE" || p.type === "SECTION")) h.parent = this.of(p);
    return h;
  }
  /** What `h` holds: its node's children but `skip`, read once (a section by its holder's box, so its growth shows). */
  private itemsOf(h: Holder): Item[] {
    if (h.items) return h.items;
    const items: Item[] = [];
    if (h.node) for (const c of h.node.children) if (c.id !== this.skip) items.push({ id: c.id, name: c.name, box: c.type === "SECTION" ? this.of(c).box : occupied(c) });
    h.items = items;
    return items;
  }
  /** Where `dest` lands: its section, else its page; a section still to make is put where makeDest will make it, and
   *  holds nothing. Null on a page still to make. */
  private holderFor(dest: Dest): Holder | null {
    const page = dest.page.node;
    if (!page) return null;
    const s = dest.section;
    if (!s) return this.of(page);
    if (s.node) return this.of(s.node);
    const planned = this.holders.get(s);
    if (planned) return planned;
    const on = this.of(page);
    const at = this.sectionAt(page);
    const h: Holder = { node: null, section: true, name: s.name, box: { x: at.x, y: at.y, width: NEW_SECTION, height: NEW_SECTION }, parent: on, items: [] };
    this.holders.set(s, h);
    this.itemsOf(on).push({ id: "", name: s.name, box: h.box });
    return h;
  }

  /** Where a section the batch makes goes on `page`: beside what the page holds, as a new frame does (it is made
   *  NEW_SECTION a side and grows to hold the frames placed in it). */
  sectionAt(page: PageNode): XY {
    return this.onPage(this.of(page), {}, footprint(NEW_SECTION, NEW_SECTION));
  }

  /** Where a top-level node covering `fp` lands on a page (its x/y): the spec's own x/y, the rest so what it covers is
   *  beside what is on the page (besideHeld). */
  private onPage(h: Holder, spec: At, fp: Footprint): XY {
    if (spec.x !== undefined && spec.y !== undefined) return { x: spec.x, y: spec.y };
    const held = this.itemsOf(h).map((i) => i.box);
    return anchored(spec, besideHeld(held, wanted(spec, fp), fp.width, fp.height, 0), fp, held);
  }
  /** Where a node covering `fp` lands in a section (its x/y, in the section's coordinates), by the spec's x/y and what
   *  the section holds: with neither, beside what it holds, or on a new row below when that would run the section into
   *  a neighbour; with one, as besideHeld says. What it covers starts at the section's margin at least, on each side the
   *  spec does not give (a row starts at the leftmost layer's edge, or at the margin when that is further left). */
  private inSection(h: Holder, spec: At, fp: Footprint): XY {
    if (spec.x !== undefined && spec.y !== undefined) return { x: spec.x, y: spec.y };
    const held = this.itemsOf(h).map((i) => i.box);
    const w = fp.width, ht = fp.height;
    if (!held.length || spec.x !== undefined || spec.y !== undefined) return anchored(spec, besideHeld(held, wanted(spec, fp), w, ht, SECTION_PAD, SECTION_PAD), fp, held, SECTION_PAD);
    const beside = besideHeld(held, {}, w, ht, SECTION_PAD, SECTION_PAD);
    if (!this.runsInto(h, beside, w, ht)) return anchored(spec, beside, fp, held, SECTION_PAD);
    const below = { x: Math.max(SECTION_PAD, Math.min(...held.map((b) => b.x))), y: Math.max(SECTION_PAD, Math.max(...held.map((b) => b.y + b.height)) + PLACE_GAP) };
    return anchored(spec, this.runsInto(h, below, w, ht) ? beside : below, fp, held, SECTION_PAD);
  }
  /** Whether section `h`, grown to hold a box of `w`×`ht` at `at`, would run into one of its neighbours. */
  private runsInto(h: Holder, at: XY, w: number, ht: number): boolean {
    const grown = grownBox(h.box, at.x + w + SECTION_PAD, at.y + ht + SECTION_PAD);
    return !!grown && this.neighbourHit(h, grown) !== null;
  }
  /** The first of section `h`'s neighbours (what its holder holds besides it) that `box` runs into and its own box did
   *  not. */
  private neighbourHit(h: Holder, box: Box): Item | null {
    if (!h.parent) return null;
    for (const c of this.itemsOf(h.parent)) if (c.box !== h.box && overlaps(box, c.box) && !overlaps(h.box, c.box)) return c;
    return null;
  }

  /** Where a node named `name`, covering `fp`, lands by `spec`'s x/y in what `dest` names (null on a page still to
   *  make), and what that does: in a section, the section and each one around it grow to hold it with their margin
   *  (innermost first); one that then runs into a neighbour, and what it covers starting past the section's left or top
   *  edge, are warnings. Nothing changes (but a section still to make, put on the canvas where makeDest will make it). */
  place(dest: Dest, spec: At, fp: Footprint, name: string): Placed | null {
    const h = this.holderFor(dest);
    if (!h) return null;
    const at = h.section ? this.inSection(h, spec, fp) : this.onPage(h, spec, fp);
    const placed: Placed = { holder: h, x: at.x, y: at.y, fp, name, grows: [], warnings: [] };
    if (!h.section) return placed;
    const out = stickingOut(name, h.name, { x: at.x + fp.dx, y: at.y + fp.dy });
    if (out) placed.warnings.push(out);
    // The right and bottom edges of what each section must hold: the node's footprint, then each section in turn.
    let right = at.x + fp.dx + fp.width;
    let bottom = at.y + fp.dy + fp.height;
    for (let s: Holder | null = h; s && s.section; s = s.parent) {
      const box = grownBox(s.box, right + SECTION_PAD, bottom + SECTION_PAD);
      if (box) {
        const hit = this.neighbourHit(s, box);
        placed.grows.push({ holder: s, width: box.width, height: box.height });
        if (hit) placed.warnings.push("section '" + s.name + "' grew to " + box.width + "×" + box.height + " to hold '" + name + "' and now overlaps '" + hit.name + "'");
      }
      const b = box || s.box;
      right = b.x + b.width;
      bottom = b.y + b.height;
    }
    return placed;
  }
  /** Put a placed node on the canvas, and grow the sections it grows: what the next op is placed beside. */
  commit(p: Placed): void {
    this.itemsOf(p.holder).push({ id: "", name: p.name, box: { x: p.x + p.fp.dx, y: p.y + p.fp.dy, width: p.fp.width, height: p.fp.height } });
    for (const g of p.grows) { g.holder.box.width = g.width; g.holder.box.height = g.height; }
  }

  // What the other ops of a batch change on the canvas, so the review plans a later op beside it (the write reads the
  // file each time, as the ops before it left it). A node's x/y are its parent's own: Figma keeps them when it moves.
  /** Where layer `n` is on this canvas: the holder a plan moved it to (null: into neither a page nor a section), else
   *  its parent's in the file (null when that is neither). */
  private readonly moved = new Map<string, Holder | null>();
  private holderOfNode(n: SceneNode): Holder | null {
    if (this.moved.has(n.id)) return this.moved.get(n.id) || null;
    const p = n.parent;
    return p && (p.type === "PAGE" || p.type === "SECTION") ? this.of(p) : null;
  }
  /** What `n` covers at `x`, `y` in its holder, `w`×`h` turned as it is (a section: its holder's box, at x/y). */
  private itemFor(n: SceneNode, x: number, y: number, w: number, h: number): Item {
    if (n.type === "SECTION") { const b = this.of(n).box; b.x = x; b.y = y; b.width = w; b.height = h; return { id: n.id, name: n.name, box: b }; }
    const fp = footprint(w, h, n);
    return { id: n.id, name: n.name, box: { x: x + fp.dx, y: y + fp.dy, width: fp.width, height: fp.height } };
  }
  /** Each layer's x/y and size as the plan last set them (reshape), by id. */
  private readonly shaped = new Map<string, { x: number; y: number; w: number; h: number }>();
  /** Layer `n`'s x/y and size on this canvas: as an earlier op of the plan set them (reshape), else the file's — so a
   *  later op that sets only one side (a patch's `box: {h}`) keeps the other as the earlier op left it. */
  geometry(n: SceneNode): { x: number; y: number; w: number; h: number } {
    return this.shaped.get(n.id) || { x: n.x, y: n.y, w: n.width, h: n.height };
  }
  /** Layer `n` of the file (a keyed re-send's root, a patched layer) now at `x`, `y` in its holder and `w`×`h`; nothing
   *  more when it is in neither a page nor a section (what it is in keeps its box). */
  reshape(n: SceneNode, x: number, y: number, w: number, h: number): void {
    this.shaped.set(n.id, { x, y, w, h });
    const holder = this.holderOfNode(n);
    if (!holder) return;
    const items = this.itemsOf(holder);
    const i = items.findIndex((it) => it.id === n.id);
    if (i >= 0) items[i] = this.itemFor(n, x, y, w, h);
  }
  /** Layer `n` of the file moved into `to` (at its own x/y and size, which a move keeps): off the page or section it was
   *  in, onto `to` when that is a page or section. */
  move(n: SceneNode, to: BaseNode): void {
    const from = this.holderOfNode(n);
    let item: Item | null = null;
    if (from) {
      const items = this.itemsOf(from);
      const i = items.findIndex((it) => it.id === n.id);
      if (i >= 0) item = items.splice(i, 1)[0] || null;
    }
    const into = to.type === "PAGE" || to.type === "SECTION" ? this.of(to) : null;
    this.moved.set(n.id, into);
    if (n.type === "SECTION") this.of(n).parent = into;
    if (!into) return;
    // What it covers keeps its place in its parent's coordinates (a section's box is its holder's).
    const g = this.geometry(n);
    this.itemsOf(into).push(item ? { id: n.id, name: n.name, box: item.box } : this.itemFor(n, g.x, g.y, g.w, g.h));
  }
  /** A layer the batch makes in `parent` (a legacy createFrame), covering `box` there; nothing unless `parent` is a page
   *  or a section. */
  add(parent: BaseNode, name: string, box: Box): void {
    if (parent.type === "PAGE" || parent.type === "SECTION") this.itemsOf(this.of(parent)).push({ id: "", name, box });
  }
  /** Where the origin of `h` (a page or section) is on its page. */
  originOf(h: Holder): XY {
    let x = 0, y = 0;
    for (let s: Holder | null = h; s && s.section; s = s.parent) { x += s.box.x; y += s.box.y; }
    return { x, y };
  }
}

/** What landing a node did: how to take back the growth of the sections around it, and what it ran into. `undo` puts
 *  back each side a section grew that is still the size landing gave it; a side resized since (the designer's, while a
 *  preview was up or the batch awaited) is left as it is, and said: one sentence per section, for the batch's reply.
 *  It is recorded on `pass` (the batch's put-back), so an older growth of the same side leaves it too, unsaid. */
export interface Landed {
  undo(pass?: RestorePass): string[];
  /** What of its growth is still in the file, said, for a node gone without its put-back (write-batch.ts Change.leaves):
   *  each section side it grew that is still the size it gave it (one the designer resized since is theirs). */
  left(): string[];
  warnings: string[];
}

/**
 * Attach `root` (built to the side, sized) where `dest` says, placed (Canvas.place, on the file as it is now): on its
 * page beside what is there, or in its section beside what it holds, the section and those around it grown to hold it.
 * The page and the section must have been made (makeDest). Throws when Figma refuses; what it grew before that is put
 * back.
 */
export function land(root: SceneNode, dest: Dest, spec: Pick<TreeNodeSpec, "x" | "y">): Landed {
  const page = dest.page.node;
  if (!page) throw new Error("the page '" + dest.page.name + "' was not made before the batch built on it");
  const section = dest.section ? dest.section.node : null;
  if (dest.section && !section) throw new Error("the section '" + dest.section.name + "' was not made before the batch built in it");
  // What it will cover: its size through its turn (a copy keeps its source's rotation), as the layers it goes beside
  // are measured (occupied).
  const placed = new Canvas(root.id).place(dest, spec, footprint(root.width, root.height, root), root.name);
  if (!placed) throw new Error("the page '" + dest.page.name + "' was not made before the batch built on it");
  (section || page).appendChild(root);
  root.x = placed.x;
  root.y = placed.y;
  // Each section around the node grows to hold what is in it, with its margin: the one it is in, then outwards.
  const grown: Array<{ s: SectionNode; w: number; h: number; toW: number; toH: number }> = [];
  const undo = (pass: RestorePass = newRestorePass()): string[] => {
    const kept: string[] = [];
    for (const g of grown.slice().reverse()) {
      if (g.s.removed) continue;
      // A side it grew goes back only while it is still the size landing gave it — and not at all once a newer growth
      // of the same put-back found it resized (its size may then be this one's by chance: the designer's all the same).
      const held = pass.kept.get(g.s) || new Set<string>();
      const heldW = held.has("width"), heldH = held.has("height");
      const keepW = g.toW !== g.w && !heldW && !near(g.s.width, g.toW), keepH = g.toH !== g.h && !heldH && !near(g.s.height, g.toH);
      const w = keepW || heldW || g.toW === g.w ? g.s.width : g.w, h = keepH || heldH || g.toH === g.h ? g.s.height : g.h;
      if (!near(w, g.s.width) || !near(h, g.s.height)) g.s.resizeWithoutConstraints(w, h);
      if (keepW) held.add("width");
      if (keepH) held.add("height");
      if (held.size) pass.kept.set(g.s, held);
      if (keepW || keepH) {
        kept.push("the section " + label(g.s) + " was resized after this batch grew it to " + g.toW + "×" + g.toH + ", so it keeps its " +
          (keepW && keepH ? "size, " + g.s.width + "×" + g.s.height : keepW ? "width, " + g.s.width : "height, " + g.s.height));
      }
    }
    return kept;
  };
  try {
    for (const g of placed.grows) {
      const s = g.holder.node;
      if (!s || s.type !== "SECTION") continue;
      grown.push({ s, w: s.width, h: s.height, toW: g.width, toH: g.height });
      s.resizeWithoutConstraints(g.width, g.height);
    }
  } catch (e) {
    try { undo(); } catch { /* the growth that was made is what Figma refused */ }
    throw e;
  }
  const left = (): string[] => {
    const out: string[] = [];
    for (const g of grown) {
      if (g.s.removed) continue;
      const grewW = g.toW !== g.w, grewH = g.toH !== g.h;
      const sameW = grewW && near(g.s.width, g.toW), sameH = grewH && near(g.s.height, g.toH);
      if (!sameW && !sameH) continue;
      const whole = (sameW || !grewW) && (sameH || !grewH);
      out.push("the section " + label(g.s) + " it grew to " + g.toW + "×" + g.toH + " keeps " +
        (whole ? "that size" : sameW ? "the width it grew to, " + g.toW : "the height it grew to, " + g.toH));
    }
    return out;
  };
  return { undo, left, warnings: placed.warnings };
}

/** Two sizes the same to within Figma's float noise. */
const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.005;

/** A section the batch makes is made this size a side, then grows to hold the frames placed in it (land). */
const NEW_SECTION = SECTION_PAD * 2;
/** The size Figma's createFrame makes a frame (a tree root without a box keeps it unless its layout hugs). */
const NEW_FRAME = 100;

/** The first layer in `n` (a page or section the batch made), or below one there, that is not gone and is not one of
 *  `ours` (write-batch.ts batchMade: every node the batch made, whichever op made it): one the batch did not make. A
 *  layer of the batch's own in it (one the designer moved there) goes with it, as its own put-back would take it back;
 *  one holding the designer's layer keeps it, and `n` with it. Not into an instance (its layers are its main's). */
function leftIn(n: BaseNode & ChildrenMixin, ours: ReadonlySet<string>): SceneNode | null {
  for (const c of n.children) {
    if (c.removed) continue;
    if (!ours.has(c.id)) return c;
    const below = c.type !== "INSTANCE" && "children" in c ? leftIn(c, ours) : null;
    if (below) return below;
  }
  return null;
}

/**
 * Make what `dest` lands in that the batch makes and is not made yet: its page, then its section — each a Change on
 * `changes`, whose undo removes it with what of the batch's is in it (refusing when it holds a layer the batch did
 * not make). `consent` is checked before
 * each. Returns what this call made, for the op's reply.
 */
export async function makeDest(dest: Dest, consent: () => void, changes: Change[]): Promise<{ page?: string; section?: string }> {
  const out: { page?: string; section?: string } = {};
  const p = dest.page;
  if (!p.node) {
    consent();
    const page = figma.createPage();
    p.node = page;
    const made: Change = {
      applied: { pageCreated: page.id }, kind: "created page", what: "the new page " + label(page), on: page, made: true,
      async restore(allowed, ours) {
        if (page.removed) return;
        // Checked again after every await: the designer may have put a layer on it, or unticked "Allow edits", meanwhile.
        const check = (): void => {
          if (!allowed()) throw new RestoreStopped("'Allow edits' was turned off");
          const left = leftIn(page, ours);
          if (left) throw new Error("the page " + label(page) + " holds " + label(left) + ", which this batch did not make; it stays");
        };
        check();
        // The current page cannot be removed: the designer is moved to another page first (no undo step: the current
        // page is not document state).
        if (figma.currentPage === page) {
          const other = figma.root.children.filter((x) => x !== page)[0];
          if (other) await figma.setCurrentPageAsync(other);
          if (page.removed) return;
          check();
          if (figma.currentPage === page) throw new Error("the page " + label(page) + " is open again in Figma; it stays");
        }
        page.remove();
      },
    };
    changes.push(made);
    page.name = p.name;
    made.what = "the new page " + label(page);
    await page.loadAsync();
    consent();
    out.page = page.id;
  }
  const s = dest.section;
  if (s && !s.node) {
    const page = p.node;
    consent();
    const section = figma.createSection();
    s.node = section;
    const made: Change = {
      applied: { sectionCreated: section.id }, kind: "created section", what: "the new section " + label(section),
      on: section, made: true, owns: [section],
      restore(_allowed, ours) {
        if (section.removed) return;
        const left = leftIn(section, ours);
        if (left) throw new Error("the section " + label(section) + " holds " + label(left) + ", which this batch did not make; it stays");
        section.remove();
      },
    };
    changes.push(made);
    section.name = s.name;
    made.what = "the new section " + label(section);
    const at = new Canvas(section.id).sectionAt(page);
    page.appendChild(section);
    section.x = at.x;
    section.y = at.y;
    section.resizeWithoutConstraints(NEW_SECTION, NEW_SECTION);
    out.section = section.id;
  }
  return out;
}

/** Where a new tree will land, before it is built (the review card says it, and its Show me pans to `spot`): words, and
 *  the point its x/y will be at on a page the file has (none when the page is still to make), placed on `canvas` by the
 *  write's own rules (Canvas.place; a section still to make where makeDest will make it) and then put on it, so the
 *  batch's next op is placed beside it (the review plans the ops in order on one canvas). Measured as land measures the
 *  built frame where that is known before it is built: each side the spec gives (its box, else its layout's width and
 *  height; a set without either and without auto-layout, the column its variants are laid out in: builtSize, as the
 *  build sizes it), else a copy's source's, turned as the source is; else a new frame's 100 (Figma's createFrame; a
 *  hugging auto-layout side is known only once built). */
export function landing(canvas: Canvas, dest: Dest, spec: TreeNodeSpec, source?: SceneNode | null): { lands: string; spot: { pageId: string; x: number; y: number } | null } {
  const p = dest.page;
  const pageText = p.make ? " on a new page '" + p.name + "'" : p.current ? "" : " on page '" + p.name + "'";
  const page = p.node;
  const s = dest.section;
  const size = builtSize(spec, NEW_FRAME);
  const fp = footprint(size.w !== undefined ? size.w : source ? source.width : NEW_FRAME, size.h !== undefined ? size.h : source ? source.height : NEW_FRAME, source);
  const placed = canvas.place(dest, spec, fp, spec.name || "");
  if (!page || !placed) return { lands: s ? "in a new section '" + s.name + "'" + pageText : pageText.slice(1), spot: null };
  canvas.commit(placed);
  const origin = canvas.originOf(placed.holder);
  const spot = { pageId: page.id, x: origin.x + placed.x, y: origin.y + placed.y };
  if (s) return { lands: "in " + (s.node ? "" : "a new ") + "section '" + s.name + "'" + pageText, spot };
  const beside = spec.x === undefined && spec.y === undefined && page.children.length > 0;
  return { lands: (beside ? "right of the existing frames" : "at " + placed.x + ", " + placed.y) + pageText, spot };
}


/** The page `n` is on, or null. */
export function pageHolding(n: BaseNode): PageNode | null {
  let p: BaseNode | null = n.parent;
  while (p && p.type !== "PAGE") p = p.parent;
  return p && p.type === "PAGE" ? p : null;
}
