// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.

// design-to-code/verify-build.js
var fs = require("fs");
var path = require("path");
function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
var STALE_HOURS = 12;
function staleCutoffMs() {
  const raw = process.env.DTWIN_PLAN_STALE_HOURS;
  const h = raw === void 0 || raw === "" ? STALE_HOURS : Number(raw);
  return Number.isFinite(h) && h > 0 ? h * 3600 * 1e3 : 0;
}
function isStale(file, now = Date.now()) {
  const cutoff = staleCutoffMs();
  if (!cutoff) return false;
  try {
    return now - fs.statSync(file).mtimeMs > cutoff;
  } catch {
    return false;
  }
}
function findPlans(cwd) {
  const dir = path.join(cwd, "design", "plan");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
    try {
      return { file: path.join(dir, f), plan: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) };
    } catch {
      return null;
    }
  }).filter(Boolean);
}
function hex6(value) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(value).trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  return h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
}
function colorKey(value) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(value).trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  const full = h.length <= 4 ? h.split("").map((c) => c + c).join("") : h;
  return full.length === 6 ? full + "ff" : full;
}
function colorLiterals(source) {
  const found = /* @__PURE__ */ new Map();
  const add = (h, lit) => {
    if (h && !found.has(h)) found.set(h, lit);
  };
  for (const m of source.matchAll(/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g)) add(colorKey(m[1]), m[0]);
  for (const m of source.matchAll(/\b0x([0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/g)) {
    const h = m[1].toLowerCase();
    add(h.length === 8 ? h.slice(2) + h.slice(0, 2) : h + "ff", m[0]);
  }
  for (const m of source.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?[^)]*\)/g)) {
    const rgb = [m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("");
    add(rgb + alphaHex(m[4]), m[0]);
  }
  return found;
}
function alphaHex(a) {
  if (a === void 0 || a === "") return "ff";
  const n = String(a).endsWith("%") ? Number(String(a).slice(0, -1)) / 100 : Number(a);
  if (!Number.isFinite(n)) return "ff";
  return Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, "0");
}
function arbitraryPx(source) {
  const found = /* @__PURE__ */ new Map();
  for (const m of source.matchAll(/\[(-?\d+(?:\.\d+)?)(px|rem)\]/g)) {
    const px = Number(m[1]) * (m[2] === "rem" ? 16 : 1);
    if (!found.has(px)) found.set(px, m[0]);
  }
  return found;
}
function loadMapKeys(cwd) {
  try {
    const map = JSON.parse(fs.readFileSync(path.join(cwd, "codeconnect.local.json"), "utf8"));
    const keys = /* @__PURE__ */ new Map();
    for (const [name, e] of Object.entries(map.components || {})) {
      if (e && e.figma && e.figma.key && e.code && e.code.module && e.status !== "deprecated") keys.set(e.figma.key, { name, module: e.code.module });
    }
    return keys;
  } catch {
    return /* @__PURE__ */ new Map();
  }
}
function checkVerification(plan, cwd) {
  const v = plan.verification;
  if (!v || typeof v !== "object") {
    return ['no `verification` block in the plan \u2014 record how the build was checked: {mode:"rendered", renderer, artifacts:[\u2026], deltas:[\u2026]} after rendering and comparing (references/verify.md), or {mode:"static-only", reason} if the project genuinely has no way to render'];
  }
  if (v.mode === "rendered") {
    const artifacts = Array.isArray(v.artifacts) ? v.artifacts : [];
    if (!artifacts.length) return ['verification.mode is "rendered" but `artifacts` is empty \u2014 list the screenshot(s)/report the render produced'];
    const missing = artifacts.filter((a) => !fs.existsSync(path.join(cwd, String(a))));
    if (missing.length) return [`verification artifact(s) not found on disk: ${missing.join(", ")} \u2014 render the screen, or record mode "static-only" with the reason`];
    if (!Array.isArray(v.deltas)) return ["verification.deltas is missing \u2014 list the residual differences against the reference ([] if none were found)"];
    return [];
  }
  if (v.mode === "static-only") {
    return v.reason ? [] : ['verification.mode is "static-only" with no `reason` \u2014 say what was checked for and not found (dev server, Playwright, simulator\u2026)'];
  }
  return [`verification.mode must be "rendered" or "static-only", got ${JSON.stringify(v.mode)}`];
}
var verdictOf = (row) => String(row && row.verdict || "").trim().toLowerCase();
var NO_TOKEN = /* @__PURE__ */ new Set(["missing", "none", "n/a", "na", "-", "null", "tbd"]);
var hasToken = (row) => !!row.codeToken && !NO_TOKEN.has(String(row.codeToken).trim().toLowerCase());
function checkPlan({ plan }, cwd) {
  const problems = [];
  const listed = Array.isArray(plan.files) ? plan.files.map(String) : [];
  const absent = listed.filter((f) => !fs.existsSync(path.join(cwd, f)));
  if (!listed.length) problems.push("`files` is empty \u2014 list every file this build created or changed; the token and component checks only read the files named there");
  if (absent.length) problems.push(`file(s) listed in \`files\` not found on disk: ${absent.join(", ")} \u2014 fix the path(s) (relative to the project root) or remove entries for files that were not written`);
  const files = listed.map((f) => path.join(cwd, f)).filter((f) => fs.existsSync(f));
  const sources = files.map((f) => fs.readFileSync(f, "utf8"));
  const source = sources.join("\n");
  const allowed = new Set((plan.allowedLiterals || []).filter((a) => a && a.reason).map((a) => String(a.value).toLowerCase()));
  const isAllowed = (row, literal) => allowed.has(String(row.value).toLowerCase()) || allowed.has(String(literal).toLowerCase());
  for (const row of plan.tokens || []) {
    if ((verdictOf(row) === "missing" || !hasToken(row)) && !row.decision) {
      problems.push(`token ${row.value} (${row.kind}) has no token (${JSON.stringify(row.codeToken ?? null)}) and no recorded decision \u2014 say what you did about it (a one-off literal is a legitimate answer; say so) before finishing`);
    }
  }
  const colors = colorLiterals(source);
  const dims = arbitraryPx(source);
  for (const row of plan.tokens || []) {
    if (!hasToken(row)) continue;
    if (row.kind === "color") {
      const h = colorKey(row.value);
      const lit = h && colors.get(h);
      if (lit && !isAllowed(row, lit)) problems.push(`raw literal ${lit} found in built code, but the plan resolved ${row.value} to token '${row.codeToken}' \u2014 use the token, not the literal (or add it to allowedLiterals with a reason)`);
    } else {
      const n = parseFloat(row.value);
      const lit = Number.isFinite(n) && dims.get(n);
      if (lit && !isAllowed(row, lit)) problems.push(`arbitrary value ${lit} found in built code, but the plan resolved ${row.value} (${row.kind}) to token '${row.codeToken}' \u2014 use the token (or add it to allowedLiterals with a reason)`);
    }
  }
  const mapped = loadMapKeys(cwd);
  for (const row of plan.components || []) {
    const verdict = verdictOf(row);
    if (verdict === "reused" && row.mapModule) {
      if (!sources.some((s) => s.includes(row.mapModule))) problems.push(`component '${row.name}' was mapped to ${row.mapModule} in the plan, but no built file imports it \u2014 was it regenerated instead of reused?`);
    }
    if (verdict === "new" && row.key && mapped.has(row.key)) {
      const m = mapped.get(row.key);
      problems.push(`component '${row.name}' is marked "new" in the plan, but its Figma key is mapped to ${m.module} in codeconnect.local.json \u2014 reuse the existing component`);
    }
    if (verdict === "missing") {
      problems.push(`component '${row.name}' has no recorded reuse/new decision \u2014 resolve before finishing`);
    }
  }
  problems.push(...checkVerification(plan, cwd));
  return problems;
}
function verificationWarnings(plan) {
  const v = plan.verification;
  if (!v || v.mode !== "rendered") return [];
  const out = [];
  const c = v.coverage;
  if (!c || !Array.isArray(c.rendered) || !c.rendered.length) out.push('verification.coverage is missing \u2014 record {rendered:[\u2026], notChecked:[{what, why}]} so the report can say which states/themes/sizes were never rendered (references/verify.md, "Beyond the ideal frame")');
  if (!v.a11y) out.push("verification.a11y is missing \u2014 no accessibility check is recorded (web: @axe-core/playwright on the rendered page); say so in the report rather than implying one ran");
  return out;
}
function passedStatus(plan) {
  return plan.verification && plan.verification.mode === "rendered" ? "verified" : "static-only";
}
function ownPlans(pending, input) {
  if (pending.length < 2) return pending;
  const file = input.agent_transcript_path || (input.agent_id ? null : input.transcript_path);
  if (!file) return pending;
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return pending;
  }
  const mine = pending.filter((p) => {
    const base = path.basename(p.file);
    return text.includes("plan/" + base) || text.includes("plan\\\\" + base);
  });
  return mine.length ? mine : pending;
}
function main() {
  const input = readStdinJson();
  if (input.stop_hook_active) process.exit(0);
  const cwd = input.cwd || process.cwd();
  const pending = findPlans(cwd).filter((p) => (p.plan.status || "pending") === "pending" && !isStale(p.file));
  if (!pending.length) process.exit(0);
  const plans = ownPlans(pending, input);
  const allProblems = [];
  for (const p of plans) {
    const problems = checkPlan(p, cwd);
    if (problems.length) allProblems.push(`# ${path.basename(p.file)}`, ...problems.map((m) => `  - ${m}`));
  }
  if (allProblems.length) {
    console.error("verify-build: build-screen check failed \u2014 do not report this screen as done until these are resolved");
    console.error('(a plan that will not be finished: set its status to "abandoned"; a build paused on a question for the user: "awaiting-user", then ask):\n');
    console.error(allProblems.join("\n"));
    process.exit(2);
  }
  for (const { file, plan } of plans) {
    for (const w of verificationWarnings(plan)) console.error(`verify-build: warning (${path.basename(file)}): ${w}`);
    plan.status = passedStatus(plan);
    fs.writeFileSync(file, JSON.stringify(plan, null, 2) + "\n");
  }
  process.exit(0);
}
module.exports = { verificationWarnings, ownPlans, checkPlan, checkVerification, passedStatus, colorLiterals, arbitraryPx, hex6, colorKey, isStale };
if (require.main === module) main();
