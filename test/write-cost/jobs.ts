// The six jobs of the write-plane design record (docs/write-plane-spec.md, "The cheap route for each job"), a new
// screen's fix round, starting from nothing (a file with no design system: tokens first, then a screen bound to
// them), a blank file's kit, and a captured page landed from disk — each a file to start from, what the agent is told (its brief), and the check of the file afterwards.
//
// A job knows nothing about HOW it is done: a route (routes.ts) does it through the MCP tools, and the suite runs
// every route of every job on a fresh copy of the job's file. The check reads the file the plugin wrote, not the
// replies: `problems` (the job is not done; the route fails) and `gaps` (done, but not the way a designer would have
// it — a raw colour where the file has a variable, a text layer left with its content as its name; reported, not failed).
import fs from "node:fs";
import path from "node:path";
import { canvas, fillHex, fillVariable, hexOf, rgb, type Canvas, type CNode, type Fill, type Rgb } from "./canvas.ts";
import type { FakeVariable } from "../fake-figma.ts";

const isRgb = (v: unknown): v is Rgb => typeof v === "object" && v !== null && "r" in v && "g" in v && "b" in v;

export type Hex = `#${string}`;
/** A colour: raw, or a colour variable of the file by name (the fixture binds it; a check wants it bound). */
export type WantFill = Hex | { variable: string };
/** A node the job wants: a frame with children, or a text. The same description builds a fixture's screens. */
export type Want =
  | { frame: string; layout?: "HORIZONTAL" | "VERTICAL"; w?: number; h?: number; gap?: number; padding?: readonly [number, number, number, number]; fill?: WantFill; children?: readonly Want[] }
  | { text: string; name?: string; size?: number; fill?: WantFill };
export const isFrame = (w: Want): w is Extract<Want, { frame: string }> => "frame" in w;

// ---- the file every job starts from: one brand colour variable, and a components page with a list row
export const BRAND = { name: "color/brand", hex: "#4f46e5" } as const;
const MUTED: Hex = "#71717a";
const WHITE: Hex = "#ffffff";
interface AppFile { c: Canvas; vars: Record<string, string>; row: CNode }
function appFile(): AppFile {
  const c = canvas();
  const vars = { [BRAND.name]: c.variable(BRAND.name, BRAND.hex) };
  c.page("Screens"); // made first, so it is the current page
  const components = c.page("Components");
  const row = c.component(components, { name: "List row", layoutMode: "HORIZONTAL", w: 358, h: 44, gap: 8 });
  c.text(row, { name: "Label", text: "Label" });
  c.text(row, { name: "Detail", text: "Detail", fill: rgb(MUTED) });
  c.frame(row, { name: "Divider", w: 358, h: 1, fill: rgb("#e4e4e7") });
  return { c, vars, row };
}
const page = (f: AppFile, name: string): CNode => f.c.pages.find((p) => p.name === name) ?? f.c.page(name);
const fillOf = (f: AppFile, w: WantFill | undefined): Fill | undefined => {
  if (w === undefined) return undefined;
  if (typeof w === "string") return rgb(w);
  const id = f.vars[w.variable];
  if (!id) throw new Error(`jobs: the file has no variable ${w.variable}`);
  return { variable: id };
};
/** Build `want` into the fixture file under `parent` (how a job's existing screens are made). */
function build(f: AppFile, parent: CNode, want: Want): CNode {
  if (!isFrame(want)) {
    const fill = fillOf(f, want.fill);
    return f.c.text(parent, { text: want.text, ...(want.name !== undefined ? { name: want.name } : {}), ...(want.size !== undefined ? { size: want.size } : {}), ...(fill ? { fill } : {}) });
  }
  const fill = fillOf(f, want.fill);
  const n = f.c.frame(parent, {
    name: want.frame, ...(want.layout ? { layoutMode: want.layout } : {}), ...(want.w !== undefined ? { w: want.w } : {}), ...(want.h !== undefined ? { h: want.h } : {}),
    ...(want.gap !== undefined ? { gap: want.gap } : {}), ...(want.padding ? { padding: want.padding } : {}), ...(fill ? { fill } : {}),
  });
  for (const k of want.children ?? []) build(f, n, k);
  return n;
}

// ---- the screens the jobs are about
const row = (label: string, value: string): Want => ({ frame: "Row", layout: "HORIZONTAL", w: 358, h: 44, gap: 8, children: [{ text: label, name: "Label" }, { text: value, name: "Value", fill: MUTED }] });
const section = (title: string, rows: ReadonlyArray<readonly [string, string]>): Want =>
  ({ frame: title, layout: "VERTICAL", gap: 8, children: [{ text: title.toUpperCase(), name: "Section title", size: 13, fill: MUTED }, ...rows.map(([l, v]) => row(l, v))] });
const button = (name: string, label: string): Want =>
  ({ frame: name, layout: "HORIZONTAL", w: 358, h: 48, padding: [12, 16, 12, 16], fill: { variable: BRAND.name }, children: [{ text: label, name: "Label", fill: WHITE }] });
const screen = (name: string, children: readonly Want[]): Want =>
  ({ frame: name, layout: "VERTICAL", w: 390, h: 844, gap: 16, padding: [16, 16, 16, 16], fill: WHITE, children });
const header = (title: string, action?: string): Want =>
  ({ frame: "Header", layout: "HORIZONTAL", w: 358, h: 44, gap: 8, children: [{ text: title, name: "Title", size: 24 }, ...(action ? [{ text: action, name: "Action", fill: { variable: BRAND.name } } satisfies Want] : [])] });

/** A settings screen: a header, two sections of three rows, a button — 28 nodes, four levels deep. */
export const settingsScreen = (name: string, email: string): Want => screen(name, [
  header(name, "Done"),
  section("Account", [["Name", "Jane Doe"], ["Email", email], ["Plan", "Pro"]]),
  section("Notifications", [["Push", "On"], ["Email digest", "Weekly"], ["Sounds", "Off"]]),
  button("Sign out button", "Sign out"),
]);
/** An order screen: a header, four detail rows, a button — 18 nodes. */
const orderScreen = (n: number, status: string, items: string, total: string, when: string): Want => screen(`Order ${n}`, [
  header(`Order ${n}`),
  { frame: "Details", layout: "VERTICAL", gap: 8, children: [row("Status", status), row("Items", items), row("Total", total), row("Delivery", when)] },
  button("Track button", "Track order"),
]);

// ---- the check: does the node the plugin made show what the job wanted
export interface Verdict { problems: string[]; gaps: string[] }
interface Tally { unbound: number; unnamedTexts: number }
/** A colour variable the check wants, by name: the colour it shows and its id in the file (null: the file has none). */
type VarLookup = (name: string) => { hex: string; id: string | null };
/** The jobs' file: its one colour variable. */
const appVars = (f: AppFile): VarLookup => (name) => ({ hex: BRAND.hex, id: f.vars[name] ?? null });
function compare(n: CNode, want: Want, vars: VarLookup, at: string, out: string[], tally: Tally): void {
  const fillCheck = (w: WantFill | undefined): void => {
    if (w === undefined) return;
    const hex = typeof w === "string" ? w : vars(w.variable).hex;
    if (fillHex(n) !== hex) out.push(`${at}: fill ${String(fillHex(n))}, wanted ${hex}`);
    else if (typeof w !== "string") { const id = vars(w.variable).id; if (id === null || fillVariable(n) !== id) tally.unbound++; }
  };
  if (!isFrame(want)) {
    if (n.type !== "TEXT") { out.push(`${at}: a ${n.type}, wanted a TEXT`); return; }
    if (n.characters !== want.text) out.push(`${at}: text "${String(n.characters)}", wanted "${want.text}"`);
    if (want.size !== undefined && n.fontSize !== want.size) out.push(`${at}: font size ${String(n.fontSize)}, wanted ${want.size}`);
    if (want.name !== undefined && n.name !== want.name) tally.unnamedTexts++;
    fillCheck(want.fill);
    return;
  }
  if (n.type === "TEXT") { out.push(`${at}: a TEXT, wanted a frame "${want.frame}"`); return; }
  if (n.name !== want.frame) out.push(`${at}: named "${n.name}", wanted "${want.frame}"`);
  if ((want.layout ?? "NONE") !== n.layoutMode) out.push(`${at}: layout ${String(n.layoutMode)}, wanted ${want.layout ?? "NONE"}`);
  if (want.gap !== undefined && n.itemSpacing !== want.gap) out.push(`${at}: gap ${String(n.itemSpacing)}, wanted ${want.gap}`);
  if (want.padding && [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].join() !== want.padding.join()) out.push(`${at}: padding wrong`);
  if (want.w !== undefined && n.width !== want.w) out.push(`${at}: width ${String(n.width)}, wanted ${want.w}`);
  if (want.h !== undefined && n.height !== want.h) out.push(`${at}: height ${String(n.height)}, wanted ${want.h}`);
  fillCheck(want.fill);
  const kids = n.children ?? [];
  const wantKids = want.children ?? [];
  if (kids.length !== wantKids.length) { out.push(`${at}: ${kids.length} children, wanted ${wantKids.length}`); return; }
  wantKids.forEach((k, i) => { const kid = kids[i]; if (kid) compare(kid, k, vars, `${at}/${isFrame(k) ? k.frame : JSON.stringify(k.text)}`, out, tally); });
}
const gapLines = (t: Tally): string[] => [
  ...(t.unbound ? [`${t.unbound} fill(s) are raw colours where the file has the variable ${BRAND.name}`] : []),
  ...(t.unnamedTexts ? [`${t.unnamedTexts} text layer(s) keep their content as their name (the four ops cannot name a text)`] : []),
];
/** The frames on `pageNode` named like `wants`, made by the route: exactly one each, compared with what was wanted. */
function newScreens(vars: VarLookup, pageNode: CNode, wants: readonly Want[], before: ReadonlySet<string>): { problems: string[]; tally: Tally } {
  const problems: string[] = [];
  const tally: Tally = { unbound: 0, unnamedTexts: 0 };
  for (const w of wants) {
    if (!isFrame(w)) continue;
    const made = (pageNode.children ?? []).filter((k) => k.name === w.frame && !before.has(k.id));
    if (made.length !== 1) { problems.push(`${made.length} new frames named "${w.frame}" on page "${pageNode.name}", wanted 1`); continue; }
    const root = made[0];
    if (root) compare(root, w, vars, w.frame, problems, tally);
  }
  return { problems, tally };
}
function checkNewScreens(f: AppFile, pageNode: CNode, wants: readonly Want[], before: ReadonlySet<string>): Verdict {
  const { problems, tally } = newScreens(appVars(f), pageNode, wants, before);
  return { problems, gaps: gapLines(tally) };
}
/** Every node under `root` (instance sublayers included). */
const walk = (root: CNode): CNode[] => [root, ...(root.children ?? []).flatMap(walk)];

// ---- the jobs
/** The design system an agent composes from, as it knows it from the file's design-system export (read once per
 *  session, so not counted per job): each component with the TEXT properties it takes (each named after the text
 *  sublayer it drives), and the variables by name. */
export interface Kit { components: Record<string, readonly string[]>; variables: readonly string[] }
/** What each job tells the agent. A route may use nothing else about the file: it has to find the rest. */
export interface Briefs {
  /** build `want` on the current page (`pageId`); the file's design system is `kit` */
  "new-screen": { pageId: string; want: Want; kit: Kit };
  /** make `want` (screens like the existing `sourceId`, with other values) beside it */
  "similar-screens": { pageId: string; sourceId: string; want: readonly Want[] };
  /** on the screen `screenId`, the text `wrong` should read `right` */
  "fix-one-node": { screenId: string; wrong: string; right: string };
  /** every text that reads `from`, on every screen of the file, should read `to` */
  "same-change-many": { from: string; to: string };
  /** the brand colour (the variable `variable`, `from`) is now `to` everywhere */
  "colour-update": { variable: string; from: Hex; to: Hex };
  /** the `part` of the list rows on screen `screenId` shows the wrong colour; it should be `to` in every row */
  "repeated-part": { screenId: string; part: string; to: Hex };
  /** build `want` on the current page; the check of it then finds the text `wrong`, which should read `right` */
  "fix-round": { pageId: string; want: Want; wrong: string; right: string };
  /** the file has no variables: make the token table `tokens` (one collection, `modes`), then build `want` on the
   *  current page with its colours bound to those tokens */
  "start-from-nothing": { pageId: string; collection: string; modes: readonly string[]; tokens: readonly Token[]; want: Want };
  /** a blank file: make the token table `tokens`, then the starter kit `kit` (components the screen uses by name, their
   *  colours bound to the tokens), then the screen `screen` on the current page, composed of the kit's instances */
  "blank-file": { pageId: string; collection: string; modes: readonly string[]; tokens: readonly Token[]; kit: StarterKit; screen: KitScreen };
  /** an existing app's page, rendered: put it on the current page as a screen. `capture` is what capture-page wrote for
   *  it (its spec file and images, under the directory the MCP server runs in); `spec` is that spec as read, for a route
   *  that types the screen itself */
  "capture-page": { pageId: string; capture: CapturedPage; spec: CapturedNode };
}
/** What capture-page wrote for one width of a page (test/fixtures/capture/sample): the spec's path relative to the
 *  directory the MCP server runs in, the fixture directory it is copied from, and its images. */
export interface CapturedPage { specFile: string; fixtureDir: string; images: readonly string[] }
/** A tree spec node as capture-page writes it (the fields a check and the four-op route read). */
export interface CapturedNode {
  name?: string; text?: string; box?: { w: number; h: number };
  font?: { size?: number; color?: Hex };
  layout?: { display?: string; flexDirection?: string; gap?: number; padding?: number[] };
  fills?: Array<{ type: string; color?: Hex; file?: string }>;
  children?: CapturedNode[];
}
/** A starter kit: icons, a button set (one variant per size × state; a label, an optional icon that can be swapped), an
 *  input with a placeholder, a card with a title and a body. */
export interface StarterKit {
  icons: readonly string[];
  button: { name: string; sizes: readonly string[]; states: readonly string[]; label: string };
  input: { name: string; placeholder: string };
  card: { name: string; title: string; body: string };
}
/** A screen of the kit's instances: a title, a card, the inputs (by placeholder), a button. */
export interface KitScreen {
  frame: string; title: string;
  card: { title: string; body: string };
  inputs: readonly string[];
  button: { size: string; state: string; label: string; icon: string };
}
/** One design token: a colour or a number, a value per mode — or an alias of another token. */
export interface Token { name: string; type: "color" | "number"; values: ReadonlyArray<Hex | number | { aliasOf: string }> }
export type JobId = keyof Briefs;
export interface Fixture<J extends JobId> {
  c: Canvas;
  brief: Briefs[J];
  check(): Verdict;
}
export interface Job<J extends JobId> {
  id: J;
  title: string;
  /** what the job is, in one line, for the table's notes */
  what: string;
  fixture(): Fixture<J>;
}

const newScreen: Job<"new-screen"> = {
  id: "new-screen", title: "New screen",
  what: "a 28-node settings screen, four levels deep, on a page that has one screen; the file has a Row component",
  fixture() {
    const f = appFile();
    const screens = page(f, "Screens");
    build(f, screens, settingsScreen("Home", "jane@example.com"));
    // The settings rows as a component (made after the existing screen, so its ids stay as they were): a row built
    // from it shows what a row built node by node shows, so the check takes either.
    const rowMain = f.c.component(page(f, "Components"), { name: "Row", layoutMode: "HORIZONTAL", w: 358, h: 44, gap: 8 });
    f.c.text(rowMain, { name: "Label", text: "Label" });
    f.c.text(rowMain, { name: "Value", text: "Value", fill: rgb(MUTED) });
    f.c.textProps(rowMain, { Label: "Label", Value: "Value" });
    const before = new Set(Object.keys(f.c.nodes));
    const want = settingsScreen("Settings", "jane@example.com");
    const kit: Kit = { components: { Row: ["Label", "Value"] }, variables: [BRAND.name] };
    return { c: f.c, brief: { pageId: screens.id, want, kit }, check: () => checkNewScreens(f, screens, [want], before) };
  },
};

const similarScreens: Job<"similar-screens"> = {
  id: "similar-screens", title: "Several similar screens",
  what: "two more 18-node order screens like an existing one, other values",
  fixture() {
    const f = appFile();
    const screens = page(f, "Screens");
    const source = build(f, screens, orderScreen(1001, "Delivered", "2", "$18.00", "Yesterday"));
    const before = new Set(Object.keys(f.c.nodes));
    const want = [orderScreen(1002, "Shipped", "3", "$42.00", "Tomorrow"), orderScreen(1003, "Packing", "1", "$9.50", "Friday")];
    return { c: f.c, brief: { pageId: screens.id, sourceId: source.id, want }, check: () => checkNewScreens(f, screens, want, before) };
  },
};

const fixOneNode: Job<"fix-one-node"> = {
  id: "fix-one-node", title: "Fix one node",
  what: "one text with a typo on a 28-node screen",
  fixture() {
    const f = appFile();
    const screens = page(f, "Screens");
    const target = build(f, screens, settingsScreen("Profile", "jane@exmaple.com"));
    build(f, screens, settingsScreen("Home", "jane@example.com"));
    const brief = { screenId: target.id, wrong: "jane@exmaple.com", right: "jane@example.com" };
    const snapshot = (): string[] => walk(target).map((n) => `${n.id}:${String(n.characters ?? "")}:${String(fillHex(n))}`);
    const was = snapshot();
    return {
      c: f.c, brief,
      check() {
        const now = snapshot();
        const changed = now.filter((s, i) => s !== was[i]);
        const texts = walk(target).filter((n) => n.type === "TEXT");
        const problems = [
          ...(texts.some((n) => n.characters === brief.wrong) ? [`"${brief.wrong}" is still on the screen`] : []),
          ...(texts.filter((n) => n.characters === brief.right).length !== 1 ? [`"${brief.right}" is not on the screen exactly once`] : []),
          ...(changed.length !== 1 || now.length !== was.length ? [`${changed.length} node(s) changed, wanted 1`] : []),
        ];
        return { problems, gaps: [] };
      },
    };
  },
};

const sameChangeMany: Job<"same-change-many"> = {
  id: "same-change-many", title: "Same change on many screens",
  what: "one footer text on 12 screens across 3 pages",
  fixture() {
    const f = appFile();
    const brief = { from: "Terms v1", to: "Terms v2" };
    const footers: CNode[] = [];
    for (const flow of ["A", "B", "C"]) {
      const p = page(f, `Flow ${flow}`);
      for (let i = 1; i <= 4; i++) {
        const s = build(f, p, screen(`${flow}${i}`, [header(`Step ${i}`), section("Details", [["First", "1"], ["Second", "2"]]), { text: brief.from, name: "Footer", size: 12, fill: MUTED }]));
        const last = s.children?.at(-1);
        if (last) footers.push(last);
      }
    }
    const footerScreens = footers.map((n) => n.parent);
    // every other text, with what it read: the change must leave them alone
    const others = Object.values(f.c.nodes).filter((n) => n.type === "TEXT" && !footers.includes(n)).map((n) => [n, n.characters] as const);
    return {
      c: f.c, brief,
      check() {
        const all = Object.values(f.c.nodes).filter((n) => n.type === "TEXT");
        const touched = others.filter(([n, text]) => n.characters !== text);
        const problems = [
          ...footers.filter((n) => n.characters !== brief.to).map((n) => `footer ${n.id} reads "${String(n.characters)}"`),
          ...footers.filter((n, i) => n.parent !== footerScreens[i]).map((n) => `footer ${n.id} is no longer on its screen`),
          ...(all.some((n) => n.characters === brief.from) ? [`"${brief.from}" is still in the file`] : []),
          ...(touched.length ? [`${touched.length} other text(s) changed too (first: ${touched[0]?.[0].id} "${String(touched[0]?.[0].characters)}")`] : []),
        ];
        return { problems, gaps: [] };
      },
    };
  },
};

const colourUpdate: Job<"colour-update"> = {
  id: "colour-update", title: "Colour update",
  what: "the brand colour, bound to 24 nodes on 8 screens across 2 pages",
  fixture() {
    const f = appFile();
    const brief = { variable: BRAND.name, from: BRAND.hex, to: "#2563eb" } as const;
    const brand: WantFill = { variable: BRAND.name };
    for (const flow of ["Shop", "Account"]) {
      const p = page(f, flow);
      for (let i = 1; i <= 4; i++) {
        build(f, p, screen(`${flow} ${i}`, [
          { frame: "Top bar", layout: "HORIZONTAL", w: 358, h: 56, padding: [8, 16, 8, 16], fill: brand, children: [{ text: `${flow} ${i}`, name: "Title", size: 20, fill: WHITE }] },
          section("Summary", [["Items", String(i)], ["Saved", "Yes"]]),
          { text: "See all", name: "Link", fill: brand },
          button("Continue button", "Continue"),
        ]));
      }
    }
    const varId = f.vars[BRAND.name] ?? "";
    const bound = Object.values(f.c.nodes).filter((n) => fillVariable(n) === varId);
    // every other node's fill: the update must leave them alone
    const others = Object.values(f.c.nodes).filter((n) => !bound.includes(n)).map((n) => [n, fillHex(n)] as const);
    return {
      c: f.c, brief,
      check() {
        const wrong = bound.filter((n) => fillHex(n) !== brief.to);
        const unbound = bound.filter((n) => fillVariable(n) !== varId).length;
        const touched = others.filter(([n, hex]) => fillHex(n) !== hex);
        const value = f.c.variables[varId]?.valuesByMode["1:0"];
        const held = isRgb(value) ? hexOf(value) : null;
        return {
          problems: [
            ...wrong.map((n) => `${n.name} ${n.id} shows ${String(fillHex(n))}`),
            ...(touched.length ? [`${touched.length} other fill(s) changed too (first: ${touched[0]?.[0].name} ${touched[0]?.[0].id})`] : []),
          ],
          gaps: [
            ...(unbound ? [`${unbound} of ${bound.length} fills were overwritten with a raw colour and are no longer bound to ${BRAND.name}`] : []),
            ...(held !== brief.to ? [`the variable ${BRAND.name} still holds ${String(held)}, so anything else bound to it stays old`] : []),
          ],
        };
      },
    };
  },
};

const repeatedPart: Job<"repeated-part"> = {
  id: "repeated-part", title: "Fault in a repeated part",
  what: "a wrong divider colour in a component with 18 instances on 6 screens",
  fixture() {
    const f = appFile();
    const screens = page(f, "Screens");
    const divider = f.row.children?.find((k) => k.name === "Divider");
    if (!divider) throw new Error("jobs: the list row has no Divider");
    divider.fills = [{ type: "SOLID", visible: true, color: rgb("#ff0000"), opacity: 1 }]; // the fault
    let inbox: CNode | null = null;
    for (const name of ["Inbox", "Archive", "Sent", "Drafts", "Spam", "Trash"]) {
      const s = build(f, screens, screen(name, [header(name)]));
      for (let i = 0; i < 3; i++) f.c.instance(s, f.row, {});
      inbox ??= s;
    }
    if (!inbox) throw new Error("jobs: no screens");
    const brief = { screenId: inbox.id, part: "Divider", to: "#e4e4e7" } as const;
    return {
      c: f.c, brief,
      check() {
        const shown = Object.values(f.c.nodes).filter((n) => n.name === "Divider" && n.id.startsWith("I"));
        const overridden = shown.filter((n) => Object.prototype.hasOwnProperty.call(n, "fills")).length;
        return {
          problems: [
            ...(shown.length !== 18 ? [`${shown.length} divider instances, wanted 18`] : []),
            ...shown.filter((n) => fillHex(n) !== brief.to).map((n) => `divider ${n.id} shows ${String(fillHex(n))}`),
            ...(fillHex(divider) !== brief.to ? [`the main component's divider shows ${String(fillHex(divider))}`] : []),
          ],
          gaps: overridden ? [`${overridden} instance(s) carry an override instead of following the main component`] : [],
        };
      },
    };
  },
};

// A new screen and the fix round its check leads to (docs/write-plane-spec.md decision 21: "verify and fix rounds"): the
// screen is built with a typo the agent only sees when it reads the result back, and the job is done when the page
// holds exactly one screen, the right one.
const fixRound: Job<"fix-round"> = {
  id: "fix-round", title: "New screen + fix round",
  what: "the 28-node settings screen built with one wrong text, read back, and the text fixed",
  fixture() {
    const f = appFile();
    const screens = page(f, "Screens");
    build(f, screens, settingsScreen("Home", "jane@example.com"));
    const before = new Set(Object.keys(f.c.nodes));
    const brief = { pageId: screens.id, want: settingsScreen("Settings", "jane@exmaple.com"), wrong: "jane@exmaple.com", right: "jane@example.com" };
    return { c: f.c, brief, check: () => checkNewScreens(f, screens, [settingsScreen("Settings", brief.right)], before) };
  },
};

// Starting from nothing (docs/write-plane-spec.md, "Starting from nothing"): a file with one empty page and no variables.
// The job is a small theme — primitives, the semantic colours that alias them in a light and a dark mode, two spacing
// numbers — and the settings screen with every colour bound to a semantic token. Done when the screen shows the light
// colours; the way a designer would have it when the tokens exist as given and the screen's fills are bound to them.
const TOKENS: readonly Token[] = [
  { name: "gray/0", type: "color", values: ["#ffffff", "#ffffff"] },
  { name: "gray/500", type: "color", values: [MUTED, MUTED] },
  { name: "gray/900", type: "color", values: ["#18181b", "#18181b"] },
  { name: "indigo/400", type: "color", values: ["#818cf8", "#818cf8"] },
  { name: "indigo/600", type: "color", values: [BRAND.hex, BRAND.hex] },
  { name: "color/bg", type: "color", values: [{ aliasOf: "gray/0" }, { aliasOf: "gray/900" }] },
  { name: "color/text", type: "color", values: [{ aliasOf: "gray/900" }, { aliasOf: "gray/0" }] },
  { name: "color/muted", type: "color", values: [{ aliasOf: "gray/500" }, { aliasOf: "gray/500" }] },
  { name: "color/brand", type: "color", values: [{ aliasOf: "indigo/600" }, { aliasOf: "indigo/400" }] },
  { name: "color/on-brand", type: "color", values: [{ aliasOf: "gray/0" }, { aliasOf: "gray/0" }] },
  { name: "space/sm", type: "number", values: [8, 8] },
  { name: "space/md", type: "number", values: [16, 16] },
];
/** A token's value in the first (light) mode, through its aliases. */
const lightOf = (name: string): Hex | number | null => {
  for (let at = TOKENS.find((t) => t.name === name), hops = 0; at && hops < 5; hops++) {
    const v = at.values[0];
    if (v === undefined) return null;
    if (typeof v !== "object") return v;
    at = TOKENS.find((t) => t.name === v.aliasOf);
  }
  return null;
};
/** The settings screen with every colour a semantic token: the screen's background, the texts, the muted values, the
 *  button and its label. */
function themed(w: Want): Want {
  if (!isFrame(w)) {
    const fill: WantFill = w.fill === MUTED ? { variable: "color/muted" } : w.fill === WHITE ? { variable: "color/on-brand" } : { variable: "color/text" };
    return { ...w, fill };
  }
  const fill: WantFill | undefined = w.fill === WHITE ? { variable: "color/bg" } : w.fill !== undefined ? { variable: "color/brand" } : undefined;
  const { fill: _old, children, ...rest } = w;
  return { ...rest, ...(fill ? { fill } : {}), ...(children ? { children: children.map(themed) } : {}) };
}
const startFromNothing: Job<"start-from-nothing"> = {
  id: "start-from-nothing", title: "Start from nothing",
  what: "a 12-token theme (light and dark, aliases) and the 28-node settings screen bound to it, in a file with no variables",
  fixture() {
    const c = canvas();
    const screens = c.page("Screens");
    const before = new Set(Object.keys(c.nodes));
    const want = themed(settingsScreen("Settings", "jane@example.com"));
    const brief = { pageId: screens.id, collection: "Theme", modes: ["Light", "Dark"], tokens: TOKENS, want };
    const variableNamed = (name: string): FakeVariable | undefined => Object.values(c.live().variables).find((v) => v.name === name);
    const vars: VarLookup = (name) => { const light = lightOf(name); return { hex: typeof light === "string" ? light : "#000000", id: variableNamed(name)?.id ?? null }; };
    return {
      c, brief,
      check() {
        const { problems, tally } = newScreens(vars, screens, [want], before);
        const live = c.live();
        const made = Object.values(live.variables);
        const gaps: string[] = [];
        if (!made.length) gaps.push(`the file still has no variables: the ${TOKENS.length} tokens were not made`);
        else {
          // A table was made: it must be the one asked for, mode by mode.
          for (const t of TOKENS) {
            const v = variableNamed(t.name);
            if (!v) { problems.push(`no variable ${t.name}`); continue; }
            const coll = live.collections[v.variableCollectionId];
            if (!coll || coll.name !== brief.collection || coll.modes.map((m) => m.name).join() !== brief.modes.join()) { problems.push(`${t.name} is not in the collection ${brief.collection} (${brief.modes.join(", ")})`); continue; }
            t.values.forEach((want, i) => {
              const modeId = coll.modes[i]?.modeId ?? "";
              const got: unknown = v.valuesByMode[modeId];
              const shown = typeof got === "object" && got !== null && "type" in got && got.type === "VARIABLE_ALIAS" && "id" in got
                ? { aliasOf: live.variables[String(got.id)]?.name ?? "?" }
                : typeof got === "object" && got !== null && "r" in got ? hexOf(got as Rgb) : got;
              if (JSON.stringify(shown) !== JSON.stringify(want)) problems.push(`${t.name} in ${coll.modes[i]?.name ?? "?"} is ${JSON.stringify(shown)}, wanted ${JSON.stringify(want)}`);
            });
          }
        }
        if (tally.unbound) gaps.push(`${tally.unbound} fill(s) are raw colours, not bound to the tokens`);
        if (tally.unnamedTexts) gaps.push(`${tally.unnamedTexts} text layer(s) keep their content as their name (the four ops cannot name a text)`);
        return { problems, gaps };
      },
    };
  },
};

// A blank file (#176): one empty page, no variables, no components. The job is the start of a design system — a few
// colour tokens (light and dark), a starter kit of components the screens will share, then one screen composed of the
// kit's instances, by name. Done when the components exist as asked (the button a set of size × state variants with
// its label, icon toggle and icon swap) and the screen shows the instances with their values; the way a designer would
// have it when the kit's colours are bound to the tokens.
const KIT_TOKENS: readonly Token[] = [
  { name: "color/bg", type: "color", values: ["#ffffff", "#18181b"] },
  { name: "color/text", type: "color", values: ["#18181b", "#fafafa"] },
  { name: "color/muted", type: "color", values: [MUTED, "#a1a1aa"] },
  { name: "color/border", type: "color", values: ["#d4d4d8", "#3f3f46"] },
  { name: "color/brand", type: "color", values: [BRAND.hex, "#818cf8"] },
  { name: "color/brand-hover", type: "color", values: ["#4338ca", "#6366f1"] },
  { name: "color/on-brand", type: "color", values: ["#ffffff", "#ffffff"] },
];
const STARTER: StarterKit = {
  icons: ["Icon/Plus", "Icon/Arrow"],
  button: { name: "Button", sizes: ["md", "sm"], states: ["default", "hover"], label: "Button" },
  input: { name: "Input", placeholder: "Placeholder" },
  card: { name: "Card", title: "Title", body: "Body" },
};
const SIGN_UP: KitScreen = {
  frame: "Sign up", title: "Create your account",
  card: { title: "Free for 30 days", body: "No card needed. Cancel any time." },
  inputs: ["Full name", "Email", "Password"],
  button: { size: "md", state: "default", label: "Create account", icon: "Icon/Arrow" },
};
const blankFile: Job<"blank-file"> = {
  id: "blank-file", title: "Blank file",
  what: "7 colour tokens (light and dark), a 5-component kit (2 icons, a 4-variant Button set with text, boolean and swap properties, an Input, a Card), then a sign-up screen of their instances",
  fixture() {
    const c = canvas();
    const screens = c.page("Screens");
    const before = new Set(Object.keys(c.nodes));
    const brief: Briefs["blank-file"] = { pageId: screens.id, collection: "Theme", modes: ["Light", "Dark"], tokens: KIT_TOKENS, kit: STARTER, screen: SIGN_UP };
    const all = (): CNode[] => Object.values(c.nodes).filter((n) => !before.has(n.id) && !n.id.startsWith("I"));
    const onPage = (n: CNode | null | undefined): boolean => (n ? n.type === "PAGE" || onPage(n.parent) : false);
    const mains = (type: string, name: string): CNode[] => all().filter((n) => n.type === type && n.name === name && onPage(n));
    const defsOf = (n: CNode): Array<{ name: string; type: string }> =>
      Object.entries((n.componentPropertyDefinitions ?? {}) as Record<string, { type: string }>).map(([k, d]) => ({ name: k.includes("#") ? k.slice(0, k.lastIndexOf("#")) : k, type: d.type }));
    const hasDef = (n: CNode, name: string, type: string): boolean => defsOf(n).some((d) => d.name === name && d.type === type);
    return {
      c, brief,
      check() {
        const problems: string[] = [];
        const gaps: string[] = [];
        let unbound = 0;
        const live = c.live();
        const madeVars = Object.values(live.variables);
        if (!madeVars.length) gaps.push(`the file still has no variables: the ${KIT_TOKENS.length} tokens were not made`);
        else for (const t of KIT_TOKENS) if (!madeVars.some((v) => v.name === t.name)) problems.push(`no variable ${t.name}`);
        // The kit: none made is a gap (the four ops cannot make one); one made must be as asked.
        const names = [...STARTER.icons, STARTER.button.name, STARTER.input.name, STARTER.card.name];
        const anyKit = names.some((n) => mains("COMPONENT", n).length + mains("COMPONENT_SET", n).length > 0);
        const one = (type: string, name: string): CNode | null => {
          const found = mains(type, name);
          if (found.length !== 1) { problems.push(`${found.length} ${type === "COMPONENT_SET" ? "component sets" : "components"} named "${name}", wanted 1`); return null; }
          return found[0] ?? null;
        };
        const kitParts: CNode[] = [];
        let button: CNode | null = null;
        let input: CNode | null = null;
        let card: CNode | null = null;
        if (!anyKit) gaps.push(`the file has no components: the ${names.length}-component kit was not made, so the screen is built node by node (a change to a button is a change to each copy)`);
        else {
          for (const name of STARTER.icons) { const i = one("COMPONENT", name); if (i) kitParts.push(i); }
          button = one("COMPONENT_SET", STARTER.button.name);
          if (button) {
            kitParts.push(button);
            const want = STARTER.button.sizes.flatMap((sz) => STARTER.button.states.map((st) => `Size=${sz}, State=${st}`));
            const got = (button.children ?? []).map((k) => k.name);
            if (JSON.stringify([...got].sort()) !== JSON.stringify([...want].sort())) problems.push(`Button's variants are ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
            if (!hasDef(button, "Label", "TEXT") || !hasDef(button, "Show icon", "BOOLEAN") || !hasDef(button, "Icon", "INSTANCE_SWAP")) problems.push(`Button's properties are ${JSON.stringify(defsOf(button))}, wanted Label (TEXT), Show icon (BOOLEAN), Icon (INSTANCE_SWAP)`);
          }
          input = one("COMPONENT", STARTER.input.name);
          if (input) { kitParts.push(input); if (!hasDef(input, "Placeholder", "TEXT")) problems.push("Input has no Placeholder TEXT property"); }
          card = one("COMPONENT", STARTER.card.name);
          if (card) { kitParts.push(card); if (!hasDef(card, "Title", "TEXT") || !hasDef(card, "Body", "TEXT")) problems.push("Card lacks its Title and Body TEXT properties"); }
        }
        const kidsOf = (n: CNode): CNode[] => n.children ?? [];
        const paints = (n: CNode): void => { for (const p of n.fills ?? []) if (!p.boundVariables?.color) unbound++; if (n.type !== "INSTANCE") for (const k of kidsOf(n)) paints(k); };
        for (const k of kitParts) for (const v of k.type === "COMPONENT_SET" ? kidsOf(k) : [k]) paints(v);
        const frames = (screens.children ?? []).filter((k) => k.name === SIGN_UP.frame && k.type === "FRAME");
        if (frames.length !== 1) problems.push(`${frames.length} frames named "${SIGN_UP.frame}" on Screens, wanted 1`);
        const screen = frames[0];
        if (screen) {
          paints(screen);
          // What the screen reads, in order, whether its parts are instances or frames.
          const texts = (n: CNode): string[] => kidsOf(n).flatMap((x) => (x.type === "TEXT" ? (x.visible === false ? [] : [String(x.characters ?? "")]) : texts(x)));
          const want = [SIGN_UP.title, SIGN_UP.card.title, SIGN_UP.card.body, ...SIGN_UP.inputs, SIGN_UP.button.label];
          if (JSON.stringify(texts(screen)) !== JSON.stringify(want)) problems.push(`the screen reads ${JSON.stringify(texts(screen))}, wanted ${JSON.stringify(want)}`);
          if (anyKit) {
            // Built from the kit: the parts are its instances, the button the variant asked for with its icon.
            const instances = (n: CNode): CNode[] => kidsOf(n).flatMap((k) => (k.type === "INSTANCE" ? [k] : instances(k)));
            const of = (k: CNode): CNode | null => (k.mainOf as CNode | undefined) ?? null;
            const inst = instances(screen);
            if (inst.filter((k) => of(k) === input).length !== SIGN_UP.inputs.length) problems.push(`the screen has ${inst.filter((k) => of(k) === input).length} Input instances, wanted ${SIGN_UP.inputs.length}`);
            if (inst.filter((k) => of(k) === card).length !== 1) problems.push("the screen has no Card instance");
            const buttons = inst.filter((k) => { const m = of(k); return m !== null && m.parent === button; });
            const b = buttons[0];
            const wantVariant = `Size=${SIGN_UP.button.size}, State=${SIGN_UP.button.state}`;
            if (buttons.length !== 1 || !b) problems.push(`${buttons.length} Button instances on the screen, wanted 1`);
            else {
              const props = (b.componentProperties ?? {}) as Record<string, { type: string; value: unknown }>;
              const by = (name: string): unknown => Object.entries(props).find(([k]) => k.startsWith(name + "#"))?.[1]?.value;
              const arrow = mains("COMPONENT", SIGN_UP.button.icon)[0];
              if (of(b)?.name !== wantVariant) problems.push(`the button is ${String(of(b)?.name)}, wanted ${wantVariant}`);
              if (by("Show icon") !== true || by("Icon") !== arrow?.id) problems.push(`the button's icon is ${JSON.stringify([by("Show icon"), by("Icon")])}, wanted shown and ${SIGN_UP.button.icon}`);
            }
          }
        }
        if (unbound) gaps.push(`${unbound} paint(s) are raw colours, not bound to the tokens`);
        return { problems, gaps };
      },
    };
  },
};

// An existing app's page to Figma (#175): capture-page has rendered a page and written its spec and images to disk
// (test/fixtures/capture/sample: a generic dashboard captured at 1280 px, 39 nodes). Done when the current page has
// exactly one new frame of the spec's name with the spec's texts in order and its node count; the way a designer would
// have it when its pictures landed too.
const CAPTURE_DIR = path.join(import.meta.dirname, "..", "fixtures", "capture", "sample");
const capturePage: Job<"capture-page"> = {
  id: "capture-page", title: "Capture a page",
  what: "a rendered 39-node dashboard page (flex, grid, text, 3 images) captured to a spec on disk, landed as one screen",
  fixture() {
    const f = appFile();
    const screens = page(f, "Screens");
    build(f, screens, settingsScreen("Home", "jane@example.com"));
    const before = new Set(Object.keys(f.c.nodes));
    const spec = JSON.parse(fs.readFileSync(path.join(CAPTURE_DIR, "sample@1280.json"), "utf8")) as CapturedNode;
    const images = fs.readdirSync(path.join(CAPTURE_DIR, "images")).sort();
    const capture: CapturedPage = { specFile: "design/capture/sample@1280.json", fixtureDir: CAPTURE_DIR, images };
    const textsOf = (n: CapturedNode): string[] => (n.text !== undefined ? [n.text] : (n.children ?? []).flatMap(textsOf));
    const countOf = (n: CapturedNode): number => 1 + (n.children ?? []).reduce((a, c) => a + countOf(c), 0);
    const imagesOf = (n: CapturedNode): number => (n.fills ?? []).filter((p) => p.type === "image").length + (n.children ?? []).reduce((a, c) => a + imagesOf(c), 0);
    return {
      c: f.c, brief: { pageId: screens.id, capture, spec },
      check() {
        const problems: string[] = [];
        const gaps: string[] = [];
        const made = (screens.children ?? []).filter((k) => k.name === spec.name && !before.has(k.id));
        if (made.length !== 1) return { problems: [`${made.length} new frames named "${String(spec.name)}" on Screens, wanted 1`], gaps };
        const root = made[0];
        if (!root) return { problems, gaps };
        const all = walk(root);
        const texts = all.filter((n) => n.type === "TEXT").map((n) => String(n.characters ?? ""));
        if (JSON.stringify(texts) !== JSON.stringify(textsOf(spec))) problems.push(`the screen reads ${JSON.stringify(texts.slice(0, 4))}…, wanted ${JSON.stringify(textsOf(spec).slice(0, 4))}…`);
        if (all.length !== countOf(spec)) problems.push(`the screen has ${all.length} nodes, wanted ${countOf(spec)}`);
        const pictures = all.reduce((a, n) => a + (n.fills ?? []).filter((p) => String(p.type) === "IMAGE").length, 0);
        if (pictures < imagesOf(spec)) gaps.push(`${imagesOf(spec) - pictures} of the page's ${imagesOf(spec)} images did not land (the four ops cannot place an image)`);
        return { problems, gaps };
      },
    };
  },
};

/** The six jobs, in the design record's order, then the fix round, starting from nothing, a blank file's kit and a
 *  captured page. */
export const JOBS = [newScreen, similarScreens, fixOneNode, sameChangeMany, colourUpdate, repeatedPart, fixRound, startFromNothing, blankFile, capturePage] as const;
export type AnyJob = (typeof JOBS)[number];
