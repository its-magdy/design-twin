// The routes: how an agent does each job through the MCP tools. The suite measures every route of every job.
//
// The baseline is `four-op`: today's figma_write with the four ops it started with (createFrame, createText, setFill,
// setText), plus the read tools to find ids. A route makes the calls a careful agent would make and reads their
// replies for what it needs (the ids a write returns, the nodes an outline lists); the agent's own reasoning is not
// modelled, only what crosses the tool boundary, which is what the measurement counts.
//
// The four-op route's rules, the same for every job:
//   - creating builds a tree level by level: one figma_write per level (a node's parentId is only known once the
//     write that made the parent has answered), at most 50 ops per call (figma_write's cap), every level of every
//     new screen batched together;
//   - a colour the file has as a variable is sent as its raw hex (the four ops cannot bind a variable);
//   - finding reads an outline (figma_export_url) of each screen it has to search, after figma_list_pages when the
//     job names no screen;
//   - a new screen is checked by one outline read of its root; a change to existing nodes is checked by the write's
//     own reply (ok, with the applied ids: the plugin fails an op it could not apply), so it costs no read.
//
// Adding a route (a later ticket): write its `jobs` entries (the jobs it has a cheaper way for) and add it to ROUTES.
// The suite runs it on the same fixtures, checks the file afterwards, and prints its cost beside the baseline; record
// its numbers with `bun test/write-cost.test.ts --record`.
import type { Phase } from "./meter.ts";
import { isFrame, type Briefs, type JobId, type Kit, type Want, type WantFill } from "./jobs.ts";
import { BRAND } from "./jobs.ts";

export interface Reply { text: string; isError: boolean }
/** The agent's side of the MCP connection: one tool call, measured. */
export interface Session { call(tool: string, args: Record<string, unknown>, phase: Phase): Promise<Reply> }
export type RouteRun<J extends JobId> = (s: Session, brief: Briefs[J]) => Promise<void>;
export interface Route {
  /** the route's name in the table and in baseline.json */
  name: string;
  /** the ticket that adds it */
  ticket: string;
  /** the jobs it has a way for (a job it leaves out is not run for it) */
  jobs: { [J in JobId]?: RouteRun<J> };
}

// ---- reading replies the way an agent does
/** A tool reply that is an error stops the route: the job failed. */
function must(r: Reply, what: string): string {
  if (r.isError) throw new Error(`${what} failed: ${r.text.slice(0, 400)}`);
  return r.text;
}
/** The ids a figma_write reply lists, in op order. */
function appliedIds(text: string): string[] {
  const r = JSON.parse(text) as { ok?: boolean; applied?: Array<{ id?: string }> };
  if (r.ok !== true || !Array.isArray(r.applied)) throw new Error(`figma_write did not apply: ${text.slice(0, 400)}`);
  return r.applied.map((a) => a.id ?? "");
}

/** One node line of an outline (bridge/src/outline.ts): `[TYPE] "name" #id … "text" … fill=#hex …`, indented two
 *  spaces per level. `$X` table references are expanded first. */
export interface OutlineNode { depth: number; type: string; name: string | null; id: string; text: string | null; fill: string | null; mainId: string | null; parent: OutlineNode | null }
export function parseOutline(text: string): OutlineNode[] {
  const lines = text.split("\n");
  const cut = lines.indexOf("---");
  const table = new Map<string, string>();
  for (const l of lines.slice(0, Math.max(cut, 0))) {
    const m = /^\$(\w+) (.*)$/.exec(l);
    if (m?.[1] !== undefined && m[2] !== undefined) table.set(m[1], m[2]);
  }
  const out: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  for (const raw of lines.slice(cut + 1)) {
    const l = raw.replace(/\$(\w+)/g, (all, k: string) => table.get(k) ?? all);
    const m = /^( *)\[(\w+)\](?: ("(?:[^"\\]|\\.)*"))? #(\S+)(.*)$/.exec(l);
    if (!m || m[2] === undefined || m[4] === undefined) continue;
    const depth = (m[1] ?? "").length / 2;
    const rest = m[5] ?? "";
    const quoted = /("(?:[^"\\]|\\.)*")/.exec(rest)?.[1];
    while (stack.length > depth) stack.pop();
    const n: OutlineNode = {
      depth, type: m[2], name: m[3] !== undefined ? (JSON.parse(m[3]) as string) : null, id: m[4],
      text: m[2] === "TEXT" && quoted !== undefined ? (JSON.parse(quoted) as string) : null,
      fill: /\bfill=(#[0-9a-fA-F]{6,8})/.exec(rest)?.[1]?.toLowerCase() ?? null,
      mainId: /→ \{name:"(?:[^"\\]|\\.)*",id:"([^"]+)"/.exec(rest)?.[1] ?? null,
      parent: stack.at(-1) ?? null,
    };
    out.push(n);
    stack.push(n);
  }
  return out;
}
const readOutline = async (s: Session, id: string, phase: Phase): Promise<OutlineNode[]> =>
  parseOutline(must(await s.call("figma_export_url", { url: id }, phase), `the outline of ${id}`));
/** The top-level frames of every page, from figma_list_pages (its default depth lists them). */
async function listScreens(s: Session): Promise<Array<{ id: string; name: string; type: string }>> {
  const r = JSON.parse(must(await s.call("figma_list_pages", {}, "find"), "figma_list_pages")) as { pages: Array<{ frames?: Array<{ id: string; name: string; type: string }> }> };
  return r.pages.flatMap((p) => p.frames ?? []).filter((f) => f.type === "FRAME");
}

// ---- the four ops
const chunks = <T>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const MAX_OPS = 50;
/** A colour as the four ops can send it: raw hex, a variable as the colour it holds. */
const rawHex = (f: WantFill): string => (typeof f === "string" ? f : f.variable === BRAND.name ? BRAND.hex : "#000000");
function createOp(w: Want, parentId: string | undefined): Record<string, unknown> {
  const parent = parentId !== undefined ? { parentId } : {};
  if (!isFrame(w)) return { op: "createText", text: w.text, ...(w.size !== undefined ? { fontSize: w.size } : {}), ...(w.fill !== undefined ? { fill: rawHex(w.fill) } : {}), ...parent };
  return {
    op: "createFrame", name: w.frame,
    ...(w.w !== undefined && w.h !== undefined ? { width: w.w, height: w.h } : {}),
    ...(w.layout ? { layoutMode: w.layout } : {}), ...(w.gap !== undefined ? { itemSpacing: w.gap } : {}),
    ...(w.padding ? { padding: w.padding } : {}), ...(w.fill !== undefined ? { fill: rawHex(w.fill) } : {}),
    ...parent,
  };
}
/** Build each tree, one write per level (several per level past 50 ops); the roots' ids, in order. */
async function buildLevels(s: Session, roots: ReadonlyArray<{ want: Want; parentId?: string }>): Promise<string[]> {
  let level = roots.map((r) => ({ want: r.want, parentId: r.parentId }));
  const rootIds: string[] = [];
  for (let depth = 0; level.length; depth++) {
    const next: typeof level = [];
    for (const chunk of chunks(level, MAX_OPS)) {
      const ids = appliedIds(must(await s.call("figma_write", { ops: chunk.map((c) => createOp(c.want, c.parentId)) }, "write"), "figma_write"));
      chunk.forEach((c, i) => {
        const id = ids[i] ?? "";
        if (depth === 0) rootIds.push(id);
        if (isFrame(c.want)) for (const k of c.want.children ?? []) next.push({ want: k, parentId: id });
      });
    }
    level = next;
  }
  return rootIds;
}
/** One op per node, in calls of at most 50. */
async function patch(s: Session, ops: ReadonlyArray<Record<string, unknown>>): Promise<void> {
  if (!ops.length) throw new Error("nothing to change was found");
  for (const chunk of chunks(ops, MAX_OPS)) appliedIds(must(await s.call("figma_write", { ops: chunk }, "write"), "figma_write"));
}

export const fourOp: Route = {
  name: "four-op",
  ticket: "baseline",
  jobs: {
    "new-screen": async (s, b) => {
      // A root with no parentId lands on the current page, which is the brief's page.
      const [root] = await buildLevels(s, [{ want: b.want }]);
      if (root !== undefined) await readOutline(s, root, "verify");
    },
    "similar-screens": async (s, b) => {
      await readOutline(s, b.sourceId, "find"); // what the existing screen is made of
      const roots = await buildLevels(s, b.want.map((want) => ({ want })));
      for (const id of roots) await readOutline(s, id, "verify");
    },
    "fix-one-node": async (s, b) => {
      const hit = (await readOutline(s, b.screenId, "find")).filter((n) => n.text === b.wrong);
      await patch(s, hit.map((n) => ({ op: "setText", nodeId: n.id, text: b.right })));
    },
    "same-change-many": async (s, b) => {
      const ops: Array<Record<string, unknown>> = [];
      for (const screen of await listScreens(s)) {
        for (const n of await readOutline(s, screen.id, "find")) if (n.text === b.from) ops.push({ op: "setText", nodeId: n.id, text: b.to });
      }
      await patch(s, ops);
    },
    "colour-update": async (s, b) => {
      const ops: Array<Record<string, unknown>> = [];
      for (const screen of await listScreens(s)) {
        for (const n of await readOutline(s, screen.id, "find")) if (n.fill === b.from) ops.push({ op: "setFill", nodeId: n.id, color: b.to });
      }
      await patch(s, ops);
    },
    "repeated-part": async (s, b) => {
      // The part sits inside an instance: the instance's line names its main component, whose outline has the part.
      const part = (await readOutline(s, b.screenId, "find")).find((n) => n.name === b.part);
      let inst = part?.parent ?? null;
      while (inst && inst.mainId === null) inst = inst.parent;
      if (!inst?.mainId) throw new Error(`no instance on the screen holds a "${b.part}"`);
      const inMain = (await readOutline(s, inst.mainId, "find")).filter((n) => n.name === b.part);
      await patch(s, inMain.map((n) => ({ op: "setFill", nodeId: n.id, color: b.to })));
    },
  },
};

// ---- the tree spec (#164): a new screen is one createTree op, so a screen of any depth is one write
/** `want` as a tree spec node (bridge/src/tree-spec.ts): the read export's field names. Colours are raw hex, as in the
 *  four-op route (binding a variable comes with design-system references). */
function treeOf(w: Want): Record<string, unknown> {
  const fills = w.fill !== undefined ? { fills: [{ type: "solid", color: rawHex(w.fill) }] } : {};
  if (!isFrame(w)) return { text: w.text, ...(w.name !== undefined ? { name: w.name } : {}), ...(w.size !== undefined ? { font: { size: w.size } } : {}), ...fills };
  const layout = w.layout ? {
    layout: { display: "flex", flexDirection: w.layout === "VERTICAL" ? "column" : "row", ...(w.gap !== undefined ? { gap: w.gap } : {}), ...(w.padding ? { padding: [...w.padding] } : {}) },
  } : {};
  return {
    name: w.frame, ...(w.w !== undefined && w.h !== undefined ? { box: { w: w.w, h: w.h } } : {}), ...layout, ...fills,
    ...(w.children?.length ? { children: w.children.map(treeOf) } : {}),
  };
}
/** Every screen in one figma_write (one createTree op each, at most 50 per call); the roots' ids, in order. */
async function buildTrees(s: Session, wants: readonly Want[]): Promise<string[]> {
  const ids: string[] = [];
  for (const chunk of chunks(wants, MAX_OPS)) {
    ids.push(...appliedIds(must(await s.call("figma_write", { ops: chunk.map((w) => ({ op: "createTree", tree: treeOf(w) })) }, "write"), "figma_write")));
  }
  return ids;
}

export const treeSpec: Route = {
  name: "tree-spec",
  ticket: "#164",
  jobs: {
    "new-screen": async (s, b) => {
      const [root] = await buildTrees(s, [b.want]);
      if (root !== undefined) await readOutline(s, root, "verify");
    },
    "similar-screens": async (s, b) => {
      await readOutline(s, b.sourceId, "find");
      for (const id of await buildTrees(s, b.want)) await readOutline(s, id, "verify");
    },
  },
};

// ---- design-system references (#165): the same tree spec, composed from the file's design system by name
/** `want` as a tree spec that names the kit: a frame the kit has as a component (its texts named after the
 *  component's TEXT properties) becomes an instance with those property values, and a colour variable is named on
 *  the paint instead of sent as its hex. Everything else is as treeOf writes it. */
function dsTreeOf(w: Want, kit: Kit): Record<string, unknown> {
  const fills = w.fill === undefined ? {} : { fills: [typeof w.fill === "string" ? { type: "solid", color: w.fill } : { type: "solid", tokens: { color: w.fill.variable } }] };
  if (!isFrame(w)) {
    const { fill: _raw, ...text } = w;
    return { ...treeOf(text), ...fills };
  }
  // A frame the kit has as a component, whose children are exactly texts its TEXT properties drive: an instance. Its
  // look (sizes, layout, the texts' colours) comes from the component.
  const props = kit.components[w.frame];
  const kids = w.children ?? [];
  const values: Array<[string, string]> = [];
  for (const k of kids) if (!isFrame(k) && k.name !== undefined && props?.includes(k.name)) values.push([k.name, k.text]);
  if (props && kids.length && values.length === kids.length) return { component: w.frame, props: Object.fromEntries(values) };
  const { fill: _raw, children: _kids, ...frame } = w;
  return { ...treeOf(frame), ...fills, ...(kids.length ? { children: kids.map((k) => dsTreeOf(k, kit)) } : {}) };
}

export const dsRefs: Route = {
  name: "ds-refs",
  ticket: "#165",
  jobs: {
    "new-screen": async (s, b) => {
      const r = must(await s.call("figma_write", { ops: [{ op: "createTree", tree: dsTreeOf(b.want, b.kit) }] }, "write"), "figma_write");
      const [root] = appliedIds(r);
      if (root !== undefined) await readOutline(s, root, "verify");
    },
  },
};

// ---- patch by id (#168): an existing node changed by id through one typed op. Finding the node still takes the
// outline read (the job names a screen, not a node); the change is one `patch` op whose `set` names the read export's
// field, and its reply is checked like the four-op route's: ok, with the node's id.
export const patchById: Route = {
  name: "patch",
  ticket: "#168",
  jobs: {
    "fix-one-node": async (s, b) => {
      const hit = (await readOutline(s, b.screenId, "find")).filter((n) => n.text === b.wrong);
      await patch(s, hit.map((n) => ({ op: "patch", nodeId: n.id, set: { text: b.right } })));
    },
  },
};

/** Every route the suite measures; the first is the baseline the others are compared with. */
export const ROUTES: readonly Route[] = [fourOp, treeSpec, dsRefs, patchById];
export const BASELINE = fourOp.name;
