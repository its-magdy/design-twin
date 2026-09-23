// Offline tests for design-to-code/verify-build.js (the build-screen Stop-hook gate) and for the
// committed claude-plugin/scripts/ bundles it ships in.
//   node test/verify-build.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { checkPlan, computeStatus, colorLiterals, arbitraryPx, hex6, colorKey, isStale, validatePlanHeader, anchorCoverage, moduleImported, importsOf,
  scanText, isSourceFile, verificationContradictions, deviationWarnings } = require("../design-to-code/verify-build");
const { check, report } = require("./assert");

const HOOK = require.resolve("../design-to-code/verify-build.js");

// A throwaway consumer project: files + a plan, returns its root.
function project(files, plan, map) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-verify-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  fs.mkdirSync(path.join(root, "design", "plan"), { recursive: true });
  fs.writeFileSync(path.join(root, "design", "plan", "login.json"), JSON.stringify(plan));
  if (map) fs.writeFileSync(path.join(root, "codeconnect.local.json"), JSON.stringify(map));
  return root;
}
const runHook = (root, stdin) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(stdin || { cwd: root }), encoding: "utf8" });
const planOf = (root) => JSON.parse(fs.readFileSync(path.join(root, "design", "plan", "login.json"), "utf8"));
// checkPlan returns { blocking, warnings }. `problems` is both, minus the two warnings every hand-made
// test plan triggers (no plan header, no export to check anchors against) — tests about those say so.
const AMBIENT = /plan header is missing|could not find this plan's screen export/;
const split = (files, plan, map) => { const root = project(files, plan, map); return checkPlan({ plan }, root); };
const problems = (files, plan, map) => { const r = split(files, plan, map); return [...r.blocking, ...r.warnings.filter((w) => !AMBIENT.test(w))]; };
const blocks = (files, plan, map) => split(files, plan, map).blocking;
const has = (list, re) => list.some((m) => re.test(m));
const statusOf = (root) => computeStatus(planOf(root), { cwd: root, planFile: path.join(root, "design", "plan", "login.json") }).status;

const STATIC = { mode: "static-only", reason: "no dev server in package.json" };
const brand = { value: "#5B5FC7", kind: "color", codeToken: "brand-600", verdict: "exact" };
const gap16 = { value: "16", kind: "spacing", codeToken: "spacing-4", verdict: "exact" };

console.log("literal parsing:");
check("hex6 normalises 3/6/8-digit hex, rejects junk", hex6("#abc") === "aabbcc" && hex6("#5B5FC7") === "5b5fc7" && hex6("#5B5FC7CC") === "5b5fc7" && hex6("red") === null);
check("colorLiterals reads #hex, 0xAARRGGBB and rgb(), keyed rrggbb+alpha", (() => {
  const c = colorLiterals("a #5B5FC7 b Color(0xFF112233) c rgba(255, 0, 10, 0.5)");
  // opaque -> "ff"; 0xAARRGGBB puts alpha FIRST, so it must be moved to the end; rgba's 0.5 -> 80.
  return c.has("5b5fc7ff") && c.has("112233ff") && c.has("ff000a80");
})());
// Live run #25: alpha was folded away, so #ffffff and #ffffff1a shared one key. The scan then
// reported whichever spelling it saw first — the live run said "raw literal #ffffff" for a plan row
// that read #ffffff1a, which looks like a hook bug — and an allowedLiterals entry for one exempted
// the other. They are different colors (opaque white vs a 10% scrim) and must stay different keys.
check("[alpha] 8-digit hex keeps its alpha, so it cannot collide with the opaque form", (() => {
  const c = colorLiterals("bg-[#ffffff1a] and #ffffff");
  return c.get("ffffff1a") === "#ffffff1a" && c.get("ffffffff") === "#ffffff" && c.size === 2;
})());
check("[alpha] colorKey normalises every spelling to 8 digits; 3- and 4-digit shorthand expand",
  colorKey("#abc") === "aabbccff" && colorKey("#abcd") === "aabbccdd" && colorKey("#5B5FC7") === "5b5fc7ff"
  && colorKey("#5B5FC7CC") === "5b5fc7cc" && colorKey("red") === null);
check("[alpha] rgba() percent and decimal alpha land on the SAME key as the #rrggbbaa spelling", (() => {
  const c = colorLiterals("rgba(255,255,255,0.1) rgb(1,2,3)");
  return c.has("ffffff1a") && colorLiterals("rgba(255,255,255,10%)").has("ffffff1a") && c.has("010203ff");
})());
check("[alpha] a scrim is no longer exempted by an allowedLiterals entry for the opaque colour", (() => {
  const scrim = { value: "#ffffff1a", kind: "color", codeToken: "bg-scrim", verdict: "exact" };
  const pr = problems({ "a.tsx": "bg-[#ffffff1a]" }, { files: ["a.tsx"], tokens: [scrim],
    allowedLiterals: [{ value: "#ffffff", reason: "theme defines white" }], verification: STATIC });
  // …and the message names the spelling that is actually in the code, not the other one.
  return pr.length === 1 && /raw colour #ffffff1a\b/.test(pr[0]) && /bg-scrim/.test(pr[0]);
})());
check("arbitraryPx reads [Npx] and [Nrem] as px", (() => { const d = arbitraryPx("gap-[14px] p-[1.5rem]"); return d.has(14) && d.has(24); })());
// Live finding 88: keyed on the number alone, every `rounded-[20px]` was reported as the 20px a
// fontSize token resolves to — and applying the suggestion ("use text-body-1") would have put a
// font-size utility on a border-radius, which the gate would then have passed.
check("[kind] an arbitrary value remembers which utility it was on", (() => {
  const d = arbitraryPx("rounded-[20px] text-[20px]");
  const u = (d.get(20) || []).map((e) => e.utility).sort();
  return u.length === 2 && u[0] === "rounded" && u[1] === "text";
})());
check("[kind] a radius literal is NOT reported against a fontSize token of the same number", (() => {
  const fontTok = { value: "20", kind: "fontSize", codeToken: "text-body-1", verdict: "exact" };
  return problems({ "a.tsx": '<div className="rounded-[20px]" />' }, { files: ["a.tsx"], tokens: [fontTok], verification: STATIC }).length === 0;
})());
check("[kind] …while the SAME number on a font utility still is", (() => {
  const fontTok = { value: "20", kind: "fontSize", codeToken: "text-body-1", verdict: "exact" };
  return has(problems({ "a.tsx": '<div className="text-[20px]" />' }, { files: ["a.tsx"], tokens: [fontTok], verification: STATIC }), /text-body-1/);
})());
check("[kind] a radius token IS matched by a radius utility", (() => {
  const radiusTok = { value: "12", kind: "radius", codeToken: "rounded-card", verdict: "exact" };
  return has(problems({ "a.tsx": '<div className="rounded-[12px]" />' }, { files: ["a.tsx"], tokens: [radiusTok], verification: STATIC }), /rounded-card/);
})());
check("[kind] padding and gap both count as spacing — the vocabulary really does overlap there", (() => {
  const sp = { value: "16", kind: "spacing", codeToken: "spacing-4", verdict: "exact" };
  return has(problems({ "a.tsx": '<div className="p-[16px]" />' }, { files: ["a.tsx"], tokens: [sp], verification: STATIC }), /spacing-4/)
    && has(problems({ "a.tsx": '<div className="gap-[16px]" />' }, { files: ["a.tsx"], tokens: [sp], verification: STATIC }), /spacing-4/);
})());
check("[kind] an unrecognised utility keeps the check it had, rather than losing it silently", (() => {
  const sp = { value: "16", kind: "spacing", codeToken: "spacing-4", verdict: "exact" };
  return has(problems({ "a.tsx": "style={{ blob: '[16px]' }}" }, { files: ["a.tsx"], tokens: [sp], verification: STATIC }), /spacing-4/);
})());

console.log("token DEFINITIONS are not token usages:");
// Live finding 87: all 19 flagged hexes occurred ONLY in the generated theme files — the files that
// DEFINE the tokens, and which files[] already listed — and not one appeared in a component. The
// build was blocked on 30 items and had to re-declare each generated hex by hand.
check("[defs] a hex that only appears on the line DEFINING its token is not a violation", (() => {
  return problems(
    { "theme.css": ":root {\n  --brand-600: #5B5FC7;\n}", "Card.tsx": '<div className="bg-brand-600" />' },
    { files: ["theme.css", "Card.tsx"], tokens: [brand], verification: STATIC }
  ).length === 0;
})());
check("[defs] the Tailwind v4 @theme spelling counts too (--color-<token>)", (() => {
  const tok = { value: "#03d5ab", kind: "color", codeToken: "success-success", verdict: "exact" };
  return problems(
    { "theme.css": "@theme {\n  --color-success-success: #03d5ab;\n}" },
    { files: ["theme.css"], tokens: [tok], verification: STATIC }
  ).length === 0;
})());
check("[defs] a JS/TS token object is a definition as well", (() => {
  return problems({ "tokens.ts": 'export const theme = {\n  brand600: "#5B5FC7",\n};' },
    { files: ["tokens.ts"], tokens: [brand], verification: STATIC }).length === 0;
})());
check("[defs] but the SAME hex used in a component still fails, even with the theme file present", (() => {
  return has(problems(
    { "theme.css": ":root { --brand-600: #5B5FC7; }", "Card.tsx": "<div style={{ color: '#5B5FC7' }} />" },
    { files: ["theme.css", "Card.tsx"], tokens: [brand], verification: STATIC }
  ), /raw colour #5B5FC7/i);
})());
check("[defs] a CSS PROPERTY declaration is not a token declaration", (() => {
  return has(problems({ "Card.tsx": "color: #5b5fc7" }, { files: ["Card.tsx"], tokens: [brand], verification: STATIC }), /brand-600/);
})());
check("[defs] allowedLiterals may now name a FILE instead of a value", (() => {
  return problems({ "gen.css": "/* generated */ .x{background:#5B5FC7}" },
    { files: ["gen.css"], tokens: [brand], allowedLiterals: [{ file: "gen.css", reason: "generated token source" }], verification: STATIC }).length === 0;
})());
check("[defs] and the failure message says allowedLiterals matches an exact value string", (() => {
  const pr = problems({ "a.tsx": "color: #5b5fc7" }, { files: ["a.tsx"], tokens: [brand], verification: STATIC });
  return pr.length === 1 && /matched on the exact value string/.test(pr[0]) && /"file"/.test(pr[0]);
})());

console.log("token checks — only plan-resolved values fail:");
check("a resolved color used as a raw #hex BLOCKS", has(blocks({ "a.tsx": "color: #5b5fc7" }, { files: ["a.tsx"], tokens: [brand], verification: STATIC }), /raw colour #5b5fc7.*brand-600/));
check("…and as Compose 0xFF… (the old gate was blind to native)", has(problems({ "A.kt": "Color(0xFF5B5FC7)" }, { files: ["A.kt"], tokens: [brand], verification: STATIC }), /0xFF5B5FC7/));
check("…and as rgb()", has(problems({ "a.css": "color: rgb(91, 95, 199)" }, { files: ["a.css"], tokens: [brand], verification: STATIC }), /rgb\(91, 95, 199\)/));
check("an UNRESOLVED rgba() (a one-off shadow) passes — profiles prescribe these", problems({ "a.css": "box-shadow: 0 1px 2px rgba(0,0,0,0.12)" }, { files: ["a.css"], tokens: [brand], verification: STATIC }).length === 0);
check("an UNRESOLVED arbitrary value (text-[15px]) passes", problems({ "a.tsx": "text-[15px]" }, { files: ["a.tsx"], tokens: [gap16], verification: STATIC }).length === 0);
check("a resolved spacing used as gap-[16px] is reported — as a WARNING, never a block", blocks({ "a.tsx": "gap-[16px]" }, { files: ["a.tsx"], tokens: [gap16], verification: STATIC }).length === 0 && has(problems({ "a.tsx": "gap-[16px]" }, { files: ["a.tsx"], tokens: [gap16], verification: STATIC }), /gap-\[16px\].*spacing-4/));
check("…and as gap-[1rem]", has(problems({ "a.tsx": "gap-[1rem]" }, { files: ["a.tsx"], tokens: [gap16], verification: STATIC }), /\[1rem\]/));
check("allowedLiterals with a reason exempts it", problems({ "theme.ts": "brand600: '#5B5FC7'" }, { files: ["theme.ts"], tokens: [brand], allowedLiterals: [{ value: "#5B5FC7", reason: "theme.ts defines the token" }], verification: STATIC }).length === 0);
check("allowedLiterals WITHOUT a reason does not", problems({ "theme.ts": "'#5B5FC7'" }, { files: ["theme.ts"], tokens: [brand], allowedLiterals: [{ value: "#5B5FC7" }], verification: STATIC }).length === 1);
check("a MISSING token with no decision fails; with one passes", (() => {
  const row = { value: "#123456", kind: "color", codeToken: null, verdict: "missing" };
  return has(problems({}, { tokens: [row], verification: STATIC }), /have no token and no recorded decision/)
    && problems({ "a.tsx": "" }, { files: ["a.tsx"], tokens: [{ ...row, decision: "deferred — asked designer" }], verification: STATIC }).length === 0;
})());
// Live run #25: the builder honestly wrote codeToken "MISSING" — the documented "no token exists"
// answer, spelled out rather than as null — and the gate read it as a token NAME, demanding "use the
// token, not the literal" for a token that by definition does not exist. Honesty must not cost more
// than omitting the row.
check("[no-token] codeToken \"MISSING\" is no token at all, not a token named MISSING", (() => {
  const row = { value: "#f1efc4", kind: "color", codeToken: "MISSING", verdict: "MISSING",
    decision: "avatar fill, unbound in the export — one-off literal" };
  return problems({ "a.tsx": "bg-[#f1efc4]" }, { files: ["a.tsx"], tokens: [row], verification: STATIC }).length === 0;
})());
check("[no-token] every no-token spelling behaves the same way", (() => {
  const base = { value: "#f1efc4", kind: "color", decision: "one-off" };
  return ["MISSING", "missing", "none", "n/a", "-", null].every((codeToken) =>
    problems({ "a.tsx": "bg-[#f1efc4]" }, { files: ["a.tsx"], tokens: [{ ...base, codeToken }], verification: STATIC }).length === 0);
})());
check("[no-token] but a row with no token AND no decision still fails — the rule keeps its teeth", (() => {
  const pr = problems({ "a.tsx": "bg-[#f1efc4]" }, { files: ["a.tsx"],
    tokens: [{ value: "#f1efc4", kind: "color", codeToken: "MISSING", verdict: "MISSING" }], verification: STATIC });
  return pr.length === 1 && /no recorded decision/.test(pr[0]);
})());
check("[no-token] a REAL token is still enforced — the sentinel list is not a blanket escape",
  has(problems({ "a.tsx": "bg-[#5b5fc7]" }, { files: ["a.tsx"], tokens: [brand], verification: STATIC }), /raw colour .*brand-600/));
// A token's VALUE is what it resolves to in the one exported mode; its NAME is what it is. Merging
// two names onto one code token renders perfectly in that mode and breaks in every other — invisible
// to the literal check, to a render, and to the eye. Seen live: three Figma tokens collapsed onto one
// because they shared a hex in the exported mode, and the survivors were then named after each
// other's roles (Schemes/On Surface ended up called `on-primary`, while the real Schemes/On Primary
// was called `on-surface`).
(() => {
  const row = (figmaName, value, codeToken) => ({ figmaName, value, kind: "color", codeToken, verdict: "exact" });
  const merged = problems({ "a.tsx": "" }, { files: ["a.tsx"], verification: STATIC, tokens: [
    row("Schemes/On Primary", "#ffffff", "text-on-surface"),
    row("Schemes/On Surface", "#ffffff", "text-on-surface"),
  ] });
  check("[identity] two Figma tokens on one code token is reported, naming both",
    merged.length === 1 && /2 DIFFERENT Figma tokens/.test(merged[0])
    && /Schemes\/On Primary/.test(merged[0]) && /Schemes\/On Surface/.test(merged[0]));
  check("[identity] the message says WHY sharing a value now is not sharing an identity",
    /diverge in another mode/.test(merged[0]));
  check("[identity] three merged tokens are counted as three", (() => {
    const p3 = problems({ "a.tsx": "" }, { files: ["a.tsx"], verification: STATIC, tokens: [
      row("a/one", "#fff", "t"), row("b/two", "#fff", "t"), row("c/three", "#fff", "t")] });
    return p3.length === 1 && /3 DIFFERENT/.test(p3[0]);
  })());
  // The same Figma token legitimately appears on several rows (one per node/usage) — that is one
  // identity, not a collision, and flagging it would make honest plans unfinishable.
  check("[identity] the SAME Figma token repeated across rows is not a collision",
    problems({ "a.tsx": "" }, { files: ["a.tsx"], verification: STATIC, tokens: [
      row("Schemes/On Primary", "#ffffff", "text-on-primary"),
      row("Schemes/On Primary", "#ffffff", "text-on-primary")] }).length === 0);
  check("[identity] distinct Figma tokens on DISTINCT code tokens is the correct case and passes",
    problems({ "a.tsx": "" }, { files: ["a.tsx"], verification: STATIC, tokens: [
      row("Schemes/On Primary", "#ffffff", "text-on-primary"),
      row("Schemes/On Surface", "#1b1b21", "text-on-surface")] }).length === 0);
  // Backward compatibility: plans predating figmaName, and genuinely unbound values, have no
  // identity to compare. Silence there is correct — an unbound value is not a Figma token.
  check("[identity] rows with no figmaName are not compared (older plans, and raw unbound values)",
    problems({ "a.tsx": "" }, { files: ["a.tsx"], verification: STATIC, tokens: [
      { value: "#ffffff", kind: "color", codeToken: "t", verdict: "exact" },
      { value: "#eeeeee", kind: "color", codeToken: "t", verdict: "exact" }] }).length === 0);
  check("[identity] a no-token row is not compared either — MISSING is not a code token to collide on",
    problems({ "a.tsx": "" }, { files: ["a.tsx"], verification: STATIC, tokens: [
      { ...row("a/one", "#fff", "MISSING"), decision: "one-off" },
      { ...row("b/two", "#eee", "MISSING"), decision: "one-off" }] }).length === 0);
})();

check("[case] an uppercase component verdict is read the same as the documented lowercase one", (() => {
  const row = { name: "Button", mapModule: "@/ui/Button", verdict: "REUSED" };
  return has(problems({ "a.tsx": "nothing imported here" }, { files: ["a.tsx"], components: [row], verification: STATIC }),
    /'Button' is "reused" from @\/ui\/Button/);
})());

console.log("component checks:");
const MAP = { version: 1, components: { Button: { figma: { key: "k-btn" }, code: { module: "@/ui/Button", export: "Button" } } } };
check("reused-but-never-imported fails", has(problems({ "a.tsx": "<button/>" }, { files: ["a.tsx"], components: [{ name: "Button", key: "k-btn", mapModule: "@/ui/Button", verdict: "reused" }], verification: STATIC }), /no file in files\[\] imports that module/));
check("reused and imported passes", problems({ "a.tsx": "import { Button } from '@/ui/Button'" }, { files: ["a.tsx"], components: [{ name: "Button", key: "k-btn", mapModule: "@/ui/Button", verdict: "reused" }], verification: STATIC }).length === 0);
check("marked \"new\" while its key IS mapped fails (the everything-is-new hole)", has(problems({}, { components: [{ name: "Button", key: "k-btn", mapModule: null, verdict: "new" }], verification: STATIC }, MAP), /marked "new".*@\/ui\/Button/));
check("genuinely new component passes", problems({ "a.tsx": "" }, { files: ["a.tsx"], components: [{ name: "PromoCard", key: "k-promo", mapModule: null, verdict: "new" }], verification: STATIC }, MAP).length === 0);

console.log("files[] — the gate only reads what is listed, so the list itself is checked:");
check("an empty / absent files[] fails (it would pass every literal check vacuously)", has(problems({}, { verification: STATIC }), /`files` is empty/) && has(problems({}, { files: [], verification: STATIC }), /`files` is empty/));
check("a listed file that is not on disk fails, by name", has(problems({ "a.tsx": "" }, { files: ["a.tsx", "src/Gone.tsx"], verification: STATIC }), /not found on disk: src\/Gone\.tsx/));
check("a raw literal is still caught when another listed file is missing", has(problems({ "a.tsx": "#5B5FC7" }, { files: ["a.tsx", "nope.tsx"], tokens: [brand], verification: STATIC }), /brand-600/));

console.log("verification evidence:");
check("no verification block is reported (a warning)", has(problems({}, {}), /no `verification.mode`/));
check("rendered with no artifacts fails", has(problems({}, { verification: { mode: "rendered", artifacts: [], deltas: [] } }), /`artifacts` is empty/));
check("rendered with an artifact that is not on disk fails", has(problems({}, { verification: { mode: "rendered", artifacts: ["design/verify/login.png"], deltas: [] } }), /not found on disk/));
check("rendered with a real artifact + deltas + coverage + a11y is clean", problems({ "a.tsx": "", "design/verify/login.png": "png" }, { files: ["a.tsx"], verification: { mode: "rendered", renderer: "playwright", artifacts: ["design/verify/login.png"], deltas: [], coverage: { rendered: ["default"], notChecked: [] }, a11y: { tool: "axe-core", violations: 0 } } }).length === 0);
check("static-only needs a reason", has(problems({}, { verification: { mode: "static-only" } }), /no `reason`/));

console.log("hook process (exit codes; status is computed, never written):");
const hookOf = (root) => (planOf(root).verification || {}).hook || {};
check("failing plan → exit 2, itemised stderr, `status` untouched, hook result recorded as blocked", (() => {
  const root = project({ "a.tsx": "#5B5FC7" }, { status: "pending", files: ["a.tsx"], tokens: [brand], verification: STATIC });
  const r = runHook(root);
  return r.status === 2 && /brand-600/.test(r.stderr) && /abandoned/.test(r.stderr) && planOf(root).status === "pending"
    && hookOf(root).result === "blocked" && statusOf(root) === "blocked";
})());
check("[155] a passing static-only plan → exit 0; the hook NEVER writes `status`; computed status is static-only", (() => {
  const root = project({ "a.tsx": "text-brand-600" }, { status: "pending", files: ["a.tsx"], tokens: [brand], verification: STATIC });
  const r = runHook(root);
  return r.status === 0 && planOf(root).status === "pending" && hookOf(root).result === "pass" && statusOf(root) === "static-only";
})());
check("[155] a rendered plan with NO verify report is never `verified` — the plan's own self-report is not evidence", (() => {
  const root = project({ "a.tsx": "", "design/verify/login.png": "png" }, { status: "pending", files: ["a.tsx"], verification: { mode: "rendered", artifacts: ["design/verify/login.png"], deltas: [] } });
  return runHook(root).status === 0 && planOf(root).status === "pending" && statusOf(root) === "unverified";
})());
check("[155] …it is `verified` only when the verify report beside it says pass, and is newer than the code", (() => {
  const root = project({ "a.tsx": "", "design/verify/login.png": "png" }, { status: "pending", files: ["a.tsx"], verification: { mode: "rendered", artifacts: ["design/verify/login.png"], deltas: [] } });
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(root, "a.tsx"), past, past);
  fs.writeFileSync(path.join(root, "design", "verify", "login.report.json"), JSON.stringify({ verdict: "pass", why: [] }));
  runHook(root);
  return statusOf(root) === "verified";
})());
check("[189] a failing verify report turns the same plan into `failed`, whatever the plan says", (() => {
  const root = project({ "a.tsx": "" }, { status: "verified", files: ["a.tsx"], verification: { mode: "rendered", artifacts: ["a.tsx"], deltas: [] } });
  fs.mkdirSync(path.join(root, "design", "verify"), { recursive: true });
  fs.writeFileSync(path.join(root, "design", "verify", "login.report.json"), JSON.stringify({ verdict: "fail", why: ["4 high-severity value mismatch(es)"] }));
  const before = statusOf(root);
  const r = runHook(root);
  return before === "pending" && r.status === 0 && planOf(root).status === undefined && /removed the stored "status": "verified"/.test(r.stderr)
    && statusOf(root) === "failed";
})());
check("[§2.9c] a hand edit to a file the plan describes turns `static-only` into `stale`, and re-opens the plan for the hook", (() => {
  const root = project({ "a.tsx": "text-brand-600" }, { status: "pending", files: ["a.tsx"], tokens: [brand], verification: STATIC });
  runHook(root);
  const ok1 = statusOf(root) === "static-only" && runHook(root).stderr === ""; // closed: the fast path says nothing
  fs.writeFileSync(path.join(root, "a.tsx"), "color: #5B5FC7");
  const stale = statusOf(root);
  const r = runHook(root);
  return ok1 && stale === "stale" && r.status === 2 && statusOf(root) === "blocked";
})());
check("a plan paused on a user question (awaiting-user) does not block the stop, and is never closed", (() => {
  const root = project({}, { status: "awaiting-user", files: [], tokens: [{ value: "#123456", kind: "color", codeToken: null, verdict: "missing" }] });
  return runHook(root).status === 0 && planOf(root).status === "awaiting-user" && statusOf(root) === "awaiting-user";
})());
// A sibling plan with a real (blocking) problem: an agent that did not write it must not be blocked on it.
const SIBLING = { status: "pending", files: ["b.tsx"], tokens: [brand], verification: STATIC };
check("fan-out: an agent is judged on the plan ITS transcript mentions, not a sibling's half-written one — which stays unchecked", (() => {
  const root = project({ "a.tsx": "text-brand-600", "b.tsx": "#5B5FC7" }, { status: "pending", files: ["a.tsx"], tokens: [brand], verification: STATIC });
  const sibling = path.join(root, "design", "plan", "settings.json");
  fs.writeFileSync(sibling, JSON.stringify(SIBLING));
  const mine = path.join(root, "agent-a.jsonl"), none = path.join(root, "none.jsonl");
  fs.writeFileSync(mine, JSON.stringify({ tool: "Write", file_path: root + "/design/plan/login.json" }));
  fs.writeFileSync(none, "{}");
  const unscoped = runHook(root, { cwd: root, agent_id: "a1", agent_transcript_path: none }).status; // no evidence → all plans → blocked
  fs.writeFileSync(sibling, JSON.stringify(SIBLING)); // forget the unscoped run's record
  const r = runHook(root, { cwd: root, agent_id: "a1", agent_transcript_path: mine });
  const sib = JSON.parse(fs.readFileSync(sibling, "utf8"));
  return unscoped === 2 && r.status === 0 && hookOf(root).result === "pass" && sib.status === "pending" && !sib.verification.hook;
})());
check("fan-out: the session transcript is never used to scope a SUBAGENT's stop", (() => {
  const root = project({ "a.tsx": "text-brand-600", "b.tsx": "#5B5FC7" }, { status: "pending", files: ["a.tsx"], tokens: [brand], verification: STATIC });
  fs.writeFileSync(path.join(root, "design", "plan", "settings.json"), JSON.stringify(SIBLING));
  const main = path.join(root, "main.jsonl");
  fs.writeFileSync(main, "design/plan/login.json");
  return runHook(root, { cwd: root, agent_id: "a1", transcript_path: main }).status === 2 && runHook(root, { cwd: root, transcript_path: main }).status === 0;
})());
check("missing coverage / a11y evidence WARNS on a passing rendered plan — exit 0", (() => {
  const files = { "a.tsx": "", "design/verify/login.png": "png" };
  const bare = project(files, { status: "pending", files: ["a.tsx"], verification: { mode: "rendered", artifacts: ["design/verify/login.png"], deltas: [] } });
  const full = project(files, { status: "pending", files: ["a.tsx"], verification: { mode: "rendered", artifacts: ["design/verify/login.png"], deltas: [], coverage: { rendered: ["default"], notChecked: [] }, a11y: { tool: "axe-core", violations: 0 } } });
  const r1 = runHook(bare), r2 = runHook(full);
  return r1.status === 0 && /coverage is missing/.test(r1.stderr) && /a11y is missing/.test(r1.stderr)
    && r2.status === 0 && !/coverage is missing|a11y is missing/.test(r2.stderr);
})());
// P3 #150/#151/#180: validatePlanHeader — the schema'd header (screenName/nodeId/route/file) other skills
// resolve a plan by. Wired into the hook's warnings now that plan-skeleton.js writes it.
check("[header] the hook WARNS (never blocks) on a plan with no header", (() => {
  const root = project({ "a.tsx": "" }, { status: "pending", files: ["a.tsx"], verification: STATIC });
  const r = runHook(root);
  return r.status === 0 && /plan header is missing `screenName`, `nodeId`, `route`, `file`/.test(r.stderr);
})());
check("[header] a plan missing every header field is flagged, one message naming all of them",
  (() => { const w = validatePlanHeader({}); return w.length === 1 && /screenName/.test(w[0]) && /nodeId/.test(w[0]) && /route/.test(w[0]) && /file/.test(w[0]); })());
check("[header] a plan with a complete header is clean",
  validatePlanHeader({ screenName: "Job Roles", nodeId: "7314:87192", route: "/job-roles", file: "src/JobRoles.tsx" }).length === 0);
check("[header] a plan missing only `route` names just that field",
  (() => { const w = validatePlanHeader({ screenName: "Job Roles", nodeId: "7314:87192", file: "x.tsx" }); return w.length === 1 && /`route`/.test(w[0]) && !/screenName/.test(w[0]); })());
check("[header] an empty string counts as missing, not present", validatePlanHeader({ screenName: "", nodeId: "1:1", route: "/x", file: "x.tsx" }).length === 1);

check("abandoned / already-closed plans are skipped (fast path)", (() => {
  const root = project({ "a.tsx": "#5B5FC7" }, { status: "abandoned", files: ["a.tsx"], tokens: [brand] });
  return runHook(root).status === 0 && planOf(root).status === "abandoned";
})());
check("stop_hook_active short-circuits (no re-entrant block)", (() => {
  const root = project({ "a.tsx": "#5B5FC7" }, { status: "pending", files: ["a.tsx"], tokens: [brand] });
  return runHook(root, { cwd: root, stop_hook_active: true }).status === 0;
})());

const age = (root, hours) => { const t = new Date(Date.now() - hours * 3600 * 1000); fs.utimesSync(path.join(root, "design", "plan", "login.json"), t, t); };
check("a pending plan untouched for >12h is a leftover — skipped, not blocking, not closed", (() => {
  const root = project({ "a.tsx": "#5B5FC7" }, { status: "pending", files: ["a.tsx"], tokens: [brand], verification: STATIC });
  age(root, 13);
  return runHook(root).status === 0 && planOf(root).status === "pending";
})());
check("…but one touched an hour ago still blocks", (() => {
  const root = project({ "a.tsx": "#5B5FC7" }, { status: "pending", files: ["a.tsx"], tokens: [brand], verification: STATIC });
  age(root, 1);
  return runHook(root).status === 2;
})());
check("DTWIN_PLAN_STALE_HOURS=0 disables the cutoff", (() => {
  const root = project({ "a.tsx": "#5B5FC7" }, { status: "pending", files: ["a.tsx"], tokens: [brand], verification: STATIC });
  age(root, 100);
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: root }), encoding: "utf8", env: { ...process.env, DTWIN_PLAN_STALE_HOURS: "0" } });
  return r.status === 2 && isStale(path.join(root, "design", "plan", "login.json")) === true;
})());

// ---------------------------------------------------------------- P2b — livetest-3 regressions
// Driven by test/fixtures/livetest3/plan/ — the real plans, reports, export and app sources from the
// live run, pruned by its build.js (nothing hand-written).
const FX = path.join(__dirname, "fixtures", "livetest3", "plan");
const JR = "positions___7314_87192", GP = "System_Configurations__1359_21337";
const fxPlan = (s) => JSON.parse(fs.readFileSync(path.join(FX, "plan", s + ".json"), "utf8"));
// A consumer project laid out exactly like the live one: design/{export,plan,verify}, app/.
function liveProject(plans) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-live-"));
  fs.cpSync(path.join(FX, "export"), path.join(root, "design", "export"), { recursive: true });
  fs.cpSync(path.join(FX, "verify"), path.join(root, "design", "verify"), { recursive: true });
  fs.cpSync(path.join(FX, "app"), path.join(root, "app"), { recursive: true });
  fs.mkdirSync(path.join(root, "design", "plan"), { recursive: true });
  for (const [name, plan] of Object.entries(plans)) fs.writeFileSync(path.join(root, "design", "plan", name + ".json"), JSON.stringify(plan, null, 2));
  return root;
}
const checkLive = (root, name) => {
  const file = path.join(root, "design", "plan", name + ".json");
  return checkPlan({ plan: JSON.parse(fs.readFileSync(file, "utf8")), file }, root);
};
const colourBlocks = (r) => r.blocking.filter((m) => /raw colour/.test(m));

console.log("P2b [100] a hex in a comment or a provenance note is not a literal:");
{
  // Header.tsx's doc comment: "…resolves to #121319 in Dark and #ffffff in Light." Before: three blocks
  // (#121319 twice — two plan rows resolve it — and #ffffff) for a comment.
  const plan = Object.assign(fxPlan(JR), { status: "pending", files: ["app/src/layout/Header.tsx"] });
  const root = liveProject({ [JR]: plan });
  check("[100] the real Header.tsx (hexes only in its doc comment) raises no colour block", colourBlocks(checkLive(root, JR)).length === 0);
  const hdr = path.join(root, "app/src/layout/Header.tsx");
  fs.appendFileSync(hdr, "\nexport const Leak = () => <div style={{ background: '#121319' }} />;\n");
  const r = colourBlocks(checkLive(root, JR));
  check("[100] …the same hex in CODE still blocks — once per literal, naming every token that resolves it",
    r.length === 1 && /#121319/.test(r[0]) && /bg-backgrounds-side-menu/.test(r[0]) && /bg-neutrals-neutral-0/.test(r[0]) && /Header\.tsx/.test(r[0]));
}
check("[100] scanText drops //, /* */, JSX {/* */} and <!-- --> comments but keeps code", (() => {
  const t = scanText("a.tsx", "// #111111\nconst a = 1; /* #222222 */\n<div>{/* #333333 */}</div>\nconst b = '#444444';");
  const h = scanText("a.vue", "<!-- #555555 -->\n<p style=\"color:#666666\"></p>");
  return !/#111111|#222222|#333333/.test(t) && /#444444/.test(t) && !/#555555/.test(h) && /#666666/.test(h);
})());
check("[100] a prose string (provenance note) is skipped; a style string is not", (() => {
  const t = scanText("a.tsx", "const note = \"bound to Neutrals/Neutral 0, which is #121319 in Dark\";\nconst c = \"#121319\";\nconst b = '1px solid #121319';\nconst k = 'flex items center bg-[#121319]';");
  return (t.match(/#121319/g) || []).length === 3 && !/Neutral 0, which/.test(t);
})());
check("[100] `https://` in code is not mistaken for a comment", /#777777/.test(scanText("a.ts", "fetch(`https://x.test/a`); const c = '#777777';")));

console.log("P2b [132] exported SVG artwork is not code:");
{
  // Global Policies resolves #d4d4d4 to two tokens; calendar-2.svg's baked-in stroke is #D4D4D4.
  // Before: two blocks for a file the skill forbids editing, cured only by allowedLiterals padding.
  const plan = Object.assign(fxPlan(GP), { status: "pending", files: ["app/src/assets/calendar-2.svg"],
    allowedLiterals: fxPlan(GP).allowedLiterals.filter((a) => !(a.file && /\.svg$/.test(a.file))) });
  const root = liveProject({ [GP]: plan });
  check("[132] the real calendar-2.svg (stroke=\"#D4D4D4\") in files[] raises no colour block, with no allowedLiterals entry for it",
    /#D4D4D4/i.test(fs.readFileSync(path.join(root, "app/src/assets/calendar-2.svg"), "utf8")) && colourBlocks(checkLive(root, GP)).length === 0);
  check("[132] isSourceFile: .tsx/.css/.swift/.kt are code; .svg/.json/.md/.png are not",
    ["a.tsx", "a.css", "A.swift", "A.kt", "a.dart"].every(isSourceFile) && !["a.svg", "tokens.json", "README.md", "x.png"].some(isSourceFile));
}

console.log("P2b [131] a reused component resolves by module path, not by substring:");
{
  const gpRoot = liveProject({});
  const byFile = [{ rel: "app/src/features/global-policies/screens/GlobalPoliciesScreen.tsx", text: fs.readFileSync(path.join(gpRoot, "app/src/features/global-policies/screens/GlobalPoliciesScreen.tsx"), "utf8") }];
  check("[131] importsOf reads ES/CJS/dynamic/CSS imports",
    importsOf("import { A } from '../A';\nimport type { B } from \"@/B\";\nexport { C } from './C';\nconst d = require('d');\nimport('./e');\n@import url('f.css');").join(",") === "../A,@/B,./C,d,./e,f.css");
  check("[131] the real GlobalPoliciesScreen.tsx ('../../../components/PageTitle') satisfies mapModule \"app/src/components/PageTitle.tsx\"",
    moduleImported("app/src/components/PageTitle.tsx", byFile, gpRoot));
  check("[131] …and so does an alias import ('@/components/PageTitle')",
    moduleImported("app/src/components/PageTitle.tsx", [{ rel: "app/src/x/Y.tsx", text: 'import { PageTitle } from "@/components/PageTitle";' }], gpRoot));
  check("[131] …and a mapModule written as the alias itself",
    moduleImported("@/components/PageTitle", byFile, gpRoot));
  check("[131] a module nobody imports is still caught", !moduleImported("app/src/components/Tooltip.tsx", byFile, gpRoot));
  // The full plan, rewritten the honest way the live build first wrote it (repo-path mapModule): before
  // the fix, six "was it regenerated instead of reused?" BLOCKS; now zero warnings about imports.
  const plan = fxPlan(GP);
  const repo = { "../../../components/PageTitle": "app/src/components/PageTitle.tsx", "../../../components/SearchInput": "app/src/components/SearchInput.tsx",
    "../../../components/SquareButton": "app/src/components/SquareButton.tsx", "../../../components/DataTable": "app/src/components/DataTable.tsx",
    "../../../components/Icon": "app/src/components/Icon.tsx", "../../../components/Modal": "app/src/components/Modal.tsx" };
  let rewritten = 0;
  for (const c of plan.components) if (repo[c.mapModule]) { c.mapModule = repo[c.mapModule]; rewritten++; }
  plan.files = ["app/src/features/global-policies/screens/GlobalPoliciesScreen.tsx"];
  const root = liveProject({ [GP]: plan });
  const r = checkLive(root, GP);
  check(`[131] the live Global Policies plan with ${rewritten} honest repo-path mapModules: no import warning, and nothing about components blocks`,
    rewritten === 6 && !r.warnings.some((w) => /imports that module/.test(w)) && !r.blocking.some((b) => /component/.test(b)));
  plan.components[2].mapModule = "app/src/components/Tooltip.tsx";
  fs.writeFileSync(path.join(root, "design/plan", GP + ".json"), JSON.stringify(plan));
  const r2 = checkLive(root, GP);
  check("[131] a genuinely un-imported reuse is a WARNING, not a block", r2.warnings.some((w) => /Tooltip/.test(w)) && !r2.blocking.some((b) => /Tooltip/.test(b)));
}

console.log("P2b [§2.9b-2] a visible design node with no anchor blocks; hidden ones never count:");
{
  const S = path.join(FX, "export/pages/__Organization_management_", JR + ".json");
  const doc = JSON.parse(fs.readFileSync(S, "utf8"));
  const cov0 = anchorCoverage({ anchors: {} }, doc);
  check("[anchors] with no anchors, all 254 visible nodes are unmapped — reported as ONE subtree (the frame)", cov0.visible === 254 && cov0.unmappedNodes === 254 && cov0.unmapped.length === 1 && cov0.unmapped[0].id === "7314:87192");
  const cov1 = anchorCoverage({ anchors: { "7314:87192": { mapModule: "app/src/features/job-roles/screens/JobRolesScreen.tsx" } } }, doc);
  check("[anchors] one anchor on the frame covers every descendant (children inherit)", cov1.unmapped.length === 0 && cov1.unmappedNodes === 0);
  // the real JR plan anchors 16 ids including the frame → covered; its hidden-node ids are not required
  const cov2 = anchorCoverage(fxPlan(JR), doc);
  check("[anchors] the live Job Roles plan (16 anchors incl. the frame) covers every visible node", cov2.unmapped.length === 0);
  const hiddenId = "I20173:137670;72:3598"; // the Breadcrumb instance, hidden: true
  const cov3 = anchorCoverage({ anchors: { "7314:87192": { mapModule: "x.tsx" }, [hiddenId]: { mapModule: "x.tsx" } } }, doc);
  check("[anchors] an anchor on a HIDDEN node is reported (hidden layers are not built)", cov3.hiddenAnchored.includes(hiddenId));
  // Global Policies: the frame draws its footer twice; the plan anchors one and never mentions 1359:21457.
  const root = liveProject({ [GP]: Object.assign(fxPlan(GP), { status: "pending" }) });
  const r = checkLive(root, GP);
  const b = r.blocking.filter((m) => /no anchor in the plan/.test(m));
  check("[anchors] the live Global Policies plan BLOCKS on exactly its unanchored subtree, 1359:21457 (the duplicate footer)", b.length === 1 && /1359:21457/.test(b[0]) && /^3 visible/.test(b[0]));
  const fixed = fxPlan(GP);
  fixed.anchors["1359:21457"] = { omitted: "duplicate footer drawn on top of the frame (see deviations: duplicateFooter)" };
  fs.writeFileSync(path.join(root, "design/plan", GP + ".json"), JSON.stringify(fixed));
  check("[anchors] …and `{omitted: \"<why>\"}` on it clears the block", checkLive(root, GP).blocking.length === 0);
}

console.log("P2b [155/189] acceptance 6 — the live plans and reports: neither comes out `verified`:");
{
  const root = liveProject({ [JR]: fxPlan(JR), [GP]: fxPlan(GP) });
  const planFile = (s) => path.join(root, "design/plan", s + ".json");
  const st = (s) => computeStatus(JSON.parse(fs.readFileSync(planFile(s), "utf8")), { cwd: root, planFile: planFile(s) });
  const before = [st(JR), st(GP)];
  check("[155] before the hook runs, the stored \"verified\" is ignored — computed status is pending, and says why",
    fxPlan(JR).status === "verified" && fxPlan(GP).status === "verified" && before.every((s) => s.status === "pending" && /older hook and is ignored/.test(s.reasons[0])));
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: root }), encoding: "utf8" });
  const after = { jr: JSON.parse(fs.readFileSync(planFile(JR), "utf8")), gp: JSON.parse(fs.readFileSync(planFile(GP), "utf8")) };
  check("[155] the hook actively clears the stored \"verified\" from both plans", after.jr.status === undefined && after.gp.status === undefined && /removed the stored "status": "verified"/.test(r.stderr));
  const jr = st(JR), gp = st(GP);
  check(`[155] Job Roles: computed status is "failed", citing design/verify/JobRoles.report.json (got ${jr.status})`, jr.status === "failed" && /JobRoles\.report\.json says verdict "fail"/.test(jr.reasons.join(" ")) && jr.reports[0].matchedBy === "layer name");
  check(`[189] Global Policies: not verified either (got ${gp.status} — its hook run blocked on the unanchored footer)`, gp.status !== "verified" && gp.status === "blocked");
  const cli = spawnSync(process.execPath, [HOOK, "--status", "--json"], { cwd: root, encoding: "utf8" });
  const rows = JSON.parse(cli.stdout);
  check("[155] `verify-build.js --status --json` reports the same, and writes nothing", cli.status === 0 && rows.length === 2 && rows.every((x) => x.status !== "verified")
    && fs.readFileSync(planFile(JR), "utf8") === JSON.stringify(after.jr, null, 2) + "\n");
  // make GP pass its hook: status must STILL not be verified, because its report says fail
  const gpFixed = JSON.parse(fs.readFileSync(planFile(GP), "utf8"));
  gpFixed.anchors["1359:21457"] = { omitted: "duplicate footer" };
  fs.writeFileSync(planFile(GP), JSON.stringify(gpFixed, null, 2));
  spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: root }), encoding: "utf8" });
  const gp2 = st(GP);
  check(`[189] with its hook passing, Global Policies is "failed" — GlobalPolicies.report.json says fail (got ${gp2.status})`, gp2.status === "failed" && /GlobalPolicies\.report\.json/.test(gp2.reasons.join(" ")));
  // the P3 `<Layer>__<id>` report naming is found by name too
  fs.renameSync(path.join(root, "design/verify/JobRoles.report.json"), path.join(root, "design/verify", JR + ".report.json"));
  const jr2 = st(JR);
  check("[155] the new <Layer>__<id>.report.json naming is found as well", jr2.status === "failed" && jr2.reports[0].matchedBy === "name");
}

console.log("P2b [156] the verification block is checked against itself; [196] deviations are calibrated:");
{
  const root = liveProject({ [JR]: Object.assign(fxPlan(JR), { status: "pending" }), [GP]: Object.assign(fxPlan(GP), { status: "pending" }) });
  const jr = checkLive(root, JR);
  check("[156] the live Job Roles plan: a11y.violations 0 beside coverage.notChecked 'axe/a11y automated scan' is flagged as a contradiction",
    jr.warnings.some((w) => /contradicts itself: `a11y` records 0 violation/.test(w) && /axe\/a11y automated scan/.test(w)));
  check("[156] a report that fails beside a plan claiming pass is flagged", verificationContradictions({ verification: { verifyScreenVerdict: "pass" } }, [{ rel: "design/verify/x.report.json", verdict: "fail" }]).some((w) => /cannot overrule/.test(w)));
  check("[156] a consistent block raises nothing", verificationContradictions({ verification: { a11y: { tool: "axe", violations: 0 }, coverage: { rendered: ["default"], notChecked: [{ what: "rtl" }] } } }, []).length === 0);
  const gp = checkLive(root, GP);
  check("[196] the live Global Policies plan: its 7 prose-only deviations are flagged as missing nodeId/field/designed/built",
    gp.warnings.some((w) => /^7 deviation\(s\) are missing fields/.test(w) && /duplicateFooter/.test(w)));
  check("[196] a calibrated deviation {nodeId, field, designed, built, reason} passes",
    deviationWarnings({ deviations: [{ nodeId: "18580:60861", field: "x", designed: 1296.81, built: 1315.75, reason: "status chips aligned to their header" }] }).length === 0);
}

console.log("P2b end to end — plan-skeleton.js writes the plan, the hook checks it:");
{
  const root = liveProject({});
  const SK = require.resolve("../design-to-code/plan-skeleton.js");
  const E = "design/export/pages/__Organization_management_";
  const planRel = "design/plan/" + JR + ".json";
  const g = spawnSync(process.execPath, [SK, `${E}/${JR}.json`, `${E}/${JR}.vars.json`, "design/export/design-system", "--out", planRel], { cwd: root, encoding: "utf8" });
  const hook = () => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: root }), encoding: "utf8" });
  const r1 = hook();
  check("a fresh skeleton (nothing filled) BLOCKS on its one unanchored subtree — the frame — and on nothing else",
    g.status === 0 && r1.status === 2 && /254 visible design node\(s\) have no anchor/.test(r1.stderr) && /7314:87192 'positions'/.test(r1.stderr) && !/raw colour/.test(r1.stderr));
  check("…its header is complete except the route, and its unfilled token rows are ONE warning, not 33",
    /plan header is missing `route`/.test(r1.stderr) && (r1.stderr.match(/have no token and no recorded decision/g) || []).length === 1 && /33 token row\(s\)/.test(r1.stderr));
  const p = JSON.parse(fs.readFileSync(path.join(root, planRel), "utf8"));
  p.anchors["7314:87192"].mapModule = "app/src/layout/Header.tsx";
  p.files = ["app/src/layout/Header.tsx"];
  p.route = "/job-roles";
  fs.writeFileSync(path.join(root, planRel), JSON.stringify(p, null, 2));
  const r2 = hook();
  const st = computeStatus(JSON.parse(fs.readFileSync(path.join(root, planRel), "utf8")), { cwd: root, planFile: path.join(root, planRel) });
  check(`one anchor on the frame + files[] → the hook passes (exit ${r2.status}); status is computed from the live JobRoles report: ${st.status}`,
    r2.status === 0 && st.status === "failed" && /JobRoles\.report\.json/.test(st.reasons.join(" ")));
}

console.log("P2b — the verify-report@2 shape (P2a): incomplete ≠ pass, a changed expectation invalidates the report:");
{
  const crypto = require("crypto");
  const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
  // A plan that passes its hook; its report is then swapped between @2 shapes (field names as
  // verify-screen.js --compare writes them since P2a: verdict pass|fail|incomplete, headline, inputs).
  const setup = (report, expectation) => {
    const root = project({ "a.tsx": "" }, { status: "pending", nodeId: "7314:87192", files: ["a.tsx"], verification: { mode: "rendered", artifacts: ["a.tsx"], deltas: [] } });
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(path.join(root, "a.tsx"), past, past);
    fs.mkdirSync(path.join(root, "design", "verify"), { recursive: true });
    if (expectation !== undefined) fs.writeFileSync(path.join(root, "design", "verify", "JobRoles.expected.json"), expectation);
    fs.writeFileSync(path.join(root, "design", "verify", "JobRoles.report.json"), JSON.stringify(report));
    runHook(root);
    return computeStatus(planOf(root), { cwd: root, planFile: path.join(root, "design", "plan", "login.json") });
  };
  const EXP = JSON.stringify({ schema: "designtwin/verify-expectation@2", frame: { nodeId: "7314:87192", name: "positions " }, hidden: { ids: [] } });
  const v2 = (verdict, extra) => Object.assign({ schema: "designtwin/verify-report@2", screen: "positions ", verdict, headline: `${verdict.toUpperCase()} — nodes measured 180/189`, why: [], inputs: { expectationSha256: sha(EXP) }, summary: { componentsAbsent: 0 } }, extra);
  const inc = setup(v2("incomplete"), EXP);
  check(`an @2 report found through its expectation's frame.nodeId; verdict "incomplete" → unverified, quoting the headline (got ${inc.status})`,
    inc.status === "unverified" && inc.reports[0].matchedBy === "expectation frame" && /INCOMPLETE — nodes measured 180\/189/.test(inc.reasons.join(" ")));
  const pass = setup(v2("pass"), EXP);
  check(`an @2 "pass" against the expectation still on disk → verified (got ${pass.status})`, pass.status === "verified");
  const moved = setup(v2("pass"), EXP.replace("positions ", "positions"));
  check(`an @2 "pass" whose inputs.expectationSha256 no longer matches the .expected.json on disk → unverified (got ${moved.status})`,
    moved.status === "unverified" && /inputs\.expectationSha256 no longer matches/.test(moved.reasons.join(" ")));
  const fail = setup(v2("fail"), EXP);
  check(`an @2 "fail" → failed (got ${fail.status})`, fail.status === "failed");
}

console.log("map-bootstrap --out (the build-screen gate's remedy must actually create the file):");
const BOOT = require.resolve("../design-to-code/map-bootstrap.js");
const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-boot-"));
const catalogFile = path.join(bootDir, "components.local.json");
const mapFile = path.join(bootDir, "codeconnect.local.json");
fs.writeFileSync(catalogFile, JSON.stringify({ components: [{ type: "COMPONENT", key: "k-btn", id: "1:2", name: "Button", props: {} }] }));
check("--out writes the map file and keeps stdout clean", (() => {
  const r = spawnSync(process.execPath, [BOOT, catalogFile, "--out", mapFile], { encoding: "utf8" });
  return r.status === 0 && r.stdout === "" && /wrote/.test(r.stderr) && JSON.parse(fs.readFileSync(mapFile, "utf8")).components["k-btn"].status === "needs-review";
})());
check("re-running --out MERGES into the existing map — hand edits survive", (() => {
  const map = JSON.parse(fs.readFileSync(mapFile, "utf8"));
  map.components["k-btn"].code.module = "@/ui/Button";
  map.components["k-btn"].status = "confirmed";
  fs.writeFileSync(mapFile, JSON.stringify(map));
  const r = spawnSync(process.execPath, [BOOT, catalogFile, "--out", mapFile], { encoding: "utf8" });
  const after = JSON.parse(fs.readFileSync(mapFile, "utf8")).components["k-btn"];
  return r.status === 0 && after.code.module === "@/ui/Button" && after.status === "confirmed" && /merged/.test(r.stderr);
})());
check("without --out it still prints to stdout (back-compat)", (() => {
  const r = spawnSync(process.execPath, [BOOT, catalogFile], { encoding: "utf8" });
  return r.status === 0 && JSON.parse(r.stdout).components["k-btn"];
})());
check("an unknown option is refused, not swallowed as a file path", spawnSync(process.execPath, [BOOT, catalogFile, "--output", mapFile], { encoding: "utf8" }).status === 1);

console.log("claude-plugin/scripts bundles:");
const SCRIPTS = path.join(__dirname, "..", "claude-plugin", "scripts");
const { build, ENTRIES } = require("../claude-plugin/build-scripts.js");
check("every entry is a committed REAL file (a symlink out of the plugin dir is not installed)", ENTRIES.every((n) => {
  const p = path.join(SCRIPTS, n + ".js");
  return fs.existsSync(p) && !fs.lstatSync(p).isSymbolicLink();
}));
check("bundles are self-contained — no require() that leaves the plugin directory", ENTRIES.every((n) =>
  !/require\(["']\.\.?\//.test(fs.readFileSync(path.join(SCRIPTS, n + ".js"), "utf8"))));

// A skill that tells the agent to run one of these with no arguments hands it a usage error in the
// gate step (shipped once: drift-lint.js and tokens.js). Every invocation must carry its arguments.
{
  const NEEDS_ARGS = ["design-diff", "drift-lint", "tokens", "map-bootstrap", "get-component", "map-validate", "plan-skeleton"];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".md") ? [path.join(d, e.name)] : []);
  const bare = [];
  for (const f of [...walk(path.join(SCRIPTS, "..", "skills")), ...walk(path.join(SCRIPTS, "..", "agents"))]) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(/scripts\/([a-z-]+)\.js"(\s*)(\S)/g))
      if (NEEDS_ARGS.includes(m[1]) && (m[3] === "`" || m[3] === ")")) bare.push(`${path.basename(path.dirname(f))}/${path.basename(f)}: ${m[1]}.js`);
  }
  check("skill docs never invoke an argument-taking script bare" + (bare.length ? " — " + bare.join(", ") : ""), bare.length === 0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-scripts-"));
build(tmp).then(async () => {
  const stale = ENTRIES.filter((n) => fs.readFileSync(path.join(tmp, n + ".js"), "utf8") !== fs.readFileSync(path.join(SCRIPTS, n + ".js"), "utf8"));
  check("claude-plugin/scripts/ is in sync with design-to-code/ (else: node claude-plugin/build-scripts.js)" + (stale.length ? " — STALE: " + stale.join(", ") : ""), stale.length === 0);
  check("a bundle runs from outside the repo", (() => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-plugin-"));
    fs.copyFileSync(path.join(SCRIPTS, "drift-lint.js"), path.join(out, "drift-lint.js"));
    const r = spawnSync(process.execPath, [path.join(out, "drift-lint.js")], { encoding: "utf8" });
    return /usage:/.test(r.stdout + r.stderr);
  })());
  // A require cycle once made esbuild wrap tokens.js as an inner module: `require.main === module`
  // was then false, and the shipped script exited 0 having written nothing.
  check("the bundled tokens.js CLI really writes its files (incl. --native)", (() => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-tokens-"));
    const input = path.join(out, "tokens.json");
    fs.writeFileSync(input, JSON.stringify({ collections: [{ name: "C", modes: ["M"], default: "M" }], variables: [{ name: "a/b", type: "COLOR", collection: "C", values: { M: "#ffffff" } }] }));
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, "tokens.js"), input, out, "--native", "swiftui", "--also-generic"], { encoding: "utf8" });
    return r.status === 0 && fs.existsSync(path.join(out, "tokens.dtcg.json")) && /static let aB: Color/.test(fs.readFileSync(path.join(out, "DesignTokens.swift"), "utf8"));
  })());
  check("finding 225: --native WITHOUT --also-generic writes ONLY the native file, not the generic set, and names the canonical file", (() => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-tokens-"));
    const input = path.join(out, "tokens.json");
    fs.writeFileSync(input, JSON.stringify({ collections: [{ name: "C", modes: ["M"], default: "M" }], variables: [{ name: "a/b", type: "COLOR", collection: "C", values: { M: "#ffffff" } }] }));
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, "tokens.js"), input, out, "--native", "swiftui"], { encoding: "utf8" });
    return r.status === 0 && fs.existsSync(path.join(out, "DesignTokens.swift")) && !fs.existsSync(path.join(out, "tokens.dtcg.json"))
      && !fs.existsSync(path.join(out, "tokens.css")) && !fs.existsSync(path.join(out, "tokens.resolver.json")) && !fs.existsSync(path.join(out, "tokens"))
      && /wrote DesignTokens\.swift/.test(r.stdout) && /NOT written here.*design\//.test(r.stdout);
  })());

  // Findings 99/133 (§2.9 d/e): stdin is read only when it is not a terminal, never waited on forever.
  const { spawn } = require("child_process");
  const timed = (args, opts, feed) => new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, [HOOK, ...args], Object.assign({ stdio: ["pipe", "pipe", "pipe"] }, opts));
    let err = "";
    c.stderr.on("data", (d) => { err += d; });
    if (feed) feed(c.stdin);
    const kill = setTimeout(() => c.kill("SIGKILL"), 10000);
    c.on("exit", (code) => { clearTimeout(kill); resolve({ code, ms: Date.now() - t0, stderr: err }); });
  });
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-empty-"));
  const silent = await timed([], { cwd: empty }); // an open pipe that never writes and never closes
  check(`[133] an attached pipe that never delivers a payload does not hang: exit ${silent.code} in ${silent.ms} ms (< 2000)`, silent.code === 0 && silent.ms < 2000);
  const cut = await timed([], { cwd: empty, env: Object.assign({}, process.env, { DTWIN_HOOK_TIMEOUT_MS: "1500" }) }, (s) => s.write("{"));
  check(`[§2.9e] a payload with no end-of-file is cut off by the hard timeout, naming what it waited on (exit ${cut.code}, ${cut.ms} ms)`,
    cut.code === 1 && /timed out after 2 s waiting for the hook payload on stdin/.test(cut.stderr) && cut.ms < 5000);
  const posRoot = project({ "a.tsx": "#5B5FC7" }, { status: "pending", files: ["a.tsx"], tokens: [brand], verification: STATIC });
  const pos = await timed([path.join(posRoot, "design", "plan", "login.json")], {});
  check(`[99] a plan path as an argument is checked without touching stdin (exit ${pos.code} in ${pos.ms} ms)`, pos.code === 2 && pos.ms < 2000 && /brand-600/.test(pos.stderr));
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "claude-plugin", "hooks", "hooks.json"), "utf8"));
  const h = hooks.hooks.SubagentStop[0].hooks[0];
  check("[hooks.json] the SubagentStop gate runs the bundled verify-build.js and gives it longer than its own 60 s cut-off",
    /scripts\/verify-build\.js"?$/.test(h.command) && h.timeout > 60);
  report();
});
