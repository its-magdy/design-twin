// Where a new screen lands (#184, figma-plugin/src/places.ts; docs/write-plane-spec.md decision 13): a section on the
// target page by name or id, placed beside what it holds without overlap and the section grown to fit (and the sections
// around it), a page or section the op asks to make — once per batch, used again by the same batch sent again — every
// name problem listed before anything runs, the limits, a keyed re-send that stays where its result is, and what the
// batch made put back whole when a later op fails (a Starter-plan team file's page limit included).
import type { WriteOp, WriteResult } from "../../bridge/src/commands.ts";
import { MAX_NEW_PAGES, SECTION_PAD } from "../../bridge/src/place-spec.ts";
import { writeOpPreview } from "../../bridge/src/commands.ts";
import { ok } from "../assert.ts";
import { PLACE_REFUSED, PLACE_TAKEN } from "../place-refusals.ts";
import type { FakeNode } from "../fake-figma.ts";
import type { Case } from "./helpers.ts";
import { treeWorld } from "./writes.ts";

type World = Awaited<ReturnType<typeof treeWorld>>;
const isNode = (v: unknown): v is FakeNode => typeof v === "object" && v !== null;
const num = (n: FakeNode | undefined, k: string): number => { const v = n?.[k]; return typeof v === "number" ? v : NaN; };
const parentOf = (n: FakeNode | undefined): FakeNode | null => { const p = n?.parent; return isNode(p) ? p : null; };
const kids = (n: FakeNode | undefined): readonly FakeNode[] => n?.children ?? [];
const box = (n: FakeNode | undefined): string => [num(n, "x"), num(n, "y"), num(n, "width"), num(n, "height")].join(",");
const screen = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ name, box: { w: 390, h: 844 }, ...extra });
const write = (w: World, ops: WriteOp[]): Promise<WriteResult> => w.api.applyWrites(ops.map((o) => ({ ...o })));
const found = (w: World, r: WriteResult, i = 0): FakeNode | undefined => w.alive().find((n) => n.id === r.applied[i]?.id);
const pageNamed = (w: World, name: string): FakeNode[] => w.figma.root.children.filter((p) => p.name === name);
async function flowsWorld(extra: Parameters<typeof treeWorld>[0] = {}) {
  const w = await treeWorld({ flows: true, ...extra });
  const f = w.flows;
  if (!f) throw new Error("flowsWorld: no Flows page");
  return { ...w, f };
}
type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** A frame on page 'Screens' to copy, `width`×`height`, turned by `deg` as Figma turns a layer (its relativeTransform;
 *  a positive rotation is anticlockwise on the canvas). Its id. */
async function turnedSource(w: World, width: number, height: number, deg: number): Promise<string> {
  const r = await write(w, [{ op: "createTree", page: "Screens", tree: { name: "Source", box: { w: width, h: height } } }]);
  const n = found(w, r);
  if (!r.ok || !n) throw new Error("turnedSource: " + String(r.error));
  const t = (deg * Math.PI) / 180;
  n.relativeTransform = [[Math.cos(t), Math.sin(t), num(n, "x")], [-Math.sin(t), Math.cos(t), num(n, "y")]];
  n.rotation = deg;
  return String(n.id);
}
/** What a node covers in its parent's coordinates, its turn included (Figma's absoluteBoundingBox less its parent's
 *  origin), worked out here from its x/y, size and relativeTransform. */
function covers(n: FakeNode | undefined): Box {
  const m = n?.relativeTransform;
  const at = (i: number, j: number, none: number): number => {
    const row: unknown = Array.isArray(m) ? m[i] : undefined;
    const v: unknown = Array.isArray(row) ? row[j] : undefined;
    return typeof v === "number" ? v : none;
  };
  const a = at(0, 0, 1), c = at(0, 1, 0), b = at(1, 0, 0), d = at(1, 1, 1);
  const w = num(n, "width"), h = num(n, "height");
  const xs = [0, a * w, c * h, a * w + c * h], ys = [0, b * w, d * h, b * w + d * h];
  return { x: num(n, "x") + Math.min(...xs), y: num(n, "y") + Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}
const plain = (n: FakeNode): Box => ({ x: num(n, "x"), y: num(n, "y"), width: num(n, "width"), height: num(n, "height") });
/** A batch (or one op) sent with "Review each change first" on, and Show me pressed on line `index` while the card is
 *  up: where the view was panned to (the spot: the view's centre less 200, 200), and the reply. */
async function shownAt(w: World, ops: WriteOp | WriteOp[], index = 0): Promise<{ r: WriteResult; spot: string }> {
  await w.send({ type: "set-review-writes", on: true });
  const view = { center: { x: NaN, y: NaN }, scrollAndZoomIntoView() {} };
  w.figma.viewport = view;
  const post = w.figma.ui.postMessage;
  // Pressed as the card is drawn, before the approving designer's answer (the next turn).
  w.figma.ui.postMessage = (m) => { post(m); if (m.type === "review") void w.figma.ui.onmessage?.({ type: "review-show", id: m.id, index }); };
  try {
    const r = await write(w, Array.isArray(ops) ? ops : [ops]);
    return { r, spot: (view.center.x - 200) + "," + (view.center.y - 200) };
  } finally { w.figma.ui.postMessage = post; }
}

export const cases: Case[] = [{
  name: "a section on a named page: inside it, beside what it holds without overlap, the section grown to fit",
  async run() {
    const w = await flowsWorld();
    const { f } = w;
    const commits = w.undo.commits;
    // Right of "Sign up" (570+390+100 = 1060) the section would grow to 1530 wide and reach "Payments" (x 1200): a new
    // row below instead, at the margin (80) and 100 below the lowest screen (80+844+100 = 1024).
    const r = await write(w, [{ op: "createTree", page: "Flows", section: "Onboarding", tree: screen("Verify") }]);
    const n = found(w, r);
    ok("[PLACE] lands inside the section, on a new row below its screens (right of them would reach 'Payments')",
      r.ok === true && parentOf(n) === f.onboarding && num(n, "x") === SECTION_PAD && num(n, "y") === 1024);
    ok("[PLACE] the section grows down to hold it with its margin (1024+844+80), its width as it was",
      num(f.onboarding, "width") === 1040 && num(f.onboarding, "height") === 1948 && num(f.onboarding, "x") === 0 && num(f.onboarding, "y") === 0);
    ok("[PLACE] the reply is as before: no page or section was made", r.applied[0]?.pageCreated === undefined && r.applied[0]?.sectionCreated === undefined && r.warnings === undefined);
    ok("[PLACE] one batch, one Cmd-Z step", w.undo.commits === commits + 2);
    // Making a page, a section on it and a frame in that is one step too: the batch's own checkpoint pair, and no step
    // ended inside it (seen live: one native Undo takes all three back).
    const made = { commits: w.undo.commits, implicit: w.undo.implicit };
    const compound = await write(w, [{ op: "createTree", page: "Launch", createPage: true, section: "Hero", createSection: true, tree: screen("Splash") }]);
    ok(`[PLACE] a batch making a page, a section and a frame is one Cmd-Z step (${w.undo.commits - made.commits} checkpoints, ${w.undo.implicit - made.implicit} ended inside)`,
      compound.ok === true && !!compound.applied[0]?.pageCreated && !!compound.applied[0]?.sectionCreated
      && w.undo.commits === made.commits + 2 && w.undo.implicit === made.implicit);
    // An empty section: at the margin, and it grows to hold the frame (80+844+80 tall; 80+390+80 = 550 fits its 600).
    const e = await write(w, [{ op: "createTree", page: "Flows", section: "Payments", tree: screen("Card entry") }]);
    const en = found(w, e);
    ok("[PLACE] an empty section: at its margin, the section grown to the frame's height + margins",
      e.ok === true && parentOf(en) === f.payments && num(en, "x") === 80 && num(en, "y") === 80 && box(f.payments) === "1200,0,600,1004");
    // By id, then a second frame: right of the first (80+390+100 = 570), the section grown right to 570+390+80 = 1040.
    const second = await write(w, [{ op: "createTree", page: "0:6", section: "6:2", tree: screen("Card saved") }]);
    ok("[PLACE] a page and a section by id; the next frame goes right of the first, the section grows right",
      second.ok === true && num(found(w, second), "x") === 570 && num(found(w, second), "y") === 80 && box(f.payments) === "1200,0,1040,1004");
    // A nested section: it grows, and so does the section around it.
    const nested = await write(w, [{ op: "createTree", page: "Flows", section: "Cards", tree: screen("Card list") }]);
    ok("[PLACE] a section inside a section: both grow (Cards to 550×1004, Library to cover it: 80+550+80 × 80+1004+80)",
      nested.ok === true && parentOf(found(w, nested)) === f.cards && box(f.cards) === "80,80,550,1004" && box(f.library) === "0,4000,710,1164");
    // Coordinates in a section are its own; past a neighbour, it is said, not refused.
    const pinned = await write(w, [{ op: "createTree", page: "Flows", section: "Onboarding", tree: screen("Pinned", { x: 2000, y: 80 }) }]);
    ok("[PLACE] explicit x/y are the section's own; the section grows to them and the overlap with a neighbour is a warning",
      pinned.ok === true && num(found(w, pinned), "x") === 2000 && num(f.onboarding, "width") === 2470
      && JSON.stringify(pinned.warnings) === JSON.stringify(["ops[0]: section 'Onboarding' grew to 2470×1948 to hold 'Pinned' and now overlaps 'Payments'"]));
    // A component lands in a section too.
    const comp = await write(w, [{ op: "createTree", page: "Flows", section: "Drafts", tree: { type: "COMPONENT", name: "Tag", box: { w: 40, h: 20 } } }]);
    ok("[PLACE] an ambiguous section name refuses even a component", comp.ok === false && /section 'Drafts' matches 2 sections on page 'Flows' — pass one's id: 'Drafts' \(6:4\), 'Drafts' \(6:5\)/.test(comp.error ?? ""));
    const comp2 = await write(w, [{ op: "createTree", page: "Flows", section: "6:5", tree: { type: "COMPONENT", name: "Tag", box: { w: 40, h: 20 } } }]);
    ok("[PLACE] …by id it lands in that one, at the margin", comp2.ok === true && parentOf(found(w, comp2))?.id === "6:5" && num(found(w, comp2), "x") === 80);
  },
}, {
  name: "one coordinate given: it is kept, and the other is chosen so the frame overlaps nothing",
  async run() {
    const at = async (ops: WriteOp[]): Promise<{ r: WriteResult; xy: string }> => {
      const w = await flowsWorld();
      const r = await write(w, ops);
      const n = found(w, r);
      return { r, xy: num(n, "x") + "," + num(n, "y") };
    };
    // Flows page: Onboarding 0,0 1040×1004 and Library 0,4000 500×500 are in the column x 0–390; Drafts end at 3200.
    const col = await at([{ op: "createTree", page: "Flows", tree: screen("Col", { x: 0 }) }]);
    ok(`[PLACE-AXIS] x only on a page: below what is in its column (4500+100), not on top of it (${col.xy})`, col.r.ok === true && col.xy === "0,4600");
    const free = await at([{ op: "createTree", page: "Flows", tree: screen("Free", { x: 5000 }) }]);
    ok(`[PLACE-AXIS] x only, the column clear: level with the topmost frame (${free.xy})`, free.r.ok === true && free.xy === "5000,0");
    const row = await at([{ op: "createTree", page: "Flows", tree: screen("Row", { y: 0 }) }]);
    ok(`[PLACE-AXIS] y only on a page: right of everything (3200+100) (${row.xy})`, row.r.ok === true && row.xy === "3300,0");
    // Onboarding holds Welcome (80,80 390×844) and Sign up (570,80).
    const inCol = await at([{ op: "createTree", page: "Flows", section: "Onboarding", tree: screen("Col", { x: 80 }) }]);
    ok(`[PLACE-AXIS] x only in a section: below the frame in its column (80+844+100), not on it (${inCol.xy})`, inCol.r.ok === true && inCol.xy === "80,1024");
    const inRow = await at([{ op: "createTree", page: "Flows", section: "Onboarding", tree: screen("Row", { y: 80 }) }]);
    ok(`[PLACE-AXIS] y only in a section: right of what it holds (960+100), never on a row that sits on a frame; the neighbour it reaches is a warning (${inRow.xy})`,
      inRow.r.ok === true && inRow.xy === "1060,80" && /now overlaps 'Payments'/.test((inRow.r.warnings ?? []).join()));
    const empty = await at([{ op: "createTree", page: "Flows", section: "Payments", tree: screen("Empty", { x: 200 }) }]);
    ok(`[PLACE-AXIS] x only in an empty section: the other at its margin (${empty.xy})`, empty.r.ok === true && empty.xy === "200,80");
  },
}, {
  name: "a rotated layer in a section: what it covers on the canvas is what a new frame is placed beside",
  async run() {
    const w = await flowsWorld();
    // In Payments (1200,0): a 100×100 frame at 80,80 whose rotation makes it cover 900×300 from its own 80,80 — its
    // canvas box, Figma's absoluteBoundingBox, is page coordinates (1200+80, 0+80).
    const rotated: FakeNode = { id: "9:8", type: "FRAME", name: "Tilted", x: 80, y: 80, width: 100, height: 100, rotation: -30,
      absoluteBoundingBox: { x: 1280, y: 80, width: 900, height: 300 } };
    (w.f.payments.appendChild as (c: FakeNode) => void)(rotated);
    const r = await write(w, [{ op: "createTree", page: "Flows", section: "Payments", tree: screen("Next") }]);
    const n = found(w, r);
    ok(`[PLACE-ROTATED] right of what the rotated frame covers (80+900+100), not of its unrotated width (${num(n, "x")},${num(n, "y")})`,
      r.ok === true && num(n, "x") === 1080 && num(n, "y") === 80);
    // A rotated layer beside a section: growing into what it covers is said.
    const w2 = await flowsWorld();
    const beside: FakeNode = { id: "9:7", type: "FRAME", name: "Tilted beside", x: 2500, y: 0, width: 100, height: 100, rotation: 45,
      absoluteBoundingBox: { x: 1900, y: 0, width: 700, height: 700 } };
    (w2.f.page.appendChild as (c: FakeNode) => void)(beside);
    const r2 = await write(w2, [{ op: "createTree", page: "Flows", section: "Payments", tree: screen("Wide", { box: { w: 700, h: 400 } }) }]);
    ok(`[PLACE-ROTATED] a section grown into a rotated neighbour's canvas box is a warning (${JSON.stringify(r2.warnings)})`,
      r2.ok === true && /now overlaps 'Tilted beside'/.test((r2.warnings ?? []).join()));
  },
}, {
  name: "a turned copy as the root: placed, and its section grown, by what it will cover on the canvas, not its unturned size",
  async run() {
    // A 40×400 frame turned -60° (clockwise) covers 366.41×234.64 from 346.41 left of its own x (Figma's corner).
    const onPage = async (at: Record<string, number>): Promise<{ r: WriteResult; n: FakeNode | undefined; hit: string }> => {
      const w = await flowsWorld();
      const r = await write(w, [{ op: "createTree", page: "Flows", tree: { clone: await turnedSource(w, 40, 400, -60), ...at } }]);
      const n = found(w, r);
      const c = covers(n);
      return { r, n, hit: kids(w.f.page).filter((k) => k !== n && overlaps(c, plain(k))).map((k) => String(k.name)).join() };
    };
    // y only: right of everything on the page (Drafts end at 3200, so its covered box starts at 3300).
    const row = await onPage({ y: 0 });
    ok(`[PLACE-TURNED] y only on a page: what it covers starts right of everything (3300+346.41), on no layer (${num(row.n, "x")},${num(row.n, "y")}; on '${row.hit}')`,
      row.r.ok === true && num(row.n, "x") === 3646 && num(row.n, "y") === 0 && row.hit === "");
    // x only: what it covers (3053.59–3420) reaches the 'Drafts' column, so it goes below them (1200+100).
    const col = await onPage({ x: 3400 });
    ok(`[PLACE-TURNED] x only on a page: below what its covered box reaches, on no layer (${num(col.n, "x")},${num(col.n, "y")}; on '${col.hit}')`,
      col.r.ok === true && num(col.n, "x") === 3400 && num(col.n, "y") === 1300 && col.hit === "");
    // Turned 90° (anticlockwise), it covers 400×40 from 40 above its own y.
    const inSection = async (at: Record<string, number>) => {
      const w = await flowsWorld();
      const r = await write(w, [{ op: "createTree", page: "Flows", section: "Turned", createSection: true, tree: { clone: await turnedSource(w, 40, 400, 90), ...at } }]);
      const n = found(w, r);
      return { r, n, sec: parentOf(n) ?? undefined };
    };
    const auto = await inSection({});
    ok(`[PLACE-TURNED] in a new section: what it covers at the margin (its y 80+40), the section grown to 80+400+80 × 80+40+80 (${num(auto.n, "x")},${num(auto.n, "y")}; ${box(auto.sec)})`,
      auto.r.ok === true && num(auto.n, "x") === 80 && num(auto.n, "y") === 120 && box(auto.sec) === "3300,0,560,200");
    const pinned = await inSection({ x: 80, y: 80 });
    ok(`[PLACE-TURNED] at x/y given in a section: kept, the section grown to the right edge of what it covers (80+400+80) (${num(pinned.n, "x")},${num(pinned.n, "y")}; ${box(pinned.sec)})`,
      pinned.r.ok === true && num(pinned.n, "x") === 80 && num(pinned.n, "y") === 80 && box(pinned.sec) === "3300,0,560,160");
    // Turned a hair (sin 0.001), it covers from 0.04 above its own y: rounding its y to the whole pixel 80 would start
    // what it covers at 79.96, inside the margin — so it is the next whole pixel instead.
    const w = await flowsWorld();
    const r = await write(w, [{ op: "createTree", page: "Flows", section: "Hair", createSection: true, tree: { clone: await turnedSource(w, 40, 400, (Math.asin(0.001) * 180) / Math.PI) } }]);
    const c = covers(found(w, r));
    ok(`[PLACE-TURNED] a computed spot never starts inside the margin once rounded (what it covers starts at ${c.x}, ${c.y}; its y ${num(found(w, r), "y")})`,
      r.ok === true && c.x >= SECTION_PAD && c.y >= SECTION_PAD && Number.isInteger(num(found(w, r), "y")));
  },
}, {
  name: "the review card's Show me pans to where the write puts the frame: its real size, the section the batch makes",
  async run() {
    /** Where the landed node's x/y are on the canvas (a section on the page adds its own). */
    const canvas = (n: FakeNode | undefined): string => {
      const p = parentOf(n);
      const o = p && p.type === "SECTION" ? { x: num(p, "x"), y: num(p, "y") } : { x: 0, y: 0 };
      return (o.x + num(n, "x")) + "," + (o.y + num(n, "y"));
    };
    // A copy of a 400×300 frame, x only at -300: 400 wide, it reaches 'Onboarding' and lands below that column (4500+100).
    const w = await flowsWorld();
    const wide = await shownAt(w, { op: "createTree", page: "Flows", tree: { clone: await turnedSource(w, 400, 300, 0), x: -300 } });
    ok(`[PLACE-SHOW] a copy, x only: Show me uses the source's size, as the write does (shown ${wide.spot}, landed ${canvas(found(w, wide.r))})`,
      wide.r.ok === true && canvas(found(w, wide.r)) === "-300,4600" && wide.spot === "-300,4600");
    // A section the batch makes (right of everything: 3300,0) and x/y given in it: they are the section's own.
    const w2 = await flowsWorld();
    const pin = await shownAt(w2, { op: "createTree", page: "Flows", section: "Pinned", createSection: true, tree: screen("Pinned", { x: 300, y: 200 }) });
    ok(`[PLACE-SHOW] a new section, x/y given: Show me at the section's place plus them, no margin added (shown ${pin.spot}, landed ${canvas(found(w2, pin.r))})`,
      pin.r.ok === true && canvas(found(w2, pin.r)) === "3600,200" && pin.spot === "3600,200");
    // A turned copy in a new section: its x/y as the write sets them (the covered box at the margin).
    const w3 = await flowsWorld();
    const turned = await shownAt(w3, { op: "createTree", page: "Flows", section: "Turned", createSection: true, tree: { clone: await turnedSource(w3, 40, 400, 90) } });
    ok(`[PLACE-SHOW] a turned copy in a new section: Show me where its x/y land (shown ${turned.spot}, landed ${canvas(found(w3, turned.r))})`,
      turned.r.ok === true && canvas(found(w3, turned.r)) === "3380,120" && turned.spot === "3380,120");
    // A size given by `layout` (no box) is the frame's size too: 400 wide at x -300 it reaches 'Onboarding' and goes
    // below that column (4500+100), not level with the top as a 100×100 frame would.
    const w5 = await flowsWorld();
    const fixed = await shownAt(w5, { op: "createTree", page: "Flows", tree: { name: "Fixed", x: -300, layout: { display: "flex", width: 400, height: 300 } } });
    ok(`[PLACE-SHOW] a size given by layout: Show me measures it as the write builds it (shown ${fixed.spot}, landed ${canvas(found(w5, fixed.r))})`,
      fixed.r.ok === true && canvas(found(w5, fixed.r)) === "-300,4600" && fixed.spot === "-300,4600");
    // A later op of the batch: Show me counts what the ops before it will land (and the sections they make or grow).
    const later = async (ops: WriteOp[], index: number): Promise<{ ok: boolean; spot: string; landed: string }> => {
      const wl = await flowsWorld();
      const s = await shownAt(wl, ops, index);
      return { ok: s.r.ok === true, spot: s.spot, landed: canvas(found(wl, s.r, index)) };
    };
    // Two frames in a section the batch makes (3300,0): the second right of the first (80+900+100).
    const two = await later([
      { op: "createTree", page: "Flows", section: "Placement test", createSection: true, tree: { name: "First", box: { w: 900, h: 300 } } },
      { op: "createTree", page: "Flows", section: "Placement test", tree: { name: "Second", box: { w: 200, h: 100 } } },
    ], 1);
    ok(`[PLACE-SHOW] the second frame in a new section: right of the first, where Show me points (shown ${two.spot}, landed ${two.landed})`,
      two.ok && two.landed === "4380,80" && two.spot === "4380,80");
    // Two frames on the page: the second right of the first (3300+390+100).
    const row = await later([
      { op: "createTree", page: "Flows", tree: screen("One") },
      { op: "createTree", page: "Flows", tree: screen("Two") },
    ], 1);
    ok(`[PLACE-SHOW] the second frame on a page: right of the first (shown ${row.spot}, landed ${row.landed})`, row.ok && row.landed === "3790,0" && row.spot === "3790,0");
    // A frame on the page, then a new section: the section goes right of that frame (3790), the frame at its margin.
    const after = await later([
      { op: "createTree", page: "Flows", tree: screen("One") },
      { op: "createTree", page: "Flows", section: "After", createSection: true, tree: screen("Two") },
    ], 1);
    ok(`[PLACE-SHOW] a section made after a frame of the batch: beside that frame (shown ${after.spot}, landed ${after.landed})`,
      after.ok && after.landed === "3870,80" && after.spot === "3870,80");
    // Two frames into an existing section: the first grows it; the second goes beside it in the grown section.
    const grown = await later([
      { op: "createTree", page: "Flows", section: "Payments", tree: screen("A") },
      { op: "createTree", page: "Flows", section: "Payments", tree: screen("B") },
    ], 1);
    ok(`[PLACE-SHOW] the second frame in a section the first grew (shown ${grown.spot}, landed ${grown.landed})`, grown.ok && grown.landed === "1770,80" && grown.spot === "1770,80");
    // The frame being built (hidden, on the current page at 0,0 until it lands) is no neighbour of the section: a
    // section at -300,0 holding one 100×100 frame grows right to 160 for the next, over where the build sits — and the
    // frame still goes beside the first (section 280,80), where Show me points.
    const w4 = await treeWorld();
    w4.pages.current.children = [];
    const seed = await write(w4, [{ op: "createTree", section: "Existing", createSection: true, tree: { name: "Held", box: { w: 100, h: 100 } } }]);
    const sec = parentOf(found(w4, seed));
    if (sec) sec.x = -300;
    const next = await shownAt(w4, { op: "createTree", section: "Existing", tree: { name: "Incoming", box: { w: 100, h: 100 } } });
    ok(`[PLACE-SHOW] the frame being built is not a neighbour its section grows into: beside the first, where Show me points (shown ${next.spot}, landed ${canvas(found(w4, next.r))})`,
      next.r.ok === true && num(found(w4, next.r), "x") === 280 && num(found(w4, next.r), "y") === 80 && next.spot === "-20,80" && next.r.warnings === undefined);
  },
}, {
  name: "given coordinates left of or above a section's edge are kept, the section stays put, and what sticks out is said",
  async run() {
    const w = await treeWorld();
    const r = await write(w, [{ op: "createTree", section: "Pinned", createSection: true, tree: { name: "Setback", x: -200.125, y: -50.375, box: { w: 150, h: 75 } } }]);
    const n = found(w, r);
    const sec = parentOf(n);
    ok(`[PLACE-OUT] past the left and top edges: kept exactly, the section's top-left where it was made, and a warning (${JSON.stringify(r.warnings)})`,
      r.ok === true && num(n, "x") === -200.125 && num(n, "y") === -50.375 && sec?.type === "SECTION" && box(sec) === "990,-20,160,160"
      && JSON.stringify(r.warnings) === JSON.stringify(["ops[0]: 'Setback' sticks out past the left and top edges of section 'Pinned': what it covers starts at -200.125, -50.375 in it, and a section grows only right and down to hold its frames"]));
    const w2 = await flowsWorld();
    const top = await write(w2, [{ op: "createTree", page: "Flows", section: "Payments", tree: screen("Raised", { x: 80, y: -10 }) }]);
    ok(`[PLACE-OUT] only above: said as the top edge (${JSON.stringify(top.warnings)})`,
      top.ok === true && JSON.stringify(top.warnings) === JSON.stringify(["ops[0]: 'Raised' sticks out past the top edge of section 'Payments': what it covers starts at 80, -10 in it, and a section grows only right and down to hold its frames"]));
    // A copy turned 90° anticlockwise covers from 40 above its own y: at y 0 it sticks out though its y does not.
    const w3 = await flowsWorld();
    const turned = await write(w3, [{ op: "createTree", page: "Flows", section: "Payments", tree: { clone: await turnedSource(w3, 40, 400, 90), x: 80, y: 0 } }]);
    ok(`[PLACE-OUT] what it covers counts, its turn included (${JSON.stringify(turned.warnings)})`,
      turned.ok === true && /sticks out past the top edge of section 'Payments': what it covers starts at 80, -40 in it/.test((turned.warnings ?? []).join()));
  },
}, {
  name: "a placed frame's x/y are whole pixels, never rounded onto a layer the spot was chosen clear of",
  async run() {
    /** A world whose current page holds only `boxes` (fixtures, not made by a batch). */
    const scratch = async (boxes: Box[]): Promise<World> => {
      const w = await treeWorld();
      w.pages.current.children = [];
      boxes.forEach((b, i) => (w.pages.current.appendChild as (c: FakeNode) => void)({ id: "9:" + (50 + i), type: "FRAME", name: "Held " + i, ...b }));
      return w;
    };
    const hits = (w: World, n: FakeNode | undefined): string => !n ? "(not made)" : kids(w.pages.current).filter((k) => k !== n && overlaps(plain(k), plain(n))).map((k) => String(k.name)).join();
    // x only: level with the topmost (y 0.6) clears the frame below at y 10.7, but rounded to 1 it would reach 10.7+.
    const w = await scratch([{ x: 200, y: 0.6, width: 10, height: 10 }, { x: 0, y: 10.7, width: 10, height: 10 }]);
    const r = await write(w, [{ op: "createTree", tree: { name: "Thin", x: 0, box: { w: 10, h: 10 } } }]);
    const n = found(w, r);
    ok(`[PLACE-ROUND] x only, level with the topmost: rounded away from the layer below, not onto it (${num(n, "x")},${num(n, "y")}; on '${hits(w, n)}')`,
      r.ok === true && num(n, "x") === 0 && num(n, "y") === 0 && hits(w, n) === "");
    // y only: right of everything (10.4+100 = 110.4), and the nearer whole pixel (110) is clear of everything held.
    const w2 = await scratch([{ x: 0.4, y: 0, width: 10, height: 10 }]);
    const r2 = await write(w2, [{ op: "createTree", tree: { name: "Row", y: 0, box: { w: 10, h: 10 } } }]);
    ok(`[PLACE-ROUND] the nearer whole pixel when that is clear (${num(found(w2, r2), "x")})`, r2.ok === true && num(found(w2, r2), "x") === 110);
    // Explicit coordinates stay exact.
    const r3 = await write(w2, [{ op: "createTree", tree: { name: "Pinned", x: 500.125, box: { w: 10, h: 10 } } }]);
    ok(`[PLACE-ROUND] a given coordinate is kept as given (${num(found(w2, r3), "x")})`, r3.ok === true && num(found(w2, r3), "x") === 500.125);
  },
}, {
  name: "the dry run and the write refuse the same placement fields (one table: test/place-refusals.ts)",
  async run() {
    const w = await flowsWorld();
    const before = w.made.length, pages = w.figma.root.children.length;
    for (const { op, why } of PLACE_REFUSED) {
      const r = await w.api.applyWrites([{ ...op } as never]);
      const dry = writeOpPreview(op as never, 0).invalid;
      ok(`[PLACE-DRY] refused by the write and by the dry run: ${JSON.stringify(op)} (${r.error})`,
        r.ok === false && why.test(r.error ?? "") && dry !== undefined && why.test(dry) && w.made.length === before && w.figma.root.children.length === pages);
    }
    for (const op of PLACE_TAKEN) {
      const r = await write(w, [op]);
      ok(`[PLACE-DRY] taken by the write and by the dry run: ${JSON.stringify(op)} (${r.error ?? "ok"})`, r.ok === true && writeOpPreview(op, 0).invalid === undefined);
    }
  },
}, {
  name: "a page and a section to make: made once, used by the batch and by the same batch sent again",
  async run() {
    const w = await flowsWorld();
    const pagesBefore = w.figma.root.children.length;
    const r = await write(w, [{ op: "createTree", page: "Checkout", createPage: true, tree: screen("Cart") }]);
    const made = pageNamed(w, "Checkout");
    const n = found(w, r);
    ok("[MAKE] a page the file lacks is made, at the end of the document, and the frame lands on it at 0,0",
      r.ok === true && made.length === 1 && w.figma.root.children.length === pagesBefore + 1 && w.figma.root.children[pagesBefore] === made[0]
      && parentOf(n) === made[0] && num(n, "x") === 0 && num(n, "y") === 0);
    ok("[MAKE] the reply names the page it made", r.applied[0]?.pageCreated === made[0]?.id);
    ok("[MAKE] the designer stays where they are", w.figma.currentPage === w.pages.current);
    const again = await write(w, [{ op: "createTree", page: "Checkout", createPage: true, tree: screen("Cart") }]);
    ok("[MAKE] the same batch again: no second page, the frame beside the first (390+100)",
      again.ok === true && pageNamed(w, "Checkout").length === 1 && parentOf(found(w, again)) === made[0] && num(found(w, again), "x") === 490 && again.applied[0]?.pageCreated === undefined);

    // A new section on a new page, two frames in it, a third op naming them without asking to make them.
    const b = await write(w, [
      { op: "createTree", page: "Launch", createPage: true, section: "Flow", createSection: true, tree: screen("Step 1") },
      { op: "createTree", page: "Launch", section: "Flow", createSection: true, tree: screen("Step 2") },
      { op: "createTree", page: "Launch", section: "Flow", tree: screen("Step 3") },
    ]);
    const launch = pageNamed(w, "Launch")[0];
    const sec = kids(launch)[0];
    ok("[MAKE] one page, one section on it, all three frames inside it",
      b.ok === true && pageNamed(w, "Launch").length === 1 && kids(launch).length === 1 && sec?.type === "SECTION" && sec.name === "Flow"
      && kids(sec).map((k) => k.name).join() === "Step 1,Step 2,Step 3");
    ok("[MAKE] the section at 0,0 on the empty page; the frames in a row from its margin, the section sized to hold them",
      box(sec) === "0,0," + (80 + 390 * 3 + 100 * 2 + 80) + ",1004" && kids(sec).map((k) => num(k, "x") + ":" + num(k, "y")).join() === "80:80,570:80,1060:80");
    ok("[MAKE] the page and the section are named on the op that made them",
      b.applied[0]?.pageCreated === launch?.id && b.applied[0]?.sectionCreated === sec?.id && b.applied[1]?.sectionCreated === undefined && b.applied[2]?.pageCreated === undefined);

    // A new section on a page that has frames: beside them, top-aligned (Page 1: right edge 890, top -20).
    const s = await write(w, [{ op: "createTree", section: "Ideas", createSection: true, tree: screen("Idea") }]);
    const ideas = kids(w.pages.current).find((k) => k.type === "SECTION");
    ok("[MAKE] a new section on the current page: right of its frames (890+100), top-aligned (-20), the frame inside at the margin",
      s.ok === true && box(ideas) === "990,-20,550,1004" && parentOf(found(w, s)) === ideas && num(found(w, s), "x") === 80);
    // An existing section with createSection: used as it is.
    const has = await write(w, [{ op: "createTree", page: "Flows", section: "Payments", createSection: true, tree: screen("Pay") }]);
    ok("[MAKE] createSection with a section the page has: it is used, none is made",
      has.ok === true && parentOf(found(w, has)) === w.f.payments && has.applied[0]?.sectionCreated === undefined && kids(w.f.page).filter((k) => k.name === "Payments").length === 1);
  },
}, {
  name: "refusals: a page or section that is not there, or there twice, the limits — every problem at once, nothing made",
  async run() {
    const w = await flowsWorld();
    const { made } = w;
    const before = made.length, pagesBefore = w.figma.root.children.length;
    const r = await write(w, [
      { op: "createFrame", name: "never" },
      { op: "createTree", page: "Flow", tree: screen("A") },
      { op: "createTree", page: "Flows", section: "Onbording", tree: screen("B") },
      { op: "createTree", page: "Archive", createPage: true, tree: screen("C") },
      { op: "createTree", section: "Onboarding", tree: screen("D") },
      { op: "createTree", page: "Flows", section: "Drafts", createSection: true, tree: screen("E") },
    ]);
    const e = r.error ?? "";
    ok(`[PLACE-REFUSE] refused whole, nothing made (${e.split("\n")[0]})`, r.ok === false && r.failedAt === 1 && made.length === before && w.figma.root.children.length === pagesBefore);
    ok("[PLACE-REFUSE] a page that is not there: its closest names, and how to make it",
      e.includes("ops[1] (createTree): page 'Flow' matches no page in this file; closest: 'Flows'") && e.includes("to make it, add `createPage: true`"));
    ok("[PLACE-REFUSE] a section that is not on the page: its closest names, and how to make it",
      e.includes("ops[2] (createTree): section 'Onbording' matches no section on page 'Flows'; closest: 'Onboarding'") && /ops\[2\][^\n]*add `createSection: true`/.test(e));
    ok("[PLACE-REFUSE] a page name the file has twice is refused even when asked to make it (which one is meant?)",
      e.includes("ops[3] (createTree): page 'Archive' matches 2 pages — pass one's id: 'Archive' (0:3), 'Archive' (0:4)"));
    ok("[PLACE-REFUSE] a section looked for on the current page only", e.includes("ops[4] (createTree): section 'Onboarding' matches no section on the current page 'Page 1'"));
    ok("[PLACE-REFUSE] a section name the page has twice, even with createSection", e.includes("ops[5] (createTree): section 'Drafts' matches 2 sections on page 'Flows'"));
    // The limit on pages a batch makes.
    const many = await write(w, Array.from({ length: MAX_NEW_PAGES + 1 }, (_, i): WriteOp => ({ op: "createTree", page: "New " + i, createPage: true, tree: screen("S" + i) })));
    ok("[PLACE-REFUSE] more than 10 new pages in one batch", many.ok === false && /makes 11 pages; one batch makes at most 10/.test(many.error ?? "") && w.figma.root.children.length === pagesBefore);
    // Two pages past the limit, and a later op naming one of them without `createPage`: each counted in turn, and the
    // later op is not told to add `createPage: true` (that would be past the limit too).
    const over = await write(w, [
      ...Array.from({ length: MAX_NEW_PAGES + 2 }, (_, i): WriteOp => ({ op: "createTree", page: "New " + i, createPage: true, tree: screen("S" + i) })),
      { op: "createTree", page: "New " + MAX_NEW_PAGES, tree: screen("Late") },
    ]);
    const oe = over.error ?? "";
    ok(`[PLACE-REFUSE] past the page limit: the 11th and 12th counted as such, and the late op told the batch already makes the most (${oe.split("\n").slice(-3).join(" | ")})`,
      over.ok === false && /ops\[10\][^\n]*makes 11 pages/.test(oe) && /ops\[11\][^\n]*makes 12 pages/.test(oe)
      && /ops\[12\] \(createTree\): page 'New 10' matches no page in this file, and the batch already makes the most pages one batch may \(10\); send the ops for it in another batch/.test(oe)
      && !/ops\[12\][^\n]*createPage: true/.test(oe));
    // The same for sections (25 a batch).
    const sections = await write(w, [
      ...Array.from({ length: 26 }, (_, i): WriteOp => ({ op: "createTree", page: "Flows", section: "Area " + i, createSection: true, tree: screen("A" + i) })),
      { op: "createTree", page: "Flows", section: "Area 25", tree: screen("Late") },
    ]);
    const se = sections.error ?? "";
    ok(`[PLACE-REFUSE] past the section limit: the late op is not told to add \`createSection: true\` (${se.split("\n").slice(-2).join(" | ")})`,
      sections.ok === false && /ops\[25\][^\n]*makes 26 sections/.test(se)
      && /ops\[26\] \(createTree\): section 'Area 25' matches no section on page 'Flows', and the batch already makes the most sections one batch may \(25\); send the ops for it in another batch/.test(se)
      && !/ops\[26\][^\n]*createSection: true/.test(se));
    // A section the batch makes is not on another page.
    const elsewhere = await write(w, [
      { op: "createTree", page: "Flows", section: "Fresh", createSection: true, tree: screen("F") },
      { op: "createTree", page: "Screens", section: "Fresh", tree: screen("G") },
    ]);
    ok("[PLACE-REFUSE] a section made on one page is not found on another", elsewhere.ok === false && /ops\[1\] \(createTree\): section 'Fresh' matches no section on page 'Screens'/.test(elsewhere.error ?? "") && made.length === before);
  },
}, {
  name: "put back: a later op failing removes the page, the section and the frame, and shrinks a grown section back",
  async run() {
    const w = await flowsWorld();
    const { f } = w;
    const pagesBefore = w.figma.root.children.length;
    const r = await write(w, [
      { op: "createTree", page: "Checkout", createPage: true, section: "Pay", createSection: true, tree: screen("Cart") },
      { op: "createTree", page: "Flows", section: "Onboarding", tree: screen("Verify") },
      { op: "setFill", nodeId: "gone:1", color: "#fff" },
    ]);
    ok("[PLACE-BACK] the batch fails at its last op and nothing it made stays",
      r.ok === false && r.failedAt === 2 && r.applied.length === 0 && w.alive().length === 0 && w.figma.root.children.length === pagesBefore && pageNamed(w, "Checkout").length === 0);
    ok("[PLACE-BACK] the section it grew is its old size again", box(f.onboarding) === "0,0,1040,1004" && kids(f.onboarding).length === 2);
    ok(`[PLACE-BACK] the reply lists the frames, the section and the page as put back (${JSON.stringify(r.restored)})`,
      (r.restored ?? []).length === 4 && JSON.stringify(r.restored?.map((x) => Object.keys(x).sort().join("+"))) === JSON.stringify(["pageCreated", "sectionCreated", "created+id", "created+id"]));

    // A Starter-plan team file's page limit: Figma refuses the new page, and the frame made before it in the batch goes too.
    const s = await flowsWorld({ pageLimit: 5 });
    const limited = await write(s, [
      { op: "createTree", page: "Screens", tree: screen("First") },
      { op: "createTree", page: "Checkout", createPage: true, tree: screen("Cart") },
    ]);
    ok("[PLACE-BACK] the page limit: refused with Figma's words at that op, the earlier frame removed",
      limited.ok === false && limited.failedAt === 1 && /Starter plan only comes with 3 pages/.test(limited.error ?? "") && s.alive().length === 0 && (limited.restored ?? []).length === 1);

    // A page the batch made that is the current page when it is put back: the designer is moved off it first.
    const k = await flowsWorld({ kit: true });
    // The designer opens the new page while the batch builds (Figma's own call; the same page object).
    k.hooks.onStyle = async () => { const pg = pageNamed(k, "Checkout")[0]; if (pg && k.figma.setCurrentPageAsync) await k.figma.setCurrentPageAsync(Object.assign(pg, { selection: [] })); };
    const current = await write(k, [
      { op: "createTree", page: "Checkout", createPage: true, tree: { name: "Cart", children: [{ text: "Total", styles: { text: "Body" } }] } },
      { op: "setFill", nodeId: "gone:1", color: "#fff" },
    ]);
    ok("[PLACE-BACK] a made page that became the current page is still removed (the designer is moved to another page first)",
      current.ok === false && pageNamed(k, "Checkout").length === 0 && current.applied.length === 0
      && k.figma.currentPage.name !== "Checkout" && k.figma.root.children.includes(k.figma.currentPage) && !/could not undo/.test(current.error ?? ""));
  },
}, {
  name: "a made page is checked again after the designer is moved off it: a layer put in, or edits turned off, meanwhile — it stays",
  async run() {
    // The batch's page becomes the current one while it builds; the put-back moves the designer off it (an await), and
    // during that await the designer puts a layer on it, or unticks "Allow edits". Either way the page is not removed.
    const sent = (k: World): Promise<WriteResult> => write(k, [
      { op: "createTree", page: "Checkout", createPage: true, tree: { name: "Cart", children: [{ text: "Total", styles: { text: "Body" } }] } },
      { op: "setFill", nodeId: "gone:1", color: "#fff" },
    ]);
    const opened = (k: World) => async (): Promise<void> => {
      const pg = pageNamed(k, "Checkout")[0];
      if (pg && k.figma.setCurrentPageAsync) await k.figma.setCurrentPageAsync(Object.assign(pg, { selection: [] }));
    };
    const a = await flowsWorld({ kit: true });
    a.hooks.onStyle = opened(a);
    const foreign: FakeNode = { id: "9:9", type: "FRAME", name: "Designer note", x: 0, y: 0, width: 10, height: 10 };
    a.hooks.onSwitch = async () => {
      const pg = pageNamed(a, "Checkout")[0];
      if (!pg || a.figma.currentPage === pg) return; // the designer opening it; the put-back's switch is away from it
      a.hooks.onSwitch = undefined;
      if (typeof pg.appendChild === "function") (pg.appendChild as (c: FakeNode) => void)(foreign);
    };
    const r = await sent(a);
    const kept = pageNamed(a, "Checkout")[0];
    ok(`[PLACE-BACK] a layer put on the page during the switch: the page stays with it, and the error says why (${r.error})`,
      r.ok === false && !!kept && kids(kept).length === 1 && kids(kept)[0] === foreign
      && /page 'Checkout' .* holds 'Designer note' \(9:9\), which this batch did not make/.test(r.error ?? "")
      && r.applied.some((x) => x.pageCreated === kept.id) && !(r.restored ?? []).some((x) => x.pageCreated !== undefined));
    const b = await flowsWorld({ kit: true });
    b.hooks.onStyle = opened(b);
    b.hooks.onSwitch = async () => {
      if (b.figma.currentPage.name === "Checkout") return;
      b.hooks.onSwitch = undefined;
      await b.allowEdits(false);
    };
    const off = await sent(b);
    const stays = pageNamed(b, "Checkout")[0];
    ok(`[PLACE-BACK] "Allow edits" unticked during the switch: the page stays, reported as kept, not as put back (${off.error})`,
      off.ok === false && !!stays && /'Allow edits' was turned off while the batch was being put back/.test(off.error ?? "")
      && off.applied.some((x) => x.pageCreated === stays.id) && !(off.restored ?? []).some((x) => x.pageCreated !== undefined));
  },
}, {
  name: "a made section holding a layer the batch did not make stays (with the layer), and is said",
  async run() {
    const w = await flowsWorld({ kit: true });
    const foreign: FakeNode = { id: "9:9", type: "FRAME", name: "Designer note", x: 0, y: 0, width: 10, height: 10 };
    w.hooks.onStyle = async () => {
      const sec = kids(w.pages.current).find((n) => n.type === "SECTION" && n.name === "Ideas");
      if (sec && typeof sec.appendChild === "function") (sec.appendChild as (c: FakeNode) => void)(foreign);
    };
    const r = await write(w, [
      { op: "createTree", section: "Ideas", createSection: true, tree: screen("A") },
      { op: "createTree", section: "Ideas", tree: { name: "B", children: [{ text: "Hi", styles: { text: "Body" } }] } },
      { op: "setFill", nodeId: "gone:1", color: "#fff" },
    ]);
    const sec = kids(w.pages.current).find((n) => n.type === "SECTION");
    ok("[PLACE-BACK] the section stays, with the designer's layer, and the error says why",
      r.ok === false && !!sec && kids(sec).length === 1 && kids(sec)[0] === foreign && /section 'Ideas' .* holds 'Designer note' \(9:9\), which this batch did not make/.test(r.error ?? "")
      && r.applied.some((a) => a.sectionCreated === sec.id));
  },
}, {
  name: "put back: a section the designer resized after the batch grew it keeps the designer's size (each side), and is said",
  async run() {
    // The batch grows "Payments" (600×600) to 80+500+80 × 80+700+80 = 660×860 for its first frame; while the next op
    // awaits its text style the designer resizes the section; then a later op fails and the batch is put back.
    const sent = async (resize: (s: FakeNode) => void) => {
      const w = await flowsWorld({ kit: true });
      w.hooks.onStyle = async () => { w.hooks.onStyle = undefined; resize(w.f.payments); };
      const r = await write(w, [
        { op: "createTree", page: "Flows", section: "Payments", tree: { name: "Pay", box: { w: 500, h: 700 } } },
        { op: "createTree", page: "Flows", tree: { name: "B", children: [{ text: "Hi", styles: { text: "Body" } }] } },
        { op: "setFill", nodeId: "gone:1", color: "#fff" },
      ]);
      return { r, s: w.f.payments, w };
    };
    const both = await sent((s) => { s.width = 900; s.height = 920; });
    ok(`[PLACE-BACK-RESIZED] resized both ways: the section keeps 900×920, the frames go, and the error says it kept the size (${both.r.error})`,
      both.r.ok === false && box(both.s) === "1200,0,900,920" && both.w.alive().length === 0
      && /the section 'Payments' \(6:2\) was resized after this batch grew it to 660×860, so it keeps its size, 900×920/.test(both.r.error ?? "")
      && !/could not undo the tree/.test(both.r.error ?? ""));
    ok("[PLACE-BACK-RESIZED] …the frame is still listed as put back (the tree did go)", (both.r.restored ?? []).some((x) => x.created !== undefined));
    const wide = await sent((s) => { s.width = 900; });
    ok(`[PLACE-BACK-RESIZED] only its width changed: the width stays 900, the height goes back to 600 (${box(wide.s)}; ${wide.r.error})`,
      wide.r.ok === false && box(wide.s) === "1200,0,900,600" && /so it keeps its width, 900/.test(wide.r.error ?? ""));
    const same = await sent(() => {});
    ok(`[PLACE-BACK-RESIZED] control: left as the batch grew it, it goes back to 600×600 and nothing is said (${same.r.error})`,
      same.r.ok === false && box(same.s) === "1200,0,600,600" && !/was resized/.test(same.r.error ?? ""));
  },
}, {
  name: "put back: a section two ops grew keeps a side the designer resized, even to the size the first op gave it",
  async run() {
    // Two trees at 80,80 grow "Payments" (600×600) twice: to 660×860, then 760×910. While a later op awaits its text
    // style the designer sets the width to 660 — the size the first op gave it. Put back, newest first: the second
    // op's growth finds the width changed and keeps it; the first op's must then leave it too (one conflict a side).
    const sent = async (resize: (s: FakeNode) => void) => {
      const w = await flowsWorld({ kit: true });
      w.hooks.onStyle = async () => { w.hooks.onStyle = undefined; resize(w.f.payments); };
      const r = await write(w, [
        { op: "createTree", page: "Flows", section: "Payments", tree: { name: "First", x: 80, y: 80, box: { w: 500, h: 700 } } },
        { op: "createTree", page: "Flows", section: "Payments", tree: { name: "Second", x: 80, y: 80, box: { w: 600, h: 750 } } },
        { op: "createTree", page: "Flows", tree: { name: "B", children: [{ text: "Hi", styles: { text: "Body" } }] } },
        { op: "setFill", nodeId: "gone:1", color: "#fff" },
      ]);
      return { r, s: w.f.payments, w };
    };
    const grew: string[] = [];
    const wide = await sent((s) => { grew.push(box(s)); s.width = 660; });
    const said = (wide.r.error ?? "").match(/was resized after this batch grew it/g) ?? [];
    ok(`[PLACE-BACK-RESIZED] two growths: the width the designer set (660) stays, the height goes back to 600, said once (${grew[0]} -> ${box(wide.s)}; ${wide.r.error})`,
      wide.r.ok === false && grew[0] === "1200,0,760,910" && box(wide.s) === "1200,0,660,600" && wide.w.alive().length === 0
      && said.length === 1 && /grew it to 760×910, so it keeps its width, 660/.test(wide.r.error ?? ""));
    const same = await sent(() => {});
    ok(`[PLACE-BACK-RESIZED] two growths, control: left as the batch grew it, both go back, to 600×600, and nothing is said (${box(same.s)}; ${same.r.error})`,
      same.r.ok === false && box(same.s) === "1200,0,600,600" && !/was resized/.test(same.r.error ?? ""));
  },
}, {
  name: "a keyed re-send stays where its result is: the page and the section it names must be the result's",
  async run() {
    const w = await flowsWorld();
    const spec = screen("Keyed", { key: "flows:keyed" });
    const first = await write(w, [{ op: "createTree", page: "Flows", section: "Payments", tree: spec }]);
    const same = await write(w, [{ op: "createTree", page: "Flows", section: "Payments", tree: { ...spec, name: "Keyed 2" } }]);
    ok("[PLACE-KEYED] the same page and section: updated in place", first.ok === true && same.ok === true && found(w, same)?.name === "Keyed 2" && found(w, same)?.id === found(w, first)?.id);
    const moved = await write(w, [{ op: "createTree", page: "Flows", section: "Onboarding", tree: spec }]);
    ok("[PLACE-KEYED] another section: refused (an update stays where the result is)", moved.ok === false && /is in section 'Payments', not 'Onboarding'; an update stays where the result is — leave `section` out/.test(moved.error ?? ""));
    const off = await write(w, [{ op: "createTree", page: "Flows", tree: { ...spec, name: "Keyed 3" } }]);
    ok("[PLACE-KEYED] no section named: the result is updated where it is (in its section)", off.ok === true && parentOf(found(w, off)) === w.f.payments);
    const onPage = await write(w, [{ op: "createTree", tree: screen("Top", { key: "flows:top" }) }]);
    const into = await write(w, [{ op: "createTree", section: "Ideas", createSection: true, tree: screen("Top", { key: "flows:top" }) }]);
    ok("[PLACE-KEYED] a result on the page itself, re-sent into a section: refused, and no section is made",
      onPage.ok === true && into.ok === false && /is not in a section, but `section` 'Ideas' would be a new section on the current page/.test(into.error ?? "") && !kids(w.pages.current).some((n) => n.type === "SECTION"));
    // The same batch sent again (a section to make, no page) once the designer has opened another page: the section of
    // that name is on the page the result is on, not this one, so it would be a new one here — said as that, and how to
    // reach the result's (its page named).
    const k = await flowsWorld();
    const keyed: WriteOp = { op: "createTree", section: "Pay", createSection: true, tree: screen("K", { key: "flows:pay" }) };
    const made = await write(k, [keyed]);
    const home = k.figma.currentPage.name;
    k.figma.currentPage = k.pages.screens;
    const again = await write(k, [keyed]);
    ok(`[PLACE-KEYED] a section of the same name only on the result's page: a new section here, said so, with the result's page to name (${again.error})`,
      made.ok === true && again.ok === false
      && new RegExp("is in section 'Pay' on page '" + home + "', but `section` 'Pay' would be a new section on the current page 'Screens'; an update stays where the result is — leave `section` out, or name its page: `page: '" + home + "'`").test(again.error ?? "")
      && !/in section 'Pay', not 'Pay'/.test(again.error ?? ""));
    // Another section's name to make: naming the result's page alone would still ask for a section it does not have —
    // the hint names both its section and its page. Each hint, followed, updates the result.
    const other = await write(k, [{ ...keyed, section: "Other" }]);
    ok(`[PLACE-KEYED] another name, a new section here: the hint names the result's section and its page (${other.error})`,
      other.ok === false
      && new RegExp("is in section 'Pay' on page '" + home + "', but `section` 'Other' would be a new section on the current page 'Screens'; an update stays where the result is — leave `section` out, or name its section and its page: `section: 'Pay', page: '" + home + "'`").test(other.error ?? "")
      && !/or name its page:/.test(other.error ?? ""));
    const followed = await write(k, [{ ...keyed, section: "Pay", page: home }]);
    const pageOnly = await write(k, [{ ...keyed, page: home }]);
    ok(`[PLACE-KEYED] …followed, either hint updates the result (${followed.error}; ${pageOnly.error})`,
      followed.ok === true && pageOnly.ok === true && found(k, followed)?.id === found(k, made)?.id && found(k, pageOnly)?.id === found(k, made)?.id);
    // On the result's own page, another name to make: the hint names its section.
    const here = await flowsWorld();
    const mine = await write(here, [keyed]);
    const elsewhere = await write(here, [{ ...keyed, section: "Other" }]);
    ok(`[PLACE-KEYED] another name on the result's page: the hint names its section (${elsewhere.error})`,
      mine.ok === true && elsewhere.ok === false
      && /is in section 'Pay', but `section` 'Other' would be a new section on the current page '[^']+'; an update stays where the result is — leave `section` out, or name its section: `section: 'Pay'`/.test(elsewhere.error ?? ""));
  },
}, {
  name: "the review card says where it lands: a section, a new section, a new page",
  async run() {
    const w = await flowsWorld();
    await w.send({ type: "set-review-writes", on: true }); // the designer ticks "Review each change first"
    const r = await write(w, [
      { op: "createTree", page: "Flows", section: "Onboarding", tree: screen("Verify") },
      { op: "createTree", page: "Checkout", createPage: true, section: "Pay", createSection: true, tree: screen("Cart") },
      { op: "createTree", page: "Screens", section: "Ideas", createSection: true, tree: screen("Idea") },
    ]);
    const card = [...w.posted].reverse().find((m) => m.type === "review");
    const tails = (card?.lines ?? []).map((l) => l.tail ?? "");
    ok(`[PLACE-CARD] each line's landing (${JSON.stringify(tails)})`, r.ok === true && JSON.stringify(tails) === JSON.stringify([
      "lands in section 'Onboarding' on page 'Flows'",
      "lands in a new section 'Pay' on a new page 'Checkout'",
      "lands in a new section 'Ideas' on page 'Screens'",
    ]));
    ok("[PLACE-CARD] Show me knows where a frame lands on a page that exists, not on one still to make",
      card?.lines?.[0]?.show?.spot === true && card.lines[1]?.show?.spot === undefined && card.lines[2]?.show?.spot === true);
  },
}, {
  name: "a placed frame's computed spot in a section starts at the section's margin at least, whatever overhangs its edge",
  async run() {
    /** Payments (1200,0, 600×600) holding a turned layer that covers `covered` (section coordinates); `wall`: a tall frame
     *  right of it on the page, so growing right runs into it. */
    const tilted = async (covered: Box, wall: boolean): Promise<World & { f: NonNullable<World["flows"]> }> => {
      const w = await flowsWorld();
      const t: FakeNode = { id: "9:21", type: "FRAME", name: "Tilted", x: covered.x + 300, y: covered.y, width: 100, height: 100, rotation: -60,
        absoluteBoundingBox: { x: 1200 + covered.x, y: covered.y, width: covered.width, height: covered.height } };
      (w.f.payments.appendChild as (c: FakeNode) => void)(t);
      if (wall) (w.f.page.appendChild as (c: FakeNode) => void)({ id: "9:22", type: "FRAME", name: "Wall", x: 1900, y: 0, width: 100, height: 3000 });
      return w;
    };
    // It covers -83..317 × 80..380: beside it (417) the section would reach 'Wall', so a new row below (380+100) — at
    // the margin, not at the turned layer's -83 left of the section's edge.
    const w = await tilted({ x: -83, y: 80, width: 400, height: 300 }, true);
    const s = await shownAt(w, { op: "createTree", page: "Flows", section: "Payments", tree: screen("Next") });
    const n = found(w, s.r);
    ok(`[PLACE-LEFT] a new row starts at the margin, not where a turned layer overhangs the left edge (${num(n, "x")},${num(n, "y")}; shown ${s.spot}; ${JSON.stringify(s.r.warnings)})`,
      s.r.ok === true && num(n, "x") === SECTION_PAD && num(n, "y") === 480 && s.spot === "1280,480" && s.r.warnings === undefined && box(w.f.payments) === "1200,0,600,1404");
    // It covers from 40 above the section's top: the next frame right of it is level with the margin, not with -40.
    const w2 = await tilted({ x: 80, y: -40, width: 300, height: 400 }, false);
    const t = await shownAt(w2, { op: "createTree", page: "Flows", section: "Payments", tree: screen("Beside") });
    const n2 = found(w2, t.r);
    ok(`[PLACE-LEFT] beside a layer overhanging the top edge: level with the margin (${num(n2, "x")},${num(n2, "y")}; shown ${t.spot}; ${JSON.stringify(t.r.warnings)})`,
      t.r.ok === true && num(n2, "x") === 480 && num(n2, "y") === SECTION_PAD && t.spot === "1680,80" && !/sticks out/.test((t.r.warnings ?? []).join()));
    // Given coordinates stay exact, even past the edge.
    const w3 = await tilted({ x: -83, y: 80, width: 400, height: 300 }, true);
    const pin = await write(w3, [{ op: "createTree", page: "Flows", section: "Payments", tree: screen("Pinned", { x: -90, y: 600 }) }]);
    ok("[PLACE-LEFT] given coordinates are kept as given", pin.ok === true && num(found(w3, pin), "x") === -90 && num(found(w3, pin), "y") === 600);
  },
}, {
  name: "a section given by id is found on whatever page holds it, the current one or not",
  async run() {
    // Payments (6:2) is on 'Flows'; the current page is 'Page 1'.
    const w = await flowsWorld();
    const fresh = await write(w, [{ op: "createTree", section: "6:2", tree: screen("By id") }]);
    ok(`[PLACE-ID] a section id, no page: it lands in that section on its own page (${fresh.error ?? "ok"})`,
      fresh.ok === true && parentOf(found(w, fresh)) === w.f.payments && num(found(w, fresh), "x") === 80);
    const spec = screen("Keyed", { key: "flows:by-id" });
    const first = await write(w, [{ op: "createTree", page: "Flows", section: "Payments", tree: spec }]);
    const again = await write(w, [{ op: "createTree", section: "6:2", tree: { ...spec, name: "Keyed 2" } }]);
    ok(`[PLACE-ID] a keyed re-send naming its own section by id, no page, another page open: updated in place (${again.error ?? "ok"})`,
      first.ok === true && again.ok === true && found(w, again)?.id === found(w, first)?.id && found(w, again)?.name === "Keyed 2");
    const named = await write(w, [{ op: "createTree", section: "Payments", tree: spec }]);
    ok("[PLACE-ID] by name, a section is still looked for on the current page only", named.ok === false && /section 'Payments' matches no section on the current page 'Page 1'/.test(named.error ?? ""));
    const other = await write(w, [{ op: "createTree", page: "Screens", section: "6:2", tree: screen("Elsewhere") }]);
    ok(`[PLACE-ID] a page named that does not hold the section: refused, saying where it is (${other.error})`, other.ok === false
      && /section '6:2' matches no section on page 'Screens'; it is the id of section 'Payments' on page 'Flows' — leave `page` out, or name that page/.test(other.error ?? "")
      && !/createSection/.test(other.error ?? ""));
    // An id that is not a section's, or no layer's: said as that, never "add `createSection: true`" (an id-like name
    // cannot be made: the wire check refuses it).
    const frame = await write(w, [{ op: "createTree", section: "6:11", tree: screen("Into a frame") }]);
    ok(`[PLACE-ID] the id of a frame: said to be a frame's, no createSection hint (${frame.error})`, frame.ok === false
      && /section '6:11' matches no section on the current page 'Page 1'; it is the id of 'Welcome' \(FRAME\), not of a section/.test(frame.error ?? "")
      && !/createSection/.test(frame.error ?? ""));
    const none = await write(w, [{ op: "createTree", section: "77:7", tree: screen("Nowhere") }]);
    ok(`[PLACE-ID] an id no layer has: said so, no createSection hint (${none.error})`, none.ok === false
      && /section '77:7' matches no section on the current page 'Page 1'; it looks like a node id, and no layer of this file has it/.test(none.error ?? "")
      && !/createSection/.test(none.error ?? ""));
    const dry = writeOpPreview({ op: "createTree", section: "6:2", tree: screen("By id") }, 0);
    ok(`[PLACE-ID] the dry run takes it, and says it lands on the section's own page (${JSON.stringify(dry.target)})`,
      dry.invalid === undefined && dry.target === "new frame in section '6:2' on the page that holds it");
  },
}, {
  name: "Show me on a later op counts what the earlier ops of the batch change on the canvas: a keyed resize, a move, a legacy frame",
  async run() {
    const canvasAt = (n: FakeNode | undefined): string => {
      const p = parentOf(n);
      const o = p && p.type === "SECTION" ? { x: num(p, "x"), y: num(p, "y") } : { x: 0, y: 0 };
      return (o.x + num(n, "x")) + "," + (o.y + num(n, "y"));
    };
    const next: WriteOp = { op: "createTree", page: "Screens", tree: { name: "Next", box: { w: 100, h: 100 } } };
    // A keyed frame (100 wide, at 0,0 on the empty 'Screens') re-sent 1100 wide: the next frame goes right of 1100.
    const w = await treeWorld();
    const spec = { name: "Keyed", key: "screens:wide", box: { w: 100, h: 100 } };
    await write(w, [{ op: "createTree", page: "Screens", tree: spec }]);
    const resized = await shownAt(w, [{ op: "createTree", page: "Screens", tree: { ...spec, box: { w: 1100, h: 100 } } }, next], 1);
    ok(`[PLACE-BATCH] after a keyed re-send that resizes its frame: shown where it lands (shown ${resized.spot}, landed ${canvasAt(found(w, resized.r, 1))})`,
      resized.r.ok === true && canvasAt(found(w, resized.r, 1)) === "1200,0" && resized.spot === "1200,0");
    // …and one that moves it (x 500): right of where it goes.
    const w1 = await treeWorld();
    await write(w1, [{ op: "createTree", page: "Screens", tree: spec }]);
    const shifted = await shownAt(w1, [{ op: "createTree", page: "Screens", tree: { ...spec, x: 500, y: 0 } }, next], 1);
    ok(`[PLACE-BATCH] after a keyed re-send that moves its frame (shown ${shifted.spot}, landed ${canvasAt(found(w1, shifted.r, 1))})`,
      shifted.r.ok === true && canvasAt(found(w1, shifted.r, 1)) === "700,0" && shifted.spot === "700,0");
    // …and one whose x/y did not change, after the designer moved it (x 2000): the update leaves it there, and so does Show me.
    const w8 = await treeWorld();
    const pinnedSpec = { ...spec, x: 0, y: 0 };
    const seed8 = await write(w8, [{ op: "createTree", page: "Screens", tree: pinnedSpec }]);
    const r8 = found(w8, seed8);
    if (r8) r8.x = 2000;
    const kept = await shownAt(w8, [{ op: "createTree", page: "Screens", tree: { ...pinnedSpec, name: "Keyed again" } }, next], 1);
    ok(`[PLACE-BATCH] after a keyed re-send that keeps its x/y: where the designer put it counts (shown ${kept.spot}, landed ${canvasAt(found(w8, kept.r, 1))})`,
      kept.r.ok === true && num(found(w8, kept.r, 0), "x") === 2000 && canvasAt(found(w8, kept.r, 1)) === "2200,0" && kept.spot === "2200,0");
    // A legacy frame made 1100 wide on 'Screens' (at 0,0, as createFrame puts it), then a tree: right of it.
    const w2 = await treeWorld();
    const legacy = await shownAt(w2, [{ op: "createFrame", name: "Legacy", width: 1100, height: 100, parentId: "0:2" }, next], 1);
    ok(`[PLACE-BATCH] after a legacy createFrame on the page (shown ${legacy.spot}, landed ${canvasAt(found(w2, legacy.r, 1))})`,
      legacy.r.ok === true && canvasAt(found(w2, legacy.r, 1)) === "1200,0" && legacy.spot === "1200,0");
    // A 1100-wide frame at 0,0 on 'Page 1' moved onto 'Screens' (it keeps its x/y): right of it. And moved off the page
    // a tree lands on, it no longer counts there.
    const w3 = await treeWorld();
    w3.pages.current.children = [];
    const big = await write(w3, [{ op: "createFrame", name: "Big", width: 1100, height: 100 }]);
    const bigId = String(big.applied[0]?.id);
    const moved = await shownAt(w3, [{ op: "move", nodeId: bigId, parentId: "0:2" }, next], 1);
    ok(`[PLACE-BATCH] after a move onto the page (shown ${moved.spot}, landed ${canvasAt(found(w3, moved.r, 1))})`,
      moved.r.ok === true && canvasAt(found(w3, moved.r, 1)) === "1200,0" && moved.spot === "1200,0");
    const w4 = await treeWorld();
    w4.pages.current.children = [];
    const big4 = await write(w4, [{ op: "createFrame", name: "Big", width: 1100, height: 100 }]);
    const away = await shownAt(w4, [{ op: "move", nodeId: String(big4.applied[0]?.id), parentId: "0:2" }, { op: "createTree", tree: { name: "Here", box: { w: 100, h: 100 } } }], 1);
    ok(`[PLACE-BATCH] after a move off the page: no longer counted there (shown ${away.spot}, landed ${canvasAt(found(w4, away.r, 1))})`,
      away.r.ok === true && canvasAt(found(w4, away.r, 1)) === "0,0" && away.spot === "0,0");
    // Moved into a section (Payments, 1200,0), it keeps its 0,0 there: the next frame in the section goes right of it.
    const w7 = await flowsWorld();
    w7.pages.current.children = [];
    const big7 = await write(w7, [{ op: "createFrame", name: "Big", width: 1100, height: 100 }]);
    const into = await shownAt(w7, [{ op: "move", nodeId: String(big7.applied[0]?.id), parentId: "6:2" }, { op: "createTree", page: "Flows", section: "Payments", tree: { name: "Next", box: { w: 100, h: 100 } } }], 1);
    ok(`[PLACE-BATCH] after a move into a section (shown ${into.spot}, landed ${canvasAt(found(w7, into.r, 1))})`,
      into.r.ok === true && canvasAt(found(w7, into.r, 1)) === "2400,80" && into.spot === "2400,80");
    // A patch that sets a frame's box (100 → 1100 wide, at 0,0 on 'Screens'): right of its new width.
    const w6 = await treeWorld();
    const small = await write(w6, [{ op: "createFrame", name: "Small", width: 100, height: 100, parentId: "0:2" }]);
    const grown = await shownAt(w6, [{ op: "patch", nodeId: String(small.applied[0]?.id), set: { box: { w: 1100 } } }, next], 1);
    ok(`[PLACE-BATCH] after a patch that resizes a frame on the page (shown ${grown.spot}, landed ${canvasAt(found(w6, grown.r, 1))})`,
      grown.r.ok === true && canvasAt(found(w6, grown.r, 1)) === "1200,0" && grown.spot === "1200,0");
    // Two patches each setting one side (w 1100, then only h 200): the second keeps the width the first set.
    const w9 = await treeWorld();
    const seed = await write(w9, [{ op: "createFrame", name: "Seed", width: 100, height: 100, parentId: "0:2" }]);
    const seedId = String(seed.applied[0]?.id);
    const sides = await shownAt(w9, [{ op: "patch", nodeId: seedId, set: { box: { w: 1100 } } }, { op: "patch", nodeId: seedId, set: { box: { h: 200 } } }, next], 2);
    ok(`[PLACE-BATCH] after two patches setting one side each: the width the first set counts (shown ${sides.spot}, landed ${canvasAt(found(w9, sides.r, 2))})`,
      sides.r.ok === true && canvasAt(found(w9, sides.r, 2)) === "1200,0" && sides.spot === "1200,0");
    // A delete runs after every other op: what it deletes is still there when the tree lands.
    const w5 = await treeWorld();
    const big5 = await write(w5, [{ op: "createFrame", name: "Big", width: 1100, height: 100, parentId: "0:2" }]);
    const gone = await shownAt(w5, [{ op: "delete", nodeId: String(big5.applied[0]?.id) }, next], 1);
    ok(`[PLACE-BATCH] a delete earlier in the batch runs last: still counted (shown ${gone.spot}, landed ${canvasAt(found(w5, gone.r, 1))})`,
      gone.r.ok === true && canvasAt(found(w5, gone.r, 1)) === "1200,0" && gone.spot === "1200,0");
  },
}, {
  name: "a component set without a size of its own is measured as the build lays out its variants",
  async run() {
    const canvasAt = (n: FakeNode | undefined): string => num(n, "x") + "," + num(n, "y");
    // Two 1100×100 variants in one column, 20 around and between: the set is 1140×260 at 0,0 on the empty 'Screens'.
    const w = await treeWorld();
    const s = await shownAt(w, [
      { op: "createTree", page: "Screens", tree: { type: "COMPONENT_SET", name: "Sizes", variant: { box: { w: 1100, h: 100 } }, columns: ["Size"], rows: [["sm"], ["lg"]] } },
      { op: "createTree", page: "Screens", tree: { name: "Next", box: { w: 100, h: 100 } } },
    ], 1);
    const set = found(w, s.r, 0);
    ok(`[PLACE-SET] the set is laid out as the review measured it, and the next frame shown where it lands (set ${box(set)}; shown ${s.spot}, landed ${canvasAt(found(w, s.r, 1))})`,
      s.r.ok === true && box(set) === "0,0,1140,260" && canvasAt(found(w, s.r, 1)) === "1240,0" && s.spot === "1240,0");
  },
}];
