// verify-build.ts — the Stop-hook gate for the build-screen skill, and the ONE place a plan's status
// is computed.
//
// Registered in two places. build-screen/SKILL.md's frontmatter (Stop): active only for a session
// that actually invoked build-screen. claude-plugin/hooks/hooks.json (SubagentStop, matched to the
// screen-builder agent): Claude Code ignores `hooks` in a plugin-shipped agent's frontmatter, so the
// fan-out builder can only be gated from the plugin level.
//
//   node verify-build.js                     hook mode: the hook JSON arrives on stdin
//   node verify-build.js <plan.json>…        check these plans (no stdin is read)
//   node verify-build.js --status [<plan>…]  print each plan's COMPUTED status; never writes
//
// ---------------------------------------------------------------- what BLOCKS (exit 2)
// Two things (livetest-3 §2.9 b), plus a third on web profiles only:
//   1. an UNEXPLAINED colour literal: a colour the plan resolved to a real code token, written as a raw
//      literal (`#5B5FC7`, `0xFF5B5FC7`, `rgb(91, 95, 199)`) in a SOURCE file listed in `files[]`.
//      Only code is scanned: comments, prose string literals (provenance notes) and every non-source
//      file (`.svg`, `.json`, `.md`, images …) are skipped — a hex in a doc comment (finding 100) or in
//      the baked-in stroke of an exported SVG the skill forbids editing (132) never reaches a painted
//      element as a literal. A value the plan did NOT resolve to a token is not a violation (the
//      profiles prescribe one-off literals where no token exists), and neither is the line that
//      DEFINES the token (`--color-figma-brand-600: #5B5FC7`). This is a source check, not a DOM
//      check: the rendered comparison is verify-screen.ts's job, and its report feeds the status.
//   2. a VISIBLE design node with no anchor in the plan: a node the export draws (not `hidden`, no
//      hidden ancestor) that neither it nor any ancestor maps to code in `anchors{}`. The plan is the
//      map from design to code; a visible subtree missing from it is a piece of the screen nobody
//      accounted for. `plan-skeleton.ts` lists every visible node, so this is only ever a fill-in.
//   3. (web profile: the plan's `target`, else design/target.json) NO `data-dt-node` attribute in any
//      plan's files[] (F-58): the verify step then measures nothing by id. Below 50% of anchored visible
//      nodes tagged is a warning; `"tagging": {"off": true, "reason": …}` opts out.
// Everything else — token identity merges (finding 130, right), a11y/coverage evidence (101, right),
// arbitrary px, file existence, `mapModule` imports (131), MISSING rows with no decision, the plan
// header (P3), the verification block's self-consistency (156), `deviations[]` shape (196) — is a
// WARNING: printed, exit 0. A gate that blocks on correct reuse teaches users to lie to it.
//
// ---------------------------------------------------------------- status is COMPUTED, never stored
// The hook never writes `plan.status` (§2.9 c, findings 155/189: two plans said "verified" beside
// reports that said "fail"). It writes `plan.verification.hook`:
//   { result: "pass"|"blocked", checkedAt, blocking:[…], warnings:N, planHash, files:{<path>: <sha256/16>|null} }
// and `computeStatus()` derives the status at read time from THREE facts that must all hold:
//   hook result "pass"  AND  every file in files[] still hashes the same  AND  the verify report
//   (design/verify/<…>.report.json, schema @2) says "pass" (or "pass-with-deviations") and measured THIS
//   design and THIS code — by content: its inputs.exportContentSha256 equals the export's (timestamps
//   stripped), its inputs.code.files equal the files' hashes now, and its inputs.waivers.sha256 equals the
//   hash of the plan's waivers[]/descopes[] now (absent = none). No clock is consulted (livetest-4 314/317).
// A stored "verified"/"static-only" (written by an older hook) is ignored by computeStatus and
// deleted the next time the hook checks that plan. `status` keeps only the states a PERSON sets:
// "pending" (default) · "awaiting-user" (paused on a question — skipped, never closed) ·
// "abandoned" (retired — skipped). Every reader (verify, sync-design, the next session) runs
// `verify-build.js --status` instead of trusting a field.
//
// Computed statuses: pending (hook has not checked this version of the plan) · blocked · stale (a
// file changed since the hook passed) · failed (a verify report exists and says fail) ·
// unverified (no report; a report that is "incomplete", older than schema @2, or that measured a
// different design, different code or different waivers) · static-only · verified ·
// verified-with-deviations (every report passes and ≥1 says "pass-with-deviations": accepted deltas or
// descoped interactions, D5/D20).
//
// ---------------------------------------------------------------- when it runs
// Fast path: a plan is OPEN when its status is "pending" (or absent/legacy), it was touched within
// STALE_HOURS, and the hook has not already passed this exact plan + these exact files. No open plan
// → exit 0 at once. So an edit to a built file re-opens its plan, and a finished build stays quiet.
// A plan nobody has touched for STALE_HOURS is a leftover from an earlier session and is left alone
// (DTWIN_PLAN_STALE_HOURS overrides; 0 disables the cutoff).
//
// stdin (findings 99/133): read ONLY when fd 0 is not a TTY; a pipe that delivers nothing within
// DTWIN_HOOK_STDIN_WAIT_MS (1 s) is treated as "no payload"; a payload with no EOF, or the whole run,
// is cut off at DTWIN_HOOK_TIMEOUT_MS (60 s) with a message naming what it was waiting on (exit 1 —
// a non-blocking error, because a stall of ours is not the agent's defect).
//
// Plan shape: see plan-skeleton.ts (which writes it) and build-screen/SKILL.md step 2.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { visibility } from "./plan-skeleton.ts";
import { screenExportOf, screenRoots } from "./export-shape.ts";
import * as contentHash from "./content-hash.ts";
import { auditGateStatus } from "./audit-gate.ts";
import { isJsonObject } from "./types.ts";
import { colorKey } from "./color.ts";
import { scriptCmd } from "./cli-args.ts";
import { isPassingVerdict, waiversHash } from "./plan-waivers.ts";
import { isPageIndex, isPagesRootIndex, isVerifyReport, parsePlan } from "./doc-guards.ts";
import { anyJson, readJson, readJsonOrNull } from "./read-json.ts";
import { isCodeConnectMap } from "./map-validate.ts";
import { isScreenDoc } from "./export-shape.ts";
import type {
  CodeInputs, IndexRow, IrNode, IrNodeType, JsonObject, Plan, PlanAnchor, PlanComputedStatus, PlanLifecycle,
  PlanStoredStatus, PlanTokenRow, ScreenDoc, VerifyDelta, VerifyReport,
} from "./types.ts";
import { getOrInit } from "./map-util.ts";
import { isMainFallback } from "../bridge/src/is-main.ts"; // import.meta.main is undefined before Node 24.2

// ================================================================ input / timeouts

const HOOK_TIMEOUT_MS = (): number => Number(process.env.DTWIN_HOOK_TIMEOUT_MS) || 60000;
const STDIN_WAIT_MS = (): number => { const n = Number(process.env.DTWIN_HOOK_STDIN_WAIT_MS); return Number.isFinite(n) && n >= 0 && process.env.DTWIN_HOOK_STDIN_WAIT_MS !== "" ? n : 1000; };

let phase = "starting";
const setPhase = (p: string): void => { phase = p; };

/** The Stop-hook payload as read off stdin: arbitrary JSON from Claude Code, so a plain JSON object. */
export type HookPayload = JsonObject;
/** readHookInput()'s result: a payload and where it came from, or an error naming what stalled. */
export interface HookRead { payload?: HookPayload; source?: string; error?: string }

// The hook JSON, read only when stdin is not a terminal. A regular file or /dev/null reads to EOF at
// once; a pipe/socket is read asynchronously with two deadlines, so an inherited pipe that never
// closes (finding 133: "same command, two different outcomes") cannot stall the build.
function readHookInput(): Promise<HookRead> {
  if (process.stdin.isTTY) return Promise.resolve({ payload: {}, source: "tty" });
  let st: fs.Stats;
  try { st = fs.fstatSync(0); } catch { return Promise.resolve({ payload: {}, source: "closed" }); }
  // Whatever the pipe carried: only a JSON object is a payload (anything else reads as an empty one).
  const parse = (raw: string): HookPayload => { if (!raw.trim()) return {}; try { const v: unknown = JSON.parse(raw); return isJsonObject(v) ? v : {}; } catch { return {}; } };
  if (st.isFile() || st.isCharacterDevice()) {
    try { return Promise.resolve({ payload: parse(fs.readFileSync(0, "utf8")), source: "file" }); } catch { return Promise.resolve({ payload: {}, source: "unreadable" }); }
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0, finished = false;
    const done = (value: HookRead): void => {
      if (finished) return;
      finished = true;
      clearTimeout(first); clearTimeout(hard);
      process.stdin.removeAllListeners("data"); process.stdin.removeAllListeners("end");
      try { process.stdin.pause(); process.stdin.unref && process.stdin.unref(); } catch { /* ignore */ }
      resolve(value);
    };
    const first = setTimeout(() => { if (!bytes) done({ payload: {}, source: "silent-pipe" }); }, STDIN_WAIT_MS());
    // a little inside the process watchdog, so this (more specific) message is the one printed
    const hard = setTimeout(() => done({ error: `timed out after ${Math.round(HOOK_TIMEOUT_MS() / 1000)} s waiting for the hook payload on stdin (${bytes} byte(s) received, no end-of-file) — pass the plan path as an argument instead, or pipe the payload: echo '{"cwd":"…"}' | ${scriptCmd("verify-build")}` }), Math.max(50, HOOK_TIMEOUT_MS() - 250));
    process.stdin.on("data", (c: Buffer) => { bytes += c.length; chunks.push(c); });
    process.stdin.on("end", () => done({ payload: parse(Buffer.concat(chunks).toString("utf8")), source: "pipe" }));
    process.stdin.on("error", () => done({ payload: {}, source: "error" }));
    process.stdin.resume();
  });
}

// ================================================================ plans on disk

const STALE_HOURS = 12;

function staleCutoffMs(): number {
  const raw = process.env.DTWIN_PLAN_STALE_HOURS;
  const h = raw === undefined || raw === "" ? STALE_HOURS : Number(raw);
  return Number.isFinite(h) && h > 0 ? h * 3600 * 1000 : 0;
}

function isStale(file: string, now: number = Date.now()): boolean {
  const cutoff = staleCutoffMs();
  if (!cutoff) return false;
  try { return now - fs.statSync(file).mtimeMs > cutoff; } catch { return false; }
}

/** A plan file on disk, parsed and checked (doc-guards.ts parsePlan): plan-skeleton.ts writes it, a model fills it. */
export interface PlanFile { file: string; plan: Plan }
/** A plan file that could not be used, and why (one line). */
export interface BadPlan { file: string; error: string }

function readPlan(file: string): PlanFile | BadPlan {
  const r = readJson(file, anyJson);
  if (!("doc" in r)) return { file, error: r.error };
  const p = parsePlan(r.doc);
  return "plan" in p ? { file, plan: p.plan } : { file, error: p.error };
}
const isPlanFile = (p: PlanFile | BadPlan): p is PlanFile => "plan" in p;

// Every plan under design/plan/, and — separately — the ones that could not be read: those are reported,
// never silently skipped (a hand-broken plan used to vanish from the hook's view, so it was never checked).
function findPlans(cwd: string): { plans: PlanFile[]; bad: BadPlan[] } {
  const dir = path.join(cwd, "design", "plan");
  if (!fs.existsSync(dir)) return { plans: [], bad: [] };
  const read = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => readPlan(path.join(dir, f)));
  return { plans: read.filter(isPlanFile), bad: read.filter((p): p is BadPlan => !isPlanFile(p)) };
}

// The project root a plan belongs to: <root>/design/plan/<x>.json → <root>.
function rootOfPlan(file: string, fallback?: string): string {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  if (path.basename(dir) === "plan" && path.basename(path.dirname(dir)) === "design") return path.dirname(path.dirname(dir));
  return fallback || process.cwd();
}

// Lifecycle states a PERSON sets. Anything else stored in `status` ("verified", "static-only", from an
// older hook) is a computed value that must not be trusted, and counts as pending.
const REPORT_SCHEMA_V2 = "designtwin/verify-report@2";
const LIFECYCLE = new Set<string>(["pending", "awaiting-user", "abandoned"]);
const COMPUTED_STORED = new Set<string>(["verified", "verified-with-deviations", "static-only"]);
const isLifecycle = (s: string): s is PlanLifecycle => LIFECYCLE.has(s);
const lifecycleOf = (plan: Plan | null | undefined): PlanLifecycle => {
  const s = String((plan && plan.status) || "pending").trim().toLowerCase();
  return isLifecycle(s) ? s : "pending";
};

// ================================================================ hashing

const sha = (buf: string | Buffer): string => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);

function fileHashes(plan: Plan | null | undefined, cwd: string): Record<string, string | null> {
  return contentHash.fileHashes(plan && plan.files, cwd); // the same hashes verify-screen --compare records
}

// The plan's own content, minus what the hook writes and what is not the plan's substance. The owner's
// waivers[]/descopes[] are left out too — accepting a delta must not send the hook back to pending; a
// report records their hash instead (inputs.waivers.sha256), and reportVerdict() compares that.
function planHash(plan: Plan | null | undefined): string {
  const copy: Plan = structuredClone(plan || {});
  delete copy.status;
  delete copy.waivers;
  delete copy.descopes;
  if (copy.verification) {
    delete copy.verification.hook;
    if (!Object.keys(copy.verification).length) delete copy.verification;
  }
  return sha(JSON.stringify(copy));
}

function changedFiles(plan: Plan, cwd: string): string[] | null {
  const hook = plan.verification && plan.verification.hook;
  if (!hook || !hook.files) return null;
  const now = fileHashes(plan, cwd);
  const changed: string[] = [];
  const all = new Set([...Object.keys(hook.files), ...Object.keys(now)]);
  for (const f of all) if (hook.files[f] !== now[f]) changed.push(now[f] === undefined ? `${f} (no longer in files[])` : hook.files[f] === undefined ? `${f} (added to files[])` : now[f] === null ? `${f} (missing)` : f);
  return changed;
}

// OPEN = the hook still has work on this plan.
function isOpen(p: PlanFile, cwd: string): boolean {
  if (lifecycleOf(p.plan) !== "pending") return false;
  if (isStale(p.file)) return false;
  const hook = p.plan.verification && p.plan.verification.hook;
  if (!hook || hook.result !== "pass") return true;
  if (hook.planHash !== planHash(p.plan)) return true;
  const ch = changedFiles(p.plan, cwd);
  return !ch || ch.length > 0;
}

// ================================================================ source scanning

// Files whose text is CODE. Everything else in files[] (exported .svg artwork, .json data, docs,
// images, Dockerfiles) is not scanned for literals: a colour there is data, not a styling decision.
const SOURCE_EXT = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs", "vue", "svelte", "astro", "css", "scss", "sass", "less", "styl", "html", "htm",
  "swift", "kt", "kts", "java", "dart", "xml", "m", "mm", "h", "cs", "xaml"]);
// split() always returns at least one element, so pop() is never undefined: `?? ""` is inert.
const extOf = (rel: string): string => String(rel).toLowerCase().split(".").pop() ?? "";
const isSourceFile = (rel: string): boolean => SOURCE_EXT.has(extOf(rel));

// A string literal that is prose — a provenance note like "bound to Neutrals/Neutral 0, #121319 in
// Dark" — rather than a style value. Three plain words in a row is prose; `1px solid #fff`,
// `bg-[#fff] px-4` and `#fff` are not.
const PROSE = /\b[A-Za-z]{2,}[,.;:]?\s+[A-Za-z]{2,}[,.;:]?\s+[A-Za-z]{2,}\b/;
const isProse = (s: string): boolean => PROSE.test(s) && !/-\[|\[#/.test(s);

// The text the literal scan looks at: comments removed; prose strings blanked. Keeps line structure
// (newlines survive) so per-line definition detection still works.
function scanText(rel: string, text: string): string {
  const ext = extOf(rel);
  const lineComments = !["css", "html", "htm", "xml", "xaml"].includes(ext);
  const htmlComments = ["html", "htm", "xml", "xaml", "vue", "svelte", "astro"].includes(ext);
  const strings = !["html", "htm", "xml", "xaml"].includes(ext);
  let out = "", i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (c === "/" && d === "*") { const j = text.indexOf("*/", i + 2); const end = j === -1 ? n : j + 2; out += text.slice(i, end).replace(/[^\n]/g, " "); i = end; continue; }
    if (lineComments && c === "/" && d === "/" && text[i - 1] !== ":") { const j = text.indexOf("\n", i); const end = j === -1 ? n : j; out += " ".repeat(end - i); i = end; continue; }
    if (htmlComments && text.startsWith("<!--", i)) { const j = text.indexOf("-->", i + 4); const end = j === -1 ? n : j + 3; out += text.slice(i, end).replace(/[^\n]/g, " "); i = end; continue; }
    if (strings && (c === '"' || c === "'" || c === "`")) {
      let j = i + 1;
      while (j < n && text[j] !== c && !(c !== "`" && text[j] === "\n")) j += text[j] === "\\" ? 2 : 1;
      const end = Math.min(n, j + 1);
      const body = text.slice(i + 1, j);
      out += isProse(body) ? c + body.replace(/[^\n]/g, " ") + (text[j] === c ? c : "") : text.slice(i, end);
      i = end;
      continue;
    }
    out += c; i++;
  }
  return out;
}

// Every raw colour literal in the source, keyed by colorKey ("#rrggbbaa", color.ts) -> the spelling found.
// Alpha is part of the key (live run #25): `#ffffff` and `#ffffff1a` are different colours bound to
// different tokens, and folding them together cross-contaminated both directions.
function colorLiterals(source: string): Map<string, string> {
  const found = new Map<string, string>();
  const add = (h: string | null, lit: string): void => { if (h && !found.has(h)) found.set(h, lit); };
  for (const m of source.matchAll(/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g)) add(colorKey(m[1]), m[0]);
  // Compose / Flutter `Color(0xFF5B5FC7)` — AARRGGBB (alpha FIRST), or bare 0xRRGGBB.
  for (const m of source.matchAll(/\b0x([0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/g)) {
    const g = m[1];
    if (g === undefined) continue; // the group is not optional: set whenever the regex matched
    const h = g.toLowerCase();
    add("#" + (h.length === 8 ? h.slice(2) + h.slice(0, 2) : h + "ff"), m[0]);
  }
  for (const m of source.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?[^)]*\)/g)) {
    const rgb = [m[1], m[2], m[3]].map((x) => Math.min(255, Number(x)).toString(16).padStart(2, "0")).join("");
    add("#" + rgb + alphaHex(m[4]), m[0]);
  }
  return found;
}

function alphaHex(a: string | undefined): string {
  if (a === undefined || a === "") return "ff";
  const n = String(a).endsWith("%") ? Number(String(a).slice(0, -1)) / 100 : Number(a);
  if (!Number.isFinite(n)) return "ff";
  return Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, "0");
}

// Tailwind arbitrary dimensions: the utility PREFIX says which kind the number is (live finding 88:
// `rounded-[20px]` is not the 20px a fontSize token resolves to).
const UTILITY_KIND: Array<[RegExp, string]> = [
  [/^rounded(-[a-z]+)?$/, "radius"],
  [/^text$/, "fontSize"],
  [/^leading$/, "lineHeight"],
  [/^tracking$/, "letterSpacing"],
  [/^(gap|gap-x|gap-y|space-x|space-y)$/, "spacing"],
  [/^([pm][trblxy]?)$/, "spacing"],
  [/^(top|right|bottom|left|inset(-[xy])?|start|end)$/, "spacing"],
  [/^(w|h|min-w|min-h|max-w|max-h|size|basis)$/, "size"],
  [/^border(-[trblxyse]+)?$/, "borderWidth"],
];
const KIND_MATCHES: Record<string, string[]> = {
  radius: ["radius", "borderradius", "cornerradius"],
  fontSize: ["fontsize", "font-size", "type", "typography"],
  lineHeight: ["lineheight", "line-height"],
  letterSpacing: ["letterspacing", "letter-spacing", "tracking"],
  spacing: ["spacing", "space", "gap", "padding", "margin", "size", "dimension"],
  size: ["size", "spacing", "space", "dimension", "width", "height"],
  borderWidth: ["borderwidth", "border-width", "border", "stroke"],
};
function utilityKind(utility: string | null | undefined): string | null {
  const u = String(utility || "").replace(/^-/, "");
  for (const [re, kind] of UTILITY_KIND) if (re.test(u)) return kind;
  return null;
}
function kindsCompatible(utility: string | null | undefined, rowKind: unknown): boolean {
  const uk = utilityKind(utility);
  if (!uk) return true;
  const rk = String(rowKind || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!rk) return true;
  return (KIND_MATCHES[uk] || []).some((k) => k.replace(/[^a-z]/g, "") === rk);
}
interface PxHit { literal: string; utility: string | null }
function arbitraryPx(source: string): Map<number, PxHit[]> {
  const found = new Map<number, PxHit[]>();
  for (const m of source.matchAll(/(?:^|[\s"'`{(])([a-z-]+)-\[(-?\d+(?:\.\d+)?)(px|rem)\]/g)) {
    const px = Number(m[2]) * (m[3] === "rem" ? 16 : 1);
    const entry: PxHit = { literal: `[${m[2]}${m[3]}]`, utility: m[1] ?? null }; // ?? null: the group is not optional, so it never applies
    const list = found.get(px) || [];
    if (!list.some((e) => e.utility === entry.utility)) list.push(entry);
    found.set(px, list);
  }
  for (const m of source.matchAll(/\[(-?\d+(?:\.\d+)?)(px|rem)\]/g)) {
    const px = Number(m[1]) * (m[2] === "rem" ? 16 : 1);
    if (!found.has(px)) found.set(px, [{ literal: m[0], utility: null }]);
  }
  return found;
}

// ================================================================ imports (finding 131)

// Module specifiers a source file imports: ES `import … from`, bare `import "x"`, `export … from`,
// dynamic `import("x")`, CommonJS `require("x")`, CSS `@import`.
function importsOf(text: string): string[] {
  const out: string[] = [];
  const re = /\bimport\s+(?:[^'"`;]*?\sfrom\s+)?["'`]([^"'`]+)["'`]|\bexport\s+[^'"`;]*?\sfrom\s+["'`]([^"'`]+)["'`]|\b(?:require|import)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)|@import\s+(?:url\()?["']([^"']+)["']/g;
  for (const m of text.matchAll(re)) {
    const spec = m[1] || m[2] || m[3] || m[4]; // each alternative captures a non-empty specifier, so one is always set
    if (spec !== undefined) out.push(spec);
  }
  return out;
}

const SRC_EXT_RE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro|css|scss|swift|kt|dart)$/i;
// "app/src/components/PageTitle.tsx" / "@/components/PageTitle" / "../../../components/PageTitle/index"
// → ["components", "PageTitle"] style segments, extension and trailing /index dropped, alias
// prefixes (`@/`, `~/`, `#/`, `@alias/`) and `.`/`..` removed.
function moduleSegments(spec: unknown): string[] {
  let s = String(spec || "").trim().replace(/\\/g, "/").replace(SRC_EXT_RE, "").replace(/\/index$/i, "");
  const segs = s.split("/").filter((x) => x && x !== "." && x !== "..");
  const [first] = segs;
  if (first !== undefined && /^[@~#]$/.test(first)) segs.shift();
  return segs;
}

/** One file of a plan's files[] with its text (rel is project-relative). */
export interface FileText { rel: string; text: string }

// Does any built file import the module a plan row says it reuses? Relative specifiers are resolved
// against the importing file, then compared with mapModule by path SUFFIX; alias / bare specifiers are
// compared by suffix directly. A `mapModule` written as a repo path (`app/src/components/PageTitle.tsx`)
// therefore matches `'../../../components/PageTitle'` and `'@/components/PageTitle'` alike — the
// unsatisfiable substring test of finding 131 is gone. Non-JS stacks (Swift/Kotlin/Dart import
// modules, not files): the component's own name used as an identifier counts.
// importsOf per file text, memoised: the import graph below asks the same file about every other file.
const importCache = new Map<string, string[]>();
const cachedImports = (text: string): string[] => getOrInit(importCache, text, () => importsOf(text));

function moduleImported(mapModule: string, byFile: FileText[], cwd: string): boolean {
  const want = moduleSegments(mapModule);
  if (!want.length) return true;
  const suffixMatch = (have: string[]): boolean => {
    const k = Math.min(have.length, want.length);
    if (!k) return false;
    for (let i = 1; i <= k; i++) {
      const h = have[have.length - i], w = want[want.length - i]; // i <= k <= both lengths, so both are set
      if (h === undefined || w === undefined || h.toLowerCase() !== w.toLowerCase()) return false;
    }
    return true;
  };
  const wantAbs = moduleSegments(path.relative(cwd, path.resolve(cwd, String(mapModule))));
  for (const f of byFile) {
    for (const spec of cachedImports(f.text)) {
      if (spec.startsWith(".")) {
        const resolved = moduleSegments(path.relative(cwd, path.resolve(cwd, path.dirname(f.rel), spec)));
        if (resolved.join("/").toLowerCase() === wantAbs.join("/").toLowerCase() || suffixMatch(resolved)) return true;
      } else if (suffixMatch(moduleSegments(spec))) return true;
    }
    if (!/\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro)$/i.test(f.rel)) {
      const name = want[want.length - 1];
      if (name && new RegExp(`\\b${name.replace(/[^A-Za-z0-9_]/g, "")}\\b`).test(f.text)) return true;
    }
  }
  return false;
}

// ================================================================ the export behind a plan

// Every JSON read below (an export, its index, a verify report/expectation, a component map) is checked
// against its doc-guards.ts guard; a lookup that finds only a broken file behaves as if it found nothing.

function exportDirOf(cwd: string): string {
  const e = path.join(cwd, "design", "export");
  return fs.existsSync(path.join(e, "pages")) ? e : path.join(cwd, "design"); // pre-split projects
}

// Node id from a `<Screen>__<a>_<b>` stem (the exporter's own file naming).
const idFromStem = (s: unknown): string | null => { const m = /__(I?\d+)_(\d+)$/.exec(String(s || "")); return m ? `${m[1]}:${m[2]}` : null; };

function indexRows(exportDir: string): IndexRow[] {
  const root = readJsonOrNull(path.join(exportDir, "pages", "index.json"), isPagesRootIndex);
  if (!root) return [];
  if (root.layers) return root.layers;
  const rows: IndexRow[] = [];
  for (const pd of root.pageDirs) {
    const idx = readJsonOrNull(path.join(exportDir, pd.index || path.join("pages", pd.dir || "", "index.json")), isPageIndex);
    if (idx) rows.push(...idx.layers);
  }
  return rows;
}

/** locateExport()'s result: the screen export a plan describes, plus what the index knows about it. */
export interface ExportHit { file: string; doc: ScreenDoc; row: IndexRow | null; nodeId: string | null; layerName: string; sameNameRows: number }

// The screen export a plan describes: its `file` header (project-relative, or relative to
// design/export as the index writes it), else its `nodeId`, else the node id in its `screen` stem or
// its own filename, looked up in the export index. Returns { file, doc, row } or null.
function locateExport(plan: Plan, planFile: string | undefined, cwd: string): ExportHit | null {
  const exportDir = exportDirOf(cwd);
  const tryFile = (rel: string | null | undefined): { file: string; doc: ScreenDoc } | null => {
    if (!rel) return null;
    for (const f of [path.resolve(cwd, rel), path.resolve(exportDir, rel)]) {
      const doc = readJsonOrNull(f, isScreenDoc);
      if (doc) return { file: f, doc };
    }
    return null;
  };
  let hit = tryFile(plan.file && /\.json$/i.test(plan.file) ? plan.file : null);
  const rows = indexRows(exportDir);
  const ids = [plan.nodeId, idFromStem(plan.screen), planFile ? idFromStem(path.basename(planFile, ".json")) : null].filter((id): id is string => !!id);
  let row: IndexRow | null = null;
  for (const id of ids) { row = rows.find((r) => r.id === id) || null; if (row) break; }
  if (!hit && row) hit = tryFile(row.file);
  if (!hit) return null;
  const root: IrNode | undefined = screenRoots(hit.doc)[0];
  const exp = screenExportOf(hit.doc);
  const nodeId = (exp && exp.nodeId) || (root && root.id) || null;
  const layerName = String((exp && exp.screen) || (root && root.name) || "");
  if (!row) row = rows.find((r) => r.id === nodeId) || null;
  return Object.assign(hit, { row, nodeId, layerName, sameNameRows: rows.filter((r) => String(r.name || "").trim() === layerName.trim()).length });
}

// ================================================================ anchors (block 2)

const anchored = (a: PlanAnchor | undefined): boolean => !!a && typeof a === "object" && (["mapModule", "file", "symbol", "omitted"] as const).some((k) => { const v = a[k]; return typeof v === "string" && !!v.trim(); });

interface NodeRef { id: string; name: string; type: IrNodeType }
/** anchorCoverage()'s result. */
export interface AnchorCoverage { visible: number; unmapped: NodeRef[]; unmappedNodes: number; wrappers: NodeRef[]; hiddenAnchored: string[]; unknown: string[] }

function anchorCoverage(plan: Plan, doc: ScreenDoc): AnchorCoverage {
  const { visible, hidden } = visibility(doc);
  const anchors: Record<string, PlanAnchor> = plan.anchors || {};
  const covered = new Map<string, boolean>();
  const isCovered = (id: string): boolean => {
    const known = covered.get(id);
    if (known !== undefined) return known;
    const v = visible.get(id);
    const r = anchored(anchors[id]) || (!!v && !!v.parentId && visible.has(v.parentId) && isCovered(v.parentId));
    covered.set(id, r);
    return r;
  };
  // which uncovered nodes have an anchored node somewhere below them (pure wrappers — a warning)
  const hasAnchoredBelow = new Set<string>();
  for (const [id, v] of visible) {
    if (!anchored(anchors[id])) continue;
    let p = v.parentId;
    while (p && !hasAnchoredBelow.has(p)) {
      const pv = visible.get(p);
      if (!pv) break;
      hasAnchoredBelow.add(p); p = pv.parentId;
    }
  }
  const unmapped: NodeRef[] = [], wrappers: NodeRef[] = [];
  for (const [id, v] of visible) {
    if (isCovered(id)) continue;
    if (hasAnchoredBelow.has(id)) { wrappers.push({ id, name: v.node.name, type: v.node.type }); continue; }
    // report only the top of each unmapped subtree
    const parentUnmapped = v.parentId && visible.has(v.parentId) && !isCovered(v.parentId) && !hasAnchoredBelow.has(v.parentId);
    if (!parentUnmapped) unmapped.push({ id, name: v.node.name, type: v.node.type });
  }
  const unmappedNodes = [...visible.keys()].filter((id) => !isCovered(id) && !hasAnchoredBelow.has(id)).length;
  return {
    visible: visible.size,
    unmapped, unmappedNodes, wrappers,
    hiddenAnchored: Object.keys(anchors).filter((id) => hidden.has(id)),
    unknown: Object.keys(anchors).filter((id) => !visible.has(id) && !hidden.has(id)),
  };
}

// ================================================================ the checks

const verdictOf = (row: { verdict?: unknown } | null | undefined): string => String((row && row.verdict) || "").trim().toLowerCase();
// `codeToken: "MISSING"` (or none / n/a / null) means "there is no token" — not a token NAME.
const NO_TOKEN = new Set(["missing", "none", "n/a", "na", "-", "null", "tbd"]);
const hasToken = (row: PlanTokenRow): row is PlanTokenRow & { codeToken: string } => !!row.codeToken && !NO_TOKEN.has(String(row.codeToken).trim().toLowerCase());

function loadMapKeys(cwd: string): Map<string, { name: string; module: string }> {
  for (const f of [path.join(cwd, "design", "codeconnect.local.json"), path.join(cwd, "codeconnect.local.json")]) {
    // An invalid map is treated as no map (these are warnings about reuse; map-validate.js names the fault).
    const map = readJsonOrNull(f, isCodeConnectMap);
    if (!map) continue;
    const keys = new Map<string, { name: string; module: string }>();
    for (const [name, e] of Object.entries(map.components)) {
      if (e.figma.key && e.status !== "deprecated") keys.set(e.figma.key, { name, module: e.code.module });
    }
    return keys;
  }
  return new Map();
}

function checkVerification(plan: Plan, cwd: string): string[] {
  const v = plan.verification;
  if (!v || typeof v !== "object" || v.mode === undefined) {
    return ["no `verification.mode` in the plan — record how the build was checked: {mode:\"rendered\", renderer, artifacts:[…], deltas:[…]} after rendering and comparing (references/verify.md), or {mode:\"static-only\", reason} if the project genuinely has no way to render"];
  }
  if (v.mode === "rendered") {
    // live L-2: an agent wrote artifacts/deltas as OBJECTS ({screenshot: "…"}, {high: 33, …}) — say the shape is wrong, not "empty"/"missing"
    const shape = (x: unknown): string => x === null ? "null" : Array.isArray(x) ? "an array" : typeof x === "object" ? "an object" : typeof x;
    // (both shape errors in one round: the field-test plans had both as objects, and this is only a warning — review LOW-1)
    const wrongShape: string[] = [];
    if (v.artifacts !== undefined && !Array.isArray(v.artifacts)) wrongShape.push(`verification.artifacts must be an array of paths, got ${shape(v.artifacts)} — e.g. ["design/verify/<Screen>.png", "design/verify/<Screen>.report.json"]`);
    if (v.deltas !== undefined && !Array.isArray(v.deltas)) wrongShape.push(`verification.deltas must be an array of the residual differences, got ${shape(v.deltas)} — the counts live in the report; list each difference ([] if none were found)`);
    if (wrongShape.length) return v.deltas === undefined ? [...wrongShape, "verification.deltas is missing — list the residual differences against the reference ([] if none were found)"] : wrongShape;
    const artifacts = Array.isArray(v.artifacts) ? v.artifacts : [];
    if (!artifacts.length) return ["verification.mode is \"rendered\" but `artifacts` is empty — list the screenshot(s)/report the render produced"];
    const missing = artifacts.filter((a) => !fs.existsSync(path.join(cwd, String(a))));
    if (missing.length) return [`verification artifact(s) not found on disk: ${missing.join(", ")} — render the screen, or record mode "static-only" with the reason`];
    if (!Array.isArray(v.deltas)) return ["verification.deltas is missing — list the residual differences against the reference ([] if none were found)"];
    return [];
  }
  if (v.mode === "static-only") {
    return v.reason ? [] : ["verification.mode is \"static-only\" with no `reason` — say what was checked for and not found (dev server, Playwright, simulator…)"];
  }
  return [`verification.mode must be "rendered" or "static-only", got ${JSON.stringify(v.mode)}`];
}

// Missing evidence worth having (a warning, never a block).
function verificationWarnings(plan: Plan): string[] {
  const v = plan.verification;
  if (!v || v.mode !== "rendered") return [];
  const out: string[] = [];
  const c = v.coverage;
  if (!c || !Array.isArray(c.rendered) || !c.rendered.length) out.push("verification.coverage is missing — record {rendered:[…], notChecked:[{what, why}]} so the report can say which states/themes/sizes were never rendered (references/verify.md, \"Beyond the ideal frame\")");
  if (!v.a11y) out.push("verification.a11y is missing — no accessibility check is recorded (web: @axe-core/playwright on the rendered page); say so in the report rather than implying one ran");
  return out;
}

/** A verify report as locateReports() summarises it for the status computation. */
/** How locateReports() tied a report to the plan (first that matches, in this order). */
export type ReportMatch = "name" | "nodeId" | "expectation frame" | "layer name";
export interface ReportRef {
  rel: string; matchedBy: ReportMatch; schema: string | null; verdict: VerifyReport["verdict"] | null; headline: string | null; why: string[]; deltas: VerifyDelta[] | null;
  exportedAt: string | null; measuredAt: string | null; mtimeMs: number; exportContentSha256: string | null; code: CodeInputs | null;
  expectationChanged: boolean; expectationRel: string | null;
  /** inputs.waivers.sha256: the plan waivers/descopes the compare applied (null = recorded none — an older report). */
  waiversSha256: string | null;
}

// Finding 156: the verification block contradicting itself in adjacent keys.
const A11Y = /\b(a11y|axe|accessib)/i;
function verificationContradictions(plan: Plan, reports: ReportRef[] | null | undefined): string[] {
  const v = plan.verification;
  if (!v || typeof v !== "object") return [];
  const out: string[] = [];
  const notChecked = (v.coverage && Array.isArray(v.coverage.notChecked)) ? v.coverage.notChecked : [];
  const what = (e: string | { what?: string; why?: string } | null | undefined): string => String(e && typeof e === "object" ? e.what || "" : e || "");
  const rendered = (v.coverage && Array.isArray(v.coverage.rendered)) ? v.coverage.rendered.map((x) => String(x).trim().toLowerCase()) : [];
  if (v.a11y && typeof v.a11y === "object" && v.a11y.violations !== undefined) {
    const nc = notChecked.find((e) => A11Y.test(what(e)));
    if (nc) out.push(`verification contradicts itself: \`a11y\` records ${JSON.stringify(v.a11y.violations)} violation(s) from ${JSON.stringify(v.a11y.tool || "an a11y scan")}, while \`coverage.notChecked\` says "${what(nc)}" was not checked${typeof nc === "object" && nc.why ? ` (${nc.why})` : ""} — keep the one that is true`);
  }
  for (const e of notChecked) if (rendered.includes(what(e).trim().toLowerCase())) out.push(`verification contradicts itself: "${what(e)}" is listed both in coverage.rendered and in coverage.notChecked`);
  for (const r of reports || []) {
    if (Array.isArray(v.deltas) && !v.deltas.length && Array.isArray(r.deltas) && r.deltas.length) out.push(`verification.deltas is [] but ${r.rel} lists ${r.deltas.length} delta(s) — copy them (or the ones you judged real, with why) into the plan`);
    for (const k of ["verifyScreenVerdict", "verdict"] as const) {
      const claimed = v[k];
      const s = claimed && typeof claimed === "object" ? claimed.verdict : claimed;
      if (typeof s === "string" && /pass/i.test(s) && !isPassingVerdict(r.verdict)) out.push(`verification.${k} says ${JSON.stringify(s)} but ${r.rel} says verdict ${JSON.stringify(r.verdict)} — the report is the verdict; the plan cannot overrule it`);
      // accepted deviations are not a plain pass: the plan must not summarise them away
      else if (typeof s === "string" && /^\s*pass\s*$/i.test(s) && r.verdict === "pass-with-deviations") out.push(`verification.${k} says "pass" but ${r.rel} says "pass-with-deviations" — say the accepted deviations, not a plain pass`);
    }
  }
  return out;
}

// Finding 196: a deviation is only reviewable when it says WHICH node, WHICH field, what was designed,
// what was built, and why.
const DEVIATION_FIELDS = ["nodeId", "field", "designed", "built", "reason"] as const;
function deviationWarnings(plan: Plan): string[] {
  if (plan.deviations === undefined) return []; // (a non-array `deviations` is refused by parsePlan, doc-guards.ts)
  const bad: string[] = [];
  plan.deviations.forEach((d, i) => {
    const miss = DEVIATION_FIELDS.filter((k) => {
      if (k === "nodeId") return !(d && ((typeof d.nodeId === "string" && d.nodeId) || (Array.isArray(d.nodeIds) && d.nodeIds.length)));
      return !(d && d[k] !== undefined && d[k] !== null && d[k] !== "");
    });
    if (miss.length) bad.push(`#${i}${d && d.id ? ` (${d.id})` : ""}: ${miss.join(", ")}`);
  });
  return bad.length ? [`${bad.length} deviation(s) are missing fields — each needs {nodeId, field, designed, built, reason} so a reviewer can check it against the export: ${bad.slice(0, 6).join("; ")}${bad.length > 6 ? `; +${bad.length - 6} more` : ""}`] : [];
}

// P3 #150/#151/#180: the header every other skill resolves a plan by. A warning — plan-skeleton.ts
// writes it, so a plan without it was hand-written.
function validatePlanHeader(plan: Plan): string[] {
  const missing = (["screenName", "nodeId", "route", "file"] as const).filter((k) => plan[k] === undefined || plan[k] === null || plan[k] === "");
  if (!missing.length) return [];
  return [
    `plan header is missing ${missing.map((k) => `\`${k}\``).join(", ")} — other skills (verify, sync-design) resolve a screen through this header, not through the free-text \`screen\` field; add ${missing.length > 1 ? "them" : "it"} so this plan is findable by node id/name/route without guessing (the plan-skeleton script writes the header; only the route is yours to fill)`,
  ];
}

// Token definitions are not token usages. A DEFINITION line declares the code token itself:
// `--color-figma-brand-600: #5b5fc7` (web-tailwind's `figma-` namespace, profile web-tailwind.md),
// `--brand-600: #5b5fc7`, `brand600: "#5b5fc7"`, `val brand600 = Color(0xFF5B5FC7)`. The declared
// name must be the TOKEN's — `color: #5b5fc7` inside a component declares a CSS property.
const DECLARATION = /(^|[\s;{,(])(--[\w-]+|[\w$][\w$-]*)\s*[:=]\s*[^;,}\n]*$/;
const slug = (x: unknown): string => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
// Strip what differs between a CSS variable and the utility/token that uses it: the category prefix
// (`--color-`, `bg-`, `text-`, `gap-`, `rounded-` …), the `figma-` namespace, and a `-<8 hex>` key suffix.
function tokenCore(x: unknown): string {
  let s = String(x || "").toLowerCase().replace(/^--/, "").replace(/^var\(--|\)$/g, "");
  s = s.replace(/^(color|colors|spacing|space|radius|rounded|text|font|font-size|font-weight|leading|tracking|shadow|bg|border|fill|stroke|ring|outline|gap|gap-[xy]|p[xytrbl]?|m[xytrbl]?|w|h|size|inset|top|left|right|bottom)-/, "");
  s = s.replace(/^figma-/, "").replace(/-[0-9a-f]{8}$/, "");
  return slug(s);
}
// Does a declared name name THIS token? Exactly — after normalising both sides (`--color-x`, `var(--x)`,
// `bg-x`, the `figma-` namespace, a key suffix all reduce to the same core) — never by substring: with
// tokens `input` and `border`, `border-color:` is a CSS property, not either token's definition. In a
// stylesheet only a custom property (`--x:`) declares a token; plain properties never do. Elsewhere a
// token object key / native constant (`brand600:`, `val brand600 =`) counts, by the same exact match.
const STYLESHEET_EXT = new Set(["css", "scss", "sass", "less", "styl"]);
const isStylesheet = (rel: string): boolean => STYLESHEET_EXT.has(extOf(rel));
// A free-text codeToken ("bg-primary / text-primary/80", "hover:bg-x", "var(--x)", "brand-600") split into
// the names it stands for — ONE reading, shared by the definition check (F-31) and the undeclared-token
// check (F-124): split on whitespace, " / " and commas; strip variants (`hover:`), `!` and an opacity
// modifier (`/80`); `var(--x)` and `--x` name the custom property; a colour utility names `--color-<name>`
// (`builtin` when <name> is a Tailwind built-in colour, a width or an arbitrary value).
const COLOUR_UTILITY = /^(bg|text|border|ring|fill|stroke|outline|divide|placeholder|decoration|accent|caret|from|via|to|shadow)-(.+)$/;
const TW_PALETTE = /^(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}$/;
const TW_KEYWORD = new Set(["white", "black", "transparent", "current", "inherit"]);
interface TokenPart { text: string; prop: string | null; builtin: boolean }
function tokenParts(codeToken: string): TokenPart[] {
  const out: TokenPart[] = [];
  // `var(--x, fallback)` → `var(--x)` before splitting on commas
  for (const raw of codeToken.replace(/var\(\s*(--[\w-]+)\s*,[^)]*\)/g, "var($1)").split(/[\s,]+/)) {
    let t = raw.trim().toLowerCase().replace(/!$/, ""); // trailing `!` (Tailwind v4 important)
    if (!t || t === "/") continue;
    const v = /^var\((--[\w-]+)\)$/.exec(t);
    if (v && v[1]) { out.push({ text: v[1], prop: v[1], builtin: false }); continue; }
    if (t.startsWith("--")) { const n = t.replace(/:$/, ""); out.push({ text: n, prop: n, builtin: false }); continue; }
    t = t.slice(t.lastIndexOf(":") + 1).replace(/^!/, "").replace(/\/[\w.[\]%]+$/, "");
    const v4 = /^[a-z-]+-\((--[\w-]+)\)$/.exec(t); // Tailwind v4 `bg-(--brand)` reads the property directly
    if (v4 && v4[1]) { out.push({ text: t, prop: v4[1], builtin: false }); continue; }
    const name = COLOUR_UTILITY.exec(t)?.[2];
    if (!name) { out.push({ text: t, prop: null, builtin: false }); continue; }
    out.push({ text: t, prop: `--color-${name}`, builtin: TW_KEYWORD.has(name) || TW_PALETTE.test(name) || /^[\d.]+$|^\[/.test(name) });
  }
  return out;
}
// Every spelling a declaration of this token may carry: the whole codeToken, each part, each part's property.
const tokenCandidates = (codeToken: string): string[] => [...new Set([codeToken, ...tokenParts(codeToken).flatMap((p) => (p.prop ? [p.text, p.prop] : [p.text]))])];
function namesToken(name: string, codeToken: string, stylesheet: boolean): boolean {
  if (stylesheet && !name.startsWith("--")) return false;
  const declared = slug(name), dc = tokenCore(name);
  if (!declared) return false;
  return tokenCandidates(codeToken).some((c) => { const tc = tokenCore(c); return declared === slug(c) || (!!dc && dc === tc); });
}
// Is the occurrence of `literal` at `at` the value of a declaration of `codeToken`?
function declaresTokenAt(line: string, at: number, codeToken: string, stylesheet: boolean): boolean {
  const m = DECLARATION.exec(line.slice(0, at));
  return !!m && namesToken(m[2] ?? "", codeToken, stylesheet); // group 2 is not optional: set whenever the regex matched
}
// F-31: a line is a DEFINITION line for `literal` when EVERY occurrence of it on the line is the value of
// a declaration of one of `codeTokens` — every plan token that resolves to this literal, not only the
// row being checked: `--color-surface: #1d1d1f; --color-canvas: #1d1d1f;` defines two tokens that share
// a value, and neither definition is a "usage" of the other.
function definesAny(line: string, literal: string, codeTokens: readonly string[], stylesheet: boolean): boolean {
  let at = line.indexOf(literal);
  if (at === -1) return false;
  while (at !== -1) {
    if (!codeTokens.some((t) => declaresTokenAt(line, at, t, stylesheet))) return false;
    at = line.indexOf(literal, at + literal.length);
  }
  return true;
}

/** checkPlan()'s optional pre-located inputs (the CLI locates each once and passes them through).
 *  `graph`: the project graph over every plan's files[] (built on first use when absent) — one per hook run. */
export interface CheckPlanOptions { export?: ExportHit | null; reports?: ReportRef[]; graph?: () => ProjectGraph }
export interface TagCoverage { tagged: number; anchored: number }
export interface CheckPlanResult { blocking: string[]; warnings: string[]; tagCoverage?: TagCoverage }

const isAcknowledged = (row: PlanTokenRow): boolean => typeof row.acknowledged === "string" && !!row.acknowledged.trim();

function readFiles(rels: readonly string[], cwd: string): FileText[] {
  const out: FileText[] = [];
  for (const rel of rels) {
    const abs = path.join(cwd, rel);
    try { if (fs.statSync(abs).isFile()) out.push({ rel, text: fs.readFileSync(abs, "utf8") }); } catch { /* absent: reported for its own plan */ }
  }
  return out;
}

// ---------------------------------------------------------------- the project graph (F-43, F-58, F-124)
// Every plan's files[] under design/plan/, read once per hook run: their texts, how many plans list each
// file, and the import graph between the script files (each file's imports parsed once, then resolved
// through a path-suffix index — linear in files + imports, not files²).
const SCRIPT_RE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro)$/i;
export interface ProjectGraph {
  files: FileText[];
  /** how many plans list each file */
  listCount: Map<string, number>;
  kids: Map<string, string[]>;
  parents: Map<string, string[]>;
  byRel: Map<string, FileText>;
  /** the project's .css files and whether it has a tailwind.config.* (walked on first use) */
  scan: () => { css: FileText[]; tailwindConfig: boolean };
}
function buildGraph(cwd: string, extra: readonly string[] = []): ProjectGraph {
  const listCount = new Map<string, number>();
  for (const p of findPlans(cwd).plans) for (const f of new Set(p.plan.files || [])) listCount.set(f, (listCount.get(f) || 0) + 1);
  const files = readFiles([...new Set([...listCount.keys(), ...extra])], cwd);
  const byRel = new Map(files.map((f): [string, FileText] => [f.rel, f]));
  const scripts = files.filter((f) => SCRIPT_RE.test(f.rel));
  const lower = (segs: string[]): string => segs.map((x) => x.toLowerCase()).join("/");
  const bySuffix = new Map<string, string[]>(), byFull = new Map<string, string[]>();
  for (const f of scripts) {
    const segs = moduleSegments(f.rel);
    getOrInit(byFull, lower(segs), () => []).push(f.rel);
    for (let i = 0; i < segs.length; i++) getOrInit(bySuffix, lower(segs.slice(i)), () => []).push(f.rel);
  }
  const kids = new Map<string, string[]>(), parents = new Map<string, string[]>();
  for (const f of scripts) {
    const found = new Set<string>();
    for (const spec of cachedImports(f.text)) {
      const segs = spec.startsWith(".") ? moduleSegments(path.relative(cwd, path.resolve(cwd, path.dirname(f.rel), spec))) : moduleSegments(spec);
      if (!segs.length) continue;
      for (const r of bySuffix.get(lower(segs)) || []) found.add(r); // spec is a suffix of the file's path
      for (let i = 1; i < segs.length; i++) for (const r of byFull.get(lower(segs.slice(i))) || []) found.add(r); // the file's path is a suffix of the spec
    }
    found.delete(f.rel);
    kids.set(f.rel, [...found]);
    for (const r of found) getOrInit(parents, r, () => []).push(f.rel);
  }
  let scanned: { css: FileText[]; tailwindConfig: boolean } | null = null;
  // a Tailwind config is looked for directly at the root and at each listed file's package root, not
  // only by the (capped) walk
  const scan = (): { css: FileText[]; tailwindConfig: boolean } => {
    if (scanned) return scanned;
    const walked = projectScan(cwd);
    const dirs = new Set([path.resolve(cwd), ...files.map((f) => packageDirOf(cwd, f.rel))]);
    return (scanned = { css: walked.css, tailwindConfig: walked.tailwindConfig || [...dirs].some(hasTwConfig) });
  };
  return { files, listCount, kids, parents, byRel, scan };
}

// F-43: the files whose imports count for a plan whose files are `own`: its own files; the files they
// import (one hop — the shell a screen renders in); every ANCESTOR (a file that transitively imports one of
// them: App → router → routes → this page); and the files an ancestor imports — except another screen's
// own file (listed by exactly one plan, not this one): App → Page → {ScreenA, ScreenB} must not let plan A
// borrow ScreenB's imports, while App → AppShell (listed by several plans) → Sidebar does count. The reverse
// walk keeps a visited set, so an import cycle cannot loop.
function reachableFor(g: ProjectGraph, own: readonly string[]): FileText[] {
  const mine = new Set(own);
  const ancestors = new Set<string>();
  const queue = own.filter((r) => g.kids.has(r));
  for (let i = 0; i < queue.length; i++) {
    for (const par of g.parents.get(queue[i] ?? "") || []) if (!mine.has(par) && !ancestors.has(par)) { ancestors.add(par); queue.push(par); }
  }
  const out = new Set<string>([...mine, ...ancestors]);
  for (const r of mine) for (const k of g.kids.get(r) || []) out.add(k);
  const steppable = (r: string): boolean => mine.has(r) || (g.listCount.get(r) || 0) !== 1;
  for (const r of ancestors) for (const k of g.kids.get(r) || []) if (steppable(k)) out.add(k);
  return [...out].map((r) => g.byRel.get(r)).filter((f): f is FileText => !!f);
}

// ---------------------------------------------------------------- F-58: profile and tag coverage
// The plan's `target` ("web-tailwind", or {profile: "web-tailwind", …}), else design/target.json's `profile`.
function profileOf(plan: Plan, cwd: string): string | null {
  const t = plan.target;
  if (typeof t === "string" && t.trim()) return t.trim();
  if (t && typeof t === "object" && typeof t.profile === "string" && t.profile.trim()) return t.profile.trim();
  const doc = readJsonOrNull(path.join(cwd, "design", "target.json"), isJsonObject);
  return doc && typeof doc.profile === "string" && doc.profile.trim() ? doc.profile.trim() : null;
}
const isWebProfile = (p: string | null): boolean => !!p && /^web(-|$)/i.test(p);

// An anchored visible node is TAGGED when its id appears as a string literal in any scanned file (the
// attribute value itself, or an entry of a lookup table the attribute reads: `data-dt-node={IDS.row}`).
// Anchored = its own anchor maps it to code (mapModule/file/symbol; `omitted` is not built, so not
// counted); visible = drawn by the export (all anchored ids when the export cannot be found).
function tagCoverageOf(plan: Plan, exp: ExportHit | null, files: FileText[]): { tagged: number; anchored: number; attribute: boolean; untagged: string[] } {
  const anchors: Record<string, PlanAnchor> = plan.anchors || {};
  const vis = exp ? visibility(exp.doc).visible : null;
  const ids = Object.keys(anchors).filter((id) => { const a = anchors[id]; return anchored(a) && !(a && typeof a.omitted === "string" && a.omitted.trim()) && (!vis || vis.has(id)); });
  const attribute = files.some((f) => f.text.includes("data-dt-node"));
  // verify reads data-dt-node only: with the attribute nowhere, an id in some other attribute tags nothing.
  const untagged = attribute ? ids.filter((id) => !files.some((f) => f.text.includes(`"${id}"`) || f.text.includes(`'${id}'`) || f.text.includes("`" + id + "`"))) : ids;
  return { tagged: ids.length - untagged.length, anchored: ids.length, attribute, untagged };
}

// ---------------------------------------------------------------- F-124: colour tokens nothing declares
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "design", ".next", "out", "coverage", ".turbo", ".svelte-kit", ".nuxt", ".output",
  "Pods", ".venv", "venv", "vendor", "target", "tmp"]);
const TW_CONFIG = /^tailwind\.config\.(js|cjs|mjs|ts|mts|cts)$/i;
const hasTwConfig = (dir: string): boolean => { try { return fs.readdirSync(dir).some((n) => TW_CONFIG.test(n)); } catch { return false; } };
// The package root a file belongs to: the nearest directory up from it (not above cwd) with a package.json.
function packageDirOf(cwd: string, rel: string): string {
  const root = path.resolve(cwd);
  for (let d = path.dirname(path.resolve(cwd, rel)); d.startsWith(root); d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, "package.json"))) return d;
    if (d === root) break;
  }
  return root;
}
// The project's stylesheets, and whether it has a Tailwind v3 config (its colours live there, not in CSS vars).
function projectScan(cwd: string, limit = 2000): { css: FileText[]; tailwindConfig: boolean } {
  const css: FileText[] = [];
  let tailwindConfig = false;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (css.length >= limit) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(abs); }
      else if (e.isFile() && TW_CONFIG.test(e.name)) tailwindConfig = true;
      else if (e.isFile() && /\.css$/i.test(e.name)) {
        try { css.push({ rel: path.relative(cwd, abs).split(path.sep).join("/"), text: fs.readFileSync(abs, "utf8") }); } catch { /* unreadable: skip */ }
      }
    }
  };
  walk(cwd);
  return { css, tailwindConfig };
}
// Every CSS custom property DECLARED in a text (`--color-x:`), comments stripped.
function declaredCustomProps(files: FileText[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    const text = isSourceFile(f.rel) ? scanText(f.rel, f.text) : f.text;
    for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) { const n = m[1]; if (n !== undefined) out.add(n.toLowerCase()); }
  }
  return out;
}
// What a codeToken needs declared (tokenParts): a custom property for `--x` / `var(--x)`, `--color-<name>`
// for a colour utility that is not a Tailwind built-in. Anything else (a bare name, `Color.brand`) is not checked.
const requiredCustomProps = (codeToken: string): string[] => [...new Set(tokenParts(codeToken).filter((p) => p.prop && !p.builtin).map((p) => String(p.prop)))];
// F-124: a colour row's codeToken whose custom property no file declares — the utility or variable it
// names renders nothing (a hand-written @theme without the alias). Not checked in a project with a
// tailwind.config.* (Tailwind v3: colours are configured there, not declared as CSS variables).
function undeclaredColourTokens(live: PlanTokenRow[], g: ProjectGraph): string[] {
  const colour = [...new Set(live.filter((r) => hasToken(r) && String(r.kind).toLowerCase() === "color").map((r) => String(r.codeToken).trim()))];
  const wanted = colour.map((t) => ({ t, props: requiredCustomProps(t) })).filter((x) => x.props.length);
  if (!wanted.length) return [];
  const scan = g.scan();
  if (scan.tailwindConfig) return [];
  const declared = declaredCustomProps([...g.files, ...scan.css]);
  const missing = wanted.filter((x) => x.props.some((p) => !declared.has(p)));
  if (!missing.length) return [];
  const show = missing.slice(0, 8).map((x) => `'${x.t}' (needs ${x.props.filter((p) => !declared.has(p)).join(", ")})`).join(", ");
  return [`${missing.length} colour code token(s) are declared nowhere — not in any plan's files[] nor in a .css file of the project: ${show}${missing.length > 8 ? `, +${missing.length - 8} more` : ""} — a utility or variable with no definition renders nothing; add the alias to the theme (e.g. in the @theme block the tokens script writes)`];
}

// ---------------------------------------------------------------- F-54: a deviation that contradicts the plan
const STYLE_FIELDS = new Set(["effects", "shadow", "fill", "fills", "stroke", "strokes", "radius", "cornerradius", "opacity", "padding", "gap", "font",
  "typography", "color", "background", "border", "blur", "size", "width", "height", "fontsize", "fontweight", "lineheight", "letterspacing",
  "borderradius", "borderwidth", "textalign", "textcase"]);
function deviationConflicts(plan: Plan): string[] {
  const out: string[] = [];
  const anchors: Record<string, PlanAnchor> = plan.anchors || {};
  (plan.deviations || []).forEach((d, i) => {
    if (!d) return;
    // Only a WHOLE-NODE omission: `built` says nothing was built, and the field is not a style
    // sub-property (a reused card whose shadow was not built is a field-level change, not the card left out).
    // the LAST segment of a path-like field: `style.shadow` → shadow, `fills[0]` → fills
    const field = typeof d.field === "string" ? (d.field.trim().toLowerCase().split(/[.[\]\s/]+/).filter(Boolean).pop() ?? "") : "";
    if (STYLE_FIELDS.has(field)) return;
    const built = d.built;
    const omitted = built === null || built === false || (typeof built === "string" && /^(omitted|not built|not rendered|removed)/i.test(built.trim()));
    if (!omitted) return;
    const ids = [...(typeof d.nodeId === "string" && d.nodeId ? [d.nodeId] : []), ...(Array.isArray(d.nodeIds) ? d.nodeIds : [])];
    for (const id of ids) {
      const comp = (plan.components || []).find((c) => c.nodeId === id && verdictOf(c) === "reused");
      const a = anchors[id];
      const mod = a && typeof a.mapModule === "string" && a.mapModule.trim() ? a.mapModule : null;
      if (!comp && !mod) continue;
      const says = [comp ? `components[] marks '${comp.name}' "reused"${comp.mapModule ? ` from ${comp.mapModule}` : ""}` : null, mod ? `anchors["${id}"] maps it to ${mod}` : null].filter(Boolean).join(" and ");
      out.push(`deviation #${i}${d.id ? ` (${d.id})` : ""} says node ${id} was not built, but ${says} — one of them is wrong: if it was left out, anchor it as {"omitted": "<why>"} and drop the reuse claim; if it was built, correct the deviation`);
    }
  });
  return out;
}

// Returns { blocking: [...], warnings: [...] }.
// Its `blocking` messages are SAVED into the plan (verification.hook.blocking), a file users commit: name
// scripts in words here, never with scriptCmd() — that is a per-machine, per-plugin-version absolute path.
function checkPlan({ plan, file }: PlanFile, cwd: string, opts?: CheckPlanOptions): CheckPlanResult {
  const o = opts || {};
  const blocking: string[] = [], warnings: string[] = [];
  const listed = plan.files || [];
  const absent = listed.filter((f) => !fs.existsSync(path.join(cwd, f)));
  if (!listed.length) warnings.push("`files` is empty — list every file this build created or changed; the literal and import checks only read the files named there, so nothing was checked");
  if (absent.length) warnings.push(`file(s) listed in \`files\` not found on disk: ${absent.join(", ")} — fix the path(s) (relative to the project root) or remove entries for files that were not written`);

  const byFile: FileText[] = listed.filter((rel) => fs.existsSync(path.join(cwd, rel)) && fs.statSync(path.join(cwd, rel)).isFile())
    .map((rel) => ({ rel, text: fs.readFileSync(path.join(cwd, rel), "utf8") }));
  const code: FileText[] = byFile.filter((f) => isSourceFile(f.rel)).map((f) => ({ rel: f.rel, text: scanText(f.rel, f.text) }));
  const source = code.map((f) => f.text).join("\n");

  const allowed = new Set((plan.allowedLiterals || []).filter((a) => a && a.reason && a.value !== undefined).map((a) => String(a.value).toLowerCase()));
  const allowedFiles = (plan.allowedLiterals || []).filter((a) => a && a.reason && a.file).map((a) => String(a.file));
  const isAllowed = (row: PlanTokenRow, literal: string): boolean => allowed.has(String(row.value).toLowerCase()) || allowed.has(String(literal).toLowerCase());
  // `codeTokens`: every plan token that resolves to this literal's value (F-31) — a line defining any of them is a definition.
  function definedOnlyInTokenSource(literal: string, codeTokens: readonly string[]): boolean {
    if (!literal) return false;
    let seen = false;
    for (const f of code) {
      if (!f.text.includes(literal)) continue;
      if (allowedFiles.includes(f.rel)) { seen = true; continue; }
      for (const line of f.text.split("\n")) {
        if (!line.includes(literal)) continue;
        if (!definesAny(line, literal, codeTokens, isStylesheet(f.rel))) return false;
        seen = true;
      }
    }
    return seen;
  }

  const tokens = plan.tokens || [];
  const live = tokens.filter((r) => verdictOf(r) !== "hidden-only");
  const colourTokensOf = (key: string): string[] => [...new Set(live.filter((r) => hasToken(r) && String(r.kind).toLowerCase() === "color" && colorKey(r.value) === key).map((r) => String(r.codeToken)))];
  const dimTokensOf = (n: number): string[] => [...new Set(live.filter((r) => hasToken(r) && String(r.kind).toLowerCase() !== "color" && parseFloat(String(r.value)) === n).map((r) => String(r.codeToken)))];
  // One message, however many rows: a fresh plan-skeleton plan has every row unfilled, and 33 lines
  // of the same sentence would bury the two things that actually block.
  const undecided = live.filter((row) => (verdictOf(row) === "missing" || !hasToken(row)) && !row.decision);
  if (undecided.length) {
    const show = undecided.slice(0, 8).map((row) => `${row.figmaName ? `'${row.figmaName}' ` : ""}${String(row.value)} (${row.kind})`).join(", ");
    warnings.push(`${undecided.length} token row(s) have no token and no recorded decision: ${show}${undecided.length > 8 ? `, +${undecided.length - 8} more` : ""} — fill codeToken, or say what you did about it in \`decision\` (a one-off literal is a legitimate answer; say so)`);
  }

  // Token IDENTITY: two DIFFERENT Figma tokens on one code token (finding 130 — right, and kept).
  // F-43: a row carrying `"acknowledged": "<why>"` is a merge a person decided on — it is left out.
  for (const row of live) if (row.acknowledged !== undefined && !isAcknowledged(row)) warnings.push(`token row '${row.figmaName || String(row.value)}' has an empty \`acknowledged\` — say why the shared code token is right, or remove the field`);
  const byCodeToken = new Map<string, Map<string, PlanTokenRow["value"]>>();
  for (const row of live) {
    if (!hasToken(row) || !row.figmaName || isAcknowledged(row)) continue;
    const c = String(row.codeToken).trim();
    const names = byCodeToken.get(c) || new Map<string, PlanTokenRow["value"]>();
    if (!names.has(row.figmaName)) names.set(row.figmaName, row.value);
    byCodeToken.set(c, names);
  }
  for (const [c, names] of byCodeToken) {
    if (names.size < 2) continue;
    const l = [...names].map(([n, v]) => `'${n}' (${String(v)})`).join(" and ");
    warnings.push(`code token '${c}' is mapped from ${names.size} DIFFERENT Figma tokens — ${l}. They may share a value in the exported mode, but they are separate tokens and will diverge in another mode/theme; give each its own code token named after its own Figma name (or, if sharing is deliberate, add "acknowledged": "<why>" to the row that shares it)`);
  }

  // BLOCK 1: an unexplained colour literal. One message per LITERAL, however many plan rows resolve it
  // (finding 100 raised two problems for one comment).
  const colors = colorLiterals(source);
  const colourHits = new Map<string, { value: PlanTokenRow["value"]; tokens: string[]; defs: string[] }>();
  for (const row of live) {
    if (!hasToken(row) || String(row.kind).toLowerCase() !== "color") continue;
    const h = colorKey(row.value);
    const lit = h && colors.get(h);
    if (h && lit && !isAllowed(row, lit) && !definedOnlyInTokenSource(lit, colourTokensOf(h))) {
      const e = getOrInit(colourHits, lit, () => ({ value: row.value, tokens: [], defs: colourTokensOf(h) }));
      if (!e.tokens.includes(row.codeToken)) e.tokens.push(row.codeToken);
    }
  }
  for (const [lit, e] of colourHits) {
    // Finding 325: name only files that USE the literal — not an allow-listed token file, not a file
    // where every occurrence is a token's own definition line.
    const where = code.filter((f) => f.text.includes(lit) && !allowedFiles.includes(f.rel)
      && !f.text.split("\n").filter((l) => l.includes(lit)).every((l) => definesAny(l, lit, e.defs, isStylesheet(f.rel)))).map((f) => f.rel);
    // F-31: a block must name where the literal is used. No such file means every occurrence is a
    // definition or allow-listed — nothing to fix, so nothing to block on.
    if (!where.length) continue;
    blocking.push(`raw colour ${lit} in ${where.join(", ")}, but the plan resolved ${String(e.value)} to token ${e.tokens.map((t) => `'${t}'`).join(" / ")} — use the token, not the literal (comments, prose strings and non-source files such as .svg are not scanned). A value that must stay literal goes in allowedLiterals as {"value": "${lit}", "reason": "…"}, matched on the exact value string, or name the file that defines the tokens: {"file": "…", "reason": "…"}`);
  }

  const dims = arbitraryPx(source);
  for (const row of live) {
    if (!hasToken(row) || String(row.kind).toLowerCase() === "color") continue;
    const n = parseFloat(String(row.value));
    const hits = Number.isFinite(n) ? dims.get(n) || [] : [];
    const hit = hits.find((e) => kindsCompatible(e.utility, row.kind) && !isAllowed(row, e.literal) && !definedOnlyInTokenSource(e.literal, dimTokensOf(n)));
    if (hit) warnings.push(`arbitrary value ${hit.utility ? `${hit.utility}-${hit.literal}` : hit.literal} in built code, but the plan resolved ${String(row.value)} (${row.kind}) to token '${String(row.codeToken)}' — use the token (or add it to allowedLiterals with a reason)`);
  }

  // Every plan's files[] under design/plan/ (this one's included): a shared shell lives in another plan's
  // files, and the import check (F-43), the tag count (F-58) and the declared-token check (F-124) see it.
  let built: ProjectGraph | null = null;
  const graph = (): ProjectGraph => built || (built = o.graph ? o.graph() : buildGraph(cwd, listed));
  const sharedByFile = (): FileText[] => graph().files.filter((f) => !listed.includes(f.rel));
  let reach: FileText[] | null = null;
  const reachable = (): FileText[] => reach || (reach = reachableFor(graph(), listed));

  const mapped = loadMapKeys(cwd);
  const seenModule = new Set<string>();
  for (const row of plan.components || []) {
    const verdict = verdictOf(row);
    if (verdict === "reused" && row.mapModule && !seenModule.has(row.mapModule)) {
      seenModule.add(row.mapModule);
      // F-43: see reachableFor — this plan's files, what they import, and the app shell that renders them.
      if (!moduleImported(row.mapModule, byFile, cwd) && !moduleImported(row.mapModule, reachable(), cwd)) warnings.push(`component '${row.name}' is "reused" from ${row.mapModule}, but no file in files[] imports that module (neither this plan's files, nor a plan file they import, nor one that renders them — an app shell — or its direct imports; compared by resolved path / path suffix, so '../../components/X' and '@/components/X' both count) — was it regenerated instead of reused? If it is rendered by a shared layout above this screen (e.g. an app shell), list that layout file in this plan's files[] too`);
    }
    const mappedTo = verdict === "new" && row.key ? mapped.get(row.key) : undefined;
    if (mappedTo) {
      warnings.push(`component '${row.name}' is marked "new" in the plan, but its Figma key is mapped to ${mappedTo.module} in codeconnect.local.json — reuse the existing component`);
    }
    if (verdict === "missing") warnings.push(`component '${row.name}' has no recorded reuse/new decision`);
  }

  // BLOCK 2: every visible design node has an anchor (itself or an ancestor).
  const exp = o.export === undefined ? locateExport(plan, file, cwd) : o.export;
  if (!exp) {
    warnings.push(`could not find this plan's screen export (no \`file\`/\`nodeId\` header, and no node id in its name) — the anchor check did not run; the plan-skeleton script writes the header`);
  } else {
    const cov = anchorCoverage(plan, exp.doc);
    if (cov.unmapped.length) {
      const show = cov.unmapped.slice(0, 10).map((u) => `${u.id} '${String(u.name).trim()}' (${u.type})`).join(", ");
      blocking.push(`${cov.unmappedNodes} visible design node(s) have no anchor in the plan — neither they nor any ancestor map to code. Top of each unmapped subtree: ${show}${cov.unmapped.length > 10 ? `, +${cov.unmapped.length - 10} more` : ""}. Add anchors["<id>"] = {"mapModule": "<the file that renders it>"} on the subtree's top (children inherit it), or {"omitted": "<why it is not built>"} — the plan-skeleton script lists every visible node`);
    }
    if (cov.wrappers.length) warnings.push(`${cov.wrappers.length} visible container(s) have anchored children but no anchor of their own (e.g. ${cov.wrappers.slice(0, 3).map((w) => `${w.id} '${String(w.name).trim()}'`).join(", ")}) — anchor the frame to the screen component so sync-design can place a change to it`);
    if (cov.hiddenAnchored.length) warnings.push(`${cov.hiddenAnchored.length} anchor(s) point at HIDDEN nodes (${cov.hiddenAnchored.slice(0, 4).join(", ")}${cov.hiddenAnchored.length > 4 ? ", …" : ""}) — hidden layers are not built; remove them`);
    if (cov.unknown.length) warnings.push(`${cov.unknown.length} anchor(s) name node ids that are not on this frame (${cov.unknown.slice(0, 4).join(", ")}${cov.unknown.length > 4 ? ", …" : ""}) — e.g. a shared shell tagged with another frame's instance ids; anchor THIS frame's ids`);
  }

  // F-58: web tag coverage. F-124: colour code tokens nothing declares.
  let tagCoverage: TagCoverage | undefined;
  if (isWebProfile(profileOf(plan, cwd))) {
    const optOut = plan.tagging;
    const reason = optOut && optOut.off === true && typeof optOut.reason === "string" ? optOut.reason.trim() : "";
    if (optOut && optOut.off === true && !reason) warnings.push("`tagging.off` is set with no `reason` — the opt-out is ignored until it says why this project cannot carry data-dt-node tags");
    if (!reason && listed.length) { // no files[] at all is the "`files` is empty" warning, not a tag block
      const tagged = tagCoverageOf(plan, exp, [...code, ...sharedByFile().filter((f) => isSourceFile(f.rel)).map((f) => ({ rel: f.rel, text: scanText(f.rel, f.text) }))]);
      if (tagged.anchored > 0) {
        tagCoverage = { tagged: tagged.tagged, anchored: tagged.anchored };
        const pct = Math.round((100 * tagged.tagged) / tagged.anchored);
        const how = "tag every element that implements a design node one-to-one with data-dt-node=\"<node id>\" (an id from a lookup table counts: the id string only has to appear in a listed file), so the verify step measures the right element instead of guessing";
        if (!tagged.attribute) blocking.push(`web build with no data-dt-node tags: none of the files in any plan's files[] carries the attribute, so 0 of ${tagged.anchored} anchored visible node(s) can be measured — ${how}. A project that genuinely cannot tag records "tagging": {"off": true, "reason": "…"} in the plan`);
        else if (tagged.tagged * 2 < tagged.anchored) warnings.push(`data-dt-node tag coverage is ${tagged.tagged}/${tagged.anchored} anchored visible node(s) (${pct}%), below 50% — ${how}${tagged.untagged.length ? `; untagged e.g. ${tagged.untagged.slice(0, 5).join(", ")}` : ""}`);
      }
    }
  }
  warnings.push(...undeclaredColourTokens(live, graph()));

  warnings.push(...checkVerification(plan, cwd));
  warnings.push(...verificationWarnings(plan));
  warnings.push(...verificationContradictions(plan, o.reports || locateReports(plan, file, cwd, exp)));
  warnings.push(...deviationWarnings(plan));
  warnings.push(...deviationConflicts(plan));
  warnings.push(...validatePlanHeader(plan));
  warnings.push(...auditGateWarnings(plan, cwd, exp));
  // One line per distinct message (F-45: the same sentence repeated is noise that buries the real ones).
  return { blocking: [...new Set(blocking)], warnings: [...new Set(warnings)], ...(tagCoverage ? { tagCoverage } : {}) };
}

// Finding 136: only a WARNING (this file blocks on a raw colour, an unanchored node and — web — no tags at all). When design/audit/<screen>.json (or a legacy-named audit) has blocker(s) and the
// plan has no auditGate covering them, a build reading a Blocked audit and proceeding would otherwise
// be indistinguishable, on disk, from one that never read it.
// (audit-gate.ts is a static import now; the CJS version's lazy require — and its "could not load →
// no warnings" fallback — is gone, since a static import cannot fail at this point.)
function auditGateWarnings(plan: Plan, cwd: string, exp: ExportHit | null | undefined): string[] {
  const screenFile = plan.file ? path.resolve(cwd, plan.file) : null;
  const screenName = plan.screenName || (exp && exp.layerName) || null;
  let g: ReturnType<typeof auditGateStatus>;
  try { g = auditGateStatus(cwd, screenFile, screenName); } catch { return []; }
  // An audit file that is there but cannot be read gates nothing — say so rather than read it as "no blockers".
  if (g.auditFile && g.unreadable) return [`${g.auditFile} ${g.error || "could not be read"} — the audit gate was NOT checked; re-run the audit script for this screen`];
  if (!g.auditFile || !g.blockers.length) return [];
  const gate = plan.auditGate;
  if (!gate) {
    return [`${g.auditFile} is Blocked (${g.blockers.length} blocker(s): ${g.blockers.join(", ")}) and this plan has no \`auditGate\` — either resolve the blocker(s) or record {auditGate:{auditFile,verdict,overridden:[...],reason,decidedBy,decidedAt}} naming which one(s) were acknowledged and why`];
  }
  const overridden = new Set(Array.isArray(gate.overridden) ? gate.overridden : []);
  const uncovered = g.blockers.filter((id) => !overridden.has(id));
  if (uncovered.length) return [`${g.auditFile} has ${uncovered.length} blocker(s) not listed in this plan's auditGate.overridden: ${uncovered.join(", ")} — either resolve them or add them with a reason`];
  if (!gate.reason) return [`this plan's auditGate overrides ${overridden.size} blocker(s) but gives no \`reason\` — say why it is safe to build past ${g.auditFile}`];
  return [];
}

// ================================================================ the verify report behind a plan

// Reports are found by name first — `<Layer>__<id>` (verify-screen's default --out since P3), the plan's
// own name, its `screen` — then by content: a report whose `nodeId` is the plan's, whose sibling
// `<stem>.expected.json` is this frame's (`frame.nodeId`, verify-expectation@2), or whose `screen` is
// the frame's layer name when that name is unique in the export (the pre-P3 `JobRoles.report.json`
// naming carries only the layer name). Every match counts; ONE failing report is enough to fail.
// Both report shapes are read: @1 (`verdict`, `why`) and @2 (`verdict` pass|pass-with-deviations|fail|
// incomplete, `headline`, `inputs.expectationSha256` — the expectation it was computed against,
// `inputs.waivers.sha256` — the plan waivers/descopes it applied).
function locateReports(plan: Plan, planFile: string | undefined, cwd: string, exp: ExportHit | null | undefined): ReportRef[] {
  const dir = path.join(cwd, "design", "verify");
  if (!fs.existsSync(dir)) return [];
  const e = exp === undefined ? locateExport(plan, planFile, cwd) : exp;
  const stems = new Set([
    plan.file ? path.basename(String(plan.file)).replace(/\.json$/i, "") : null,
    e ? path.basename(e.file).replace(/\.json$/i, "") : null,
    planFile ? path.basename(planFile, ".json") : null,
    plan.screen ? String(plan.screen) : null,
  ].filter((s): s is string => !!s));
  const nodeId = plan.nodeId || (e && e.nodeId) || idFromStem(plan.screen) || (planFile ? idFromStem(path.basename(planFile, ".json")) : null);
  const layer = e ? e.layerName.trim() : null;
  const out: ReportRef[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".report.json")).sort()) {
    const abs = path.join(dir, f);
    const r = readJsonOrNull(abs, isVerifyReport);
    if (!r) continue;
    const stem = f.replace(/\.report\.json$/, "");
    let by: ReportMatch | null = null;
    const expFile = path.join(dir, stem + ".expected.json");
    // Only the expectation's frame.nodeId is read here, so only that is required of the file.
    const expFrame = (): string | null => { const x = readJsonOrNull(expFile, isJsonObject); return x && isJsonObject(x.frame) && typeof x.frame.nodeId === "string" ? x.frame.nodeId : null; };
    if (stems.has(stem)) by = "name";
    else if (nodeId && (r.nodeId === nodeId || idFromStem(stem) === nodeId)) by = "nodeId";
    else if (nodeId && fs.existsSync(expFile) && expFrame() === nodeId) by = "expectation frame";
    else if (e && layer && e.sameNameRows <= 1 && String(r.screen || "").trim() === layer) by = "layer name";
    if (!by) continue;
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(abs).mtimeMs; } catch { /* ignore */ }
    // @2: which expectation the report was computed against, and whether that file still says the same
    const want = r.inputs && r.inputs.expectationSha256;
    let expectationChanged = false;
    if (want && fs.existsSync(expFile)) { try { expectationChanged = crypto.createHash("sha256").update(fs.readFileSync(expFile)).digest("hex") !== want; } catch { /* ignore */ } }
    out.push({ rel: path.relative(cwd, abs).split(path.sep).join("/"), matchedBy: by, schema: r.schema || null, verdict: r.verdict || null, headline: r.headline || null,
      why: r.why || [], deltas: r.deltas || null, exportedAt: r.exportedAt || null, measuredAt: r.measuredAt || null, mtimeMs,
      exportContentSha256: (r.inputs && r.inputs.exportContentSha256) || null, code: (r.inputs && r.inputs.code) || null,
      expectationChanged, expectationRel: expectationChanged ? path.relative(cwd, expFile).split(path.sep).join("/") : null,
      waiversSha256: (r.inputs && r.inputs.waivers && typeof r.inputs.waivers.sha256 === "string" && r.inputs.waivers.sha256) || null });
  }
  return out;
}

// ================================================================ computed status

interface Verdict { status: PlanComputedStatus; reasons: string[] }

// What the verify report(s) say about this plan, on their own: { status, reasons }. status is one of
// failed | unverified | static-only | verified | verified-with-deviations. Never empty reasons.
// A report that recorded no inputs.waivers (older than group 9) applied none: it stays fresh while the
// plan has none, and goes stale once the owner accepts one.
const NO_WAIVERS = waiversHash(null);
const waiversChanged = (r: ReportRef, now: string): boolean => (r.waiversSha256 || NO_WAIVERS) !== now;
const WAIVERS_CHANGED = "waivers changed since the last compare — re-run --compare (with --plan <plan.json> when several plans describe the frame)";
function reportVerdict(plan: Plan, cwd: string, exp: ExportHit | null, reports: ReportRef[]): Verdict {
  const v = plan.verification;
  if (!reports.length) {
    if (v && v.mode === "static-only") return { status: "static-only", reasons: [`built and checked statically — not rendered (${v.reason || "no reason recorded"})`] };
    return { status: "unverified", reasons: [`no verify report found for this screen in design/verify/ — run ${scriptCmd("verify-screen")} --expect/--compare (the report's verdict is what grants "verified")`] };
  }
  // Finding 316: a report older than verify-report@2 counted hidden layers as "never built" / "failed"
  // (0-for-83 wrong on the live run). Its figures are not repeated as fact — only its verdict, labelled.
  const legacy = reports.filter((r) => r.schema !== REPORT_SCHEMA_V2);
  if (legacy.length) return { status: "unverified", reasons: legacy.map((r) => `${r.rel} is ${r.schema || "an unversioned report"} (its verdict: ${JSON.stringify(r.verdict)}) — it predates ${REPORT_SCHEMA_V2}, whose counts exclude hidden layers, so its verdict and figures are not reliable. Regenerate it: ${scriptCmd("verify-screen")} --expect, then --compare`) };
  const said = (r: ReportRef): string => `${r.rel} says verdict ${JSON.stringify(r.verdict)}${r.headline ? ` (${r.headline})` : r.why.length ? `: ${r.why.join("; ")}` : ""}`;
  const waiversNow = waiversHash(plan);
  const failing = reports.filter((r) => r.verdict === "fail");
  // A fail stays a fail until it is re-compared — but say when the owner has since accepted something.
  if (failing.length) return { status: "failed", reasons: failing.map((r) => said(r) + (waiversChanged(r, waiversNow) ? ` — ${WAIVERS_CHANGED}` : "")) };
  // "incomplete" (@2: nothing failed, but not everything was measured/probed) or no verdict at all is
  // not a pass — and not a failure the build caused either.
  const notPass = reports.filter((r) => !isPassingVerdict(r.verdict));
  if (notPass.length) return { status: "unverified", reasons: notPass.map(said) };
  // Freshness is decided by CONTENT, never by a clock (findings 314/317): not exportedAt (a no-change
  // re-pull rewrites it), not mtimes (a `touch` or a fresh clone reorders them).
  const expSha = exp && exp.doc ? contentHash.exportContentSha256(exp.doc) : null;
  for (const r of reports) {
    if (!r.exportContentSha256) {
      if (r.expectationChanged) return { status: "unverified", reasons: [`${r.rel} was computed against a different ${r.expectationRel} than the one on disk (inputs.expectationSha256 no longer matches) — re-run --compare`] };
      return { status: "unverified", reasons: [`${r.rel} does not record the content hash of the export it measured (inputs.exportContentSha256) — re-run ${scriptCmd("verify-screen")} --expect and --compare`] };
    }
    if (!expSha) return { status: "unverified", reasons: [`cannot find this plan's screen export to compare with ${r.rel}'s inputs.exportContentSha256 — give the plan its \`file\` header`] };
    if (r.exportContentSha256 !== expSha) return { status: "unverified", reasons: [`the design changed since ${r.rel} was computed (export content sha256 ${r.exportContentSha256.slice(0, 12)}… → ${expSha.slice(0, 12)}…, timestamps ignored) — re-run --expect and --compare`] };
    const measured = r.code && r.code.files && typeof r.code.files === "object" ? r.code.files : null;
    if (!measured) return { status: "unverified", reasons: [`${r.rel} does not record which code it measured (inputs.code) — re-run ${scriptCmd("verify-screen")} --compare from the project root, where design/plan/ lists this screen's files`] };
    const now = fileHashes(plan, cwd);
    const differ = Object.keys(now).filter((f) => measured[f] !== now[f]);
    if (differ.length) return { status: "unverified", reasons: [`${r.rel} measured different code — changed since: ${differ.slice(0, 6).join(", ")}${differ.length > 6 ? `, +${differ.length - 6} more` : ""} — re-run --compare`] };
    if (waiversChanged(r, waiversNow)) return { status: "unverified", reasons: [`${r.rel}: ${WAIVERS_CHANGED} (the plan's waivers[]/descopes[] are not the ones the report applied)`] };
  }
  const head = reports.map((r) => r.code && r.code.gitHead).find(Boolean);
  const withDeviations = reports.filter((r) => r.verdict === "pass-with-deviations");
  const says = withDeviations.length ? `says pass (${withDeviations.map((r) => r.rel).join(", ")}: pass-with-deviations — accepted deltas / descoped interactions are listed in the report)` : "says pass";
  return { status: withDeviations.length ? "verified-with-deviations" : "verified", reasons: [`${reports.map((r) => r.rel).join(", ")} ${says} and measured this design and exactly these files (by content)${head ? ` — at git ${head.slice(0, 12)}` : ""}`] };
}

/** computeStatus()'s options: where the plan lives (for locating its export/reports), or those pre-located. */
export interface StatusOptions { cwd?: string; planFile?: string; export?: ExportHit | null; reports?: ReportRef[] }
export interface StatusResult { status: PlanComputedStatus; reasons: string[]; reports: ReportRef[] }

// The computed status. PRECEDENCE (first match wins; also in --status --help):
//   1. abandoned / awaiting-user  — set by a person; nothing is evaluated
//   2. failed    — a verify report (schema @2) for this screen says fail: a measured defect is never
//                  hidden behind the hook's state
//   3. blocked   — the Stop hook's last check blocked
//   4. stale     — a file in files[] changed since the hook passed
//   5. pending   — the hook has not checked this version of the plan
//   6. unverified / static-only / verified / verified-with-deviations — what the report says (see reportVerdict)
// `reasons` is never empty for a non-verified status: it always carries the hook's state AND what the
// report(s) say (a report too old to trust is named with its schema), plus a note when a stored
// "verified"/"static-only" was ignored.
function computeStatus(plan: Plan, opts?: StatusOptions): StatusResult {
  const o = opts || {};
  const cwd = o.cwd || (o.planFile ? rootOfPlan(o.planFile) : process.cwd());
  const notes: string[] = [];
  const stored = String((plan && plan.status) || "").trim().toLowerCase();
  if (COMPUTED_STORED.has(stored)) notes.push(`the stored "status": "${plan.status}" was not confirmed by the current hook and is ignored — status is computed, never stored`);
  const life = lifecycleOf(plan);
  if (life !== "pending") return { status: life, reasons: [life === "abandoned" ? "retired by hand (\"status\": \"abandoned\")" : "paused on a question for the user (\"status\": \"awaiting-user\")"], reports: [] };
  const exp = o.export === undefined ? locateExport(plan, o.planFile, cwd) : o.export;
  const reports = o.reports || locateReports(plan, o.planFile, cwd, exp);
  const rv = reportVerdict(plan, cwd, exp, reports);
  const hook = plan.verification && plan.verification.hook;
  let hookState: PlanComputedStatus | null = null, hookWhy: string[] = [];
  if (!hook || !hook.result) { hookState = "pending"; hookWhy = ["the build-screen Stop hook has not checked this plan"]; }
  else if (hook.planHash && hook.planHash !== planHash(plan)) { hookState = "pending"; hookWhy = ["the plan changed after the hook's last check"]; }
  else if (hook.result !== "pass") { hookState = "blocked"; hookWhy = hook.blocking && hook.blocking.length ? hook.blocking : ["the hook's last check blocked"]; }
  else {
    const ch = changedFiles(plan, cwd) || [];
    if (ch.length) { hookState = "stale"; hookWhy = [`file(s) changed since the hook passed: ${ch.slice(0, 6).join(", ")}${ch.length > 6 ? `, +${ch.length - 6} more` : ""}`]; }
  }
  const reportWhy = rv.reasons.map((r) => (hookState ? "report: " : "") + r);
  if (rv.status === "failed") return { status: "failed", reasons: notes.concat(reportWhy, hookWhy.map((h) => "hook: " + h)), reports };
  if (hookState) return { status: hookState, reasons: notes.concat(hookWhy, reportWhy), reports };
  return { status: rv.status, reasons: notes.concat(rv.status === "verified" || rv.status === "verified-with-deviations" ? ["hook passed; " + rv.reasons[0]] : rv.reasons), reports };
}

// ================================================================ fan-out scoping

// Several screens build in parallel (one screen-builder each), and every one lands here when it
// stops. Narrow to the plans the stopping agent's own transcript mentions (a subagent's own transcript
// when the payload names one, else the session's). A transcript that mentions NO plan file checks
// NOTHING (F-45): build-screen's Stop hook is skill-scoped, so it also fires in an orchestrator session
// that loaded the skill and built nothing itself — it must not block that session on a plan another
// agent is still filling. A transcript that mentions only plans the hook already closed narrows to
// nothing too: agent A, finished, is not blocked on agent B's half-built plan. `scope: "unscoped"` means
// the payload carried no readable transcript at all (a hand-piped `{"cwd": …}`): every open plan is checked.
export type PlanScope = "unscoped" | "none-named" | "named";
// OWNERSHIP (F-45). A plan is this session's when the session's OWN tool calls (message.content[] tool_use
// items; for the session transcript, not a subagent's sidechain entries) either
//   (a) WRITE the plan; or
//   (b) WRITE a file that exactly ONE open plan lists in files[] — a builder or fixer editing that
//       screen's code. A file several plans list (a shared component) claims none of them.
// "Write" = a Write/Edit/MultiEdit/NotebookEdit of the path, or a Bash command that writes it (see
// bashWriteTargets; a path merely inside a heredoc body or echo text does not count). Not prose, not an
// Agent/Task prompt (an orchestrator naming the plan a subagent should fill), not a tool_result (a
// subagent's report). Relative paths resolve against the transcript entry's own `cwd`, else the payload's
// (so `cd design/plan && echo {} > x.json` in ONE command is missed — accepted: fail-open). Separators
// are normalised; a Windows drive path from another machine matches by its project-relative tail.
// Nothing claimed → nothing checked, by design: the screen-builder's SubagentStop still gates delegated builds.
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** A path the session wrote, and the directory it was relative to (the entry's `cwd`, when recorded). */
export interface WrittenPath { path: string; base: string | null }
function transcriptActions(text: string, ownOnly: boolean): WrittenPath[] {
  const out: WrittenPath[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let v: unknown = null;
    try { const parsed: unknown = JSON.parse(line); v = parsed; } catch { continue; }
    if (!isJsonObject(v) || (ownOnly && v.isSidechain === true) || !isJsonObject(v.message) || !Array.isArray(v.message.content)) continue;
    for (const item of v.message.content) {
      if (!isJsonObject(item) || item.type !== "tool_use" || typeof item.name !== "string" || !isJsonObject(item.input)) continue;
      const inp = item.input;
      const base = typeof v.cwd === "string" && v.cwd ? v.cwd : null;
      if (WRITE_TOOLS.has(item.name)) { for (const k of ["file_path", "notebook_path"]) { const f = inp[k]; if (typeof f === "string") out.push({ path: f, base }); } }
      else if (item.name === "Bash" && typeof inp.command === "string") for (const f of bashWriteTargets(inp.command)) out.push({ path: f, base });
    }
  }
  return out;
}

// The paths a shell command writes (see OWNERSHIP): after `>`/`>>`; after `tee`; after `--out`/`-o`; every
// argument of a command running plan-skeleton; the last argument of cp/mv/install/ln; the file arguments of
// `sed -i`/`perl -i`; a quoted path in a `python -c` / `node -e` code string. Heredoc bodies are dropped
// first; then the command is tokenised (quotes respected) and split into simple commands at && || ; | and
// newlines.
function bashWriteTargets(cmd: string): string[] {
  const kept: string[] = [];
  let delim: string | null = null;
  for (const line of cmd.split("\n")) {
    if (delim !== null) { if (line.trim() === delim) delim = null; continue; }
    kept.push(line);
    const h = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(line);
    if (h && h[2]) delim = h[2];
  }
  type Tok = { op: string } | { word: string };
  const toks: Tok[] = [];
  const text = kept.join("\n");
  let i = 0, word: string | null = null;
  const flush = (): void => { if (word !== null) { toks.push({ word }); word = null; } };
  while (i < text.length) {
    const c = text[i] ?? "";
    if (c === "'" || c === '"') {
      const j = text.indexOf(c, i + 1);
      const end = j === -1 ? text.length : j;
      word = (word ?? "") + text.slice(i + 1, end).replace(/\\(.)/g, c === '"' ? "$1" : "\\$1");
      i = end + 1; continue;
    }
    if (c === "\\" && i + 1 < text.length) { word = (word ?? "") + (text[i + 1] ?? ""); i += 2; continue; }
    if (/\s/.test(c) && c !== "\n") { flush(); i++; continue; }
    const two = text.slice(i, i + 2);
    // `2>` / `2>>`: the digits are a file descriptor, not a word
    const fdThenFlush = (): void => { if (word !== null && /^\d+$/.test(word)) word = null; else flush(); };
    if (two === ">>" || two === "&>") { fdThenFlush(); toks.push({ op: two === "&>" ? ">" : ">>" }); i += 2; continue; }
    if (c === ">") { fdThenFlush(); toks.push({ op: ">" }); i++; continue; }
    if (two === "&&" || two === "||" || two === "<<") { flush(); toks.push({ op: two }); i += 2; continue; }
    if ([";", "|", "\n", "<", "&", "(", ")"].includes(c)) { flush(); toks.push({ op: c }); i++; continue; }
    word = (word ?? "") + c; i++;
  }
  flush();
  const out: string[] = [];
  let cmdWords: string[] = [];
  const endCommand = (): void => {
    const [head, ...args] = cmdWords;
    const name = head === undefined ? "" : path.posix.basename(head.replace(/\\/g, "/"));
    const plain = args.filter((w) => !w.startsWith("-"));
    if (["cp", "mv", "install", "ln"].includes(name) && plain.length >= 2) out.push(plain[plain.length - 1] ?? "");
    if ((name === "sed" && args.some((w) => w === "-i" || w.startsWith("-i") || w.startsWith("--in-place"))) || (name === "perl" && args.some((w) => /^-\w*i/.test(w)))) {
      // skip the flags, the in-place suffix (`-i ''`), the script (`-e X`, or the first bare word for sed); the rest are files
      let script = false;
      for (let k = 0; k < args.length; k++) {
        const w = args[k] ?? "";
        if (w === "-i" && args[k + 1] === "") { k++; continue; }
        if (w === "-e" || w === "-f" || (name === "perl" && /^-\w*e$/.test(w))) { k++; script = true; continue; }
        if (w.startsWith("-")) continue;
        if (!script && name === "sed") { script = true; continue; }
        out.push(w);
      }
    }
    if (/^(python3?|node)$/.test(name)) {
      const at = args.findIndex((w) => w === "-c" || w === "-e");
      const code = at === -1 ? undefined : args[at + 1];
      if (code) for (const m of code.matchAll(/['"`]([^'"`\n]+)['"`]/g)) if (m[1]) out.push(m[1]);
    }
    if (cmdWords.some((w) => /plan-skeleton/.test(w))) out.push(...cmdWords.filter((w) => !w.startsWith("-")));
    const tee = cmdWords.findIndex((w) => w === "tee" || w.endsWith("/tee"));
    if (tee !== -1) out.push(...cmdWords.slice(tee + 1).filter((w) => !w.startsWith("-")));
    cmdWords.forEach((w, k) => {
      if ((w === "--out" || w === "-o") && cmdWords[k + 1] !== undefined) out.push(cmdWords[k + 1] ?? "");
      const eq = /^--out=(.+)$/.exec(w);
      if (eq && eq[1]) out.push(eq[1]);
    });
    cmdWords = [];
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (!t) continue;
    if ("word" in t) { cmdWords.push(t.word); continue; }
    if (t.op === ">" || t.op === ">>") { const n = toks[k + 1]; if (n && "word" in n) { out.push(n.word); k++; } continue; }
    if (t.op === "<" || t.op === "<<") { const n = toks[k + 1]; if (n && "word" in n) k++; continue; } // input / heredoc delimiter
    endCommand();
  }
  endCommand();
  return out.filter(Boolean);
}

// Does a path the session wrote name `rel` (project-relative) under `cwd`?
function sameFile(w: WrittenPath, rel: string, cwd: string): boolean {
  const c = w.path.trim().replace(/\\/g, "/");
  if (!c) return false;
  const want = path.resolve(cwd, rel).replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(c) && !/^[A-Za-z]:\//.test(want)) return path.posix.normalize(c).toLowerCase().endsWith("/" + path.posix.normalize(rel.replace(/\\/g, "/")).toLowerCase());
  const got = path.resolve(w.base || cwd, c).replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(want) ? got.toLowerCase() === want.toLowerCase() : got === want;
}

function ownPlans(open: PlanFile[], input: HookPayload, all: PlanFile[] | null | undefined, cwd: string): { plans: PlanFile[]; scope: PlanScope } {
  const agent = typeof input.agent_transcript_path === "string" && !!input.agent_transcript_path;
  const file = input.agent_transcript_path || (input.agent_id ? null : input.transcript_path);
  // (a non-string path would have thrown in readFileSync and been caught the same way)
  if (!file || typeof file !== "string") return { plans: open, scope: "unscoped" };
  let writes: WrittenPath[];
  // the session transcript may carry a subagent's sidechain entries: those are not this session's actions
  try { writes = transcriptActions(fs.readFileSync(file, "utf8"), !agent); } catch { return { plans: open, scope: "unscoped" }; }
  // rule (b): a written file claims the ONE open plan that lists it; a file two or more open plans list claims none
  const listers = new Map<string, number>();
  for (const p of open) for (const f of new Set(p.plan.files || [])) listers.set(f, (listers.get(f) || 0) + 1);
  const owns = (p: PlanFile): boolean => {
    const planRel = path.relative(cwd, path.resolve(p.file));
    if (writes.some((w) => sameFile(w, planRel, cwd))) return true;
    return open.includes(p) && (p.plan.files || []).some((f) => listers.get(f) === 1 && writes.some((w) => sameFile(w, f, cwd)));
  };
  const known = all && all.length ? all : open;
  if (!known.some(owns)) return { plans: [], scope: "none-named" };
  return { plans: open.filter(owns), scope: "named" };
}

// ================================================================ CLI

const USAGE = [
  `usage: ${scriptCmd("verify-build")}                     (Stop hook: reads the hook JSON from stdin when stdin is not a terminal)`,
  `       ${scriptCmd("verify-build")} <plan.json>…        check these plans now (no stdin read)`,
  `       ${scriptCmd("verify-build")} --status [<plan.json>…] [--json]   print each plan's computed status (all of design/plan/ by default); never writes`,
  "",
  "Blocks (exit 2) on: a raw colour the plan resolved to a token, in a source file of files[] (comments,",
  "prose strings and .svg/.json/non-source files are not scanned); a visible design node with no anchor",
  "(itself or an ancestor) in anchors{}; and, on web profiles, no data-dt-node tag in any plan's files[]",
  "(opt out: \"tagging\": {\"off\": true, \"reason\": \"…\"}). Everything else is a warning (exit 0).",
  "Hook mode checks the plans the stopping agent's transcript names; a transcript that names none checks nothing.",
  "Never writes plan.status: it records verification.hook {result, planHash, files:{path: sha256}}, and",
  "--status computes the status from that, the file hashes, and design/verify/<…>.report.json. First match wins:",
  "  1. abandoned | awaiting-user  set by a person in plan.status; nothing else is evaluated",
  "  2. failed       a verify-report@2 for this screen says fail (never hidden behind the hook's state)",
  "  3. blocked      the Stop hook's last check blocked",
  "  4. stale        a file in files[] changed (by content) since the hook passed",
  "  5. pending      the hook has not checked this version of the plan",
  "  6. unverified | static-only | verified | verified-with-deviations   what the report says: verified",
  "     only for an @2 'pass' that measured this design, these files and the plan's current waivers[]/",
  "     descopes[], by content hash (no report / a pre-@2 report / other design, code or waivers ->",
  "     unverified); verified-with-deviations when every report passes and >=1 says 'pass-with-deviations'.",
  "     A stored \"verified\" is ignored. waivers[]/descopes[] are not part of the hook's planHash.",
  "Every non-verified status carries a non-empty why: the hook's state AND what the report says (a",
  "report too old to trust is named with its schema). --json prints {plan, status, why, reasons, reports}.",
].join("\n");

interface RecordResult { blocking: string[]; warnings: string[]; cleared: PlanStoredStatus | null | undefined; status: StatusResult }

function checkAndRecord(p: PlanFile, cwd: string, graph?: () => ProjectGraph): RecordResult {
  const exp = locateExport(p.plan, p.file, cwd);
  const reports = locateReports(p.plan, p.file, cwd, exp);
  setPhase(`checking ${path.basename(p.file)}`);
  const { blocking, warnings, tagCoverage } = checkPlan(p, cwd, { export: exp, reports, ...(graph ? { graph } : {}) });
  const plan = p.plan;
  const cleared = COMPUTED_STORED.has(String(plan.status || "").toLowerCase()) ? plan.status : null;
  if (cleared) delete plan.status;
  if (!plan.verification) plan.verification = {};
  setPhase(`hashing files[] of ${path.basename(p.file)}`);
  plan.verification.hook = {
    result: blocking.length ? "blocked" : "pass",
    checkedAt: new Date().toISOString(),
    blocking,
    warnings: warnings.length,
    planHash: planHash(plan),
    files: fileHashes(plan, cwd),
    ...(tagCoverage ? { tagCoverage } : {}),
  };
  // The plan's mtime is the staleness clock — it measures the BUILDER's last edit. The hook's own
  // write must not reset it, or a blocked leftover plan would stay "fresh" (and nag) forever.
  let times: [Date, Date] | null = null;
  try { const s = fs.statSync(p.file); times = [s.atime, s.mtime]; } catch { /* new file */ }
  fs.writeFileSync(p.file, JSON.stringify(plan, null, 2) + "\n");
  if (times) try { fs.utimesSync(p.file, times[0], times[1]); } catch { /* ignore */ }
  const st = computeStatus(plan, { cwd, planFile: p.file, export: exp, reports });
  return { blocking, warnings, cleared, status: st };
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice();
  if (args.includes("--help") || args.includes("-h")) { console.log(USAGE); return 0; }
  const statusMode = args.includes("--status");
  const json = args.includes("--json");
  const planArgs = args.filter((a) => !a.startsWith("-"));
  const stray = args.filter((a) => a.startsWith("-") && !["--status", "--json"].includes(a));
  if (stray.length) { console.error(`verify-build: unknown flag ${stray.join(", ")}\n${USAGE}`); return 2; }

  if (statusMode) {
    setPhase("computing plan status");
    const found = planArgs.length ? planArgs.map((f) => readPlan(path.resolve(f))) : null;
    const { plans, bad } = found ? { plans: found.filter(isPlanFile), bad: found.filter((p): p is BadPlan => !isPlanFile(p)) } : findPlans(process.cwd());
    for (const b of bad) console.error(`verify-build: cannot read plan ${b.file}: ${b.error}`);
    const show = (f: string): string => { const r = path.relative(process.cwd(), f); return r.startsWith("..") ? f : r; };
    const rows = plans.map((p) => Object.assign({ plan: show(p.file) }, computeStatus(p.plan, { planFile: p.file, cwd: rootOfPlan(p.file) })));
    if (json) console.log(JSON.stringify(rows.map((r) => ({ plan: r.plan, status: r.status, why: r.reasons.join(" · ") || null, reasons: r.reasons, reports: r.reports.map((x) => ({ file: x.rel, verdict: x.verdict, matchedBy: x.matchedBy })) })), null, 2));
    else for (const r of rows) console.log(`${r.plan}: ${r.status}${r.reasons.length ? "\n  - " + r.reasons.join("\n  - ") : ""}`);
    if (!plans.length) console.error("verify-build: no plans found (design/plan/*.json)");
    return 0;
  }

  let input: HookPayload = {};
  let targets: PlanFile[] | undefined;
  if (planArgs.length) {
    const read = planArgs.map((f) => readPlan(path.resolve(f)));
    const bad = read.filter((p): p is BadPlan => !isPlanFile(p));
    if (bad.length) { console.error(`verify-build: cannot read plan(s): ${bad.map((b) => `${path.relative(process.cwd(), b.file) || b.file} (${b.error})`).join(", ")}`); return 1; }
    targets = read.filter(isPlanFile);
  } else {
    setPhase("reading the hook payload on stdin");
    const r = await readHookInput();
    if (r.error) { console.error(`verify-build: ${r.error}`); return 1; }
    input = r.payload || {};
    if (input.stop_hook_active) return 0; // avoid re-entrant loops on the same turn
  }

  const all: Array<{ p: PlanFile; cwd: string }> = [];
  if (targets) {
    for (const p of targets) {
      const cwd = rootOfPlan(p.file);
      const life = lifecycleOf(p.plan);
      if (life !== "pending") { console.error(`verify-build: ${path.basename(p.file)} is "${life}" — not checked`); continue; }
      all.push({ p, cwd });
    }
  } else {
    // (a hook payload's cwd is a string; anything else falls back to the process cwd)
    const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
    setPhase("finding open plans in design/plan/");
    const { plans, bad } = findPlans(cwd);
    // A plan the hook cannot read is not checked — say so on every stop rather than skip it silently.
    for (const b of bad) console.error(`verify-build: warning: ${path.relative(cwd, b.file)} ${b.error} — it was NOT checked; fix it (${scriptCmd("plan-skeleton")} rewrites the skeleton fields and keeps what you filled)`);
    const open = plans.filter((p) => isOpen(p, cwd));
    if (!open.length) return 0; // fast path
    const own = ownPlans(open, input, plans, cwd);
    if (own.scope === "none-named") {
      console.error(`verify-build: this session wrote or ran nothing naming a plan under design/plan/ — nothing checked (${open.length} open plan(s) belong to other sessions; check one by hand with ${scriptCmd("verify-build")} <plan.json>)`);
      return 0;
    }
    for (const p of own.plans) all.push({ p, cwd });
  }

  const blockedOut: string[] = [], lines: string[] = [];
  // A warning several plans share (a merged token on a shared theme) is printed ONCE, naming them all.
  const warned = new Map<string, string[]>();
  const graphs = new Map<string, ProjectGraph>(); // built once per project root per run, on first use
  for (const { p, cwd } of all) {
    const res = checkAndRecord(p, cwd, () => getOrInit(graphs, cwd, () => buildGraph(cwd)));
    const name = path.basename(p.file);
    if (res.cleared) console.error(`verify-build: ${name}: removed the stored "status": "${res.cleared}" — status is computed now (${scriptCmd("verify-build")} --status), never stored`);
    for (const w of res.warnings) getOrInit(warned, w, () => []).push(name);
    if (res.blocking.length) blockedOut.push(`# ${name}`, ...res.blocking.map((m) => `  - ${m}`));
    const why = res.blocking.length ? "see below" : res.status.reasons[res.status.reasons.length - 1];
    lines.push(`verify-build: ${name}: hook ${res.blocking.length ? "BLOCKED" : "passed"} · computed status: ${res.status.status}${why ? ` — ${why}` : ""}`);
  }
  for (const [w, names] of warned) console.error(`verify-build: warning (${names.join(", ")}): ${w}`);
  for (const l of lines) console.error(l);
  if (blockedOut.length) {
    console.error("\nverify-build: build-screen check failed — do not report this screen as done until these are resolved");
    console.error("(a plan that will not be finished: set its status to \"abandoned\"; a build paused on a question for the user: \"awaiting-user\", then ask):\n");
    console.error(blockedOut.join("\n"));
    return 2;
  }
  return 0;
}

export {
  checkPlan, computeStatus, locateReports, locateExport, anchorCoverage, moduleImported, importsOf, scanText, isSourceFile,
  verificationWarnings, verificationContradictions, deviationWarnings, validatePlanHeader, ownPlans, checkVerification, auditGateWarnings,
  colorLiterals, arbitraryPx, colorKey, isStale, isOpen, planHash, fileHashes, readHookInput, main, USAGE,
};

if (import.meta.main ?? isMainFallback(import.meta.url)) {
  const watchdog = setTimeout(() => {
    console.error(`verify-build: gave up after ${Math.round(HOOK_TIMEOUT_MS() / 1000)} s while ${phase} — nothing was blocked; re-run \`${scriptCmd("verify-build")} <plan.json>\` to check the plan directly`);
    process.exit(1);
  }, HOOK_TIMEOUT_MS());
  watchdog.unref();
  // exitCode, not exit(): on macOS a pipe write is asynchronous, and exit() would cut a long --json
  // listing or the itemised block message short. stdin is paused+unref'd and the watchdog unref'd, so
  // nothing keeps the process alive once main() is done.
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e: unknown) => { console.error(`verify-build: ${(e instanceof Error && e.stack) || String(e)}`); process.exitCode = 1; });
}
