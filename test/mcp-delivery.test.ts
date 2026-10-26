// MCP delivery: how an export tool hands its read back — inline, written to disk (asked for, or on its own
// because it would not fit), or refused — and what the result says about the files a write replaced or kept.
//   - delivery.ts, the pure step: decideDelivery (inline / spill / refuse) and describeWrite (the note, and the
//     .prev it points at), from write-out's change report;
//   - write-out.ts's change report (`changes`, under keepPrev): the .prev files a write kept, the layer files it
//     replaced, and the .prev files an earlier write left that are still on disk;
//   - the real tools, in process: figma-mcp.ts loaded as a module (it starts no server on import) and driven over
//     an in-memory transport, its route going through a recording daemon (read-plan-e2e's pattern);
//   - both launches still serve: `bun figma-mcp.ts` and `dtwin mcp` (which imports the module, so it must start
//     the server itself).
//   bun test/mcp-delivery.test.ts
// Binds the daemon socket for FIGMA_BRIDGE_PORT=8789, like cli-pull, read-plan-e2e and mcp-smoke: the runner runs
// suites one at a time, never beside them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { check, report } from "./assert.ts";
import { manifest, screenReply, clientRow, node, variable } from "./fixtures.ts";
import * as daemon from "../bridge/src/daemon.ts";
import { addressAt } from "./bridge-settings.ts";
import * as W from "../bridge/src/write-out.ts";
import type { Cmd, Commands, ScreenshotReply } from "../bridge/src/commands.ts";
import type { DaemonBridge } from "../bridge/src/daemon.ts";
import type { ChangeReport } from "../bridge/src/write-out.ts";
import type { DesignSystemDoc } from "../bridge/src/doc-types.ts";

const PORT = 8789;
const TOKEN = "mcp-delivery-token";
const ROOT = path.join(import.meta.dirname, "..");
const MCP = path.join(ROOT, "bridge", "src", "figma-mcp.ts");
const CLI = path.join(ROOT, "bridge", "src", "figma-pull.ts");

const D = await import("../bridge/src/delivery.ts").catch((e: unknown) => {
  check("bridge/src/delivery.ts loads — " + (e instanceof Error ? e.message : String(e)), false);
  report();
  throw e;
});

// ---------------------------------------------------------------- delivery.ts: decideDelivery
console.log("\ndecideDelivery — inline, spill or refuse:");
const LIMIT = 48000;
const WHY = "this export is past the 48,000 characters (~12k tokens) the client accepts inline (Claude Code keeps larger results out of the conversation, and MAX_MCP_OUTPUT_TOKENS can only lower this)";
const BASE = "Export written to disk; node payloads intentionally omitted from this result. Read the files under outDir (start with the index) to inspect them at your own granularity.";
const SPILLED = `Written to disk WITHOUT being asked: ${WHY}, so returning it inline would have been cut off mid-JSON. `;
{
  let measured: number[] = [];
  const fits = (limit: number): string | null => { measured.push(limit); return "{\"small\":true}"; };
  const big = (limit: number): string | null => { measured.push(limit); return null; };
  const json = (x: unknown): string => JSON.stringify(x);

  measured = [];
  const explicit = D.decideDelivery(true, fits, LIMIT);
  check("writeToDisk:true → an explicit write, and the result is never measured", json(explicit) === json({ kind: "write", implicit: false }) && measured.length === 0);
  measured = [];
  const omitted = D.decideDelivery(undefined, fits, LIMIT);
  check("writeToDisk omitted, fits → inline with the measured text, measured against the limit", json(omitted) === json({ kind: "inline", text: "{\"small\":true}" }) && json(measured) === "[48000]");
  check("writeToDisk:false, fits → inline", json(D.decideDelivery(false, fits, LIMIT)) === json({ kind: "inline", text: "{\"small\":true}" }));
  const spill = D.decideDelivery(undefined, big, LIMIT);
  check("writeToDisk omitted, too big → an implicit write, with why", json(spill) === json({ kind: "write", implicit: true, why: WHY }));
  const refuse = D.decideDelivery(false, big, LIMIT);
  check("writeToDisk:false, too big → refused, naming the size and both ways out",
    json(refuse) === json({ kind: "refuse", message: `${WHY}, and writeToDisk:false was passed. Omit it (or pass true) to get the files plus a compact index, or narrow the scope (a node id instead of a page, a lower depth).` }));
  const small = D.decideDelivery(undefined, () => null, 1600);
  check("a lowered limit is named as such (1,600 characters, ~0k tokens — as the server has always rounded it)",
    small.kind === "write" && small.implicit && small.why.startsWith("this export is past the 1,600 characters (~0k tokens)"));
}

// ---------------------------------------------------------------- delivery.ts: describeWrite
console.log("\ndescribeWrite — the note, and the .prev it points at:");
{
  const none: ChangeReport = { kept: [], replaced: [], earlier: [] };
  const explicit = { kind: "write" as const, implicit: false as const };
  const implicit = { kind: "write" as const, implicit: true as const, why: WHY };
  const S = "/p/design/export/pages/Home/Sample__1_2.json";
  const DIR = "/p/design/export";
  const eq = (name: string, got: unknown, want: unknown): void => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    check(name, ok);
    if (!ok) console.log(`    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
  };
  // screen
  eq("explicit screen write: the plain note, no prev, the screen file", D.describeWrite(explicit, { kind: "screen", dir: DIR, screen: S, changes: { ...none, kept: [S + ".prev"] } }),
    { note: BASE, file: S });
  eq("implicit screen spill, first one: no replaced text", D.describeWrite(implicit, { kind: "screen", dir: DIR, screen: S, changes: none }),
    { note: SPILLED + BASE, file: S });
  eq("implicit screen spill over a different file: replaced + kept, prev = the new .prev", D.describeWrite(implicit, { kind: "screen", dir: DIR, screen: S, changes: { ...none, kept: [S + ".prev"] } }),
    { note: SPILLED + `It replaced ${S}; the previous version is kept at ${S}.prev (one level — the next implicit spill replaces it). ` + BASE, file: S, prev: S + ".prev" });
  eq("implicit screen re-spill, unchanged: the earlier .prev, named", D.describeWrite(implicit, { kind: "screen", dir: DIR, screen: S, changes: { ...none, earlier: [S + ".prev"] } }),
    { note: SPILLED + `An earlier version is still at ${S}.prev (this export matched what was on disk). ` + BASE, file: S, prev: S + ".prev" });
  eq("implicit screen spill with no change report: as one with nothing kept", D.describeWrite(implicit, { kind: "screen", dir: DIR, screen: S }),
    { note: SPILLED + BASE, file: S });
  // screenshot
  eq("explicit screenshot: the PNG is the file", D.describeWrite(explicit, { kind: "screenshot", dir: DIR, reference: "assets/1_2_ref.png", changes: none }),
    { note: BASE, file: path.join(DIR, "assets/1_2_ref.png") });
  eq("implicit screenshot: the spill line only (a screenshot keeps no .prev)", D.describeWrite(implicit, { kind: "screenshot", dir: DIR, reference: "assets/1_2_ref.png", changes: { ...none, earlier: ["/x.prev"] } }),
    { note: SPILLED + BASE, file: path.join(DIR, "assets/1_2_ref.png") });
  // full / design system
  const L1 = DIR + "/pages/Home/Panel__5_1.json", L2 = DIR + "/pages/Home/Sheet__5_2.json";
  eq("explicit export: no prevKept, the plain note", D.describeWrite(explicit, { kind: "export", dir: DIR, changes: { kept: [L1 + ".prev"], replaced: [L1], earlier: ["/e.prev"] } }),
    { note: BASE, file: DIR });
  eq("implicit export, kept + replaced", D.describeWrite(implicit, { kind: "export", dir: DIR, changes: { kept: [L1 + ".prev", DIR + "/design-system/tokens.json.prev"], replaced: [L1, L2], earlier: ["/e.prev"] } }),
    { note: SPILLED + `It replaced 2 existing screen file(s) under ${path.join(DIR, "pages")}. The previous version of each changed file — 2 file(s) under pages/ or design-system/ (or design-system.json), e.g. ${L1}.prev — is kept beside it as <file>.prev (one level — the next implicit spill replaces it). ` + BASE, file: DIR, prevKept: 2 });
  eq("implicit export, kept, nothing replaced (a design-system spill)", D.describeWrite(implicit, { kind: "export", dir: DIR, changes: { ...none, kept: [DIR + "/design-system/tokens.json.prev"] } }),
    { note: SPILLED + `The previous version of each changed file — 1 file(s) under pages/ or design-system/ (or design-system.json), e.g. ${DIR}/design-system/tokens.json.prev — is kept beside it as <file>.prev (one level — the next implicit spill replaces it). ` + BASE, file: DIR, prevKept: 1 });
  eq("implicit export, nothing kept, earlier .prev files, replaced", D.describeWrite(implicit, { kind: "export", dir: DIR, changes: { kept: [], replaced: [L1], earlier: ["/a.prev", "/b.prev"] } }),
    { note: SPILLED + `It replaced 1 existing screen file(s) under ${path.join(DIR, "pages")}. Earlier versions are still kept as 2 .prev file(s) beside their files (this export matched what was on disk). ` + BASE, file: DIR, prevKept: 0 });
  eq("implicit export, nothing kept, earlier .prev files, nothing replaced", D.describeWrite(implicit, { kind: "export", dir: DIR, changes: { ...none, earlier: ["/a.prev"] } }),
    { note: SPILLED + "Earlier versions are still kept as 1 .prev file(s) beside their files (this export matched what was on disk). " + BASE, file: DIR, prevKept: 0 });
  eq("implicit export, nothing kept, none earlier, replaced", D.describeWrite(implicit, { kind: "export", dir: DIR, changes: { ...none, replaced: [L1, L2] } }),
    { note: SPILLED + `It replaced 2 existing screen file(s) under ${path.join(DIR, "pages")} (none differed from what was on disk, so no .prev was kept). ` + BASE, file: DIR, prevKept: 0 });
  eq("implicit export into a fresh dir: the spill line only, prevKept 0", D.describeWrite(implicit, { kind: "export", dir: DIR, changes: none }),
    { note: SPILLED + BASE, file: DIR, prevKept: 0 });
}

// ---------------------------------------------------------------- write-out.ts: the change report
console.log("\nwrite-out — the change report a write returns under keepPrev:");
const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-delivery-")));
const PNG = (() => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(4, 16); b.writeUInt32BE(3, 20);
  return b.toString("base64");
})();
let size = 3; // children / variables per reply: 3 fits inline, 2000 does not
let label = "A"; // a design change
const kids = () => Array.from({ length: size }, (_, i) => ({ id: "9:" + i, name: label + " row " + i, type: "FRAME" as const, box: { x: 0, y: i * 40, w: 390, h: 40 } }));
const designSystem = (): DesignSystemDoc => ({ file: "Delivery File", exportedAt: new Date().toISOString(), collections: [], components: [],
  styles: { paint: [], text: [], effect: [], grid: [] }, hygiene: [],
  variables: Array.from({ length: size }, (_, i) => variable({ name: label + "/var" + i, type: "COLOR", values: {} })) });
const screen = () => screenReply({ screenName: "Sample", screen: { exportedAt: new Date().toISOString(), nodes: [{ id: "1:2", type: "FRAME", name: "Sample", children: kids() }] }, page: "Home", pageId: "0:1", nodeId: "1:2" });
const full = () => ({ designSystem: designSystem(), layersDoc: { exportedAt: new Date().toISOString(), manifest: manifest(), index: [],
  layers: [{ page: "Home", pageId: "0:1", name: "Panel", id: "5:1", tree: node({ id: "5:1", name: "Panel", type: "FRAME", children: kids() }) }] }, assets: [] });
const shot = (): ScreenshotReply => ({ id: "1:2", name: "Sample", type: "FRAME", reference: "assets/1_2_ref.png", w: 4, h: 3, scale: 1, manifest: manifest(),
  assets: [{ id: "1:2", name: "Sample", format: "png", file: "1_2_ref.png", base64: PNG, kind: "reference" }] });
const changesOf = (r: object): ChangeReport | undefined => ("changes" in r ? (r.changes as ChangeReport | undefined) : undefined);
const json = (x: unknown): string => JSON.stringify(x);
{
  const out = path.join(work, "wo-screen");
  const S = path.join(out, "pages", "Home", "Sample__1_2.json");
  check("no keepPrev (the CLI, an explicit write) → no change report at all", changesOf(W.writeScreen(out, screen())) === undefined);
  check("…and none from writeAny either", changesOf(W.writeAny(out, screen())) === undefined);
  label = "B";
  check("keepPrev, a differing screen → kept is its .prev, nothing earlier", json(changesOf(W.writeScreen(out, screen(), undefined, { keepPrev: true }))) === json({ kept: [S + ".prev"], replaced: [], earlier: [] }));
  check("keepPrev, unchanged → nothing kept, the .prev from before is earlier", json(changesOf(W.writeScreen(out, screen(), undefined, { keepPrev: true }))) === json({ kept: [], replaced: [], earlier: [S + ".prev"] }));
  check("writeAny forwards keepPrev and returns the report", json(changesOf(W.writeAny(out, screen(), undefined, { keepPrev: true }))) === json({ kept: [], replaced: [], earlier: [S + ".prev"] }));
  const fresh = path.join(work, "wo-screen-fresh");
  check("keepPrev into an empty dir → an empty report", json(changesOf(W.writeScreen(fresh, screen(), undefined, { keepPrev: true }))) === json({ kept: [], replaced: [], earlier: [] }));

  const fout = path.join(work, "wo-full");
  label = "A";
  const first = W.writeExport(fout, full(), undefined, { keepPrev: true });
  check("a full write into an empty dir: nothing kept, replaced or earlier", json(changesOf(first)) === json({ kept: [], replaced: [], earlier: [] }));
  const layer = path.join(fout, "pages", "Home", "Panel__5_1.json");
  // .prev files an earlier write could have left: a screen's under pages/, the manifest's at the root, a library's —
  // and two the walk never reads (assets/ is not a tree a spill keeps .prev in; neither is a stray directory).
  const planted = [path.join(fout, "pages", "Home", "Other__1_9.json.prev"), path.join(fout, "design-system.json.prev"), path.join(fout, "libraries", "lib-x", "tokens.json.prev")];
  const ignored = [path.join(fout, "assets", "x.svg.prev"), path.join(fout, "other", "y.json.prev")];
  for (const f of [...planted, ...ignored]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "{}"); }
  label = "B";
  const second = W.writeExport(fout, full(), undefined, { keepPrev: true });
  const c2 = changesOf(second);
  const keptRaw: unknown = "prevKept" in second.wrote ? second.wrote.prevKept : undefined;
  check("a differing full write: kept is exactly wrote.prevKept", !!c2 && c2.kept.length > 0 && json(c2.kept) === json(keptRaw));
  check("…replaced is the layer file that was on disk", !!c2 && json(c2.replaced) === json([layer]));
  check("…earlier is the planted .prev files under pages/, design-system/, libraries/ and the root (not assets/ or another dir), none of the kept ones",
    !!c2 && json([...c2.earlier].sort()) === json([...planted].sort()));
  const third = changesOf(W.writeExport(fout, full(), undefined, { keepPrev: true }));
  check("an unchanged full write: nothing kept, the layer replaced, every .prev under those trees earlier",
    !!third && third.kept.length === 0 && json(third.replaced) === json([layer]) && json([...third.earlier].sort()) === json([...planted, ...(c2?.kept ?? [])].sort()));
  check("no keepPrev → no change report from writeExport", changesOf(W.writeExport(fout, full())) === undefined);

  const dsout = path.join(work, "wo-ds");
  W.writeExport(dsout, { designSystem: designSystem() }, undefined, { keepPrev: true });
  label = "C";
  const ds = changesOf(W.writeExport(dsout, { designSystem: designSystem() }, undefined, { keepPrev: true }));
  check("a design-system write replaces no layer file, and keeps its changed tokens", !!ds && ds.replaced.length === 0 && ds.kept.some((f) => f.endsWith(path.join("design-system", "tokens.json.prev"))));

  const sout = path.join(work, "wo-shot");
  check("a screenshot under keepPrev → an empty report (assets are never replaced)", json(changesOf(W.writeAny(sout, shot(), undefined, { keepPrev: true }))) === json({ kept: [], replaced: [], earlier: [] }));
  check("…and none without it", changesOf(W.writeAny(sout, shot())) === undefined);
}

// ---------------------------------------------------------------- the recording daemon
let asked = 0;
const client = clientRow({ connId: "c1", file: "Delivery File", fileKey: "DKEY" });
const replies: Record<string, () => unknown> = {
  ping: () => ({ pong: true }),
  exportNode: screen,
  exportSelection: screen,
  exportDesignSystem: () => ({ designSystem: designSystem() }),
  exportFull: full,
  screenshot: shot,
};
const fake: DaemonBridge = {
  port: PORT, isConnected: () => true, close() {}, listClients: () => [client],
  async request<C extends Cmd>(cmd: C) {
    if (cmd !== "ping") asked++;
    const r = replies[cmd];
    if (!r) throw new Error("the recording daemon does not answer " + cmd);
    return { reply: r() as Commands[C]["reply"], client };
  },
};
for (const k of ["FIGMA_BRIDGE_TOKEN_FILE", "DTWIN_PORT", "FIGMA_EXPORT_DIR", "MAX_MCP_OUTPUT_TOKENS"]) delete process.env[k];
process.env.FIGMA_BRIDGE_PORT = String(PORT);
process.env.FIGMA_BRIDGE_TOKEN = TOKEN;
const served = await daemon.serve(fake, addressAt(PORT, TOKEN), { idleMs: 0, signals: false });

// ---------------------------------------------------------------- figma-mcp.ts, in process
console.log("\nfigma-mcp.ts loaded as a module starts nothing:");
const app = path.join(work, "app");
fs.mkdirSync(app);
const was = process.cwd();
process.chdir(app); // the server's outDir rule is relative to ITS cwd: in process, this one
const listeners = () => ({ term: process.listenerCount("SIGTERM"), int: process.listenerCount("SIGINT"), out: process.stdout.listenerCount("error"), stdin: process.stdin.listenerCount("data") });
const before = listeners();
const mod = await import("../bridge/src/figma-mcp.ts");
check("importing it installs no signal handler, stdout guard or stdin reader (main() did not run)", json(listeners()) === json(before));
check("it exports the server and the way to start it", typeof mod.runServer === "function" && typeof mod.server === "object" && mod.server !== null);

const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await mod.server.connect(serverSide);
const mc = new Client({ name: "mcp-delivery", version: "0.0.0" });
await mc.connect(clientSide);
type Got = { isError: boolean; text: string; json: Record<string, unknown> };
const textOf = (r: Awaited<ReturnType<typeof mc.callTool>>): string => {
  const c: unknown = r.content;
  const first: unknown = Array.isArray(c) ? c[0] : undefined;
  return first && typeof first === "object" && "text" in first && typeof first.text === "string" ? first.text : "";
};
const parse = (t: string): Record<string, unknown> => { try { const v: unknown = JSON.parse(t); return v && typeof v === "object" ? (v as Record<string, unknown>) : {}; } catch { return {}; } };
const rec = (x: unknown): Record<string, unknown> => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});
async function call(name: string, a: Record<string, unknown>): Promise<Got & { asked: boolean; lastWrite: Record<string, unknown> | null }> {
  const n0 = asked;
  const r = await mc.callTool({ name, arguments: a });
  const t = textOf(r);
  const st = parse(textOf(await mc.callTool({ name: "figma_status", arguments: {} })));
  return { isError: r.isError === true, text: t, json: parse(t), asked: asked > n0, lastWrite: st.lastWrite ? rec(st.lastWrite) : null };
}
const exp = path.join(app, "design", "export");
const S = path.join(exp, "pages", "Home", "Sample__1_2.json");
const isInline = (g: Got): boolean => !g.isError && g.json.note === undefined && g.json.durationMs !== undefined;
const noteOf = (g: Got): string => String(g.json.note ?? "");
const keysOf = (o: Record<string, unknown> | null): string => (o ? Object.keys(o).join(",") : "null");

console.log("\nthe export tools, end to end — screens:");
{
  size = 3; label = "A";
  const inline = await call("figma_export_url", { url: "1:2" });
  check("fits, writeToDisk omitted → inline (the stripped reply + durationMs), nothing recorded", isInline(inline) && Array.isArray(rec(inline.json.screen).nodes) && inline.lastWrite === null);
  check("fits, writeToDisk:false → inline", isInline(await call("figma_export_url", { url: "1:2", writeToDisk: false })));
  const named = await call("figma_export_url", { url: "1:2", outDir: "named" });
  check("fits, a named outDir → still inline, and nothing written there", isInline(named) && !fs.existsSync(path.join(app, "named")));
  size = 2000;
  const refused = await call("figma_export_url", { url: "1:2", writeToDisk: false });
  check("too big, writeToDisk:false → an error naming the size", refused.isError && refused.text.startsWith(`${WHY}, and writeToDisk:false was passed.`) && refused.lastWrite === null);
  const first = await call("figma_export_url", { url: "1:2" });
  check("too big, omitted → spilled: the spill line, no replaced text, no wrote.prev",
    !first.isError && noteOf(first) === SPILLED + BASE && rec(first.json.wrote).prev === undefined && first.json.changes === undefined);
  check("…lastWrite {implicit, the screen file}, no prev", json(first.lastWrite && { ...first.lastWrite, at: "-" }) === json({ tool: "figma_export_url", at: "-", implicit: true, file: S }));
  label = "B";
  const differs = await call("figma_export_url", { url: "1:2" });
  check("a spill over a different screen keeps its .prev: note, wrote.prev and lastWrite.prev name it",
    noteOf(differs) === SPILLED + `It replaced ${S}; the previous version is kept at ${S}.prev (one level — the next implicit spill replaces it). ` + BASE &&
    rec(differs.json.wrote).prev === S + ".prev" && differs.lastWrite?.prev === S + ".prev");
  const same = await call("figma_export_url", { url: "1:2" });
  check("a re-spill of the unchanged design names the earlier .prev, and lastWrite keeps pointing at it",
    noteOf(same) === SPILLED + `An earlier version is still at ${S}.prev (this export matched what was on disk). ` + BASE && rec(same.json.wrote).prev === undefined && same.lastWrite?.prev === S + ".prev");
  const explicit = await call("figma_export_url", { url: "1:2", writeToDisk: true });
  check("an explicit write: the plain note (the .prev on disk unmentioned), lastWrite implicit:false with no prev",
    noteOf(explicit) === BASE && json(explicit.lastWrite && { ...explicit.lastWrite, at: "-" }) === json({ tool: "figma_export_url", at: "-", implicit: false, file: S }));
  check("the written result keeps its shape: outDir, wrote, durationMs, note — and no change report", keysOf(explicit.json) === "outDir,wrote,durationMs,note");
}

console.log("\nthe export tools, end to end — full and design system:");
{
  size = 3; label = "A";
  check("a small full export comes back inline", isInline(await call("figma_export_full", {})));
  size = 2000;
  const spill = await call("figma_export_full", {});
  const kept = rec(spill.json.wrote).prevKept;
  check("a full spill over the screen pull: the two pages/ indexes kept, listed in wrote.prevKept, counted in the note and lastWrite",
    Array.isArray(kept) && kept.length === 2 && noteOf(spill).startsWith(SPILLED + "The previous version of each changed file — 2 file(s) under pages/ or design-system/ (or design-system.json), e.g. ") && spill.lastWrite?.prevKept === 2 && spill.lastWrite.file === exp);
  check("…with the export's written shape (outDir, wrote, index, durationMs, note)", keysOf(spill.json) === "outDir,wrote,index,durationMs,note");
  label = "B";
  const differs = await call("figma_export_full", {});
  check("a differing full spill says it replaced the layer file, and keeps the changed ones",
    noteOf(differs).startsWith(SPILLED + `It replaced 1 existing screen file(s) under ${path.join(exp, "pages")}. The previous version of each changed file — 2 file(s)`) && differs.lastWrite?.prevKept === 2);
  const same = await call("figma_export_full", {});
  check("an unchanged full spill counts every .prev under the export (the screen's too), prevKept 0",
    noteOf(same) === SPILLED + `It replaced 1 existing screen file(s) under ${path.join(exp, "pages")}. Earlier versions are still kept as 5 .prev file(s) beside their files (this export matched what was on disk). ` + BASE && same.lastWrite?.prevKept === 0);
  const explicit = await call("figma_export_full", { writeToDisk: true });
  check("an explicit full write: the plain note, no prevKept anywhere", noteOf(explicit) === BASE && rec(explicit.json.wrote).prevKept === undefined && explicit.lastWrite?.prevKept === undefined);
  const fresh1 = await call("figma_export_full", { outDir: "fresh" });
  const fresh2 = await call("figma_export_full", { outDir: "fresh" });
  check("into a fresh dir: the spill line alone, then the 'none differed' line",
    noteOf(fresh1) === SPILLED + BASE && noteOf(fresh2) === SPILLED + `It replaced 1 existing screen file(s) under ${path.join(app, "fresh", "pages")} (none differed from what was on disk, so no .prev was kept). ` + BASE && fresh2.lastWrite?.prevKept === 0);
  size = 3;
  check("a small design-system export comes back inline", isInline(await call("figma_export_design_system", {})));
  size = 2000; label = "D";
  const ds = await call("figma_export_design_system", {});
  check("a differing design-system spill keeps tokens.json.prev and never says it replaced a screen file",
    noteOf(ds) === SPILLED + `The previous version of each changed file — 1 file(s) under pages/ or design-system/ (or design-system.json), e.g. ${path.join(exp, "design-system", "tokens.json.prev")} — is kept beside it as <file>.prev (one level — the next implicit spill replaces it). ` + BASE && ds.lastWrite?.prevKept === 1);
  const dsSame = await call("figma_export_design_system", {});
  check("an unchanged design-system spill counts the .prev files under pages/ too (as it always has)",
    noteOf(dsSame) === SPILLED + "Earlier versions are still kept as 5 .prev file(s) beside their files (this export matched what was on disk). " + BASE);
}

console.log("\nthe export tools, end to end — screenshots:");
{
  const inline = await call("figma_screenshot", { nodeId: "1:2" });
  check("writeToDisk omitted → inline, the PNG bytes stripped", isInline(inline) && JSON.stringify(inline.json).includes("Asset bytes omitted") && !inline.text.includes(PNG));
  const wrote = await call("figma_screenshot", { nodeId: "1:2", writeToDisk: true });
  check("writeToDisk:true → w/h/scale, png, the plain note; lastWrite.file is the PNG",
    keysOf(wrote.json) === "w,h,scale,outDir,reference,png,wrote,durationMs,note" && noteOf(wrote) === BASE && wrote.lastWrite?.file === path.join(exp, "assets", "1_2_ref.png"));
  const half = await call("figma_screenshot", { nodeId: "1:2", writeToDisk: true, scale: 0.5 });
  check("…a scale gets its own file", half.lastWrite?.file === path.join(exp, "assets", "1_2_shot@0.5x.png") && fs.existsSync(path.join(exp, "assets", "1_2_shot@0.5x.png")));
}

console.log("\nthe export tools, end to end — outDir:");
{
  size = 3;
  const bad = await call("figma_export_url", { url: "1:2", outDir: "../x" });
  check("a named outDir outside the cwd is refused before the read", bad.isError && /outDir must stay inside/.test(bad.text) && !bad.asked);
  const badInline = await call("figma_export_url", { url: "1:2", outDir: "../x", writeToDisk: false });
  check("…unless writeToDisk:false (nothing is written, so nothing is checked)", isInline(badInline) && badInline.asked);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-delivery-outside-"));
  process.env.FIGMA_EXPORT_DIR = outside;
  try {
    check("FIGMA_EXPORT_DIR outside the cwd, fits → inline", isInline(await call("figma_export_url", { url: "1:2" })));
    size = 2000;
    const spill = await call("figma_export_url", { url: "1:2" });
    check("…too big → the read runs, then the spill is refused (the outDir check after it)", spill.isError && /outDir must stay inside/.test(spill.text) && spill.asked && fs.readdirSync(outside).length === 0);
    const asked2 = await call("figma_export_url", { url: "1:2", writeToDisk: true });
    check("…writeToDisk:true → refused before the read", asked2.isError && !asked2.asked);
    const empty = await call("figma_export_url", { url: "1:2", outDir: "" });
    check("…outDir:\"\" is no outDir: the read runs, the spill is refused", empty.isError && empty.asked);
  } finally {
    delete process.env.FIGMA_EXPORT_DIR;
    fs.rmSync(outside, { recursive: true, force: true });
  }
  process.env.MAX_MCP_OUTPUT_TOKENS = "500";
  try {
    size = 3;
    check("MAX_MCP_OUTPUT_TOKENS lowers the limit: a small reply still fits", isInline(await call("figma_export_url", { url: "1:2", outDir: "small" })));
    size = 12;
    const lowered = await call("figma_export_url", { url: "1:2", outDir: "small" });
    check("…a slightly larger one spills, and the note names the lowered limit", noteOf(lowered).startsWith("Written to disk WITHOUT being asked: this export is past the 1,600 characters (~0k tokens)"));
  } finally {
    delete process.env.MAX_MCP_OUTPUT_TOKENS;
  }
}
await mc.close();
process.chdir(was);

// ---------------------------------------------------------------- both launches serve
console.log("\nboth launches still start the server:");
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
for (const [name, args] of [["bun figma-mcp.ts", [MCP]], ["dtwin mcp", [CLI, "mcp"]]] as const) {
  const t = new StdioClientTransport({ command: process.execPath, args: [...args], env, cwd: app, stderr: "ignore" });
  const c = new Client({ name: "mcp-delivery-launch", version: "0.0.0" });
  let tools: string[] = [];
  let answered = false;
  try {
    await c.connect(t);
    tools = (await c.listTools()).tools.map((x) => x.name);
    size = 3;
    const r = await c.callTool({ name: "figma_export_url", arguments: { url: "1:2" } });
    answered = r.isError !== true && Array.isArray(rec(parse(textOf(r)).screen).nodes);
  } catch (e) {
    console.log("    " + name + ": " + (e instanceof Error ? e.message : String(e)));
  } finally {
    await c.close().catch(() => {});
  }
  check(`${name} answers initialize, lists the tools and serves an export`, tools.includes("figma_export_url") && answered);
}

served.shutdown();
fs.rmSync(work, { recursive: true, force: true });
report();
