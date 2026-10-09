// Offline tests for the BRIDGE layer — the two files the plugin harness can't reach:
//   1. bridge/src/server-core.ts  — verifyClient, the bridge's only real access control (token + Origin
//      + loopback Host). Previously reachable only through a live WebSocket handshake, so untested.
//   2. bridge/src/seed-components.ts — a CLI, so it's driven as a subprocess in a temp dir.
// Run with:  node test/bridge.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { getEventListeners } from "node:events";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
// "ws" ships no types of its own; @types/ws (a bridge devDependency) provides them.
import WebSocket from "ws";
import type { ClientOptions, RawData } from "ws";
import { ok, report } from "./assert.ts";
import { clientRow, collection, component, malformed, manifest, must, node, screenReply, variable } from "./fixtures.ts";
import { screenPaths } from "../bridge/src/pages-layout.ts";
import { ifDefined } from "../bridge/src/json-util.ts";
import type { Baseline } from "../design-to-code/design-diff.ts";
import type {
  ComponentDetailFile, ComponentsCatalog, DesignSystemDoc, DesignSystemManifest, DesignSystemStamp, EffectStylesDoc, GridStylesDoc,
  HygieneDoc, LibrariesIndex, LibrariesIndexRow, LibraryManifest, PageIndex, PagesRootIndex, PaintStylesDoc, ScreenExport,
  TextStylesDoc, TokensDoc, Asset,
} from "../bridge/src/doc-types.ts";
import type { ComponentsEntry } from "../bridge/src/seed-components.ts";
import type { AssetIndexEntry } from "../bridge/src/write-out.ts";
import type { SnapshotInfo, SnapshotParseError } from "../bridge/src/snapshot-meta.ts";
import type { ClientRow, ProgressTick } from "../bridge/src/server-core.ts";
import type { Cmd } from "../bridge/src/commands.ts";
import type { TokenStatus } from "../bridge/src/token-store.ts";
import type { DaemonBridge } from "../bridge/src/daemon.ts";
import type { Check, Report } from "../bridge/src/doctor.ts";
import type { MergedVariablesDoc } from "../bridge/src/variables-merge.ts";

// A fixed token so verifyClient's comparisons are deterministic. server-core reads this at require
// time, so it must be set BEFORE the module is loaded.
const TOKEN = "test-token-abc123";
process.env.FIGMA_BRIDGE_TOKEN = TOKEN;
// A static `import` is hoisted above this env assignment, and server-core reads FIGMA_BRIDGE_TOKEN at
// load time — so this stays a dynamic import at the exact point the env var is set.
const core = await import("../bridge/src/server-core.ts");

// A caught/rejected value as the Error every bridge path throws. A non-Error is wrapped rather than
// cast, so a check reading `.message` still sees a string (and stays truthy, like the raw value).
const asErr = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));
// Wait for a condition instead of sleeping a guessed time: polls every 10 ms, resolves true once it
// holds, false at the cap — so a check that never comes true fails cleanly instead of hanging, and a
// loaded machine only makes it slower, never wrong.
const until = async (cond: () => boolean, capMs = 10_000): Promise<boolean> => {
  const end = Date.now() + capMs;
  while (!cond()) {
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
};
// The one bridge -> plugin frame the fake plugins below read: `{ id, cmd, args }` (not exported by server-core).
interface CommandFrame { id: string; cmd: Cmd; args?: Record<string, unknown> }
// A fixture asset with the producer-owned identity fields filled in (doc-types.ts Asset).
const asset = (a: { id: string; file: string; text?: string; base64?: string; hash?: string; kind?: "reference" | "source" }): Asset =>
  ({ name: a.id, format: a.text !== undefined ? "svg" : "png", ...a });
// design/target.json as bridge/src/init.ts writes it (built inline there, no exported type): the fields read below.
interface TargetJson { profile: string | null; note?: string }
// .mcp.json as the assertions below read it (init.ts's McpJson is not exported; entries are foreign-or-ours JSON).
interface McpJsonView { mcpServers: Record<string, { command?: string; args?: string[]; url?: string }> }
// <Screen>.assets.json — write-out.ts writeScreenAssets builds it inline (no exported doc type); rows are its AssetIndexEntry.
interface ScreenAssetsDoc { count: number; totalBytes: number; duplicates: unknown[]; monochrome: string[]; note: string; reference?: AssetIndexEntry[]; files: AssetIndexEntry[] }

// ---------------------------------------------------------------- server-core: auth
// verifyClientWith(token) builds the handshake check bound to ONE expected token; the check then calls
// done(true) to accept, or done(false, code, msg) to reject.
const verifyClient = core.verifyClientWith(TOKEN);
function verify({ token, origin, host }: { token?: string; origin?: string; host?: string }): { accepted?: boolean; code?: number } {
  const url = token === undefined ? "/" : "/?token=" + encodeURIComponent(token);
  const info = { ...ifDefined("origin", origin), req: { url, headers: { host: host === undefined ? "127.0.0.1:8787" : host } } };
  const result: { accepted?: boolean; code?: number } = {};
  verifyClient(info, (accepted, code) => { result.accepted = accepted; if (code !== undefined) result.code = code; });
  return result;
}

console.log("server-core — handshake auth:");
ok("[auth] correct token accepted", verify({ token: TOKEN, origin: "null" }).accepted === true);
ok("[auth] wrong token rejected 401", (() => { const r = verify({ token: "nope", origin: "null" }); return r.accepted === false && r.code === 401; })());
ok("[auth] missing token rejected 401", (() => { const r = verify({ origin: "null" }); return r.accepted === false && r.code === 401; })());
ok("[auth] empty token rejected", verify({ token: "", origin: "null" }).accepted === false);
// The CSWSH case the file's own comment calls out: a sandboxed attacker iframe also sends "null",
// so Origin must NOT be sufficient on its own — only the token decides.
ok("[auth] Origin:null WITHOUT token still rejected (CSWSH)", verify({ origin: "null" }).accepted === false);
ok("[auth] real website origin rejected 403", (() => { const r = verify({ token: TOKEN, origin: "https://evil.example" }); return r.accepted === false && r.code === 403; })());
ok("[auth] localhost origin allowed", verify({ token: TOKEN, origin: "http://localhost:3000" }).accepted === true);
// DNS-rebinding: Origin looks fine but Host points at an attacker-controlled name.
ok("[auth] non-loopback Host rejected 403 (DNS rebinding)", (() => { const r = verify({ token: TOKEN, origin: "null", host: "evil.example:8787" }); return r.accepted === false && r.code === 403; })());
ok("[auth] ::1 Host allowed", verify({ token: TOKEN, origin: "null", host: "[::1]:8787" }).accepted === true);
// The old split-on-":" parse turned ANY bracketed IPv6 Host into "" and skipped the check, so "::1"
// passed by accident — a non-loopback IPv6 literal is what tells a real parse from that.
ok("[auth] non-loopback IPv6 Host rejected 403", (() => { const r = verify({ token: TOKEN, origin: "null", host: "[2001:db8::1]:8787" }); return r.accepted === false && r.code === 403; })());
ok("[auth] bare localhost Host (no port) allowed", verify({ token: TOKEN, origin: "null", host: "localhost" }).accepted === true);
// Fail-closed: no Host (or an unparseable one) is refused, not waved through as "nothing to check".
ok("[auth] empty Host rejected 403", (() => { const r = verify({ token: TOKEN, origin: "null", host: "" }); return r.accepted === false && r.code === 403; })());
ok("[auth] missing Host header rejected 403", (() => {
  const r: { accepted?: boolean; code?: number } = {};
  verifyClient({ origin: "null", req: { url: "/?token=" + TOKEN, headers: {} } }, (accepted, code) => { r.accepted = accepted; if (code !== undefined) r.code = code; });
  return r.accepted === false && r.code === 403;
})());
ok("[auth] userinfo trick (127.0.0.1@evil.example) rejected 403", verify({ token: TOKEN, origin: "null", host: "127.0.0.1@evil.example" }).code === 403);
// A token that differs only in LENGTH must not throw (timingSafeEqual requires equal lengths).
ok("[auth] length-mismatched token rejected, no throw", verify({ token: "short", origin: "null" }).accepted === false);
ok("[auth] safeEqual is length-safe", core.safeEqual("abc", "abcdef") === false && core.safeEqual("abc", "abc") === true);

// ---------------------------------------------------------------- seed-components CLI
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seed-test-"));
const seed = path.join(import.meta.dirname, "..", "bridge", "src", "seed-components.ts");
function runSeed(name: string, files: Record<string, string>, existingMap?: object | null, designFiles?: Record<string, unknown>) {
  const root = path.join(tmp, name);
  const design = path.join(root, "design");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(design, { recursive: true });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(root, "src", f), body);
  if (existingMap) fs.writeFileSync(path.join(design, "components.json"), JSON.stringify(existingMap, null, 2));
  // Export files the seeder reads back (the design-system manifest + whatever it points at), written
  // at paths relative to the export dir so the pointer indirection is exercised for real.
  for (const [f, body] of Object.entries(designFiles || {})) {
    const dest = path.join(design, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(body, null, 2));
  }
  execFileSync(process.execPath, [seed, root, design], { stdio: "pipe" });
  const out = path.join(design, "components.json");
  return fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) as Record<string, ComponentsEntry> : null;
}
const tpl = (comp: string, id: string, src: string) => `// url=https://figma.com/design/x?node-id=${id}\n// component=${comp}\n// source=${src}\n`;

console.log("\nseed-components — node-id forms:");
const forms = must(runSeed("forms", {
  "a.figma.tsx": tpl("DashForm", "1-2", "a.tsx"),
  "b.figma.tsx": tpl("ColonEnc", "3%3A4", "b.tsx"),
  "c.figma.tsx": tpl("ColonRaw", "5:6", "c.tsx"),
  "d.figma.tsx": tpl("Nested", "I7-8;9-10", "d.tsx"),
}), "components.json (seeding these templates always writes it)");
ok("[id-dash] node-id=1-2 -> 1:2", forms.DashForm?.nodeId === "1:2");
ok("[id-encoded] node-id=3%3A4 -> 3:4", forms.ColonEnc?.nodeId === "3:4");
ok("[id-colon] node-id=5:6 -> 5:6", forms.ColonRaw?.nodeId === "5:6");
ok("[id-nested] instance path I7-8;9-10 -> I7:8;9:10", forms.Nested?.nodeId === "I7:8;9:10");

console.log("\nseed-components — reserved-key hardening:");
// A component literally named "__proto__" used to resolve to Object.prototype: its entry vanished
// from components.json AND the backfills landed on the prototype, after which no OTHER entry could
// be filled either (their `=== undefined` checks became false). Both halves are asserted here.
const poisoned = must(runSeed(
  "poison",
  { "a.figma.tsx": tpl("__proto__", "1-2", "evil.tsx"), "z.figma.tsx": tpl("Widget", "5-5", "widget.tsx") },
  { Widget: { component: "Widget", import: "@/ui", props: {} } }
), "components.json (the merge always writes it)");
ok("[sec-seed-proto-kept] '__proto__' entry is a real own key, not dropped",
  Object.prototype.hasOwnProperty.call(poisoned, "__proto__") && poisoned["__proto__"]?.source === "evil.tsx");
const widget = must(poisoned.Widget, "poisoned.Widget entry");
ok("[sec-seed-no-starve] unrelated entry still backfilled after a '__proto__' entry",
  widget.source === "widget.tsx" && widget.nodeId === "5:5");
ok("[sec-seed-no-pollute] Object.prototype was not mutated",
  ({} as Record<string, unknown>).source === undefined && ({} as Record<string, unknown>).nodeId === undefined);
ok("[seed-preserves-human-fields] hand-authored import survives the merge", widget.import === "@/ui");
{
  // The hand-edited map is rewritten atomically and in its own format (not normalized to LF, 2 spaces)
  const map = path.join(tmp, "poison", "design", "components.json");
  fs.writeFileSync(map, JSON.stringify({ Widget: { component: "Widget", import: "@/ui", props: {} } }, null, 4).split("\n").join("\r\n") + "\r\n");
  execFileSync(process.execPath, [seed, path.join(tmp, "poison"), path.dirname(map)], { stdio: "pipe" });
  const text = fs.readFileSync(map, "utf8");
  ok("seed keeps a hand-edited map's own format (CRLF, 4-space indent) and leaves no temp file beside it",
    text.includes("\r\n    \"") && !/[^\r]\n/.test(text) && text.endsWith("}\r\n") && !fs.readdirSync(path.dirname(map)).some((f) => f.includes(".tmp-")));
}

console.log("\nseed-components — node-id -> name via the split catalog:");
// A Code Connect template that carries a node-id but NO `component=` can only be named by looking the
// id up in the export. That lookup used to read `components` straight off design-system.json — which
// since the design-system split is a slim POINTER manifest with no such array, so the map came back
// empty and every name-less mapping was silently dropped (a clean-looking run that just found less).
// The seeder must follow files.componentsLocal to the real catalog.
const viaManifest = runSeed(
  "manifest-lookup",
  { "a.figma.tsx": "// url=https://figma.com/design/x?node-id=1-2\n// source=Card.tsx\n" },
  null,
  {
    "design-system.json": { files: { componentsLocal: "design-system/components.local.json" }, counts: { components: 1 } },
    "design-system/components.local.json": { components: [{ id: "1:2", name: "Card", key: "abc" }] },
  }
);
ok("[seed-split-catalog] node-id resolved to a name through files.componentsLocal",
  !!viaManifest && !!viaManifest.Card && viaManifest.Card.nodeId === "1:2" && viaManifest.Card.source === "Card.tsx");

// Pre-split exports inlined the array on design-system.json itself; keep reading those.
const viaInline = runSeed(
  "inline-lookup",
  { "a.figma.tsx": "// url=https://figma.com/design/x?node-id=3-4\n// source=Chip.tsx\n" },
  null,
  { "design-system.json": { components: [{ id: "3:4", name: "Chip" }] } }
);
ok("[seed-inline-catalog] pre-split inline components array still resolves",
  !!viaInline && !!viaInline.Chip && viaInline.Chip.nodeId === "3:4");

console.log("\nseed-components — `dtwin seed` (routed by figma-pull.ts before server-core loads):");
{
  // Driven through the real CLI entry: `dtwin seed` must need no bridge, no token and no plugin, and
  // must be the SAME command as the script run directly. The token env is removed and the config dir
  // pointed at an empty temp dir, so a token minted as a side effect would show up as a file there.
  const pullCli = path.join(import.meta.dirname, "..", "bridge", "src", "figma-pull.ts");
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-cfg-"));
  const env: Record<string, string | undefined> = { ...process.env, DESIGNTWIN_CONFIG_DIR: cfgDir };
  delete env.FIGMA_BRIDGE_TOKEN;
  delete env.FIGMA_BRIDGE_TOKEN_FILE;
  const viaDtwin = (cwd: string, args: string[]) => spawnSync(process.execPath, [pullCli, "seed", ...args], { cwd, env, encoding: "utf8", timeout: 10000 });
  const direct = (cwd: string, args: string[]) => spawnSync(process.execPath, [seed, ...args], { cwd, env, encoding: "utf8", timeout: 10000 });
  // A project root with ONE Code Connect template under src/.
  const project = (name: string) => {
    const root = path.join(tmp, name);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "button.figma.tsx"), tpl("Button", "1-2", "Button.tsx"));
    return root;
  };

  const helpDir = fs.mkdtempSync(path.join(tmp, "help-"));
  const help = viaDtwin(helpDir, ["--help"]);
  ok("[seed-cli] `dtwin seed --help` exits 0 and prints the seed usage",
    help.status === 0 && help.stdout.startsWith("dtwin seed [codeRoot] [outDir] [--dry-run]") && /Code Connect/.test(help.stdout) && /--dry-run/.test(help.stdout));
  ok("[seed-cli] and has no side effects: no design/ dir, no file, no token minted, no bridge",
    fs.readdirSync(helpDir).length === 0 && fs.readdirSync(cfgDir).length === 0 && !help.stderr.includes("[bridge]"));
  ok("[seed-cli] the script run directly answers --help with the same text", direct(helpDir, ["-h"]).stdout === help.stdout && fs.readdirSync(helpDir).length === 0);

  const rootA = project("same-a"), rootB = project("same-b");
  const a = direct(rootA, ["src", "design"]);
  const b = viaDtwin(rootB, ["src", "design"]);
  ok("[seed-cli] `dtwin seed <codeRoot> <outDir>` = the script run directly: same exit, same stderr, byte-identical components.json",
    a.status === 0 && b.status === 0 && a.stderr === b.stderr && /1 mapping\(s\) from 1 scanned file\(s\)/.test(b.stderr)
    && fs.readFileSync(path.join(rootA, "design", "components.json"), "utf8") === fs.readFileSync(path.join(rootB, "design", "components.json"), "utf8"));
  ok("[seed-cli] and it needed no token (none minted)", fs.readdirSync(cfgDir).length === 0 && !b.stderr.includes("[bridge]"));

  const rootDry = project("dry");
  const dry = viaDtwin(rootDry, ["src", "design", "--dry-run"]);
  ok("[seed-cli] --dry-run writes nothing and says so on both summary lines",
    dry.status === 0 && !fs.existsSync(path.join(rootDry, "design"))
    && dry.stderr.split("\n").filter((l) => l.startsWith("[seed-components] (dry run, nothing written) ")).length === 2
    && /1 mapping\(s\) from 1 scanned file\(s\)/.test(dry.stderr));

  const rootBad = project("bogus");
  const bad = viaDtwin(rootBad, ["--bogus"]);
  ok("[seed-cli] an unknown flag exits 2 with a one-line error, and writes nothing",
    bad.status === 2 && /^\[seed-components\] error: unknown flag --bogus/.test(bad.stderr) && bad.stderr.trim().split("\n").length === 1
    && !fs.existsSync(path.join(rootBad, "design")));
  ok("[seed-cli] the script run directly refuses it the same way", (() => { const r = direct(rootBad, ["src", "--bogus"]); return r.status === 2 && r.stderr === bad.stderr; })());
  fs.rmSync(cfgDir, { recursive: true, force: true });
}

fs.rmSync(tmp, { recursive: true, force: true });

// ------------------------------------------------- server-core: post-connect request timeout
// Regression for a LIVE failure (2026-07-28, first real run against Figma): an --all-pages pull on a
// ~1000-node design system blew past server-core's 120s default and reported
// "timed out waiting for the Figma plugin (is the right file open?)". That diagnosis is provably
// wrong — request() only runs AFTER isConnected() passed and the command was sent, so the socket was
// up and the file WAS open. It sent debugging in the wrong direction. No offline test could catch it:
// the mock harness answers instantly, so a timeout never elapsed. This drives the REAL socket path
// with a client that deliberately never replies. (WebSocket is imported statically at the top —
// ws has no load-time env dependency, so hoisting above the code that runs before this point is safe.)

// A bridge plus an OPEN, authenticated client on it. The `?token=` query and the "null" origin are
// exactly what verifyClient gates on, so that handshake shape lives in one place — three copies meant
// a change to the auth contract broke three tests in three spots. Ports start above 8787 so a bridge
// the user has running is never collided with.
let nextPort = 8797;
async function connectedBridge() {
  const port = nextPort++;
  const bridge = core.createBridge(port);
  const client = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`, { origin: "null" });
  await new Promise((res, rej) => { client.on("open", res); client.on("error", rej); });
  return { bridge, client };
}

// Drive one in-flight request to a socket close and hand back the rejection. The three disconnect
// cases differ only in close code/reason, so the setup — connect, start a request, let it register,
// close the peer, shut the bridge down (otherwise every case leaks a listening WS server for the rest
// of the run) — lives here once.
async function disconnectErr(code: number, reason: string) {
  const { bridge, client } = await connectedBridge();
  let err: Error | undefined;
  const inflight = bridge.request("exportFull", {}, 20000).catch((e: unknown) => { err = asErr(e); });
  await new Promise((r) => setTimeout(r, 60)); // let the request register before the close lands
  client.close(code, reason);
  await inflight;
  bridge.close();
  return err;
}

// The suite reports its own failures (report() sets the exit code); nothing awaits the IIFE.
void (async () => {
  const { bridge, client } = await connectedBridge();

  let err: Error | undefined;
  try { await bridge.request("exportFull", {}, 1100); } catch (e) { err = asErr(e); } // client never answers
  client.close();
  bridge.close();

  console.log("\nserver-core — post-connect request timeout:");
  ok("[to-connected] the client really was connected before the request", bridge.isConnected() === true || !!err);
  ok("[to-msg] a stalled request rejects", !!err);
  ok("[to-msg] does NOT blame the file/connection — the socket was up",
    !!err && !/right file open/i.test(err.message));
  ok("[to-msg] names the command that stalled", !!err && /exportFull/.test(err.message));
  ok("[to-msg] states the budget that elapsed", !!err && /within 1s/.test(err.message));
  ok("[to-msg] points at the real remedies (--timeout, plugin window)",
    !!err && /--timeout/.test(err.message) && /plugin window/i.test(err.message));

  // ------------------------------------------- server-core: reply shape check (commands.ts)
  // The ONE place a reply enters the process checks it against the command's contract, so a plugin
  // answering the wrong shape is a named rejection — not a TypeError in whichever reader touches the
  // missing field first. Driven over a real socket with a client that answers what it is told to.
  {
    const { bridge: b, client: c } = await connectedBridge();
    let answer: unknown = { nope: true };
    c.on("message", (raw: RawData) => {
      const m = JSON.parse(raw.toString()) as CommandFrame;
      c.send(JSON.stringify({ id: m.id, ok: true, result: answer }));
    });
    const shapeErr = async (cmd: Cmd) => { try { await b.request(cmd, {}, 2000); return null; } catch (e) { return asErr(e).message; } };
    console.log("\nserver-core — reply shape check:");
    ok("[shape] a listPages reply with no `pages` is rejected, naming the command and the field",
      /plugin replied with an unexpected shape for listPages: `pages` is missing/.test((await shapeErr("listPages")) ?? ""));
    ok("[shape] a getSelection reply that is not an array is rejected",
      /unexpected shape for getSelection: not an array/.test((await shapeErr("getSelection")) ?? ""));
    ok("[shape] a ping reply without pong:true is rejected",
      /unexpected shape for ping: `pong` is not true/.test((await shapeErr("ping")) ?? ""));
    answer = "just a string";
    ok("[shape] a non-object reply is rejected", /unexpected shape for whoami: not an object/.test((await shapeErr("whoami")) ?? ""));
    answer = { pages: "x", manifest: {} };
    ok("[shape] a field of the wrong kind is named", /`pages` is not an array/.test((await shapeErr("listPages")) ?? ""));
    answer = { exportedAt: "2026-09-24T00:00:00.000Z", file: "F", depth: 1, pages: [], manifest: { pages: 0, warnings: [] } };
    const good = await b.request("listPages", { depth: 1 }, 2000);
    ok("[shape] the real shape resolves, typed", good.pages.length === 0 && good.manifest.pages === 0);
    ok("[shape] requestWithClient also names the connection the reply came from",
      (await b.requestWithClient("listPages", { depth: 1 }, 2000)).client.connId === "c1");
    c.close();
    b.close();
  }

  // ------------------------------------------- server-core: disconnect diagnosis
  // Second LIVE failure (2026-07-28): the same --all-pages pull died at ~11min with a bare
  // "Figma plugin disconnected before replying." — no close code, no socket error, nothing to act on,
  // because ws.on("error") was `() => {}` and the close handler discarded `code`. A disconnect has
  // several distinct causes (1009 payload overflow vs a plugin-side crash) that need different fixes,
  // so the message must distinguish them.
  const dErr = await disconnectErr(1009, "max payload size exceeded"); // the payload-overflow disconnect

  console.log("\nserver-core — disconnect diagnosis:");
  ok("[dc] an in-flight request rejects on disconnect", !!dErr);
  ok("[dc] the close CODE is surfaced (was discarded)", !!dErr && /1009/.test(dErr.message));
  ok("[dc] the close reason is surfaced", !!dErr && /max payload size exceeded/i.test(dErr.message));
  ok("[dc] 1009 names the actual knob to turn", !!dErr && /FIGMA_BRIDGE_MAX_PAYLOAD_MB/.test(dErr.message));
  ok("[dc] and suggests pulling less at once", !!dErr && /--all-pages/.test(dErr.message));

  // A plain close with no error must NOT be misreported as a payload problem — it points at the
  // plugin console instead, which is where a crash/OOM actually shows up.
  const pErr = await disconnectErr(1001, ""); // peer went away, no socket error

  ok("[dc-plain] a non-1009 close does NOT blame the payload limit",
    !!pErr && !/FIGMA_BRIDGE_MAX_PAYLOAD_MB/.test(pErr.message));
  ok("[dc-plain] it points at the plugin console instead",
    !!pErr && /Open Console/i.test(pErr.message));
  ok("[dc-plain] and still reports the close code", !!pErr && /1001/.test(pErr.message));

  // ------------------------------------------------- server-core: a bad token the PLUGIN can diagnose
  // A browser socket cannot read an HTTP 401 (it sees an opaque 1006, same as "nothing listening"), so
  // the plugin's iframe (Origin "null") is admitted and closed with 4401 instead. The properties that
  // make that safe are what is tested: it is never a client, and everyone else still gets the 401.
  {
    const port = nextPort++;
    const bridge = core.createBridge(port);
    const closed = (url: string, opts: ClientOptions) => new Promise<{ opened: boolean; http?: number; code?: number; clients?: number }>((res) => {
      const c = new WebSocket(url, opts);
      let opened = false;
      c.on("open", () => { opened = true; c.send(JSON.stringify({ type: "hello", file: "intruder" })); });
      c.on("unexpected-response", (_req, r) => res({ opened, ...ifDefined("http", r.statusCode) }));
      c.on("close", (code) => res({ opened, code, clients: bridge.listClients().length }));
      c.on("error", () => {});
    });
    const plugin = await closed(`ws://127.0.0.1:${port}/?token=wrong`, { origin: "null" });
    ok("[bad-token] the plugin iframe (Origin null) gets close code 4401 it can read, not an opaque refusal",
      plugin.opened === true && plugin.code === core.CLOSE_BAD_TOKEN && core.CLOSE_BAD_TOKEN === 4401);
    ok("[bad-token] and was never registered as a client, even though it sent a hello", plugin.clients === 0 && !bridge.isConnected());
    const node = await closed(`ws://127.0.0.1:${port}/?token=wrong`, {});
    ok("[bad-token] a non-browser client (no Origin) is still refused at the HTTP layer with 401", node.opened === false && node.http === 401);
    const site = await closed(`ws://127.0.0.1:${port}/?token=wrong`, { origin: "https://evil.example" });
    ok("[bad-token] a real website Origin is refused 403 — never admitted for diagnosis", site.opened === false && site.http === 403);
    const good = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`, { origin: "null" });
    await new Promise((res, rej) => { good.on("open", res); good.on("error", rej); });
    ok("[bad-token] the right token still connects normally afterwards", bridge.listClients().length === 1);
    good.close();
    bridge.close();
  }

  // ------------------------------------------------- server-core: our own HTTP server (ws noServer mode)
  // The handshake check moved from ws's verifyClient hook into the HTTP server's 'upgrade' listener
  // (ws docs: "Use of verifyClient is discouraged"). A plain HTTP request must still get the 426 ws's
  // internal server answered — `dtwin doctor` identifies a bridge on a port by exactly that — and a
  // bad Host is still a 403 at the HTTP layer.
  {
    const port = nextPort++;
    const bridge = core.createBridge(port);
    await bridge.listening;
    const plain = await new Promise<number | undefined>((res) => {
      http.get({ host: "127.0.0.1", port, path: "/" }, (r) => { r.resume(); res(r.statusCode); }).on("error", () => res(undefined));
    });
    console.log("\nserver-core — HTTP server + upgrade admission:");
    ok("[upgrade] a plain HTTP request is answered 426 Upgrade Required, as ws's own server did", plain === 426);
    const hostRefused = await new Promise<number | undefined>((res) => {
      const c = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`, { origin: "null", headers: { host: "evil.example" } });
      c.on("unexpected-response", (_req, r) => res(r.statusCode));
      c.on("open", () => { c.close(); res(undefined); });
      c.on("error", () => {});
    });
    ok("[upgrade] a non-loopback Host is refused 403 in the upgrade listener, even with the right token", hostRefused === 403);
    bridge.close();
  }

  // ------------------------------------------------- server-core: heartbeat (ws README ping/pong)
  // A peer that silently stopped answering (lid closed, cable pulled) used to sit in the registry as a
  // live client forever, so every command routed to it waited out its whole timeout. The bridge now
  // pings on an interval and terminates a client that missed the previous pong. `autoPong: false` is a
  // client whose network stack never answers. The rounds are stepped by hand (`heartbeatMs: 0` +
  // heartbeatTick()): with a real short interval, one loop stall after a ping fired the next tick
  // before the alive client's pong was read, and terminated it.
  {
    const port = nextPort++;
    const bridge = core.createBridge(port, { heartbeatMs: 0 });
    const open = (autoPong: boolean) => new Promise<WebSocket>((res, rej) => {
      const c = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`, { origin: "null", autoPong });
      c.on("open", () => res(c));
      c.on("error", rej);
    });
    const alive = await open(true);
    const dead = await open(false);
    let alivePings = 0;
    let deadPings = 0;
    let deadPingsAtClose = -1;
    alive.on("ping", () => { alivePings++; });
    dead.on("ping", () => { deadPings++; });
    dead.on("close", () => { deadPingsAtClose = deadPings; });
    // The alive client answers every command. Its reply is written after its pong on the same socket,
    // so a round trip that resolves proves the bridge has READ the pong — the fence before each tick.
    alive.on("message", (d: RawData) => {
      const f = JSON.parse(d.toString()) as CommandFrame;
      if (f.cmd === "ping") alive.send(JSON.stringify({ id: f.id, ok: true, result: { pong: true, page: "P", file: "F" } }));
    });
    const fence = async (): Promise<boolean> => {
      try { await bridge.request("ping", {}, 5000, "c1"); return true; } catch { return false; }
    };
    ok("[heartbeat] both clients are registered at first", bridge.listClients().length === 2);
    // An in-flight request on the dead client must fail on termination, not wait out its budget.
    let hbErr: Error | undefined;
    const inflight = bridge.request("exportFull", {}, 20000, "c2").catch((e: unknown) => { hbErr = asErr(e); });
    bridge.heartbeatTick();
    const pinged = await until(() => alivePings === 1 && deadPings === 1);
    const fenced = await fence();
    bridge.heartbeatTick();
    const terminated = await until(() => deadPingsAtClose >= 0);
    // The same tick pinged the alive client a second time: its pong is fenced before the next tick.
    const second = await until(() => alivePings === 2) && await fence();
    await inflight;
    console.log("\nserver-core — heartbeat:");
    ok("[heartbeat] a client that never answers pings is terminated at the tick after ONE unanswered ping",
      pinged && fenced && terminated && deadPingsAtClose === 1);
    ok("[heartbeat] and is removed from the client registry", bridge.listClients().map((c) => c.connId).join() === "c1");
    ok("[heartbeat] its in-flight request fails fast with the disconnect diagnosis", !!hbErr && /disconnected before replying/.test(hbErr.message));
    let rounds = 0;
    for (let want = 3; want <= 5; want++) {
      bridge.heartbeatTick();
      if ((await until(() => alivePings === want)) && (await fence())) rounds++;
    }
    ok("[heartbeat] a client that answers pings survives many rounds (pinged each one, still open and routed to)",
      second && rounds === 3 && alivePings === 5 && alive.readyState === WebSocket.OPEN && bridge.isConnected());
    alive.close();
    bridge.close();
  }
  // The real interval is armed: a silent client is terminated with no hand-stepping (no upper time
  // bound — a loaded machine may run it late, which is not the bug this guards).
  {
    const port = nextPort++;
    const bridge = core.createBridge(port, { heartbeatMs: 50 });
    const dead = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`, { origin: "null", autoPong: false });
    let deadClosed = false;
    dead.on("close", () => { deadClosed = true; });
    dead.on("error", () => {});
    ok("[heartbeat] with a real heartbeatMs the interval runs and terminates a client that never answers pings",
      await until(() => deadClosed) && bridge.listClients().length === 0);
    bridge.close();
  }

  // ------------------------------------------------- server-core: progress ticks reach the request's listener
  // The plugin relays `{type:"progress", phase, page, nodes, assets}` during a bridge-triggered export;
  // request()'s optional onProgress hears every tick from THAT connection (figma-mcp forwards them as
  // MCP notifications/progress). A malformed counter is dropped to null, never passed through.
  {
    const { bridge: b, client: c } = await connectedBridge();
    c.on("message", (raw: RawData) => {
      const m = JSON.parse(raw.toString()) as CommandFrame;
      c.send(JSON.stringify({ type: "progress", phase: "pages", page: { index: 1, of: 2, name: "Home" }, nodes: 40, assets: "x" }));
      c.send(JSON.stringify({ type: "progress", phase: "assets" }));
      setTimeout(() => c.send(JSON.stringify({ id: m.id, ok: true, result: { pong: true } })), 30);
    });
    const ticks: ProgressTick[] = [];
    await b.request("ping", {}, 2000, null, undefined, (t) => ticks.push(t));
    console.log("\nserver-core — progress listener:");
    ok("[progress] every tick sent while the request was in flight reaches onProgress", ticks.length === 2);
    const tick0 = must(ticks[0], "first progress tick");
    const tick1 = must(ticks[1], "second progress tick");
    ok("[progress] the tick carries the plugin's phase/page/counters",
      tick0.phase === "pages" && tick0.page?.index === 1 && tick0.page?.of === 2 && tick0.page?.name === "Home" && tick0.nodes === 40);
    ok("[progress] a non-numeric counter and an absent page read as null", tick0.assets === null && tick1.page === null && tick1.nodes === null);
    c.close();
    b.close();
  }

  // ------------------------------------------------- server-core: MULTI-CLIENT routing (two files)
  // The bridge used to keep ONE plugin socket and terminate the incumbent, which made two open Figma
  // files ping-pong: the displaced plugin's 3s auto-reconnect stole the bridge straight back, forever
  // (observed live). Connections now coexist and commands are ADDRESSED. These drive real sockets —
  // two of them — because the whole failure mode lived in the interaction between two clients, which
  // no single-socket test could reach.
  {
    const port = nextPort++;
    const bridge = core.createBridge(port);
    const open = () => new Promise<WebSocket>((res, rej) => {
      const c = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`, { origin: "null" });
      c.on("open", () => res(c));
      c.on("error", rej);
    });
    // A client that identifies itself the way the plugin UI does, then answers whatever it is asked.
    const identify = (c: WebSocket, hello: Record<string, unknown>) => c.send(JSON.stringify({ type: "hello", ...hello }));
    const autoReply = (c: WebSocket, result: Record<string, unknown>) => c.on("message", (b: RawData) => {
      const m = JSON.parse(b.toString()) as CommandFrame;
      if (m && m.id) c.send(JSON.stringify({ id: m.id, ok: true, result: { ...result, cmd: m.cmd } }));
    });

    const base = await open();
    identify(base, { instanceId: "fig-base", file: "App — Base", fileKey: "KEYBASE", page: "Home" });
    autoReply(base, { pong: true, page: "Home", file: "base" });
    await new Promise((r) => setTimeout(r, 80));

    console.log("\nserver-core — multi-client routing (the two-files question):");
    const one = bridge.listClients();
    const one0 = must(one[0], "first listed client");
    ok("[multi] a lone client is listed", one.length === 1 && one0.connId === "c1");
    ok("[multi] the hello announcement is recorded", one0.file === "App — Base" && one0.fileKey === "KEYBASE");
    ok("[multi] and it is marked identified", one0.identified === true);
    // With ONE client, an unaddressed request must still work — every existing call site relies on it.
    const soloRes = await bridge.request("ping", {}, 5000);
    ok("[multi] an unaddressed request resolves when only one file is connected", soloRes.file === "base");

    // The second file connects. Under the old rule this terminated the first.
    const lib = await open();
    identify(lib, { instanceId: "fig-lib", file: "NIMA Library", fileKey: "KEYLIB", page: "Tokens" });
    autoReply(lib, { pong: true, page: "Tokens", file: "lib" });
    await new Promise((r) => setTimeout(r, 80));

    const two = bridge.listClients();
    ok("[multi] BOTH files stay connected — no takeover", two.length === 2);
    ok("[multi] neither is displaced (both ids present)",
      two.some((c) => c.connId === "c1") && two.some((c) => c.connId === "c2"));
    ok("[multi] takeovers stays 0 now that connections coexist", bridge.connectionInfo().takeovers === 0);
    ok("[multi] connectionInfo reports the client count", bridge.connectionInfo().clientsConnected === 2);

    // Addressing: by connId, by fileKey, and by a substring of the file name.
    ok("[multi] routes by connId", (await bridge.request("ping", {}, 5000, "c2")).file === "lib");
    ok("[multi] routes by fileKey", (await bridge.request("ping", {}, 5000, "KEYBASE")).file === "base");
    ok("[multi] routes by file-name substring (case-insensitive)",
      (await bridge.request("ping", {}, 5000, "nima")).file === "lib");

    // waitForClient: a NAMED target whose window has not redialled yet (two files open, the other
    // one landed first — seen live) is waited for, bounded; an unknown name times out quietly and
    // the request path's own resolveClient still says what IS connected.
    const tw0 = Date.now();
    await bridge.waitForClient("nobody-has-this-name", 300);
    const tw = Date.now() - tw0;
    ok("[multi] waitForClient for a name nobody has returns quietly after its window (no throw)", tw >= 280 && tw < 1500);
    let stillErr: Error | undefined;
    try { await bridge.request("ping", {}, 5000, "nobody-has-this-name"); } catch (e) { stillErr = asErr(e); }
    ok("[multi] …and the request afterwards still gets the unchanged 'no connected Figma file matches' text",
      !!stillErr && stillErr.message.startsWith("no connected Figma file matches 'nobody-has-this-name'. Connected:\n  c1  \"App — Base\"  fileKey KEYBASE"));
    const waited = bridge.waitForClient("Docs", 3000);
    let lateWs: WebSocket | undefined;
    setTimeout(() => { void open().then((c) => { lateWs = c; identify(c, { instanceId: "fig-docs", file: "Docs File", fileKey: "KEYDOCS", page: "P" }); autoReply(c, { pong: true, page: "P", file: "docs" }); }); }, 200);
    const tl0 = Date.now();
    await waited;
    const tl = Date.now() - tl0;
    ok("[multi] waitForClient resolves as soon as the late window identifies under that name (not at the timeout)", tl >= 150 && tl < 2500);
    ok("[multi] …and the named request then routes to it", (await bridge.request("ping", {}, 5000, "Docs")).file === "docs");
    // Raced against a timer shorter than its own 3 s window: a wait that only ended at the window loses.
    ok("[multi] waitForClient resolves at once for a name already connected",
      await Promise.race([bridge.waitForClient("nima", 3000).then(() => "resolved"), new Promise((r) => setTimeout(() => r("window"), 2000))]) === "resolved");
    lateWs?.close();
    await new Promise((r) => setTimeout(r, 80));

    // Ambiguity must REFUSE, not guess. Silently picking one would export the wrong file and look
    // entirely successful — the adb "more than one device" call.
    let ambErr: Error | undefined;
    try { await bridge.request("ping", {}, 5000); } catch (e) { ambErr = asErr(e); }
    ok("[multi] an unaddressed request with two files connected is REFUSED", !!ambErr);
    ok("[multi] the refusal lists both files so the caller can choose",
      !!ambErr && /App — Base/.test(ambErr.message) && /NIMA Library/.test(ambErr.message));
    ok("[multi] and names the flags that fix it", !!ambErr && /--client/.test(ambErr.message));

    let missErr: Error | undefined;
    try { await bridge.request("ping", {}, 5000, "nope"); } catch (e) { missErr = asErr(e); }
    ok("[multi] an unmatched target is refused and lists what IS connected",
      !!missErr && /no connected Figma file matches/.test(missErr.message) && /c1/.test(missErr.message));

    // A substring hitting several files must refuse rather than resolve to the first.
    const dupA = await open();
    identify(dupA, { instanceId: "fig-d", file: "Untitled", fileKey: null, page: "Page 1" });
    await new Promise((r) => setTimeout(r, 60));
    let dupErr: Error | undefined;
    try { await bridge.request("ping", {}, 5000, "e"); } catch (e) { dupErr = asErr(e); }
    ok("[multi] an ambiguous name match is refused, not resolved to the first",
      !!dupErr && /matches \d+ connected files/.test(dupErr.message));
    dupA.close();
    await new Promise((r) => setTimeout(r, 80));

    // The isolation property that matters most: one file's plugin window closing must NOT abort work
    // in flight in another file. Under the single-socket version every pending request shared one map
    // and one close cleared them all.
    const slow = await open(); // connects but never answers
    await new Promise((r) => setTimeout(r, 60));
    const slowId = bridge.listClients().find((c) => !c.identified)?.connId;
    let slowErr: Error | undefined;
    const slowReq = bridge.request("exportFull", {}, 20000, slowId).catch((e: unknown) => { slowErr = asErr(e); });
    const liveReq = bridge.request("ping", {}, 5000, "c1"); // base file, still healthy
    await new Promise((r) => setTimeout(r, 60));
    slow.close(1001, "");
    await slowReq;
    const liveRes = await liveReq;
    ok("[multi] a closing client fails ITS OWN in-flight request", !!slowErr);
    ok("[multi] and does NOT abort another file's in-flight request", liveRes.file === "base");
    ok("[multi] the closed client leaves the registry", !bridge.listClients().some((c) => c.connId === slowId));
    ok("[multi] while the others remain", bridge.listClients().length === 2);

    // A re-announced hello (what the plugin sends after Figma restarts its runtime) must UPDATE the
    // existing entry rather than duplicate it.
    identify(base, { instanceId: "fig-base-2", file: "App — Base", fileKey: "KEYBASE", page: "Settings" });
    await new Promise((r) => setTimeout(r, 60));
    const afterRe = bridge.listClients().find((c) => c.connId === "c1");
    ok("[multi] a re-announced identity updates in place (no duplicate entry)", bridge.listClients().length === 2);
    ok("[multi] and carries the NEW instanceId", afterRe?.instanceId === "fig-base-2");

    base.close(); lib.close();
    bridge.close();
    await new Promise((r) => setTimeout(r, 60));
    ok("[multi] closing the bridge empties the registry", bridge.listClients().length === 0);
    ok("[multi] and reports disconnected", bridge.connectionInfo().connected === false);
  }

  // ---------------------------------------------------------------- figma-pull: argument parsing
  // Untested until now, and it was the fiddliest code in the CLI: value-taking flags, an `=` form,
  // a repeatable flag, and a positional [outDir] that must not swallow any of their values.
  // Importing the module must NOT start a bridge — see the import.meta.main guard in figma-pull.ts.
  // Kept as a dynamic import at this exact spot (not hoisted): the enclosing scope is this async IIFE.
  const pull = await import("../bridge/src/figma-pull.ts");
  const parse = (argv: string[]) => pull.parseArgs(argv);
  const usage = (argv: string[]) => { try { parse(argv); return null; } catch (e) { return e instanceof pull.UsageError ? e.message : "WRONG ERROR: " + (e as Error).message; } };
  // Anti-drift: --node and --selection must both write through write-out.js's shared writeScreen
  // helper, not an ad hoc trio of writeJson/writeAssets calls each branch could quietly reinvent.
  const pullSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "bridge", "src", "figma-pull.ts"), "utf8");
  ok("[args] --node dispatch routes through the shared OUT.writeScreen writer", (() => {
    const i = pullSrc.indexOf("if (nodeId) {");
    const j = pullSrc.indexOf("} else if (selection) {");
    return i !== -1 && j !== -1 && i < j && pullSrc.slice(i, j).includes("OUT.writeScreen(outDir, r, plog)");
  })());
  ok("[args] --selection dispatch ALSO routes through OUT.writeScreen (no more ad hoc write trio)", (() => {
    const i = pullSrc.indexOf("} else if (selection) {");
    const j = pullSrc.indexOf("} else if (asLibrary) {");
    return i !== -1 && j !== -1 && i < j && pullSrc.slice(i, j).includes("OUT.writeScreen(outDir, r, plog)");
  })());
  // `dtwin list`'s own "next step" hint must not recommend `dtwin pull design --page/--node
  // <id>` — the outDir trap, printed by the tool itself right after the command that
  // discovers ids to pull. A user-facing STRING, not a doc, so the doc-only grep in the ground rules
  // does not catch it. Pin it at the source level (this hint only prints after a live plugin
  // connection, which a unit test cannot fake cheaply) so it can never regress silently.
  ok("[args] the `list` next-step hint never recommends the outDir-trap form `dtwin pull design `",
    !pullSrc.split("\n").some((l) => /console\.(error|log)/.test(l) && /pull design /.test(l)));

  console.log("\nfigma-pull — argument parsing:");
  // --as-library is a SCOPE: it selects what is exported, so it collides with the other scopes and,
  // like --design-system, walks no page (making every read option inert and therefore refused).
  ok("[as-library] parses and carries the library name", parse(["--as-library", "NIMA"]).asLibrary === "NIMA");
  ok("[as-library] requires a name rather than defaulting silently", /library name/.test(usage(["--as-library"]) || ""));
  ok("[as-library] is refused alongside --design-system", /select different scopes/.test(usage(["--as-library", "NIMA", "--design-system"]) || ""));
  ok("[as-library] is refused alongside --page", /select different scopes/.test(usage(["--as-library", "NIMA", "--page", "1:2"]) || ""));
  ok("[as-library] is refused alongside a list command", /cannot be combined/.test(usage(["--as-library", "NIMA", "--list-libraries"]) || ""));
  ok("[as-library] refuses read options, which would be silently ignored", /silently ignored/.test(usage(["--as-library", "NIMA", "--css"]) || ""));
  ok("[as-library] is refused alongside a daemon command", /cannot be combined/.test(usage(["--as-library", "NIMA", "--serve"]) || ""));

  // The regression: `--timeout` with no value fell into the validator's own `!== undefined` exemption,
  // so it was silently IGNORED and the default applied — invisible until the export died at a limit
  // the caller believed they had raised. A flag that cannot be honoured must fail, never default.
  ok("[args] --timeout with no value is an ERROR, not a silent default", /positive number/.test(usage(["--timeout"]) || ""));
  ok("[args] --timeout followed by another flag is an ERROR too", /positive number/.test(usage(["--timeout", "--no-assets"]) || ""));
  ok("[args] --timeout= (empty) is an ERROR", /positive number/.test(usage(["--timeout="]) || ""));
  ok("[args] --timeout 0 is rejected", /positive number/.test(usage(["--timeout", "0"]) || ""));
  ok("[args] --timeout abc is rejected", /positive number/.test(usage(["--timeout", "abc"]) || ""));
  ok("[args] --timeout 600 -> 600000ms", parse(["--timeout", "600"]).exportTimeoutMs === 600000);
  ok("[args] --timeout=600 -> 600000ms (= form)", parse(["--timeout=600"]).exportTimeoutMs === 600000);
  // A near-miss flag must not be read as this one: `startsWith("--timeout")` used to swallow it.
  // It is now refused outright (unknown flag) — stronger than "parsed, but not as --timeout".
  ok("[args] an unrelated --timeout-ish flag is not consumed as --timeout",
    /unknown flag: --timeout-ms/.test(usage(["--timeout-ms", "5"]) || ""));
  // Unknown flags: a typo used to match nothing and fall through to a FULL PULL that waits on the
  // plugin — the wrong command, silently. Refused, with the nearest real flag offered.
  ok("[args] a typo'd flag is an ERROR with a did-you-mean, not a silent full pull",
    /unknown flag: --lst \(did you mean --list\?\)/.test(usage(["--lst"]) || ""));
  ok("[args] several unknown flags are all named", (() => {
    const m = usage(["--al-pages", "--frobnicate"]) || "";
    return /unknown flags:/.test(m) && /--al-pages \(did you mean --all-pages\?\)/.test(m) && /--frobnicate/.test(m);
  })());
  ok("[args] an unknown --flag=value form is refused too", /unknown flag: --pgae=Foo \(did you mean --page\?\)/.test(usage(["--pgae=Foo"]) || ""));
  ok("[args] a flag's VALUE is never judged as a flag", parse(["--page", "-weird-name"]).pageSel[0] === "-weird-name");
  ok("[args] every documented flag still parses", (() => {
    for (const a of [["--list"], ["--list-pages"], ["--list-libraries"], ["--whoami"], ["--list-clients"], ["--serve"], ["--show-token"],
      ["--selection", "--css", "--no-assets"], ["--design-system", "--variant-visuals"], ["--client", "c1", "--node", "1:2"], ["--screenshot", "1:2", "--scale", "2"]]) parse(a);
    return true;
  })());
  // ---------------------------------------------------------------- dtwin init
  {
    const init = await import("../bridge/src/init.ts");
    // "os" is already imported statically at the top of the file — the original local require was a
    // redundant re-require of the same builtin module (identical object), so it is not repeated here.
    const mk = (files: Record<string, string>) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-init-")); for (const [f, b] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), b); } return d; };
    const tok = { created: false, source: "file" as const, path: "/x/bridge-token" };
    const entry = { command: "node", args: ["/abs/figma-mcp.mjs"] };
    ok("[init] detects the stack the way build-screen step 0 does", init.detectProfile(mk({ "package.json": '{"dependencies":{"react-native":"1"}}' }))?.profile === "react-native"
      && init.detectProfile(mk({ "package.json": '{"devDependencies":{"tailwindcss":"4"}}' }))?.profile === "web-tailwind"
      && init.detectProfile(mk({ "pubspec.yaml": "dependencies:\n  flutter:\n    sdk: flutter\n" }))?.profile === "flutter"
      && init.detectProfile(mk({ "Package.swift": "" }))?.profile === "swiftui"
      && init.detectProfile(mk({ "app/build.gradle.kts": "implementation(libs.androidx.compose.ui)" }))?.profile === "android-compose"
      && init.detectProfile(mk({})) === null);
    ok("[init] fresh project: creates design/ + target.json, no .mcp.json unless asked", (() => {
      const d = mk({ "package.json": '{"dependencies":{"tailwindcss":"4"}}' });
      init.apply(d, init.plan(d, { token: tok }), () => {});
      return (JSON.parse(fs.readFileSync(path.join(d, "design/target.json"), "utf8")) as TargetJson).profile === "web-tailwind" && !fs.existsSync(path.join(d, ".mcp.json"));
    })());
    ok("[init] never overwrites an existing target.json", (() => {
      const d = mk({ "design/target.json": '{"profile":"mine"}', "package.json": "{}" });
      init.apply(d, init.plan(d, { token: tok }), () => {});
      return fs.readFileSync(path.join(d, "design/target.json"), "utf8") === '{"profile":"mine"}';
    })());
    ok("[init] --mcp MERGES into an existing .mcp.json and keeps other servers", (() => {
      const d = mk({ ".mcp.json": '{"mcpServers":{"other":{"command":"x"}}}' });
      init.apply(d, init.plan(d, { mcp: true, mcpEntry: entry, token: tok }), () => {});
      const m = (JSON.parse(fs.readFileSync(path.join(d, ".mcp.json"), "utf8")) as McpJsonView).mcpServers;
      return m.other?.command === "x" && m.designtwin?.args?.[0] === "/abs/figma-mcp.mjs";
    })());
    ok("[init] --mcp registers as \"designtwin\" BESIDE Figma's own \"figma\" server, never in its place", (() => {
      const d = mk({ ".mcp.json": '{"mcpServers":{"figma":{"type":"http","url":"https://mcp.figma.com/mcp"}}}' });
      init.apply(d, init.plan(d, { mcp: true, mcpEntry: entry, token: tok }), () => {});
      const m = (JSON.parse(fs.readFileSync(path.join(d, ".mcp.json"), "utf8")) as McpJsonView).mcpServers;
      return m.figma?.url === "https://mcp.figma.com/mcp" && m.designtwin?.args?.[0] === "/abs/figma-mcp.mjs";
    })());
    ok("[init] --mcp does not add a SECOND copy when ours is already there under the legacy \"figma\" key (two would fight over 8787)", (() => {
      const before = '{"mcpServers":{"figma":{"command":"node","args":["/old/clone/bridge/figma-mcp.mjs"]}}}';
      const d = mk({ ".mcp.json": before });
      const plan = init.plan(d, { mcp: true, mcpEntry: entry, token: tok });
      init.apply(d, plan, () => {});
      return fs.readFileSync(path.join(d, ".mcp.json"), "utf8") === before && plan.some((a) => a.kind === "skip" && /already registered as "figma"/.test(a.note));
    })());
    ok("[init] --mcp leaves a foreign designtwin entry, and an invalid .mcp.json, untouched", (() => {
      const a = mk({ ".mcp.json": '{"mcpServers":{"designtwin":{"command":"keep"}}}' }), b = mk({ ".mcp.json": "{not json" });
      init.apply(a, init.plan(a, { mcp: true, mcpEntry: entry, token: tok }), () => {});
      init.apply(b, init.plan(b, { mcp: true, mcpEntry: entry, token: tok }), () => {});
      return (JSON.parse(fs.readFileSync(path.join(a, ".mcp.json"), "utf8")) as McpJsonView).mcpServers.designtwin?.command === "keep" && fs.readFileSync(path.join(b, ".mcp.json"), "utf8") === "{not json";
    })());
    ok("[init] --mcp skips a well-formed JSON .mcp.json of the wrong shape and leaves it untouched (null crashed; a string mcpServers was spread char-by-char into the rewrite)", (() => {
      return ["null", '{"mcpServers":"abc"}', "[1]", '{"mcpServers":[]}', '{"mcpServers":null}'].every((before) => {
        const d = mk({ ".mcp.json": before });
        const plan = init.plan(d, { mcp: true, mcpEntry: entry, token: tok });
        init.apply(d, plan, () => {});
        return fs.readFileSync(path.join(d, ".mcp.json"), "utf8") === before
          && plan.some((a) => a.kind === "skip" && a.path === ".mcp.json" && /must be (a JSON object|an object of server entries), not (null|a string|an array)/.test(a.note) && /re-run with --mcp/.test(a.note));
      });
    })());
    ok("[init] --mcp keeps a server literally keyed \"__proto__\" (zod's record drops that key; the rewrite must not)", (() => {
      const d = mk({ ".mcp.json": '{"mcpServers":{"__proto__":{"command":"odd"},"other":{"command":"x"}}}' });
      init.apply(d, init.plan(d, { mcp: true, mcpEntry: entry, token: tok }), () => {});
      const text = fs.readFileSync(path.join(d, ".mcp.json"), "utf8");
      return /"__proto__": \{\s*"command": "odd"/.test(text) && /"other"/.test(text) && /"designtwin"/.test(text);
    })());
    ok("[init] --mcp keeps the file's own key order and every unknown key when it merges", (() => {
      const d = mk({ ".mcp.json": '{"a":1,"mcpServers":{"other":{"command":"x"}},"b":{"c":[2]}}' });
      init.apply(d, init.plan(d, { mcp: true, mcpEntry: entry, token: tok }), () => {});
      const doc: unknown = JSON.parse(fs.readFileSync(path.join(d, ".mcp.json"), "utf8"));
      return JSON.stringify(doc) === JSON.stringify({ a: 1, mcpServers: { other: { command: "x" }, designtwin: entry }, b: { c: [2] } });
    })());
    ok("[init] warns when .gitignore would swallow the hand-authored maps, and names the narrower pattern",
    (() => {
      const note = init.plan(mk({ ".gitignore": "node_modules/\ndesign/\n" }), { token: tok }).find((a) => a.kind === "note");
      return !!note && /NOT regenerable/.test(note.note) && /design\/export\//.test(note.note);
    })());
    // Suggest only: Tailwind v4 compiles class names quoted in design/ notes unless excluded.
    ok("a project whose package.json lists tailwindcss (deps or devDeps) gets ONE @source not note; others get none", (() => {
      const notes = (files: Record<string, string>) => init.plan(mk(files), { token: tok }).filter((a) => a.kind === "note" && /@source not "<path from that CSS file to design\/>";/.test(a.note) && /v4\.1\+/.test(a.note));
      return notes({ "package.json": '{"devDependencies":{"tailwindcss":"4"}}' }).length === 1 && notes({ "package.json": '{"dependencies":{"tailwindcss":"4"}}' }).length === 1
        && notes({ "package.json": '{"dependencies":{"react":"19"}}' }).length === 0 && notes({}).length === 0 && notes({ "package.json": "not json" }).length === 0;
    })());
    ok("no note for a Tailwind pinned to v3 (^3 / ~3 / 3.x / >=3 <4 — v3 does not auto-scan); v4 ranges and the v4-only plugins still get it", (() => {
      const n = (pkg: string) => init.plan(mk({ "package.json": pkg }), { token: tok }).filter((a) => a.kind === "note" && /@source not/.test(a.note)).length;
      return ["^3.4.1", "~3.3", "3.x", ">=3 <4"].every((r) => n(`{"devDependencies":{"tailwindcss":"${r}"}}`) === 0)
        && n('{"devDependencies":{"tailwindcss":"^4.1.0"}}') === 1 && n('{"devDependencies":{"tailwindcss":"^3.0.0 || ^4.0.0"}}') === 1 && n('{"devDependencies":{"tailwindcss":"^3.0.0 || ~3.4"}}') === 0 && n('{"devDependencies":{"tailwindcss":">=3"}}') === 1 && n('{"devDependencies":{"@tailwindcss/vite":"^4"}}') === 1;
    })());
    // Suggest only: a watched write into design/ can hot-reload the page being measured.
    // proven only for vite + Tailwind v4 (its source detection is what makes Vite reload on a design/ rewrite)
    ok("a project listing vite AND Tailwind v4 gets ONE server.watch.ignored note naming the proven mechanism; vite alone, Tailwind v3 or no vite get none; vite.config is never written", (() => {
      const notes = (files: Record<string, string>) => init.plan(mk(files), { token: tok }).filter((a) => a.kind === "note" && /server: \{ watch: \{ ignored: \['\*\*\/design\/\*\*'\] \} \}/.test(a.note));
      const n = (files: Record<string, string>) => notes(files).length;
      const d = mk({ "package.json": '{"devDependencies":{"vite":"7","tailwindcss":"^4.1.0"}}', "vite.config.ts": "export default {};\n" });
      init.apply(d, init.plan(d, { token: tok }), () => {});
      const both = notes({ "package.json": '{"devDependencies":{"vite":"7","@tailwindcss/vite":"^4"}}' });
      return both.length === 1 && /Tailwind v4's automatic source detection/.test(both[0]?.kind === "note" ? both[0].note : "") && /fully reload/.test(both[0]?.kind === "note" ? both[0].note : "")
        && n({ "package.json": '{"dependencies":{"vite":"7","tailwindcss":"4"}}' }) === 1
        && n({ "package.json": '{"devDependencies":{"vite":"7"}}' }) === 0 && n({ "package.json": '{"devDependencies":{"vite":"7","tailwindcss":"^3.4.1"}}' }) === 0
        && n({ "package.json": '{"dependencies":{"tailwindcss":"4"}}' }) === 0 && n({}) === 0 && fs.readFileSync(path.join(d, "vite.config.ts"), "utf8") === "export default {};\n";
    })());
    ok("init suggests gitignoring design/verify/ unless .gitignore already covers it", (() => {
      const n = (files: Record<string, string>) => init.plan(mk(files), { token: tok }).filter((a) => a.kind === "note" && /consider adding `design\/verify\/` to \.gitignore/.test(a.note)).length;
      return n({}) === 1 && n({ ".gitignore": "node_modules/\n" }) === 1 && n({ ".gitignore": "design/verify/\n" }) === 0 && n({ ".gitignore": "design/\n" }) === 0
        && ["design/verify/**\n", "/design/verify\n", "/design/verify/\n", "design/verify/*\n", "design/verify\n"].every((g) => n({ ".gitignore": g }) === 0)
        && n({ ".gitignore": "design/verify-old/\n" }) === 1 && n({ ".gitignore": "design/export/\n" }) === 1;
    })());
    ok("init only suggests it — nothing is written into a stylesheet", (() => {
      const d = mk({ "package.json": '{"devDependencies":{"tailwindcss":"4"}}', "src/app.css": '@import "tailwindcss";\n' });
      init.apply(d, init.plan(d, { token: tok }), () => {});
      return fs.readFileSync(path.join(d, "src/app.css"), "utf8") === '@import "tailwindcss";\n';
    })());
  // The layout split, asserted where it is decided: dtwin writes only under design/export/, and
  // everything a re-pull must not destroy sits beside it (see bridge/project-layout.js).
  ok("[init] scaffolds design/ AND design/export/, so the split is visible before the first pull",
    (() => {
      const d = mk({});
      init.apply(d, init.plan(d, { token: tok }), () => {});
      return fs.existsSync(path.join(d, "design", "export")) && fs.existsSync(path.join(d, "design", "README.md"));
    })());
  ok("[init] the README says which half a re-pull is allowed to destroy",
    (() => {
      const d = mk({});
      init.apply(d, init.plan(d, { token: tok }), () => {});
      const r = fs.readFileSync(path.join(d, "design", "README.md"), "utf8");
      return /dtwin owns this/.test(r) && /you own it/.test(r) && /codeconnect\.local\.json/.test(r);
    })());
  // target.json is written even when no stack is detected; skipping it would make `init --help`'s own promise
  // false and leave every later step reading a file that is not there.
  ok("[init] target.json is written even when no stack is detected, with profile:null",
    (() => {
      const d = mk({});
      init.apply(d, init.plan(d, { token: tok }), () => {});
      const t = JSON.parse(fs.readFileSync(path.join(d, "design", "target.json"), "utf8")) as TargetJson;
      return t.profile === null && /build-screen asks/.test(t.note ?? "");
    })());
  ok("[init] and it still records a DETECTED stack rather than null",
    (() => {
      const d = mk({ "package.json": JSON.stringify({ dependencies: { tailwindcss: "^4" } }) });
      init.apply(d, init.plan(d, { token: tok }), () => {});
      return (JSON.parse(fs.readFileSync(path.join(d, "design", "target.json"), "utf8")) as TargetJson).profile === "web-tailwind";
    })());
    ok("[init] CLI: --dry-run writes nothing, prints the remaining steps, exits 0; junk args exit 1", (() => {
      const d = mk({ "package.json": '{"dependencies":{"tailwindcss":"4"}}' });
      const run = (args: string[]) => spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "bridge", "src", "figma-pull.ts"), "init", ...args], { cwd: d, encoding: "utf8", timeout: 5000, env: { ...process.env, FIGMA_BRIDGE_TOKEN: "t" } });
      const r = run(["--dry-run", "--mcp"]);
      return r.status === 0 && /Import plugin from manifest/.test(r.stdout) && /would write/.test(r.stderr) && !fs.existsSync(path.join(d, "design")) && !fs.existsSync(path.join(d, ".mcp.json")) && run(["--nope"]).status === 1;
    })());

    // `dtwin init --help` must list EXACTLY what init creates — no more, no less. Walk the real
    // filesystem diff after a real `init` and cross-check it against the four paths named in --help.
    ok("[init] --help lists exactly what init creates — a filesystem diff after init matches the help text", (() => {
      const helpRun = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "bridge", "src", "figma-pull.ts"), "init", "--help"], { encoding: "utf8", timeout: 5000 });
      const help = helpRun.stdout;
      // Never promise to create the hand-owned files that only get written later, on demand.
      if (/Creates:.*codeconnect\.local\.json/s.test(help) || /Creates:.*plan\//s.test(help) || /Creates:.*audit\//s.test(help) || /Creates:.*verify\//s.test(help)) return false;
      if (!/codeconnect\.local\.json/.test(help) || !/plan\//.test(help) || !/audit\b/.test(help) || !/verify\//.test(help)) return false; // still SAID, just not claimed as created
      const d = mk({});
      init.apply(d, init.plan(d, { token: tok }), () => {});
      const walk = (dir: string, base: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const rel = path.join(base, e.name);
        return e.isDirectory() ? [rel, ...walk(path.join(dir, e.name), rel)] : [rel];
      });
      const created = walk(d, "").map((p: string) => p.split(path.sep).join("/")).sort();
      const expected = ["design", "design/README.md", "design/export", "design/target.json"].sort();
      return JSON.stringify(created) === JSON.stringify(expected)
        && /design\/export\//.test(help) && /design\/README\.md/.test(help) && /design\/target\.json/.test(help);
    })());
  }
  ok("[args] --json is accepted on the printing commands", parse(["--list-clients", "--json"]).json === true && parse(["--list-libraries", "--json"]).json === true && parse(["--list", "--json"]).json === true && parse(["--list"]).json === false);
  ok("[args] --json on an export is refused (it writes files, prints no result)", /--json applies to the commands that PRINT/.test(usage(["--all-pages", "--json"]) || "") && /--json applies/.test(usage(["--json"]) || ""));
  ok("[args] --help prints the usage header and exits 0 without starting a bridge", (() => {
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "bridge", "src", "figma-pull.ts"), "--help"], { encoding: "utf8", timeout: 5000 });
    return r.status === 0 && /Usage:/.test(r.stdout) && /--list-libraries/.test(r.stdout) && !/listening/.test(r.stderr);
  })());
  // `dtwin --help` must mention `--client`, the flag
  // every plugin-reaching command needs once two Figma files are connected — otherwise it appears only in
  // bridge/README.md (a clone-only file) and in `list clients`' own table.
  ok("[args] --help mentions --client, pointing at `dtwin list clients`", (() => {
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "bridge", "src", "figma-pull.ts"), "--help"], { encoding: "utf8", timeout: 5000 });
    return r.status === 0 && /--client/.test(r.stdout) && /list clients/.test(r.stdout);
  })());
  ok("[args] default timeout scales with the work (selection < page < all-pages)", (() => {
    const s = parse(["--selection"]).exportTimeoutMs, p = parse([]).exportTimeoutMs, a = parse(["--all-pages"]).exportTimeoutMs;
    return s === 120000 && p === 300000 && a === 900000 && s < p && p < a;
  })());

  // outDir is positional, so every value-taking flag above must be excluded from the search — the
  // failure this guards is `--children 131:1879` writing an export into a directory named "131:1879".
  //
  // The default outDir itself is CWD-dependent (bridge/project-layout.js's findExportDir walks
  // process.cwd() looking for an existing flat `design/` export to stay backward-compatible with).
  // Asserting a literal "design" here silently depended on whichever directory happened to be the
  // test runner's cwd ALREADY having a legacy-flat `design/` in it — true by accident on some dev
  // checkouts, false in a clean git worktree (these 4 checks are cwd-dependent, NOT
  // environmental failures). Run `parse()`
  // from a fresh, empty temp cwd instead, so the default is deterministically LAYOUT.EXPORT_DIR
  // ("design/export") regardless of where the suite happens to run.
  const freshCwd = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-argparse-cwd-"));
  const parseInFreshCwd = (argv: string[]) => {
    const before = process.cwd();
    process.chdir(freshCwd);
    try { return pull.parseArgs(argv); } finally { process.chdir(before); }
  };
  const LAYOUT = await import("../bridge/src/project-layout.ts");
  ok("[args] --children <id> value is not mistaken for outDir", (() => {
    const r = parseInFreshCwd(["--children", "131:1879"]);
    return r.childrenId === "131:1879" && r.outDir === LAYOUT.EXPORT_DIR;
  })());
  ok("[args] --timeout value is not mistaken for outDir", parseInFreshCwd(["--timeout", "600"]).outDir === LAYOUT.EXPORT_DIR);
  ok("[args] --page value is not mistaken for outDir", parseInFreshCwd(["--page", "1:2"]).outDir === LAYOUT.EXPORT_DIR);
  ok("[args] a real positional outDir is still picked up", parse(["out", "--page", "1:2"]).outDir === "out");
  ok("[args] outDir works AFTER a value flag too", parse(["--page", "1:2", "out"]).outDir === "out");

  ok("[args] --page is repeatable", (() => { const p = parse(["--page", "1:2", "--page", "3:4"]).pageSel; return p.length === 2 && p[0] === "1:2" && p[1] === "3:4"; })());
  ok("[args] --page= form works and mixes with the space form", (() => { const p = parse(["--page=1:2", "--page", "3:4"]).pageSel; return p.length === 2 && p[0] === "1:2"; })());
  ok("[args] --page with no value is an ERROR", /needs an id or name/.test(usage(["--page"]) || ""));
  ok("[args] --page= empty is an ERROR", /needs an id or name/.test(usage(["--page="]) || ""));
  ok("[args] --children with no value is an ERROR", /needs a node id/.test(usage(["--children"]) || ""));
  // Parity: --page and --timeout both take `=`, so --children silently rejecting it was a papercut.
  ok("[args] --children= form is accepted", parse(["--children=131:1879"]).childrenId === "131:1879");
  // --children now goes through node-id.js, the same parser figma_list_children uses, so the CLI and
  // the MCP twin accept the SAME inputs. Previously the raw token went straight to the plugin, whose
  // only normalisation is replace(/-/g, ":") — so a pasted design URL worked via MCP and failed here.
  ok("[args] --children accepts the DASH form (normalised to colons)",
    parse(["--children", "131-1879"]).childrenId === "131:1879");
  ok("[args] --children accepts a full figma.com design URL",
    parse(["--children", "https://www.figma.com/design/abc123/NIMA?node-id=131-1879&t=x"]).childrenId === "131:1879");
  ok("[args] --children accepts a percent-encoded id",
    parse(["--children=131%3A1879"]).childrenId === "131:1879");
  ok("[args] --children accepts a nested-instance path",
    parse(["--children", "I131-1879;12-34"]).childrenId === "I131:1879;12:34");
  // An id shape node-id.js doesn't recognise must keep working exactly as before rather than becoming
  // a new hard failure — the plugin is the authority on what resolves, not this parser.
  ok("[args] an unrecognised id shape is passed through untouched",
    parse(["--children", "weird_id"]).childrenId === "weird_id");
  ok("[args] --children= empty is an ERROR", /needs a node id/.test(usage(["--children="]) || ""));

  // --node <id>: the REAL single-node export (properties + assets) — a SCOPE flag, unlike --children
  // (peek) and --screenshot (PNG only), so it must accept the same id shapes --children does and join
  // the scopes/indexCmds mutual-exclusion guards below rather than living in its own lane.
  ok("[args] --node <id> value is not mistaken for outDir", (() => {
    const r = parseInFreshCwd(["--node", "131:1879"]);
    return r.nodeId === "131:1879" && r.outDir === LAYOUT.EXPORT_DIR;
  })());
  ok("[args] --node with no value is an ERROR", /needs a node id/.test(usage(["--node"]) || ""));
  ok("[args] --node= form is accepted", parse(["--node=131:1879"]).nodeId === "131:1879");
  ok("[args] --node accepts the DASH form (normalised to colons)",
    parse(["--node", "131-1879"]).nodeId === "131:1879");
  ok("[args] --node accepts a full figma.com design URL",
    parse(["--node", "https://www.figma.com/design/abc123/NIMA?node-id=131-1879&t=x"]).nodeId === "131:1879");
  ok("[args] --node accepts a percent-encoded id",
    parse(["--node=131%3A1879"]).nodeId === "131:1879");
  ok("[args] --node accepts a nested-instance path",
    parse(["--node", "I131-1879;12-34"]).nodeId === "I131:1879;12:34");
  ok("[args] --node= empty is an ERROR", /needs a node id/.test(usage(["--node="]) || ""));
  ok("[args] --node + --selection is an ERROR (different scopes)", /different scopes/.test(usage(["--node", "1:2", "--selection"]) || ""));
  ok("[args] --node + --page is an ERROR (different scopes)", /different scopes/.test(usage(["--node", "1:2", "--page", "3:4"]) || ""));
  ok("[args] --node + --list is an ERROR (structural index only)", /structural index/.test(usage(["--list", "--node", "1:2"]) || ""));
  ok("[args] --node + --serve is an ERROR", /manages the background bridge/.test(usage(["--serve", "--node", "1:2"]) || ""));
  // Unlike --screenshot (skips the walk entirely), --node DOES a real serialize() pass, so read
  // options are genuinely live and must compose rather than being refused.
  ok("[args] --node + a read option is ACCEPTED (unlike --screenshot)", (() => {
    const r = parse(["--node", "1:2", "--css"]);
    return r.nodeId === "1:2" && r.readOpts.css === true;
  })());

  ok("[args] --no-assets sets skipAssets", parse(["--no-assets"]).readOpts.skipAssets === true);
  ok("[args] --list implies depth 2, --list-pages depth 1", (() => {
    const l = parse(["--list"]), lp = parse(["--list-pages"]);
    return l.listOnly && l.listDepth === 2 && lp.listOnly && lp.listDepth === 1;
  })());

  // Scope flags are mutually exclusive and the loser was DISCARDED IN SILENCE: collectFull is
  // `if (allPages) … else if (page)`, so `--all-pages --page Foo` exported all 25 pages while the
  // caller waited for one, and `--selection --page Foo` never forwarded the page at all. Both hand
  // back a plausible export of the WRONG scope — the failure nobody notices. Refuse instead.
  ok("[args] --all-pages + --page is an ERROR", /different scopes/.test(usage(["--all-pages", "--page", "1:2"]) || ""));
  ok("[args] --selection + --page is an ERROR", /different scopes/.test(usage(["--selection", "--page", "1:2"]) || ""));
  ok("[args] --selection + --all-pages is an ERROR", /different scopes/.test(usage(["--selection", "--all-pages"]) || ""));
  ok("[args] each scope flag ALONE is still fine", (() => {
    return parse(["--selection"]).selection && parse(["--all-pages"]).allPages && parse(["--page", "1:2"]).pageSel.length === 1;
  })());

  // --design-system: the "just the design system, no page walk" scope. Same exclusivity family as
  // --selection/--all-pages/--page, and — like the list commands — no read options apply, since it
  // never walks a node.
  ok("[args] --design-system alone parses and sets the flag", parse(["--design-system"]).designSystemOnly === true);
  ok("[args] --design-system + --all-pages is an ERROR", /different scopes/.test(usage(["--design-system", "--all-pages"]) || ""));
  ok("[args] --design-system + --selection is an ERROR", /different scopes/.test(usage(["--design-system", "--selection"]) || ""));
  ok("[args] --design-system + --page is an ERROR", /different scopes/.test(usage(["--design-system", "--page", "1:2"]) || ""));
  ok("[args] --design-system + a read option is an ERROR (no node walk to apply it to)",
    /node\/page walk/.test(usage(["--design-system", "--css"]) || ""));
  // --variant-visuals is the ONE exception: it enriches the component catalog --design-system/
  // --as-library both build, so it must NOT trip the "no node walk" guard the other five do.
  ok("[args] --design-system + --variant-visuals is ACCEPTED, not refused",
    parse(["--design-system", "--variant-visuals"]).designSystemOnly === true);
  ok("[args] --design-system + --variant-visuals + --css is STILL an error (css is refused, variant-visuals is not)",
    /node\/page walk/.test(usage(["--design-system", "--variant-visuals", "--css"]) || "") &&
    !/--variant-visuals/.test(usage(["--design-system", "--variant-visuals", "--css"]) || ""));
  ok("[args] --design-system + --serve is an ERROR", /manages the background bridge/.test(usage(["--serve", "--design-system"]) || ""));
  // --list/--children print a structural index and exit(0) before any export runs, so an export flag
  // combined with one of them is a no-op the caller has no way to observe.
  ok("[args] --list + --page is an ERROR", /structural index/.test(usage(["--list", "--page", "1:2"]) || ""));
  ok("[args] --children + --all-pages is an ERROR", /structural index/.test(usage(["--children", "1:2", "--all-pages"]) || ""));
  ok("[args] --list + --children is an ERROR (two different queries)", /only one/.test(usage(["--list", "--children", "1:2"]) || ""));
  // Read options are ADDITIVE, not scopes — they must keep composing with any one scope flag.
  ok("[args] read options still compose with a scope flag", !!((() => {
    const r = parse(["--page", "1:2", "--no-assets", "--css", "--timeout", "60"]);
    return r.pageSel.length === 1 && r.readOpts.skipAssets && r.readOpts.css && r.exportTimeoutMs === 60000;
  })()));
  // …but only with a SCOPE flag. The list ops emit structural fields only — they never serialize a
  // node, so every read option is inert there and used to be discarded without a word. Refused as a
  // group, --no-assets included: it is equally inert (nothing renders on that path), and exempting it
  // would leave the caller guessing which flags survive a list.
  ok("[args] --list + --css is an ERROR (read option would be ignored)", /silently ignored/.test(usage(["--list", "--css"]) || ""));
  ok("[args] the refusal names the offending flag", /--css/.test(usage(["--list", "--css"]) || ""));
  ok("[args] …and the command that cannot use it", /--list\b/.test(usage(["--list", "--css"]) || ""));
  ok("[args] --list-pages names ITSELF, not --list", /--list-pages/.test(usage(["--list-pages", "--motion"]) || ""));
  ok("[args] --children + a read option is an ERROR too", /--children/.test(usage(["--children", "1:2", "--measurements"]) || ""));
  ok("[args] --no-assets is refused on --list as well (no carve-out)", /--no-assets/.test(usage(["--list", "--no-assets"]) || ""));
  ok("[args] every read option is covered, none silently survives a list", (() => {
    const flags = ["--css", "--measurements", "--plugin-data", "--motion", "--shared-data", "--no-assets"];
    return flags.every((f) => usage(["--list", f]) !== null);
  })());
  ok("[args] multiple offenders are all named at once", (() => {
    const m = usage(["--list", "--css", "--motion"]) || "";
    return /--css/.test(m) && /--motion/.test(m);
  })());
  // --timeout is NOT a read option: it genuinely applies to the list ops' own budget, so it must
  // keep composing with them.
  ok("[args] --timeout still composes with --list", (() => {
    const r = parse(["--list", "--timeout", "600"]);
    return r.listOnly === true && r.listTimeoutMs === 600000;
  })());
  ok("[args] a bare --list is of course still fine", parse(["--list"]).listOnly === true);

  // ---------------------------------------------------------------- figma-pull: --list-libraries
  // The library-discovery member of the cheap-index family. It must join EVERY guard the other two
  // are in — a new index command that gets added to the parser but forgotten by one guard is the
  // silent-loss bug this whole section exists to prevent, just wearing a new flag.
  console.log("\nfigma-pull — --list-libraries:");
  ok("[lib] --list-libraries parses as its own command", (() => {
    const r = parse(["--list-libraries"]);
    return r.listLibraries === true && r.listOnly === false && r.childrenId === null;
  })());
  // The prefix trap: `--list` is matched by exact includes(), so --list-libraries must NOT also read
  // as --list (which would run listPages and print the wrong thing entirely).
  ok("[lib] --list-libraries is NOT swallowed by --list", parse(["--list-libraries"]).listOnly === false);
  ok("[lib] it takes the LIST timeout tier, and --timeout raises it", (() => {
    const d = parse(["--list-libraries"]), t = parse(["--list-libraries", "--timeout", "600"]);
    return d.listTimeoutMs === 300000 && t.listTimeoutMs === 600000;
  })());
  // Like --list/--children it prints and exits before any export runs, so a scope flag alongside it
  // is a no-op the caller cannot observe.
  ok("[lib] --list-libraries + --page is an ERROR", /structural index/.test(usage(["--list-libraries", "--page", "1:2"]) || ""));
  ok("[lib] --list-libraries + --all-pages is an ERROR", /structural index/.test(usage(["--list-libraries", "--all-pages"]) || ""));
  ok("[lib] --list-libraries + --selection is an ERROR", /structural index/.test(usage(["--list-libraries", "--selection"]) || ""));
  ok("[lib] the refusal names --list-libraries, not another index command",
    /--list-libraries/.test(usage(["--list-libraries", "--all-pages"]) || ""));
  // Two index commands: only one would ever run and print; the other would vanish silently.
  ok("[lib] --list-libraries + --list is an ERROR", /only one/.test(usage(["--list-libraries", "--list"]) || ""));
  ok("[lib] --list-libraries + --children is an ERROR", /only one/.test(usage(["--list-libraries", "--children", "1:2"]) || ""));
  // Read options are equally inert here — it reports library identity/usage, never a serialized node.
  ok("[lib] every read option is refused on --list-libraries, none silently survives", (() => {
    const flags = ["--css", "--measurements", "--plugin-data", "--motion", "--shared-data", "--no-assets"];
    return flags.every((f) => /silently ignored/.test(usage(["--list-libraries", f]) || ""));
  })());
  ok("[lib] and the refusal names both the flag and this command",
    (() => { const m = usage(["--list-libraries", "--css"]) || ""; return /--css/.test(m) && /--list-libraries/.test(m); })());
  // --timeout genuinely applies (it is the list budget), so it must keep composing.
  ok("[lib] --timeout still composes with --list-libraries", parse(["--list-libraries", "--timeout", "60"]).listTimeoutMs === 60000);
  ok("[lib] a daemon command alongside it is refused",
    /cannot be combined with --list-libraries/.test(usage(["--serve", "--list-libraries"]) || ""));

  // ------------------------------------------------------------------------ figma-pull: --whoami
  // The identity/liveness probe joins the index-command family, so it must inherit every guard that
  // family has — the point of routing it through indexCmds rather than giving it a private branch.
  console.log("\nfigma-pull — --whoami:");
  ok("[whoami] parses as its own command", parse(["--whoami"]).whoami === true);
  ok("[whoami] is off by default", parse(["design"]).whoami === false);
  ok("[whoami] writes no outDir (it prints, like the other index commands)",
    parse(["--whoami"]).listOnly === false && parse(["--whoami"]).whoami === true);
  ok("[whoami] + an export scope is an ERROR", /cannot be combined/.test(usage(["--whoami", "--all-pages"]) || ""));
  ok("[whoami] + --list is an ERROR (two index commands)", /only one/.test(usage(["--whoami", "--list"]) || ""));
  ok("[whoami] + --list-libraries is an ERROR", /only one/.test(usage(["--whoami", "--list-libraries"]) || ""));
  ok("[whoami] every read option is refused, none silently survives", (() => {
    const flags = ["--css", "--measurements", "--plugin-data", "--motion", "--shared-data", "--no-assets"];
    return flags.every((f) => /silently ignored/.test(usage(["--whoami", f]) || ""));
  })());
  // The refusal must describe what --whoami actually emits, not claim it prints a structural index.
  ok("[whoami] the refusal describes what it DOES emit",
    /connection\/plugin identity/.test(usage(["--whoami", "--css"]) || ""));
  ok("[whoami] a daemon command alongside it is refused",
    /cannot be combined with --whoami/.test(usage(["--serve", "--whoami"]) || ""));

  // ------------------------------------------------ figma-pull: --client / --list-clients (routing)
  console.log("\nfigma-pull — multi-file routing flags:");
  // --client is an ADDRESS, not a scope: unlike every other flag here it must COMPOSE with all of
  // them, so the guards that refuse combinations must leave it alone.
  ok("[client] --client takes a value", parse(["design", "--client", "c2"]).client === "c2");
  ok("[client] the = form works too", parse(["design", "--client=NIMA"]).client === "NIMA");
  ok("[client] a file name with spaces survives", parse(["design", "--client", "App — Base"]).client === "App — Base");
  ok("[client] it is null when absent", parse(["design"]).client === null);
  ok("[client] --client with no value is a usage error",
    /needs a connection id/.test(usage(["design", "--client"]) || ""));
  // The positional [outDir] must not swallow --client's value, the bug class takeValues exists for.
  ok("[client] its value is not mistaken for outDir", parse(["--client", "c2", "design"]).outDir.endsWith("design"));
  ok("[client] composes with an export scope", (() => {
    const r = parse(["design", "--all-pages", "--client", "c1"]);
    return r.allPages === true && r.client === "c1";
  })());
  ok("[client] composes with read options", (() => {
    const r = parse(["design", "--page", "1:2", "--client", "lib", "--css"]);
    return r.client === "lib" && r.readOpts.css === true;
  })());
  ok("[client] composes with an index command (it addresses WHICH file to list)", (() => {
    const r = parse(["--list", "--client", "c2"]);
    return r.listOnly === true && r.client === "c2";
  })());

  ok("[list-clients] parses as its own command", parse(["--list-clients"]).listClients === true);
  ok("[list-clients] is off by default", parse(["design"]).listClients === false);
  ok("[list-clients] + an export scope is an ERROR", /cannot be combined/.test(usage(["--list-clients", "--all-pages"]) || ""));
  ok("[list-clients] + --list is an ERROR (two index commands)", /only one/.test(usage(["--list-clients", "--list"]) || ""));
  ok("[list-clients] + --whoami is an ERROR", /only one/.test(usage(["--list-clients", "--whoami"]) || ""));
  ok("[list-clients] read options are refused", /silently ignored/.test(usage(["--list-clients", "--css"]) || ""));
  ok("[list-clients] the refusal describes what it DOES emit",
    /which Figma files are connected/.test(usage(["--list-clients", "--css"]) || ""));

  // formatClients renders for a human. The EMPTY case matters most: "nothing connected" is the normal
  // state before the plugin is opened, and must read as an instruction rather than a failure.
  const noClients = pull.formatClients([]);
  ok("[list-clients] the empty listing explains rather than just printing nothing", /No Figma files are connected/.test(noClients));
  ok("[list-clients] and says how to fix it", /Design Twin/.test(noClients));
  ok("[list-clients] and mentions that SEVERAL files can connect", /SEVERAL files at once/.test(noClients));
  const twoClients = pull.formatClients([
    { connId: "c1", file: "App — Base", fileKey: "KEYBASE", page: "Home", uptimeMs: 65000, identified: true },
    { connId: "c2", file: "NIMA Library", fileKey: null, page: "Tokens", uptimeMs: 3000, identified: true },
  ]);
  ok("[list-clients] the listing counts the files", /2 Figma files connected/.test(twoClients));
  ok("[list-clients] each row leads with the connId --client takes", /c1\s+"App — Base"/.test(twoClients));
  ok("[list-clients] a present fileKey is shown", /fileKey KEYBASE/.test(twoClients));
  ok("[list-clients] a MISSING fileKey is explained, not blank", /no fileKey \(private-plugin API not in effect\)/.test(twoClients));
  ok("[list-clients] it tells you how to address one", /--client <connId \| fileKey \| part of the file name>/.test(twoClients));
  // An unidentified socket is a real state (connected, no hello yet) and must not render as a blank row.
  const anon = pull.formatClients([{ connId: "c9", file: null, fileKey: null, uptimeMs: 500, identified: false }]);
  ok("[list-clients] an unidentified client says so and stays addressable",
    /unidentified — address it by connId/.test(anon) && /c9/.test(anon));

  // Output rendering. The EMPTY case is the one that matters most: zero libraries is a NORMAL result
  // (free plan, or no library enabled in the Figma UI, or a plugin imported before the manifest
  // gained "teamlibrary") and must read as an explanation, not as a failure or an empty table.
  const emptyOut = pull.formatLibraries({ libraries: [], warnings: [] });
  ok("[lib] the empty case says so in words, not as a blank table", /No libraries reported/.test(emptyOut));
  ok("[lib] and states it is a normal outcome", /normal outcome/i.test(emptyOut));
  ok("[lib] and names the stale-plugin cause first (a reload is the usual fix)",
    /teamlibrary/.test(emptyOut) && /re-import/i.test(emptyOut) &&
    emptyOut.indexOf("teamlibrary") < emptyOut.search(/free plan/i));
  ok("[lib] and that libraries are enabled only in the Figma UI", /Figma UI/.test(emptyOut));
  ok("[lib] a missing libraries field is treated as empty, not a crash",
    /No libraries reported/.test(pull.formatLibraries({})));

  const libOut = pull.formatLibraries({
    libraries: [
      { key: "k1", name: "This file", kind: "local", componentCount: 3, variableCollections: [{ key: "c1", name: "Primitives", variableCount: 40 }] },
      { key: "k2", name: "NIMA Design System", kind: "library", componentCount: 12,
        variableCollections: [{ key: "c2", name: "Semantic", variableCount: 120 }, { key: "c3", name: "Brand", variableCount: 8 }],
        note: "variable collections unavailable on this plan" },
    ],
    warnings: [],
  });
  ok("[lib] it prints a table, not raw JSON", !/^\s*[{[]/.test(libOut) && /LIBRARIES \(2\)/.test(libOut));
  ok("[lib] every library name appears", /This file/.test(libOut) && /NIMA Design System/.test(libOut));
  ok("[lib] local vs library kind is shown", /\blocal\b/.test(libOut) && /\blibrary\b/.test(libOut));
  ok("[lib] variable counts are summed per library", /\b128\b/.test(libOut) && /\b40\b/.test(libOut));
  ok("[lib] each collection is listed with its own count", /Primitives \(40 variables\)/.test(libOut) && /Brand \(8 variables\)/.test(libOut));
  ok("[lib] a per-library note is surfaced rather than dropped", /note: variable collections unavailable/.test(libOut));
  // The counts are the part a reader will over-trust, so the caveat ships with every render.
  ok("[lib] component counts are labelled usage-derived", /USAGE-derived/.test(libOut));
  ok("[lib] and the no-enumeration limit is stated", /no API to enumerate/.test(libOut));
  // Alignment: the columns must line up, or it is JSON with extra steps.
  ok("[lib] the table columns are aligned across rows", (() => {
    // The header and both data rows must start their NAME column at the same offset — the one thing
    // that makes this a table rather than JSON with extra steps.
    const rows = libOut.split("\n").filter((l: string) => /^ {2}(KIND|local|library) /.test(l));
    const nameAt = rows.map((l: string) => ["This file", "NIMA Design System", "NAME"].reduce((n, s) => (l.includes(s) ? l.indexOf(s) : n), -1));
    return rows.length === 3 && new Set(nameAt).size === 1 && (nameAt[0] ?? -1) > 0;
  })());

  // The MCP twin. Checked against the server's own source, src/figma-mcp.ts — the file Node runs from a
  // checkout and tsc emits to dist/ — because the source compiling is not evidence the tool is
  // registered, and Zod silently strips anything undeclared.
  // Read here rather than reusing the `mcpSrc` below: this section runs first, and a const declared
  // further down is in its temporal dead zone.
  const libMcpSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "bridge", "src", "figma-mcp.ts"), "utf8");
  // Until the TS port this compared a generated figma-mcp.mjs bundle against src/figma-mcp.mts (a tool
  // added only to the bundle vanished on the next build — what happened to figma_whoami). There is no
  // bundle any more, so the two checks now pin the registered tool set: the core tools every agent
  // workflow depends on, and every tool `dtwin mcp --help` promises (a renamed tool must not leave the
  // help naming one that no longer exists).
  {
    const registered = [...libMcpSrc.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => must(m[1], "registerTool name capture"));
    const pullSrcForHelp = fs.readFileSync(path.join(import.meta.dirname, "..", "bridge", "src", "figma-pull.ts"), "utf8");
    const helpStart = pullSrcForHelp.indexOf('"dtwin mcp\\n\\n"');
    const helpText = helpStart === -1 ? "" : pullSrcForHelp.slice(helpStart, pullSrcForHelp.indexOf("process.exit(0)", helpStart));
    const named = (helpText.match(/figma_[a-z_]+\*?/g) || []).filter((t, i, a) => a.indexOf(t) === i);
    // `figma_export_*` is a glob over the export family (prefix match). A bare name that is not itself a
    // tool (the help's `figma_list`) names a family too: it must be the `<name>_` prefix of a real tool.
    const resolves = (t: string) => t.endsWith("*")
      ? registered.some((r) => r.startsWith(t.slice(0, -1)))
      : registered.includes(t) || registered.some((r) => r.startsWith(t + "_"));
    console.log("\nfigma-mcp — registered tool set (src/figma-mcp.ts):");
    ok("[mcp-gen] src/figma-mcp.ts registers the core tool set",
      ["figma_status", "figma_list_clients", "figma_write", "design_get_component", "design_drift_lint"].every((t) => registered.includes(t)));
    ok("[mcp-gen] every tool `dtwin mcp --help` names exists in src/figma-mcp.ts",
      named.length >= 5 && named.every(resolves));
  }

  // The routing surface on the MCP side. Every tool that reaches the plugin must accept `client`, or
  // an agent with two files connected can address some tools and not others — the worst outcome,
  // because the un-addressable ones fail only when a second file happens to be open.
  console.log("\nfigma-mcp — multi-file routing surface:");
  ok("[mcp-multi] figma_list_clients is registered", /"figma_list_clients"/.test(libMcpSrc));
  ok("[mcp-multi] it is read-only and needs no arguments", (() => {
    const b = libMcpSrc.slice(libMcpSrc.indexOf('"figma_list_clients"'), libMcpSrc.indexOf('"figma_whoami"'));
    return /READ_ONLY/.test(b) && !/inputSchema/.test(b);
  })());
  ok("[mcp-multi] it reads the bridge registry, never the plugin (answers during a long export)", (() => {
    const b = libMcpSrc.slice(libMcpSrc.indexOf('"figma_list_clients"'), libMcpSrc.indexOf('"figma_whoami"'));
    return /bridge\.listClients\(\)/.test(b) && !/bridge\.request/.test(b);
  })());
  ok("[mcp-multi] every plugin-reaching tool accepts a client target", (() => {
    // One clientShape spread per tool that calls bridge.request, plus the ones that only list.
    const spreads = (libMcpSrc.match(/\.\.\.clientShape/g) || []).length;
    const requests = (libMcpSrc.match(/bridge\.request\(/g) || []).length;
    return spreads >= requests;
  })());
  ok("[mcp-multi] and every bridge.request forwards it", (() => {
    // Each call must end with the routing argument; a forgotten one silently ignores `client`.
    const calls = libMcpSrc.match(/bridge\.request\([^;]*?\);/gs) || [];
    return calls.length > 0 && calls.every((c) => /a && a\.client/.test(c));
  })());
  ok("[mcp-multi] figma_status reports the roster rather than failing when several are connected",
    /Several Figma files are connected/.test(libMcpSrc));
  // The whoami description must no longer claim the bridge holds ONE connection — that was the old rule.
  ok("[mcp-multi] no tool description still claims a single-connection bridge",
    !/holds exactly ONE plugin connection/.test(libMcpSrc));

  ok("[lib] figma_list_libraries is registered in src/figma-mcp.ts", /"figma_list_libraries"/.test(libMcpSrc));
  ok("[lib] it sends the listLibraries bridge command", /"listLibraries"/.test(libMcpSrc));
  (() => {
    const body = libMcpSrc.slice(libMcpSrc.indexOf('"figma_list_libraries"'), libMcpSrc.indexOf('"figma_list_children"'));
    ok("[lib] it is annotated read-only", /READ_ONLY/.test(body));
    // It is a DISCOVERY call: the cheap budget tier, not an export's. Its ONLY argument is `client`
    // (which connected file to ask) — it gained one when the bridge learned to hold several files at
    // once, because "which libraries does this file use" needs to know which file you mean.
    ok("[lib] its only input is the routing target", /inputSchema: \{ \.\.\.clientShape \}/.test(body));
    ok("[lib] and it takes no OTHER arguments — nothing else to get wrong",
      !/readOptsShape|writeShape|z\.(string|boolean|number|union)/.test(body));
    ok("[lib] it uses the shared cheap list timeout tier, not an export budget",
      /TIMEOUTS\.list/.test(body) && !/exportTimeout/.test(body));
    // Compactness is the contract for a discovery call — it must not hand back an unbounded payload.
    ok("[lib] the result is compacted to the documented fields", /variableCollections/.test(body) && /componentCount/.test(body));
    ok("[lib] warnings survive the compaction (they explain an empty list)", /warnings/.test(body));
    ok("[lib] the usage-derived caveat travels with the result", /USAGE-derived/.test(body));
    ok("[lib] the empty case is explained in-result, not left ambiguous", /NORMAL outcome/.test(body));
    ok("[lib] and the stale-plugin/teamlibrary cause is named", /teamlibrary/.test(body));
  })();

  // ---------------------------------------------------------------- figma-pull: writePages layout
  // safe() folds every non-alphanumeric to "_", so DISTINCT page names collide. Sharing one directory
  // meant the second page's index.json OVERWROTE the first's — the first page's layer files stayed on
  // disk but vanished from every index, invisible to an agent following the manifest.
  console.log("\nfigma-pull — writePages layout:");
  // The pages/ layout is read back a dozen times below; one reader so a layout change (e.g. the index
  // filename) is one edit, not twelve.
  const readJson = <T,>(...p: string[]): T => JSON.parse(fs.readFileSync(path.join(...p), "utf8")) as T;
  const pagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-pages-"));
  pull.writePages(pagesDir, {
    exportedAt: "t",
    index: [{ name: "A", id: "1:1" }, { name: "B", id: "2:2" }, { name: "C", id: "3:3" }],
    layers: [
      { name: "A", id: "1:1", page: "Design System", pageId: "0:1", tree: node({ type: "FRAME", id: "1:1", name: "A" }) },
      { name: "B", id: "2:2", page: "Design/System", pageId: "0:2", tree: node({ type: "FRAME", id: "2:2", name: "B" }) }, // folds to the SAME dir as above
      { name: "C", id: "3:3", page: "Screens", pageId: "0:3", tree: node({ type: "FRAME", id: "3:3", name: "C" }) },
    ],
  });
  const rootIndex = readJson<PagesRootIndex>(pagesDir, "pages", "index.json");
  ok("[wp] every page gets its own directory, even when names fold alike",
    new Set(rootIndex.pageDirs.map((p) => p.dir)).size === 3);
  ok("[wp] each page's own name is preserved (only the DIRECTORY is disambiguated)",
    rootIndex.pageDirs.map((p) => p.page).join("|") === "Design System|Design/System|Screens");
  // The real regression: no layer may exist on disk yet be absent from its page index.
  ok("[wp] no layer is orphaned — every layer file is listed in its page's index", (() => {
    let listed = 0;
    for (const pd of rootIndex.pageDirs) {
      const idx = readJson<PageIndex>(pagesDir, "pages", pd.dir, "index.json");
      if (idx.layers.length !== pd.layers) return false;
      for (const l of idx.layers) { if (!fs.existsSync(path.join(pagesDir, l.file))) return false; listed++; }
    }
    return listed === 3;
  })());
  ok("[wp] each page index reports the page it actually describes", (() => {
    const seen = rootIndex.pageDirs.map((pd) =>
      readJson<PageIndex>(pagesDir, "pages", pd.dir, "index.json").page);
    return seen.join("|") === "Design System|Design/System|Screens";
  })());
  // Each pageDirs entry POINTS at its index file, exactly as each layer entry points at its own file.
  // Reassembling "pages/<dir>/index.json" from `dir` is right on this path and wrong on the plugin's
  // browser-download twin, where the HTML spec forces the same file to land flat as
  // "pages__<dir>__index.json" — so the pointer, not the convention, is the contract.
  ok("[wp] every page index is addressable by a pointer, not by convention",
    rootIndex.pageDirs.every((pd) => typeof pd.index === "string" && fs.existsSync(path.join(pagesDir, pd.index))));
  ok("[wp] and the pointer is relative to outDir, like each layer's `file`",
    rootIndex.pageDirs.every((pd) => !path.isAbsolute(pd.index) && pd.index.startsWith("pages/")));
  // The root index carries the flattened per-screen rows, not only the run manifest + pageDirs counts, so a consumer
  // need not go one hop down to `pages/<Page>/index.json` to find a single screen by name/title. The rows
  // (name/id/title/texts/file, no tree bytes) are in the file every
  // skill is told to read, so it has what it promises.
  ok("[wp] the root index carries the run manifest AND the flattened per-screen rows (no tree bytes)",
    rootIndex.exportedAt === "t" && Array.isArray(rootIndex.layers) && rootIndex.layers.length === 3 &&
    rootIndex.layers.map((l) => l.name).sort().join("|") === "A|B|C" &&
    rootIndex.layers.every((l) => l.id && l.file) &&
    JSON.stringify(rootIndex.layers).indexOf("\"children\"") === -1);
  ok("[wp] pages/ exists even for a zero-layer run", (() => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "figma-empty-"));
    pull.writePages(empty, { exportedAt: "t", index: [], layers: [] });
    return fs.existsSync(path.join(empty, "pages"));
  })());
  ok("[wp] each page dir carries the page ID, so two entries are tellable apart by more than a dir name",
    rootIndex.pageDirs.map((p) => p.pageId).join("|") === "0:1|0:2|0:3");
  fs.rmSync(pagesDir, { recursive: true, force: true });

  // The name-keyed bug's OTHER half: `uniqueDir()` only fixed page names that DIFFER but fold to the
  // same safe() string. Figma's Plugin API documents no uniqueness constraint on PageNode.name, and
  // two pages can be named identically — those were bucketed together (one dir, one index, one
  // pageDirs entry claiming both pages' layers), and uniqueDir never fired because only one bucket
  // was ever built. Identity is the page ID; the name is for display.
  const dupDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-duppage-"));
  pull.writePages(dupDir, {
    exportedAt: "t",
    index: [{ name: "A", id: "1:1" }, { name: "B", id: "2:2" }],
    layers: [
      { name: "A", id: "1:1", page: "Screens", pageId: "0:1", tree: node({ type: "FRAME", id: "1:1", name: "A" }) },
      { name: "B", id: "2:2", page: "Screens", pageId: "0:9", tree: node({ type: "FRAME", id: "2:2", name: "B" }) }, // SAME name, different page
    ],
  });
  const dupIndex = readJson<PagesRootIndex>(dupDir, "pages", "index.json");
  ok("[wp] two DISTINCT pages sharing a name stay two pages", dupIndex.pageDirs.length === 2);
  ok("[wp] and get separate directories", new Set(dupIndex.pageDirs.map((p) => p.dir)).size === 2);
  ok("[wp] each keeping the real (identical) page name, disambiguated only by id",
    dupIndex.pageDirs.every((p) => p.page === "Screens") &&
    dupIndex.pageDirs.map((p) => p.pageId).join("|") === "0:1|0:9");
  ok("[wp] and one layer each, not both in one bucket", (() => dupIndex.pageDirs.every((pd) => {
    const idx = readJson<PageIndex>(dupDir, "pages", pd.dir, "index.json");
    return pd.layers === 1 && idx.layers.length === 1 && idx.pageId === pd.pageId;
  }))());
  fs.rmSync(dupDir, { recursive: true, force: true });

  // Exports written before pageId existed must still lay out — fall back to the name as the key.
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-oldpage-"));
  pull.writePages(oldDir, {
    exportedAt: "t",
    index: [{ name: "A", id: "1:1" }, { name: "B", id: "2:2" }],
    layers: [{ name: "A", id: "1:1", page: "Screens", tree: node({ type: "FRAME", id: "1:1", name: "A" }) }, { name: "B", id: "2:2", page: "Screens", tree: node({ type: "FRAME", id: "2:2", name: "B" }) }],
  });
  const oldIndex = readJson<PagesRootIndex>(oldDir, "pages", "index.json");
  const oldPageDir0 = must(oldIndex.pageDirs[0], "old export's pageDirs[0]");
  ok("[wp] a pre-pageId export still groups by name (one bucket) rather than splitting per layer",
    oldIndex.pageDirs.length === 1 && oldPageDir0.layers === 2);
  ok("[wp] and OMITS pageId rather than emitting a null — absence means 'export predates page ids'",
    !("pageId" in oldPageDir0));
  fs.rmSync(oldDir, { recursive: true, force: true });

  // ---------------------------------------------------------------- stdout is not truncated on exit
  // --list / --children print their WHOLE payload to stdout, and an agent reads this CLI through a
  // PIPE. Node's stdout is asynchronous for pipes, so the process.exit(0) these branches used to end
  // with discarded everything still buffered: measured 369,799 bytes written, 65,536 delivered — cut
  // at one pipe buffer, yielding truncated JSON that fails to parse with nothing to say why.
  // bridge.close() replaces it: it releases the WS server (the handle that was keeping the loop alive,
  // and the reason an exit call was there at all) and lets Node drain stdout on its own.
  // Driven as a subprocess because that is the only way to observe the real thing — the pipe, the
  // async write, and the exit are all process-level. Payload is deliberately far over the 64KB pipe
  // buffer, since anything under it passes either way and would not have caught the bug.
  const exitDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-exit-"));
  // An ESM child: server-core reads FIGMA_BRIDGE_TOKEN at load time and a static import would hoist
  // above the env assignment, so the module is loaded with a dynamic import after it.
  const exitScript = path.join(exitDir, "drain.mjs");
  fs.writeFileSync(exitScript, [
    'process.env.FIGMA_BRIDGE_TOKEN = "t";',
    `const { createBridge } = await import(${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../bridge/src/server-core.ts")).href)});`,
    "const bridge = createBridge(0);", // port 0 -> ephemeral, so the suite never fights a real bridge on 8787
    'const big = JSON.stringify({ pages: Array.from({ length: 4000 }, (_, i) => ({ id: "1:" + i, name: "page " + i, w: 100, h: 200 })) }, null, 2);',
    'process.stderr.write("BYTES:" + big.length + "\\n");',
    "console.log(big);",
    "bridge.close();", // the fix under test: no process.exit()
  ].join("\n"));
  const drained = spawnSync(process.execPath, [exitScript], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const intended = Number((/BYTES:(\d+)/.exec(drained.stderr || "") || [])[1]);
  ok("[exit] the harness actually produced a payload larger than a pipe buffer", intended > 65536);
  ok("[exit] closing the bridge lets the process exit on its own (no hang, no process.exit)",
    drained.status === 0 && !drained.error);
  // The regression itself: every byte survives. Under the old process.exit(0) this landed at 65,536.
  ok("[exit] the WHOLE payload reaches a pipe — stdout is not truncated",
    drained.stdout.length === intended + 1); // +1 for console.log's newline
  ok("[exit] and the delivered payload is still parseable JSON",
    (() => { try { return (JSON.parse(drained.stdout) as { pages: unknown[] }).pages.length === 4000; } catch { return false; } })());
  fs.rmSync(exitDir, { recursive: true, force: true });

  // ---------------------------------------------------------------- staleness stamp: write-through + figma_status
  // design-system.json's `exportedAt`/`file` are stamped by the PLUGIN (collect.ts/components.ts), not
  // by figma-pull — this only proves the CLI's write path is faithful (never strips or re-derives the
  // stamp) and that snapshot-meta.js (the shared reader figma_status uses) reads it back correctly.
  console.log("\nfigma-pull / figma-mcp — snapshot freshness stamp:");
  const snapshotMeta = await import("../bridge/src/snapshot-meta.ts");
  // readSnapshotInfo returns SnapshotInfo | SnapshotParseError | null; the assertions below probe fields
  // of either arm (a missing one reads as undefined, exactly as before), so read it through that view.
  const readSnapshotInfo = (dir?: string): Partial<SnapshotInfo & SnapshotParseError> | null => snapshotMeta.readSnapshotInfo(dir);
  const stampDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-stamp-"));
  const stampedAt = new Date(Date.now() - 5 * 3600000).toISOString(); // 5h old
  pull.writeJson(stampDir, "design-system.json", { exportedAt: stampedAt, file: "My Design File", components: [] }, true);
  const stamped = JSON.parse(fs.readFileSync(path.join(stampDir, "design-system.json"), "utf8")) as DesignSystemStamp;
  ok("[stamp] figma-pull writes design-system.json's exportedAt through unchanged", stamped.exportedAt === stampedAt);
  ok("[stamp] and the file name too", stamped.file === "My Design File");

  const info = readSnapshotInfo(stampDir);
  ok("[status] readSnapshotInfo finds the export and reports its exportedAt", !!(info && info.exportedAt === stampedAt));
  ok("[status] and the source file name, under sourceFile (distinct from its OWN `file` = the json path)",!!(
    info && info.sourceFile === "My Design File" && info.file === path.join(stampDir, "design-system.json")));
  ok("[status] and computes a plausible age (~5h, generously bounded)",!!(
    info && (info.ageMs ?? NaN) > 4.9 * 3600000 && (info.ageMs ?? NaN) < 5.1 * 3600000));

  ok("[status] missing export dir -> null, not a throw (not-yet-exported is not an error)",
    readSnapshotInfo(path.join(stampDir, "does-not-exist")) === null);

  const noStampDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-nostamp-"));
  pull.writeJson(noStampDir, "design-system.json", { components: [] }, true); // no exportedAt at all
  const noStampInfo = readSnapshotInfo(noStampDir);
  ok("[status] a snapshot with no exportedAt reports a warning instead of pretending it's fresh",!!(
    noStampInfo && noStampInfo.exportedAt === undefined && typeof noStampInfo.warning === "string"));

  const badJsonDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-badjson-"));
  fs.mkdirSync(badJsonDir, { recursive: true });
  fs.writeFileSync(path.join(badJsonDir, "design-system.json"), "{ not valid json");
  const badInfo = readSnapshotInfo(badJsonDir);
  ok("[status] unparseable design-system.json reports an error, not a crash", !!(badInfo && typeof badInfo.error === "string"));

  // A single-screen pull writes design/<Screen>.json and NOTHING else that is stamped —
  // no design-system.json, no pages/index.json. Reading only the first meant doctor told someone who
  // had just exported a screen that nothing had been exported yet.
  (() => {
    const scrDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-screen-"));
    const at = new Date(Date.now() - 2 * 3600000).toISOString();
    fs.writeFileSync(path.join(scrDir, "Skills_list.json"), JSON.stringify({ exportedAt: at, screen: "Skills list", nodes: [{ id: "1:2" }], manifest: {} }));
    const i = readSnapshotInfo(scrDir);
    ok("[status] a single-screen export IS an export — its stamp is found with no design-system.json",!!(
      i && i.exportedAt === at && (i.ageMs ?? NaN) > 1.9 * 3600000));
    ok("[status] and a screen doc's `screen` stands in for the source-file name",!!(
      i && i.sourceFile === "Skills list"));
    // design/ also holds files this tool GENERATES. None of them may be mistaken for the export.
    fs.writeFileSync(path.join(scrDir, "target.json"), JSON.stringify({ profile: "web-tailwind" }));
    fs.writeFileSync(path.join(scrDir, "tokens.dtcg.json"), JSON.stringify({ color: { bg: { $value: "#fff" } } }));
    fs.writeFileSync(path.join(scrDir, "tokens.resolver.json"), JSON.stringify({ name: "r", sets: [] }));
    ok("[status] generated files (target/tokens.*) are not mistaken for the export",!!(
      readSnapshotInfo(scrDir)?.file?.endsWith("Skills_list.json")));
    // variables.json IS export-shaped (variables[]) but carries no stamp of its own; a stamped doc
    // sitting next to it must win, or the report reads "freshness unknown" for a fresh export.
    fs.writeFileSync(path.join(scrDir, "variables.json"), JSON.stringify({ variables: [{ name: "x" }] }));
    const withVars = readSnapshotInfo(scrDir);
    ok("[status] an unstamped variables.json never outranks the stamped screen doc beside it",
      withVars?.exportedAt === at && withVars.warning === undefined);
    // …but when it is genuinely the only export-shaped file, it is still reported (with the warning)
    // rather than the caller being told nothing was exported at all.
    const onlyVars = fs.mkdtempSync(path.join(os.tmpdir(), "figma-onlyvars-"));
    fs.writeFileSync(path.join(onlyVars, "variables.json"), JSON.stringify({ variables: [] }));
    const ov = readSnapshotInfo(onlyVars);
    ok("[status] an unstamped export is reported WITH its warning, not as 'nothing exported'",!!(
      ov && ov.exportedAt === undefined && /variables\.json/.test(ov.warning ?? "")));
    // A page walk's index is the third shape.
    const pagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-pages-"));
    fs.mkdirSync(path.join(pagesDir, "pages"));
    fs.writeFileSync(path.join(pagesDir, "pages", "index.json"), JSON.stringify({ exportedAt: at, pageDirs: [] }));
    ok("[status] a page walk's pages/index.json is found too", readSnapshotInfo(pagesDir)?.exportedAt === at);
    // And a directory with only generated output is still "nothing exported".
    const genOnly = fs.mkdtempSync(path.join(os.tmpdir(), "figma-genonly-"));
    fs.writeFileSync(path.join(genOnly, "target.json"), JSON.stringify({ profile: "web-tailwind" }));
    ok("[status] a design/ holding only generated files still reports no export",
      readSnapshotInfo(genOnly) === null);
  })();

  ok("[status] FIGMA_EXPORT_DIR env is honored when no outDir arg is given", (() => {
    const prev = process.env.FIGMA_EXPORT_DIR;
    process.env.FIGMA_EXPORT_DIR = stampDir;
    try {
      return readSnapshotInfo()?.exportedAt === stampedAt;
    } finally {
      if (prev === undefined) delete process.env.FIGMA_EXPORT_DIR; else process.env.FIGMA_EXPORT_DIR = prev;
    }
  })());

  fs.rmSync(stampDir, { recursive: true, force: true });
  fs.rmSync(noStampDir, { recursive: true, force: true });
  fs.rmSync(badJsonDir, { recursive: true, force: true });

  // figma-mcp.ts wires readSnapshotInfo into figma_status's result unconditionally (both the
  // connected and not-connected branches carry `snapshot`) — checked statically here rather than by
  // importing figma-mcp.ts, whose top-level createBridge()/main() open a real WS server + stdio
  // transport and would hang the test process.
  const mcpSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "bridge", "src", "figma-mcp.ts"), "utf8");
  ok("[status] figma-mcp.ts wires snapshot-meta's readSnapshotInfo into figma_status",
    /snapshot-meta\.ts/.test(mcpSrc) && /readSnapshotInfo/.test(mcpSrc));
  ok("[status] figma_status reports `snapshot` on BOTH the connected and disconnected branches",
    (() => {
      const toolBody = mcpSrc.slice(mcpSrc.indexOf('"figma_status"'), mcpSrc.indexOf('"figma_get_selection"'));
      return (toolBody.match(/snapshot/g) || []).length >= 3; // definition + both branches
    })());

  // ---------------------------------------------------------------- write-out: the shared writer
  // write-out.js is the ONE writer both front-ends go through. These check the two things that make
  // the MCP path complete on its own: asset BYTES land on disk (stripAssets throws them away inline,
  // and the CLI cannot be run to fill the gap while the MCP holds port 8787), and what comes BACK is
  // a compact index — counts and paths, never node payloads.
  const OUT = await import("../bridge/src/write-out.ts");
  // writeAny/writeExport return a different shape per export kind (screen / screenshot / library /
  // full). Each assertion below knows which kind its fixture selects; this view keeps every arm's
  // fields at their real types but optional, so probing the selected arm type-checks and an absent
  // field still reads as undefined.
  type AllKeys<U> = U extends unknown ? keyof U : never;
  type Merged<U> = { [K in AllKeys<U>]?: U extends unknown ? (K extends keyof U ? U[K] : never) : never };
  type WriteResult = ReturnType<typeof OUT.writeAny>;
  type WithoutWrote<U> = U extends unknown ? Omit<U, "wrote"> : never;
  type WriteView = Merged<WithoutWrote<WriteResult>> & { wrote: Merged<WriteResult["wrote"]> };
  const wdir = fs.mkdtempSync(path.join(os.tmpdir(), "write-out-"));

  // ---------- writeScreen: title/texts land in the index ----------
  // Real node tree from the livetest3 fixture (the `positions ` frame — layer name "positions ",
  // visible title "Jet Roles"), pruned to the fields deriveTitle/collectTexts read.
  {
    const fixtureScreen = JSON.parse(fs.readFileSync(
      path.join(import.meta.dirname, "fixtures", "livetest3", "pages-titled", "__Optimization_management_", "positions___7314_87192.json"), "utf8")) as ScreenExport;
    const sdir = fs.mkdtempSync(path.join(os.tmpdir(), "write-screen-"));
    OUT.writeScreen(sdir, screenReply({
      screenName: "positions ",
      nodeId: "7314:87192",
      page: "✅ Optimization management ",
      pageId: "5282:58823",
      screen: { screen: "positions ", nodes: fixtureScreen.nodes, manifest: fixtureScreen.manifest, exportedAt: "2026-09-23T00:00:00.000Z" },
    }), undefined);
    const rootIdx = JSON.parse(fs.readFileSync(path.join(sdir, "pages", "index.json"), "utf8")) as PagesRootIndex;
    const pageIdx = JSON.parse(fs.readFileSync(path.join(sdir, "pages", "__Optimization_management_", "index.json"), "utf8")) as PageIndex;
    const rootRow0 = must(rootIdx.layers?.[0], "rootIdx.layers[0]");
    ok("[write-screen] the ROOT index row carries the visible title, not just the Figma layer name",
      Array.isArray(rootIdx.layers) && rootIdx.layers.length === 1 &&
      rootRow0.name === "positions " && rootRow0.title === "Jet Roles");
    ok("[write-screen] the PAGE index row carries the same title",
      pageIdx.layers.length === 1 && pageIdx.layers[0]?.title === "Jet Roles");
    ok("[write-screen] the row also carries a texts[] fingerprint, deduped and non-empty",
      Array.isArray(rootRow0.texts) && rootRow0.texts.length > 0 &&
      new Set(rootRow0.texts).size === rootRow0.texts.length);
    fs.rmSync(sdir, { recursive: true, force: true });
  }

  // ---------- writeScreen: sourceFile stamp lands on the screen doc AND its index row ----------
  // figma-pull.js resolves which connected Figma file a pull actually talked to and stamps the RESULT
  // as `r.sourceFile` (see resolveSourceFile()/stampSource() there); write-out.js's job is only to
  // persist it. Before this fix, a screen JSON carried no field naming its own source at all, so
  // doctor.js could only ever report whichever file design-system.json or the snapshot-meta pick
  // happened to name — attributing every screen to the wrong Figma file when the design system lives
  // in a different one.
  {
    const sdir2 = fs.mkdtempSync(path.join(os.tmpdir(), "write-screen-src-"));
    OUT.writeScreen(sdir2, screenReply({
      screenName: "positions ",
      nodeId: "7314:87192",
      page: "✅ Optimization management ",
      pageId: "5282:58823",
      sourceFile: "TideStack (Copy)",
      screen: { screen: "positions ", nodes: [{ id: "7314:87192", type: "FRAME", name: "positions " }], manifest: { nodes: 1 }, exportedAt: "2026-09-23T00:00:00.000Z" },
    }), undefined);
    const screenDoc = JSON.parse(fs.readFileSync(path.join(sdir2, "pages", "__Optimization_management_", "positions___7314_87192.json"), "utf8")) as ScreenExport;
    const rootIdx2 = JSON.parse(fs.readFileSync(path.join(sdir2, "pages", "index.json"), "utf8")) as PagesRootIndex;
    ok("[write-screen sourceFile] lands on the screen doc's own top level", screenDoc.sourceFile === "TideStack (Copy)");
    ok("[write-screen sourceFile] lands on the root index row too", rootIdx2.layers?.[0]?.sourceFile === "TideStack (Copy)");
    fs.rmSync(sdir2, { recursive: true, force: true });

    // No sourceFile given (an unresolved/ambiguous client, or a caller that never asked) — the field
    // is simply ABSENT, never a guessed or default value.
    const sdir3 = fs.mkdtempSync(path.join(os.tmpdir(), "write-screen-nosrc-"));
    OUT.writeScreen(sdir3, screenReply({
      screenName: "positions ",
      nodeId: "7314:87192",
      page: "✅ Optimization management ",
      pageId: "5282:58823",
      screen: { screen: "positions ", nodes: [{ id: "7314:87192", type: "FRAME", name: "positions " }], manifest: { nodes: 1 }, exportedAt: "2026-09-23T00:00:00.000Z" },
    }), undefined);
    const screenDoc2 = JSON.parse(fs.readFileSync(path.join(sdir3, "pages", "__Optimization_management_", "positions___7314_87192.json"), "utf8")) as ScreenExport;
    ok("[write-screen sourceFile] absent when the pull result carried none — never defaulted", !("sourceFile" in screenDoc2));
    fs.rmSync(sdir3, { recursive: true, force: true });
  }

  // ---------- library-file export layout (--as-library) ----------
  // The library catalog must land in a tree that CANNOT collide with design-system/, because the two
  // describe different Figma files and answer different questions.
  {
    const libDoc: DesignSystemDoc = {
      file: "NIMA DS",
      exportedAt: "2026-08-16T00:00:00.000Z",
      colorProfile: "srgb",
      source: { role: "library", libraryName: "NIMA", fileKey: "ABCDEFGH12345", collectionKeys: ["ck_core"] },
      collections: [collection({ name: "Core", modes: ["Light"], default: "Light", key: "ck_core", publish: "current" })],
      variables: [variable({ name: "color/primary", type: "COLOR", collection: "Core", tier: "primitive", values: { Light: "#112233" }, key: "vk1", publish: "current" })],
      styles: { paint: [{ name: "Brand", key: "pk1", publish: "changed" }], text: [], effect: [], grid: [] },
      // A main consumed from ANOTHER library: not this library's to claim.
      components: [component({ name: "Button", type: "COMPONENT", key: "ck1", publish: "current" }), component({ name: "Foreign", type: "COMPONENT", key: "ck2", remote: true })],
      hygiene: [],
    };
    const ldir = fs.mkdtempSync(path.join(os.tmpdir(), "write-lib-"));
    const res: WriteView = OUT.writeExport(path.join(ldir, "design"), { designSystem: libDoc }, () => {});
    const base = path.join(ldir, "design");
    const dirName = "nima-ABCDEFGH".slice(0, 4) + "-ABCDEFGH"; // slug("NIMA") + first 8 of fileKey
    ok("[lib-layout] lands under libraries/<slug>-<fileKey8>/", res.wrote.library === "libraries/" + dirName);
    ok("[lib-layout] directory identity uses fileKey, which survives a rename", /-ABCDEFGH$/.test(res.wrote.library ?? ""));
    ok("[lib-layout] never writes into design-system/", !fs.existsSync(path.join(base, "design-system")));
    ok("[lib-layout] tokens.json exists", fs.existsSync(path.join(base, "libraries", dirName, "tokens.json")));
    const tok = JSON.parse(fs.readFileSync(path.join(base, "libraries", dirName, "tokens.json"), "utf8")) as TokensDoc;
    // The shape contract: a top-level `variables` array is what keeps design-to-code/catalog-input.ts from
    // rejecting this as the slim manifest, and what lets design-to-code/tokens.ts run on it unchanged.
    ok("[lib-layout] tokens.json carries a top-level variables array", Array.isArray(tok.variables) && tok.variables.length === 1);
    ok("[lib-layout] tokens.json carries collections for the mode join", Array.isArray(tok.collections));
    ok("[lib-layout] every split file repeats the freshness stamp", tok.exportedAt === libDoc.exportedAt && tok.file === "NIMA DS");
    ok("[lib-layout] and carries source so a consumer knows it is a library", tok.source?.role === "library");

    const comps = JSON.parse(fs.readFileSync(path.join(base, "libraries", dirName, "components.json"), "utf8")) as ComponentsCatalog;
    ok("[lib-layout] a component from ANOTHER library is not claimed by this one", comps.components.length === 1 && comps.components[0]?.name === "Button");
    const hyg = JSON.parse(fs.readFileSync(path.join(base, "libraries", dirName, "hygiene.json"), "utf8")) as HygieneDoc;
    ok("[lib-layout] and the drop is reported, not silent", hyg.hygiene.some((h) => /ANOTHER library were dropped/.test(h)));

    const idx = JSON.parse(fs.readFileSync(path.join(base, "libraries", dirName, "index.json"), "utf8")) as LibraryManifest;
    ok("[lib-layout] the directory self-describes via index.json", !!(idx.files && idx.files.tokens && idx.counts.variables === 1));
    ok("[lib-layout] index summarises publish status", idx.publish && (idx.publish.current ?? 0) >= 1 && idx.publish.changed === undefined ? true : !!idx.publish);

    // LibrariesIndex types carried-through rows as unknown[]; every row here was written by this run, so read them as rows.
    type LibrariesIndexView = LibrariesIndex & { libraries: LibrariesIndexRow[] };
    const root = JSON.parse(fs.readFileSync(path.join(base, "libraries", "index.json"), "utf8")) as LibrariesIndexView;
    ok("[lib-layout] libraries/index.json lists the library", root.libraries.length === 1 && root.libraries[0]?.libraryName === "NIMA");
    // A second library must not erase the first: each is a separate plugin run in a separate file.
    const second = JSON.parse(JSON.stringify(libDoc)) as DesignSystemDoc;
    second.file = "Icons";
    const secondSource = must(second.source, "second.source");
    secondSource.libraryName = "Icons"; secondSource.fileKey = "ZZZZZZZZ999";
    OUT.writeExport(path.join(ldir, "design"), { designSystem: second }, () => {});
    const root2 = JSON.parse(fs.readFileSync(path.join(base, "libraries", "index.json"), "utf8")) as LibrariesIndexView;
    ok("[lib-layout] a second library is ADDED, not substituted", root2.libraries.length === 2);
    // Re-exporting the SAME library replaces its own row only.
    OUT.writeExport(path.join(ldir, "design"), { designSystem: libDoc }, () => {});
    const root3 = JSON.parse(fs.readFileSync(path.join(base, "libraries", "index.json"), "utf8")) as LibrariesIndexView;
    ok("[lib-layout] re-exporting the same library does not duplicate its row", root3.libraries.length === 2);

    // Orphan reporting: a file the previous export produced and this one did not is REPORTED, never
    // deleted — a read command must not remove files it did not create.
    const stale = path.join(base, "libraries", dirName, "styles.text.json");
    ok("[lib-layout] a previously written split file is still on disk", fs.existsSync(stale));
    let logged: string[] = [];
    const shrunk = JSON.parse(JSON.stringify(libDoc)) as DesignSystemDoc;
    // Simulate a build that no longer emits text styles by rewriting the index to claim an extra file.
    const idxPath = path.join(base, "libraries", dirName, "index.json");
    // de-any: the test plants an EXTRA pointer (`ghost`) that LibraryManifest["files"] does not name, so files is widened here.
    const idxDoc = JSON.parse(fs.readFileSync(idxPath, "utf8")) as LibraryManifest & { files: Record<string, string> };
    idxDoc.files.ghost = "libraries/" + dirName + "/ghost.json";
    fs.writeFileSync(idxPath, JSON.stringify(idxDoc));
    fs.writeFileSync(path.join(base, "libraries", dirName, "ghost.json"), "{}");
    const res2: WriteView = OUT.writeExport(path.join(ldir, "design"), { designSystem: shrunk }, (m) => logged.push(m));
    ok("[lib-layout] an orphaned file is reported", (res2.wrote.orphans ?? []).some((o) => /ghost\.json$/.test(o)));
    ok("[lib-layout] and it is NOT deleted", fs.existsSync(path.join(base, "libraries", dirName, "ghost.json")));
    ok("[lib-layout] the orphan warning reaches the user", logged.some((m) => /STALE:/.test(m)));
    // `files` is the pointer map; a corrupt index holding an ARRAY there is not walked as one (its
    // entries used to be reported as orphans even though no export ever mapped them).
    fs.writeFileSync(idxPath, JSON.stringify({ ...idxDoc, files: ["libraries/" + dirName + "/ghost.json"] }));
    logged = [];
    const res3: WriteView = OUT.writeExport(path.join(ldir, "design"), { designSystem: shrunk }, (m) => logged.push(m));
    ok("[lib-layout] a non-object `files` in the previous index reports no orphans", (res3.wrote.orphans ?? []).length === 0 && !logged.some((m) => /STALE:/.test(m)));
  }


  const full: WriteView = OUT.writeAny(path.join(wdir, "design"), {
    designSystem: {
      file: "Demo",
      exportedAt: "2026-08-12T00:00:00.000Z",
      colorProfile: "srgb",
      collections: [collection({ name: "Core", modes: ["Light"] })],
      variables: [variable({ name: "color/bg", type: "COLOR", values: {} })],
      styles: { paint: [{ name: "Brand" }], text: [], effect: [], grid: [] },
      components: [
        { key: "k1", name: "Button", type: "COMPONENT", id: "2:1", page: "Home", pageId: "1:0" },
        { key: "k2", name: "Card", type: "COMPONENT", remote: true, derivedFrom: "instances" },
        { key: "k3", name: "Badge", type: "COMPONENT_SET", id: "2:9", page: "Home", pageId: "1:0",
          variants: [
            { id: "2:10", name: "Size=Small", key: "vk1", values: { Size: "Small" }, node: node({ type: "COMPONENT", id: "2:10", name: "Size=Small", children: [] }) },
            { id: "2:11", name: "Size=Large", key: "vk2", values: { Size: "Large" }, node: node({ type: "COMPONENT", id: "2:11", name: "Size=Large", children: [] }) },
          ] },
        { key: "k4", name: "NoNodes", type: "COMPONENT_SET", id: "2:12", page: "Home", pageId: "1:0",
          variants: [{ id: "2:13", name: "State=Default", key: "vk3", values: { State: "Default" } }] },
      ],
      hygiene: ["variant explosion: 'Button'"],
    },
    layersDoc: {
      index: [{ id: "1:2", name: "Hero", type: "FRAME", pageId: "1:0", page: "Home" }],
      layers: [{ id: "1:2", name: "Hero", tree: node({ type: "FRAME", id: "1:2", name: "Hero" }) }],
    },
    assets: [
      asset({ id: "1:3", file: "icon.svg", text: "<svg/>" }),
      asset({ id: "1:4", file: "img.png", base64: Buffer.from("hi").toString("base64") }),
    ],
  });
  ok("[write-out] the full export writes design-system.json",
    fs.existsSync(path.join(wdir, "design", "design-system.json")));
  ok("[write-out] asset BYTES land on disk — the thing the inline MCP path cannot do",
    fs.readFileSync(path.join(wdir, "design", "assets", "icon.svg"), "utf8") === "<svg/>" &&
    fs.readFileSync(path.join(wdir, "design", "assets", "img.png"), "utf8") === "hi");
  ok("[write-out] base64 assets are decoded, not written as base64 text",
    fs.readFileSync(path.join(wdir, "design", "assets", "img.png"), "utf8") !== Buffer.from("hi").toString("base64"));
  ok("[write-out] it reports the asset count it actually wrote", full.wrote.assets === 2);
  ok("[write-out] and a layer-file count", full.wrote.layerFiles === 1);
  // The whole point of the writeToDisk path: the RESULT is an index, not the export.
  // "no payload" means no serialized subtree (`children`) — not the absence of a layer's own
  // name/type, which the index deliberately carries (`full.index.layers[].name/type`) so
  // a consumer can resolve a screen from the index alone, without opening its node file.
  ok("[write-out] the returned index carries NO node payload (no serialized subtree)",
    (() => {
      const s = JSON.stringify(full);
      return !s.includes("\"children\"");
    })());
  ok("[write-out] but it DOES carry the layer's own name/type, so a screen resolves from the index alone",!!(
    full.index && Array.isArray(full.index.layers) &&
    full.index.layers.some((l) => l.name === "Hero" && l.type === "FRAME")));
  ok("[write-out] the freshness stamp survives the write byte-for-byte",
    (JSON.parse(fs.readFileSync(path.join(wdir, "design", "design-system.json"), "utf8")) as DesignSystemManifest).exportedAt ===
      "2026-08-12T00:00:00.000Z");

  // --- the design-system split (bridge/design-system-layout.js) -------------------------------
  // The catalog is no longer one flat object: Figma's own model has three separate systems
  // (VariableCollections+Variables / Paint|Text|Effect|GridStyle / Components), and library
  // components are not nodes in this file at all.
  // The eight parts land in design-system/ — design/tokens.json and design/components.json at the
  // export ROOT are the user's hand-authored, non-regenerable config maps and must not be clobbered.
  const readDS = <T,>(n: string): T => JSON.parse(fs.readFileSync(path.join(wdir, "design", "design-system", n), "utf8")) as T;
  ok("[ds-split] tokens.json carries the collections + variables, and nothing else's payload",
    // de-any: styles/components are asserted ABSENT from tokens.json — they are not fields of TokensDoc, so they are named here.
    (() => { const t = readDS<TokensDoc & { styles?: unknown; components?: unknown }>("tokens.json");
      return t.collections?.length === 1 && t.variables?.length === 1 && !t.styles && !t.components; })());
  ok("[ds-split] styles are split one file per type — styles.paint.json/text/effect/grid",
    (() => { const p = readDS<PaintStylesDoc>("styles.paint.json").styles, t = readDS<TextStylesDoc>("styles.text.json").styles,
        e = readDS<EffectStylesDoc>("styles.effect.json").styles, g = readDS<GridStylesDoc>("styles.grid.json").styles;
      return p.length === 1 && Array.isArray(t) && t.length === 0 && Array.isArray(e) && Array.isArray(g); })());
  ok("[ds-split] components.local.json holds only real nodes in this file (id/page/pageId)",
    (() => { const c = readDS<ComponentsCatalog>("components.local.json").components;
      const c0 = must(c[0], "components.local.json components[0]");
      return c.length === 3 && c0.key === "k1" && !!c0.id && !!c0.pageId; })());

  // --- component detail split (variants[].node stripped into design-system/components/) --------
  ok("[component-split] the COMPONENT_SET with exported node trees gets a variantsFile pointer",
    (() => { const c = readDS<ComponentsCatalog>("components.local.json").components.find((x) => x.key === "k3");
      return !!c && !!c.variantsFile && c.variantsFile === "design-system/components/Badge__2_9.json"; })());
  ok("[component-split] its variants in the catalog keep id/name/key/values but lose .node",
    (() => { const c = readDS<ComponentsCatalog>("components.local.json").components.find((x) => x.key === "k3");
      const v = c?.variants; const v0 = v?.[0];
      return !!v && v.length === 2 && !!v0 && v0.id === "2:10" && v0.values?.Size === "Small" && !("node" in v0); })());
  ok("[component-split] a COMPONENT_SET with no exported node trees gets NO pointer (absence = not exported)",
    (() => { const c = readDS<ComponentsCatalog>("components.local.json").components.find((x) => x.key === "k4");
      return !!c && !("variantsFile" in c) && c.variants?.length === 1; })());
  ok("[component-split] the detail file carries the full node trees + stamp + set identity",
    (() => { const d = JSON.parse(fs.readFileSync(path.join(wdir, "design", "design-system", "components", "Badge__2_9.json"), "utf8")) as ComponentDetailFile;
      return d.setId === "2:9" && d.setKey === "k3" && d.name === "Badge" && d.variants?.length === 2 &&
        d.variants?.[0]?.node?.type === "COMPONENT" && d.exportedAt === "2026-08-12T00:00:00.000Z"; })());
  ok("[component-split] design-system.json's manifest points at the components/ dir when one was written",
    (JSON.parse(fs.readFileSync(path.join(wdir, "design", "design-system.json"), "utf8")) as DesignSystemManifest).files.componentsDir === "design-system/components");
  // …and OMITS the key when it was not. A pointer that resolves to nothing is worse than an absent
  // key: a tool walking `files` verbatim got ENOENT on one entry of nine.
  ok("[component-split] and omits componentsDir entirely when no detail file was produced",
    (() => {
      const d2 = path.join(wdir, "nodetail");
      OUT.writeExport(d2, { designSystem: { exportedAt: "2026-08-12T00:00:00.000Z", file: "F", components: [{ name: "Button", key: "k1", type: "COMPONENT" }] } });
      const m = JSON.parse(fs.readFileSync(path.join(d2, "design-system.json"), "utf8")) as DesignSystemManifest;
      return m.files.componentsDir === undefined && !fs.existsSync(path.join(d2, "design-system", "components"));
    })());
  ok("[ds-split] components.library.json holds only remote:true entries — inferred from instances, not nodes here",
    (() => { const c = readDS<ComponentsCatalog>("components.library.json").components;
      const c0 = must(c[0], "components.library.json components[0]");
      return c.length === 1 && c0.key === "k2" && c0.remote === true && c0.id === undefined; })());
  ok("[ds-split] hygiene.json is the lint report on its own", readDS<HygieneDoc>("hygiene.json").hygiene.length === 1);
  ok("[ds-split] every split file repeats the freshness stamp, so drift-lint/figma_status work off any of them",
    ["tokens.json", "styles.paint.json", "styles.text.json", "styles.effect.json", "styles.grid.json",
     "components.local.json", "components.library.json", "hygiene.json"]
      .every((n) => readDS<DesignSystemStamp>(n).exportedAt === "2026-08-12T00:00:00.000Z" && readDS<DesignSystemStamp>(n).file === "Demo"));
  ok("[ds-split] design-system.json is now a slim manifest: stamp + pointers, no bulk data",
    // de-any: variables/components/styles are asserted ABSENT from the slim manifest — not fields of DesignSystemManifest.
    (() => { const m = JSON.parse(fs.readFileSync(path.join(wdir, "design", "design-system.json"), "utf8")) as DesignSystemManifest & { variables?: unknown; components?: unknown; styles?: unknown };
      return m.file === "Demo" && m.colorProfile === "srgb" && m.files.tokens === "design-system/tokens.json" &&
        m.files.componentsLibrary === "design-system/components.library.json" && !m.variables && !m.components && !m.styles; })());
  ok("[ds-split] the manifest counts local and library components, and each style bucket, separately",
    (() => { const c = (JSON.parse(fs.readFileSync(path.join(wdir, "design", "design-system.json"), "utf8")) as DesignSystemManifest).counts;
      return c.variables === 1 && c.components === 3 && c.libraryComponents === 1 && c.hygiene === 1 &&
        c.stylesPaint === 1 && c.stylesText === 0 && c.stylesEffect === 0 && c.stylesGrid === 0; })());

  // --- the --design-system / figma_export_design_system result shape: { designSystem } only, no
  // layersDoc/assets. This is what OUT.writeExport receives on that path (figma-pull.js's
  // designSystemOnly branch and figma-mcp.mts's exportResult both call writeAny -> writeExport with
  // exactly this shape) — must degrade cleanly with no pages/ and no assets/ written.
  const dsOnlyDir = path.join(wdir, "ds-only");
  const dsOnlyResult: WriteView = OUT.writeExport(dsOnlyDir, {
    designSystem: { exportedAt: "2026-08-16T00:00:00.000Z", file: "Demo", colorProfile: "srgb",
      collections: [], variables: [], styles: { paint: [], text: [], effect: [], grid: [] }, components: [], hygiene: [] },
  });
  ok("[ds-only] writeExport with no layersDoc/assets still writes the design-system split",
    fs.existsSync(path.join(dsOnlyDir, "design-system.json")) && fs.existsSync(path.join(dsOnlyDir, "design-system", "tokens.json")));
  ok("[ds-only] and writes NO pages/ or assets/ directory",
    !fs.existsSync(path.join(dsOnlyDir, "pages")) && !fs.existsSync(path.join(dsOnlyDir, "assets")));
  ok("[ds-only] wrote.layerFiles/pageDirs/assets all report zero, not a crash",
    dsOnlyResult.wrote.layerFiles === 0 && dsOnlyResult.wrote.pageDirs === 0 && dsOnlyResult.wrote.assets === 0);
  ok("[ds-split] and the write result reports the same counts back to the MCP caller",!!(
    full.wrote.designSystemCounts && full.wrote.designSystemCounts.libraryComponents === 1));

  // A manifest-only asset (no bytes — e.g. one the plugin skipped) must not be counted as written.
  const skipped: WriteView = OUT.writeAny(path.join(wdir, "skip"), {
    designSystem: { file: "D" },
    layersDoc: { layers: [], index: [] },
    assets: [asset({ id: "9:9", file: "none.svg" })],
  });
  ok("[write-out] a bytes-less asset entry is reported as skipped, not written",
    skipped.wrote.assets === 0 && skipped.wrote.assetsSkipped === 1);

  // The selection/node shape takes the other writer — dispatched on the RESULT, so a tool never has
  // to know which writer its own command implies.
  const sel: WriteView = OUT.writeAny(path.join(wdir, "sel"), screenReply({
    screenName: "Login/Screen", page: "Flows", pageId: "0:3", nodeId: "2:1",
    screen: { nodes: [{ id: "2:1", type: "FRAME" }] }, assets: [],
  }));
  ok("[write-out] the selection shape files into the pages/ tree, named with safe() + the node id",
    fs.existsSync(path.join(wdir, "sel", "pages", "Flows", "Login_Screen__2_1.json")));
  ok("[write-out] and the merged variables.json at the export root", fs.existsSync(path.join(wdir, "sel", "variables.json")));
  ok("[write-out] plus this pull's own slice beside the screen",
    fs.existsSync(path.join(wdir, "sel", "pages", "Flows", "Login_Screen__2_1.vars.json")));
  ok("[write-out] writeAny dispatched on shape, not on the caller's command", !!sel.wrote.screen);

  // The whole point of the nested layout: ONE index a consumer opens without knowing which pull shape
  // produced the tree, and two same-named frames that cannot overwrite each other.
  OUT.writeAny(path.join(wdir, "sel"), screenReply({
    screenName: "Popup", page: "Flows", pageId: "0:3", nodeId: "20170:132666",
    screen: { nodes: [{ id: "20170:132666", type: "FRAME" }] }, assets: [],
  }));
  OUT.writeAny(path.join(wdir, "sel"), screenReply({
    screenName: "Popup", page: "Flows", pageId: "0:3", nodeId: "20173:142455",
    screen: { nodes: [{ id: "20173:142455", type: "FRAME" }] }, assets: [],
  }));
  ok("[write-out] two frames with the SAME name land in two files, not one",
    fs.existsSync(path.join(wdir, "sel", "pages", "Flows", "Popup__20170_132666.json")) &&
    fs.existsSync(path.join(wdir, "sel", "pages", "Flows", "Popup__20173_142455.json")));
  const pageIdx = JSON.parse(fs.readFileSync(path.join(wdir, "sel", "pages", "Flows", "index.json"), "utf8")) as PageIndex;
  ok("[write-out] the page index accumulates every screen pulled into it", pageIdx.layers.length === 3);
  ok("[write-out] and keeps the page's real name beside the sanitised dir", pageIdx.page === "Flows" && pageIdx.pageId === "0:3");
  ok("[write-out] re-pulling one screen REPLACES its row rather than appending a duplicate",
    (() => {
      OUT.writeAny(path.join(wdir, "sel"), screenReply({
        screenName: "Popup", page: "Flows", pageId: "0:3", nodeId: "20173:142455",
        screen: { nodes: [{ id: "20173:142455", type: "FRAME" }] }, assets: [],
      }));
      return (JSON.parse(fs.readFileSync(path.join(wdir, "sel", "pages", "Flows", "index.json"), "utf8")) as PageIndex).layers.length === 3;
    })());
  const rootIdx = JSON.parse(fs.readFileSync(path.join(wdir, "sel", "pages", "index.json"), "utf8")) as PagesRootIndex;
  const rootPageDir0 = must(rootIdx.pageDirs[0], "rootIdx.pageDirs[0]");
  ok("[write-out] the root pages/index.json points at the page dir with a live layer count",
    rootIdx.pageDirs.length === 1 && rootPageDir0.layers === 3 && rootPageDir0.index === "pages/Flows/index.json");
  // An export written before the plugin emitted page identity still has to land somewhere predictable.
  // Kept WITHOUT `variables` (off-type, hence malformed()): the one fixture that still drives writeScreen's
  // no-slice branch, which every screenReply() — like every real reply — now fills.
  OUT.writeAny(path.join(wdir, "sel"), malformed<Parameters<typeof OUT.writeAny>[1]>({ screenName: "Legacy", nodeId: "9:9", screen: { nodes: [], manifest: manifest() }, assets: [] }));
  ok("[write-out] a page-less export files under _unfiled rather than guessing a page",
    fs.existsSync(path.join(wdir, "sel", "pages", "_unfiled", "Legacy__9_9.json")));
  // The index row's join key is the node id. A screen with none at all (no nodeId, no root node) would
  // be a row nothing can ever address again — refused with a reason, never written keyless.
  ok("[write-out] a screen with no id at all is refused rather than indexed without its join key",
    (() => { try { OUT.writeAny(path.join(wdir, "sel"), screenReply({ screenName: "Keyless", screen: { nodes: [] }, assets: [] })); return false; }
      catch (e) { return /screen 'Keyless' has no id — cannot index/.test(asErr(e).message); } })());

  // Per-screen asset index: which of the shared, cumulative assets/ belong to THIS screen, and which
  // of them are byte-identical (the same icon exported once per instance path).
  const withAssets: WriteView = OUT.writeAny(path.join(wdir, "sel"), screenReply({
    screenName: "Icons", page: "Flows", pageId: "0:3", nodeId: "5:5",
    screen: { nodes: [{ id: "5:5", type: "FRAME" }] },
    assets: [
      asset({ id: "a", file: "I1_2_3.svg", text: "<svg><path d='M0 0'/></svg>" }),
      asset({ id: "b", file: "I4_5_6.svg", text: "<svg><path d='M0 0'/></svg>" }),
      asset({ id: "c", file: "I7_8_9.svg", text: "<svg><path d='M1 1'/></svg>" }),
    ],
  }));
  const aIdx = JSON.parse(fs.readFileSync(path.join(wdir, "sel", "pages", "Flows", "Icons__5_5.assets.json"), "utf8")) as ScreenAssetsDoc;
  ok("[write-out] the asset index lists every asset this screen references", aIdx.files.length === 3);
  // writeAssets dedups by CONTENT before ever writing a file, so
  // two byte-identical entries under two DIFFERENT names ("I1_2_3.svg"/"I4_5_6.svg") collapse to ONE
  // file on disk instead of two — `duplicates` is empty because there is no duplicate
  // FILE for it to find; both manifest rows correctly point at the one file that was actually written.
  const aFile0 = must(aIdx.files[0], "aIdx.files[0]"), aFile1 = must(aIdx.files[1], "aIdx.files[1]");
  ok("[write-out] byte-identical entries under different names are deduped at WRITE time, not just reported after the fact",
    aFile0.file === aFile1.file && aIdx.duplicates.length === 0);
  ok("[write-out] the returned summary agrees — no duplicate count to report", withAssets.wrote.assetIndex?.duplicates === 0);

  // Which icons are safe to recolour. Figma exports the frame as it LOOKS, so a Dark-mode glyph
  // arrives with its stroke baked in and cannot serve a Light theme — but a red trash
  // icon carries meaning and must keep its colour. One colour throughout is the tell.
  OUT.writeAny(path.join(wdir, "sel"), screenReply({
    screenName: "Glyphs", page: "Flows", pageId: "0:3", nodeId: "6:6",
    screen: { nodes: [{ id: "6:6", type: "FRAME" }] },
    assets: [
      asset({ id: "g1", file: "arrow-down.svg", text: '<svg><path stroke="#D4D4D4" d="M0 0"/><path stroke="#d4d4d4" d="M1 1"/></svg>' }),
      asset({ id: "g2", file: "trash.svg", text: '<svg><path fill="#FF6767" d="M0 0"/><path fill="none" stroke="#ffffff" d="M1 1"/></svg>' }),
    ],
  }));
  const gIdx = JSON.parse(fs.readFileSync(path.join(wdir, "sel", "pages", "Flows", "Glyphs__6_6.assets.json"), "utf8")) as ScreenAssetsDoc;
  ok("[write-out] a single-coloured glyph is marked monochrome — safe to swap for currentColor",
    gIdx.monochrome.length === 1 && gIdx.monochrome[0] === "assets/arrow-down.svg");
  ok("[write-out] a two-coloured glyph is NOT, because its colour may be semantic",
    gIdx.files.find((f) => f.file === "assets/trash.svg")?.monochrome === false);
  ok("[write-out] and fill=\"none\" is not counted as a colour",
    gIdx.files.find((f) => f.file === "assets/trash.svg")?.colors?.length === 2);
  ok("[write-out] the index says outright not to edit an exported asset in place", /re-pull will overwrite/.test(gIdx.note));

  // ------------------------------------------------ variables.json MERGES across single-screen pulls
  // The bug this replaces: each --node pull wrote its own slice over design/variables.json, so pulling
  // screen B silently deleted screen A's tokens and A's theme stopped resolving — with no warning,
  // because the screen JSON carries raw hex beside every binding.
  const vdir = path.join(wdir, "vars");
  const V = (name: string, key: string, values: Record<string, string>, coll?: string) => variable({ name, key, collection: coll || "Sem", type: "COLOR", values });
  OUT.writeAny(vdir, screenReply({
    screenName: "Jet roles", page: "P", pageId: "0:1", nodeId: "1:1", screen: { nodes: [] }, assets: [],
    variables: {
      collections: [collection({ name: "Sem", key: "ck1", modes: ["Dark"] })],
      variables: [V("Text/Main", "k1", { Dark: "#fff" }), V("Bg/Page", "k2", { Dark: "#111" })],
      hygiene: ["one"],
    },
  }));
  OUT.writeAny(vdir, screenReply({
    screenName: "Filter", page: "P", pageId: "0:1", nodeId: "2:2", screen: { nodes: [] }, assets: [],
    variables: {
      collections: [collection({ name: "Sem", key: "ck1", modes: ["Light"] }), collection({ name: "Space", key: "ck2", modes: ["Desktop"] })],
      variables: [V("Bg/Page", "k2", { Dark: "#111" }), V("Border/Soft", "k3", { Dark: "#222" })],
      hygiene: ["two"],
    },
  }));
  const merged = JSON.parse(fs.readFileSync(path.join(vdir, "variables.json"), "utf8")) as MergedVariablesDoc;
  const byName = (n: string) => merged.variables.filter((v) => v.name === n);
  ok("[write-out/vars] the earlier screen's tokens SURVIVE the next pull",
    byName("Text/Main").length === 1);
  ok("[write-out/vars] the new screen's tokens are added", byName("Border/Soft").length === 1);
  ok("[write-out/vars] a token both screens bind appears ONCE, not twice", byName("Bg/Page").length === 1);
  ok("[write-out/vars] the union is 3, not the last slice's 2", merged.variables.length === 3);
  ok("[write-out/vars] collections union by key too", merged.collections.length === 2);
  ok("[write-out/vars] and a collection's modes union across slices",
    (() => { const c = merged.collections.find((c) => c.key === "ck1"); return !!c && c.modes.includes("Dark") && c.modes.includes("Light"); })());
  ok("[write-out/vars] hygiene lines from both slices are kept, deduped",
    merged.hygiene.includes("one") && merged.hygiene.includes("two"));
  ok("[write-out/vars] provenance records BOTH contributing screens",
    merged._slices.length === 2 && merged._slices.map((s) => s.screen).join(",") === "Jet_roles__1_1,Filter__2_2");
  ok("[write-out/vars] the note says the file accumulates", /UNION/.test(merged._note ?? ""));
  ok("[write-out/vars] each pull's raw slice is kept verbatim beside its screen",
    fs.existsSync(path.join(vdir, "pages", "P", "Jet_roles__1_1.vars.json")) && fs.existsSync(path.join(vdir, "pages", "P", "Filter__2_2.vars.json")));
  ok("[write-out/vars] a slice file holds ONLY that screen's variables",
    (JSON.parse(fs.readFileSync(path.join(vdir, "pages", "P", "Filter__2_2.vars.json"), "utf8")) as TokensDoc).variables?.length === 2);

  // A token that resolves differently in two screens is a REAL disagreement between two libraries
  // — the newest wins, but it is recorded rather than silently applied.
  const conf: WriteView = OUT.writeAny(vdir, screenReply({
    screenName: "Popup", page: "P", pageId: "0:1", nodeId: "3:3", screen: { nodes: [] }, assets: [],
    variables: { collections: [], variables: [V("Bg/Page", "k2", { Dark: "#999" })], hygiene: [] },
  }));
  const merged2 = JSON.parse(fs.readFileSync(path.join(vdir, "variables.json"), "utf8")) as MergedVariablesDoc;
  ok("[write-out/vars] a value conflict is reported, not swallowed",
    conf.wrote.variablesMerge?.conflicts === 1 && merged2._conflicts?.length === 1);
  ok("[write-out/vars] the conflicting token keeps the NEWEST value",
    merged2.variables.find((v) => v.key === "k2")?.values.Dark === "#999");
  ok("[write-out/vars] and the conflict is spelled out in hygiene, where a reader will see it",
    merged2.hygiene.some((h) => /CONFLICT: 'Bg\/Page'/.test(h)));
  ok("[write-out/vars] re-pulling the SAME screen replaces its slice entry rather than appending",
    (() => {
      OUT.writeAny(vdir, screenReply({ screenName: "Popup", page: "P", pageId: "0:1", nodeId: "3:3", screen: { nodes: [] }, assets: [],
        variables: { collections: [], variables: [V("Bg/Page", "k2", { Dark: "#999" })], hygiene: [] } }));
      const m = JSON.parse(fs.readFileSync(path.join(vdir, "variables.json"), "utf8")) as MergedVariablesDoc;
      return m._slices.length === 3 && m._slices.filter((s) => s.screen === "Popup__3_3").length === 1;
    })());

  // ------------------------------------------------------------- reference PNGs land in ONE place
  // The docs agree on one location, and the printed path resolves to a file.
  const shot: WriteView = OUT.writeAny(path.join(wdir, "shot"), {
    id: "7410:12299", name: "Jet Role Details", type: "FRAME",
    reference: "assets/7410_12299_ref.png", manifest: manifest(),
    assets: [asset({ id: "7410:12299", file: "7410_12299_ref.png", base64: Buffer.from("png").toString("base64"), kind: "reference" })],
  });
  ok("[write-out/shot] a screenshot lands in assets/ — where a --node pull puts the same PNG",
    fs.existsSync(path.join(wdir, "shot", "assets", "7410_12299_ref.png")));
  ok("[write-out/shot] and there is no second copy under screenshots/",
    !fs.existsSync(path.join(wdir, "shot", "screenshots")));
  ok("[write-out/shot] the returned reference is the path actually written",
    shot.reference === "assets/7410_12299_ref.png");

  // outDir resolves against the CWD — for the MCP server that is the project Claude Code started in,
  // so an export lands in the project being built, not next to the bridge's own source.
  ok("[write-out] a relative outDir resolves against process.cwd()",
    OUT.resolveOutDir("design") === path.resolve(process.cwd(), "design"));
  ok("[write-out] FIGMA_EXPORT_DIR is the fallback — the same var snapshot-meta.js reads",
    (() => {
      const prev = process.env.FIGMA_EXPORT_DIR;
      process.env.FIGMA_EXPORT_DIR = "custom-out";
      const got = OUT.resolveOutDir(undefined);
      if (prev === undefined) delete process.env.FIGMA_EXPORT_DIR; else process.env.FIGMA_EXPORT_DIR = prev;
      return got === path.resolve(process.cwd(), "custom-out");
    })());
  // outDir on the MCP side is a MODEL-supplied argument, and path.resolve honours "../.." and
  // absolute paths — so without this an export could be written anywhere the process can write.
  // Confined to the server's cwd, which is also exactly what the option's description promises.
  const escapes = (p: string) => { try { OUT.assertInsideCwd(p); return false; } catch (e) { return /must stay inside/.test(asErr(e).message); } };
  ok("[write-out] a relative outDir is accepted", !escapes("design") && !escapes("src/design"));
  ok("[write-out] '..' traversal out of the project is refused", escapes("../../../../tmp/pwned"));
  ok("[write-out] an absolute path outside the project is refused", escapes("/tmp/pwned"));
  ok("[write-out] the refusal names the offending path and the fix",
    (() => { try { OUT.assertInsideCwd("/tmp/pwned"); return false; } catch (e) { return /\/tmp\/pwned/.test(asErr(e).message) && /relative path/.test(asErr(e).message); } })());
  ok("[write-out] the cwd itself is allowed", !escapes("."));
  fs.rmSync(wdir, { recursive: true, force: true });

  // The server must actually declare the flag — the source compiling is not evidence the tool
  // schema shipped it (Zod strips undeclared keys, so a forgotten declaration is a SILENT drop).
  ok("[write-out] all three export tools declare writeToDisk in src/figma-mcp.ts",
    (mcpSrc.match(/writeToDisk/g) || []).length >= 3);
  ok("[write-out] src/figma-mcp.ts routes writes through write-out.ts",
    /write-out\.ts/.test(mcpSrc) && /writeAny/.test(mcpSrc));

  // ---------------------------------------------------------------- daemon: hold the bridge open
  // The daemon exists because a one-shot run pays a plugin reconnect every time AND only one process
  // can hold port 8787. These drive it against a FAKE bridge — no Figma, no WebSocket — so the
  // queueing, framing and lifecycle are testable offline, which is where the interesting failures are.
  const daemon = await import("../bridge/src/daemon.ts");
  const D_PORT = 19787; // not 8787: a test must never contend with a real bridge the user is running

  const calls: string[] = [];
  const fakeBridge = {
    port: D_PORT,
    isConnected: () => true,
    // The daemon forwards the connected-file listing through __status, so the fake has to answer it
    // too — two rows, so the routing assertions below have something to disambiguate between.
    listClients: () => [
      clientRow({ connId: "c1", file: "App — Base", fileKey: "KEYBASE", page: "Home", instanceId: "fig-a", connectedAt: 1, uptimeMs: 1000, identified: true }),
      clientRow({ connId: "c2", file: "NIMA Library", fileKey: "KEYLIB", page: "Tokens", instanceId: "fig-b", connectedAt: 2, uptimeMs: 2000, identified: true }),
    ],
    close: () => calls.push("close"),
    waitForConnection: async () => {},
    // Records the bounded named-client wait the daemon asks for (target + window), see daemon.ts.
    waitForClient: async (target: string, timeoutMs: number) => { calls.push(`wait:${target}:${timeoutMs}`); },
    // The daemon forwards a command frame's own fields; the fake answers each command with ITS real
    // reply shape (the daemon client checks replies against commands.ts before handing them back),
    // tagging `file` with the command so a round-trip can be told apart. It blows up on `write` (the
    // plugin-side failure case) and answers `exportFull { allPages }` with a 4 MB hygiene line (the
    // reassembly case). No requestWithClient: an older/minimal bridge shape, so the daemon's reply
    // carries no `client` — which requestWithClient() must report as null, never invent.
    request: async (cmd: Cmd, args: Record<string, unknown> | undefined, _timeoutMs: number | undefined, client: string | null | undefined) => {
      if (client) calls.push("client:" + client);
      calls.push(cmd);
      if (cmd === "write") throw new Error("plugin exploded");
      const echo = "echo:" + cmd;
      const replies: Partial<Record<Cmd, () => unknown>> = {
        ping: () => ({ pong: true, page: "P", file: echo }),
        whoami: () => ({ instanceId: "fig-fake", file: echo }),
        getSelection: () => [],
        listPages: () => ({ exportedAt: "2026-09-24T00:00:00.000Z", file: echo, depth: 2, pages: [], manifest: { pages: 0, warnings: [] } }),
        exportFull: () => ({ designSystem: { hygiene: ["x".repeat(args && args.allPages === true ? 4e6 : 0)] }, layersDoc: {}, assets: [] }),
      };
      return (replies[cmd] ?? (() => ({})))(); // anything else: an empty object, i.e. NOT that command's shape
    },
  };

  ok("[daemon] with none running, connect() is null — callers fall back to their own bridge",
    (await daemon.connect(D_PORT)) === null);
  ok("[daemon] and --stop reports there was nothing to stop", (await daemon.stop(D_PORT)) === false);

  // A socket FILE left by a crashed daemon is not a running daemon. If this read as "alive", every
  // later CLI run would fail until the user hand-deleted a file they don't know about.
  fs.writeFileSync(daemon.sockPath(D_PORT), "");
  ok("[daemon] a stale socket file reads as NO daemon, not as a hang",
    (await daemon.connect(D_PORT)) === null);

  // crashHandlers:false — the process-wide unhandledRejection handler only LOGS, which inside this
  // suite would turn a crashed test into a silent pass. It is tested in a subprocess below.
  await daemon.serve(fakeBridge, { port: D_PORT, crashHandlers: false });
  ok("[daemon] --serve starts over a stale socket file", !!(await daemon.connect(D_PORT)));
  const dstat = await daemon.status(D_PORT);
  ok("[daemon] status reports the pid, port and whether the PLUGIN is connected",
    dstat?.pid === process.pid && dstat.port === D_PORT && dstat.pluginConnected === true);

  // Starting a second daemon must REFUSE, not silently steal the socket out from under the first.
  let dblErr: Error | undefined;
  try { await daemon.serve(fakeBridge, { port: D_PORT, crashHandlers: false }); } catch (e) { dblErr = asErr(e); }
  ok("[daemon] a second --serve is refused rather than stealing the live socket",
    !!dblErr && /already running/.test(dblErr.message));
  ok("[daemon] and the refusal names the way out", !!dblErr && /--stop/.test(dblErr.message));

  const dcli = await daemon.connect(D_PORT);
  if (!dcli) throw new Error("daemon.connect() returned null right after serve()");
  ok("[daemon] a request round-trips", (await dcli.request({ cmd: "listPages", timeoutMs: 5000 }, 5000)).file === "echo:listPages");
  let dReqErr: Error | undefined;
  try { await dcli.request({ cmd: "write", args: { ops: [] }, timeoutMs: 5000 }, 5000); } catch (e) { dReqErr = asErr(e); }
  ok("[daemon] a plugin-side failure propagates to the client as an error, not a silent empty result",
    !!dReqErr && /plugin exploded/.test(dReqErr.message));

  // Requests are SERIALIZED. The plugin is single-threaded and its heavy commands mutate shared
  // per-run state, so concurrent exports interleave badly — the daemon must behave like a sequence of
  // one-shot runs, which is what every existing caller was written against.
  const order: string[] = [];
  const three: Cmd[] = ["ping", "whoami", "getSelection"];
  await Promise.all(three.map((c) => dcli.request({ cmd: c, timeoutMs: 5000 }, 5000).then(() => order.push(c))));
  ok("[daemon] concurrent client requests run ONE at a time, in arrival order", order.join(",") === three.join(","));

  // The frame is CHECKED before anything reads it (daemon.ts isDaemonRequest): a `{}` used to be
  // forwarded to the bridge as `cmd: undefined`, and `timeoutMs: "x"` reached setTimeout as NaN.
  // Driven over the raw socket, since the typed client cannot even express these frames.
  const rawFrame = (frame: string) => new Promise<string>((resolve, reject) => {
    const c = net.createConnection(daemon.sockPath(D_PORT));
    c.setEncoding("utf8");
    let buf = "";
    c.on("data", (d: string) => { buf += d; if (buf.includes("\n")) { c.end(); resolve(buf.trim()); } });
    c.on("error", reject);
    c.on("connect", () => c.write(frame + "\n"));
  });
  const badFrames: Array<[string, RegExp]> = [
    ["{}", /bad request frame: `cmd` is missing/],
    ["[]", /bad request frame: not an object/],
    ['{"cmd":"boom"}', /bad request frame: unknown cmd 'boom'/],
    ['{"cmd":"listPages","timeoutMs":"x"}', /bad request frame: `timeoutMs` is not a positive number/],
    ['{"cmd":"listPages","args":[]}', /bad request frame: `args` is not an object/],
    ['{"cmd":"listPages","client":7}', /bad request frame: `client` is not a string/],
    ['{"cmd":"listPages","progress":"yes"}', /bad request frame: `progress` is not a boolean/],
    ["not json", /bad request frame: /],
  ];
  for (const [frame, want] of badFrames) {
    const r = await rawFrame(frame);
    ok(`[daemon] a malformed frame ${frame} is refused as a bad request frame`, /"ok":false/.test(r) && want.test(r));
  }
  ok("[daemon] a refused frame never reached the bridge", !calls.includes("boom") && !calls.some((c) => c === "undefined"));
  ok("[daemon] the daemon's own commands need no other field", /"daemon":true/.test(await rawFrame('{"cmd":"__ping"}')));
  ok("[daemon] a request id is echoed back on the reply", /"id":"q7"/.test(await rawFrame('{"id":"q7","cmd":"ping"}')));

  // Routing has to survive the daemon hop. A CLI process behind a daemon has no bridge of its own, so
  // if `client` were dropped in the unix-socket frame the command would silently run against whichever
  // file the bridge picked — the exact wrong-file export the refusal in resolveClient exists to prevent.
  calls.length = 0;
  const routed = await dcli.requestWithClient({ cmd: "whoami", client: "NIMA Library", timeoutMs: 5000 }, 5000);
  ok("[daemon] --client is forwarded through the daemon to the bridge", calls.includes("client:NIMA Library"));
  ok("[daemon] and the command itself still arrives", calls.includes("whoami"));
  ok("[daemon] a bridge that cannot name the client it used leaves `client` null — never a guess", routed.client === null);
  ok("[daemon] a named client with no connect window asks for no wait", !calls.some((c) => c.startsWith("wait:")));
  // With a connect window (the CLI behind a daemon passes its own), a NAMED client gets the bounded
  // waitForClient before the request — min(window, 15 s) — so the second file's window has time to
  // redial; a bare connId never waits (it does not depend on identification).
  calls.length = 0;
  await dcli.requestWithClient({ cmd: "whoami", client: "NIMA Library", timeoutMs: 5000, waitForConnection: 90000 }, 5000);
  ok("[daemon] a named client WITH a connect window is waited for, capped at 15 s", calls[0] === "wait:NIMA Library:15000" && calls.includes("client:NIMA Library"));
  calls.length = 0;
  await dcli.requestWithClient({ cmd: "whoami", client: "NIMA Library", timeoutMs: 5000, waitForConnection: 4000 }, 5000);
  ok("[daemon] …and a shorter window is used as-is", calls[0] === "wait:NIMA Library:4000");
  calls.length = 0;
  await dcli.requestWithClient({ cmd: "whoami", client: "c2", timeoutMs: 5000, waitForConnection: 90000 }, 5000);
  ok("[daemon] a bare connId target never waits", !calls.some((c) => c.startsWith("wait:")) && calls.includes("client:c2"));
  // A connect window that runs out with NOTHING connected is not the daemon's error to report: the
  // request still runs, so the bridge's own resolveClient text ("Figma plugin not connected. Open the
  // file in Figma and run the plugin.") is what every path prints — not waitForConnection's "timed out
  // waiting for the plugin to connect" (the MCP's named `client` sends a window).
  calls.length = 0;
  const wasConnected = fakeBridge.isConnected, wasWait = fakeBridge.waitForConnection;
  fakeBridge.isConnected = () => false;
  fakeBridge.waitForConnection = async () => { calls.push("waitConn"); throw new Error("timed out waiting for the plugin to connect"); };
  const afterWindow = await dcli.requestWithClient({ cmd: "whoami", client: "NIMA Library", timeoutMs: 5000, waitForConnection: 50 }, 5000).then(() => "answered", (e: unknown) => asErr(e).message);
  fakeBridge.isConnected = wasConnected;
  fakeBridge.waitForConnection = wasWait;
  ok("[daemon] a connect window that runs out falls through to the request (the bridge's own not-connected text), not the daemon's timeout text",
    calls[0] === "waitConn" && calls[1] === "wait:NIMA Library:50" && calls.includes("whoami") && afterWindow === "answered");
  // The connected-file listing is only visible to the daemon (it owns the bridge), so __status carries it.
  const cstat = await daemon.status(D_PORT);
  ok("[daemon] status reports the connected files so --list-clients works behind a daemon",
    Array.isArray(cstat?.clients) && cstat.clients.length === 2 && cstat.clients[0]?.connId === "c1");

  // Newline-delimited framing has to survive a payload that arrives in many chunks — a real export is
  // megabytes, and reassembling it wrongly would corrupt every large pull.
  const big = await dcli.request({ cmd: "exportFull", args: { allPages: true }, timeoutMs: 30000 }, 30000);
  ok("[daemon] a multi-megabyte reply is reassembled intact across chunks", big.designSystem.hygiene?.[0]?.length === 4e6);
  // The daemon client re-checks the relayed reply's shape (an older daemon build may not have): a
  // bridge answering `listChildren` with a listPages-shaped reply is a named error, not a typed lie.
  let shapeErr: Error | undefined;
  try { await dcli.request({ cmd: "listChildren", args: { nodeId: "1:1" }, timeoutMs: 5000 }, 5000); } catch (e) { shapeErr = asErr(e); }
  ok("[daemon] a relayed reply of the wrong shape is refused by the client, naming the command",
    !!shapeErr && /relayed an unexpected shape for listChildren: `id` is missing/.test(shapeErr.message));

  // Idle shutdown config is reported in MS, not rounded minutes: a sub-minute window rounded to "0"
  // reads as "disabled", which is the opposite of true. (The reap itself is time-based and covered by
  // a manual run rather than a 40s sleep in the suite; what's asserted here is the wiring.)
  ok("[daemon] status reports the idle window in ms, and how long it has been idle",
    typeof dstat?.idleForMs === "number" && (dstat.idleMs == null || dstat.idleMs > 0));
  ok("[daemon] a client probe counts as activity — idleForMs stays small while in use",
    (dstat?.idleForMs ?? NaN) < 60000);

  // A bridge with no requestWithClient cannot take a progress listener (the shape an older bridge has):
  // a client that asks for progress still gets its reply, and simply no ticks.
  let noTicks = 0;
  const optedNoSource = await dcli.request({ cmd: "ping", timeoutMs: 5000 }, 5000, () => { noTicks++; });
  ok("[daemon-progress] a listener against a bridge with no progress source still gets the reply, and no ticks",
    optedNoSource.file === "echo:ping" && noTicks === 0);

  ok("[daemon] --stop stops it", (await daemon.stop(D_PORT)) === true);
  ok("[daemon] and removes the socket file, so the next --serve is not blocked",
    !fs.existsSync(daemon.sockPath(D_PORT)));
  ok("[daemon] stopping closes the underlying bridge", calls.includes("close"));

  // ---------------------------------------------------------------- daemon: progress frames
  // An MCP export routed through a daemon owes its caller notifications/progress (MCP spec 2025-06-18,
  // basic/utilities/progress) just as one that holds the bridge does, so the daemon relays the
  // bridge's ticks as `{ id, progress }` frames ahead of the reply — to a client that opted in only.
  // A second daemon, over a fake bridge WITH requestWithClient that emits ticks through its listener.
  {
    const P_PORT = 19788; // a socket name only: the fake bridge binds no TCP port
    const TICKS: ProgressTick[] = [
      { phase: "pages", page: { index: 1, of: 2, name: "P1" }, nodes: 10, assets: null },
      { phase: "assets", page: null, nodes: null, assets: 3 },
    ];
    const TICK0 = must(TICKS[0], "TICKS[0]"), TICK1 = must(TICKS[1], "TICKS[1]");
    const row: ClientRow = { connId: "c1", file: "App — Base", fileKey: "KEYBASE", page: "Home", instanceId: "fig-a", connectedAt: 1, uptimeMs: 1000, identified: true, pluginVersion: null, pluginStale: null };
    const listeners: string[] = []; // whether each forwarded request carried a listener
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const tickBridge: DaemonBridge = {
      port: P_PORT,
      isConnected: () => true,
      waitForConnection: async () => {},
      close: () => {},
      request: async () => { throw new Error("a bridge with requestWithClient is never asked through request()"); },
      requestWithClient: async (cmd, _args, _timeoutMs, _target, _stallMs, onProgress) => {
        listeners.push(onProgress ? "yes" : "none");
        // ping: both ticks, then the reply in the same turn (the tightest ordering case).
        if (cmd === "ping") { for (const t of TICKS) onProgress?.(t); return { reply: { pong: true, page: "P", file: "ticked" }, client: row }; }
        // whoami: 4 ticks 150 ms apart, reply at ~600 ms — longer than the client's 400 ms guard, so it
        // only succeeds if each tick re-arms that guard (the silence-budget decision in daemon.ts).
        if (cmd === "whoami") { for (let i = 0; i < 4; i++) { await sleep(150); onProgress?.(TICK0); } return { reply: { instanceId: "fig-a", file: "slow" }, client: row }; }
        // listPages: one tick, then 1.5 s of silence — past the client's 400 ms guard.
        await sleep(10); onProgress?.(TICK1); await sleep(1500);
        return { reply: { exportedAt: "2026-09-24T00:00:00.000Z", file: "late", depth: 2, pages: [], manifest: { pages: 0, warnings: [] } }, client: row };
      },
    };
    await daemon.serve(tickBridge, { port: P_PORT, crashHandlers: false });
    const pcli = await daemon.connect(P_PORT);
    if (!pcli) throw new Error("daemon.connect() returned null right after serve() (progress daemon)");

    // Typed client, opted in: both ticks, exact values, in order, and before the promise settles.
    const events: string[] = [];
    const got: ProgressTick[] = [];
    const withTicks = await pcli.requestWithClient({ cmd: "ping", timeoutMs: 5000 }, 5000, (t) => { got.push(t); events.push("tick"); });
    events.push("reply");
    ok("[daemon-progress] an opted-in client receives both ticks, exact values, in order",
      JSON.stringify(got) === JSON.stringify(TICKS));
    ok("[daemon-progress] …all before the reply, and the reply (and its client) is unchanged",
      events.join(",") === "tick,tick,reply" && withTicks.reply.file === "ticked" && withTicks.client?.connId === "c1" && listeners.at(-1) === "yes");

    // Over the raw socket: what an OLD client (one that never sends `progress`) sees vs an opted-in one.
    const rawLines = (frame: string) => new Promise<string[]>((resolve, reject) => {
      const c = net.createConnection(daemon.sockPath(P_PORT));
      c.setEncoding("utf8");
      const lines: string[] = [];
      c.on("data", daemon.framer((l) => { lines.push(l); if (l.includes('"ok":')) { c.end(); resolve(lines); } }));
      c.on("error", reject);
      c.on("connect", () => c.write(frame + "\n"));
    });
    const plain = await rawLines('{"id":"n1","cmd":"ping"}');
    const opted = await rawLines('{"id":"y1","cmd":"ping","progress":true}');
    ok("[daemon-progress] a client that did not opt in gets ONLY the reply frame, unchanged — while an opted-in one gets the ticks first",
      plain.length === 1 && plain[0] === JSON.stringify({ ok: true, id: "n1", result: { pong: true, page: "P", file: "ticked" }, client: row })
      && listeners.at(-2) === "none"
      && opted.length === 3 && opted[0] === JSON.stringify({ id: "y1", progress: TICKS[0] }) && opted[1] === JSON.stringify({ id: "y1", progress: TICKS[1] }));
    const noOpt = await pcli.request({ cmd: "ping", timeoutMs: 5000 }, 5000);
    ok("[daemon-progress] the typed client without a listener does not opt in, and its reply is unchanged",
      noOpt.file === "ticked" && listeners.at(-1) === "none");

    // Timeout: each tick re-arms the client's outer guard (a silence budget, like the CLI's stall check).
    let slowTicks = 0;
    const slow = await pcli.request({ cmd: "whoami", timeoutMs: 5000 }, 400, () => { slowTicks++; }).then((r) => r.file, (e: unknown) => "rejected: " + asErr(e).message);
    ok("[daemon-progress] ticks keep a request alive past the client's guard (each one re-arms it)", slow === "slow" && slowTicks === 4);
    const t0 = Date.now();
    const silent = await pcli.request({ cmd: "listPages", timeoutMs: 5000 }, 400, () => {}).then(() => "resolved", (e: unknown) => asErr(e).message);
    ok("[daemon-progress] …but silence after a tick still times out, on the guard, not on the late reply",
      /daemon did not respond within 0s/.test(silent) && Date.now() - t0 < 1200);
    await sleep(1400); // let the daemon's queue drain the late listPages before stopping it
    ok("[daemon-progress] the progress daemon stops", (await daemon.stop(P_PORT)) === true);

    // A daemon that sends malformed progress frames (or sends them unasked) must not break the reply:
    // bad ticks are dropped, a good one is still delivered, and the reply is the answer.
    const F_PORT = 19790;
    const fsock = daemon.sockPath(F_PORT);
    try { fs.unlinkSync(fsock); } catch { /* none */ }
    const seenFrames: unknown[] = [];
    const fake = net.createServer((conn) => {
      conn.setEncoding("utf8");
      conn.on("error", () => {});
      conn.on("data", daemon.framer((line) => {
        const m = JSON.parse(line) as unknown;
        const rec = typeof m === "object" && m !== null && !Array.isArray(m) ? m : {};
        const cmd = "cmd" in rec ? rec.cmd : undefined;
        const id = "id" in rec && typeof rec.id === "string" ? rec.id : undefined;
        if (cmd === "__ping") { conn.write(JSON.stringify({ ok: true, id, result: { daemon: true } }) + "\n"); return; }
        seenFrames.push(m);
        conn.write([
          '{"id":"z","progress":"nope"}',
          '{"progress":{"phase":5,"page":null,"nodes":null,"assets":null}}',
          '{"progress":{"phase":"pages","page":{"index":"1","of":2,"name":null},"nodes":null,"assets":null}}',
          '{"progress":null}',
          JSON.stringify({ progress: TICKS[1] }),
          JSON.stringify({ ok: true, id, result: { pong: true, page: "P", file: "fake" } }),
        ].join("\n") + "\n");
      }));
    });
    await new Promise<void>((r) => fake.listen(fsock, r));
    const fcli = await daemon.connect(F_PORT);
    if (!fcli) throw new Error("daemon.connect() returned null against the hand-rolled daemon");
    const fgot: ProgressTick[] = [];
    const fr = await fcli.request({ cmd: "ping", timeoutMs: 5000 }, 5000, (t) => fgot.push(t)).then((r) => r.file, (e: unknown) => "rejected: " + asErr(e).message);
    ok("[daemon-progress] malformed progress frames are dropped — the reply still arrives, and only the well-formed tick is delivered",
      fr === "fake" && JSON.stringify(fgot) === JSON.stringify([TICKS[1]]));
    const fr2 = await fcli.request({ cmd: "ping", timeoutMs: 5000 }, 5000).then((r) => r.file, (e: unknown) => "rejected: " + asErr(e).message);
    const optIn = seenFrames.map((f) => typeof f === "object" && f !== null && "progress" in f ? f.progress : "absent");
    ok("[daemon-progress] the client opts in on the wire only with a listener, and copes with frames it never asked for",
      fr2 === "fake" && optIn.join(",") === "true,absent");
    await new Promise<void>((r) => fake.close(() => r()));
    try { fs.unlinkSync(fsock); } catch { /* closed server removed it */ }
  }

  // ---------------------------------------------------------------- is-main.ts: the import.meta.main fallback
  // isMainFallback is what every CLI guard falls back to on a Node without import.meta.main (< 24.2):
  // "was THIS file the process entry?", realpath-resolved on both sides so an npm `bin` symlink still
  // counts. Driven as subprocesses because argv[1] and import.meta.url are process facts.
  {
    console.log("\nis-main.ts — isMainFallback:");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-ismain-"));
    const isMainUrl = pathToFileURL(path.resolve(import.meta.dirname, "../bridge/src/is-main.ts")).href;
    const real = path.join(dir, "real.mjs");
    fs.writeFileSync(real, `import { isMainFallback } from ${JSON.stringify(isMainUrl)};\nconsole.log(String(isMainFallback(import.meta.url)));\n`);
    const other = path.join(dir, "other.mjs");
    fs.writeFileSync(other, "export const x = 1;\n");
    const mismatch = path.join(dir, "mismatch.mjs");
    fs.writeFileSync(mismatch, `import { isMainFallback } from ${JSON.stringify(isMainUrl)};\nimport { pathToFileURL } from "node:url";\nconsole.log(String(isMainFallback(pathToFileURL(${JSON.stringify(other)}).href)));\n`);
    const link = path.join(dir, "link.mjs");
    fs.symlinkSync(real, link);
    const run = (args: string[]) => spawnSync(process.execPath, args, { encoding: "utf8" });
    ok("[is-main] the file that IS the process entry answers true", run([real]).stdout.trim() === "true");
    ok("[is-main] run through a symlink (an npm bin shim), the target still answers true", run([link]).stdout.trim() === "true");
    ok("[is-main] a module asking about a DIFFERENT file's URL answers false", run([mismatch]).stdout.trim() === "false");
    const noArgv = run(["--input-type=module", "-e", `import { isMainFallback } from ${JSON.stringify(isMainUrl)}; console.log(String(isMainFallback(import.meta.url)));`]);
    ok("[is-main] with no argv[1] (node -e) it answers false rather than throwing", noArgv.status === 0 && noArgv.stdout.trim() === "false");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- daemon.ts: installCrashHandlers
  // The long-lived processes (`dtwin serve`, the MCP server) log a stray rejection and carry on, and
  // log an uncaught exception, run their synchronous cleanup and exit 1 (Node docs: resuming after
  // 'uncaughtException' is unsafe). Process-wide handlers, so driven in subprocesses.
  {
    console.log("\ndaemon.ts — installCrashHandlers:");
    const daemonUrl = pathToFileURL(path.resolve(import.meta.dirname, "../bridge/src/daemon.ts")).href;
    const run = (body: string) => spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { installCrashHandlers } from ${JSON.stringify(daemonUrl)};\n` +
      `installCrashHandlers((m) => console.error("[t] " + m), () => console.log("cleanup ran"));\n` +
      `installCrashHandlers((m) => console.error("[second] " + m));\n` + body], { encoding: "utf8" });
    const rej = run(`Promise.reject(new Error("boom"));\nsetTimeout(() => console.log("still alive"), 50);`);
    const rejLines = rej.stderr.split("\n").filter((l) => l.trim() && !/ExperimentalWarning|--trace-warnings/.test(l));
    ok("[crash] an unhandled rejection is logged as ONE line through errMsg", rejLines.length === 1 && rejLines[0] === "[t] unhandled promise rejection (continuing): boom");
    ok("[crash] and the process does NOT exit — it keeps running and ends normally", rej.status === 0 && rej.stdout.includes("still alive") && !rej.stdout.includes("cleanup ran"));
    const exc = run(`setTimeout(() => { throw new Error("kaboom"); }, 10);\nsetTimeout(() => console.log("still alive"), 200);`);
    ok("[crash] an uncaught exception is logged as one line, then the process exits 1",
      exc.status === 1 && exc.stderr.includes("[t] uncaught exception — exiting: kaboom") && !exc.stdout.includes("still alive"));
    ok("[crash] its synchronous cleanup runs before the exit", exc.stdout.includes("cleanup ran"));
    ok("[crash] installed once per process — a second install adds no second handler", !rej.stderr.includes("[second]") && !exc.stderr.includes("[second]"));
  }

  // ---------------------------------------------------------------- write-out.ts: atomic writeJson
  // tmp-then-rename, so a run killed mid-write leaves the previous file whole. The bytes on disk are
  // exactly what the plain writeFileSync wrote, and no temp file is left behind.
  {
    console.log("\nwrite-out.ts — atomic writeJson:");
    const wo = await import("../bridge/src/write-out.ts");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-atomic-"));
    fs.mkdirSync(path.join(dir, "pages", "home"), { recursive: true });
    const doc = { a: 1, nested: { list: [1, "two", null], text: "ünïcødé" } };
    const logged: string[] = [];
    wo.writeJson(dir, "pages/home/doc.json", { old: true }, true);
    wo.writeJson(dir, "pages/home/doc.json", doc, false, (m) => logged.push(m));
    const target = path.join(dir, "pages", "home", "doc.json");
    ok("[atomic] the written bytes are byte-identical to JSON.stringify(obj, null, 2), replacing the old file",
      fs.readFileSync(target).equals(Buffer.from(JSON.stringify(doc, null, 2))));
    ok("[atomic] no .tmp-* file is left behind", fs.readdirSync(path.dirname(target)).join() === "doc.json");
    ok("[atomic] the log line is unchanged (the final path, not the temp one)", logged.join() === "wrote " + target);
    let threw = false;
    fs.writeFileSync(path.join(dir, "not-a-dir"), "x"); // a file where the parent directory would go: the write cannot succeed
    try { wo.writeJson(dir, "not-a-dir/doc.json", doc, true); } catch { threw = true; }
    ok("[atomic] a failed write still throws, and leaves no temp file",
      threw && fs.readdirSync(dir).filter((f) => f.includes(".tmp-")).length === 0 && fs.readFileSync(path.join(dir, "not-a-dir"), "utf8") === "x");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // parseArgs owns the daemon flags — a daemon command takes the whole invocation, so combining it
  // with a pull must be refused rather than silently starting a daemon and dropping the export.
  const parseThrows = (args: string[]) => { try { pull.parseArgs(args); return null; } catch (e) { return asErr(e).message; } };
  ok("[daemon] --serve is refused alongside an export scope",
    /cannot be combined with --all-pages/.test(parseThrows(["--serve", "--all-pages"]) || ""));
  ok("[daemon] --stop is refused alongside a read option",
    /cannot be combined with --css/.test(parseThrows(["--stop", "--css"]) || ""));
  ok("[daemon] two daemon commands at once are refused",
    /different commands/.test(parseThrows(["--serve", "--stop"]) || ""));
  ok("[daemon] a daemon command alone parses", pull.parseArgs(["--serve"]).daemonCmd === "--serve");
  ok("[daemon] and an ordinary pull still parses with no daemon command",
    pull.parseArgs(["design", "--all-pages"]).daemonCmd === null);


  // ---------------------------------------------------------------- token-store
  // The token STORE: where the bridge token lives between runs. Before it, the token was
  // env-var-or-nothing and a fresh one was minted every run, so the plugin's saved token was stale on
  // the very next `dtwin`. These tests own the precedence chain, the file's permissions, and the
  // lifecycle commands' argument guards.
  //
  // Every case points DESIGNTWIN_CONFIG_DIR at a temp dir: the suite must never read, write or delete
  // the developer's real ~/.config/design-twin/bridge-token.
  const store = await import("../bridge/src/token-store.ts");
  const withStore = <T,>(fn: (d: string) => T, { env = {}, dir = null }: { env?: Record<string, string>; dir?: string | null } = {}) => {
    const saved = { ...process.env };
    const d = dir || fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-token-"));
    process.env.DESIGNTWIN_CONFIG_DIR = d;
    delete process.env.FIGMA_BRIDGE_TOKEN;
    delete process.env.FIGMA_BRIDGE_TOKEN_FILE;
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    try { return fn(d); } finally { for (const k of Object.keys(process.env)) delete process.env[k]; Object.assign(process.env, saved); }
  };

  console.log("\ntoken-store — path resolution:");
  ok("[token] DESIGNTWIN_CONFIG_DIR overrides the per-OS default",
    withStore((d: string) => store.tokenPath() === path.join(d, "bridge-token")));
  ok("[token] a RELATIVE XDG_CONFIG_HOME is ignored, per the XDG spec",
    (() => {
      const saved = { ...process.env };
      delete process.env.DESIGNTWIN_CONFIG_DIR;
      process.env.XDG_CONFIG_HOME = "relative/path";
      const p = store.configDir();
      Object.assign(process.env, saved);
      // Must NOT resolve against cwd — the token's location can't depend on where dtwin was run.
      return !p.startsWith("relative") && path.isAbsolute(p);
    })());
  ok("[token] the path is absolute on this platform", path.isAbsolute(store.configDir()));

  console.log("\ntoken-store — precedence:");
  ok("[token] env beats the stored file",
    withStore((d: string) => {
      store.write("stored-tok", path.join(d, "bridge-token"));
      process.env.FIGMA_BRIDGE_TOKEN = "env-tok";
      const r = store.resolve({ persist: false });
      return r.token === "env-tok" && r.source === "env";
    }));
  ok("[token] --token-file beats env",
    withStore((d: string) => {
      const f = path.join(d, "custom");
      fs.writeFileSync(f, "file-tok");
      process.env.FIGMA_BRIDGE_TOKEN = "env-tok";
      const r = store.resolve({ tokenFile: f, persist: false });
      return r.token === "file-tok" && r.source === "token-file";
    }));
  ok("[token] the stored file is used when no env var is set",
    withStore((d: string) => {
      store.write("stored-tok", path.join(d, "bridge-token"));
      const r = store.resolve({ persist: false });
      return r.token === "stored-tok" && r.source === "file";
    }));
  ok("[token] with nothing set at all, one is minted and persisted",
    withStore((d: string) => {
      const r = store.resolve();
      return r.created === true && r.source === "file" && fs.existsSync(path.join(d, "bridge-token"));
    }));
  ok("[token] and the minted token is 48 hex chars (24 bytes of CSPRNG)",
    withStore(() => /^[0-9a-f]{48}$/.test(store.resolve().token)));
  ok("[token] a minted token is STABLE across runs — the whole point of the store",
    withStore(() => store.resolve().token === store.resolve().token));
  ok("[token] persist:false mints without writing anything, so --token-status can't lie",
    withStore((d: string) => {
      const r = store.resolve({ persist: false });
      return r.source === "ephemeral" && !fs.existsSync(path.join(d, "bridge-token"));
    }));
  ok("[token] an unreadable --token-file is a clear error, not a silent fallback",
    withStore((d: string) => {
      try { store.resolve({ tokenFile: path.join(d, "nope") }); return false; }
      catch (e) { return e instanceof Error && "code" in e && e.code === "TOKEN_FILE_UNREADABLE"; }
    }));
  ok("[token] an EMPTY token file is treated as absent, not as an empty token",
    withStore((d: string) => {
      const f = path.join(d, "bridge-token");
      fs.writeFileSync(f, "   \n");
      return store.readFrom(f) === null;
    }));
  ok("[token] an empty FIGMA_BRIDGE_TOKEN does not shadow the stored file",
    withStore((d: string) => {
      store.write("stored-tok", path.join(d, "bridge-token"));
      process.env.FIGMA_BRIDGE_TOKEN = "";
      return store.resolve({ persist: false }).source === "file";
    }));

  console.log("\ntoken-store — file hygiene:");
  ok("[token] a trailing newline is trimmed (echo tok > file must work)",
    withStore((d: string) => {
      const f = path.join(d, "bridge-token");
      fs.writeFileSync(f, "tok-with-newline\n");
      return store.readFrom(f) === "tok-with-newline";
    }));
  ok("[token] the file is written 0600 — owner only",
    withStore((d: string) => {
      const f = store.write("tok", path.join(d, "bridge-token"));
      if (process.platform === "win32") return true; // mode bits aren't meaningful on Windows
      return (fs.statSync(f).mode & 0o777) === 0o600;
    }));
  ok("[token] the config dir is created 0700",
    withStore(() => {
      const nested = path.join(process.env.DESIGNTWIN_CONFIG_DIR as string, "deep", "bridge-token");
      store.write("tok", nested);
      if (process.platform === "win32") return true;
      return (fs.statSync(path.dirname(nested)).mode & 0o777) === 0o700;
    }));
  ok("[token] a world-readable file is detected so the bridge can warn",
    withStore((d: string) => {
      if (process.platform === "win32") return true;
      const f = store.write("tok", path.join(d, "bridge-token"));
      fs.chmodSync(f, 0o644);
      return store.loosePerms(f) === true;
    }));
  ok("[token] the write is atomic — no tmp file is left behind",
    withStore((d: string) => {
      store.write("tok", path.join(d, "bridge-token"));
      return fs.readdirSync(d).join() === "bridge-token";
    }));
  ok("[token] writing twice REPLACES rather than appending",
    withStore((d: string) => {
      const f = path.join(d, "bridge-token");
      store.write("first", f);
      store.write("second", f);
      return store.readFrom(f) === "second";
    }));
  ok("[token] remove() deletes it",
    withStore((d: string) => {
      const f = store.write("tok", path.join(d, "bridge-token"));
      return store.remove(f) === true && !fs.existsSync(f);
    }));
  ok("[token] and removing a token that isn't there is not an error",
    withStore((d: string) => store.remove(path.join(d, "bridge-token")) === false));

  console.log("\ntoken-store — fingerprint + status:");
  ok("[token] the fingerprint is stable for the same token",
    store.fingerprint("abc") === store.fingerprint("abc"));
  ok("[token] differs for a different token", store.fingerprint("abc") !== store.fingerprint("abd"));
  ok("[token] and never contains the token itself",
    !String(store.fingerprint("supersecrettoken")).includes("supersecret"));
  // Regression: status() resolves with persist:false, so the ephemeral branch mints a throwaway that
  // differs every call. Reporting ITS fingerprint invited the user to compare a meaningless value
  // against the plugin's — caught by running --token-status twice and seeing the answer change.
  ok("[token] status reports NO fingerprint when nothing is saved",
    withStore(() => store.status().fingerprint === null));
  ok("[token] and a STABLE one when a token is saved",
    withStore((d: string) => {
      store.write("stored-tok", path.join(d, "bridge-token"));
      return store.status().fingerprint === store.status().fingerprint && store.status().fingerprint !== null;
    }));
  ok("[token] status reports a stored token WITHOUT creating one",
    withStore((d: string) => {
      const st = store.status();
      return st.stored === false && !fs.existsSync(path.join(d, "bridge-token"));
    }));
  ok("[token] status names the shadowing case: a saved token the env var overrides",
    withStore((d: string) => {
      store.write("stored-tok", path.join(d, "bridge-token"));
      process.env.FIGMA_BRIDGE_TOKEN = "env-tok";
      const st = store.status();
      return st.shadowed === true && st.activeSource === "env" && st.stored === true;
    }));
  ok("[token] and does not claim shadowing when only a file exists",
    withStore((d: string) => {
      store.write("stored-tok", path.join(d, "bridge-token"));
      return store.status().shadowed === false;
    }));
  // A project that always exports FIGMA_BRIDGE_TOKEN set to the SAME value as the
  // saved file (a common CI/team setup) is not reported as "shadowed" on every single run, with
  // nothing actually wrong — that would train the user to ignore the note. `shadowed` means the values
  // genuinely DIFFER, not merely that both a file and the env var exist.
  ok("[token] does NOT claim shadowing when the env var carries the SAME value as the saved file",
    withStore((d: string) => {
      store.write("same-tok", path.join(d, "bridge-token"));
      process.env.FIGMA_BRIDGE_TOKEN = "same-tok";
      return store.status().shadowed === false && store.status().activeSource === "env";
    }));

  console.log("\nserver-core — hashed compare:");
  // safeEqual previously short-circuited on length before timingSafeEqual, leaking the token's
  // length. Hashing first makes both sides 32 bytes, so unequal lengths compare normally (and false)
  // rather than returning early — or throwing, which is what a raw timingSafeEqual would do.
  ok("[auth] equal tokens compare true", core.safeEqual("abc", "abc"));
  ok("[auth] different-LENGTH tokens compare false instead of throwing", core.safeEqual("abc", "abcdef") === false);
  ok("[auth] same-length different tokens compare false", core.safeEqual("abc", "abd") === false);
  ok("[auth] the empty token compares false against a real one", core.safeEqual("", TOKEN) === false);
  // The check is bound to the token it was built with — strings only, so a token that failed to
  // resolve (null) can never be compared, and the literal token "null" authenticates nothing.
  {
    const other = core.verifyClientWith("other-token-xyz");
    const r: { accepted?: boolean; code?: number } = {};
    other({ origin: "null", req: { url: "/?token=" + TOKEN, headers: { host: "127.0.0.1:8787" } } }, (accepted, code) => { r.accepted = accepted; if (code !== undefined) r.code = code; });
    ok("[auth] verifyClientWith(token) checks against THAT token, not the module's", r.accepted === false && r.code === 401);
    const n: { accepted?: boolean } = {};
    other({ origin: "null", req: { url: "/?token=null", headers: { host: "127.0.0.1:8787" } } }, (accepted) => { n.accepted = accepted; });
    ok("[auth] the literal token \"null\" is refused like any other wrong token", n.accepted === false);
  }

  console.log("\nfigma-pull — token command guards:");
  ok("[token] --token-status parses as a command", pull.parseArgs(["--token-status"]).tokenCmd === "--token-status");
  ok("[token] --show-token parses as a command", pull.parseArgs(["--show-token"]).tokenCmd === "--show-token");
  ok("[token] --rotate-token parses as a command", pull.parseArgs(["--rotate-token"]).tokenCmd === "--rotate-token");
  ok("[token] --forget-token parses as a command", pull.parseArgs(["--forget-token"]).tokenCmd === "--forget-token");
  ok("[token] --token-file takes a value and is NOT a command",
    (() => { const p = pull.parseArgs(["--token-file", "/tmp/t"]); return p.tokenFile === "/tmp/t" && p.tokenCmd === null; })());
  ok("[token] --token-file=<path> form works too", pull.parseArgs(["--token-file=/tmp/t"]).tokenFile === "/tmp/t");
  ok("[token] --token-file with no value is refused",
    /needs a path/.test(parseThrows(["--token-file"]) || ""));
  ok("[token] its value is not mistaken for the positional outDir",
    pull.parseArgs(["--token-file", "/tmp/t"]).outDir !== "/tmp/t");
  ok("[token] a token command is refused alongside an export scope",
    /cannot be combined with --all-pages/.test(parseThrows(["--rotate-token", "--all-pages"]) || ""));
  ok("[token] a token command is refused alongside a daemon command",
    /cannot be combined with --serve/.test(parseThrows(["--show-token", "--serve"]) || ""));
  ok("[token] a token command is refused alongside an index command",
    /cannot be combined with --whoami/.test(parseThrows(["--token-status", "--whoami"]) || ""));
  ok("[token] two token commands at once are refused",
    /different commands/.test(parseThrows(["--show-token", "--rotate-token"]) || ""));
  ok("[token] --token-file is refused with --rotate-token (it would rotate the OTHER token)",
    /silently ignored/.test(parseThrows(["--rotate-token", "--token-file", "/tmp/t"]) || ""));
  ok("[token] and with --token-status, which reports on the STORED token",
    /silently ignored/.test(parseThrows(["--token-status", "--token-file", "/tmp/t"]) || ""));
  ok("[token] and with --forget-token",
    /silently ignored/.test(parseThrows(["--forget-token", "--token-file", "/tmp/t"]) || ""));
  ok("[token] but --token-file IS allowed with --show-token",
    pull.parseArgs(["--show-token", "--token-file", "/tmp/t"]).tokenCmd === "--show-token");
  ok("[token] an ordinary pull still parses with no token command",
    pull.parseArgs(["design"]).tokenCmd === null);

  console.log("\nfigma-pull — token commands end to end (subprocess):");
  // Driven as a real subprocess: these commands must work with NO bridge, NO daemon and NO plugin,
  // which is only honestly testable by running the CLI itself.
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-cli-token-"));
  const cli = path.join(import.meta.dirname, "..", "bridge", "src", "figma-pull.ts");
  const runCli = (argv: string[], extraEnv: Record<string, string> = {}) => {
    const env: Record<string, string | undefined> = { ...process.env, DESIGNTWIN_CONFIG_DIR: cliDir, ...extraEnv };
    delete env.FIGMA_BRIDGE_TOKEN;
    delete env.FIGMA_BRIDGE_TOKEN_FILE;
    if (extraEnv.FIGMA_BRIDGE_TOKEN) env.FIGMA_BRIDGE_TOKEN = extraEnv.FIGMA_BRIDGE_TOKEN;
    return spawnSync(process.execPath, [cli, ...argv], { encoding: "utf8", env });
  };

  const statusFresh = runCli(["--token-status"]);
  ok("[token-cli] --token-status exits 0 with nothing saved", statusFresh.status === 0);
  ok("[token-cli] and reports no saved token rather than inventing one",
    (JSON.parse(statusFresh.stdout) as TokenStatus).stored === false);
  ok("[token-cli] and did NOT create the file as a side effect of asking",
    !fs.existsSync(path.join(cliDir, "bridge-token")));

  ok("[token-cli] --token-status twice reports the SAME thing when nothing is saved",
    runCli(["--token-status"]).stdout === runCli(["--token-status"]).stdout);

  const rotated = runCli(["--rotate-token"]);
  ok("[token-cli] --rotate-token exits 0", rotated.status === 0);
  const rotatedTok = rotated.stdout.trim();
  ok("[token-cli] and prints the new token on stdout so it can be piped", /^[0-9a-f]{48}$/.test(rotatedTok));
  ok("[token-cli] and saved it", fs.readFileSync(path.join(cliDir, "bridge-token"), "utf8").trim() === rotatedTok);
  // The failure mode that would otherwise be a silent 3s reconnect loop in the plugin.
  ok("[token-cli] and TELLS the user to re-paste it into the plugin",
    /re-paste/i.test(rotated.stderr));

  const shown = runCli(["--show-token"]);
  ok("[token-cli] --show-token prints the saved token, not a new one", shown.stdout.trim() === rotatedTok);
  ok("[token-cli] and prints it alone on stdout so `| pbcopy` works", shown.stdout.trim().split("\n").length === 1);

  const statusSaved = JSON.parse(runCli(["--token-status"]).stdout) as TokenStatus;
  ok("[token-cli] --token-status now reports it as stored", statusSaved.stored === true);
  ok("[token-cli] and never prints the token itself",
    !runCli(["--token-status"]).stdout.includes(rotatedTok));
  ok("[token-cli] and reports the saved token as the active source", statusSaved.activeSource === "file");

  const shadowed = JSON.parse(runCli(["--token-status"], { FIGMA_BRIDGE_TOKEN: "env-wins" }).stdout) as TokenStatus;
  ok("[token-cli] with the env var set, status reports env as the winner", shadowed.activeSource === "env");
  ok("[token-cli] and flags that the saved token is being shadowed", shadowed.shadowed === true);
  ok("[token-cli] --rotate-token warns when the env var would override the rotation",
    /OVERRIDES/.test(runCli(["--rotate-token"], { FIGMA_BRIDGE_TOKEN: "env-wins" }).stderr));

  const customFile = path.join(cliDir, "custom-token");
  fs.writeFileSync(customFile, "custom-tok-value\n");
  ok("[token-cli] --token-file is honoured by --show-token",
    runCli(["--show-token", "--token-file", customFile]).stdout.trim() === "custom-tok-value");

  // The mint-on-first-bridge-start path, which no other test reaches: the CLI tests above never open
  // a bridge, and this suite's own server-core is loaded with FIGMA_BRIDGE_TOKEN set (source "env",
  // which never persists). Driven as a subprocess on a spare port so it neither needs a plugin nor
  // collides with a real bridge on 8787.
  const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-boot-"));
  const bootScript = path.join(bootDir, "boot.mjs");
  fs.writeFileSync(bootScript, `
    import { createBridge } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "..", "bridge", "src", "server-core.ts")).href)};
    const b = createBridge(19788);
    b.close();
  `);
  const bootEnv: Record<string, string | undefined> = { ...process.env, DESIGNTWIN_CONFIG_DIR: bootDir };
  delete bootEnv.FIGMA_BRIDGE_TOKEN;
  delete bootEnv.FIGMA_BRIDGE_TOKEN_FILE;
  const boot = spawnSync(process.execPath, [bootScript], { encoding: "utf8", env: bootEnv });
  const bootFile = path.join(bootDir, "bridge-token");
  ok("[token-boot] starting a bridge with nothing saved mints and PERSISTS a token", fs.existsSync(bootFile));
  const bootTok = fs.existsSync(bootFile) ? fs.readFileSync(bootFile, "utf8").trim() : "";
  ok("[token-boot] and prints it once, to paste into the plugin", boot.stderr.includes(bootTok) && bootTok.length === 48);
  ok("[token-boot] and says it was saved, so the user knows not to expect it again",
    /saved to/.test(boot.stderr) && /won't be asked to paste it again/.test(boot.stderr));
  // The regression the whole store exists to prevent: the SECOND run must reuse, not re-mint.
  const boot2 = spawnSync(process.execPath, [bootScript], { encoding: "utf8", env: bootEnv });
  ok("[token-boot] a SECOND bridge start reuses the saved token instead of minting a new one",
    fs.readFileSync(bootFile, "utf8").trim() === bootTok);
  ok("[token-boot] and does NOT reprint the secret into the terminal", !boot2.stderr.includes(bootTok));
  ok("[token-boot] it reports which token is in play by fingerprint instead",
    boot2.stderr.includes(String(store.fingerprint(bootTok))));

  // Regression: server-core resolves the token at REQUIRE time, so an unreadable --token-file used to
  // throw out of a module load — a raw stack trace, before any front-end error handling was in scope.
  const badFile = runCli(["--show-token", "--token-file", "/nonexistent/nope"]);
  ok("[token-cli] an unreadable --token-file exits 1", badFile.status === 1);
  ok("[token-cli] with a one-line message, not a stack trace",
    /^\[dtwin\] error: --token-file/.test(badFile.stderr.trim()) && !badFile.stderr.includes("at Object."));

  const forgot = runCli(["--forget-token"]);
  ok("[token-cli] --forget-token exits 0", forgot.status === 0);
  ok("[token-cli] and deletes the file", !fs.existsSync(path.join(cliDir, "bridge-token")));
  ok("[token-cli] and forgetting twice is not an error",
    runCli(["--forget-token"]).status === 0);

  // ---------------------------------------------------------------- verbs
  console.log("\nverbs — `dtwin <verb>` is a pure argv → argv translation:");
  const { translate, VerbError, VERBS, HELP } = await import("../bridge/src/verbs.ts");
  const tr = (...a: string[]) => translate(a).join(" ");
  // Zero scopes is a real pull (the current page): the help page does not say "Exactly one scope" and lists --all-pages.
  ok("[verbs] `dtwin pull --help`: at most one scope, none = the current page, --all-pages listed, default design/export",
    !/Exactly one scope/.test(HELP.pull ?? "") && /with none it pulls the CURRENT page/.test(HELP.pull ?? "") && /--all-pages/.test(HELP.pull ?? "") && /default design\/export/.test(HELP.pull ?? ""));
  // The design-to-code scripts an agent probes answer --help with their usage and exit 0 (not
  // "unknown option --help" with exit 1).
  for (const script of ["map-bootstrap", "resolve-screen", "get-component"]) {
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "design-to-code", script + ".ts"), "--help"], { encoding: "utf8", timeout: 5000 });
    ok(`[help] ${script} --help prints its usage to stdout and exits 0`, r.status === 0 && /^usage: /.test(r.stdout) && r.stdout.includes(script));
  }
  ok("[verbs] flags pass through untouched", tr("--list", "--json") === "--list --json" && tr() === "");
  ok("[verbs] `dtwin design` is still a positional outDir, not a verb", tr("design", "--page", "Screens") === "design --page Screens");
  ok("[verbs] pull strips itself and keeps everything after", tr("pull", "design", "--page", "Screens") === "design --page Screens" && tr("pull") === "");
  ok("[verbs] `pull list` is how an outDir spelled like a verb is written", tr("pull", "list") === "list");
  ok("[verbs] a verb is only recognised as the FIRST argument", tr("design", "list") === "design list");
  ok("[verbs] list → --list, with the sub-nouns mapped",
    tr("list") === "--list" && tr("list", "pages") === "--list-pages" && tr("list", "libraries", "--json") === "--list-libraries --json"
    && tr("list", "clients") === "--list-clients" && tr("list", "--timeout", "600") === "--list --timeout 600");
  ok("[verbs] list children <id> → --children <id>", tr("list", "children", "12:34", "--timeout", "9") === "--children 12:34 --timeout 9");
  ok("[verbs] screenshot <id> [outDir] [flags] → --screenshot <id> …", tr("screenshot", "12:34", "design", "--scale", "2") === "--screenshot 12:34 design --scale 2");
  ok("[verbs] whoami / serve / stop / status / help / version",
    tr("whoami") === "--whoami" && tr("serve") === "--serve" && tr("stop") === "--stop" && tr("status") === "--daemon-status" && tr("help") === "--help"
    && tr("version") === "--version");
  ok("[verbs] token [status|show|rotate|forget]",
    tr("token") === "--token-status" && tr("token", "status") === "--token-status" && tr("token", "show") === "--show-token"
    && tr("token", "rotate") === "--rotate-token" && tr("token", "forget") === "--forget-token");
  const verbErr = (...a: string[]) => { try { translate(a); return null; } catch (e) { return asErr(e); } };
  ok("[verbs] an unknown sub-noun is a VerbError that names the valid ones",
    verbErr("list", "bogus") instanceof VerbError && /pages\|libraries\|clients/.test(verbErr("list", "bogus")?.message ?? "")
    && verbErr("token", "bogus") instanceof VerbError);
  ok("[verbs] a near-miss of a verb is a VerbError with a suggestion, not a pull into ./whomai",
    verbErr("whomai") instanceof VerbError && /dtwin whoami/.test(verbErr("whomai")?.message ?? "") && /dtwin pull whomai/.test(verbErr("whomai")?.message ?? "")
    && verbErr("serv") instanceof VerbError && verbErr("lists") instanceof VerbError && verbErr("docter") instanceof VerbError);
  ok("[verbs] ordinary folder names, paths and existing folders are never mistaken for a typo",
    ["design", "out", "dist", "app", "build", "src", "figma", "./serv", "exports/list2"].every((d) => tr(d) === d)
    && translate(["serv"], () => true).join(" ") === "serv" && tr("pull", "serv") === "serv");
  ok("[verbs] a verb missing its required id is a VerbError, not a silent full pull",
    verbErr("screenshot") instanceof VerbError && verbErr("screenshot", "--scale") instanceof VerbError
    && verbErr("list", "children") instanceof VerbError && verbErr("list", "children", "--json") instanceof VerbError);
  ok("[verbs] doctor / init / mcp are left for figma-pull.js to route", tr("doctor", "--json") === "doctor --json" && VERBS.includes("doctor"));
  ok("[verbs] seed is a verb, left for figma-pull.ts to route untranslated",
    VERBS.includes("seed") && tr("seed") === "seed" && tr("seed", "src", "design", "--dry-run") === "seed src design --dry-run");
  // `seed` is a SHORT verb, so (like `list`/`stop`) only a dropped or extra last letter is a near-miss:
  // `seeds`/`see` get the suggestion, while `feed`/`need`/`sed` stay ordinary outDirs.
  ok("[verbs] a near-miss of `seed` gets a did-you-mean, other one-edit words do not",
    /did you mean `dtwin seed`\?/.test(verbErr("seeds")?.message ?? "") && /did you mean `dtwin seed`\?/.test(verbErr("see")?.message ?? "")
    && tr("feed") === "feed" && tr("need") === "need" && tr("sed") === "sed" && translate(["seeds"], () => true).join(" ") === "seeds");

  // End to end: the verb and the flag it stands for must be the SAME command.
  ok("[verbs-cli] `dtwin token status` = `dtwin --token-status`",
    runCli(["token", "status"]).stdout === runCli(["--token-status"]).stdout && runCli(["token", "status"]).status === 0);
  const helpVerb = runCli(["help"]);
  ok("[verbs-cli] `dtwin help` = `dtwin --help`, exit 0", helpVerb.status === 0 && helpVerb.stdout === runCli(["--help"]).stdout);
  ok("[verbs-cli] help leads with the quick start, before the full flag reference",
    helpVerb.stdout.indexOf("Quick start") > 0 && helpVerb.stdout.indexOf("Quick start") < helpVerb.stdout.indexOf("dtwin doctor")
    && helpVerb.stdout.indexOf("dtwin doctor") < helpVerb.stdout.indexOf("Full reference"));
  ok("[verbs-cli] help still has no side effects (no token minted)", !fs.existsSync(path.join(cliDir, "bridge-token")));
  // `version` used to sit in the did-you-mean ALIASES table, so `dtwin version` was refused with
  // "did you mean `dtwin --version`?" before figma-pull ever saw it.
  const versionVerb = runCli(["version"]);
  ok("[verbs-cli] `dtwin version` = `dtwin --version`, exit 0, prints the package version",
    versionVerb.status === 0 && /^\d+\.\d+\.\d+/.test(versionVerb.stdout) && versionVerb.stdout === runCli(["--version"]).stdout);
  ok("[verbs] a near-miss of `version` still gets a suggestion", /dtwin version/.test(verbErr("verson")?.message ?? ""));
  const badVerb = runCli(["list", "bogus"]);
  ok("[verbs-cli] a VerbError is a one-line `[dtwin] error:` + exit 1, before any bridge starts",
    badVerb.status === 1 && /^\[dtwin\] error: unknown `dtwin list bogus`/.test(badVerb.stderr.trim()) && !badVerb.stderr.includes("[bridge]"));


  ok("[verbs] a word people reach for that is NOT a verb (`export`, `ls`, `check`) is refused with the real verb — it used to become an outDir and wait for a plugin",
    ["export", "ls", "check"].every((w) => { try { translate([w]); return false; } catch (e) { return e instanceof VerbError && /did you mean `dtwin (pull|list|doctor)`/.test(e.message); } })
    && tr("pull", "export") === "export" && translate(["export"], () => true).join(" ") === "export" && tr("./export") === "./export");
  {
    const t0 = Date.now();
    const noPlugin = runCli(["list", "--timeout", "2"], { FIGMA_BRIDGE_PORT: "8789", FIGMA_BRIDGE_TOKEN: "t".repeat(32) });
    ok("[verbs-cli] --timeout bounds the WAIT FOR THE PLUGIN too: no plugin → exit 1 in seconds with the next step, not a 10-minute hang",
      noPlugin.status === 1 && Date.now() - t0 < 15000 && /no Figma plugin connected within 2s/.test(noPlugin.stderr) && /dtwin doctor/.test(noPlugin.stderr));
  }

  // `dtwin list` against a fake plugin that answers listPages with the REAL reply shape
  // (figma-plugin/src/collect.ts listPages): top-level layers live under pages[].frames — there is no
  // top-level `frames`. The CLI used to read `r.frames`, which the plugin never sends, so the per-type
  // breakdown and the SECTION hint never printed on any real file. Driven end to end because both
  // lines are stderr of main(), with no pure seam. 8789, not 8787: never contend with a real bridge.
  {
    const listReply = {
      exportedAt: "2026-09-24T00:00:00.000Z", file: "Sectioned App", depth: 2,
      pages: [
        { id: "0:1", name: "Screens", current: true, frames: [
          { id: "1:1", name: "Onboarding", type: "SECTION", w: 8898, h: 2000 },
          { id: "1:2", name: "Login", type: "FRAME", w: 390, h: 844 },
          { id: "1:3", name: "Home", type: "FRAME", w: 390, h: 844 },
        ] },
        { id: "0:2", name: "Notes", frames: [{ id: "2:1", name: "todo", type: "TEXT", w: 200, h: 40 }] },
      ],
      manifest: { pages: 2, frames: 4, warnings: [] },
    };
    const env: Record<string, string | undefined> = { ...process.env, DESIGNTWIN_CONFIG_DIR: cliDir, FIGMA_BRIDGE_PORT: "8789", FIGMA_BRIDGE_TOKEN: TOKEN };
    delete env.FIGMA_BRIDGE_TOKEN_FILE;
    const child = spawn(process.execPath, [cli, "list", "--timeout", "10"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
    // Dial until the CLI's bridge is up (it binds after module load), then answer every command.
    let plugin: WebSocket | null = null;
    for (let i = 0; i < 50 && !plugin; i++) {
      await new Promise((r) => setTimeout(r, 100));
      plugin = await new Promise<WebSocket | null>((res) => {
        const c = new WebSocket("ws://127.0.0.1:8789/?token=" + TOKEN, { origin: "null" });
        c.on("open", () => res(c));
        c.on("error", () => res(null));
      });
    }
    if (plugin) {
      const p = plugin;
      p.send(JSON.stringify({ type: "hello", instanceId: "fig-list", file: "Sectioned App" }));
      p.on("message", (b: RawData) => {
        const m = JSON.parse(b.toString()) as CommandFrame;
        if (m && m.id) p.send(JSON.stringify({ id: m.id, ok: true, result: m.cmd === "listPages" ? listReply : {} }));
      });
    }
    const timer = setTimeout(() => child.kill(), 20000);
    const code = await exited;
    clearTimeout(timer);
    plugin?.close();
    ok("[list-cli] `dtwin list` against a fake plugin exits 0 and prints the reply", code === 0 && /"Sectioned App"/.test(stdout));
    ok("[list-cli] the per-type breakdown counts layers from pages[].frames (was always empty)",
      /2 page\(s\), 4 top-level layer\(s\) in "Sectioned App" — 2 FRAME, 1 SECTION, 1 TEXT\./.test(stderr));
    ok("[list-cli] a page holding a SECTION prints the 'containers, not screens' hint",
      /some top-level layers are SECTIONs/.test(stderr) && /dtwin list children <section id>/.test(stderr));
  }

  // ---------------------------------------------------------------- doctor
  console.log("\ndoctor — pure checks:");
  const doctor = await import("../bridge/src/doctor.ts");
  ok("[doctor] its port list IS server-core's (both read bridge/src/ports.ts)",
    doctor.ALLOWED_PORTS === core.ALLOWED_PORTS && JSON.stringify(doctor.ALLOWED_PORTS) === "[8787,8788,8789]");
  ok("[doctor] node: new enough is ok, too old is a failure, unreadable range is only a note",
    doctor.checkNode("v22.1.0", ">=18").status === "ok" && doctor.checkNode("v16.20.0", ">=18").status === "fail"
    && doctor.checkNode("v22.1.0", null).status === "warn");
  const tokS: TokenStatus = { path: "/x/bridge-token", stored: true, envSet: false, activeSource: "file", fingerprint: "abcd1234", loosePerms: false, shadowed: false };
  ok("[doctor] token: saved is ok and shows the fingerprint, never a token", doctor.checkToken(tokS).status === "ok" && doctor.checkToken(tokS).detail.includes("abcd1234"));
  ok("[doctor] token: none saved is a note pointing at init", doctor.checkToken({ ...tokS, stored: false, activeSource: "ephemeral", fingerprint: null }).status === "warn");
  ok("[doctor] token: env shadowing a saved token is named", /OVERRIDES/.test(doctor.checkToken({ ...tokS, envSet: true, activeSource: "env", shadowed: true }).detail));
  ok("[doctor] token: loose permissions get the chmod", /chmod 600/.test(doctor.checkToken({ ...tokS, loosePerms: true }).next ?? ""));
  // The shadowed-token note does not fire on EVERY run the env var happens to be
  // set on (even one carrying the SAME value as the saved file) and does not say only "make sure" without
  // whether anything is actually wrong. token-store.js only reports `shadowed` when the values
  // genuinely differ (asserted in the token-cli suite below); doctor's job is to say what a plugin
  // connection actually proved about that mismatch, once one is known.
  {
    const shadowedS: TokenStatus = { ...tokS, envSet: true, activeSource: "env", shadowed: true };
    ok("[doctor] token: shadowed + a real (non-daemon) connection succeeding is reported as OK, not a warn",
      doctor.checkToken(shadowedS, { id: "plugin", title: "Figma plugin", status: "ok", detail: "connected: X" }, false).status === "ok");
    ok("[doctor] token: shadowed + the SAME connection routed THROUGH A DAEMON proves nothing (daemon authenticated once, at its own start) — still 'could not be checked'",
      (() => { const c = doctor.checkToken(shadowedS, { id: "plugin", title: "Figma plugin", status: "ok", detail: "connected: X" }, true); return c.status === "warn" && /could not be checked/.test(c.detail) && /daemon/.test(c.detail); })());
    ok("[doctor] token: shadowed + the plugin explicitly rejecting a different token is a real failure",
      doctor.checkToken(shadowedS, { id: "plugin", title: "Figma plugin", status: "fail", detail: "a plugin IS running, but with a different token (...)" }, false).status === "fail");
    ok("[doctor] token: shadowed + no plugin reachable at all is 'could not be checked', not a false 'make sure'",
      (() => { const c = doctor.checkToken(shadowedS, { id: "plugin", title: "Figma plugin", status: "warn", detail: "not checked — no token yet" }, false); return c.status === "warn" && /could not be checked/.test(c.detail); })());
  }
  // a missing daemon does not report `ok` for "none running", which would undersell the real
  // cost — every pull without one starts its own bridge and waits out the plugin's full reconnect
  // window. Never a `fail` (no daemon really is the normal, unconfigured
  // state), but a `warn` that names `dtwin serve` as the fix.
  ok("[doctor] daemon: none running is a warn naming `dtwin serve`, not a plain ok",
    doctor.checkDaemon(null, 8787).status === "warn" && /dtwin serve/.test(doctor.checkDaemon(null, 8787).next || ""));
  ok("[doctor] daemon: a running one reports its connected file names",
    doctor.checkDaemon({ daemon: true, pid: 1, port: 8787, pluginConnected: true, clients: [clientRow({ file: "App — Base", identified: true })] }, 8787).detail.includes("App — Base"));
  ok("[doctor] port: unset → 8787; an allowed value is kept", doctor.resolvePort(undefined).port === 8787 && doctor.resolvePort("8789").port === 8789);
  ok("[doctor] port: a value outside the manifest's three is a failure", doctor.resolvePort("9999").problem?.status === "fail");
  ok("[doctor] port: free is ok; held by our daemon is ok; held by a ws server is a note; by anything else a failure",
    doctor.checkPort(8787, { free: true }, null).status === "ok" && doctor.checkPort(8787, { free: false, holder: "websocket" }, { daemon: true, pid: 7 }).status === "ok"
    && doctor.checkPort(8787, { free: false, holder: "websocket" }, null).status === "warn"
    && doctor.checkPort(8787, { free: false, holder: "http", detail: "x" }, null).status === "fail");
  const wrongTok = doctor.checkPlugin({ clients: [], badToken: { at: 0, fingerprint: "11111111" }, expected: "22222222" }, 10);
  ok("[doctor] plugin: a refused token reads as 'running, wrong token' with both fingerprints and the fix",
    wrongTok.status === "fail" && wrongTok.detail.includes("11111111") && wrongTok.detail.includes("22222222") && /--show-token/.test(wrongTok.next ?? ""));
  ok("[doctor] plugin: connected / nobody came / skipped",
    doctor.checkPlugin({ clients: [{ file: "F", pluginVersion: core.BRIDGE_VERSION, pluginStale: null }] }, 10).status === "ok" && doctor.checkPlugin({ clients: [] }, 10).status === "fail"
    && doctor.checkPlugin({ skipped: "why" }, 10).status === "warn");
  // With two files connected, doctor must not report a plain ✓ when the very next command
  // refused with "say which one to use". Healthy AND ambiguous is one state, not two.
  (() => {
    const one = doctor.checkPlugin({ clients: [{ file: "TideStack", pluginVersion: core.BRIDGE_VERSION, pluginStale: null }] }, 10);
    const two = doctor.checkPlugin({ clients: [{ file: "TideStack", pluginVersion: core.BRIDGE_VERSION, pluginStale: null }, { file: "NIMA", pluginVersion: core.BRIDGE_VERSION, pluginStale: null }] }, 10);
    ok("[doctor] plugin: one connected file is a plain ✓ with no flag to add", one.status === "ok" && one.next === undefined);
    ok("[doctor] plugin: several connected files stay ✓ but warn that commands must disambiguate",
      two.status === "ok" && /2 files, so commands must say which/.test(two.detail) && /--client/.test(two.next ?? ""));
    ok("[doctor] plugin: both file names are still named either way",
      /TideStack/.test(one.detail) && /TideStack/.test(two.detail) && /NIMA/.test(two.detail));
  })();

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-doctor-"));
  // A missing check throws here (as the untyped `.status` on undefined did), naming which one.
  const byId = (checks: Check[], id: string): Check => { const c = checks.find((x) => x.id === id); if (!c) throw new Error("no '" + id + "' check"); return c; };
  ok("[doctor] project: an empty directory is a note (never a failure) pointing at init",
    byId(doctor.checkProject(projDir), "project").status === "warn" && !doctor.checkProject(projDir).some((c) => c.status === "fail"));
  fs.mkdirSync(path.join(projDir, "design"));
  fs.writeFileSync(path.join(projDir, "design", "target.json"), "{}");
  const exportedAt = Date.parse("2026-01-01T00:00:00Z");
  fs.writeFileSync(path.join(projDir, "design", "design-system.json"), JSON.stringify({ exportedAt: new Date(exportedAt).toISOString(), file: "My File" }));
  fs.writeFileSync(path.join(projDir, ".mcp.json"), JSON.stringify({ mcpServers: { figma: { command: "node", args: ["/x/bridge/figma-mcp.mjs"] } } }));
  const fresh = doctor.checkProject(projDir, exportedAt + 3600000);
  ok("[doctor] project: design/ + target.json is ok; a 1h-old export is ok and names its source file",
    byId(fresh, "project").status === "ok" && byId(fresh, "export").status === "ok" && byId(fresh, "export").detail.includes("My File"));
  ok("[doctor] project: an export past 24h is flagged stale", byId(doctor.checkProject(projDir, exportedAt + 3 * 86400000), "export").status === "warn");
  ok("[doctor] project: no codeconnect.local.json is a note", byId(fresh, "map").status === "warn");
  ok("[doctor] project: a legacy `figma` MCP key pointing at figma-mcp.mjs still works, and is told about `designtwin`",
    byId(fresh, "mcp").status === "warn" && /designtwin/.test(byId(fresh, "mcp").next ?? ""));
  fs.writeFileSync(path.join(projDir, ".mcp.json"), JSON.stringify({ mcpServers: { designtwin: { command: "node", args: ["/x/figma-mcp.mjs"] }, figma: { url: "https://mcp.figma.com/mcp" } } }));
  ok("[doctor] project: the `designtwin` key is ok, and Figma's OWN `figma` server is not mistaken for ours", byId(doctor.checkProject(projDir), "mcp").status === "ok");

  // A stray `dtwin pull design ...` writes a SECOND export tree directly under
  // design/ (design/pages/, design/assets/, design/variables.json, design/design-system/) beside the
  // real one at design/export/. Doctor must name which layout it reads AND warn that the other one
  // also exists, rather than silently picking the modern one and saying nothing.
  {
    const parDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-doctor-parallel-"));
    fs.mkdirSync(path.join(parDir, "design", "export", "pages"), { recursive: true });
    fs.writeFileSync(path.join(parDir, "design", "export", "design-system.json"), JSON.stringify({ exportedAt: new Date().toISOString(), file: "Real File" }));
    // The stray legacy tree beside it:
    fs.mkdirSync(path.join(parDir, "design", "pages"), { recursive: true });
    fs.writeFileSync(path.join(parDir, "design", "variables.json"), JSON.stringify({ collections: [] }));
    const checks = doctor.checkProject(parDir);
    const layout = byId(checks, "layout");
    ok("[doctor] parallel layout: warns (never fails) that BOTH design/export/ and a stray design/pages exist",
      layout && layout.status === "warn" && /BOTH layouts/.test(layout.detail) && /design\/pages/.test(layout.detail));
    ok("[doctor] parallel layout: says which one it is actually reading", /design\/export/.test(layout.detail));
    ok("[doctor] parallel layout: the fix points at `dtwin pull --node`, and calls out `dtwin pull design ...` as the trap to avoid, never as the recommended fix",
      /never `dtwin pull design/.test(layout.next ?? "") && /dtwin pull --node/.test(layout.next ?? ""));

    // No parallel tree, no warning:
    const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-doctor-clean-"));
    fs.mkdirSync(path.join(cleanDir, "design", "export"), { recursive: true });
    fs.writeFileSync(path.join(cleanDir, "design", "export", "design-system.json"), JSON.stringify({ exportedAt: new Date().toISOString(), file: "Real File" }));
    ok("[doctor] no parallel tree, no layout warning", !doctor.checkProject(cleanDir).find((c) => c.id === "layout"));
  }

  // Doctor's export line, built from exportSourceCounts(), on a livetest3-shaped copy — 5
  // screens across two pages, none stamped (an older-bridge export), plus one design system. It
  // does not report a single line naming only the design system's file for the WHOLE export
  // ("exported 12.7h ago from 'Design System - Sample (Copy)'"); it counts screens separately
  // from the design system and says plainly when a screen's source was never recorded.
  {
    const dsDir3 = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-doctor-sourcecounts-"));
    const at = new Date().toISOString();
    fs.mkdirSync(path.join(dsDir3, "design", "export"), { recursive: true });
    fs.writeFileSync(path.join(dsDir3, "design", "export", "design-system.json"), JSON.stringify({ exportedAt: at, file: "Design System - NIMA (Copy)" }));
    fs.mkdirSync(path.join(dsDir3, "design", "export", "pages", "PageA"), { recursive: true });
    fs.mkdirSync(path.join(dsDir3, "design", "export", "pages", "PageB"), { recursive: true });
    // Root index has NO layers[] at all (the older-bridge shape) — only pageDirs, forcing the
    // per-page-index fallback.
    fs.writeFileSync(path.join(dsDir3, "design", "export", "pages", "index.json"), JSON.stringify({
      pageDirs: [
        { page: "PageA", dir: "PageA", index: "pages/PageA/index.json", layers: 3 },
        { page: "PageB", dir: "PageB", index: "pages/PageB/index.json", layers: 2 },
      ],
    }));
    fs.writeFileSync(path.join(dsDir3, "design", "export", "pages", "PageA", "index.json"), JSON.stringify({
      layers: [{ name: "S1", file: "pages/PageA/S1.json", exportedAt: at }, { name: "S2", file: "pages/PageA/S2.json", exportedAt: at }, { name: "S3", file: "pages/PageA/S3.json", exportedAt: at }],
    }));
    fs.writeFileSync(path.join(dsDir3, "design", "export", "pages", "PageB", "index.json"), JSON.stringify({
      layers: [{ name: "S4", file: "pages/PageB/S4.json", exportedAt: at }, { name: "S5", file: "pages/PageB/S5.json", exportedAt: at }],
    }));
    const checks3 = doctor.checkProject(dsDir3);
    const exp3 = byId(checks3, "export");
    ok("[doctor] exportSourceCounts: 5 unstamped screens are counted and named as source-not-recorded",
      exp3.status === "ok" && /5 screen\(s\) \(source not recorded — pulled by an older bridge; re-pull to stamp it\)/.test(exp3.detail));
    ok("[doctor] exportSourceCounts: the design system is reported separately, by its own name",
      /design system from 'Design System - NIMA \(Copy\)'/.test(exp3.detail));
    ok("[doctor] exportSourceCounts: never attributes the screens to the design-system file",
      !new RegExp(`5 screen\\(s\\) from 'Design System`).test(exp3.detail));
  }

  // A corrupt or wrong-shaped export index is SAID, not silently counted as "no screens" (a
  // `pageDirs: 5` used to throw inside one try and drop every screen without a word).
  {
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-doctor-badindex-"));
    const exp = path.join(badDir, "design", "export");
    fs.mkdirSync(path.join(exp, "pages", "PageA"), { recursive: true });
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(exp, "design-system.json"), JSON.stringify({ exportedAt: at, file: "DS File" }));
    fs.writeFileSync(path.join(exp, "pages", "index.json"), JSON.stringify({ pageDirs: 5 }));
    const c1 = doctor.checkProject(badDir).filter((c) => c.id === "export");
    ok("[doctor] a wrong-shaped pages/index.json is a warn naming the file and the field; the summary line stays first",
      c1.length === 2 && c1[0]?.status === "ok" && /DS File/.test(c1[0]?.detail ?? "")
      && c1[1]?.status === "warn" && /pages\/index\.json is not the expected shape: .*pageDirs/.test(c1[1]?.detail ?? ""));
    fs.writeFileSync(path.join(exp, "pages", "index.json"), JSON.stringify({ pageDirs: [{ index: "pages/PageA/index.json" }] }));
    fs.writeFileSync(path.join(exp, "pages", "PageA", "index.json"), "{truncated");
    const c2 = doctor.checkProject(badDir).filter((c) => c.id === "export");
    ok("[doctor] a truncated per-page index is a warn naming THAT file",
      c2.some((c) => c.status === "warn" && /pages\/PageA\/index\.json is not valid JSON/.test(c.detail)));
    fs.writeFileSync(path.join(exp, "pages", "PageA", "index.json"), JSON.stringify({ layers: [null, { file: "pages/PageA/S1.json", exportedAt: at }] }));
    const c3 = doctor.checkProject(badDir).filter((c) => c.id === "export");
    ok("[doctor] a valid index (a null row is still skipped, as before) adds no warn and counts the screen",
      c3.length === 1 && /1 screen\(s\)/.test(c3[0]?.detail ?? ""));
    fs.writeFileSync(path.join(exp, "design-system.json"), JSON.stringify({ exportedAt: at, file: { name: "x" } }));
    const c4 = doctor.checkProject(badDir).filter((c) => c.id === "export");
    ok("[doctor] a non-string design-system `file` is a warn, never printed as [object Object]",
      c4.some((c) => /design-system\.json is not the expected shape: .*file/.test(c.detail)) && !c4.some((c) => /\[object Object\]/.test(c.detail)));
  }
  {
    const mcpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-doctor-mcpshape-"));
    fs.writeFileSync(path.join(mcpDir, ".mcp.json"), "null");
    const m1 = byId(doctor.checkProject(mcpDir), "mcp");
    fs.writeFileSync(path.join(mcpDir, ".mcp.json"), '{"mcpServers":"abc"}');
    const m2 = byId(doctor.checkProject(mcpDir), "mcp");
    ok("[doctor] a well-formed JSON .mcp.json of the wrong shape is reported as such — not as 'not valid JSON', not as 'not registered'",
      m1.status === "warn" && /must be a JSON object, not null/.test(m1.detail) && !/not valid JSON/.test(m1.detail)
      && m2.status === "warn" && /`mcpServers` must be an object of server entries, not a string/.test(m2.detail));
  }

  // A "not checked" warn means a check that should have run, didn't — the roll-up must be
  // false, not just when something outright failed.
  {
    const okChecks = [{ id: "a", status: "ok" }, { id: "b", status: "ok" }];
    const notCheckedWarn = [{ id: "a", status: "ok" }, { id: "plugin", status: "warn", detail: "not checked — port 8787 is held by something else" }];
    const ordinaryWarn = [{ id: "a", status: "ok" }, { id: "export", status: "warn", detail: "exported 3 days ago — the Figma file may have moved on" }];
    const runOk = (checks: Array<{ status: string; detail?: string }>) => !checks.some((c) => c.status === "fail" || (c.status === "warn" && /not checked/i.test(c.detail || "")));
    ok("[doctor] ok roll-up: all-ok is true", runOk(okChecks) === true);
    ok("[doctor] ok roll-up: a plain warn (advice about project state) stays true", runOk(ordinaryWarn) === true);
    ok("[doctor] ok roll-up: a 'not checked' warn makes it false, even with zero fails", runOk(notCheckedWarn) === false);
  }

  console.log("\ndoctor — probes (real sockets, spare ports):");
  const httpSrv = http.createServer((_q, s) => s.end("hi"));
  await new Promise<void>((r) => httpSrv.listen(0, "127.0.0.1", r));
  const httpProbe = await doctor.probePort((httpSrv.address() as AddressInfo).port);
  ok("[doctor] probePort: a plain HTTP server is identified as not-a-bridge", httpProbe.free === false && httpProbe.holder === "http");
  const freed = (httpSrv.address() as AddressInfo).port;
  await new Promise<void>((r) => httpSrv.close(() => r()));
  ok("[doctor] probePort: a free port is free, and the probe leaves nothing listening",
    (await doctor.probePort(freed)).free === true && (await doctor.probePort(freed)).free === true);
  const held = core.createBridge(nextPort);
  await new Promise((r) => setTimeout(r, 50));
  const wsProbe = await doctor.probePort(nextPort);
  ok("[doctor] probePort: a bridge is recognised by its 426 to a plain GET — no WebSocket opened", wsProbe.holder === "websocket" && held.listClients().length === 0);
  held.close();
  nextPort++;

  // probePlugin against the REAL handshake: a plugin-shaped client (Origin "null") with each token.
  const pluginLike = (port: number, tok: string) => setTimeout(() => { const c = new WebSocket(`ws://127.0.0.1:${port}/?token=${tok}`, { origin: "null" }); c.on("error", () => {}); }, 150);
  pluginLike(nextPort, "not-the-token");
  const refusedProbe = await doctor.probePlugin(nextPort++, 3000);
  ok("[doctor] probePlugin: a wrong-token plugin is reported by fingerprint, not as 'nothing running'",!!(
    refusedProbe.clients?.length === 0 && refusedProbe.badToken && refusedProbe.badToken.fingerprint === store.fingerprint("not-the-token")
    && refusedProbe.expected === store.fingerprint(TOKEN)));
  pluginLike(nextPort, TOKEN);
  const goodProbe = await doctor.probePlugin(nextPort++, 3000);
  ok("[doctor] probePlugin: a right-token plugin is reported connected", goodProbe.clients?.length === 1 && !goodProbe.badToken);
  const t0 = Date.now();
  const nobody = await doctor.probePlugin(nextPort, 400);
  ok("[doctor] probePlugin: nobody there → empty after the wait, and a stale refusal from an earlier probe is not blamed",
    nobody.clients?.length === 0 && !nobody.badToken && Date.now() - t0 >= 400);
  ok("[doctor] probePlugin always closes its bridge (the port is free again)", (await doctor.probePort(nextPort++)).free === true);

  console.log("\ndoctor — end to end (subprocess):");
  // Fresh config dir → no token → the plugin probe is skipped, so this never binds a port and cannot
  // collide with a real bridge on the developer's machine.
  const docDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-doctor-cfg-"));
  const runDoctor = (argv: string[], extraEnv: Record<string, string> = {}) => {
    const env: Record<string, string | undefined> = { ...process.env, DESIGNTWIN_CONFIG_DIR: docDir, ...extraEnv };
    delete env.FIGMA_BRIDGE_TOKEN;
    delete env.FIGMA_BRIDGE_TOKEN_FILE;
    if (!extraEnv.FIGMA_BRIDGE_PORT) delete env.FIGMA_BRIDGE_PORT;
    return spawnSync(process.execPath, [cli, "doctor", ...argv], { encoding: "utf8", env, cwd: projDir, timeout: 20000 });
  };
  // These two assertions need the port to be genuinely free — no daemon, no plugin — which port 8787
  // is NOT when a real dtwin daemon happens to be running on the developer's machine (a live daemon
  // answers `daemon.status()` regardless of this subprocess's own empty token, which reports the
  // plugin as connected instead of "not checked" and makes the test pass only by accident of the
  // environment). 8788/8789 are the other two ports the plugin's manifest allows
  // (bridge/doctor.js ALLOWED_PORTS) and are not bound by the daemon (which only ever holds one), so
  // this is deterministic whether or not a daemon is running elsewhere.
  const docJson = runDoctor(["--json"], { FIGMA_BRIDGE_PORT: "8789" });
  const docReport = ((): Partial<Report> & { checks: Check[] } => { try { return JSON.parse(docJson.stdout) as Report; } catch { return { checks: [] }; } })();
  ok("[doctor-cli] --json prints one parseable report and nothing else on stdout", docReport.checks.length >= 6);
  ok("[doctor-cli] exit code is 1 only when a check failed", docJson.status === (docReport.ok ? 0 : 1));
  ok("[doctor-cli] with no token, the plugin probe is SKIPPED rather than minting one",
    byId(docReport.checks, "plugin").status === "warn" && byId(docReport.checks, "token").status === "warn");
  ok("[doctor-cli] ok is false while the plugin check is a 'not checked' warn, not just on an outright fail",
    docReport.ok === false && /not checked/.test(byId(docReport.checks, "plugin").detail));
  ok("[doctor-cli] and it left no token file behind — doctor has no side effects", !fs.existsSync(path.join(docDir, "bridge-token")));
  const docHuman = runDoctor([]);
  ok("[doctor-cli] the human report marks each check and gives next steps", /^✓ Node\.js:/m.test(docHuman.stdout) && /^! Bridge token:/m.test(docHuman.stdout) && /^    → /m.test(docHuman.stdout));
  const badPort = runDoctor(["--json"], { FIGMA_BRIDGE_PORT: "9999" });
  ok("[doctor-cli] a bad FIGMA_BRIDGE_PORT is a reported ✗ (exit 1), not a crash inside server-core",
    badPort.status === 1 && byId((JSON.parse(badPort.stdout) as Report).checks, "port").status === "fail" && !badPort.stderr.includes("[bridge]"));
  ok("[doctor-cli] unknown arguments are refused", runDoctor(["--nope"]).status === 1 && runDoctor(["--wait", "x"]).status === 1);
  ok("[doctor-cli] doctor --help exits 0", runDoctor(["--help"]).status === 0);

  // ---------------------------------------------------------------- figma-pull.js, mkdir
  console.log("\nfigma-pull.js — mkdir moved after validation:");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-mkdir-"));
    // Two clients "connected" via the daemon status file so figma-pull refuses ambiguously — before
    // ever touching outDir — is the exact shape of `dtwin nonexistent` with two
    // clients connected. We don't need a real daemon: --list-clients against no bridge at all also
    // exercises the same "no mkdir before any client contact" code path, and is deterministic offline.
    // --timeout 1: with no plugin to wait for the command fails in ~1 s instead of idling until the 5 s cap kills it
    spawnSync(process.execPath, [cli, "nonexistent-outdir", "--timeout", "1"], { encoding: "utf8", cwd: dir, timeout: 5000, env: { ...process.env, FIGMA_BRIDGE_PORT: "8788" } });
    ok("[mkdir] a command that never reaches a plugin leaves no stray outDir behind",
      !fs.existsSync(path.join(dir, "nonexistent-outdir")));
  }

  // ---------------------------------------------------------------- figma-pull.js, outDir trap
  console.log("\nfigma-pull.js — outDir-already-has-export/ warning:");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-outdir-trap-"));
    fs.mkdirSync(path.join(dir, "design", "export"), { recursive: true });
    // No daemon/plugin reachable on this port — the command still fails downstream (no client), but
    // the warning is printed BEFORE any network attempt, so it is present regardless of what happens next.
    const r = spawnSync(process.execPath, [cli, "design", "--list", "--timeout", "1"], { encoding: "utf8", cwd: dir, timeout: 5000, env: { ...process.env, FIGMA_BRIDGE_PORT: "8788" } });
    ok("[outdir-trap] warns when the user-typed outDir already contains export/",
      /warn: design already contains design(\/|\\)export/.test(r.stderr));
    ok("[outdir-trap] never refuses — `design` is still a legitimate, deliberate outDir", r.status !== 2 || !/unknown/.test(r.stderr));
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-outdir-clean-"));
    const r2 = spawnSync(process.execPath, [cli, "somewhere-else", "--list", "--timeout", "1"], { encoding: "utf8", cwd: clean, timeout: 5000, env: { ...process.env, FIGMA_BRIDGE_PORT: "8788" } });
    ok("[outdir-trap] no warning when the outDir does not already contain export/", !/already contains/.test(r2.stderr));
  }

  // ---------------------------------------------------------------- server-core waitForIdentified
  console.log("\nserver-core — waitForIdentified (--client name race):");
  {
    const port = nextPort++;
    const b = core.createBridge(port);
    await b.waitForIdentified(200); // no clients at all: resolves immediately, never hangs
    ok("[identify] waitForIdentified with nobody connected resolves without hanging", true);
    b.close();
  }
  {
    const { bridge: b, client: ws1 } = await connectedBridge();
    // Not yet identified (no `hello` sent) — waitForIdentified must wait for it rather than return
    // instantly, which is exactly the race ("the plugin's identified message
    // has not arrived yet").
    const before = must(b.listClients()[0], "freshly connected client row");
    ok("[identify] freshly connected client starts unidentified", before.identified === false);
    setTimeout(() => ws1.send(JSON.stringify({ type: "hello", instanceId: "i1", file: "App — Base" })), 60);
    await b.waitForIdentified(2000);
    const after = must(b.listClients()[0], "client row after waitForIdentified");
    ok("[identify] waitForIdentified waits for the hello, then returns", after.identified === true && after.file === "App — Base");
    ws1.close();
    b.close();
  }

  // ---------------------------------------------------------------- plugin version reporting
  console.log("\nserver-core — plugin version reporting and staleness:");
  // Live-verified on this machine: a real daemon + a real Figma plugin, both still
  // running older code, produced `pluginVersion: null, pluginStale: null` from `list clients --json`
  // and a plain ✓ from doctor — a MISSING version is exactly the one case guaranteed to predate this
  // feature, so it must warn, not pass silently as "nothing to compare".
  ok("[version] pluginStalenessNote WARNS on no plugin version reported (an older bundle) — 'no version at all' is itself the stale signal, not a free pass",
    (() => { const n1 = core.pluginStalenessNote(null), n2 = core.pluginStalenessNote(undefined);
      return typeof n1 === "string" && /predates version reporting/.test(n1) && /restart `dtwin serve`/.test(n1) && n1 === n2; })());
  ok("[version] pluginStalenessNote is null for a plugin version equal to or newer than the bridge",
    core.pluginStalenessNote(core.BRIDGE_VERSION) === null);
  ok("[version] pluginStalenessNote fires for a plugin version strictly older than the bridge, and names both",
    (() => { const n = core.pluginStalenessNote("0.0.1"); return typeof n === "string" && /0\.0\.1/.test(n) && n.includes(String(core.BRIDGE_VERSION)) && /reload the plugin/.test(n); })());
  {
    // The fake client sends its version in `hello`, exactly like a real plugin's identity relay
    // (figma-plugin/src/bridge.ts's `pluginVersion` -> ui.html's `hello` -> here).
    const { bridge: b, client: ws1 } = await connectedBridge();
    ws1.send(JSON.stringify({ type: "hello", instanceId: "old-1", file: "Old Bundle File", pluginVersion: "0.0.1" }));
    await b.waitForIdentified(1000);
    const row = must(b.listClients()[0], "old-plugin client row");
    ok("[version] a hello's pluginVersion is recorded and surfaced on the client row", row.pluginVersion === "0.0.1");
    ok("[version] an old plugin's row carries the staleness note", typeof row.pluginStale === "string" && /0\.0\.1/.test(row.pluginStale));
    ws1.close();
    b.close();
  }
  {
    // A pre-327 plugin never sends `pluginVersion` at all — must not be reported stale (it's simply
    // unknown), and must not crash anything downstream.
    const { bridge: b, client: ws1 } = await connectedBridge();
    ws1.send(JSON.stringify({ type: "hello", instanceId: "noversion-1", file: "No Version File" }));
    await b.waitForIdentified(1000);
    const row = must(b.listClients()[0], "no-version client row");
    ok("[version] a hello with no pluginVersion at all records null AND is treated as stale (not a crash)",
      row.pluginVersion === null && typeof row.pluginStale === "string" && /predates version reporting/.test(row.pluginStale));
    ws1.close();
    b.close();
  }

  console.log("\ndoctor — plugin staleness surfaces as a warn, distinct from the multi-client ok:");
  ok("[doctor-version] one current-version client stays a plain ok",
    doctor.checkPlugin({ clients: [{ file: "A", identified: true, pluginVersion: core.BRIDGE_VERSION, pluginStale: null }] }, 10).status === "ok");
  ok("[doctor-version] one STALE client is a warn, naming the reload step",
    (() => {
      const c = doctor.checkPlugin({ clients: [{ file: "A", identified: true, pluginVersion: "0.0.1", pluginStale: "plugin v0.0.1 is older — reload the plugin in Figma" }] }, 10);
      return c.status === "warn" && /reload the plugin/.test(c.next || "");
    })());
  ok("[doctor-version] several CURRENT clients still stay ok (multi-client alone is not staleness)",
    doctor.checkPlugin({ clients: [{ file: "A", identified: true, pluginVersion: core.BRIDGE_VERSION, pluginStale: null }, { file: "B", identified: true, pluginVersion: core.BRIDGE_VERSION, pluginStale: null }] }, 10).status === "ok");
  // daemonRowStalenessNote: a row with NO `pluginVersion` key at all (not merely `null`) — the shape a
  // NEWER `dtwin` CLI sees when reading client rows back from an OLDER `dtwin serve` daemon whose own
  // `describe()` predates this feature entirely. Distinct from `pluginStale` (which fires from a
  // CURRENT daemon relaying an old/version-less PLUGIN) — this one means the DAEMON PROCESS itself
  // needs restarting, which reloading the Figma plugin alone would not fix.
  ok("[version] daemonRowStalenessNote is null for a row that HAS the key (even if null)",
    core.daemonRowStalenessNote({ pluginVersion: null }) === null && core.daemonRowStalenessNote({ pluginVersion: "1.2.3" }) === null);
  ok("[version] daemonRowStalenessNote fires for a row with the key entirely ABSENT, naming a daemon restart",
    (() => { const n = core.daemonRowStalenessNote({ file: "A" }); return typeof n === "string" && /dtwin serve/.test(n) && /restart/.test(n); })());
  ok("[doctor-version] a daemon-sourced client row missing pluginVersion entirely still demotes doctor's daemon-plugin check to warn",
    (() => {
      // Mirrors the daemon branch of doctor.run() directly (that branch requires server-core lazily
      // the same way connectedDetail does), using a client shaped exactly like an old daemon's own
      // describe() output — no pluginVersion/pluginStale keys at all.
      const oldDaemonClients: Partial<ClientRow>[] = [{ connId: "c1", file: "TideStack (Copy)", identified: true }];
      const stale = oldDaemonClients.some((cl) => cl.pluginStale || core.daemonRowStalenessNote(cl));
      return stale === true;
    })());

  // ---------------------------------------------------------------- request() stall detector
  console.log("\nserver-core — request() stall detector (a client that never answers):");
  {
    // The fake client in this suite (per its own header comment) — connects, gets `hello`d, but never
    // replies to a command and never sends a progress frame either. This is EXACTLY the shape of a stall:
    // a bridge that IS connected, sitting silent for the full timeout.
    const { bridge: b, client: ws1 } = await connectedBridge();
    ws1.send(JSON.stringify({ type: "hello", instanceId: "silent-1", file: "Silent File" }));
    await b.waitForIdentified(1000);
    const start = Date.now();
    let err: Error | undefined;
    try { await b.request("exportNode", { nodeId: "7314:87192" }, 60000, undefined, 300); }
    catch (e) { err = asErr(e); }
    const elapsed = Date.now() - start;
    ok("[stall] a client that never answers and never reports progress is aborted by the STALL timeout, not the full one",
      !!err && elapsed < 5000 && /dtwin serve/.test(err.message) && /7314:87192/.test(err.message));
    ws1.close();
    b.close();
  }
  {
    // The inverse: progress frames arriving periodically must keep resetting the stall clock, so a
    // genuinely slow (but working) export is never mistaken for a stalled one — a stall detector that
    // fires on ANY export slower than its window would be worse than the bug it fixes.
    const { bridge: b, client: ws1 } = await connectedBridge();
    ws1.send(JSON.stringify({ type: "hello", instanceId: "slow-1", file: "Slow File" }));
    await b.waitForIdentified(1000);
    // stallMs=300, but a progress frame every 100ms — the request must survive well past 300ms of
    // WALL-CLOCK time without the stall timer firing, because activity never actually goes quiet.
    const ticker = setInterval(() => { try { ws1.send(JSON.stringify({ type: "progress", phase: "pages" })); } catch {} }, 100);
    const req = b.request("exportFull", {}, 5000, undefined, 300);
    let rejectedWithStall = false;
    req.catch((e: unknown) => { if (e instanceof Error && /connected but sent nothing/.test(e.message)) rejectedWithStall = true; });
    await new Promise((r) => setTimeout(r, 900)); // 3x the stall window, with progress the whole time
    clearInterval(ticker);
    ok("[stall] periodic progress frames keep resetting the stall clock (no premature abort)", !rejectedWithStall);
    // LIVE 2026-09-25: a working export goes quiet for 14–24 s after a big frame and for 116–135 s
    // before its reply (catalog build + a 120 MB send). Once the plugin has shown ANY life for this
    // request, going quiet is work, not a stall — only the real per-command timeout bounds it now.
    // Before this change the line below saw the stall rejection ~800 ms after the ticks stopped.
    let outcome: string | undefined;
    req.then(() => { outcome = "resolved"; }, (e: unknown) => { outcome = e instanceof Error ? e.message : String(e); });
    await new Promise((r) => setTimeout(r, 1500)); // 5x the stall window (300) of silence after the last tick
    ok("[stall] once the plugin has shown life, silence is NOT a stall: the request stays pending past the stall window", outcome === undefined && !rejectedWithStall);
    await new Promise((r) => setTimeout(r, 3000)); // now the real timeout (5000 ms from send) has passed
    ok("[stall] …and the real per-command timeout still bounds it, with the timeout text (not the stall text)",
      typeof outcome === "string" && /did not answer 'exportFull' within 5s/.test(outcome) && !/connected but sent nothing/.test(outcome));
    ws1.close();
    b.close();
  }
  {
    // Life shown BEFORE the command was sent does not count: the first test's client `hello`d and
    // then went silent, and was aborted — this pins that the disarm reads activity since `sentAt`,
    // not "ever". A second silent request on a connection that answered progress for an EARLIER
    // request must still stall.
    const { bridge: b, client: ws1 } = await connectedBridge();
    ws1.send(JSON.stringify({ type: "hello", instanceId: "silent-2", file: "Silent File 2" }));
    await b.waitForIdentified(1000);
    ws1.send(JSON.stringify({ type: "progress", phase: "pages" })); // life, but before the request below
    await new Promise((r) => setTimeout(r, 50));
    let err: Error | undefined;
    const start = Date.now();
    try { await b.request("exportFull", {}, 60000, undefined, 300); }
    catch (e) { err = asErr(e); }
    ok("[stall] activity from BEFORE the command was sent does not disarm the check: a request with no life since send still stalls",
      !!err && Date.now() - start < 5000 && /connected but sent nothing/.test(err.message));
    ws1.close();
    b.close();
  }
  {
    // The disarm is a frame COUNT, not a clock. A client that CONNECTED in the same millisecond as the
    // send — no hello, nothing since — has shown no life since the send and must still stall. The
    // timestamp compare this replaced (`lastActivity >= sentAt`, with lastActivity set at connect) read
    // that connect as life and never fired; the [stall] blocks above and the [cancel] stall check below
    // needed a hello + a sleep before their request for exactly that reason. Here the request goes out
    // in the same tick the connect resolved in, and the client never sends a frame.
    const { bridge: b, client: ws1 } = await connectedBridge();
    let err: Error | undefined;
    const start = Date.now();
    try { await b.request("exportFull", {}, 60000, undefined, 300); }
    catch (e) { err = asErr(e); }
    ok("[stall] a client that connected in the same instant as the send and sent nothing since still stalls (frame count, not clock)",
      !!err && Date.now() - start < 5000 && /connected but sent nothing/.test(err.message));
    ws1.close();
    b.close();
  }

  // ---------------------------------------------------------------- cancel frames
  // Whenever the bridge gives up on a request it already sent — the stall check, the per-command
  // timeout, close(), the caller's AbortSignal, or (through the daemon) the daemon's own client going
  // away — the plugin must be told with `{ type: "cancel", id }`, or it keeps walking the export for
  // nobody and queues every later command behind it. Each check below drives the REAL socket path
  // with a fake plugin that records every frame it receives and never answers.
  console.log("\nserver-core / daemon — cancel frames to the plugin when a request is abandoned:");
  {
    type Seen = { id?: string; cmd?: string; type?: string };
    const record = (ws: WebSocket, into: Array<Seen | "socket-closed">) => {
      ws.on("message", (d: RawData) => {
        const v = JSON.parse(d.toString()) as unknown;
        if (v !== null && typeof v === "object") into.push(v); // any object is a Seen: every field is optional and read defensively
      });
      ws.on("close", () => into.push("socket-closed"));
    };
    const frames = (into: Array<Seen | "socket-closed">) => into.filter((f): f is Seen => f !== "socket-closed");
    const cmdFrames = (into: Array<Seen | "socket-closed">) => frames(into).filter((f) => typeof f.cmd === "string");
    const cancelsFor = (into: Array<Seen | "socket-closed">, id: string | undefined) =>
      frames(into).filter((f) => f.type === "cancel" && f.id === id && f.cmd === undefined);
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    // (a) the stall check. Pre-change server-core.ts (the stall interval, ~line 797-808) deleted the
    // request and rejected without a word to the plugin — no cancel frame ever reached it.
    {
      const { bridge: b, client: ws1 } = await connectedBridge();
      const seen: Array<Seen | "socket-closed"> = [];
      record(ws1, seen);
      // Same setup as the [stall] blocks above: identified, then quiet. Sending in the SAME millisecond
      // as the connect would read the connect itself as "life since send" and disarm the check.
      ws1.send(JSON.stringify({ type: "hello", instanceId: "cancel-stall", file: "Cancel File" }));
      await b.waitForIdentified(1000);
      await sleep(20);
      let err: Error | undefined;
      try { await b.request("exportNode", { nodeId: "1:2" }, 10000, undefined, 300); } catch (e) { err = asErr(e); }
      await sleep(100); // the frame was sent BEFORE the rejection; give it its trip over loopback
      const sent = cmdFrames(seen)[0];
      ok("[cancel] stall check fires → the plugin gets { type: \"cancel\", id } for the request it was sent",
        !!err && /connected but sent nothing/.test(err.message) && !!sent && cancelsFor(seen, sent.id).length === 1);
      ws1.close();
      b.close();
    }
    // (b) the per-command timeout. Pre-change (the setTimeout in requestWithClient, ~line 772-784)
    // likewise rejected silently.
    {
      const { bridge: b, client: ws1 } = await connectedBridge();
      const seen: Array<Seen | "socket-closed"> = [];
      record(ws1, seen);
      let err: Error | undefined;
      try { await b.request("exportFull", {}, 400); } catch (e) { err = asErr(e); }
      await sleep(100);
      const sent = cmdFrames(seen)[0];
      ok("[cancel] per-command timeout fires → the plugin gets the cancel frame for that id",
        !!err && /did not answer 'exportFull'/.test(err.message) && !!sent && cancelsFor(seen, sent.id).length === 1);
      ws1.close();
      b.close();
    }
    // (c) close() with a request pending. Pre-change close() (~line 866-869) rejected "bridge closed"
    // and closed the socket; the plugin saw a close and no cancel for the exact request.
    {
      const { bridge: b, client: ws1 } = await connectedBridge();
      const seen: Array<Seen | "socket-closed"> = [];
      record(ws1, seen);
      let err: Error | undefined;
      const inflight = b.request("exportFull", {}, 20000).catch((e: unknown) => { err = asErr(e); });
      await sleep(60); // let the command land before the close
      b.close();
      await inflight;
      await sleep(300); // the socket's closing handshake
      const sent = cmdFrames(seen)[0];
      const cancelAt = seen.findIndex((f) => f !== "socket-closed" && f.type === "cancel" && !!sent && f.id === sent.id);
      const closedAt = seen.indexOf("socket-closed");
      ok("[cancel] close() with a request pending → the cancel frame arrives BEFORE the socket closes",
        err?.message === "bridge closed" && cancelAt > 0 && closedAt > cancelAt);
    }
    // (d) the caller's AbortSignal. Pre-change request()/requestWithClient() had no `signal` parameter:
    // the extra argument was ignored, the command stayed pending until its timeout, nothing was cancelled.
    {
      const { bridge: b, client: ws1 } = await connectedBridge();
      const seen: Array<Seen | "socket-closed"> = [];
      record(ws1, seen);
      // Answers only ping, so the same bridge can prove a request after the abort still round-trips.
      ws1.on("message", (d: RawData) => {
        const f = JSON.parse(d.toString()) as CommandFrame;
        if (f.cmd === "ping") ws1.send(JSON.stringify({ id: f.id, ok: true, result: { pong: true, page: "P", file: "F" } }));
      });
      const ac = new AbortController();
      let err: Error | undefined;
      const start = Date.now();
      const inflight = b.request("exportFull", {}, 20000, undefined, undefined, undefined, ac.signal).catch((e: unknown) => { err = asErr(e); });
      await sleep(60);
      ac.abort();
      await inflight;
      // "At once" = well inside the 20 s budget: the abort path is synchronous, so only a request left
      // waiting for its timeout could come near it (no tighter wall-clock bound: a loaded machine is late).
      const abortedMs = Date.now() - start;
      await until(() => cancelsFor(seen, cmdFrames(seen)[0]?.id).length >= 1);
      const sent = cmdFrames(seen)[0];
      ok("[cancel] signal aborted while pending → cancel frame sent, rejects \"request aborted by the caller\" at once",
        err?.message === "request aborted by the caller" && abortedMs < 20000 && !!sent && cancelsFor(seen, sent.id).length === 1);
      // An Error reason of the caller's own is passed through (the daemon names its departed client).
      const ac2 = new AbortController();
      let err2: Error | undefined;
      const inflight2 = b.request("exportFull", {}, 20000, undefined, undefined, undefined, ac2.signal).catch((e: unknown) => { err2 = asErr(e); });
      await sleep(30);
      ac2.abort(new Error("caller-specific reason"));
      await inflight2;
      ok("[cancel] an Error given as the abort reason is the rejection itself", err2?.message === "caller-specific reason");
      // A settled request removes its abort listener (no leak on a long-lived signal), and the bridge
      // still answers the next request after the aborted ones.
      const ac3 = new AbortController();
      // One listener while in flight, none once settled.
      const pinging = b.request("ping", {}, 2000, undefined, undefined, undefined, ac3.signal);
      const listening = getEventListeners(ac3.signal, "abort").length;
      const pong = await pinging;
      ok("[cancel] after aborts the bridge still round-trips, and the settled request left no abort listener behind",
        pong.pong === true && listening === 1 && getEventListeners(ac3.signal, "abort").length === 0);
      // Aborted BEFORE the call: nothing is sent at all.
      const before = cmdFrames(seen).length;
      const pre = new AbortController();
      pre.abort();
      let err3: Error | undefined;
      try { await b.request("exportFull", {}, 20000, undefined, undefined, undefined, pre.signal); } catch (e) { err3 = asErr(e); }
      await sleep(100);
      ok("[cancel] a signal aborted before the call rejects \"request aborted before it was sent\" and sends no command frame",
        err3?.message === "request aborted before it was sent" && cmdFrames(seen).length === before);
      ws1.close();
      b.close();
    }
    // (d, timers) An aborted request leaves no timer armed: a child process with a 60 s request that it
    // aborts must exit on its own right away. Pre-change the 60 s timer (and the request) stayed live.
    {
      const port = nextPort++;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-abort-"));
      const script = path.join(dir, "abort.mjs");
      fs.writeFileSync(script, [
        'process.env.FIGMA_BRIDGE_TOKEN = "t";',
        `const { createBridge } = await import(${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../bridge/src/server-core.ts")).href)});`,
        `const { default: WebSocket } = await import(${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../node_modules/ws/wrapper.mjs")).href)});`,
        `const bridge = createBridge(${port});`,
        `const ws = new WebSocket("ws://127.0.0.1:${port}/?token=t", { origin: "null" });`,
        'await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });',
        "const ac = new AbortController();",
        'const p = bridge.request("exportFull", {}, 60000, undefined, undefined, undefined, ac.signal).catch((e) => console.log("REJECTED:" + e.message));',
        "setTimeout(() => ac.abort(), 50);",
        "await p;",
        // Closed only AFTER the request settled, so close() finds nothing pending to clear: a timer the
        // abort failed to clear would still hold the loop open for its full 60 s.
        "ws.terminate();",
        "bridge.close();",
      ].join("\n"));
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 20000 });
      ok("[cancel] an aborted request leaves no timer behind — the process exits on its own promptly",
        r.status === 0 && /REJECTED:request aborted by the caller/.test(r.stdout) && Date.now() - t0 < 10000);
      fs.rmSync(dir, { recursive: true, force: true });
    }

    // (e) the daemon. A real server-core bridge + a fake plugin behind a real daemon socket.
    // Pre-change daemon.ts ignored its client's disconnect entirely: the in-flight request ran to its
    // timeout with no cancel, and a queued one was forwarded once the one ahead of it finished.
    {
      const { bridge: b, client: ws1 } = await connectedBridge();
      const seen: Array<Seen | "socket-closed"> = [];
      record(ws1, seen);
      const C_PORT = 19791; // a socket name only (the bridge above has its own TCP port)
      const { shutdown } = await daemon.serve(b, { port: C_PORT, signals: false, crashHandlers: false });
      const openRaw = (frame: object) => new Promise<net.Socket>((resolve, reject) => {
        const c = net.createConnection(daemon.sockPath(C_PORT));
        c.on("error", reject);
        c.on("connect", () => { c.write(JSON.stringify(frame) + "\n"); resolve(c); });
      });
      // In flight: sent, plugin silent, client destroys its socket → the plugin gets the cancel frame.
      const beforeF = cmdFrames(seen).length;
      const c1 = await openRaw({ cmd: "exportFull", args: {}, timeoutMs: 20000 });
      await until(() => cmdFrames(seen).length > beforeF); // forwarded to the plugin
      const sent = cmdFrames(seen)[beforeF];
      c1.destroy();
      await until(() => cancelsFor(seen, sent?.id).length >= 1);
      ok("[cancel-daemon] a client that disconnects while its request is in flight → the plugin gets the cancel frame",
        !!sent && sent.cmd === "exportFull" && cancelsFor(seen, sent.id).length === 1);
      // Queued: A in flight on one client (the fake plugin holds it), B queued behind it on another
      // that then disconnects. When A is answered, B must NOT be forwarded. Pre-change B went to the
      // plugin as soon as A released the queue. No timer decides the order: B's
      // client ends its socket after writing the frame, so the daemon reads B, then its 'end' aborts B
      // (allowHalfOpen:false: the daemon's own FIN goes out after that listener ran) — the client's
      // 'close' therefore proves B is aborted before A is answered. A third request C is the fence:
      // the queue is FIFO, so a forwarded B would sit between A and C.
      const replyOn = (c: net.Socket) => new Promise<string>((resolve) => {
        let buf = "";
        c.setEncoding("utf8");
        c.on("data", (d: string) => { buf += d; if (buf.includes("\n")) resolve(buf); });
        c.on("close", () => resolve(buf));
      });
      const beforeQ = cmdFrames(seen).length;
      const cA = await openRaw({ cmd: "listPages", args: { depth: 1 }, timeoutMs: 20000 });
      const aReply = replyOn(cA);
      await until(() => cmdFrames(seen).length > beforeQ);
      const aSent = cmdFrames(seen)[beforeQ];
      const cB = await openRaw({ cmd: "exportDesignSystem", args: {}, timeoutMs: 20000 });
      cB.end();
      await new Promise((r) => cB.once("close", r));
      const pagesReply = { pages: [], manifest: {} }; // the minimum listPages reply server-core accepts
      if (aSent) ws1.send(JSON.stringify({ id: aSent.id, ok: true, result: pagesReply }));
      const aGot = await aReply;
      const cC = await openRaw({ cmd: "listPages", args: { depth: 1 }, timeoutMs: 20000 });
      await until(() => cmdFrames(seen).length > beforeQ + 1);
      const cSent = cmdFrames(seen)[beforeQ + 1];
      if (cSent) ws1.send(JSON.stringify({ id: cSent.id, ok: true, result: pagesReply }));
      const afterQ = cmdFrames(seen).slice(beforeQ).map((f) => f.cmd);
      ok("[cancel-daemon] a request still QUEUED when its client disconnects is never forwarded to the plugin",
        /"ok":true/.test(aGot) && afterQ.join(",") === "listPages,listPages" && cancelsFor(seen, sent?.id).length === 1);
      cC.destroy();
      cA.destroy();
      shutdown();
      ws1.close();
    }

    // (f) the daemon's OWN queued-abandon check, with no server-core behind it. In (e) server-core's pre-send
    // `signal.aborted` check also stops B, so a daemon that forwarded an abandoned queued request still passed
    // (a daemon.ts `abandoned()` that returns false survived). This fake bridge ignores `signal` entirely:
    // only the daemon can keep B from reaching it. A is held, B's client ends while B is queued, C is the FIFO fence.
    {
      const seenCmds: string[] = [];
      let releaseA: (() => void) | undefined;
      const row = clientRow({ connId: "c1" });
      const blindBridge: DaemonBridge = {
        port: 0, isConnected: () => true, waitForConnection: async () => {}, close: () => {},
        request: async () => ({}),
        requestWithClient: (cmd) => {
          seenCmds.push(cmd);
          if (cmd === "listPages") return new Promise((r) => { releaseA = () => r({ reply: {}, client: row }); });
          return Promise.resolve({ reply: {}, client: row });
        },
      };
      const F_PORT = 19793; // a socket name only
      const { shutdown } = await daemon.serve(blindBridge, { port: F_PORT, signals: false, crashHandlers: false });
      const openRaw = (frame: object) => new Promise<net.Socket>((resolve, reject) => {
        const c = net.createConnection(daemon.sockPath(F_PORT));
        c.on("error", reject);
        c.on("connect", () => { c.write(JSON.stringify(frame) + "\n"); resolve(c); });
      });
      const fA = await openRaw({ cmd: "listPages", args: {}, timeoutMs: 20000 });
      await until(() => seenCmds.length === 1);
      const fB = await openRaw({ cmd: "exportDesignSystem", args: {}, timeoutMs: 20000 });
      fB.end();
      await new Promise((r) => fB.once("close", r));
      releaseA?.();
      const fC = await openRaw({ cmd: "whoami", args: {}, timeoutMs: 20000 });
      await until(() => seenCmds.includes("whoami"));
      ok(`[cancel-daemon] the daemon itself drops a queued request whose client left — a bridge that ignores the abort never sees it (${seenCmds.join(",")})`,
        seenCmds.join(",") === "listPages,whoami");
      fA.destroy();
      fC.destroy();
      shutdown();
    }
  }

  // ---------------------------------------------------------------- request ids, reply routing, stall wording, whoami connection
  // Live (session 14): a direct pull stalled out; the next request through a fresh daemon failed with
  // "export cancelled: … abandoned" — the plugin's late failure for the dead bridge's `r1` settled the
  // daemon's own `r1`. Ids are now unique per bridge, and a reply settles only from the socket the
  // request went to. Each check drives the REAL socket path with a fake plugin.
  console.log("\nserver-core — per-bridge request ids, reply routing, stall wording, whoami connection:");
  {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const ABANDONED = "export cancelled: the bridge request that asked for it was abandoned (its caller timed out, stalled out, or disconnected)";
    /** Every command frame a fake plugin socket receives. */
    const commandsOf = (ws: WebSocket): CommandFrame[] => {
      const into: CommandFrame[] = [];
      ws.on("message", (d: RawData) => {
        const v = JSON.parse(d.toString()) as unknown;
        if (v !== null && typeof v === "object" && "cmd" in v && "id" in v && typeof v.id === "string") into.push(v as CommandFrame);
      });
      return into;
    };
    const pingReply = (file: string) => ({ pong: true, page: "P", file });
    const settle = <T>(p: Promise<T>): Promise<{ v: T | null; err: Error | null }> => p.then((v) => ({ v, err: null }), (e: unknown) => ({ v: null, err: asErr(e) }));

    // two bridges' first wire ids differ. Pre-change both were "r1".
    const A = await connectedBridge();
    const seenA = commandsOf(A.client);
    const aReq = settle(A.bridge.request("ping", {}, 3000));
    await sleep(80);
    const idA = seenA[0]?.id;
    A.bridge.close(); // the stalled one-shot CLI goes away with its request unanswered
    await aReq;
    A.client.close();
    const B = await connectedBridge();
    const seenB = commandsOf(B.client);
    const bReq = settle(B.bridge.request("ping", {}, 3000));
    await sleep(80);
    const idB = seenB[0]?.id;
    ok("two bridges' first request ids differ (per-bridge nonce), and stay opaque strings starting \"r\"",
      typeof idA === "string" && typeof idB === "string" && idA !== idB && /^r/.test(idA) && /^r/.test(idB));
    // the plugin first posts the OLD bridge's failure (its run for idA finally threw), then answers
    // the new request. Pre-change idA === idB, so the stale failure rejected the new request.
    B.client.send(JSON.stringify({ id: idA, ok: false, error: ABANDONED }));
    await sleep(50);
    B.client.send(JSON.stringify({ id: idB, ok: true, result: pingReply("for-B") }));
    const rB = await bReq;
    ok("a reply carrying the previous bridge's id does not settle the new request — B resolves with its own reply",
      rB.err === null && rB.v?.file === "for-B");
    B.client.close();
    B.bridge.close();

    // two clients; a reply for c1's request arriving on c2 is ignored, c1's own reply resolves it.
    // Pre-change it settled from c2.
    {
      const { bridge: b, client: c1 } = await connectedBridge();
      const c2 = new WebSocket(`ws://127.0.0.1:${b.port}/?token=${TOKEN}`, { origin: "null" });
      await new Promise((res, rej) => { c2.on("open", res); c2.on("error", rej); });
      const seen1 = commandsOf(c1);
      await sleep(30);
      const req = settle(b.request("ping", {}, 3000, "c1"));
      await sleep(80);
      const sent = seen1[0];
      c2.send(JSON.stringify({ id: sent?.id, ok: true, result: pingReply("from-c2") }));
      await sleep(80);
      c1.send(JSON.stringify({ id: sent?.id, ok: true, result: pingReply("from-c1") }));
      const r = await req;
      ok("a reply for c1's request that arrives on c2 is ignored; c1's own reply resolves it",
        !!sent && r.err === null && r.v?.file === "from-c1");
      // the connection named by connId, not the first live one. Pre-change connectionInfo()
      // took no target and connectionFor did not exist.
      const rows = b.listClients();
      const row2 = rows.find((c) => c.connId === "c2");
      const viaArg = b.connectionInfo("c2");
      const pure = typeof core.connectionFor === "function" ? core.connectionFor(b.connectionInfo(), "c2") : null;
      ok("connectionFor(connectionInfo(), \"c2\") / connectionInfo(\"c2\") describe c2 (connId + its connectedAt), keeping the clients list",
        !!row2 && !!pure && pure.connId === "c2" && pure.connectedAt === row2.connectedAt && viaArg.connId === "c2" &&
        viaArg.connectedAt === row2.connectedAt && pure.clientsConnected === 2 && pure.clients.length === 2);
      ok("…no connId, or an unknown one, still describes the first connection",
        b.connectionInfo().connId === "c1" && b.connectionInfo("c9").connId === "c1");
      c1.close();
      c2.close();
      b.close();
    }

    // the stall fires only after connect + identify, so it says the plugin IS connected and
    // busy — not that a reconnect is what takes the time. Pre-change: the "missing daemon" text.
    {
      const { bridge: b, client: ws1 } = await connectedBridge();
      ws1.send(JSON.stringify({ type: "hello", instanceId: "stall-g14", file: "Sample App" }));
      await b.waitForIdentified(1000);
      await sleep(20);
      let err: Error | undefined;
      try { await b.request("exportNode", { nodeId: "5:6" }, 10000, undefined, 300); } catch (e) { err = asErr(e); }
      ok("the stall text says the plugin is connected but sent nothing, names the node and `dtwin serve`, and does not blame a reconnect",
        !!err && /the plugin is connected but sent nothing for 'exportNode' \(node 5:6\) in 0s/.test(err.message) &&
        /dtwin serve/.test(err.message) && !/reconnect/i.test(err.message));
      ws1.close();
      b.close();
    }
    // (control) a `start` frame — what the plugin relays at the run's run-begin — is life:
    // the stall disarms and the reply at 600 ms resolves. Same for a `queued` frame.
    for (const phase of ["start", "queued"]) {
      const { bridge: b, client: ws1 } = await connectedBridge();
      const seen = commandsOf(ws1);
      ws1.send(JSON.stringify({ type: "hello", instanceId: "stall2-" + phase, file: "Sample App" }));
      await b.waitForIdentified(1000);
      await sleep(20);
      const ticks: ProgressTick[] = [];
      const req = settle(b.request("ping", {}, 10000, undefined, 300, (t) => ticks.push(t)));
      setTimeout(() => ws1.send(JSON.stringify({ type: "progress", phase })), 100);
      setTimeout(() => ws1.send(JSON.stringify({ id: seen[0]?.id, ok: true, result: pingReply("late") })), 600);
      const r = await req;
      ok(`a \`${phase}\` progress frame at 100 ms disarms the 300 ms stall; the reply at 600 ms resolves, and the tick reaches the listener`,
        r.err === null && r.v?.file === "late" && ticks.length === 1 && ticks[0]?.phase === phase);
      ws1.close();
      b.close();
    }

    // two requests in flight on ONE connection: the plugin executes A and queues B. A `start`
    // / `queued` frame carrying a requestId reaches only that request (the executing A never hears it is
    // "queued"); an id-less frame (page ticks, an older plugin) still reaches both.
    {
      const { bridge: b, client: ws1 } = await connectedBridge();
      const seen = commandsOf(ws1);
      ws1.send(JSON.stringify({ type: "hello", instanceId: "l8", file: "Sample App" }));
      await b.waitForIdentified(1000);
      await sleep(20);
      const ticksA: string[] = [], ticksB: string[] = [];
      const pA = settle(b.request("ping", {}, 5000, undefined, undefined, (t) => ticksA.push(String(t.phase))));
      await sleep(30);
      const pB = settle(b.request("ping", {}, 5000, undefined, undefined, (t) => ticksB.push(String(t.phase))));
      await sleep(30);
      const idA = seen[0]?.id, idB = seen[1]?.id;
      ws1.send(JSON.stringify({ type: "progress", phase: "start", requestId: idA }));
      ws1.send(JSON.stringify({ type: "progress", phase: "queued", requestId: idB }));
      ws1.send(JSON.stringify({ type: "progress", phase: "pages" }));
      await sleep(30);
      ws1.send(JSON.stringify({ id: idA, ok: true, result: pingReply("A") }));
      ws1.send(JSON.stringify({ type: "progress", phase: "start", requestId: idB }));
      await sleep(30);
      ws1.send(JSON.stringify({ id: idB, ok: true, result: pingReply("B") }));
      const [rA, rB] = [await pA, await pB];
      ok(`an id-carrying start/queued frame reaches only its own request; an id-less tick reaches both (A saw ${ticksA.join(",")} | B saw ${ticksB.join(",")})`,
        typeof idA === "string" && typeof idB === "string" && rA.v?.file === "A" && rB.v?.file === "B" &&
        ticksA.join(",") === "start,pages" && ticksB.join(",") === "queued,pages,start");
      ws1.close();
      b.close();
    }

    // the daemon client's optional trailing `signal` (the MCP cancel via a daemon): an
    // abort closes the request's socket, so the daemon abandons it on the wire. Without it, the client
    // would let the call run to its reply and the bridge's signal would never abort.
    {
      const S_PORT = 19792; // a socket name only: the fake bridge binds no TCP port
      const row: ClientRow = { connId: "c1", file: "Sample App", fileKey: null, page: "Home", instanceId: "fig-s", connectedAt: 1, uptimeMs: 1, identified: true, pluginVersion: null, pluginStale: null };
      const bridgeSaw: string[] = [];
      const sigBridge: DaemonBridge = {
        port: S_PORT,
        isConnected: () => true,
        waitForConnection: async () => {},
        close: () => {},
        request: async () => { throw new Error("never asked through request()"); },
        requestWithClient: (cmd, _args, _timeoutMs, _target, _stallMs, _onProgress, signal) => new Promise((resolve) => {
          bridgeSaw.push("got:" + cmd);
          const t = setTimeout(() => resolve({ reply: pingReply("answered"), client: row }), 1500);
          signal?.addEventListener("abort", () => {
            clearTimeout(t);
            bridgeSaw.push("aborted:" + (signal.reason instanceof Error ? signal.reason.message : String(signal.reason)));
            resolve({ reply: pingReply("aborted"), client: row });
          }, { once: true });
        }),
      };
      const { shutdown } = await daemon.serve(sigBridge, { port: S_PORT, signals: false, crashHandlers: false });
      const scli = await daemon.connect(S_PORT);
      if (!scli) throw new Error("daemon.connect() returned null right after serve() (signal daemon)");
      const ac = new AbortController();
      const t0 = Date.now();
      const pending = settle(scli.requestWithClient({ cmd: "ping", timeoutMs: 5000 }, 5000, undefined, ac.signal));
      setTimeout(() => ac.abort(), 100);
      const r = await pending;
      const elapsed = Date.now() - t0;
      await sleep(150); // the daemon sees the socket close and aborts the bridge request
      ok("daemon client: aborting the signal rejects at once with \"request aborted by the caller\"",
        r.v === null && r.err?.message === "request aborted by the caller" && elapsed < 1000);
      ok("…and the daemon abandons the in-flight bridge request (its signal is aborted: the plugin gets a cancel frame)",
        bridgeSaw.join("|") === "got:ping|aborted:the daemon's client disconnected before the reply");
      // An Error reason of the caller's own is the rejection; an already-aborted signal sends nothing.
      const ac2 = new AbortController();
      const p2 = settle(scli.request({ cmd: "ping", timeoutMs: 5000 }, 5000, undefined, ac2.signal));
      setTimeout(() => ac2.abort(new Error("caller went away")), 50);
      const r2 = await p2;
      await sleep(150);
      const pre = new AbortController();
      pre.abort();
      const before = bridgeSaw.length;
      const r3 = await settle(scli.request({ cmd: "ping", timeoutMs: 5000 }, 5000, undefined, pre.signal));
      await sleep(100);
      ok("…an Error reason passes through; an already-aborted signal rejects \"request aborted before it was sent\" and forwards nothing",
        r2.err?.message === "caller went away" && r3.err?.message === "request aborted before it was sent" && bridgeSaw.length === before);
      // A request that settles normally leaves no abort listener behind on a long-lived signal.
      const ac4 = new AbortController();
      const p4 = scli.request({ cmd: "ping", timeoutMs: 5000 }, 5000, undefined, ac4.signal);
      const listening = getEventListeners(ac4.signal, "abort").length;
      const r4 = await p4;
      ok("…a request that settles normally answers and removes its abort listener",
        r4.file === "answered" && listening === 1 && getEventListeners(ac4.signal, "abort").length === 0);
      shutdown();
    }
  }

  // ---------------------------------------------------------------- write-out.js asset clobbering
  console.log("\nwrite-out.js — asset writes are refuse-or-version, never clobber:");
  const writeOut = await import("../bridge/src/write-out.ts");
  {
    // Two Figma layers named `angle-left` and `Angle-left` — different content, different screens'
    // pulls, into the SAME shared assets/ dir. On a case-insensitive filesystem (macOS default) they
    // are one path; the fix must never let the second call's fs.writeFileSync target write over the
    // first's bytes.
    // The fixtures are stored as variant-a.svg/variant-b.svg — never AS "angle-left.svg"/"Angle-left.svg"
    // on disk, because a case-insensitive filesystem (this repo's own dev machines included) collapses
    // that pair into one file/one inode before the test even runs, which is the very collision being tested. The
    // colliding names are only ever given to write-out.js as `a.file` — as REAL Figma exports arrive,
    // never as files this test itself created.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-assets-"));
    const svg1 = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "livetest3", "case-collision", "variant-a.svg"), "utf8");
    const svg2 = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "livetest3", "case-collision", "variant-b.svg"), "utf8");
    const a1 = asset({ id: "n1", file: "assets/angle-left.svg", text: svg1, hash: "aaaaaaaa-1" });
    const a2 = asset({ id: "n2", file: "assets/Angle-left.svg", text: svg2, hash: "bbbbbbbb-1" });
    writeOut.writeAssets(dir, [a1]);
    writeOut.writeAssets(dir, [a2]); // simulates a second, later screen pull into the same shared dir
    const onDisk = fs.readdirSync(path.join(dir, "assets"));
    ok("[case-fold] both differently-cased, different-content assets survive as TWO files", onDisk.length === 2);
    const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
    ok("[case-fold] the FIRST file's bytes are untouched (never clobbered)", read(a1.file) === svg1);
    ok("[case-fold] the SECOND asset got a distinct, non-colliding name (not the same as the first)",
      a2.file.toLowerCase() !== a1.file.toLowerCase() && read(a2.file) === svg2);

    // A re-pull that produces byte-IDENTICAL content under the same name is a no-op, not a rewrite or
    // a new suffixed file — re-pulling an unchanged screen must not multiply files on disk.
    writeOut.writeAssets(dir, [asset({ id: "n1b", file: "assets/angle-left.svg", text: svg1, hash: "aaaaaaaa-1" })]);
    ok("[case-fold] an identical re-pull reuses the existing file rather than duplicating it",
      fs.readdirSync(path.join(dir, "assets")).length === 2);
  }
  // ---------------------------------------------------------------- content dedup regardless of NAME
  console.log("\nwrite-out.js — writeAssets dedups by CONTENT, not just by name:");
  {
    // A live three-screen pull produced 4 Ellipse_2327*
    // files for one icon when the reuse path only checked "is anything already written under THIS
    // exact name" and could not see that a NEW name's bytes were already on disk under a
    // DIFFERENT, earlier name (an earlier screen's pull, or a same-run sibling the plugin named
    // differently). This is the exact shape: write "Ellipse_2327.svg" first, then hand writeAssets the
    // SAME bytes under the name "Ellipse_2327-e9af26.svg" (what a real duplicate-content pull looks
    // like on disk).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-content-dedup-"));
    const circle = '<svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="#fff"/></svg>';
    const a1 = asset({ id: "n1", file: "assets/Ellipse_2327.svg", text: circle, hash: "aaaaaaaa-1" });
    writeOut.writeAssets(dir, [a1]);
    const a2 = asset({ id: "n2", file: "assets/Ellipse_2327-e9af26.svg", text: circle, hash: "bbbbbbbb-1" });
    writeOut.writeAssets(dir, [a2]);
    const onDisk = fs.readdirSync(path.join(dir, "assets"));
    ok("[content-dedup] a new NAME whose content already exists on disk reuses the existing file — one file, not two",
      onDisk.length === 1 && onDisk[0] === "Ellipse_2327.svg");
    ok("[content-dedup] the reused asset's `a.file` points at the EXISTING name, not the one it arrived under",
      a2.file === "assets/Ellipse_2327.svg");
    // duplicates must be EMPTY for this group now that dedup happens before either file is written —
    // there is only ever one file, so there is nothing for the duplicates scan to find.
    fs.mkdirSync(path.join(dir, "pages", "P"), { recursive: true });
    writeOut.writeScreenAssets(dir, screenPaths({ screenName: "S", page: "P" }, "/"), [a1, a2]);
    const doc = JSON.parse(fs.readFileSync(path.join(dir, "pages", "P", "S.assets.json"), "utf8")) as ScreenAssetsDoc;
    ok("[content-dedup] `duplicates` is empty — the writer no longer creates the duplicate it used to report",
      doc.duplicates.length === 0);
    const diskHash = crypto.createHash("sha1").update(fs.readFileSync(path.join(dir, "assets", "Ellipse_2327.svg"))).digest("hex");
    ok("[content-dedup] both manifest rows carry the hash of the ONE file on disk",
      doc.files.every((f) => f.hash === diskHash));
  }
  {
    // The drifted arrow-down pair (real fixture, ≤0.002px apart) handed to writeAssets under two
    // DIFFERENT names — the shape a same-run plugin `byName` suffix or two different screens' pulls
    // produce. Must still collapse to one file via the SAME content-independent-of-name path (SVG
    // normalisation applies here too, not just byte-identical content like the Ellipse_2327 case).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-content-dedup-drift-"));
    const svgA = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "livetest3", "arrow-down", "arrow-down-3ea6be.svg"), "utf8");
    const svgB = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "livetest3", "arrow-down", "arrow-down-ccfd6b.svg"), "utf8");
    const a1 = asset({ id: "n1", file: "assets/arrow-down-3ea6be.svg", text: svgA, hash: "cccccccc-1" });
    writeOut.writeAssets(dir, [a1]);
    const a2 = asset({ id: "n2", file: "assets/arrow-down-ccfd6b.svg", text: svgB, hash: "dddddddd-1" });
    writeOut.writeAssets(dir, [a2]);
    const onDisk = fs.readdirSync(path.join(dir, "assets"));
    ok("[content-dedup] the real drifted arrow-down pair, under two different names, still collapses to ONE file",
      onDisk.length === 1 && a2.file === a1.file);
  }
  {
    // Genuinely NEW content must still get written — this fix must not turn writeAssets into a
    // no-op for real new icons.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-content-dedup-new-"));
    writeOut.writeAssets(dir, [asset({ id: "n1", file: "assets/a.svg", text: "<svg>A</svg>", hash: "e1e1e1e1-1" })]);
    writeOut.writeAssets(dir, [asset({ id: "n2", file: "assets/b.svg", text: "<svg>B</svg>", hash: "f2f2f2f2-1" })]);
    ok("[content-dedup] genuinely different content is still written as two files",
      fs.readdirSync(path.join(dir, "assets")).length === 2);
  }
  {
    // Live evidence from a real pull: a near-zero coordinate came back as
    // `2.09808e-05` in one export and `-0.000406265` in another, for what is otherwise the identical
    // path — the old regex (`-?\d+\.\d+`, no exponent) only replaced the `2.09808` mantissa, leaving a
    // corrupted `2.1e-05` fragment that could never match the plain-decimal form's normalised `0.0`.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-content-dedup-sci-"));
    const svgSci = '<svg width="18" height="10"><path d="M2.09808e-05 8.61087C8.2016e-05 8.61087"/></svg>';
    const svgPlain = '<svg width="18" height="10"><path d="M-0.000406265 8.61087C0.0000821 8.61087"/></svg>';
    const a1 = asset({ id: "n1", file: "assets/angle-left-a.svg", text: svgSci, hash: "aaaaaaaa-2" });
    writeOut.writeAssets(dir, [a1]);
    const a2 = asset({ id: "n2", file: "assets/angle-left-b.svg", text: svgPlain, hash: "bbbbbbbb-2" });
    writeOut.writeAssets(dir, [a2]);
    ok("[content-dedup] scientific-notation and plain-decimal near-zero coordinates normalise the same way",
      fs.readdirSync(path.join(dir, "assets")).length === 1 && a2.file === a1.file);
  }
  {
    // the whole-frame reference PNG must not inflate the screen's shippable asset totals.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-refasset-"));
    fs.mkdirSync(path.join(dir, "pages", "P"), { recursive: true });
    const icon = asset({ id: "i1", file: "assets/icon.svg", text: "<svg></svg>", hash: "cccccccc-1" });
    const ref = asset({ id: "n1:ref", file: "assets/n1_ref.png", base64: Buffer.from("x".repeat(1000)).toString("base64"), hash: "dddddddd-1", kind: "reference" });
    writeOut.writeAssets(dir, [icon, ref]);
    writeOut.writeScreenAssets(dir, screenPaths({ screenName: "Screen", page: "P" }, "/"), [icon, ref]);
    const doc = JSON.parse(fs.readFileSync(path.join(dir, "pages", "P", "Screen.assets.json"), "utf8")) as ScreenAssetsDoc;
    ok("[ref-asset] the reference PNG is not counted in `count`/`totalBytes`", doc.count === 1 && doc.totalBytes === (icon.text ?? "").length);
    ok("[ref-asset] the reference PNG still gets a manifest row, under `reference`", Array.isArray(doc.reference) && doc.reference.length === 1);
  }
  {
    // a screen with geometry fallbacks is flagged at pull time. Every fallback
    // left after the plugin stopped exporting hidden graphics is a real degraded vector, so ANY count warns —
    // the old 10 % threshold (and its "a low ratio produces nothing" case) is gone on purpose.
    ok("[geometry-warn] a 40% geometry-fallback ratio produces a warning",
      /^warn {2}40 of 100 node\(s\) fell back to raw geometry/.test(writeOut.assetsGeometryWarning({ nodes: 100, assetsGeometry: 40 }) ?? ""));
    ok("[geometry-warn] a low ratio warns too (every fallback)",
      /^warn {2}2 of 100 node\(s\) fell back to raw geometry/.test(writeOut.assetsGeometryWarning({ nodes: 100, assetsGeometry: 2 }) ?? ""));
    ok("[geometry-warn] no fallback produces nothing",
      writeOut.assetsGeometryWarning({ nodes: 100, assetsGeometry: 0 }) === null && writeOut.assetsGeometryWarning({ nodes: 100 }) === null);
  }
  {
    // Criterion 10, end to end: writeScreen() itself must surface the warning through `log` — not just
    // the standalone helper — since that is what a real `dtwin pull` actually calls.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-geo-e2e-"));
    const r = screenReply({
      screenName: "Icons",
      screen: {
        exportedAt: "2026-01-01T00:00:00Z",
        screen: "Icons",
        nodes: [{ id: "1:1", type: "FRAME", name: "Icons" }],
        manifest: { nodes: 100, assetsGeometry: 40 },
      },
    });
    const lines: string[] = [];
    writeOut.writeScreen(dir, r, (m) => lines.push(m));
    ok("[geometry-warn] writeScreen() logs the geometry-fallback warning at pull time",
      lines.some((l) => /assetsGeometry|fell back to raw geometry/.test(l)));
  }

  // ---------------------------------------------------------------- design-diff.js asset-hash tolerance
  console.log("\ndesign-diff.js — SVG re-export noise tolerance, on the REAL arrow-down*.svg fixtures:");
  {
    const diffMod = await import("../design-to-code/design-diff.ts");
    const dirFix = path.join(import.meta.dirname, "fixtures", "livetest3", "arrow-down");
    const read = (f: string) => fs.readFileSync(path.join(dirFix, f), "utf8");
    // Same setup redrawnAssets() actually runs: ONE node, ONE asset path, on-disk bytes that change
    // between "prev" (a snapshot's recorded hash) and "now" (the current export's file). A real re-pull
    // of an unchanged icon looks exactly like this — same node id, same asset path, only the SVG bytes
    // differ because Figma's exporter re-rounded some coordinates.
    const docFor = () => ({ name: "root", id: "1:1", exportedAt: "2026-01-01T00:00:00Z", tree: { id: "1:1", type: "FRAME", name: "root", asset: "assets/arrow-down.svg", children: [] } });
    const setup = (nowContent: string) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-svgnorm-"));
      fs.mkdirSync(path.join(root, "assets"));
      const file = path.join(root, "screen.json");
      fs.writeFileSync(path.join(root, "assets", "arrow-down.svg"), nowContent);
      return { file, root };
    };
    // Build the "prev" hash from one variant's real bytes, then diff against the doc whose on-disk
    // bytes are a DIFFERENT variant's — exactly redrawnAssets()'s contract.
    const prevFor = (content: string) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-svgnorm-prev-"));
      const prevAssetPath = path.join(tmp, "assets"); fs.mkdirSync(prevAssetPath);
      fs.writeFileSync(path.join(prevAssetPath, "arrow-down.svg"), content);
      const { hashes } = diffMod.assetHashes(path.join(tmp, "screen.json"), docFor());
      const prev: Baseline = { doc: docFor(), source: "screen.json.snapshot", kind: "snapshot", assets: hashes, notes: [] };
      return prev;
    };
    const now3ea6be = setup(read("arrow-down-3ea6be.svg"));
    // 3ea6be and ccfd6b are the SAME icon (≤0.002px drift) — must NOT be
    // reported as redrawn.
    const prevSame = prevFor(read("arrow-down-ccfd6b.svg"));
    const redrawnSame = diffMod.redrawnAssets(now3ea6be.file, docFor(), prevSame, now3ea6be.root);
    ok("[svg-tolerance] two exports of the SAME icon (sub-0.002px drift) are NOT reported as redrawn",
      redrawnSame.size === 0);
    // 3ea6be (14x14, white, 1.5 stroke) vs 31f462 (16x16, #F6F6F6, 1.2 stroke) ARE genuinely different
    // icons and must still be caught as a real redraw even after normalisation.
    const prevDiff = prevFor(read("arrow-down-31f462.svg"));
    const redrawnDiff = diffMod.redrawnAssets(now3ea6be.file, docFor(), prevDiff, now3ea6be.root);
    ok("[svg-tolerance] two genuinely DIFFERENT icons are still reported as redrawn",
      redrawnDiff.has("assets/arrow-down.svg"));
    // The end-to-end case the acceptance criteria name directly: a byte-identical re-pull of the SAME
    // file (no design change at all) reports zero changed assets.
    const prevIdentical = prevFor(read("arrow-down-3ea6be.svg"));
    const redrawnIdentical = diffMod.redrawnAssets(now3ea6be.file, docFor(), prevIdentical, now3ea6be.root);
    ok("[svg-tolerance] a byte-identical re-pull reports zero redrawn assets", redrawnIdentical.size === 0);
  }

  // ---------- the tree names the asset files actually written ----------
  // writeAssets reuses a byte-identical file already on disk under another name and version-suffixes a
  // same-name (or same-name-but-case) different file. The screen JSON used to be written BEFORE that, with
  // the plugin's own names, so nodes pointed at files never written — or, on a case-insensitive disk, at a
  // different icon — and the index's `reference` at a thumbnail that held the plain name. Fixtures use the
  // PLUGIN's shape: `Asset.file` is the bare name, the tree's pointer is `assets/<name>` (assets.ts
  // register()). Invented names.
  {
    const dt = await import("../bridge/src/write-out.ts");
    // A minimal PNG: signature + IHDR (w, h) — enough for writeScreen's size read; `tag` varies the bytes.
    const png = (w: number, h: number, tag: number): Buffer => {
      const b = Buffer.alloc(33);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
      b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[32] = tag;
      return b;
    };
    const exactExists = (dir: string, rel: string): boolean => {
      try { return fs.readdirSync(path.join(dir, path.dirname(rel))).includes(path.basename(rel)); } catch { return false; }
    };
    const pointers = (tree: unknown): string[] => {
      const out: string[] = [];
      const visit = (v: unknown): void => {
        if (!v || typeof v !== "object") return;
        if (Array.isArray(v)) { v.forEach(visit); return; }
        for (const [k, val] of Object.entries(v)) (k === "asset" || k === "reference") && typeof val === "string" ? out.push(val) : visit(val);
      };
      visit(tree);
      return out;
    };
    const ddir = fs.mkdtempSync(path.join(os.tmpdir(), "write-asset-ptrs-"));
    const adir = path.join(ddir, "assets");
    fs.mkdirSync(adir, { recursive: true });
    // Already on disk from an earlier pull: a chevron under the LOWER-case name (different glyph), a dot
    // under its plain name (same bytes the plugin will send under a suffixed name), and a discovery
    // thumbnail holding the frame's reference slot.
    fs.writeFileSync(path.join(adir, "chevron-left.svg"), '<svg viewBox="0 0 18 10"><path d="M0 0L9 10L18 0"/></svg>');
    const dot = '<svg viewBox="0 0 8 8"><circle cx="4" cy="4" r="4"/></svg>';
    fs.writeFileSync(path.join(adir, "Dot.svg"), dot);
    fs.writeFileSync(path.join(adir, "9_1_ref.png"), png(360, 309, 1));
    const logged: string[] = [];
    dt.writeScreen(ddir, screenReply({
      screenName: "Screen A", nodeId: "9:1", page: "Page A", pageId: "1:1",
      screen: {
        screen: "Screen A", exportedAt: "2026-09-30T00:00:00.000Z", manifest: { nodes: 3 },
        nodes: [{
          id: "9:1", type: "FRAME", name: "Screen A", reference: "assets/9_1_ref.png",
          box: { x: 100, y: 50, w: 100, h: 50 }, renderBox: { x: 79, y: 49, w: 142, h: 52 },
          children: [
            { id: "9:2", type: "VECTOR", name: "Chevron-left", asset: "assets/Chevron-left.svg" },
            { id: "9:3", type: "ELLIPSE", name: "Dot", asset: "assets/Dot-1a2b3c.svg" },
          ],
        }],
      },
      assets: [
        { id: "9:1:ref", name: "Screen A (reference)", format: "png", file: "9_1_ref.png", base64: png(284, 104, 2).toString("base64"), kind: "reference" },
        { id: "9:2", name: "Chevron-left", format: "svg", file: "Chevron-left.svg", text: '<svg viewBox="0 0 10 18"><path d="M10 0L0 9L10 18"/></svg>' },
        { id: "9:3", name: "Dot", format: "svg", file: "Dot-1a2b3c.svg", text: dot },
      ],
    }), (m) => logged.push(m));
    const screenFile = path.join(ddir, "pages", "Page_A", "Screen_A__9_1.json");
    const written = JSON.parse(fs.readFileSync(screenFile, "utf8")) as ScreenExport;
    const ptrs = pointers(written.nodes);
    const manifestFiles = JSON.parse(fs.readFileSync(path.join(ddir, "pages", "Page_A", "Screen_A__9_1.assets.json"), "utf8")) as { files: Array<{ file: string }>; reference?: Array<{ file: string }> };
    const listed = new Set([...manifestFiles.files, ...(manifestFiles.reference || [])].map((f) => f.file));
    ok("every asset/reference pointer in the written screen JSON names a file on disk (exact case)",
      ptrs.length === 3 && ptrs.every((p) => exactExists(ddir, p)));
    ok("…and the same file .assets.json lists", ptrs.every((p) => listed.has(p)));
    const kids = written.nodes[0]?.children ?? [];
    ok("a content-identical asset points at the file already on disk (Dot.svg), not the plugin's suffixed name",
      kids[1]?.asset === "assets/Dot.svg");
    ok("a same-name-but-case different glyph gets its own file, and the node points at IT — never at the lower-case chevron",
      typeof kids[0]?.asset === "string" && kids[0].asset !== "assets/Chevron-left.svg" && kids[0].asset !== "assets/chevron-left.svg" &&
      fs.readFileSync(path.join(ddir, kids[0].asset), "utf8").includes("M10 0L0 9L10 18"));
    const rootRow = must((JSON.parse(fs.readFileSync(path.join(ddir, "pages", "index.json"), "utf8")) as PagesRootIndex).layers?.[0], "root row");
    const refFile = must(rootRow.reference, "rootRow.reference");
    const refPng = fs.readFileSync(path.join(ddir, refFile));
    ok("the index row's reference is the full-size render this pull wrote, not the thumbnail that held the plain name",
      refFile !== "assets/9_1_ref.png" && refPng.readUInt32BE(16) === 284 && written.nodes[0]?.reference === refFile);
    ok("the index row records the reference's scale and its offset from the box (render bounds include the shadow)",
      rootRow.referenceScale === 2 && rootRow.referenceOffset?.x === -21 && rootRow.referenceOffset?.y === -1);
    ok("the pull says it rewired pointers, and reports no dangling pointer", logged.some((m) => /rewired 3 asset pointer/.test(m)) && !logged.some((m) => /not on disk/.test(m)));

    // A discovery thumbnail at an explicit scale never takes the reference slot.
    const sh = fs.mkdtempSync(path.join(os.tmpdir(), "write-shot-"));
    const shot = dt.writeScreenshot(sh, { id: "9:1", name: "Screen A", type: "FRAME", reference: "assets/9_1_ref.png", manifest: manifest({ nodes: 1 }),
      assets: [{ id: "9:1:ref", name: "Screen A (reference)", format: "png", file: "9_1_ref.png", base64: png(90, 77, 3).toString("base64"), kind: "reference" }] }, undefined, { scale: 0.25 });
    ok("a screenshot at an explicit --scale is written as <id>_shot@<scale>x.png and leaves <id>_ref.png free",
      shot.reference === "assets/9_1_shot@0.25x.png" && exactExists(sh, "assets/9_1_shot@0.25x.png") && !exactExists(sh, "assets/9_1_ref.png"));
    const sh2 = fs.mkdtempSync(path.join(os.tmpdir(), "write-shot2-"));
    const shot2 = dt.writeScreenshot(sh2, { id: "9:1", name: "Screen A", type: "FRAME", reference: "assets/9_1_ref.png", manifest: manifest({ nodes: 1 }),
      assets: [{ id: "9:1:ref", name: "Screen A (reference)", format: "png", file: "9_1_ref.png", base64: png(284, 104, 4).toString("base64"), kind: "reference" }] }, undefined);
    ok("a default-scale screenshot keeps the shared <id>_ref.png name (a later pull reuses the same render)", shot2.reference === "assets/9_1_ref.png");

    // A page walk: the layer files are written after the assets, with rewired pointers too.
    const pw = fs.mkdtempSync(path.join(os.tmpdir(), "write-walk-"));
    fs.mkdirSync(path.join(pw, "assets"), { recursive: true });
    fs.writeFileSync(path.join(pw, "assets", "Dot.svg"), dot);
    dt.writeExport(pw, {
      designSystem: { variables: [], collections: [], components: [] },
      layersDoc: {
        layers: [{ id: "9:1", name: "Screen A", page: "Page A", pageId: "1:1", tree: node({ id: "9:1", type: "FRAME", name: "Screen A", children: [{ id: "9:3", type: "ELLIPSE", name: "Dot", asset: "assets/Dot-1a2b3c.svg" }] }) }],
        index: [{ id: "9:1", name: "Screen A", type: "FRAME", page: "Page A", pageId: "1:1" }],
      },
      assets: [{ id: "9:3", name: "Dot", format: "svg", file: "Dot-1a2b3c.svg", text: dot }],
    }, undefined);
    const walkFiles = fs.readdirSync(path.join(pw, "pages"), { recursive: true }).map(String).filter((f) => f.endsWith(".json") && !f.endsWith("index.json"));
    const walkPtrs = walkFiles.flatMap((f) => pointers(JSON.parse(fs.readFileSync(path.join(pw, "pages", f), "utf8")) as unknown));
    ok("a page walk's layer files also point at the file actually on disk", walkPtrs.length === 1 && walkPtrs[0] === "assets/Dot.svg" && exactExists(pw, "assets/Dot.svg"));
    // Two frames that render identically keep their OWN reference files (the plugin never dedups a
    // reference; one `reference` naming another frame's PNG is the confusion it exists to prevent).
    const twin = fs.mkdtempSync(path.join(os.tmpdir(), "write-twin-refs-"));
    const same = png(200, 100, 7).toString("base64");
    for (const id of ["9:5", "9:6"]) {
      const safeId = id.replace(":", "_");
      dt.writeScreen(twin, screenReply({
        screenName: "Twin " + safeId, nodeId: id, page: "Page A", pageId: "1:1",
        screen: { screen: "Twin " + safeId, manifest: { nodes: 1 }, nodes: [{ id, type: "FRAME", name: "Twin " + safeId, reference: `assets/${safeId}_ref.png`, box: { x: 0, y: 0, w: 100, h: 50 } }] },
        assets: [{ id: id + ":ref", name: "Twin (reference)", format: "png", file: `${safeId}_ref.png`, base64: same, kind: "reference" }],
      }), undefined);
    }
    const twinRows = (JSON.parse(fs.readFileSync(path.join(twin, "pages", "index.json"), "utf8")) as PagesRootIndex).layers ?? [];
    ok("two identical-looking frames keep their own <id>_ref.png — a reference is never shared across frames",
      twinRows.length === 2 && twinRows.some((r) => r.reference === "assets/9_5_ref.png") && twinRows.some((r) => r.reference === "assets/9_6_ref.png") &&
      exactExists(twin, "assets/9_5_ref.png") && exactExists(twin, "assets/9_6_ref.png"));
    ok("a default-scale screenshot followed by the pull's identical render reuses the one file (no suffixed copy)", (() => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "write-shot-then-pull-"));
      const bytes = png(284, 104, 9).toString("base64");
      dt.writeScreenshot(d, { id: "9:7", name: "Screen B", type: "FRAME", reference: "assets/9_7_ref.png", manifest: manifest({ nodes: 1 }),
        assets: [{ id: "9:7:ref", name: "Screen B (reference)", format: "png", file: "9_7_ref.png", base64: bytes, kind: "reference" }] }, undefined);
      dt.writeScreen(d, screenReply({ screenName: "Screen B", nodeId: "9:7", page: "Page A", pageId: "1:1",
        screen: { screen: "Screen B", manifest: { nodes: 1 }, nodes: [{ id: "9:7", type: "FRAME", name: "Screen B", reference: "assets/9_7_ref.png", box: { x: 0, y: 0, w: 142, h: 52 } }] },
        assets: [{ id: "9:7:ref", name: "Screen B (reference)", format: "png", file: "9_7_ref.png", base64: bytes, kind: "reference" }] }), undefined);
      const files = fs.readdirSync(path.join(d, "assets"));
      fs.rmSync(d, { recursive: true, force: true });
      return files.length === 1 && files[0] === "9_7_ref.png";
    })());
    // Re-pulls over a reference name that holds OTHER bytes (an old thumbnail): the first pull writes one
    // suffixed copy, every later pull of the same render reuses it — never `_1`, `_2`, ….
    const again = fs.mkdtempSync(path.join(os.tmpdir(), "write-repull-"));
    fs.mkdirSync(path.join(again, "assets"));
    fs.writeFileSync(path.join(again, "assets", "9_9_ref.png"), png(90, 77, 11));
    const render = png(284, 104, 12).toString("base64");
    const pullOnce = () => dt.writeScreen(again, screenReply({ screenName: "Screen C", nodeId: "9:9", page: "Page A", pageId: "1:1",
      screen: { screen: "Screen C", manifest: { nodes: 1 }, nodes: [{ id: "9:9", type: "FRAME", name: "Screen C", reference: "assets/9_9_ref.png", box: { x: 0, y: 0, w: 142, h: 52 } }] },
      assets: [{ id: "9:9:ref", name: "Screen C (reference)", format: "png", file: "9_9_ref.png", base64: render, kind: "reference" }] }), undefined);
    pullOnce(); pullOnce(); pullOnce();
    const walkOnce = () => dt.writeExport(again, {
      designSystem: { variables: [], collections: [], components: [] },
      layersDoc: { layers: [{ id: "9:9", name: "Screen C", page: "Page A", pageId: "1:1", reference: "assets/9_9_ref.png", tree: node({ id: "9:9", type: "FRAME", name: "Screen C" }) }], index: [{ id: "9:9", name: "Screen C", type: "FRAME", page: "Page A", pageId: "1:1" }] },
      assets: [{ id: "9:9:ref", name: "Screen C (reference)", format: "png", file: "9_9_ref.png", base64: render, kind: "reference" }],
    }, undefined);
    walkOnce(); walkOnce();
    const refFiles = fs.readdirSync(path.join(again, "assets")).filter((f) => f.startsWith("9_9_ref")).sort();
    ok("three pulls and two page walks of an unchanged frame over an old thumbnail leave exactly ONE extra reference file",
      refFiles.length === 2 && refFiles.includes("9_9_ref.png") && refFiles.some((f) => /^9_9_ref-[0-9a-z]{6}\.png$/.test(f)));
    const shotsDir = fs.mkdtempSync(path.join(os.tmpdir(), "write-reshoot-"));
    fs.mkdirSync(path.join(shotsDir, "assets"));
    fs.writeFileSync(path.join(shotsDir, "assets", "9_9_shot@0.25x.png"), png(20, 10, 13));
    const thumb = { id: "9:9", name: "Screen C", type: "FRAME", reference: "assets/9_9_ref.png", manifest: manifest({ nodes: 1 }),
      assets: [{ id: "9:9:ref", name: "Screen C (reference)", format: "png" as const, file: "9_9_ref.png", base64: png(36, 13, 14).toString("base64"), kind: "reference" as const }] };
    dt.writeScreenshot(shotsDir, structuredClone(thumb), undefined, { scale: 0.25 });
    dt.writeScreenshot(shotsDir, structuredClone(thumb), undefined, { scale: 0.25 });
    ok("re-shooting the same thumbnail over a stale one adds one file, not one per shot",
      fs.readdirSync(path.join(shotsDir, "assets")).length === 2);
    for (const d of [ddir, sh, sh2, pw, twin, again, shotsDir]) fs.rmSync(d, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- write-out
  // RP-*: assertInsideCwd accepts a path that is inside the server's cwd once symlinks are resolved (macOS
  // /tmp → /private/tmp: getcwd() is resolved, a path built from PWD or os.tmpdir() is not), and still
  // refuses one whose REAL location is outside. Each test makes its own symlink, so it fails before the fix
  // on every platform, not just macOS.
  // PREV-*: the MCP server's implicit spill (keepPrev) keeps a one-level `<file>.prev` for every JSON it
  // replaces with different content (stamps ignored); the CLI path (keepPrev omitted) keeps nothing.
  {
    const W = await import("../bridge/src/write-out.ts");
    const real = (p: string) => fs.realpathSync.native(p);
    const proj = real(fs.mkdtempSync(path.join(os.tmpdir(), "g20-proj-")));
    const elsewhere = real(fs.mkdtempSync(path.join(os.tmpdir(), "g20-out-")));
    const links = fs.mkdtempSync(path.join(os.tmpdir(), "g20-links-"));
    const alias = path.join(links, "alias"); // -> the project (cwd)
    const alias2 = path.join(links, "alias2"); // -> a directory OUTSIDE the project
    fs.symlinkSync(proj, alias, "dir");
    fs.symlinkSync(elsewhere, alias2, "dir");
    const was = process.cwd();
    const throwsMsg = (f: () => unknown): string | null => { try { f(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); } };
    try {
      process.chdir(proj);
      let got: string | null = null;
      const err = throwsMsg(() => { got = W.assertInsideCwd(path.join(alias, "design")); });
      ok("an outDir reaching the cwd through a symlink is accepted (inside after realpath)", err === null);
      ok("and the returned path is the lexical one (no `..` steering after the link)", got === path.join(alias, "design"));
      ok("a nested not-yet-existing path under the alias is accepted (realpath of the existing prefix)",
        throwsMsg(() => W.assertInsideCwd(path.join(alias, "a", "b", "c"))) === null && !fs.existsSync(path.join(proj, "a")));
      ok("`../x` is still refused", throwsMsg(() => W.assertInsideCwd("../x")) !== null);
      ok("`/` is still refused", throwsMsg(() => W.assertInsideCwd("/")) !== null);
      const esc = throwsMsg(() => W.assertInsideCwd(path.join(alias2, "x")));
      ok("a symlink to a directory OUTSIDE the cwd is refused", esc !== null);
      ok("and the refusal names the real path it resolved to",
        esc !== null && esc.includes("real path " + path.join(elsewhere, "x")));
      ok("a symlink escape with a non-existent tail is refused too",
        throwsMsg(() => W.assertInsideCwd(path.join(alias2, "p", "q"))) !== null);
      ok("`<alias>/../alias2/x` is refused (resolved lexically first)",
        throwsMsg(() => W.assertInsideCwd(path.join(alias, "..", "alias2", "x"))) !== null);
      ok("the argument name still leads the message",
        (throwsMsg(() => W.assertInsideCwd("../x", "exportDir")) ?? "").startsWith("exportDir must stay inside"));
    } finally {
      process.chdir(was);
    }
    // a server started in the filesystem root (some MCP hosts launch stdio servers in `/`) accepts no
    // path below it — every path is lexically "inside" `/`, so the ordinary rule would accept them all.
    try {
      const fsRoot = path.parse(process.cwd()).root;
      process.chdir(fsRoot);
      const absElsewhere = throwsMsg(() => W.assertInsideCwd(path.join(elsewhere, "x")));
      ok("cwd = the filesystem root → an absolute outDir anywhere is refused", absElsewhere !== null);
      ok("…and so is a relative map path (etc/hosts)", throwsMsg(() => W.assertInsideCwd(path.join("etc", "hosts"), "map")) !== null);
      ok("…through a symlink too (realpath does not reopen it)", throwsMsg(() => W.assertInsideCwd(path.join(alias, "design"))) !== null);
      ok("…the root itself is still accepted, as it always was", throwsMsg(() => W.assertInsideCwd(fsRoot)) === null);
      ok("…and the refusal says to start the server in the project",
        absElsewhere !== null && absElsewhere.includes("started in the filesystem root"));
    } finally {
      process.chdir(was);
    }

    // A full reply built fresh per call (writeExport stamps sourceFile onto layersDoc in place).
    const fullReply = (stamp: string, label = "Go") => ({
      designSystem: {
        file: "Sample File", exportedAt: stamp, colorProfile: "srgb" as const,
        collections: [collection({ name: "Core", modes: ["Light"] })],
        variables: [variable({ name: "color/bg", type: "COLOR", values: { Light: "#ffffff" } })],
        styles: { paint: [{ name: "Brand" }], text: [], effect: [], grid: [] },
        components: [{ key: "k1", name: "Widget", type: "COMPONENT" as const, id: "2:1", page: "Page A", pageId: "1:0" }],
        hygiene: [],
      },
      layersDoc: {
        exportedAt: stamp,
        index: [{ id: "1:2", name: "Panel", type: "FRAME", pageId: "1:0", page: "Page A" }, { id: "1:5", name: "Sheet", type: "FRAME", pageId: "1:0", page: "Page A" }],
        layers: [
          { id: "1:2", name: "Panel", page: "Page A", pageId: "1:0", tree: node({ type: "FRAME", id: "1:2", name: "Panel", children: [node({ type: "TEXT", id: "1:3", name: label })] }) },
          { id: "1:5", name: "Sheet", page: "Page A", pageId: "1:0", tree: node({ type: "FRAME", id: "1:5", name: "Sheet" }) },
        ],
      },
      assets: [],
    });
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const readOr = (f: string): string | null => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
    const prevs = (d: string) => walk(d).filter((f) => f.endsWith(".prev")).sort();
    const pdir = fs.mkdtempSync(path.join(os.tmpdir(), "g20-prev-"));
    const out = path.join(pdir, "design");
    type Wrote = { prevKept?: string[] };
    // prevKept is checked at runtime, not taken on the declared type's word (a non-array fails the test).
    const { isStringArray } = await import("../bridge/src/json-util.ts");
    const wroteOf = (r: { wrote: object }): Wrote => {
      const raw: unknown = "prevKept" in r.wrote ? r.wrote.prevKept : undefined;
      if (raw === undefined) return {};
      if (!isStringArray(raw)) { ok(`wrote.prevKept is a string[] when present (got ${JSON.stringify(raw)})`, false); return {}; }
      return { prevKept: raw };
    };
    const first = wroteOf(W.writeExport(out, fullReply("2026-10-01T00:00:00.000Z"), undefined, { keepPrev: true }));
    ok("a first spill into an empty dir keeps nothing (no field, no .prev)", first.prevKept === undefined && prevs(out).length === 0);
    const layerFile = walk(path.join(out, "pages")).find((f) => f.endsWith(".json") && !f.endsWith("index.json") && fs.readFileSync(f, "utf8").includes("\"Panel\""));
    const dsFile = walk(path.join(out, "design-system")).find((f) => f.endsWith(".json") && fs.readFileSync(f, "utf8").includes("color/bg"));
    ok("fixture: the layer file and a design-system file exist", !!layerFile && !!dsFile);
    const editedLayer = '{"hand":"edited layer"}';
    const editedDs = '{"hand":"edited tokens"}';
    if (layerFile) fs.writeFileSync(layerFile, editedLayer);
    if (dsFile) fs.writeFileSync(dsFile, editedDs);
    const second = wroteOf(W.writeExport(out, fullReply("2026-10-02T00:00:00.000Z"), undefined, { keepPrev: true }));
    const want = [layerFile + ".prev", dsFile + ".prev"].sort();
    ok("exactly the two changed files get a .prev, and wrote.prevKept lists them",
      JSON.stringify(prevs(out)) === JSON.stringify(want) && JSON.stringify([...(second.prevKept ?? [])].sort()) === JSON.stringify(want));
    ok("each .prev holds the text the spill replaced",
      readOr(layerFile + ".prev") === editedLayer && readOr(dsFile + ".prev") === editedDs);
    ok("prevKept paths are absolute", (second.prevKept ?? []).every((p) => path.isAbsolute(p)));
    const third = wroteOf(W.writeExport(out, fullReply("2026-10-03T00:00:00.000Z"), undefined, { keepPrev: true }));
    ok("the same design re-spilled with a fresh exportedAt keeps nothing new",
      third.prevKept === undefined && JSON.stringify(prevs(out)) === JSON.stringify(want));
    ok("and the earlier .prev files are untouched",
      readOr(layerFile + ".prev") === editedLayer && readOr(dsFile + ".prev") === editedDs);
    const anyDispatch = wroteOf(W.writeAny(out, fullReply("2026-10-04T00:00:00.000Z", "Stop"), undefined, { keepPrev: true }));
    ok("writeAny forwards keepPrev to a full export (a real design change → its layer file kept)",
      (anyDispatch.prevKept ?? []).includes(layerFile + ".prev") && (readOr(layerFile + ".prev") ?? "").includes("\"Go\""));
    for (const f of prevs(out)) fs.rmSync(f);
    if (layerFile) fs.writeFileSync(layerFile, editedLayer);
    const cli = wroteOf(W.writeExport(out, fullReply("2026-10-05T00:00:00.000Z"), undefined));
    const cliAny = wroteOf(W.writeAny(out, fullReply("2026-10-06T00:00:00.000Z", "Stop"), undefined, {}));
    ok("keepPrev omitted (the CLI path) keeps no .prev and reports no prevKept",
      prevs(out).length === 0 && cli.prevKept === undefined && cliAny.prevKept === undefined);

    // Libraries: the root index carries a fresh generatedAt and per-row exportedAt on every write.
    const libReply = (stamp: string, hex: string) => ({ designSystem: {
      file: "Sample Library", exportedAt: stamp, colorProfile: "srgb" as const,
      source: { role: "library" as const, libraryName: "Sample", fileKey: "QWERTYUI12345" },
      collections: [collection({ name: "Core", modes: ["Light"] })],
      variables: [variable({ name: "color/fg", type: "COLOR", values: { Light: hex } })],
      styles: { paint: [], text: [], effect: [], grid: [] }, components: [], hygiene: [],
    } });
    const lout = path.join(pdir, "lib");
    W.writeExport(lout, libReply("2026-10-01T00:00:00.000Z", "#000000"), undefined, { keepPrev: true });
    await new Promise((r) => setTimeout(r, 5)); // a different generatedAt
    const lib2 = wroteOf(W.writeExport(lout, libReply("2026-10-02T00:00:00.000Z", "#000000"), undefined, { keepPrev: true }));
    ok("an unchanged library re-spilled (fresh generatedAt + row exportedAt) keeps no .prev",
      lib2.prevKept === undefined && prevs(lout).length === 0);
    const lib3 = wroteOf(W.writeExport(lout, libReply("2026-10-03T00:00:00.000Z", "#111111"), undefined, { keepPrev: true }));
    ok("a changed library variable keeps the replaced library file(s), not the unchanged root index",
      (lib3.prevKept ?? []).length > 0 && prevs(lout).length === (lib3.prevKept ?? []).length &&
      !prevs(lout).some((f) => f === path.join(lout, "libraries", "index.json.prev")));
    for (const d of [proj, elsewhere, links, pdir]) fs.rmSync(d, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- hex colour (figma_write fill / color)
  {
    const { parseHexColor, HEX_COLOR_RE } = await import("../bridge/src/hex-color.ts");
    const near = (a: number | undefined, b: number): boolean => a !== undefined && Math.abs(a - b) < 1e-9;
    const rgb = parseHexColor("#ff8000");
    ok("[hex] #rrggbb parses to 0..1 channels with no alpha", near(rgb?.r, 1) && near(rgb?.g, 128 / 255) && near(rgb?.b, 0) && rgb?.a === undefined);
    const short = parseHexColor("#f0a");
    ok("[hex] #rgb doubles each digit", near(short?.r, 1) && near(short?.g, 0) && near(short?.b, 170 / 255) && short?.a === undefined);
    ok("[hex] #rgba and #rrggbbaa carry the alpha pair", near(parseHexColor("#f008")?.a, 136 / 255) && near(parseHexColor("#FF000080")?.a, 128 / 255));
    ok("[hex] upper and lower case both parse", near(parseHexColor("#ABCDEF")?.g, 205 / 255) && near(parseHexColor("#abcdef")?.g, 205 / 255));
    const rejected = ["red", "#red", "rreedd", "ff0000", "bad", "#12", "#12345", "#1234567", "#ggg", "#ff000g", "# ff0000", " #fff", "#fff ", "#fff\n", "", "#", "#ffff00ff0", "rgb(1,2,3)", "transparent"];
    ok("[hex] names, bare digits, wrong lengths, non-hex digits and stray whitespace are rejected: " + rejected.filter((v) => parseHexColor(v) !== null || HEX_COLOR_RE.test(v)).join("|"),
      rejected.every((v) => parseHexColor(v) === null && !HEX_COLOR_RE.test(v)));
    ok("[hex] a non-string is rejected", [undefined, null, 255, {}, ["#fff"]].every((v) => parseHexColor(v) === null));
  }

  // ---------------------------------------------------------------- report
  report();
})();
