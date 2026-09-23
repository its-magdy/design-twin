// verify-build.js — the Stop-hook gate for the build-screen skill, and the ONE place a plan's status
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
// Exactly two things (livetest-3 §2.9 b):
//   1. an UNEXPLAINED colour literal: a colour the plan resolved to a real code token, written as a raw
//      literal (`#5B5FC7`, `0xFF5B5FC7`, `rgb(91, 95, 199)`) in a SOURCE file listed in `files[]`.
//      Only code is scanned: comments, prose string literals (provenance notes) and every non-source
//      file (`.svg`, `.json`, `.md`, images …) are skipped — a hex in a doc comment (finding 100) or in
//      the baked-in stroke of an exported SVG the skill forbids editing (132) never reaches a painted
//      element as a literal. A value the plan did NOT resolve to a token is not a violation (the
//      profiles prescribe one-off literals where no token exists), and neither is the line that
//      DEFINES the token (`--color-figma-brand-600: #5B5FC7`). This is a source check, not a DOM
//      check: the rendered comparison is verify-screen.js's job, and its report feeds the status.
//   2. a VISIBLE design node with no anchor in the plan: a node the export draws (not `hidden`, no
//      hidden ancestor) that neither it nor any ancestor maps to code in `anchors{}`. The plan is the
//      map from design to code; a visible subtree missing from it is a piece of the screen nobody
//      accounted for. `plan-skeleton.js` lists every visible node, so this is only ever a fill-in.
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
//   (design/verify/<…>.report.json) says "pass" and is newer than the code.
// A stored "verified"/"static-only" (written by an older hook) is ignored by computeStatus and
// deleted the next time the hook checks that plan. `status` keeps only the states a PERSON sets:
// "pending" (default) · "awaiting-user" (paused on a question — skipped, never closed) ·
// "abandoned" (retired — skipped). Every reader (verify, sync-design, the next session) runs
// `verify-build.js --status` instead of trusting a field.
//
// Computed statuses: pending (hook has not checked this version of the plan) · blocked · stale (a
// file changed since the hook passed) · failed (a verify report exists and does not say pass) ·
// unverified (no report, or it predates the code/export) · static-only · verified.
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
// Plan shape: see plan-skeleton.js (which writes it) and build-screen/SKILL.md step 2.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { visibility, rootsOf } = require("./plan-skeleton");

// ================================================================ input / timeouts

const HOOK_TIMEOUT_MS = () => Number(process.env.DTWIN_HOOK_TIMEOUT_MS) || 60000;
const STDIN_WAIT_MS = () => { const n = Number(process.env.DTWIN_HOOK_STDIN_WAIT_MS); return Number.isFinite(n) && n >= 0 && process.env.DTWIN_HOOK_STDIN_WAIT_MS !== "" ? n : 1000; };

let phase = "starting";
const setPhase = (p) => { phase = p; };

// The hook JSON, read only when stdin is not a terminal. A regular file or /dev/null reads to EOF at
// once; a pipe/socket is read asynchronously with two deadlines, so an inherited pipe that never
// closes (finding 133: "same command, two different outcomes") cannot stall the build.
function readHookInput() {
  if (process.stdin.isTTY) return Promise.resolve({ payload: {}, source: "tty" });
  let st;
  try { st = fs.fstatSync(0); } catch { return Promise.resolve({ payload: {}, source: "closed" }); }
  const parse = (raw) => { try { return raw.trim() ? JSON.parse(raw) : {}; } catch { return {}; } };
  if (st.isFile() || st.isCharacterDevice()) {
    try { return Promise.resolve({ payload: parse(fs.readFileSync(0, "utf8")), source: "file" }); } catch { return Promise.resolve({ payload: {}, source: "unreadable" }); }
  }
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0, finished = false;
    const done = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(first); clearTimeout(hard);
      process.stdin.removeAllListeners("data"); process.stdin.removeAllListeners("end");
      try { process.stdin.pause(); process.stdin.unref && process.stdin.unref(); } catch { /* ignore */ }
      resolve(value);
    };
    const first = setTimeout(() => { if (!bytes) done({ payload: {}, source: "silent-pipe" }); }, STDIN_WAIT_MS());
    // a little inside the process watchdog, so this (more specific) message is the one printed
    const hard = setTimeout(() => done({ error: `timed out after ${Math.round(HOOK_TIMEOUT_MS() / 1000)} s waiting for the hook payload on stdin (${bytes} byte(s) received, no end-of-file) — pass the plan path as an argument instead, or pipe the payload: echo '{"cwd":"…"}' | node verify-build.js` }), Math.max(50, HOOK_TIMEOUT_MS() - 250));
    process.stdin.on("data", (c) => { bytes += c.length; chunks.push(c); });
    process.stdin.on("end", () => done({ payload: parse(Buffer.concat(chunks).toString("utf8")), source: "pipe" }));
    process.stdin.on("error", () => done({ payload: {}, source: "error" }));
    process.stdin.resume();
  });
}

// ================================================================ plans on disk

const STALE_HOURS = 12;

function staleCutoffMs() {
  const raw = process.env.DTWIN_PLAN_STALE_HOURS;
  const h = raw === undefined || raw === "" ? STALE_HOURS : Number(raw);
  return Number.isFinite(h) && h > 0 ? h * 3600 * 1000 : 0;
}

function isStale(file, now = Date.now()) {
  const cutoff = staleCutoffMs();
  if (!cutoff) return false;
  try { return now - fs.statSync(file).mtimeMs > cutoff; } catch { return false; }
}

function readPlan(file) {
  try { return { file, plan: JSON.parse(fs.readFileSync(file, "utf8")) }; } catch { return null; }
}

function findPlans(cwd) {
  const dir = path.join(cwd, "design", "plan");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => readPlan(path.join(dir, f))).filter(Boolean);
}

// The project root a plan belongs to: <root>/design/plan/<x>.json → <root>.
function rootOfPlan(file, fallback) {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  if (path.basename(dir) === "plan" && path.basename(path.dirname(dir)) === "design") return path.dirname(path.dirname(dir));
  return fallback || process.cwd();
}

// Lifecycle states a PERSON sets. Anything else stored in `status` ("verified", "static-only", from an
// older hook) is a computed value that must not be trusted, and counts as pending.
const LIFECYCLE = new Set(["pending", "awaiting-user", "abandoned"]);
const COMPUTED_STORED = new Set(["verified", "static-only"]);
const lifecycleOf = (plan) => {
  const s = String((plan && plan.status) || "pending").trim().toLowerCase();
  return LIFECYCLE.has(s) ? s : "pending";
};

// ================================================================ hashing

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);

function fileHashes(plan, cwd) {
  const out = {};
  for (const rel of Array.isArray(plan.files) ? plan.files.map(String) : []) {
    try { out[rel] = sha(fs.readFileSync(path.join(cwd, rel))); } catch { out[rel] = null; }
  }
  return out;
}

// The plan's own content, minus what the hook writes and what is not the plan's substance.
function planHash(plan) {
  const copy = JSON.parse(JSON.stringify(plan || {}));
  delete copy.status;
  if (copy.verification && typeof copy.verification === "object") {
    delete copy.verification.hook;
    if (!Object.keys(copy.verification).length) delete copy.verification;
  }
  return sha(JSON.stringify(copy));
}

function changedFiles(plan, cwd) {
  const hook = plan.verification && plan.verification.hook;
  if (!hook || !hook.files) return null;
  const now = fileHashes(plan, cwd);
  const changed = [];
  const all = new Set([...Object.keys(hook.files), ...Object.keys(now)]);
  for (const f of all) if (hook.files[f] !== now[f]) changed.push(now[f] === undefined ? `${f} (no longer in files[])` : hook.files[f] === undefined ? `${f} (added to files[])` : now[f] === null ? `${f} (missing)` : f);
  return changed;
}

// OPEN = the hook still has work on this plan.
function isOpen(p, cwd) {
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
const extOf = (rel) => String(rel).toLowerCase().split(".").pop();
const isSourceFile = (rel) => SOURCE_EXT.has(extOf(rel));

// A string literal that is prose — a provenance note like "bound to Neutrals/Neutral 0, #121319 in
// Dark" — rather than a style value. Three plain words in a row is prose; `1px solid #fff`,
// `bg-[#fff] px-4` and `#fff` are not.
const PROSE = /\b[A-Za-z]{2,}[,.;:]?\s+[A-Za-z]{2,}[,.;:]?\s+[A-Za-z]{2,}\b/;
const isProse = (s) => PROSE.test(s) && !/-\[|\[#/.test(s);

// The text the literal scan looks at: comments removed; prose strings blanked. Keeps line structure
// (newlines survive) so per-line definition detection still works.
function scanText(rel, text) {
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

// "#abc" / "#aabbcc" / "#aabbccdd" -> "aabbcc" (alpha dropped).
function hex6(value) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(value).trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  return h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
}

// The comparison key for the literal check: always 8 hex digits, rrggbb + alpha (opaque -> "ff").
// Alpha is part of the colour's identity (live run #25): `#ffffff` and `#ffffff1a` are different
// colours bound to different tokens, and folding them together cross-contaminated both directions.
function colorKey(value) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(value).trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  const full = h.length <= 4 ? h.split("").map((c) => c + c).join("") : h;
  return full.length === 6 ? full + "ff" : full;
}

// Every raw colour literal in the source, keyed by colorKey -> the spelling found.
function colorLiterals(source) {
  const found = new Map();
  const add = (h, lit) => { if (h && !found.has(h)) found.set(h, lit); };
  for (const m of source.matchAll(/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g)) add(colorKey(m[1]), m[0]);
  // Compose / Flutter `Color(0xFF5B5FC7)` — AARRGGBB (alpha FIRST), or bare 0xRRGGBB.
  for (const m of source.matchAll(/\b0x([0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/g)) {
    const h = m[1].toLowerCase();
    add(h.length === 8 ? h.slice(2) + h.slice(0, 2) : h + "ff", m[0]);
  }
  for (const m of source.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?[^)]*\)/g)) {
    const rgb = [m[1], m[2], m[3]].map((x) => Math.min(255, Number(x)).toString(16).padStart(2, "0")).join("");
    add(rgb + alphaHex(m[4]), m[0]);
  }
  return found;
}

function alphaHex(a) {
  if (a === undefined || a === "") return "ff";
  const n = String(a).endsWith("%") ? Number(String(a).slice(0, -1)) / 100 : Number(a);
  if (!Number.isFinite(n)) return "ff";
  return Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, "0");
}

// Tailwind arbitrary dimensions: the utility PREFIX says which kind the number is (live finding 88:
// `rounded-[20px]` is not the 20px a fontSize token resolves to).
const UTILITY_KIND = [
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
const KIND_MATCHES = {
  radius: ["radius", "borderradius", "cornerradius"],
  fontSize: ["fontsize", "font-size", "type", "typography"],
  lineHeight: ["lineheight", "line-height"],
  letterSpacing: ["letterspacing", "letter-spacing", "tracking"],
  spacing: ["spacing", "space", "gap", "padding", "margin", "size", "dimension"],
  size: ["size", "spacing", "space", "dimension", "width", "height"],
  borderWidth: ["borderwidth", "border-width", "border", "stroke"],
};
function utilityKind(utility) {
  const u = String(utility || "").replace(/^-/, "");
  for (const [re, kind] of UTILITY_KIND) if (re.test(u)) return kind;
  return null;
}
function kindsCompatible(utility, rowKind) {
  const uk = utilityKind(utility);
  if (!uk) return true;
  const rk = String(rowKind || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!rk) return true;
  return (KIND_MATCHES[uk] || []).some((k) => k.replace(/[^a-z]/g, "") === rk);
}
function arbitraryPx(source) {
  const found = new Map();
  for (const m of source.matchAll(/(?:^|[\s"'`{(])([a-z-]+)-\[(-?\d+(?:\.\d+)?)(px|rem)\]/g)) {
    const px = Number(m[2]) * (m[3] === "rem" ? 16 : 1);
    const entry = { literal: `[${m[2]}${m[3]}]`, utility: m[1] };
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
function importsOf(text) {
  const out = [];
  const re = /\bimport\s+(?:[^'"`;]*?\sfrom\s+)?["'`]([^"'`]+)["'`]|\bexport\s+[^'"`;]*?\sfrom\s+["'`]([^"'`]+)["'`]|\b(?:require|import)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)|@import\s+(?:url\()?["']([^"']+)["']/g;
  for (const m of text.matchAll(re)) out.push(m[1] || m[2] || m[3] || m[4]);
  return out;
}

const SRC_EXT_RE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro|css|scss|swift|kt|dart)$/i;
// "app/src/components/PageTitle.tsx" / "@/components/PageTitle" / "../../../components/PageTitle/index"
// → ["components", "PageTitle"] style segments, extension and trailing /index dropped, alias
// prefixes (`@/`, `~/`, `#/`, `@alias/`) and `.`/`..` removed.
function moduleSegments(spec) {
  let s = String(spec || "").trim().replace(/\\/g, "/").replace(SRC_EXT_RE, "").replace(/\/index$/i, "");
  const segs = s.split("/").filter((x) => x && x !== "." && x !== "..");
  if (segs.length && /^[@~#]$/.test(segs[0])) segs.shift();
  return segs;
}

// Does any built file import the module a plan row says it reuses? Relative specifiers are resolved
// against the importing file, then compared with mapModule by path SUFFIX; alias / bare specifiers are
// compared by suffix directly. A `mapModule` written as a repo path (`app/src/components/PageTitle.tsx`)
// therefore matches `'../../../components/PageTitle'` and `'@/components/PageTitle'` alike — the
// unsatisfiable substring test of finding 131 is gone. Non-JS stacks (Swift/Kotlin/Dart import
// modules, not files): the component's own name used as an identifier counts.
function moduleImported(mapModule, byFile, cwd) {
  const want = moduleSegments(mapModule);
  if (!want.length) return true;
  const suffixMatch = (have) => {
    const k = Math.min(have.length, want.length);
    if (!k) return false;
    for (let i = 1; i <= k; i++) if (have[have.length - i].toLowerCase() !== want[want.length - i].toLowerCase()) return false;
    return true;
  };
  const wantAbs = moduleSegments(path.relative(cwd, path.resolve(cwd, String(mapModule))));
  for (const f of byFile) {
    for (const spec of importsOf(f.text)) {
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

function readJsonOr(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }

function exportDirOf(cwd) {
  const e = path.join(cwd, "design", "export");
  return fs.existsSync(path.join(e, "pages")) ? e : path.join(cwd, "design"); // pre-split projects
}

// Node id from a `<Screen>__<a>_<b>` stem (the exporter's own file naming).
const idFromStem = (s) => { const m = /__(I?\d+)_(\d+)$/.exec(String(s || "")); return m ? `${m[1]}:${m[2]}` : null; };

function indexRows(exportDir) {
  const root = readJsonOr(path.join(exportDir, "pages", "index.json"), null);
  if (!root) return [];
  if (Array.isArray(root.layers)) return root.layers;
  const rows = [];
  for (const pd of root.pageDirs || []) {
    const idx = readJsonOr(path.join(exportDir, pd.index || path.join("pages", pd.dir || "", "index.json")), null);
    if (idx && Array.isArray(idx.layers)) rows.push(...idx.layers);
  }
  return rows;
}

// The screen export a plan describes: its `file` header (project-relative, or relative to
// design/export as the index writes it), else its `nodeId`, else the node id in its `screen` stem or
// its own filename, looked up in the export index. Returns { file, doc, row } or null.
function locateExport(plan, planFile, cwd) {
  const exportDir = exportDirOf(cwd);
  const tryFile = (rel) => {
    if (!rel) return null;
    for (const f of [path.resolve(cwd, rel), path.resolve(exportDir, rel)]) {
      const doc = fs.existsSync(f) ? readJsonOr(f, null) : null;
      if (doc) return { file: f, doc };
    }
    return null;
  };
  let hit = tryFile(plan.file && /\.json$/i.test(plan.file) ? plan.file : null);
  const rows = indexRows(exportDir);
  const ids = [plan.nodeId, idFromStem(plan.screen), planFile ? idFromStem(path.basename(planFile, ".json")) : null].filter(Boolean);
  let row = null;
  for (const id of ids) { row = rows.find((r) => r.id === id); if (row) break; }
  if (!hit && row) hit = tryFile(row.file);
  if (!hit) return null;
  const root = rootsOf(hit.doc)[0] || {};
  if (!row) row = rows.find((r) => r.id === (hit.doc.nodeId || root.id)) || null;
  return Object.assign(hit, { row, nodeId: hit.doc.nodeId || root.id || null, layerName: String(hit.doc.screen || root.name || ""), sameNameRows: rows.filter((r) => String(r.name || "").trim() === String(hit.doc.screen || root.name || "").trim()).length });
}

// ================================================================ anchors (block 2)

const anchored = (a) => !!a && typeof a === "object" && ["mapModule", "file", "symbol", "omitted"].some((k) => typeof a[k] === "string" && a[k].trim());

function anchorCoverage(plan, doc) {
  const { visible, hidden } = visibility(doc);
  const anchors = plan.anchors && typeof plan.anchors === "object" ? plan.anchors : {};
  const covered = new Map();
  const isCovered = (id) => {
    if (covered.has(id)) return covered.get(id);
    const v = visible.get(id);
    const r = anchored(anchors[id]) || (!!v && !!v.parentId && visible.has(v.parentId) && isCovered(v.parentId));
    covered.set(id, r);
    return r;
  };
  // which uncovered nodes have an anchored node somewhere below them (pure wrappers — a warning)
  const hasAnchoredBelow = new Set();
  for (const id of visible.keys()) {
    if (!anchored(anchors[id])) continue;
    let p = visible.get(id).parentId;
    while (p && visible.has(p) && !hasAnchoredBelow.has(p)) { hasAnchoredBelow.add(p); p = visible.get(p).parentId; }
  }
  const unmapped = [], wrappers = [];
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

const verdictOf = (row) => String((row && row.verdict) || "").trim().toLowerCase();
// `codeToken: "MISSING"` (or none / n/a / null) means "there is no token" — not a token NAME.
const NO_TOKEN = new Set(["missing", "none", "n/a", "na", "-", "null", "tbd"]);
const hasToken = (row) => !!row.codeToken && !NO_TOKEN.has(String(row.codeToken).trim().toLowerCase());

function loadMapKeys(cwd) {
  for (const f of [path.join(cwd, "design", "codeconnect.local.json"), path.join(cwd, "codeconnect.local.json")]) {
    const map = readJsonOr(f, null);
    if (!map) continue;
    const keys = new Map();
    for (const [name, e] of Object.entries(map.components || {})) {
      if (e && e.figma && e.figma.key && e.code && e.code.module && e.status !== "deprecated") keys.set(e.figma.key, { name, module: e.code.module });
    }
    return keys;
  }
  return new Map();
}

function checkVerification(plan, cwd) {
  const v = plan.verification;
  if (!v || typeof v !== "object" || v.mode === undefined) {
    return ["no `verification.mode` in the plan — record how the build was checked: {mode:\"rendered\", renderer, artifacts:[…], deltas:[…]} after rendering and comparing (references/verify.md), or {mode:\"static-only\", reason} if the project genuinely has no way to render"];
  }
  if (v.mode === "rendered") {
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
function verificationWarnings(plan) {
  const v = plan.verification;
  if (!v || v.mode !== "rendered") return [];
  const out = [];
  const c = v.coverage;
  if (!c || !Array.isArray(c.rendered) || !c.rendered.length) out.push("verification.coverage is missing — record {rendered:[…], notChecked:[{what, why}]} so the report can say which states/themes/sizes were never rendered (references/verify.md, \"Beyond the ideal frame\")");
  if (!v.a11y) out.push("verification.a11y is missing — no accessibility check is recorded (web: @axe-core/playwright on the rendered page); say so in the report rather than implying one ran");
  return out;
}

// Finding 156: the verification block contradicting itself in adjacent keys.
const A11Y = /\b(a11y|axe|accessib)/i;
function verificationContradictions(plan, reports) {
  const v = plan.verification;
  if (!v || typeof v !== "object") return [];
  const out = [];
  const notChecked = (v.coverage && Array.isArray(v.coverage.notChecked)) ? v.coverage.notChecked : [];
  const what = (e) => String(e && typeof e === "object" ? e.what || "" : e || "");
  const rendered = (v.coverage && Array.isArray(v.coverage.rendered)) ? v.coverage.rendered.map((x) => String(x).trim().toLowerCase()) : [];
  if (v.a11y && typeof v.a11y === "object" && v.a11y.violations !== undefined) {
    const nc = notChecked.find((e) => A11Y.test(what(e)));
    if (nc) out.push(`verification contradicts itself: \`a11y\` records ${JSON.stringify(v.a11y.violations)} violation(s) from ${JSON.stringify(v.a11y.tool || "an a11y scan")}, while \`coverage.notChecked\` says "${what(nc)}" was not checked${nc.why ? ` (${nc.why})` : ""} — keep the one that is true`);
  }
  for (const e of notChecked) if (rendered.includes(what(e).trim().toLowerCase())) out.push(`verification contradicts itself: "${what(e)}" is listed both in coverage.rendered and in coverage.notChecked`);
  for (const r of reports || []) {
    if (Array.isArray(v.deltas) && !v.deltas.length && Array.isArray(r.deltas) && r.deltas.length) out.push(`verification.deltas is [] but ${r.rel} lists ${r.deltas.length} delta(s) — copy them (or the ones you judged real, with why) into the plan`);
    for (const k of ["verifyScreenVerdict", "verdict"]) {
      const claimed = v[k];
      const s = claimed && typeof claimed === "object" ? claimed.verdict : claimed;
      if (typeof s === "string" && /pass/i.test(s) && r.verdict !== "pass") out.push(`verification.${k} says ${JSON.stringify(s)} but ${r.rel} says verdict ${JSON.stringify(r.verdict)} — the report is the verdict; the plan cannot overrule it`);
    }
  }
  return out;
}

// Finding 196: a deviation is only reviewable when it says WHICH node, WHICH field, what was designed,
// what was built, and why.
const DEVIATION_FIELDS = ["nodeId", "field", "designed", "built", "reason"];
function deviationWarnings(plan) {
  if (plan.deviations === undefined) return [];
  if (!Array.isArray(plan.deviations)) return ["`deviations` must be an array of {nodeId, field, designed, built, reason}"];
  const bad = [];
  plan.deviations.forEach((d, i) => {
    const miss = DEVIATION_FIELDS.filter((k) => {
      if (k === "nodeId") return !(d && ((typeof d.nodeId === "string" && d.nodeId) || (Array.isArray(d.nodeIds) && d.nodeIds.length)));
      return !(d && d[k] !== undefined && d[k] !== null && d[k] !== "");
    });
    if (miss.length) bad.push(`#${i}${d && d.id ? ` (${d.id})` : ""}: ${miss.join(", ")}`);
  });
  return bad.length ? [`${bad.length} deviation(s) are missing fields — each needs {nodeId, field, designed, built, reason} so a reviewer can check it against the export: ${bad.slice(0, 6).join("; ")}${bad.length > 6 ? `; +${bad.length - 6} more` : ""}`] : [];
}

// P3 #150/#151/#180: the header every other skill resolves a plan by. A warning — plan-skeleton.js
// writes it, so a plan without it was hand-written.
function validatePlanHeader(plan) {
  const missing = ["screenName", "nodeId", "route", "file"].filter((k) => plan[k] === undefined || plan[k] === null || plan[k] === "");
  if (!missing.length) return [];
  return [
    `plan header is missing ${missing.map((k) => `\`${k}\``).join(", ")} — other skills (verify, sync-design) resolve a screen through this header, not through the free-text \`screen\` field; add ${missing.length > 1 ? "them" : "it"} so this plan is findable by node id/name/route without guessing (plan-skeleton.js writes the header; only the route is yours to fill)`,
  ];
}

// Token definitions are not token usages. A DEFINITION line declares the code token itself:
// `--color-figma-brand-600: #5b5fc7` (web-tailwind's `figma-` namespace, profile web-tailwind.md),
// `--brand-600: #5b5fc7`, `brand600: "#5b5fc7"`, `val brand600 = Color(0xFF5B5FC7)`. The declared
// name must be the TOKEN's — `color: #5b5fc7` inside a component declares a CSS property.
const DECLARATION = /(^|[\s;{,(])(--[\w-]+|[\w$][\w$-]*)\s*[:=]\s*[^;,}\n]*$/;
const slug = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
// Strip what differs between a CSS variable and the utility/token that uses it: the category prefix
// (`--color-`, `bg-`, `text-`, `gap-`, `rounded-` …), the `figma-` namespace, and a `-<8 hex>` key suffix.
function tokenCore(x) {
  let s = String(x || "").toLowerCase().replace(/^--/, "").replace(/^var\(--|\)$/g, "");
  s = s.replace(/^(color|colors|spacing|space|radius|rounded|text|font|font-size|font-weight|leading|tracking|shadow|bg|border|fill|stroke|ring|outline|gap|gap-[xy]|p[xytrbl]?|m[xytrbl]?|w|h|size|inset|top|left|right|bottom)-/, "");
  s = s.replace(/^figma-/, "").replace(/-[0-9a-f]{8}$/, "");
  return slug(s);
}
function declaresToken(line, literal, codeToken) {
  const at = line.indexOf(literal);
  if (at === -1) return false;
  const m = DECLARATION.exec(line.slice(0, at));
  if (!m) return false;
  const declared = slug(m[2]), token = slug(codeToken);
  if (!declared || !token) return false;
  const dc = tokenCore(m[2]), tc = tokenCore(codeToken);
  return declared === token || declared.includes(token) || token.includes(declared) || (!!dc && !!tc && (dc === tc || dc.includes(tc) || tc.includes(dc)));
}

// Returns { blocking: [...], warnings: [...] }.
function checkPlan({ plan, file }, cwd, opts) {
  const o = opts || {};
  const blocking = [], warnings = [];
  const listed = Array.isArray(plan.files) ? plan.files.map(String) : [];
  const absent = listed.filter((f) => !fs.existsSync(path.join(cwd, f)));
  if (!listed.length) warnings.push("`files` is empty — list every file this build created or changed; the literal and import checks only read the files named there, so nothing was checked");
  if (absent.length) warnings.push(`file(s) listed in \`files\` not found on disk: ${absent.join(", ")} — fix the path(s) (relative to the project root) or remove entries for files that were not written`);

  const byFile = listed.filter((rel) => fs.existsSync(path.join(cwd, rel)) && fs.statSync(path.join(cwd, rel)).isFile())
    .map((rel) => ({ rel, text: fs.readFileSync(path.join(cwd, rel), "utf8") }));
  const code = byFile.filter((f) => isSourceFile(f.rel)).map((f) => ({ rel: f.rel, text: scanText(f.rel, f.text) }));
  const source = code.map((f) => f.text).join("\n");

  const allowed = new Set((plan.allowedLiterals || []).filter((a) => a && a.reason && a.value !== undefined).map((a) => String(a.value).toLowerCase()));
  const allowedFiles = (plan.allowedLiterals || []).filter((a) => a && a.reason && a.file).map((a) => String(a.file));
  const isAllowed = (row, literal) => allowed.has(String(row.value).toLowerCase()) || allowed.has(String(literal).toLowerCase());
  function definedOnlyInTokenSource(literal, codeToken) {
    if (!literal) return false;
    let seen = false;
    for (const f of code) {
      if (!f.text.includes(literal)) continue;
      if (allowedFiles.includes(f.rel)) { seen = true; continue; }
      for (const line of f.text.split("\n")) {
        if (!line.includes(literal)) continue;
        if (!declaresToken(line, literal, codeToken)) return false;
        seen = true;
      }
    }
    return seen;
  }

  const tokens = Array.isArray(plan.tokens) ? plan.tokens : [];
  const live = tokens.filter((r) => verdictOf(r) !== "hidden-only");
  // One message, however many rows: a fresh plan-skeleton plan has every row unfilled, and 33 lines
  // of the same sentence would bury the two things that actually block.
  const undecided = live.filter((row) => (verdictOf(row) === "missing" || !hasToken(row)) && !row.decision);
  if (undecided.length) {
    const show = undecided.slice(0, 8).map((row) => `${row.figmaName ? `'${row.figmaName}' ` : ""}${row.value} (${row.kind})`).join(", ");
    warnings.push(`${undecided.length} token row(s) have no token and no recorded decision: ${show}${undecided.length > 8 ? `, +${undecided.length - 8} more` : ""} — fill codeToken, or say what you did about it in \`decision\` (a one-off literal is a legitimate answer; say so)`);
  }

  // Token IDENTITY: two DIFFERENT Figma tokens on one code token (finding 130 — right, and kept).
  const byCodeToken = new Map();
  for (const row of live) {
    if (!hasToken(row) || !row.figmaName) continue;
    const c = String(row.codeToken).trim();
    const names = byCodeToken.get(c) || new Map();
    if (!names.has(row.figmaName)) names.set(row.figmaName, row.value);
    byCodeToken.set(c, names);
  }
  for (const [c, names] of byCodeToken) {
    if (names.size < 2) continue;
    const l = [...names].map(([n, v]) => `'${n}' (${v})`).join(" and ");
    warnings.push(`code token '${c}' is mapped from ${names.size} DIFFERENT Figma tokens — ${l}. They may share a value in the exported mode, but they are separate tokens and will diverge in another mode/theme; give each its own code token named after its own Figma name`);
  }

  // BLOCK 1: an unexplained colour literal. One message per LITERAL, however many plan rows resolve it
  // (finding 100 raised two problems for one comment).
  const colors = colorLiterals(source);
  const colourHits = new Map();
  for (const row of live) {
    if (!hasToken(row) || String(row.kind).toLowerCase() !== "color") continue;
    const h = colorKey(row.value);
    const lit = h && colors.get(h);
    if (lit && !isAllowed(row, lit) && !definedOnlyInTokenSource(lit, row.codeToken)) {
      if (!colourHits.has(lit)) colourHits.set(lit, { value: row.value, tokens: [] });
      const e = colourHits.get(lit);
      if (!e.tokens.includes(row.codeToken)) e.tokens.push(row.codeToken);
    }
  }
  for (const [lit, e] of colourHits) {
    const where = code.filter((f) => f.text.includes(lit)).map((f) => f.rel);
    blocking.push(`raw colour ${lit} in ${where.join(", ")}, but the plan resolved ${e.value} to token ${e.tokens.map((t) => `'${t}'`).join(" / ")} — use the token, not the literal (comments, prose strings and non-source files such as .svg are not scanned). A value that must stay literal goes in allowedLiterals as {"value": "${lit}", "reason": "…"}, matched on the exact value string, or name the file that defines the tokens: {"file": "…", "reason": "…"}`);
  }

  const dims = arbitraryPx(source);
  for (const row of live) {
    if (!hasToken(row) || String(row.kind).toLowerCase() === "color") continue;
    const n = parseFloat(row.value);
    const hits = Number.isFinite(n) ? dims.get(n) || [] : [];
    const hit = hits.find((e) => kindsCompatible(e.utility, row.kind) && !isAllowed(row, e.literal) && !definedOnlyInTokenSource(e.literal, row.codeToken));
    if (hit) warnings.push(`arbitrary value ${hit.utility ? `${hit.utility}-${hit.literal}` : hit.literal} in built code, but the plan resolved ${row.value} (${row.kind}) to token '${row.codeToken}' — use the token (or add it to allowedLiterals with a reason)`);
  }

  const mapped = loadMapKeys(cwd);
  const seenModule = new Set();
  for (const row of Array.isArray(plan.components) ? plan.components : []) {
    const verdict = verdictOf(row);
    if (verdict === "reused" && row.mapModule && !seenModule.has(row.mapModule)) {
      seenModule.add(row.mapModule);
      if (!moduleImported(row.mapModule, byFile, cwd)) warnings.push(`component '${row.name}' is "reused" from ${row.mapModule}, but no file in files[] imports that module (compared by resolved path / path suffix, so '../../components/X' and '@/components/X' both count) — was it regenerated instead of reused?`);
    }
    if (verdict === "new" && row.key && mapped.has(row.key)) {
      warnings.push(`component '${row.name}' is marked "new" in the plan, but its Figma key is mapped to ${mapped.get(row.key).module} in codeconnect.local.json — reuse the existing component`);
    }
    if (verdict === "missing") warnings.push(`component '${row.name}' has no recorded reuse/new decision`);
  }

  // BLOCK 2: every visible design node has an anchor (itself or an ancestor).
  const exp = o.export === undefined ? locateExport(plan, file, cwd) : o.export;
  if (!exp) {
    warnings.push("could not find this plan's screen export (no `file`/`nodeId` header, and no node id in its name) — the anchor check did not run; plan-skeleton.js writes the header");
  } else {
    const cov = anchorCoverage(plan, exp.doc);
    if (cov.unmapped.length) {
      const show = cov.unmapped.slice(0, 10).map((u) => `${u.id} '${String(u.name).trim()}' (${u.type})`).join(", ");
      blocking.push(`${cov.unmappedNodes} visible design node(s) have no anchor in the plan — neither they nor any ancestor map to code. Top of each unmapped subtree: ${show}${cov.unmapped.length > 10 ? `, +${cov.unmapped.length - 10} more` : ""}. Add anchors["<id>"] = {"mapModule": "<the file that renders it>"} on the subtree's top (children inherit it), or {"omitted": "<why it is not built>"} — plan-skeleton.js lists every visible node`);
    }
    if (cov.wrappers.length) warnings.push(`${cov.wrappers.length} visible container(s) have anchored children but no anchor of their own (e.g. ${cov.wrappers.slice(0, 3).map((w) => `${w.id} '${String(w.name).trim()}'`).join(", ")}) — anchor the frame to the screen component so sync-design can place a change to it`);
    if (cov.hiddenAnchored.length) warnings.push(`${cov.hiddenAnchored.length} anchor(s) point at HIDDEN nodes (${cov.hiddenAnchored.slice(0, 4).join(", ")}${cov.hiddenAnchored.length > 4 ? ", …" : ""}) — hidden layers are not built; remove them`);
    if (cov.unknown.length) warnings.push(`${cov.unknown.length} anchor(s) name node ids that are not on this frame (${cov.unknown.slice(0, 4).join(", ")}${cov.unknown.length > 4 ? ", …" : ""}) — e.g. a shared shell tagged with another frame's instance ids; anchor THIS frame's ids`);
  }

  warnings.push(...checkVerification(plan, cwd));
  warnings.push(...verificationWarnings(plan));
  warnings.push(...verificationContradictions(plan, o.reports || locateReports(plan, file, cwd, exp)));
  warnings.push(...deviationWarnings(plan));
  warnings.push(...validatePlanHeader(plan));
  return { blocking, warnings };
}

// ================================================================ the verify report behind a plan

// Reports are found by name first — `<Layer>__<id>` (verify-screen's default --out since P3), the plan's
// own name, its `screen` — then by content: a report whose `nodeId` is the plan's, or whose `screen`
// is the frame's layer name when that name is unique in the export (the pre-P3 `JobRoles.report.json`
// naming carries only the layer name). Every match counts; ONE failing report is enough to fail.
function locateReports(plan, planFile, cwd, exp) {
  const dir = path.join(cwd, "design", "verify");
  if (!fs.existsSync(dir)) return [];
  const e = exp === undefined ? locateExport(plan, planFile, cwd) : exp;
  const stems = new Set([
    plan.file ? path.basename(String(plan.file)).replace(/\.json$/i, "") : null,
    e ? path.basename(e.file).replace(/\.json$/i, "") : null,
    planFile ? path.basename(planFile, ".json") : null,
    plan.screen ? String(plan.screen) : null,
  ].filter(Boolean));
  const nodeId = plan.nodeId || (e && e.nodeId) || idFromStem(plan.screen) || (planFile ? idFromStem(path.basename(planFile, ".json")) : null);
  const layer = e ? e.layerName.trim() : null;
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".report.json")).sort()) {
    const abs = path.join(dir, f);
    const r = readJsonOr(abs, null);
    if (!r) continue;
    const stem = f.replace(/\.report\.json$/, "");
    let by = null;
    if (stems.has(stem)) by = "name";
    else if (nodeId && (r.nodeId === nodeId || idFromStem(stem) === nodeId)) by = "nodeId";
    else if (layer && e.sameNameRows <= 1 && String(r.screen || "").trim() === layer) by = "layer name";
    if (!by) continue;
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(abs).mtimeMs; } catch { /* ignore */ }
    out.push({ rel: path.relative(cwd, abs).split(path.sep).join("/"), matchedBy: by, verdict: r.verdict || null, why: Array.isArray(r.why) ? r.why : [], deltas: Array.isArray(r.deltas) ? r.deltas : null, exportedAt: r.exportedAt || null, measuredAt: r.measuredAt || null, mtimeMs });
  }
  return out;
}

// ================================================================ computed status

function computeStatus(plan, opts) {
  const o = opts || {};
  const cwd = o.cwd || (o.planFile ? rootOfPlan(o.planFile) : process.cwd());
  const reasons = [];
  const stored = String((plan && plan.status) || "").trim().toLowerCase();
  if (COMPUTED_STORED.has(stored)) reasons.push(`the stored "status": "${plan.status}" was written by an older hook and is ignored — status is computed`);
  const life = lifecycleOf(plan);
  if (life !== "pending") return { status: life, reasons: [life === "abandoned" ? "retired by hand" : "paused on a question for the user"], reports: [] };
  const hook = plan.verification && plan.verification.hook;
  if (!hook || !hook.result) return { status: "pending", reasons: reasons.concat("the build-screen Stop hook has not checked this plan"), reports: [] };
  if (hook.planHash && hook.planHash !== planHash(plan)) return { status: "pending", reasons: reasons.concat("the plan changed after the hook's last check"), reports: [] };
  if (hook.result !== "pass") return { status: "blocked", reasons: reasons.concat(hook.blocking && hook.blocking.length ? hook.blocking : ["the hook's last check blocked"]), reports: [] };
  const ch = changedFiles(plan, cwd) || [];
  if (ch.length) return { status: "stale", reasons: reasons.concat(`file(s) changed since the hook passed: ${ch.slice(0, 6).join(", ")}${ch.length > 6 ? `, +${ch.length - 6} more` : ""}`), reports: [] };
  const exp = o.export === undefined ? locateExport(plan, o.planFile, cwd) : o.export;
  const reports = o.reports || locateReports(plan, o.planFile, cwd, exp);
  const failing = reports.filter((r) => r.verdict !== "pass");
  if (failing.length) {
    return { status: "failed", reasons: reasons.concat(failing.map((r) => `${r.rel} says verdict ${JSON.stringify(r.verdict)}${r.why.length ? `: ${r.why.join("; ")}` : ""}`)), reports };
  }
  const mode = plan.verification && plan.verification.mode;
  if (!reports.length) {
    if (mode === "static-only") return { status: "static-only", reasons: reasons.concat(`built and checked statically — not rendered (${plan.verification.reason || "no reason recorded"})`), reports };
    return { status: "unverified", reasons: reasons.concat("no verify report found for this screen in design/verify/ — run verify-screen.js --expect/--compare (the report's verdict is what grants \"verified\")"), reports };
  }
  let newest = 0;
  for (const rel of Array.isArray(plan.files) ? plan.files : []) { try { newest = Math.max(newest, fs.statSync(path.join(cwd, String(rel))).mtimeMs); } catch { /* ignore */ } }
  const older = reports.filter((r) => r.mtimeMs && newest && r.mtimeMs < newest);
  if (older.length) return { status: "unverified", reasons: reasons.concat(`${older.map((r) => r.rel).join(", ")} is older than the newest file in files[] — it describes an earlier build; re-run --compare`), reports };
  const expAt = exp && exp.doc && exp.doc.exportedAt;
  const onOld = expAt ? reports.filter((r) => r.exportedAt && r.exportedAt !== expAt) : [];
  if (onOld.length) return { status: "unverified", reasons: reasons.concat(`${onOld.map((r) => r.rel).join(", ")} was computed against an export from ${onOld[0].exportedAt}; the export on disk is from ${expAt} — re-run --expect and --compare`), reports };
  return { status: "verified", reasons: reasons.concat(`hook passed, files unchanged, ${reports.map((r) => r.rel).join(", ")} says pass`), reports };
}

// ================================================================ fan-out scoping

// Several screens build in parallel (one screen-builder each), and every one lands here when it
// stops. Narrow to the plans the stopping agent's own transcript mentions (a subagent's own transcript
// when the payload names one, else the session's) — on positive evidence only: a transcript that
// mentions NO plan file at all keeps every open plan. A transcript that mentions only plans the hook
// already closed narrows to nothing: agent A, finished, is not blocked on agent B's half-built plan.
function ownPlans(open, input, all) {
  const file = input.agent_transcript_path || (input.agent_id ? null : input.transcript_path);
  if (!file) return open;
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return open; }
  const mentioned = (p) => { const base = path.basename(p.file); return text.includes("plan/" + base) || text.includes("plan\\\\" + base); };
  const known = all && all.length ? all : open;
  if (!known.some(mentioned)) return open;
  return open.filter(mentioned);
}

// ================================================================ CLI

const USAGE = [
  "usage: node verify-build.js                     (Stop hook: reads the hook JSON from stdin when stdin is not a terminal)",
  "       node verify-build.js <plan.json>…        check these plans now (no stdin read)",
  "       node verify-build.js --status [<plan.json>…] [--json]   print each plan's computed status (all of design/plan/ by default); never writes",
  "",
  "Blocks (exit 2) on exactly two things: a raw colour the plan resolved to a token, in a source file of",
  "files[] (comments, prose strings and .svg/.json/non-source files are not scanned); and a visible",
  "design node with no anchor (itself or an ancestor) in anchors{}. Everything else is a warning (exit 0).",
  "Never writes plan.status: it records verification.hook {result, planHash, files:{path: sha256}}, and",
  "--status computes pending | blocked | stale | failed | unverified | static-only | verified from that,",
  "the file hashes, and design/verify/<…>.report.json's verdict.",
].join("\n");

function checkAndRecord(p, cwd, input) {
  const exp = locateExport(p.plan, p.file, cwd);
  const reports = locateReports(p.plan, p.file, cwd, exp);
  setPhase(`checking ${path.basename(p.file)}`);
  const { blocking, warnings } = checkPlan(p, cwd, { export: exp, reports });
  const plan = p.plan;
  const cleared = COMPUTED_STORED.has(String(plan.status || "").toLowerCase()) ? plan.status : null;
  if (cleared) delete plan.status;
  if (!plan.verification || typeof plan.verification !== "object") plan.verification = {};
  setPhase(`hashing files[] of ${path.basename(p.file)}`);
  plan.verification.hook = {
    result: blocking.length ? "blocked" : "pass",
    checkedAt: new Date().toISOString(),
    blocking,
    warnings: warnings.length,
    planHash: planHash(plan),
    files: fileHashes(plan, cwd),
  };
  // The plan's mtime is the staleness clock — it measures the BUILDER's last edit. The hook's own
  // write must not reset it, or a blocked leftover plan would stay "fresh" (and nag) forever.
  let times = null;
  try { const s = fs.statSync(p.file); times = [s.atime, s.mtime]; } catch { /* new file */ }
  fs.writeFileSync(p.file, JSON.stringify(plan, null, 2) + "\n");
  if (times) try { fs.utimesSync(p.file, times[0], times[1]); } catch { /* ignore */ }
  const st = computeStatus(plan, { cwd, planFile: p.file, export: exp, reports });
  return { blocking, warnings, cleared, status: st };
}

async function main(argv) {
  const args = argv.slice();
  if (args.includes("--help") || args.includes("-h")) { console.log(USAGE); return 0; }
  const statusMode = args.includes("--status");
  const json = args.includes("--json");
  const planArgs = args.filter((a) => !a.startsWith("-"));
  const stray = args.filter((a) => a.startsWith("-") && !["--status", "--json"].includes(a));
  if (stray.length) { console.error(`verify-build: unknown flag ${stray.join(", ")}\n${USAGE}`); return 2; }

  if (statusMode) {
    setPhase("computing plan status");
    const plans = planArgs.length ? planArgs.map((f) => readPlan(path.resolve(f))).filter(Boolean) : findPlans(process.cwd());
    const show = (f) => { const r = path.relative(process.cwd(), f); return r.startsWith("..") ? f : r; };
    const rows = plans.map((p) => Object.assign({ plan: show(p.file) }, computeStatus(p.plan, { planFile: p.file, cwd: rootOfPlan(p.file) })));
    if (json) console.log(JSON.stringify(rows.map((r) => ({ plan: r.plan, status: r.status, reasons: r.reasons, reports: r.reports.map((x) => ({ file: x.rel, verdict: x.verdict, matchedBy: x.matchedBy })) })), null, 2));
    else for (const r of rows) console.log(`${r.plan}: ${r.status}${r.reasons.length ? "\n  - " + r.reasons.join("\n  - ") : ""}`);
    if (!plans.length) console.error("verify-build: no plans found (design/plan/*.json)");
    return 0;
  }

  let input = {};
  let targets;
  if (planArgs.length) {
    targets = planArgs.map((f) => readPlan(path.resolve(f)));
    const bad = planArgs.filter((f, i) => !targets[i]);
    if (bad.length) { console.error(`verify-build: cannot read plan(s): ${bad.join(", ")}`); return 1; }
  } else {
    setPhase("reading the hook payload on stdin");
    const r = await readHookInput();
    if (r.error) { console.error(`verify-build: ${r.error}`); return 1; }
    input = r.payload || {};
    if (input.stop_hook_active) return 0; // avoid re-entrant loops on the same turn
  }

  const all = [];
  if (targets) {
    for (const p of targets) {
      const cwd = rootOfPlan(p.file);
      const life = lifecycleOf(p.plan);
      if (life !== "pending") { console.error(`verify-build: ${path.basename(p.file)} is "${life}" — not checked`); continue; }
      all.push({ p, cwd });
    }
  } else {
    const cwd = input.cwd || process.cwd();
    setPhase("finding open plans in design/plan/");
    const plans = findPlans(cwd);
    const open = plans.filter((p) => isOpen(p, cwd));
    if (!open.length) return 0; // fast path
    for (const p of ownPlans(open, input, plans)) all.push({ p, cwd });
  }

  const blockedOut = [];
  for (const { p, cwd } of all) {
    const res = checkAndRecord(p, cwd, input);
    const name = path.basename(p.file);
    if (res.cleared) console.error(`verify-build: ${name}: removed the stored "status": "${res.cleared}" — status is computed now (verify-build.js --status), never stored`);
    for (const w of res.warnings) console.error(`verify-build: warning (${name}): ${w}`);
    if (res.blocking.length) blockedOut.push(`# ${name}`, ...res.blocking.map((m) => `  - ${m}`));
    const why = res.blocking.length ? "see below" : res.status.reasons[res.status.reasons.length - 1];
    console.error(`verify-build: ${name}: hook ${res.blocking.length ? "BLOCKED" : "passed"} · computed status: ${res.status.status}${why ? ` — ${why}` : ""}`);
  }
  if (blockedOut.length) {
    console.error("\nverify-build: build-screen check failed — do not report this screen as done until these are resolved");
    console.error("(a plan that will not be finished: set its status to \"abandoned\"; a build paused on a question for the user: \"awaiting-user\", then ask):\n");
    console.error(blockedOut.join("\n"));
    return 2;
  }
  return 0;
}

module.exports = {
  checkPlan, computeStatus, locateReports, locateExport, anchorCoverage, moduleImported, importsOf, scanText, isSourceFile,
  verificationWarnings, verificationContradictions, deviationWarnings, validatePlanHeader, ownPlans, checkVerification,
  colorLiterals, arbitraryPx, hex6, colorKey, isStale, isOpen, planHash, fileHashes, readHookInput, main, USAGE,
};

if (require.main === module) {
  const watchdog = setTimeout(() => {
    console.error(`verify-build: gave up after ${Math.round(HOOK_TIMEOUT_MS() / 1000)} s while ${phase} — nothing was blocked; re-run \`node verify-build.js <plan.json>\` to check the plan directly`);
    process.exit(1);
  }, HOOK_TIMEOUT_MS());
  watchdog.unref();
  // exitCode, not exit(): on macOS a pipe write is asynchronous, and exit() would cut a long --json
  // listing or the itemised block message short. stdin is paused+unref'd and the watchdog unref'd, so
  // nothing keeps the process alive once main() is done.
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(`verify-build: ${e && e.stack || e}`); process.exitCode = 1; });
}
