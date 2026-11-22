// Where a createTree lands (docs/write-plane-spec.md decision 13): its page, the section on it, and the ones it asks to
// make (bridge/src/place-spec.ts is the pure half: the fields, their check, the words).
//
// Resolved with the rest of the batch, before anything runs (resolveDests): a page by exact name or id (the current one
// by default), a section on that page (nested ones too) the same way. A name that matches several is refused with their
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
// around it; the growth is put back with the frame. A section that still runs into a neighbour is said in a warning.
//
// Plugin API facts this leans on (@figma/plugin-typings):
//   * figma.createPage appends a new page to the document; a Starter file stops at 3 pages and it throws then.
//   * figma.createSection makes a SECTION on the current page; appendChild moves it. A section is sized with
//     resizeWithoutConstraints (≥ 0.01 a side), and does not grow by itself when a plugin appends to it.
//   * Under documentAccess "dynamic-page" a page is loaded (loadAsync) before its children are read.
import type { TreeNodeSpec } from "../../bridge/src/tree-spec.ts";
import type { WriteOp } from "../../bridge/src/commands.ts";
import { matchByName, quoteList } from "../../bridge/src/name-match.ts";
import { MAX_NEW_PAGES, MAX_NEW_SECTIONS, SECTION_PAD } from "../../bridge/src/place-spec.ts";
import { RestoreStopped, type Change, type OpProblem } from "./write-batch";

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
  for (const [index, op] of trees) {
    if (op.createPage !== true || op.page === undefined || newPages.has(op.page)) continue;
    if (matchByName(op.page, figma.root.children, (p) => p.name, (p) => [p.id]).kind !== "none") continue;
    if (newPages.size >= MAX_NEW_PAGES) { problems.push({ index, op: op.op, message: "the batch makes " + (newPages.size + 1) + " pages; one batch makes at most " + MAX_NEW_PAGES + " (send the rest in another)" }); continue; }
    newPages.set(op.page, { name: op.page, node: null, make: true, current: false });
  }
  const pageFor = new Map<number, PageDest>();
  for (const [index, op] of trees) {
    const bad = (message: string): void => { problems.push({ index, op: op.op, message }); };
    if (op.page === undefined) { pageFor.set(index, pageOf(figma.currentPage)); continue; }
    const m = matchByName(op.page, figma.root.children, (p) => p.name, (p) => [p.id]);
    if (m.kind === "one") { pageFor.set(index, pageOf(m.item)); continue; }
    if (m.kind === "many") { bad("page '" + op.page + "' matches " + m.matches.length + " pages — pass one's id: " + m.matches.slice(0, 3).map(label).join(", ")); continue; }
    const planned = newPages.get(op.page);
    if (planned) { pageFor.set(index, planned); continue; }
    if (op.createPage === true) continue; // over the limit: said above
    bad("page '" + op.page + "' matches no page in this file" + (m.candidates.length ? "; closest: " + quoteList(m.candidates) : "") + "; to make it, add `createPage: true`");
  }
  // Every page an op lands on, loaded (dynamic-page) before its sections are read or anything is appended to it.
  for (const d of pages.values()) if (d.node) await d.node.loadAsync();
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
  let madeSections = 0;
  for (const [index, op] of trees) {
    const page = pageFor.get(index);
    if (!page || op.createSection !== true || op.section === undefined) continue;
    const planned = newSections.get(page) || new Map<string, SectionDest>();
    if (planned.has(op.section)) continue;
    if (matchByName(op.section, sectionsOf(page), (s) => s.name, (s) => [s.id]).kind !== "none") continue;
    if (madeSections >= MAX_NEW_SECTIONS) { problems.push({ index, op: op.op, message: "the batch makes " + (madeSections + 1) + " sections; one batch makes at most " + MAX_NEW_SECTIONS + " (send the rest in another)" }); continue; }
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
    if (op.createSection === true) continue; // over the limit: said above
    bad("section '" + op.section + "' matches no section on " + pageWords(page) + (m.candidates.length ? "; closest: " + quoteList(m.candidates) : "") + "; to make it, add `createSection: true`");
  }
  return { dests, problems };
}

/** A container's children, except `skip` (a node being placed among them). */
function others(parent: BaseNode & ChildrenMixin, skip: string): SceneNode[] {
  return parent.children.filter((c) => c.id !== skip);
}

/** What a node covers in its parent's coordinates, rotation included: its canvas box (absoluteBoundingBox, page
 *  coordinates) less its parent's origin — a page's is 0,0, a section's its own canvas box (a section does not
 *  rotate). Its x/y/size when Figma gives no canvas box. */
function occupied(c: SceneNode): { x: number; y: number; width: number; height: number } {
  const b = "absoluteBoundingBox" in c ? c.absoluteBoundingBox : null;
  const p = c.parent;
  const origin = !p ? null : p.type === "PAGE" ? { x: 0, y: 0 } : "absoluteBoundingBox" in p ? p.absoluteBoundingBox : null;
  return b && origin ? { x: b.x - origin.x, y: b.y - origin.y, width: b.width, height: b.height } : { x: c.x, y: c.y, width: c.width, height: c.height };
}
interface Box { x: number; y: number; width: number; height: number }
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Where a node of `w`×`h` goes among `held` (boxes in the same coordinates), by the spec's x/y — `pad` in from the
 * edges when nothing is held. Neither given: right of everything held, level with the topmost. Only `y`: right of
 * everything held, at that `y`. Only `x`: at that `x`, level with the topmost when that overlaps nothing, else below
 * everything held in its column. Only the spec's own coordinates are kept as given; the other never lands on a layer.
 */
function besideHeld(held: readonly Box[], spec: Pick<TreeNodeSpec, "x" | "y">, w: number, h: number, pad: number): { x: number; y: number } {
  if (!held.length) return { x: spec.x !== undefined ? spec.x : pad, y: spec.y !== undefined ? spec.y : pad };
  const top = Math.round(Math.min(...held.map((b) => b.y)));
  if (spec.x === undefined) return { x: Math.round(Math.max(...held.map((b) => b.x + b.width)) + PLACE_GAP), y: spec.y !== undefined ? spec.y : top };
  const x = spec.x;
  if (spec.y !== undefined) return { x, y: spec.y };
  if (!held.some((b) => overlaps({ x, y: top, width: w, height: h }, b))) return { x, y: top };
  const column = held.filter((b) => b.x < x + w && x < b.x + b.width);
  return { x, y: Math.round(Math.max(...column.map((b) => b.y + b.height)) + PLACE_GAP) };
}

/** Where a top-level node of `w`×`h` lands on `page`: the spec's own x/y, the rest beside what is on it (besideHeld). */
export function pagePlacement(page: PageNode, skip: string, spec: Pick<TreeNodeSpec, "x" | "y">, w: number, h: number): { x: number; y: number } {
  if (spec.x !== undefined && spec.y !== undefined) return { x: spec.x, y: spec.y };
  return besideHeld(others(page, skip).map(occupied), spec, w, h, 0);
}

/** Where a node of `w`×`h` lands in `section` (its own coordinates), by the spec's x/y and what the section holds:
 *  with neither, beside what it holds, or on a new row below when that would run the section into a neighbour; with
 *  one, as besideHeld says. */
function sectionPlacement(section: SectionNode, skip: string, spec: Pick<TreeNodeSpec, "x" | "y">, w: number, h: number): { x: number; y: number } {
  if (spec.x !== undefined && spec.y !== undefined) return { x: spec.x, y: spec.y };
  const held = others(section, skip).map(occupied);
  if (!held.length || spec.x !== undefined || spec.y !== undefined) return besideHeld(held, spec, w, h, SECTION_PAD);
  const beside = besideHeld(held, {}, w, h, SECTION_PAD);
  if (!runsInto(section, beside, w, h)) return beside;
  const below = { x: Math.round(Math.min(...held.map((b) => b.x))), y: Math.round(Math.max(...held.map((b) => b.y + b.height)) + PLACE_GAP) };
  return runsInto(section, below, w, h) ? beside : below;
}
/** Whether `section`, grown to hold a node of `w`×`h` at `at`, would run into one of its neighbours. */
function runsInto(section: SectionNode, at: { x: number; y: number }, w: number, h: number): boolean {
  const grown = grownBox(section, at.x + w + SECTION_PAD, at.y + h + SECTION_PAD);
  return !!grown && neighbourHit(section, grown) !== null;
}
/** The section's box grown to `needW`×`needH` (never shrunk); null when it already holds that. */
function grownBox(section: SectionNode, needW: number, needH: number): Box | null {
  const w = Math.max(section.width, Math.ceil(needW));
  const h = Math.max(section.height, Math.ceil(needH));
  return w === section.width && h === section.height ? null : { x: section.x, y: section.y, width: w, height: h };
}
/** The first of `section`'s neighbours (its parent's other children) that `box` runs into and its own box did not. */
function neighbourHit(section: SectionNode, box: Box): SceneNode | null {
  const p = section.parent;
  if (!p || !("children" in p)) return null;
  const was: Box = { x: section.x, y: section.y, width: section.width, height: section.height };
  for (const c of p.children) {
    if (c.id === section.id) continue;
    const b = occupied(c);
    if (overlaps(box, b) && !overlaps(was, b)) return c;
  }
  return null;
}

/** What landing a node did: how to take back the growth of the sections around it, and what it ran into. */
export interface Landed { undo(): void; warnings: string[] }

/**
 * Attach `root` (built to the side, sized) where `dest` says, placed: on its page beside what is there, or in its section
 * beside what it holds, the section and those around it grown to hold it. The page and the section must have been made
 * (makeDest). Throws when Figma refuses; what it grew before that is put back.
 */
export function land(root: SceneNode, dest: Dest, spec: Pick<TreeNodeSpec, "x" | "y">): Landed {
  const page = dest.page.node;
  if (!page) throw new Error("the page '" + dest.page.name + "' was not made before the batch built on it");
  if (!dest.section) {
    const { x, y } = pagePlacement(page, root.id, spec, root.width, root.height);
    page.appendChild(root);
    root.x = x;
    root.y = y;
    return { undo() {}, warnings: [] };
  }
  const section = dest.section.node;
  if (!section) throw new Error("the section '" + dest.section.name + "' was not made before the batch built in it");
  const { x, y } = sectionPlacement(section, root.id, spec, root.width, root.height);
  section.appendChild(root);
  root.x = x;
  root.y = y;
  // Each section around the node grows to hold what is in it, with its margin: the one it is in, then outwards.
  const grown: Array<{ s: SectionNode; w: number; h: number }> = [];
  const warnings: string[] = [];
  const undo = (): void => { for (const g of grown.slice().reverse()) if (!g.s.removed) g.s.resizeWithoutConstraints(g.w, g.h); };
  try {
    let child: SceneNode = root;
    let s: BaseNode | null = section;
    while (s && s.type === "SECTION") {
      const box = grownBox(s, child.x + child.width + SECTION_PAD, child.y + child.height + SECTION_PAD);
      if (box) {
        const hit = neighbourHit(s, box);
        grown.push({ s, w: s.width, h: s.height });
        s.resizeWithoutConstraints(box.width, box.height);
        if (hit) warnings.push("section '" + s.name + "' grew to " + box.width + "×" + box.height + " to hold '" + root.name + "' and now overlaps '" + hit.name + "'");
      }
      child = s;
      s = s.parent;
    }
  } catch (e) {
    try { undo(); } catch { /* the growth that was made is what Figma refused */ }
    throw e;
  }
  return { undo, warnings };
}

/** The first layer in `n` (a page or section the batch made) that is not gone: one the batch did not make. */
function leftIn(n: BaseNode & ChildrenMixin): SceneNode | null {
  for (const c of n.children) if (!c.removed) return c;
  return null;
}

/**
 * Make what `dest` lands in that the batch makes and is not made yet: its page, then its section — each a Change on
 * `changes`, whose undo removes it (refusing when it holds a layer the batch did not make). `consent` is checked before
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
      applied: { pageCreated: page.id }, kind: "created page", what: "the new page " + label(page),
      async restore(allowed) {
        if (page.removed) return;
        // Checked again after every await: the designer may have put a layer on it, or unticked "Allow edits", meanwhile.
        const check = (): void => {
          if (!allowed()) throw new RestoreStopped("'Allow edits' was turned off");
          const left = leftIn(page);
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
      restore() {
        if (section.removed) return;
        const left = leftIn(section);
        if (left) throw new Error("the section " + label(section) + " holds " + label(left) + ", which this batch did not make; it stays");
        section.remove();
      },
    };
    changes.push(made);
    section.name = s.name;
    made.what = "the new section " + label(section);
    // Beside what the page holds; it grows to hold the frames placed in it (land).
    const at = pagePlacement(page, section.id, {}, SECTION_PAD * 2, SECTION_PAD * 2);
    page.appendChild(section);
    section.x = at.x;
    section.y = at.y;
    section.resizeWithoutConstraints(SECTION_PAD * 2, SECTION_PAD * 2);
    out.section = section.id;
  }
  return out;
}

/** Where a new tree will land, before it is built (the review card says it, and its Show me pans to `spot`): words, and
 *  a point on a page the file has (none when the page is still to make). In a section, the spec's own size is used
 *  where it gives one (the built size is known only once it is built). */
export function landing(dest: Dest, spec: TreeNodeSpec): { lands: string; spot: { pageId: string; x: number; y: number } | null } {
  const p = dest.page;
  const pageText = p.make ? " on a new page '" + p.name + "'" : p.current ? "" : " on page '" + p.name + "'";
  const page = p.node;
  const s = dest.section;
  if (!page) return { lands: s ? "in a new section '" + s.name + "'" + pageText : pageText.slice(1), spot: null };
  const w = spec.box ? spec.box.w : 100;
  const h = spec.box ? spec.box.h : 100;
  if (!s) {
    const at = pagePlacement(page, "", spec, w, h);
    const beside = spec.x === undefined && spec.y === undefined && page.children.length > 0;
    return { lands: (beside ? "right of the existing frames" : "at " + at.x + ", " + at.y) + pageText, spot: { pageId: page.id, x: at.x, y: at.y } };
  }
  if (!s.node) {
    const at = pagePlacement(page, "", {}, SECTION_PAD * 2, SECTION_PAD * 2);
    return { lands: "in a new section '" + s.name + "'" + pageText, spot: { pageId: page.id, x: at.x + SECTION_PAD, y: at.y + SECTION_PAD } };
  }
  const at = sectionPlacement(s.node, "", spec, w, h);
  const origin = s.node.absoluteBoundingBox || { x: s.node.x, y: s.node.y };
  return { lands: "in section '" + s.name + "'" + pageText, spot: { pageId: page.id, x: origin.x + at.x, y: origin.y + at.y } };
}

/** The page `n` is on, or null. */
export function pageHolding(n: BaseNode): PageNode | null {
  let p: BaseNode | null = n.parent;
  while (p && p.type !== "PAGE") p = p.parent;
  return p && p.type === "PAGE" ? p : null;
}
