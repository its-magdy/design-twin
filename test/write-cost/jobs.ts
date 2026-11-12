// The six jobs of the write-plane design record (docs/write-plane-spec.md, "The cheap route for each job"), each a
// file to start from, what the agent is told (its brief), and the check of the file afterwards.
//
// A job knows nothing about HOW it is done: a route (routes.ts) does it through the MCP tools, and the suite runs
// every route of every job on a fresh copy of the job's file. The check reads the file the plugin wrote, not the
// replies: `problems` (the job is not done; the route fails) and `gaps` (done, but not the way a designer would have
// it — a raw colour where the file has a variable, a text layer left with its content as its name; reported, not failed).
import { canvas, fillHex, fillVariable, hexOf, rgb, type Canvas, type CNode, type Fill, type Rgb } from "./canvas.ts";

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
function compare(n: CNode, want: Want, f: AppFile, at: string, out: string[], tally: Tally): void {
  const fillCheck = (w: WantFill | undefined): void => {
    if (w === undefined) return;
    const hex = typeof w === "string" ? w : BRAND.hex;
    if (fillHex(n) !== hex) out.push(`${at}: fill ${String(fillHex(n))}, wanted ${hex}`);
    else if (typeof w !== "string" && fillVariable(n) !== f.vars[w.variable]) tally.unbound++;
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
  wantKids.forEach((k, i) => { const kid = kids[i]; if (kid) compare(kid, k, f, `${at}/${isFrame(k) ? k.frame : JSON.stringify(k.text)}`, out, tally); });
}
const gapLines = (t: Tally): string[] => [
  ...(t.unbound ? [`${t.unbound} fill(s) are raw colours where the file has the variable ${BRAND.name}`] : []),
  ...(t.unnamedTexts ? [`${t.unnamedTexts} text layer(s) keep their content as their name (the four ops cannot name a text)`] : []),
];
/** The frames on `pageNode` named like `wants`, made by the route: exactly one each, compared with what was wanted. */
function checkNewScreens(f: AppFile, pageNode: CNode, wants: readonly Want[], before: ReadonlySet<string>): Verdict {
  const problems: string[] = [];
  const tally: Tally = { unbound: 0, unnamedTexts: 0 };
  for (const w of wants) {
    if (!isFrame(w)) continue;
    const made = (pageNode.children ?? []).filter((k) => k.name === w.frame && !before.has(k.id));
    if (made.length !== 1) { problems.push(`${made.length} new frames named "${w.frame}" on page "${pageNode.name}", wanted 1`); continue; }
    const root = made[0];
    if (root) compare(root, w, f, w.frame, problems, tally);
  }
  return { problems, gaps: gapLines(tally) };
}
/** Every node under `root` (instance sublayers included). */
const walk = (root: CNode): CNode[] => [root, ...(root.children ?? []).flatMap(walk)];

// ---- the jobs
/** What each job tells the agent. A route may use nothing else about the file: it has to find the rest. */
export interface Briefs {
  /** build `want` on the current page (`pageId`) */
  "new-screen": { pageId: string; want: Want };
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
}
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
  what: "a 28-node settings screen, four levels deep, on a page that has one screen",
  fixture() {
    const f = appFile();
    const screens = page(f, "Screens");
    build(f, screens, settingsScreen("Home", "jane@example.com"));
    const before = new Set(Object.keys(f.c.nodes));
    const want = settingsScreen("Settings", "jane@example.com");
    return { c: f.c, brief: { pageId: screens.id, want }, check: () => checkNewScreens(f, screens, [want], before) };
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

/** The six jobs, in the design record's order. */
export const JOBS = [newScreen, similarScreens, fixOneNode, sameChangeMany, colourUpdate, repeatedPart] as const;
export type AnyJob = (typeof JOBS)[number];
