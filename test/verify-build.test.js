// Offline tests for design-to-code/verify-build.js (the build-screen Stop-hook gate) and for the
// committed claude-plugin/scripts/ bundles it ships in.
//   node test/verify-build.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { checkPlan, passedStatus, colorLiterals, arbitraryPx, hex6, colorKey, isStale, validatePlanHeader } = require("../design-to-code/verify-build");
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
const problems = (files, plan, map) => { const root = project(files, plan, map); return checkPlan({ plan }, root); };
const has = (list, re) => list.some((m) => re.test(m));

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
  return pr.length === 1 && /raw literal #ffffff1a\b/.test(pr[0]) && /bg-scrim/.test(pr[0]);
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
  ), /raw literal #5B5FC7/i);
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
check("a resolved color used as a raw #hex fails", has(problems({ "a.tsx": "color: #5b5fc7" }, { files: ["a.tsx"], tokens: [brand], verification: STATIC }), /raw literal #5b5fc7.*brand-600/));
check("…and as Compose 0xFF… (the old gate was blind to native)", has(problems({ "A.kt": "Color(0xFF5B5FC7)" }, { files: ["A.kt"], tokens: [brand], verification: STATIC }), /0xFF5B5FC7/));
check("…and as rgb()", has(problems({ "a.css": "color: rgb(91, 95, 199)" }, { files: ["a.css"], tokens: [brand], verification: STATIC }), /rgb\(91, 95, 199\)/));
check("an UNRESOLVED rgba() (a one-off shadow) passes — profiles prescribe these", problems({ "a.css": "box-shadow: 0 1px 2px rgba(0,0,0,0.12)" }, { files: ["a.css"], tokens: [brand], verification: STATIC }).length === 0);
check("an UNRESOLVED arbitrary value (text-[15px]) passes", problems({ "a.tsx": "text-[15px]" }, { files: ["a.tsx"], tokens: [gap16], verification: STATIC }).length === 0);
check("a resolved spacing used as gap-[16px] fails", has(problems({ "a.tsx": "gap-[16px]" }, { files: ["a.tsx"], tokens: [gap16], verification: STATIC }), /\[16px\].*spacing-4/));
check("…and as gap-[1rem]", has(problems({ "a.tsx": "gap-[1rem]" }, { files: ["a.tsx"], tokens: [gap16], verification: STATIC }), /\[1rem\]/));
check("allowedLiterals with a reason exempts it", problems({ "theme.ts": "brand600: '#5B5FC7'" }, { files: ["theme.ts"], tokens: [brand], allowedLiterals: [{ value: "#5B5FC7", reason: "theme.ts defines the token" }], verification: STATIC }).length === 0);
check("allowedLiterals WITHOUT a reason does not", problems({ "theme.ts": "'#5B5FC7'" }, { files: ["theme.ts"], tokens: [brand], allowedLiterals: [{ value: "#5B5FC7" }], verification: STATIC }).length === 1);
check("a MISSING token with no decision fails; with one passes", (() => {
  const row = { value: "#123456", kind: "color", codeToken: null, verdict: "missing" };
  return has(problems({}, { tokens: [row], verification: STATIC }), /no token .* and no recorded decision/)
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
  has(problems({ "a.tsx": "bg-[#5b5fc7]" }, { files: ["a.tsx"], tokens: [brand], verification: STATIC }), /raw literal .*brand-600/));
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
    /'Button' was mapped to @\/ui\/Button/);
})());

console.log("component checks:");
const MAP = { version: 1, components: { Button: { figma: { key: "k-btn" }, code: { module: "@/ui/Button", export: "Button" } } } };
check("reused-but-never-imported fails", has(problems({ "a.tsx": "<button/>" }, { files: ["a.tsx"], components: [{ name: "Button", key: "k-btn", mapModule: "@/ui/Button", verdict: "reused" }], verification: STATIC }), /no built file imports it/));
check("reused and imported passes", problems({ "a.tsx": "import { Button } from '@/ui/Button'" }, { files: ["a.tsx"], components: [{ name: "Button", key: "k-btn", mapModule: "@/ui/Button", verdict: "reused" }], verification: STATIC }).length === 0);
check("marked \"new\" while its key IS mapped fails (the everything-is-new hole)", has(problems({}, { components: [{ name: "Button", key: "k-btn", mapModule: null, verdict: "new" }], verification: STATIC }, MAP), /marked "new".*@\/ui\/Button/));
check("genuinely new component passes", problems({ "a.tsx": "" }, { files: ["a.tsx"], components: [{ name: "PromoCard", key: "k-promo", mapModule: null, verdict: "new" }], verification: STATIC }, MAP).length === 0);

console.log("files[] — the gate only reads what is listed, so the list itself is checked:");
check("an empty / absent files[] fails (it would pass every literal check vacuously)", has(problems({}, { verification: STATIC }), /`files` is empty/) && has(problems({}, { files: [], verification: STATIC }), /`files` is empty/));
check("a listed file that is not on disk fails, by name", has(problems({ "a.tsx": "" }, { files: ["a.tsx", "src/Gone.tsx"], verification: STATIC }), /not found on disk: src\/Gone\.tsx/));
check("a raw literal is still caught when another listed file is missing", has(problems({ "a.tsx": "#5B5FC7" }, { files: ["a.tsx", "nope.tsx"], tokens: [brand], verification: STATIC }), /brand-600/));

console.log("verification evidence:");
check("no verification block fails", has(problems({}, {}), /no `verification` block/));
check("rendered with no artifacts fails", has(problems({}, { verification: { mode: "rendered", artifacts: [], deltas: [] } }), /`artifacts` is empty/));
check("rendered with an artifact that is not on disk fails", has(problems({}, { verification: { mode: "rendered", artifacts: ["design/verify/login.png"], deltas: [] } }), /not found on disk/));
check("rendered with a real artifact + deltas passes", problems({ "a.tsx": "", "design/verify/login.png": "png" }, { files: ["a.tsx"], verification: { mode: "rendered", renderer: "playwright", artifacts: ["design/verify/login.png"], deltas: [] } }).length === 0);
check("static-only needs a reason", has(problems({}, { verification: { mode: "static-only" } }), /no `reason`/));
check("status granted: verified ONLY when rendered", passedStatus({ verification: { mode: "rendered" } }) === "verified" && passedStatus({ verification: STATIC }) === "static-only");

console.log("hook process (exit codes + status writes):");
check("failing plan → exit 2, itemised stderr, status stays pending", (() => {
  const root = project({ "a.tsx": "#5B5FC7" }, { status: "pending", files: ["a.tsx"], tokens: [brand], verification: STATIC });
  const r = runHook(root);
  return r.status === 2 && /brand-600/.test(r.stderr) && /abandoned/.test(r.stderr) && planOf(root).status === "pending";
})());
check("passing static-only plan → exit 0 and status \"static-only\", never \"verified\"", (() => {
  const root = project({ "a.tsx": "text-brand-600" }, { status: "pending", files: ["a.tsx"], tokens: [brand], verification: STATIC });
  return runHook(root).status === 0 && planOf(root).status === "static-only";
})());
check("passing rendered plan → status \"verified\"", (() => {
  const root = project({ "a.tsx": "", "design/verify/login.png": "png" }, { status: "pending", files: ["a.tsx"], verification: { mode: "rendered", artifacts: ["design/verify/login.png"], deltas: [] } });
  return runHook(root).status === 0 && planOf(root).status === "verified";
})());
check("a plan paused on a user question (awaiting-user) does not block the stop, and is never closed", (() => {
  const root = project({}, { status: "awaiting-user", files: [], tokens: [{ value: "#123456", kind: "color", codeToken: null, verdict: "missing" }] });
  return runHook(root).status === 0 && planOf(root).status === "awaiting-user";
})());
check("fan-out: an agent is judged on the plan ITS transcript mentions, not a sibling's half-written one — which stays pending", (() => {
  const root = project({ "a.tsx": "text-brand-600" }, { status: "pending", files: ["a.tsx"], tokens: [brand], verification: STATIC });
  const sibling = path.join(root, "design", "plan", "settings.json");
  fs.writeFileSync(sibling, JSON.stringify({ status: "pending", files: [] }));
  const mine = path.join(root, "agent-a.jsonl"), none = path.join(root, "none.jsonl");
  fs.writeFileSync(mine, JSON.stringify({ tool: "Write", file_path: root + "/design/plan/login.json" }));
  fs.writeFileSync(none, "{}");
  const unscoped = runHook(root, { cwd: root, agent_id: "a1", agent_transcript_path: none }).status; // no evidence → all plans → blocked
  const r = runHook(root, { cwd: root, agent_id: "a1", agent_transcript_path: mine });
  return unscoped === 2 && r.status === 0 && planOf(root).status === "static-only" && JSON.parse(fs.readFileSync(sibling, "utf8")).status === "pending";
})());
check("fan-out: the session transcript is never used to scope a SUBAGENT's stop", (() => {
  const root = project({ "a.tsx": "text-brand-600" }, { status: "pending", files: ["a.tsx"], tokens: [brand], verification: STATIC });
  fs.writeFileSync(path.join(root, "design", "plan", "settings.json"), JSON.stringify({ status: "pending", files: [] }));
  const main = path.join(root, "main.jsonl");
  fs.writeFileSync(main, "design/plan/login.json");
  return runHook(root, { cwd: root, agent_id: "a1", transcript_path: main }).status === 2 && runHook(root, { cwd: root, transcript_path: main }).status === 0;
})());
check("missing coverage / a11y evidence WARNS on a passing rendered plan — exit 0, still verified", (() => {
  const files = { "a.tsx": "", "design/verify/login.png": "png" };
  const bare = project(files, { status: "pending", files: ["a.tsx"], verification: { mode: "rendered", artifacts: ["design/verify/login.png"], deltas: [] } });
  const full = project(files, { status: "pending", files: ["a.tsx"], verification: { mode: "rendered", artifacts: ["design/verify/login.png"], deltas: [], coverage: { rendered: ["default"], notChecked: [] }, a11y: { tool: "axe-core", violations: 0 } } });
  const r1 = runHook(bare), r2 = runHook(full);
  return r1.status === 0 && /coverage is missing/.test(r1.stderr) && /a11y is missing/.test(r1.stderr) && planOf(bare).status === "verified"
    && r2.status === 0 && !/warning/.test(r2.stderr);
})());
// P3 #150/#151/#180: validatePlanHeader is the reusable check for the schema'd plan header
// (screenName/nodeId/route/file) other skills' screen-resolution step reads instead of the
// free-text `screen` field. Not yet wired into the hook (see the note beside its one call site in
// verify-build.js) — the plan WRITER (plan-skeleton.js) needs to populate the fields first.
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
  const NEEDS_ARGS = ["design-diff", "drift-lint", "tokens", "map-bootstrap", "get-component", "map-validate"];
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
build(tmp).then(() => {
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
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, "tokens.js"), input, out, "--native", "swiftui"], { encoding: "utf8" });
    return r.status === 0 && fs.existsSync(path.join(out, "tokens.dtcg.json")) && /static let aB: Color/.test(fs.readFileSync(path.join(out, "DesignTokens.swift"), "utf8"));
  })());
  report();
});
