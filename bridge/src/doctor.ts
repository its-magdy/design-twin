// `dtwin doctor` — one command that says what is wrong with the setup, and what to do about it.
//
// Every failure this tool has looks the same from the outside: a pull that waits and times out. The
// causes are not the same at all — no token, a token the plugin doesn't have, a port held by a
// forgotten daemon or by the MCP server, a plugin that isn't running, a stale export. Each check here
// names ONE of those, marks it ✓ / ! / ✗, and gives the single next step.
//
// Rules it keeps:
//   - NO side effects. It never mints or persists a token (tokenStore.status() resolves with
//     persist:false), never writes a file, and leaves nothing listening. So it is safe to run at any
//     moment, including while a daemon or the MCP server holds the port.
//   - It never opens a WebSocket to a port someone else holds: the bridge registers every WS client as
//     a PLUGIN client, so a probe would disturb routing for whoever owns that bridge (and a
//     wrong-token probe spams its log). A held port is identified with a plain HTTP GET instead — a
//     bridge answers 426 Upgrade Required.
//   - A bridge is only created once the port is known to be valid and free: createBridge exits the
//     process on EADDRINUSE, which is a finding for doctor to report, not a way for it to die.
//   - The settings are read ONCE, at the entry (main), and passed in with an observer: bridge-observer.ts, the
//     bridge holder's read-only lifetime, says who holds the bridge and whether a plugin is on it; run() only
//     words what it says (a suite passes a fake observer). server-core is loaded only by the observer's own
//     probe bridge; the one server-core helper doctor needs, daemonRowStalenessNote, lives in staleness.ts.
//
//   dtwin doctor            # human report; exit 1 only if a check is ✗
//   dtwin doctor --wait 30  # wait longer for the plugin to connect (default 10s)
//   dtwin doctor --json     # { ok, checks: [{ id, title, status, detail, next, skipped }] }

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tokenStore from "./token-store.ts";
import type { TokenStatus } from "./token-store.ts";
import type { DaemonStatusView } from "./daemon.ts";
import { readExportVerdict } from "./export-verdict.ts";
import type { ExportSource, ExportVerdict } from "./export-verdict.ts";
import { errMsg } from "./errmsg.ts";
import { ifDefined } from "./json-util.ts";
import * as LAYOUT from "./project-layout.ts";
import { isOurMcpEntry, mcpEntryProblems, PROFILES, readMcpJson } from "./init.ts";
import { daemonRowStalenessNote } from "./staleness.ts";
import { describeState, pluginState } from "./plugin-install.ts";
import type { PluginState } from "./plugin-install.ts";
// The manifest's allowedDomains ports and the FIGMA_BRIDGE_PORT parse — ports.ts, the same list and
// parse settings.ts reads the port with. A bad value is a finding here (the very case this exists to diagnose).
import { ALLOWED_PORTS, parsePortEnv } from "./ports.ts";
import { dtwinPortWarning } from "./verbs.ts";
// The package's own package.json, imported rather than read by a path at run time (so it resolves in a
// compiled binary too): engines.bun is the Bun version this install needs.
import pkg from "../package.json" with { type: "json" };
import type { ClientRow } from "./server-core.ts";
import { exitCli } from "./stdio.ts";
import { readSettings } from "./settings.ts";
import type { BridgeSettings, SettingsResult } from "./settings.ts";
import { bridgeObserver, probePlugin, probePort } from "./bridge-observer.ts";
import type { BadToken, BridgeObserver, PortProbe } from "./bridge-observer.ts";
import { presence } from "./presence.ts";
import { pasteToken, pickClient, runPlugin } from "./hints.ts";

/** Every check this report can carry, by id — what `--json` consumers key on. */
export type CheckId = "bun" | "token" | "daemon" | "port" | "plugin" | "plugin-files" | "project" | "profile" | "layout" | "export" | "map" | "mcp";

/** One line of the report. `next` is the single next step (absent, or undefined, when there is none). `skipped`: the
 *  check could not run (a warn), so nothing it would have verified was — the report is not ok beside one. */
export interface Check {
  id: CheckId;
  title: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  next?: string;
  skipped?: true;
}

export interface Report {
  ok: boolean;
  checks: Check[];
}

/** A connected-client row as doctor reads it — from this process's own probe bridge, or relayed by a
 *  daemon (possibly an older one whose rows lack newer fields). */
type ClientRowLike = Partial<ClientRow>;

/** What the observer's own probe bridge saw (bridge-observer.ts OwnView), or `{ skipped }` when it could not run
 *  (see checkPlugin). */
export interface PluginProbe {
  skipped?: string;
  next?: string;
  clients?: ClientRowLike[];
  badToken?: BadToken | null;
  expected?: string | null;
  error?: string;
}

const ok = (id: CheckId, title: string, detail: string): Check => ({ id, title, status: "ok", detail });
const warn = (id: CheckId, title: string, detail: string, next?: string): Check => ({ id, title, status: "warn", detail, ...ifDefined("next", next) });
const fail = (id: CheckId, title: string, detail: string, next?: string): Check => ({ id, title, status: "fail", detail, ...ifDefined("next", next) });

// ---------------------------------------------------------------- pure checks

// `version` is the running Bun (Bun.version — NOT process.version, which under Bun reports the Node.js
// release Bun is compatible with, e.g. v26.3.0, and says nothing about Bun itself). `range` is
// package.json's engines.bun, matched with Bun's own semver (Bun.semver.satisfies), so any range
// syntax the field can hold is understood. An absent or unreadable range is reported as unknown
// rather than guessed at — and "unreadable" is decided here, because Bun.semver.satisfies is lenient
// to a fault: a range with no version in it at all ("", "x", "not a range!") satisfies everything.
function checkBun(version: string, range: string | null | undefined): Check {
  const v = String(version).replace(/^v/, "");
  const unread = (): Check => warn("bun", "Bun", `${v} (could not read the required version from package.json)`);
  if (!range || !/\d+\.\d+/.test(range)) return unread();
  let satisfied: boolean;
  try { satisfied = Bun.semver.satisfies(v, range); } catch { return unread(); }
  if (satisfied) return ok("bun", "Bun", `${v} (needs ${range})`);
  return fail("bun", "Bun", `${v} is too old — this package needs ${range}`, "upgrade the way it was installed: `bun upgrade` (the official installer), `brew upgrade bun` (Homebrew), `npm install -g bun@latest` (npm), `scoop update bun` (Scoop) — or reinstall from https://bun.sh/install");
}

// `s` is tokenStore.status(). `pluginCheck` is the ALREADY-COMPUTED plugin check
// from later in run() — passed in only when `s.shadowed` is true, so the shadowed-token note can say
// what actually happened instead of a blanket "make sure the plugin has it": a connection succeeding
// under the overriding token IS the evidence it was accepted; a connection that never happened means
// this could not be checked at all, which is a different, more honest thing to say than "make sure".
// `viaDaemon` matters because a connection routed THROUGH an already-running daemon proves nothing
// about THIS process's token: the daemon authenticated the plugin once, at its own start, and every
// later command's socket auth is skipped — a bogus FIGMA_BRIDGE_TOKEN still shows "connected" there
// (`list clients` works and `doctor` says ok:true with a bogus token).
// Only a connection THIS process itself negotiated (no daemon in front) is real evidence either way.
function checkToken(s: TokenStatus, pluginCheck?: Check, viaDaemon?: boolean): Check {
  if (s.activeSource === "ephemeral") {
    return warn("token", "Bridge token", `none saved yet (${s.path} does not exist)`, "run `dtwin init` — or any pull: the first bridge start creates it and prints it once to paste into the plugin");
  }
  if (s.shadowed) {
    if (pluginCheck && pluginCheck.status === "ok" && !viaDaemon) {
      return ok("token", "Bridge token", `FIGMA_BRIDGE_TOKEN (${s.fingerprint}) OVERRIDES the saved token in ${s.path} — the plugin connected using it, so the override is working as intended`);
    }
    if (pluginCheck && pluginCheck.status === "fail" && /different token/.test(pluginCheck.detail || "")) {
      return fail("token", "Bridge token", `FIGMA_BRIDGE_TOKEN (${s.fingerprint}) OVERRIDES the saved token in ${s.path}, and the connected plugin rejected it`, "paste `dtwin --show-token`'s value into the plugin, or unset FIGMA_BRIDGE_TOKEN to go back to the saved token");
    }
    const why = viaDaemon
      ? "a running daemon already holds an authenticated connection, so this override was not exercised by this check"
      : pluginCheck && pluginCheck.detail ? `plugin: ${pluginCheck.detail}` : "no daemon/plugin reachable";
    return warn("token", "Bridge token", `FIGMA_BRIDGE_TOKEN (${s.fingerprint}) OVERRIDES the saved token in ${s.path} — whether the plugin accepts it could not be checked (${why})`, "make sure the plugin has the env var's token — or unset FIGMA_BRIDGE_TOKEN to go back to the saved one");
  }
  if (s.activeSource === "env") return ok("token", "Bridge token", `from FIGMA_BRIDGE_TOKEN (fingerprint ${s.fingerprint})`);
  if (s.loosePerms) return warn("token", "Bridge token", `saved in ${s.path} (fingerprint ${s.fingerprint}), but the file is readable by other users`, `chmod 600 ${s.path}`);
  return ok("token", "Bridge token", `saved in ${s.path} (fingerprint ${s.fingerprint})`);
}

const fileNames = (clients: ClientRowLike[] | null | undefined) => (clients || []).map((c) => c.file || "(unidentified)").join(", ");

// One bridge serves several Figma files at once (one client per open plugin window). With more than
// one connected, resolveClient() refuses any plugin-reaching command that doesn't say WHICH file —
// correct, but reporting both connections as a plain ✓ would let the next command's refusal
// come as a surprise. A connected-and-ambiguous bridge is healthy AND needs a flag;
// say both.
//
// Also surfaces a stale plugin bundle here — the ONE place doctor already reports which
// files are connected, so a version mismatch is seen in the same breath rather than needing a second
// command. `pluginStale` is computed server-side (server-core.ts's `describe()`), so doctor doesn't
// duplicate the version-compare logic; it just relays whichever client(s) are behind.
function connectedDetail(clients: ClientRowLike[] | null | undefined, prefix: string): { detail: string; next?: string } {
  // daemonRowStalenessNote comes from staleness.ts, NOT server-core: server-core is only loaded for the
  // plugin probe (this file's header), and staleness.ts is a plain static import.
  const detail = `${prefix}: ${fileNames(clients)}`;
  const stale = (clients || []).map((c) => c.pluginStale).filter((n): n is string => Boolean(n));
  // A row with no `pluginVersion` KEY at all (not merely a `null` value) means it came from a
  // `dtwin serve` daemon whose own `describe()` predates plugin-version reporting — a SEPARATE
  // staleness, distinct from "this Figma plugin's bundle is old": reloading the plugin will not fix it,
  // restarting the daemon will. `list clients`/`whoami` name it per-row (figma-pull.ts); doctor folds
  // it into this same summary line so it's never a silent gap here either.
  const daemonStale = [...new Set((clients || []).map(daemonRowStalenessNote).filter((n): n is string => Boolean(n)))];
  const list = clients ?? [];
  const ambiguous = presence(list).kind === "ambiguous";
  if (!ambiguous && !stale.length && !daemonStale.length) return { detail };
  const bits: string[] = [];
  if (ambiguous) bits.push(`${detail} — ${list.length} files, so commands must say which`);
  const nexts: string[] = [];
  if (ambiguous) nexts.push(`on every command that reaches the plugin, ${pickClient}`);
  if (stale.length) nexts.push(...new Set(stale));
  if (daemonStale.length) nexts.push(...daemonStale);
  return {
    detail: bits[0] ?? detail,
    ...(nexts.length ? { next: nexts.join("; ") } : {}),
  };
}

// `st` is daemon.status(at), at the address the settings resolve to: null when none is running. Without a daemon,
// every `dtwin pull` starts its own throwaway bridge and waits out the plugin's full reconnect window — the difference between
// an 8s pull and a 300s+ timeout, and `--client c1` becomes reconnect-order
// roulette instead of a stable id across a daemon's lifetime. That is a real cost, not a
// cosmetic one, so a missing daemon is reported `warn`, never `ok` — "optional" undersold it.
// `st` is read as DaemonStatusView: a daemon from an OLDER bridge may omit fields, which print as "?".
// `refused` is daemon.sockProblem(at): the socket location is not private to this user (or its path is too long
// for the platform), so no daemon can be started or reached there — every command still works, one-shot. A fail,
// not a warn: it is someone else's directory (or a loosened one) in the place this user's daemon would listen.
// `tokenNote` is sharedTokenNote(): on Windows the daemon's pipe is guarded by the token alone, and the
// token is read from somewhere other users can usually read — the line is demoted to a warning saying so
// (a refused location stays the fail it is).
function checkDaemon(st: DaemonStatusView | null | undefined, port: number, refused?: string | null, tokenNote?: string | null): Check {
  const base = daemonState(st, port, refused);
  if (!tokenNote || base.status === "fail") return base;
  return warn("daemon", "Daemon", `${base.detail} — but ${tokenNote}`,
    "keep the token under your profile — the default, %APPDATA%\\design-twin\\bridge-token, is — by unsetting FIGMA_BRIDGE_TOKEN_FILE / DESIGNTWIN_CONFIG_DIR (or pointing them inside your profile), then `dtwin --rotate-token`");
}

// On Windows the daemon's pipe can be opened by other users (its default security descriptor), and what
// keeps them out is the handshake — so the pipe is exactly as private as the token FILE. %APPDATA% is per-user
// by ACL; a file elsewhere (a --token-file / FIGMA_BRIDGE_TOKEN_FILE, or DESIGNTWIN_CONFIG_DIR, pointed at a
// shared folder or a directory under C:\) usually inherits read access for every user. Judged by path, under the
// profile or not: Bun cannot read a Windows ACL. Null off Windows (the socket's directory is the check there),
// for a token from the environment (no file), and for a file inside the profile.
function sharedTokenNote(file: string | null, profile: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== "win32" || !file || !profile) return null;
  const rel = path.win32.relative(path.win32.resolve(profile).toLowerCase(), path.win32.resolve(file).toLowerCase());
  if (rel !== "" && !rel.startsWith("..") && !path.win32.isAbsolute(rel)) return null;
  return `the bridge token is read from ${file}, outside your user profile (${profile}), and on Windows the daemon's pipe is only as private as that file: folders outside the profile are usually readable by other users`;
}

function daemonState(st: DaemonStatusView | null | undefined, port: number, refused?: string | null): Check {
  if (refused) {
    return fail(
      "daemon", "Daemon", refused,
      "remove that directory (if another user owns it, ask them or an admin), or set XDG_RUNTIME_DIR or TMPDIR to a directory only you can access (mode 0700) — until then `dtwin serve` refuses to start and every command runs without a daemon"
    );
  }
  if (!st) {
    return warn(
      "daemon", "Daemon",
      `none running on port ${port} — every pull will start its own bridge and wait out the plugin's reconnect window (this is what turns a normal export into a 300s+ timeout, and makes --client c1 unstable across runs)`,
      "run `dtwin serve` in a background terminal before pulling — it keeps one bridge alive so plugins stay connected between commands"
    );
  }
  const who = st.pluginConnected ? `plugin connected: ${fileNames(st.clients)}` : "no plugin connected to it";
  return ok("daemon", "Daemon", `running (pid ${st.pid ?? "?"}, port ${st.port ?? "?"}) — ${who}`);
}

// `raw` is FIGMA_BRIDGE_PORT. Returns { port } or { problem: <check> }.
function resolvePort(raw: string | undefined): { port: number; problem?: undefined } | { problem: Check; port?: undefined } {
  const parsed = parsePortEnv(raw);
  if (parsed.port !== undefined) return { port: parsed.port };
  return { problem: fail("port", "Port", `FIGMA_BRIDGE_PORT=${parsed.invalid} is not one of ${ALLOWED_PORTS.join(", ")} — the Figma plugin may only open sockets to ports named in its manifest, so nothing could ever connect`, `unset FIGMA_BRIDGE_PORT, or set it to one of ${ALLOWED_PORTS.join(", ")}`) };
}

// DT_TEST_EPHEMERAL_PORT is the suites' seam (server-core.ts createBridge): at "1" every bridge this shell starts binds a
// random port, which the Figma plugin — limited to the manifest's three — can never reach. Left exported in a shell, it
// reads exactly like "the plugin never connects"; say so before that hunt starts. Any other value is ignored by the
// bridge, but it is still a test variable that has escaped into a real environment.
function ephemeralPortWarning(env: NodeJS.ProcessEnv): Check | null {
  const v = env.DT_TEST_EPHEMERAL_PORT;
  if (v === undefined || v === "") return null;
  return warn("port", "Port", v === "1"
    ? "DT_TEST_EPHEMERAL_PORT=1 is set — a test-only seam: every bridge started from this environment binds a random port the Figma plugin can never reach"
    : `DT_TEST_EPHEMERAL_PORT=${JSON.stringify(v)} is set — a test-only variable (the bridge acts on it only at "1")`, "unset DT_TEST_EPHEMERAL_PORT");
}

// `probe` is probePort()'s result; `st` the daemon status for the same port; `envPort` the value of
// FIGMA_BRIDGE_PORT (a seam, so the wording is testable without touching process.env). The free line
// says how the port was chosen, because the override is otherwise undiscoverable.
function checkPort(port: number, probe: PortProbe, st: DaemonStatusView | null | undefined, envPort?: string | undefined): Check {
  if (probe.free) {
    const via = envPort ? `FIGMA_BRIDGE_PORT=${envPort}` : `default; FIGMA_BRIDGE_PORT selects ${ALLOWED_PORTS.filter((p) => p !== port).join("/")}`;
    return ok("port", "Port", `${port} is free (${via})`);
  }
  if (st) return ok("port", "Port", `${port} is held by the dtwin daemon (pid ${st.pid ?? "?"}) — pulls route through it`);
  const others = ALLOWED_PORTS.filter((p) => p !== port).join(" or ");
  if (probe.holder === "websocket") {
    return warn("port", "Port", `${port} is held by a WebSocket server that is not a dtwin daemon — most likely the Design Twin MCP server (Claude Code), or a pull still running`, `use the MCP tools (writeToDisk:true) while it runs, or stop it, or run this CLI on another port: FIGMA_BRIDGE_PORT=${others}`);
  }
  return fail("port", "Port", `${port} is held by another program (${probe.detail})`, `find it with \`lsof -i :${port}\` and stop it, or use FIGMA_BRIDGE_PORT=${others} — the plugin walks all three`);
}

// `r` is probePlugin()'s result, or { skipped } when it could not run.
function checkPlugin(r: PluginProbe, waitSec?: number): Check {
  const title = "Figma plugin";
  if (r.skipped) return { ...warn("plugin", title, `not checked — ${r.skipped}`, r.next), skipped: true };
  if (presence(r.clients ?? []).kind !== "none") {
    const c = connectedDetail(r.clients, "connected");
    // A stale plugin bundle IS a problem worth a warn, unlike the multi-client case (still `ok` — being
    // connected to several files at once is healthy, it just needs `--client`). Only staleness demotes
    // the status; an ambiguous-but-current multi-client connection stays `ok`.
    const stale = (r.clients ?? []).some((cl) => cl.pluginStale);
    return { id: "plugin", title, status: stale ? "warn" as const : "ok" as const, detail: c.detail, ...(c.next ? { next: c.next } : {}) };
  }
  if (r.badToken) {
    return fail("plugin", title, `a plugin IS running, but with a different token (fingerprint ${r.badToken.fingerprint || "none — its token field is empty"} vs expected ${r.expected})`, pasteToken);
  }
  if (r.error) return fail("plugin", title, `could not open a bridge to check: ${r.error}`);
  return fail("plugin", title, `no plugin connected within ${waitSec}s`, `${runPlugin}; \`--wait 30\` waits longer`);
}

const ageStr = (ms: number) => { const h = ms / 3600000; return h < 1 ? `${Math.max(0, Math.round(ms / 60000))} min` : h < 48 ? `${h.toFixed(1)}h` : `${Math.round(h / 24)} days`; };

// One source of the export (export-verdict.ts), said: whose screens, the design system, and how old each is.
function sourcePart(src: ExportSource): string {
  const age = src.ageMs !== undefined ? `${ageStr(src.ageMs)} ago`
    : src.problem === "unparseable" ? `exportedAt '${src.exportedAt}' is not a parseable timestamp` : "no stamp";
  const from = src.sourceFile !== null ? ` from '${src.sourceFile}'` : "";
  switch (src.kind) {
    case "screens": return src.sourceFile === null
      ? `${src.count} screen(s) (source not recorded — pulled by an older bridge; re-pull to stamp it)`
      : `${src.count} screen(s)${from} (newest ${age})`;
    case "design-system": return `design system${from} (${age})`;
    case "page-walk": return `page walk${from} (${age})`;
    case "screen-doc": return `screen '${src.sourceFile ?? path.basename(src.file ?? "")}' (${age})`;
  }
}

// The export lines: one summary (always the first "export" check), then one warn per file that is there but unusable.
// Every fact is the verdict's (export-verdict.ts) — which file each screen came from, the newest stamp, whether it is
// stale, why there is no age — so doctor and figma_status cannot disagree about the same export; this only words it.
function exportChecks(v: ExportVerdict, rel: string): Check[] {
  if (!v.exported) return [warn("export", "Export", `nothing exported yet (no design-system.json, pages/index.json or screen JSON in ${rel}/)`, "dtwin list   →   dtwin pull --node <id>   (or --page <name> / --design-system)")];
  const out: Check[] = [];
  let problems = v.problems.map((p) => `${p.file} ${p.error}`);
  if (!v.sources.length) {
    out.push(warn("export", "Export", problems[0] ?? "", "re-run the pull"));
    problems = problems.slice(1);
  } else if (v.unknownFreshness) {
    out.push(warn("export", "Export", v.unknownFreshness, "re-run the pull"));
  } else {
    const detail = v.sources.map(sourcePart).join(" + ");
    const mixed = v.mixed ? "the export mixes Figma files — /designtwin:audit-design's cross-file check says whether they are one system" : undefined;
    if (v.stale) out.push(warn("export", "Export", `${detail} — the Figma file may have moved on`, ["re-run the pull before building from it", mixed].filter(Boolean).join("; ")));
    else out.push({ ...ok("export", "Export", detail), ...ifDefined("next", mixed) });
  }
  for (const p of problems) out.push(warn("export", "Export", `${p} — left out of the export summary`, "re-run the pull that writes it (or fix the hand edit)"));
  return out;
}

// The profile build-screen, audit-design and sync-design will use: design/target.json's `profile` (a bundled one, or a
// custom stack written in design/profile.md), plus design/profile.md read after a bundled profile as the project's own
// rules. An older project's root profiles/<profile>.md is read the same way.
export const OVERLAY_FILE = path.join(LAYOUT.DESIGN_DIR, "profile.md");
// The plugin's files on disk (plugin-install.ts), not the running plugin: is there a per-user copy to import, and is it
// this dtwin's? Read only — doctor never installs or refreshes it. A note, never a failure: someone who imported from
// a clone or the package folder before is still working.
function checkPluginFiles(s: PluginState): Check {
  const d = describeState(s);
  return d.ok ? ok("plugin-files", "Plugin files", d.detail) : warn("plugin-files", "Plugin files", d.detail, d.next);
}

function checkProfile(cwd: string): Check {
  let profile: string | null = null;
  try {
    const doc: unknown = JSON.parse(fs.readFileSync(path.join(cwd, LAYOUT.TARGET_FILE), "utf8"));
    const p = doc && typeof doc === "object" ? (doc as { profile?: unknown }).profile : undefined;
    if (typeof p === "string" && p.trim()) profile = p.trim();
  } catch { /* unreadable or not JSON: no profile chosen */ }
  const overlay = fs.existsSync(path.join(cwd, OVERLAY_FILE));
  const legacy = profile !== null && fs.existsSync(path.join(cwd, "profiles", profile + ".md"));
  const extra = [overlay ? "design/profile.md (the project's rules, read after it)" : "", legacy ? `profiles/${profile}.md (older location, read the same way)` : ""].filter(Boolean).join(" + ");
  if (profile === null) return warn("profile", "Profile", "design/target.json names no profile yet", "build-screen asks on its first run, or set `profile` to one of " + PROFILES.join(", "));
  if (PROFILES.includes(profile)) return ok("profile", "Profile", `${profile} (bundled)${extra ? " + " + extra : ""}`);
  if (overlay || legacy) return ok("profile", "Profile", `${profile} (custom) — ${extra}`);
  return warn("profile", "Profile", `${profile} is not a bundled profile, and design/profile.md does not exist`,
    "write design/profile.md from the plugin's skills/build-screen/profiles/_template.md, or set `profile` to one of " + PROFILES.join(", "));
}

// Everything about the project in `cwd`. Several checks, none of them ✗: doctor is also run outside a
// project (to debug the connection), where all of this is legitimately absent.
function checkProject(cwd: string, now: number = Date.now()): Check[] {
  const out: Check[] = [];
  const designDir = path.join(cwd, LAYOUT.DESIGN_DIR);
  if (!fs.existsSync(designDir)) {
    out.push(warn("project", "Project", `no design/ in ${cwd}`, "run `dtwin init` in the root of the project you are building (skip this if you are only testing the connection)"));
  } else {
    const hasTarget = fs.existsSync(path.join(cwd, LAYOUT.TARGET_FILE));
    out.push(hasTarget ? ok("project", "Project", "design/ and design/target.json present") : warn("project", "Project", "design/ present, but no design/target.json", "run `dtwin init` (it detects the stack), or build-screen will ask on first run"));
    if (hasTarget) out.push(checkProfile(cwd));

    // Which layout this project uses, said out loud. A project created before the export/ split keeps
    // working, but "where do my files land" must never be a thing the user has to infer.
    const ex = LAYOUT.findExportDir(cwd);
    if (ex.layout === "legacy-flat") {
      out.push(warn("layout", "Layout", "this project uses the older flat layout — exports live directly in design/, beside your hand-owned target.json / plan / audit",
        "it keeps working as is. To adopt the current split, move the export into design/export/ (pages/, design-system/, assets/, variables.json, libraries/) so `rm -rf design/export` can never take your decisions with it"));
    } else if (ex.layout === "export-subdir" && ex.parallelLegacy) {
      // A stray `dtwin pull design ...` wrote a SECOND export tree directly under
      // design/ (design/pages/, design/assets/, design/variables.json, design/design-system/) beside
      // the real one at design/export/. Doctor reads only design/export/ below, so say so out loud —
      // silently picking one is exactly the trap this project is in.
      out.push(warn("layout", "Layout", `found BOTH layouts: reading ${ex.rel.split(path.sep).join("/")}/ (the current one), but design/pages/, design/assets/, design/variables.json and/or design/design-system/ ALSO exist beside it — a stray pull wrote a second, parallel export tree`,
        "the two trees can disagree (e.g. two different variables.json). Move anything real out of the stray design/pages, design/assets, design/variables.json, design/design-system into design/export/, then remove them — never `dtwin pull design ...` (that outDir already contains export/); use `dtwin pull --node <id>` etc."));
    }

    out.push(...exportChecks(readExportVerdict(ex.dir, now), ex.rel));

    const map = LAYOUT.findMapFile(cwd);
    out.push(
      map.missing
        ? warn("map", "Component map", `no ${LAYOUT.MAP_FILE} — builds cannot reuse your existing components yet`, "scaffold one after a pull: /designtwin:build-screen walks you through it")
        : map.legacy
          ? warn("map", "Component map", "codeconnect.local.json is at the repo root (the older location)", `it still works. Moving it to ${LAYOUT.MAP_FILE} keeps every hand-owned file in one place`)
          : ok("map", "Component map", `${LAYOUT.MAP_FILE} present`)
    );
  }

  const mcpFile = path.join(cwd, ".mcp.json");
  if (fs.existsSync(mcpFile)) {
    let servers: Record<string, unknown> | null = null;
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(mcpFile, "utf8")) as unknown; } catch (e) { out.push(warn("mcp", "MCP registration", ".mcp.json is not valid JSON: " + errMsg(e), "fix it, then `dtwin init --mcp`")); }
    if (raw !== undefined) {
      const r = readMcpJson(raw);
      if ("servers" in r) servers = r.servers;
      else out.push(warn("mcp", "MCP registration", ".mcp.json: " + r.error, "fix it, then `dtwin init --mcp`"));
    }
    if (servers) {
      const found = servers;
      const mine = Object.keys(found).find((k) => isOurMcpEntry(found[k]));
      // Registered, but it cannot start (init.ts mcpEntryProblems): Claude Code would show the server failed and offer no
      // tools, with nothing here to say why. A ✗, not a note — and init --mcp is the repair (it rewrites that entry).
      const broken = mine === undefined ? [] : mcpEntryProblems(found[mine], { cwd });
      if (!mine) out.push(ok("mcp", "MCP registration", "not registered in .mcp.json (optional — `dtwin init --mcp` adds it)"));
      else if (broken.length) out.push(fail("mcp", "MCP registration", `registered as "${mine}" in .mcp.json, but Claude Code cannot reliably start it as written: ${broken.join("; ")}`, "run `dtwin init --mcp` from the install you use — it rewrites that entry to this bun and its figma-mcp.ts — then restart Claude Code"));
      else if (mine === "designtwin") out.push(ok("mcp", "MCP registration", 'registered as "designtwin" in .mcp.json'));
      else out.push(warn("mcp", "MCP registration", `registered under the legacy key "${mine}" — it still works, but new setups use "designtwin" ("figma" collides with Figma's own MCP server)`, `rename the "${mine}" key in .mcp.json to "designtwin", then restart Claude Code`));
    }
  }
  return out;
}

// ---------------------------------------------------------------- run + report

// `onCheck` sees each result the moment it is known, and `onWait` fires before the one slow step (the
// plugin wait). Printing only at the end meant a caller with a short timeout — an agent shelling out —
// got NOTHING, not even the instant Bun/token answers, if the plugin wait outlived it.
// The rest are the dependencies, resolved once at the entry (main): `settings` (settings.ts readSettings, from
// `env`), the `observer` for them (bridge-observer.ts), the token's status (token-store.ts status) and the
// environment the warnings read. A suite passes fakes.
export interface RunOptions {
  cwd?: string;
  waitSec?: number;
  onCheck?: (c: Check) => void;
  onWait?: (sec: number) => void;
  settings: SettingsResult;
  observer: (settings: BridgeSettings) => BridgeObserver;
  token?: TokenStatus;
  env?: NodeJS.ProcessEnv;
}

// The plugin check when a daemon holds the bridge: its view IS the answer — no second bridge needed (or possible).
// Status is `ok` unless a connected client is running a stale plugin bundle — that demotion is independent of, and
// composes with, the shadowed-token classification, which reads the plugin check's status to decide whether the
// token warning is real.
function checkDaemonPlugin(st: DaemonStatusView): Check {
  if (!st.pluginConnected) {
    return fail("plugin", "Figma plugin", "the daemon is running, but no plugin is connected to it", `${runPlugin}; if its window says the token is wrong, ${pasteToken}`);
  }
  // daemonRowStalenessNote: staleness.ts, not server-core — see connectedDetail's comment
  const c = connectedDetail(st.clients, "connected (through the daemon)");
  // Two independent kinds of stale, either one is a warn: a stale PLUGIN bundle (pluginStale, set by an up-to-date
  // daemon that saw a version-less/old `hello`), or the DAEMON itself predating version reporting (its rows have no
  // `pluginVersion` key at all — the live case this was found in: a long-running `dtwin serve` older than this bridge).
  const stale = (st.clients ?? []).some((cl) => cl.pluginStale || daemonRowStalenessNote(cl));
  return { id: "plugin", title: "Figma plugin", status: stale ? "warn" : "ok", detail: c.detail, ...(c.next ? { next: c.next } : {}) };
}

async function run({ cwd = process.cwd(), waitSec = 10, onCheck, onWait, settings, observer, token, env = process.env }: RunOptions): Promise<Report> {
  const checks: Check[] = [];
  const add = (...cs: Check[]) => { for (const c of cs) { checks.push(c); if (onCheck) onCheck(c); } };
  // A package.json without `engines.bun` reads as null — checkBun then reports the range as unreadable.
  add(checkBun(Bun.version, (pkg as { engines?: { bun?: string } }).engines?.bun ?? null));

  const tok = token ?? tokenStore.status();
  // A shadowed token's real answer depends on the plugin check below — emit it
  // once that is known, rather than a static "make sure" note before anything has actually been
  // checked. Every other case is unaffected and keeps its original position, right after Bun.
  if (!tok.shadowed) add(checkToken(tok));

  // DTWIN_PORT is not read anywhere; a person who set it believes the bridge moved.
  const portWarning = dtwinPortWarning(env);
  if (portWarning) add(warn("port", "Port", portWarning));
  const seam = ephemeralPortWarning(env);
  if (seam) add(seam);
  let pluginCheck: Check;
  let viaDaemon = false;
  if (!settings.ok) {
    // The one setting that fails to read is the port (settings.ts readSettings); worded as doctor words it.
    add(resolvePort(env.FIGMA_BRIDGE_PORT).problem ?? fail("port", "Port", settings.problem));
    pluginCheck = checkPlugin({ skipped: "the port setting has to be fixed first" });
    add(pluginCheck);
  } else {
    const s = settings.settings;
    const look = observer(s);
    const seen = await look.holder();
    const st = "via" in seen && seen.via === "daemon" ? seen.status : null;
    // The file the effective token is read from (none for FIGMA_BRIDGE_TOKEN); a token file that cannot be read
    // is still the one the setup points at.
    const tokenFile = s.token.ok ? s.token.resolved.path : (env.FIGMA_BRIDGE_TOKEN_FILE || null);
    add(checkDaemon(st, s.port, seen.refused, sharedTokenNote(tokenFile, env.USERPROFILE || os.homedir())));
    add(checkPort(s.port, seen.port, st, env.FIGMA_BRIDGE_PORT));

    if (st) {
      viaDaemon = true;
      pluginCheck = checkDaemonPlugin(st);
    } else if ("heldBy" in seen) {
      pluginCheck = checkPlugin({ skipped: `port ${s.port} is held by something else, and probing it would disturb it`, ...(seen.heldBy === "websocket" ? { next: "if that is the MCP server, ask Claude Code to call figma_status — it reports the plugin connection" } : {}) });
    } else if (s.token.ok && s.token.resolved.source === "ephemeral") {
      pluginCheck = checkPlugin({ skipped: "there is no token yet, and doctor never creates one", next: "run `dtwin init`, paste the token into the plugin, then run doctor again" });
    } else {
      if (onWait) onWait(waitSec);
      pluginCheck = checkPlugin(await look.watch(waitSec * 1000), waitSec);
    }
    add(pluginCheck);
  }
  if (tok.shadowed) add(checkToken(tok, pluginCheck, viaDaemon));
  add(checkPluginFiles(pluginState()));

  add(...checkProject(cwd));
  return { ok: reportOk(checks), checks };
}

// A skipped check (the plugin probe could not run: a port held by something else, no token yet) is not advice like an
// ordinary warn — a check that was supposed to answer "can this project actually pull anything" never ran. `ok: true`
// beside one of those is worse than `ok: false`: it tells an automated caller (or a human skimming --json) that
// everything was verified when it wasn't. A warn about project state (stale export, legacy layout, no map) is real
// advice and does not flip the roll-up.
function reportOk(checks: readonly Check[]): boolean {
  return !checks.some((c) => c.status === "fail" || c.skipped === true);
}

const MARK: Record<Check["status"], string> = { ok: "✓", warn: "!", fail: "✗" };

const formatCheck = (c: Check) => `${MARK[c.status]} ${c.title}: ${c.detail}` + (c.next ? `\n    → ${c.next}` : "");
function verdict(report: Report): string {
  const n = (s: Check["status"]) => report.checks.filter((c) => c.status === s).length;
  return n("fail") ? `${n("fail")} problem(s) to fix${n("warn") ? `, ${n("warn")} note(s)` : ""}.` : n("warn") ? `No blocking problems; ${n("warn")} note(s) above.` : "All good.";
}

async function main(argv: string[]): Promise<void> {
  let waitSec = 10;
  let json = false;
  const usage = "Usage: dtwin doctor [--wait <seconds>] [--json]";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue; // cannot happen: i < argv.length
    if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") {
      console.log("dtwin doctor [--wait <seconds>] [--json]\n\n  Checks the whole setup and says what to do next: Bun version, bridge token, daemon, port,\n  whether the Figma plugin can connect (and whether it has the right token), and the project in\n  the current directory. Changes nothing: no token is created, no file is written.\n  --wait N   seconds to wait for the plugin to connect (default 10; it retries every second); once it has,\n             up to ~6.5 s more so every open file is seen and named\n  --json     machine output: { ok, checks: [{ id, title, status, detail, next, skipped }] }\n\n  Exit code 1 only when a check is ✗ (a note, !, is not a failure).");
      exitCli(0);
    } else if (a === "--wait" || a.startsWith("--wait=")) {
      const v = a === "--wait" ? argv[++i] : a.slice("--wait=".length);
      waitSec = Number(v);
      if (!v || !Number.isFinite(waitSec) || waitSec < 0) { console.error(`[dtwin doctor] error: --wait needs a number of seconds. ${usage}`); exitCli(1); }
    } else { console.error(`[dtwin doctor] error: unknown argument: ${a}. ${usage}`); exitCli(1); }
  }
  // Human output streams; --json stays one document at the end (a consumer parses it whole).
  // The settings, read once: the observer and every check below see the same ones.
  const settings = readSettings();
  const deps = { settings, observer: bridgeObserver };
  const report = await run(json ? { waitSec, ...deps } : {
    ...deps,
    waitSec,
    onCheck: (c) => console.log(formatCheck(c)),
    onWait: (sec) => console.log(`… waiting up to ${sec}s for the Figma plugin to connect, then a few seconds more for every open file to say its name (run it in Figma now; --wait 0 skips)`),
  });
  console.log(json ? JSON.stringify(report, null, 2) : "\n" + verdict(report));
  // exitCode, not exit(): let stdout drain (a piped --json would otherwise be cut short).
  process.exitCode = report.ok ? 0 : 1;
}

export { checkBun, checkToken, checkDaemon, sharedTokenNote, resolvePort, ephemeralPortWarning, checkPort, checkPlugin, checkPluginFiles, checkProject, exportChecks, reportOk, probePort, probePlugin, checkDaemonPlugin, run, main };
