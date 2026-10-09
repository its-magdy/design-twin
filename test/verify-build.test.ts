// Offline tests for design-to-code/verify-build.ts (the build-screen Stop-hook gate) and for the
// committed claude-plugin/scripts/ bundles it ships in.
//   node test/verify-build.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { checkPlan, computeStatus, colorLiterals, arbitraryPx, colorKey, isStale, validatePlanHeader, anchorCoverage, moduleImported, importsOf,
  scanText, isSourceFile, verificationContradictions, deviationWarnings, auditGateWarnings } from "../design-to-code/verify-build.ts";
import { blockerIds } from "../design-to-code/audit.ts";
import { normHex, parseHex } from "../design-to-code/color.ts";
import { exportContentSha256, fileHashes as hashFiles, planCodeFiles, planCodeSkipped } from "../design-to-code/content-hash.ts";
import { waiversHash } from "../design-to-code/plan-waivers.ts";
import { build, ENTRIES } from "../claude-plugin/build-scripts.ts";
import type { CheckPlanResult, ReportRef } from "../design-to-code/verify-build.ts";
import * as verifyBuild from "../design-to-code/verify-build.ts";
import { buildExpectation, compare, STYLE_KEYS } from "../design-to-code/verify-screen.ts";
import type { BehaviourCheck, CodeConnectMap, MeasuredBehaviour, MeasuredNode, MeasuredStyles, Plan, PlanComputedStatus, PlanHookRecord, PlanTokenRow, PlanVerification } from "../design-to-code/types.ts";
import { check, report } from "./assert.ts";
import { codeMap, must, parseAs, readFixture, screenExport } from "./fixtures.ts";
import { isAuditReport, isPlan, isVerifyExpectation, isVerifyReport, parsePlan } from "../design-to-code/doc-guards.ts";
import { isScreenExport } from "../design-to-code/export-shape.ts";
import { isCodeConnectMap } from "../design-to-code/map-validate.ts";
import { isJsonObject } from "../design-to-code/types.ts";

const HOOK = path.join(import.meta.dirname, "..", "design-to-code", "verify-build.ts");

// A throwaway consumer project: files + a plan, returns its root.
function project(files: Record<string, string>, plan: unknown, map?: unknown) {
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
const runHook = (root: string, stdin?: object) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(stdin || { cwd: root }), encoding: "utf8" });
// A transcript line as Claude Code writes it: one JSON object per line, tool calls as message.content[] tool_use items.
const toolUse = (name: string, input: object, sidechain = false) => JSON.stringify({ type: "assistant", isSidechain: sidechain, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_x", name, input }] } });
const toolResult = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content: text }] } });
const planOf = (root: string): Plan => readFixture(path.join(root, "design", "plan", "login.json"), isPlan);
// One row of `verify-build --status --json` (the CLI prints {plan, status, why, reasons, reports}).
const isStatusRows = (x: unknown): x is StatusRow[] => Array.isArray(x) && x.every((r) => isJsonObject(r) && typeof r.plan === "string" && typeof r.status === "string" && Array.isArray(r.reasons));
interface StatusRow { plan: string; status: PlanComputedStatus; why: string | null; reasons: string[]; reports: Array<{ file: string; verdict: string | null; matchedBy: string }> }
// checkPlan returns { blocking, warnings }. `problems` is both, minus the two warnings every hand-made
// test plan triggers (no plan header, no export to check anchors against) — tests about those say so.
const AMBIENT = /plan header is missing|could not find this plan's screen export/;
// The plan is checked as the file project() just wrote (design/plan/login.json).
const split = (files: Record<string, string>, plan: Plan, map?: CodeConnectMap) => { const root = project(files, plan, map); return checkPlan({ plan, file: path.join(root, "design", "plan", "login.json") }, root); };
const problems = (files: Record<string, string>, plan: Plan, map?: CodeConnectMap) => { const r = split(files, plan, map); return [...r.blocking, ...r.warnings.filter((w) => !AMBIENT.test(w))]; };
const blocks = (files: Record<string, string>, plan: Plan, map?: CodeConnectMap) => split(files, plan, map).blocking;
const has = (list: string[], re: RegExp) => list.some((m) => re.test(m));
// A located report with only the fields a check reads set (the rest as locateReports writes them when absent).
const reportRef = (r: Partial<ReportRef> & { rel: string }): ReportRef => ({ matchedBy: "name", schema: null, verdict: null, headline: null, why: [], deltas: null, exportedAt: null, measuredAt: null, mtimeMs: 0, exportContentSha256: null, code: null, expectationChanged: false, expectationRel: null, waiversSha256: null, behaviour: null, shippedProbe: false, ...r });
const statusOf = (root: string) => computeStatus(planOf(root), { cwd: root, planFile: path.join(root, "design", "plan", "login.json") }).status;

const STATIC: PlanVerification = { mode: "static-only", reason: "no dev server in package.json" };
const brand: PlanTokenRow = { value: "#5B5FC7", kind: "color", codeToken: "brand-600", verdict: "exact" };
const gap16: PlanTokenRow = { value: "16", kind: "spacing", codeToken: "spacing-4", verdict: "exact" };

console.log("literal parsing:");
check("normHex (color.ts) normalises 3/4/6/8-digit hex with or without '#', emits '#', rejects junk", normHex("#abc") === "#aabbcc" && normHex("5B5FC7") === "#5b5fc7" && normHex("#5B5FC7CC") === "#5b5fc7cc" && normHex("#abcd") === "#aabbccdd" && normHex("red") === null && normHex("#12345") === null && normHex(0xabcdef) === null);
check("[one rule] every hex reader agrees: parseHex takes what normHex takes, '#' optional", parseHex("abc")?.r === 0xaa && parseHex("#abc")?.b === 0xcc && parseHex("#aabbcc80")?.a === 0x80 / 255 && parseHex("#12345") === null);
check("colorLiterals reads #hex, 0xAARRGGBB and rgb(), keyed rrggbb+alpha", (() => {
  const c = colorLiterals("a #5B5FC7 b Color(0xFF112233) c rgba(255, 0, 10, 0.5)");
  // opaque -> "ff"; 0xAARRGGBB puts alpha FIRST, so it must be moved to the end; rgba's 0.5 -> 80.
  return c.has("#5b5fc7ff") && c.has("#112233ff") && c.has("#ff000a80");
})());
// Alpha is part of the key: if it were folded away, #ffffff and #ffffff1a shared one key. The scan then
// reported whichever spelling it saw first — the live run said "raw literal #ffffff" for a plan row
// that read #ffffff1a, which looks like a hook bug — and an allowedLiterals entry for one exempted
// the other. They are different colors (opaque white vs a 10% scrim) and must stay different keys.
check("[alpha] 8-digit hex keeps its alpha, so it cannot collide with the opaque form", (() => {
  const c = colorLiterals("bg-[#ffffff1a] and #ffffff");
  return c.get("#ffffff1a") === "#ffffff1a" && c.get("#ffffffff") === "#ffffff" && c.size === 2;
})());
check("[alpha] colorKey normalises every spelling to 8 digits; 3- and 4-digit shorthand expand",
  colorKey("#abc") === "#aabbccff" && colorKey("#abcd") === "#aabbccdd" && colorKey("#5B5FC7") === "#5b5fc7ff"
  && colorKey("#5B5FC7CC") === "#5b5fc7cc" && colorKey("red") === null);
check("[alpha] rgba() percent and decimal alpha land on the SAME key as the #rrggbbaa spelling", (() => {
  const c = colorLiterals("rgba(255,255,255,0.1) rgb(1,2,3)");
  return c.has("#ffffff1a") && colorLiterals("rgba(255,255,255,10%)").has("#ffffff1a") && c.has("#010203ff");
})());
// rgb() literals go through color.ts parseCssColor, the same reader as the probe: percentage channels and decimal channels
// are colours too (100% = 255, CSS Color 4 §5.1); a call it cannot read (var(), a template placeholder) is not a literal.
check("[css] colorLiterals reads rgb(100% 0% 0% / 50%), rgb(10.4, 0, 0) and the modern rgb(0 0 0 / 40%); rgb(var(--x)) and rgba(${c}, 0.5) are skipped", (() => {
  const c = colorLiterals("rgb(100% 0% 0% / 50%) rgb(10.4, 0, 0) rgb(0 0 0 / 40%) rgb(var(--x)) rgba(${c}, 0.5)");
  return c.get("#ff000080") === "rgb(100% 0% 0% / 50%)" && c.has("#0a0000ff") && c.has("#00000066") && c.size === 3;
})());
check("[alpha] a scrim is no longer exempted by an allowedLiterals entry for the opaque colour", (() => {
  const scrim = { value: "#ffffff1a", kind: "color", codeToken: "bg-scrim", verdict: "exact" };
  // (theme.css is outside files[]: it only declares --color-scrim, so the undeclared-token check is satisfied)
  const pr = problems({ "a.tsx": "bg-[#ffffff1a]", "theme.css": "@theme { --color-scrim: #ffffff1a; }" }, { files: ["a.tsx"], tokens: [scrim],
    allowedLiterals: [{ value: "#ffffff", reason: "theme defines white" }], verification: STATIC });
  // …and the message names the spelling that is actually in the code, not the other one.
  const msg = must(pr[0], "pr[0]");
  return pr.length === 1 && /raw colour #ffffff1a\b/.test(msg) && /bg-scrim/.test(msg);
})());
check("arbitraryPx reads [Npx] and [Nrem] as px", (() => { const d = arbitraryPx("gap-[14px] p-[1.5rem]"); return d.has(14) && d.has(24); })());
// Keyed on the number alone, every `rounded-[20px]` was reported as the 20px a
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
// A hex that occurs ONLY in the generated theme files — the files that DEFINE the tokens, and which
// files[] already lists — is not a violation: none appears in a component, and blocking on each would
// force the build to re-declare every generated hex by hand.
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
  const msg = must(pr[0], "pr[0]");
  return pr.length === 1 && /matched on the exact value string/.test(msg) && /"file"/.test(msg);
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
// The builder honestly writes codeToken "MISSING" — the documented "no token exists"
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
  return pr.length === 1 && /no recorded decision/.test(must(pr[0], "pr[0]"));
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
  const row = (figmaName: string, value: string, codeToken: string) => ({ figmaName, value, kind: "color", codeToken, verdict: "exact" });
  // a theme (outside files[]) declaring every code token below, so only the identity check speaks
  const THEME = { "a.tsx": "", "theme.css": "@theme { --color-on-surface: #1b1b21; --color-on-primary: #ffffff; }" };
  const merged = problems(THEME, { files: ["a.tsx"], verification: STATIC, tokens: [
    row("Schemes/On Primary", "#ffffff", "text-on-surface"),
    row("Schemes/On Surface", "#ffffff", "text-on-surface"),
  ] });
  const mergedMsg = must(merged[0], "merged[0]");
  check("[identity] two Figma tokens on one code token is reported, naming both",
    merged.length === 1 && /2 DIFFERENT Figma tokens/.test(mergedMsg)
    && /Schemes\/On Primary/.test(mergedMsg) && /Schemes\/On Surface/.test(mergedMsg));
  check("[identity] the message says WHY sharing a value now is not sharing an identity",
    /diverge in another mode/.test(mergedMsg));
  check("[identity] three merged tokens are counted as three", (() => {
    const p3 = problems({ "a.tsx": "" }, { files: ["a.tsx"], verification: STATIC, tokens: [
      row("a/one", "#fff", "t"), row("b/two", "#fff", "t"), row("c/three", "#fff", "t")] });
    return p3.length === 1 && /3 DIFFERENT/.test(must(p3[0], "p3[0]"));
  })());
  // The same Figma token legitimately appears on several rows (one per node/usage) — that is one
  // identity, not a collision, and flagging it would make honest plans unfinishable.
  check("[identity] the SAME Figma token repeated across rows is not a collision",
    problems(THEME, { files: ["a.tsx"], verification: STATIC, tokens: [
      row("Schemes/On Primary", "#ffffff", "text-on-primary"),
      row("Schemes/On Primary", "#ffffff", "text-on-primary")] }).length === 0);
  check("[identity] distinct Figma tokens on DISTINCT code tokens is the correct case and passes",
    problems(THEME, { files: ["a.tsx"], verification: STATIC, tokens: [
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
const MAP = codeMap({ Button: { figma: { name: "Button", key: "k-btn" }, code: { module: "@/ui/Button", export: "Button" } } });
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
// the agent's real shape — artifacts and deltas as objects — is named as the wrong type, not "empty"/"missing"
{
  // (through the plan guard, as a plan read from disk would be — the shape the field-test agent wrote)
  const objPlan = (verification: Record<string, unknown>): Plan | null => { const r = parsePlan({ verification }); return "plan" in r ? r.plan : null; };
  const a = objPlan({ mode: "rendered", artifacts: { screenshot: "design/verify/Orders.png" }, deltas: [] });
  check("artifacts as an object → 'must be an array of paths, got an object', not 'empty'", !!a && has(problems({}, a), /artifacts must be an array of paths, got an object/) && !has(problems({}, a), /`artifacts` is empty/));
  const both = objPlan({ mode: "rendered", artifacts: { screenshot: "design/verify/Orders.png" }, deltas: { high: 33, medium: 111 } });
  check("both as objects (the real field-test plans) → both shape messages in ONE round", !!both && has(problems({}, both), /artifacts must be an array of paths, got an object/) && has(problems({}, both), /deltas must be an array of the residual differences, got an object/));
  const noDeltas = objPlan({ mode: "rendered", artifacts: { screenshot: "design/verify/Orders.png" } });
  check("artifacts an object AND deltas absent → both messages in one round", !!noDeltas && has(problems({}, noDeltas), /artifacts must be an array/) && has(problems({}, noDeltas), /deltas is missing/));
  check("deltas as an object with real artifacts → 'deltas must be an array…, got an object', not 'missing'", (() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vb-l2-")); fs.writeFileSync(path.join(tmp, "shot.png"), "x");
    const p = parsePlan({ verification: { mode: "rendered", artifacts: ["shot.png"], deltas: { high: 33 } } });
    const out = "plan" in p ? checkPlan({ plan: p.plan, file: path.join(tmp, "plan.json") }, tmp) : null;
    fs.rmSync(tmp, { recursive: true, force: true });
    const msgs = out ? [...out.blocking, ...out.warnings] : [];
    return msgs.some((m) => /deltas must be an array of the residual differences, got an object/.test(m)) && !msgs.some((m) => /deltas is missing/.test(m));
  })());
}
check("rendered with an artifact that is not on disk fails", has(problems({}, { verification: { mode: "rendered", artifacts: ["design/verify/login.png"], deltas: [] } }), /not found on disk/));
check("rendered with a real artifact + deltas + coverage + a11y is clean", problems({ "a.tsx": "", "design/verify/login.png": "png" }, { files: ["a.tsx"], verification: { mode: "rendered", renderer: "playwright", artifacts: ["design/verify/login.png"], deltas: [], coverage: { rendered: ["default"], notChecked: [] }, a11y: { tool: "axe-core", violations: 0 } } }).length === 0);
check("static-only needs a reason", has(problems({}, { verification: { mode: "static-only" } }), /no `reason`/));

console.log("hook process (exit codes; status is computed, never written):");
check("[shape] a plan the hook cannot use is WARNED about by name on every stop, never silently skipped", (() => {
  const root = project({ "a.tsx": "" }, { status: "pending", files: ["a.tsx"], verification: STATIC });
  fs.writeFileSync(path.join(root, "design", "plan", "broken.json"), JSON.stringify({ status: "pending", tokens: "none" }));
  const r = runHook(root);
  return /warning: design\/plan\/broken\.json is not a valid plan: `tokens` must be an array — it was NOT checked/.test(r.stderr);
})());
check("[shape] a plan path argument that is not a plan -> 'cannot read plan(s): <file> (<why>)', exit 1", (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-verify-bad-"));
  fs.writeFileSync(path.join(root, "p.json"), JSON.stringify([1, 2]));
  const r = spawnSync(process.execPath, [HOOK, "p.json"], { encoding: "utf8", cwd: root });
  return r.status === 1 && /verify-build: cannot read plan\(s\): p\.json \(is not a plan \(the file holds an array, not an object\)\)/.test(r.stderr);
})());
check("[shape] parsePlan names the field: `deviations` as an object is refused (the warning path used to accept anything)", (() => {
  const p = parsePlan({ deviations: {} });
  return "error" in p && /`deviations` must be an array/.test(p.error);
})());
const hookOf = (root: string): Partial<PlanHookRecord> => planOf(root).verification?.hook || {};
check("failing plan → exit 2, itemised stderr, `status` untouched, hook result recorded as blocked", (() => {
  const root = project({ "a.tsx": "#5B5FC7" }, { status: "pending", files: ["a.tsx"], tokens: [brand], verification: STATIC });
  const r = runHook(root);
  return r.status === 2 && /brand-600/.test(r.stderr) && /abandoned/.test(r.stderr) && planOf(root).status === "pending"
    && hookOf(root).result === "blocked" && statusOf(root) === "blocked";
})());
check("a passing static-only plan → exit 0; the hook NEVER writes `status`; computed status is static-only", (() => {
  const root = project({ "a.tsx": "text-brand-600" }, { status: "pending", files: ["a.tsx"], tokens: [brand], verification: STATIC });
  const r = runHook(root);
  return r.status === 0 && planOf(root).status === "pending" && hookOf(root).result === "pass" && statusOf(root) === "static-only";
})());
check("a rendered plan with NO verify report is never `verified` — the plan's own self-report is not evidence", (() => {
  const root = project({ "a.tsx": "", "design/verify/login.png": "png" }, { status: "pending", files: ["a.tsx"], verification: { mode: "rendered", artifacts: ["design/verify/login.png"], deltas: [] } });
  return runHook(root).status === 0 && planOf(root).status === "pending" && statusOf(root) === "unverified";
})());
check("…nor with a 'pass' report that predates verify-report@2 — it says so instead of trusting it", (() => {
  const root = project({ "a.tsx": "", "design/verify/login.png": "png" }, { status: "pending", files: ["a.tsx"], verification: { mode: "rendered", artifacts: ["design/verify/login.png"], deltas: [] } });
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(root, "a.tsx"), past, past);
  fs.writeFileSync(path.join(root, "design", "verify", "login.report.json"), JSON.stringify({ verdict: "pass", why: [] }));
  runHook(root);
  const st = computeStatus(planOf(root), { cwd: root, planFile: path.join(root, "design", "plan", "login.json") });
  return st.status === "unverified" && /predates designtwin\/verify-report@2/.test(st.reasons.join(" "));
})());
check("a failing verify report turns the same plan into `failed`, whatever the plan says", (() => {
  const root = project({ "a.tsx": "" }, { status: "verified", files: ["a.tsx"], verification: { mode: "rendered", artifacts: ["a.tsx"], deltas: [] } });
  fs.mkdirSync(path.join(root, "design", "verify"), { recursive: true });
  fs.writeFileSync(path.join(root, "design", "verify", "login.report.json"), JSON.stringify({ schema: "designtwin/verify-report@2", verdict: "fail", why: ["4 high-severity value mismatch(es)"] }));
  const before = statusOf(root);
  const r = runHook(root);
  // precedence 2: a failing @2 report is "failed" even before the hook has run — never hidden behind "pending"
  return before === "failed" && r.status === 0 && planOf(root).status === undefined && /removed the stored "status": "verified"/.test(r.stderr)
    && statusOf(root) === "failed";
})());
check("a hand edit to a file the plan describes turns `static-only` into `stale`, and re-opens the plan for the hook", (() => {
  const root = project({ "a.tsx": "text-brand-600" }, { status: "pending", files: ["a.tsx"], tokens: [brand], verification: STATIC });
  runHook(root);
  const ok1 = statusOf(root) === "static-only" && runHook(root).stderr === ""; // closed: the fast path says nothing
  fs.writeFileSync(path.join(root, "a.tsx"), "color: #5B5FC7");
  const stale = statusOf(root);
  const r = runHook(root);
  return ok1 && stale === "stale" && r.status === 2 && statusOf(root) === "blocked";
})());
// FU-shared-shell: the plan's anchors/components map a shared shell another plan lists in its files[] — the
// hook and the report hash it too, so a shell edit reopens THIS plan (before: it stayed verified/static-only).
check("planCodeFiles = files[] (as written, in order) then the mapped modules not already listed, sorted; `#Export` stripped; absolute / `..` / package / alias / extensionless skipped", (() => {
  const got = planCodeFiles({
    files: ["src/b/Screen.tsx", "src/a/Table.tsx"],
    anchors: { "1:1": { mapModule: "src/shell/Sidebar.tsx#Sidebar" }, "1:2": { mapModule: " src/shell/Header.tsx " }, "1:3": { mapModule: "./src/a/Table.tsx" }, "1:4": { mapModule: "/abs/Shell.tsx" },
      "1:5": { mapModule: "../other/Shell.tsx" }, "1:6": { mapModule: "react" }, "1:7": { mapModule: "@/components/Shell.tsx" }, "1:8": { mapModule: "@scope/ui" }, "1:9": { mapModule: "src/shell" },
      "1:10": { mapModule: "C:\\work\\Shell.tsx" }, "1:11": { omitted: "decorative" }, "1:12": { mapModule: "src/x/../../../up.tsx" } },
    components: [{ name: "Button", mapModule: "src/ui/Button.tsx" }, { name: "Badge", mapModule: null }, { name: "Icon", mapModule: "node:fs" }],
  });
  return JSON.stringify(got) === JSON.stringify(["src/b/Screen.tsx", "src/a/Table.tsx", "src/shell/Header.tsx", "src/shell/Sidebar.tsx", "src/ui/Button.tsx"]);
})());
{
  const files = { "src/Screen.tsx": "export const Screen = () => null;\n", "src/shell/Shell.tsx": "export const Shell = () => null;\n" };
  const root = project(files, { status: "pending", files: ["src/Screen.tsx"], anchors: { "1:2": { mapModule: "src/shell/Shell.tsx#Shell" } }, verification: STATIC });
  const r = runHook(root);
  const hooked = hookOf(root).files || {};
  check(`the hook passes and hashes the mapped shell outside files[] (got ${JSON.stringify(Object.keys(hooked))})`,
    r.status === 0 && statusOf(root) === "static-only" && JSON.stringify(Object.keys(hooked)) === JSON.stringify(["src/Screen.tsx", "src/shell/Shell.tsx"]) && typeof hooked["src/shell/Shell.tsx"] === "string");
  fs.appendFileSync(path.join(root, "src/shell/Shell.tsx"), "// a shared nav item\n");
  const st = computeStatus(planOf(root), { cwd: root, planFile: path.join(root, "design", "plan", "login.json") });
  check(`editing the shared shell → stale, naming it (before: still static-only) (got ${st.status}: ${st.reasons.join(" | ")})`,
    st.status === "stale" && st.reasons.some((x) => /file\(s\) changed since the hook passed: src\/shell\/Shell\.tsx$/.test(x)));
  // a hook record written when only files[] was hashed — the shell key is absent. That is the
  // upgrade, not a change: the plan the hook closed stays closed (before: stale + open with no file changed), one note
  runHook(root);
  const p = planOf(root);
  const hook = p.verification?.hook;
  if (hook) delete hook.files["src/shell/Shell.tsx"];
  const planFile = path.join(root, "design", "plan", "login.json");
  fs.writeFileSync(planFile, JSON.stringify(p, null, 2));
  const old = computeStatus(planOf(root), { cwd: root, planFile });
  check(`an older hook record (shell not hashed) → NOT stale, not open; a note "src/shell/Shell.tsx (now hashed: mapped module)" (got ${old.status}: ${old.reasons.join(" | ")})`,
    old.status === "static-only" && !verifyBuild.isOpen({ file: planFile, plan: planOf(root) }, root)
    && old.reasons.some((x) => /^hook: not hashed by the hook's last check \(its record predates hashing of mapped modules\), so not a change: src\/shell\/Shell\.tsx \(now hashed: mapped module\)/.test(x))
    && !old.reasons.some((x) => /file\(s\) changed since/.test(x)));
  check("…the Stop hook's fast path stays silent on it (closed)", (() => { const r = runHook(root); return r.status === 0 && r.stderr === "" && hookOf(root).files?.["src/shell/Shell.tsx"] === undefined; })());
  // a files[] entry the old record never hashed is still a change
  const p2 = planOf(root);
  if (p2.verification?.hook) delete p2.verification.hook.files["src/Screen.tsx"];
  fs.writeFileSync(planFile, JSON.stringify(p2, null, 2));
  const st2 = computeStatus(planOf(root), { cwd: root, planFile });
  check(`control: a files[] entry missing from the record is still a change → stale "(added to files[])" (got ${st2.status})`,
    st2.status === "stale" && st2.reasons.some((x) => x.includes("src/Screen.tsx (added to files[])")));
  // once the hook records the shell, an edit to it reopens the plan
  spawnSync(process.execPath, [HOOK, "design/plan/login.json"], { cwd: root, encoding: "utf8" }); // an explicit check re-records
  const recorded = typeof hookOf(root).files?.["src/shell/Shell.tsx"] === "string";
  fs.appendFileSync(path.join(root, "src/shell/Shell.tsx"), "// edited after the record\n");
  check("once a hook check records it, an edit to the shell is a change again (stale)", recorded && statusOf(root) === "stale");
}
// Extensionless mapModule paths (queued): resolved like an import, under the project, and the resolved FILE
// hashed; aliases / packages / no file → one hook warning naming them; a resolved module gone → labelled.
check("planCodeFiles(plan, cwd): an extensionless mapModule resolves .tsx/.ts/.jsx/.js, then /index.*; none found, an alias or a package → skipped and named by planCodeSkipped", (() => {
  const root = project({ "src/Screen.tsx": "x", "src/shell/Sidebar.tsx": "x", "src/shell/Header.ts": "x", "src/shell/nav/index.tsx": "x", "src/ui/Card.jsx": "x", "src/ui/Card.js": "x", "src/Screen.ts": "x" }, {});
  const plan: Plan = { files: ["src/Screen.tsx"], anchors: { "1:1": { mapModule: "src/shell/Sidebar#Sidebar" }, "1:2": { mapModule: "./src/shell/Header" }, "1:3": { mapModule: "src/shell/nav/" },
    "1:4": { mapModule: "src/ui/Card" }, "1:5": { mapModule: "src/Screen" }, "1:6": { mapModule: "src/shell/Gone" }, "1:7": { mapModule: "@/components/Shell" }, "1:8": { mapModule: "~/shell/Header" },
    "1:9": { mapModule: "react" }, "1:10": { mapModule: "../other/Shell" } } };
  const got = planCodeFiles(plan, root), noCwd = planCodeFiles(plan);
  const skipped = planCodeSkipped(plan, root);
  return JSON.stringify(got) === JSON.stringify(["src/Screen.tsx", "src/shell/Header.ts", "src/shell/Sidebar.tsx", "src/shell/nav/index.tsx", "src/ui/Card.jsx"])
    && JSON.stringify(noCwd) === JSON.stringify(["src/Screen.tsx"])
    && JSON.stringify(skipped) === JSON.stringify(["../other/Shell", "@/components/Shell", "react", "src/shell/Gone", "~/shell/Header"]);
})());
{
  const files = { "src/Screen.tsx": "export const Screen = () => null;\n", "src/shell/Shell.tsx": "export const Shell = () => null;\n" };
  const root = project(files, { status: "pending", files: ["src/Screen.tsx"], anchors: { "1:2": { mapModule: "src/shell/Shell#Shell" }, "1:3": { mapModule: "@/components/Footer" }, "1:4": { mapModule: "~/ui/Badge" } }, verification: STATIC });
  const r = runHook(root);
  check(`an extensionless shell mapModule: the hook hashes the resolved file (got ${JSON.stringify(Object.keys(hookOf(root).files || {}))})`,
    r.status === 0 && statusOf(root) === "static-only" && typeof hookOf(root).files?.["src/shell/Shell.tsx"] === "string");
  fs.appendFileSync(path.join(root, "src/shell/Shell.tsx"), "// a shared nav item\n");
  check("…editing it → stale", statusOf(root) === "stale");
  // named once in --status, never by the Stop hook (it would repeat on every stop)
  const NOTE = /mapModule path\(s\) not hashed with this plan's code: @\/components\/Footer, ~\/ui\/Badge — not a file under the project \(an `@\/`\/`~\/` alias/;
  const sj = spawnSync(process.execPath, [HOOK, "--status", "--json"], { cwd: root, encoding: "utf8" });
  const rows: unknown = JSON.parse(sj.stdout || "[]");
  const reasons = isStatusRows(rows) ? rows.flatMap((x) => x.reasons) : [];
  check(`verify-build --status: ONE note naming the alias mapModules (got ${JSON.stringify(reasons.filter((x) => /mapModule/.test(x)))})`,
    reasons.filter((x) => NOTE.test(x)).length === 1 && reasons.some((x) => x.startsWith("note: mapModule path(s) not hashed")));
  const hookRun = runHook(root, { cwd: root });
  const hookSaid = spawnSync(process.execPath, [HOOK, "design/plan/login.json"], { cwd: root, encoding: "utf8" });
  check("…the Stop hook says nothing about it (no warning on the fast path nor on an explicit check; not among checkPlan's warnings)",
    !/mapModule path\(s\) not hashed/.test(hookRun.stderr + hookSaid.stderr) && hookSaid.status === 0
    && !checkPlan({ plan: planOf(root), file: path.join(root, "design", "plan", "login.json") }, root).warnings.some((x) => /mapModule path\(s\) not hashed/.test(x)));
  runHook(root);
  fs.rmSync(path.join(root, "src/shell/Shell.tsx"));
  const gone = computeStatus(planOf(root), { cwd: root, planFile: path.join(root, "design", "plan", "login.json") });
  check(`the resolved module deleted → stale, labelled "no longer hashed" (not "no longer in files[]") (got ${gone.reasons.join(" | ")})`,
    gone.status === "stale" && gone.reasons.some((x) => x.includes("src/shell/Shell.tsx (no longer hashed: not in files[] nor a mapped module that resolves)")) && !gone.reasons.some((x) => /\(no longer in files\[\]\)/.test(x)));
}
// "the reference PNG is illustrative here" is a deviations[] row with field "reference" — the existing
// shape, so verify-build's deviation checks accept it unchanged (compare surfaces it in report.visual.illustrative).
check("a deviation with field \"reference\" passes deviationWarnings and deviationConflicts unchanged (no warning)", (() => {
  const plan: Plan = { deviations: [{ nodeId: "1:2", field: "reference", designed: "the PNG shows sample rows", built: "rows come from the API", reason: "the reference is illustrative: the rows are sample data" }] };
  return deviationWarnings(plan).length === 0 && verifyBuild.deviationConflicts(plan).length === 0
    && !problems({}, { ...plan, verification: STATIC }).some((m) => /deviation/i.test(m));
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
  fs.writeFileSync(mine, toolUse("Write", { file_path: root + "/design/plan/login.json", content: "{}" }));
  fs.writeFileSync(none, "{}");
  // a transcript naming no plan checks nothing (it used to fall back to every open plan and block)
  const unscoped = runHook(root, { cwd: root, agent_id: "a1", agent_transcript_path: none }).status;
  const untouched = !readFixture(sibling, isPlan).verification?.hook;
  const r = runHook(root, { cwd: root, agent_id: "a1", agent_transcript_path: mine });
  const sib = readFixture(sibling, isPlan);
  return unscoped === 0 && untouched && r.status === 0 && hookOf(root).result === "pass" && sib.status === "pending" && !sib.verification?.hook;
})());
check("fan-out: the session transcript is never used to scope a SUBAGENT's stop", (() => {
  const root = project({ "a.tsx": "text-brand-600", "b.tsx": "#5B5FC7" }, { status: "pending", files: ["a.tsx"], tokens: [brand], verification: STATIC });
  fs.writeFileSync(path.join(root, "design", "plan", "settings.json"), JSON.stringify(SIBLING));
  const main = path.join(root, "main.jsonl");
  fs.writeFileSync(main, toolUse("Edit", { file_path: "design/plan/login.json", old_string: "a", new_string: "b" }));
  return runHook(root, { cwd: root, agent_id: "a1", transcript_path: main }).status === 2 && runHook(root, { cwd: root, transcript_path: main }).status === 0;
})());
// The Stop hook reads a transcript of tens of MB line by line, and JSON.parses only the lines that can hold a
// tool_use item. Both halves must lose nothing the whole-file read and parse-every-line would have used.
check("transcript lines: forEachLine yields exactly readFileSync(…, \"utf8\").split(\"\\n\") — at any chunk size, across multi-byte characters, invalid bytes, CRLF, a BOM, a missing last newline and lines longer than the chunk", (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-lines-"));
  const bodies: Buffer[] = [
    Buffer.alloc(0), Buffer.from("\n"), Buffer.from("\n\n"), Buffer.from("one"), Buffer.from("one\n"),
    Buffer.from("\uFEFF{\"a\":1}\r\n{\"b\":\"é中😀\"}\n" + "x".repeat(50) + "\nlast"),
    Buffer.concat([Buffer.from("ok\n"), Buffer.from([0xe4, 0xb8, 0x0a, 0x80, 0x41, 0x0a, 0xf0, 0x9f]), Buffer.from("\ntail")]),
  ];
  return bodies.every((body, n) => {
    const f = path.join(root, `t${n}.jsonl`);
    fs.writeFileSync(f, body);
    const want = fs.readFileSync(f, "utf8").split("\n");
    return [1, 2, 3, 5, 7, 64, 1 << 20].every((chunk) => {
      const got: string[] = [];
      verifyBuild.forEachLine(f, (l) => got.push(l), chunk);
      return got.length === want.length && got.every((l, i) => l === want[i]);
    });
  });
})());
const carriesToolUse = (line: string): boolean => {
  try { const v: unknown = JSON.parse(line); return isJsonObject(v) && isJsonObject(v.message) && Array.isArray(v.message.content) && v.message.content.some((i) => isJsonObject(i) && i.type === "tool_use"); } catch { return false; }
};
// Lines as Claude Code writes them (toolUse/toolResult above, plus the other entry types a session transcript holds),
// and the same tool_use lines re-escaped the way another JSON writer may spell them.
const escapeAll = (s: string): string => s.replace(/"tool_use"/g, () => '"' + [..."tool_use"].map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()).join("") + '"');
const TRANSCRIPT_LINES = [
  toolUse("Write", { file_path: "design/plan/login.json", content: "{}" }),
  toolUse("Bash", { command: "echo {} > design/plan/login.json" }, true),
  JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "next" }, { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "a.tsx", old_string: "a", new_string: "b" } }] } }),
  toolResult("wrote design/plan/login.json \u001b[32mok\u001b[0m"),
  JSON.stringify({ type: "user", message: { role: "user", content: "build the login screen" } }),
  JSON.stringify({ type: "attachment", attachment: { kind: "file", text: "x" } }),
  JSON.stringify({ type: "system", subtype: "info", content: "compacted" }),
  "",
  "not json",
];
const ESCAPED_LINES = TRANSCRIPT_LINES.filter(carriesToolUse).flatMap((l) => [escapeAll(l), l.replace('"tool_use"', '"tool\\u005fuse"'), l.replace('"tool_use"', '"\\u0074ool_us\\u0065"')]);
check("transcript filter: every line that holds a tool_use item passes it — Claude Code's plain spelling and any \\u-escaped one", (() => {
  const users = [...TRANSCRIPT_LINES, ...ESCAPED_LINES].filter(carriesToolUse);
  return users.length === 3 + ESCAPED_LINES.length && users.every((l) => verifyBuild.mayHoldToolUse(l));
})());
check("transcript filter: a line that holds no tool_use item is skipped unparsed — a tool_result (even one with \\u escapes in its text), a prompt, an attachment, a system entry, a blank or non-JSON line",
  TRANSCRIPT_LINES.filter((l) => !carriesToolUse(l)).length === 6 && TRANSCRIPT_LINES.filter((l) => !carriesToolUse(l)).every((l) => !verifyBuild.mayHoldToolUse(l)));
check("transcript filter: a Write spelled with \\u escapes still claims its plan (ownPlans reads the file through the filter)", (() => {
  const root = project({ "a.tsx": "x" }, { status: "pending", files: ["a.tsx"], verification: STATIC });
  const t = path.join(root, "t.jsonl");
  fs.writeFileSync(t, escapeAll(toolUse("Write", { file_path: path.join(root, "design", "plan", "login.json"), content: "{}" })) + "\n" + toolResult("ok"));
  const plan = { file: path.join(root, "design", "plan", "login.json"), plan: planOf(root) };
  const all = verifyBuild.transcriptActions(t, true);
  return all.length === 1 && verifyBuild.ownPlans([plan], { cwd: root, transcript_path: t }, [plan], root).scope === "named";
})());
// The project graph reads every plan's files once per hook run; checkPlan and the recorded hashes take their bytes
// from it, except for a file the run itself has rewritten since (a plan another plan lists).
check("project graph: checkPlan takes a listed file's text from the graph it is handed (no second read)…", (() => {
  const root = project({ "a.tsx": "text-brand-600" }, { status: "pending", files: ["a.tsx"], tokens: [brand], verification: STATIC });
  const g = verifyBuild.buildGraph(root);
  fs.writeFileSync(path.join(root, "a.tsx"), "#5B5FC7"); // changed behind the graph's back: the run's snapshot is what is checked
  return checkPlan({ plan: planOf(root), file: path.join(root, "design", "plan", "login.json") }, root, { graph: () => g }).blocking.length === 0;
})());
check("…but reads one the run rewrote from disk", (() => {
  const root = project({ "a.tsx": "text-brand-600" }, { status: "pending", files: ["a.tsx"], tokens: [brand], verification: STATIC });
  const g = verifyBuild.buildGraph(root);
  fs.writeFileSync(path.join(root, "a.tsx"), "#5B5FC7");
  g.rewrote(path.join(root, "a.tsx"));
  return g.cached("a.tsx") === undefined && has(checkPlan({ plan: planOf(root), file: path.join(root, "design", "plan", "login.json") }, root, { graph: () => g }).blocking, /raw colour #5B5FC7/);
})());
check("project graph: hashes from its bytes equal hashes read from disk; the plans handed to it are the ones it counts", (() => {
  const root = project({ "a.tsx": "é\u0000bytes", "b.css": "x" }, { status: "pending", files: ["a.tsx", "b.css", "gone.tsx"], verification: STATIC });
  const g = verifyBuild.buildGraph(root);
  const viaGraph = hashFiles(["a.tsx", "b.css", "gone.tsx"], root, g.cached), fromDisk = hashFiles(["a.tsx", "b.css", "gone.tsx"], root);
  fs.writeFileSync(path.join(root, "b.css"), "y"); // not re-read: the hash is of the bytes the graph holds
  return JSON.stringify(viaGraph) === JSON.stringify(fromDisk) && viaGraph["gone.tsx"] === null && hashFiles(["b.css"], root, g.cached)["b.css"] === fromDisk["b.css"]
    && g.listCount.get("a.tsx") === 1 && verifyBuild.buildGraph(root, [], []).listCount.size === 0;
})());
check("hook: a plan listed in a later plan's files[] is hashed as the hook rewrote it (the --status that follows says not stale)", (() => {
  const root = project({ "a.tsx": "text-brand-600" }, { status: "pending", files: ["a.tsx"], tokens: [brand], verification: STATIC });
  const later = path.join(root, "design", "plan", "settings.json"); // sorts after login.json, so it is checked second
  fs.writeFileSync(later, JSON.stringify({ status: "pending", files: ["a.tsx", "design/plan/login.json"], tokens: [brand], verification: STATIC }));
  const t = path.join(root, "t.jsonl");
  fs.writeFileSync(t, [toolUse("Write", { file_path: path.join(root, "design", "plan", "login.json"), content: "{}" }), toolUse("Write", { file_path: later, content: "{}" })].join("\n"));
  const r = runHook(root, { cwd: root, transcript_path: t });
  const rec = readFixture(later, isPlan).verification?.hook?.files || {};
  const onDisk = hashFiles(["design/plan/login.json"], root)["design/plan/login.json"];
  const st = computeStatus(readFixture(later, isPlan), { cwd: root, planFile: later }).status;
  return r.status === 0 && !!hookOf(root).result && rec["design/plan/login.json"] === onDisk && st !== "stale";
})());
check("missing coverage / a11y evidence WARNS on a passing rendered plan — exit 0", (() => {
  const files = { "a.tsx": "", "design/verify/login.png": "png" };
  const bare = project(files, { status: "pending", files: ["a.tsx"], verification: { mode: "rendered", artifacts: ["design/verify/login.png"], deltas: [] } });
  const full = project(files, { status: "pending", files: ["a.tsx"], verification: { mode: "rendered", artifacts: ["design/verify/login.png"], deltas: [], coverage: { rendered: ["default"], notChecked: [] }, a11y: { tool: "axe-core", violations: 0 } } });
  const r1 = runHook(bare), r2 = runHook(full);
  return r1.status === 0 && /coverage is missing/.test(r1.stderr) && /a11y is missing/.test(r1.stderr)
    && r2.status === 0 && !/coverage is missing|a11y is missing/.test(r2.stderr);
})());
// validatePlanHeader — the schema'd header (screenName/nodeId/route/file) other skills
// resolve a plan by. Wired into the hook's warnings now that plan-skeleton.js writes it.
check("[header] the hook WARNS (never blocks) on a plan with no header", (() => {
  const root = project({ "a.tsx": "" }, { status: "pending", files: ["a.tsx"], verification: STATIC });
  const r = runHook(root);
  return r.status === 0 && /plan header is missing `screenName`, `nodeId`, `route`, `file`/.test(r.stderr);
})());
check("[header] a plan missing every header field is flagged, one message naming all of them",
  (() => { const w = validatePlanHeader({}); const msg = must(w[0], "w[0]"); return w.length === 1 && /screenName/.test(msg) && /nodeId/.test(msg) && /route/.test(msg) && /file/.test(msg); })());
check("[header] a plan with a complete header is clean",
  validatePlanHeader({ screenName: "Jet Roles", nodeId: "7314:87192", route: "/jet-roles", file: "src/JetRoles.tsx" }).length === 0);
check("[header] a plan missing only `route` names just that field",
  (() => { const w = validatePlanHeader({ screenName: "Jet Roles", nodeId: "7314:87192", file: "x.tsx" }); const msg = must(w[0], "w[0]"); return w.length === 1 && /`route`/.test(msg) && !/screenName/.test(msg); })());
check("[header] an empty string counts as missing, not present", validatePlanHeader({ screenName: "", nodeId: "1:1", route: "/x", file: "x.tsx" }).length === 1);

check("abandoned / already-closed plans are skipped (fast path)", (() => {
  const root = project({ "a.tsx": "#5B5FC7" }, { status: "abandoned", files: ["a.tsx"], tokens: [brand] });
  return runHook(root).status === 0 && planOf(root).status === "abandoned";
})());
check("stop_hook_active short-circuits (no re-entrant block)", (() => {
  const root = project({ "a.tsx": "#5B5FC7" }, { status: "pending", files: ["a.tsx"], tokens: [brand] });
  return runHook(root, { cwd: root, stop_hook_active: true }).status === 0;
})());

const age = (root: string, hours: number) => { const t = new Date(Date.now() - hours * 3600 * 1000); fs.utimesSync(path.join(root, "design", "plan", "login.json"), t, t); };
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

// ---------------------------------------------------------------- regressions on recorded plans
// Driven by test/fixtures/livetest3/plan/ — the real plans, reports, export and app sources from the
// live run, pruned by its build.ts (nothing hand-written).
const FX = path.join(import.meta.dirname, "fixtures", "livetest3", "plan");
const JR = "positions___7314_87192", GP = "Studio_Configurations__1359_21337";
const fxPlan = (s: string) => readFixture(path.join(FX, "plan", s + ".json"), isPlan);
// A consumer project laid out exactly like the live one: design/{export,plan,verify}, app/.
function liveProject(plans: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-live-"));
  fs.cpSync(path.join(FX, "export"), path.join(root, "design", "export"), { recursive: true });
  fs.cpSync(path.join(FX, "verify"), path.join(root, "design", "verify"), { recursive: true });
  fs.cpSync(path.join(FX, "app"), path.join(root, "app"), { recursive: true });
  fs.mkdirSync(path.join(root, "design", "plan"), { recursive: true });
  for (const [name, plan] of Object.entries(plans)) fs.writeFileSync(path.join(root, "design", "plan", name + ".json"), JSON.stringify(plan, null, 2));
  return root;
}
const checkLive = (root: string, name: string) => {
  const file = path.join(root, "design", "plan", name + ".json");
  return checkPlan({ plan: readFixture(file, isPlan), file }, root);
};
const colourBlocks = (r: CheckPlanResult) => r.blocking.filter((m) => /raw colour/.test(m));

console.log("a hex in a comment or a provenance note is not a literal:");
{
  // Header.tsx's doc comment: "…resolves to #121319 in Dark and #ffffff in Light." Before: three blocks
  // (#121319 twice — two plan rows resolve it — and #ffffff) for a comment.
  const plan = Object.assign(fxPlan(JR), { status: "pending", files: ["app/src/layout/Header.tsx"] });
  const root = liveProject({ [JR]: plan });
  check("the real Header.tsx (hexes only in its doc comment) raises no colour block", colourBlocks(checkLive(root, JR)).length === 0);
  const hdr = path.join(root, "app/src/layout/Header.tsx");
  fs.appendFileSync(hdr, "\nexport const Leak = () => <div style={{ background: '#121319' }} />;\n");
  const r = colourBlocks(checkLive(root, JR));
  const rMsg = must(r[0], "r[0]");
  check("…the same hex in CODE still blocks — once per literal, naming every token that resolves it",
    r.length === 1 && /#121319/.test(rMsg) && /bg-backgrounds-side-menu/.test(rMsg) && /bg-neutrals-neutral-0/.test(rMsg) && /Header\.tsx/.test(rMsg));
}
check("scanText drops //, /* */, JSX {/* */} and <!-- --> comments but keeps code", (() => {
  const t = scanText("a.tsx", "// #111111\nconst a = 1; /* #222222 */\n<div>{/* #333333 */}</div>\nconst b = '#444444';");
  const h = scanText("a.vue", "<!-- #555555 -->\n<p style=\"color:#666666\"></p>");
  return !/#111111|#222222|#333333/.test(t) && /#444444/.test(t) && !/#555555/.test(h) && /#666666/.test(h);
})());
check("a prose string (provenance note) is skipped; a style string is not", (() => {
  const t = scanText("a.tsx", "const note = \"bound to Neutrals/Neutral 0, which is #121319 in Dark\";\nconst c = \"#121319\";\nconst b = '1px solid #121319';\nconst k = 'flex items center bg-[#121319]';");
  return (t.match(/#121319/g) || []).length === 3 && !/Neutral 0, which/.test(t);
})());
check("`https://` in code is not mistaken for a comment", /#777777/.test(scanText("a.ts", "fetch(`https://x.test/a`); const c = '#777777';")));

console.log("exported SVG artwork is not code:");
{
  // Guided Policies resolves #d4d4d4 to two tokens; calendar-2.svg's baked-in stroke is #D4D4D4.
  // Before: two blocks for a file the skill forbids editing, cured only by allowedLiterals padding.
  const plan = Object.assign(fxPlan(GP), { status: "pending", files: ["app/src/assets/calendar-2.svg"],
    allowedLiterals: fxPlan(GP).allowedLiterals?.filter((a) => !(a.file && /\.svg$/.test(a.file))) });
  const root = liveProject({ [GP]: plan });
  check("the real calendar-2.svg (stroke=\"#D4D4D4\") in files[] raises no colour block, with no allowedLiterals entry for it",
    /#D4D4D4/i.test(fs.readFileSync(path.join(root, "app/src/assets/calendar-2.svg"), "utf8")) && colourBlocks(checkLive(root, GP)).length === 0);
  check("isSourceFile: .tsx/.css/.swift/.kt are code; .svg/.json/.md/.png are not",
    ["a.tsx", "a.css", "A.swift", "A.kt", "a.dart"].every(isSourceFile) && !["a.svg", "tokens.json", "README.md", "x.png"].some(isSourceFile));
}

console.log("a reused component resolves by module path, not by substring:");
{
  const gpRoot = liveProject({});
  const byFile = [{ rel: "app/src/features/guided-policies/screens/GuidedPoliciesScreen.tsx", text: fs.readFileSync(path.join(gpRoot, "app/src/features/guided-policies/screens/GuidedPoliciesScreen.tsx"), "utf8") }];
  check("importsOf reads ES/CJS/dynamic/CSS imports",
    importsOf("import { A } from '../A';\nimport type { B } from \"@/B\";\nexport { C } from './C';\nconst d = require('d');\nimport('./e');\n@import url('f.css');").join(",") === "../A,@/B,./C,d,./e,f.css");
  check("the real GuidedPoliciesScreen.tsx ('../../../components/PageTitle') satisfies mapModule \"app/src/components/PageTitle.tsx\"",
    moduleImported("app/src/components/PageTitle.tsx", byFile, gpRoot));
  check("…and so does an alias import ('@/components/PageTitle')",
    moduleImported("app/src/components/PageTitle.tsx", [{ rel: "app/src/x/Y.tsx", text: 'import { PageTitle } from "@/components/PageTitle";' }], gpRoot));
  check("…and a mapModule written as the alias itself",
    moduleImported("@/components/PageTitle", byFile, gpRoot));
  check("a module nobody imports is still caught", !moduleImported("app/src/components/Tooltip.tsx", byFile, gpRoot));
  // The full plan, rewritten the honest way the live build first wrote it (repo-path mapModule): before
  // the fix, six "was it regenerated instead of reused?" BLOCKS; now zero warnings about imports.
  const plan = fxPlan(GP);
  const repo: Record<string, string> = { "../../../components/PageTitle": "app/src/components/PageTitle.tsx", "../../../components/SearchInput": "app/src/components/SearchInput.tsx",
    "../../../components/SquareButton": "app/src/components/SquareButton.tsx", "../../../components/DataTable": "app/src/components/DataTable.tsx",
    "../../../components/Icon": "app/src/components/Icon.tsx", "../../../components/Modal": "app/src/components/Modal.tsx" };
  let rewritten = 0;
  for (const c of must(plan.components, "plan.components")) { const to = c.mapModule ? repo[c.mapModule] : undefined; if (to) { c.mapModule = to; rewritten++; } }
  plan.files = ["app/src/features/guided-policies/screens/GuidedPoliciesScreen.tsx"];
  const root = liveProject({ [GP]: plan });
  const r = checkLive(root, GP);
  check(`the live Guided Policies plan with ${rewritten} honest repo-path mapModules: no import warning, and nothing about components blocks`,
    rewritten === 6 && !r.warnings.some((w) => /imports that module/.test(w)) && !r.blocking.some((b) => /component/.test(b)));
  must(must(plan.components, "plan.components")[2], "plan.components[2]").mapModule = "app/src/components/Tooltip.tsx";
  fs.writeFileSync(path.join(root, "design/plan", GP + ".json"), JSON.stringify(plan));
  const r2 = checkLive(root, GP);
  check("a genuinely un-imported reuse is a WARNING, not a block", r2.warnings.some((w) => /Tooltip/.test(w)) && !r2.blocking.some((b) => /Tooltip/.test(b)));
}

console.log("a visible design node with no anchor blocks; hidden ones never count:");
{
  const S = path.join(FX, "export/pages/__Optimization_management_", JR + ".json");
  const doc = readFixture(S, isScreenExport);
  const cov0 = anchorCoverage({ anchors: {} }, doc);
  check("[anchors] with no anchors, all 254 visible nodes are unmapped — reported as ONE subtree (the frame)", cov0.visible === 254 && cov0.unmappedNodes === 254 && cov0.unmapped.length === 1 && cov0.unmapped[0]?.id === "7314:87192");
  const cov1 = anchorCoverage({ anchors: { "7314:87192": { mapModule: "app/src/features/jet-roles/screens/JetRolesScreen.tsx" } } }, doc);
  check("[anchors] one anchor on the frame covers every descendant (children inherit)", cov1.unmapped.length === 0 && cov1.unmappedNodes === 0);
  // the real JR plan anchors 16 ids including the frame → covered; its hidden-node ids are not required
  const cov2 = anchorCoverage(fxPlan(JR), doc);
  check("[anchors] the live Jet Roles plan (16 anchors incl. the frame) covers every visible node", cov2.unmapped.length === 0);
  const hiddenId = "I20173:137670;72:3598"; // the Breadcrumb instance, hidden: true
  const cov3 = anchorCoverage({ anchors: { "7314:87192": { mapModule: "x.tsx" }, [hiddenId]: { mapModule: "x.tsx" } } }, doc);
  check("[anchors] an anchor on a HIDDEN node is reported (hidden layers are not built)", cov3.hiddenAnchored.includes(hiddenId));
  // Guided Policies: the frame draws its footer twice; the plan anchors one and never mentions 1359:21457.
  const root = liveProject({ [GP]: Object.assign(fxPlan(GP), { status: "pending" }) });
  const r = checkLive(root, GP);
  const b = r.blocking.filter((m) => /no anchor in the plan/.test(m));
  const bMsg = must(b[0], "b[0]");
  check("[anchors] the live Guided Policies plan BLOCKS on exactly its unanchored subtree, 1359:21457 (the duplicate footer)", b.length === 1 && /1359:21457/.test(bMsg) && /^3 visible/.test(bMsg));
  // blocking messages are SAVED into the plan (verification.hook.blocking), a committed file —
  // they name scripts in words, never by the per-machine absolute path the printed hints carry.
  check("no blocking message (saved into the plan) carries a script path or a `node \"…\"` command",
    r.blocking.length > 0 && r.blocking.every((m) => !/node "|[\\/]scripts[\\/][a-z-]+\.(js|ts)|design-to-code[\\/]/.test(m)) && /the plan-skeleton script/.test(bMsg));
  const fixed = fxPlan(GP);
  must(fixed.anchors, "fixed.anchors")["1359:21457"] = { omitted: "duplicate footer drawn on top of the frame (see deviations: duplicateFooter)" };
  fs.writeFileSync(path.join(root, "design/plan", GP + ".json"), JSON.stringify(fixed));
  check("[anchors] …and `{omitted: \"<why>\"}` on it clears the block", checkLive(root, GP).blocking.length === 0);
}

console.log("the live plans and reports: neither comes out `verified`:");
{
  const root = liveProject({ [JR]: fxPlan(JR), [GP]: fxPlan(GP) });
  const planFile = (s: string) => path.join(root, "design/plan", s + ".json");
  const st = (s: string) => computeStatus(readFixture(planFile(s), isPlan), { cwd: root, planFile: planFile(s) });
  const before = [st(JR), st(GP)];
  check("before the hook runs, the stored \"verified\" is ignored — computed status is pending, and says why",
    fxPlan(JR).status === "verified" && fxPlan(GP).status === "verified" && before.every((s) => s.status === "pending" && /not confirmed by the current hook and is ignored/.test(s.reasons[0] ?? "")));
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: root }), encoding: "utf8" });
  const after = { jr: readFixture(planFile(JR), isPlan), gp: readFixture(planFile(GP), isPlan) };
  const jrText = fs.readFileSync(planFile(JR), "utf8"); // (the hook keeps the plan file's own format)
  check("the hook actively clears the stored \"verified\" from both plans", after.jr.status === undefined && after.gp.status === undefined && /removed the stored "status": "verified"/.test(r.stderr));
  const jr = st(JR), gp = st(GP);
  check(`Jet Roles: not verified — its report (JetRoles.report.json, schema @1) is flagged as predating @2, and its false "31 component(s) … never built" is NOT repeated (got ${jr.status})`,
    jr.status === "unverified" && /JetRoles\.report\.json is designtwin\/verify-report@1 \(its verdict: "fail"\) — it predates designtwin\/verify-report@2/.test(jr.reasons.join(" "))
    && !/never built|31 component/.test(jr.reasons.join(" ")) && jr.reports[0]?.matchedBy === "layer name");
  check(`Guided Policies: not verified either (got ${gp.status} — its hook run blocked on the unanchored footer)`, gp.status !== "verified" && gp.status === "blocked");
  const cli = spawnSync(process.execPath, [HOOK, "--status", "--json"], { cwd: root, encoding: "utf8" });
  const rows = parseAs(cli.stdout, isStatusRows, "--status --json");
  check("`verify-build.js --status --json` reports the same, and writes nothing", cli.status === 0 && rows.length === 2 && rows.every((x) => x.status !== "verified")
    && fs.readFileSync(planFile(JR), "utf8") === jrText);
  // make GP pass its hook: status must STILL not be verified, because its report says fail
  const gpFixed = readFixture(planFile(GP), isPlan);
  must(gpFixed.anchors, "gpFixed.anchors")["1359:21457"] = { omitted: "duplicate footer" };
  fs.writeFileSync(planFile(GP), JSON.stringify(gpFixed, null, 2));
  spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: root }), encoding: "utf8" });
  const gp2 = st(GP);
  check(`with its hook passing, Guided Policies is still not verified — its @1 report must be regenerated (got ${gp2.status})`, gp2.status === "unverified" && /GuidedPolicies\.report\.json is designtwin\/verify-report@1/.test(gp2.reasons.join(" ")));
  // the `<Layer>__<id>` report naming is found by name too
  fs.renameSync(path.join(root, "design/verify/JetRoles.report.json"), path.join(root, "design/verify", JR + ".report.json"));
  const jr2 = st(JR);
  check("the new <Layer>__<id>.report.json naming is found as well", jr2.status === "unverified" && jr2.reports[0]?.matchedBy === "name");
}

console.log("the verification block is checked against itself; deviations are calibrated:");
{
  const root = liveProject({ [JR]: Object.assign(fxPlan(JR), { status: "pending" }), [GP]: Object.assign(fxPlan(GP), { status: "pending" }) });
  const jr = checkLive(root, JR);
  check("the live Jet Roles plan: a11y.violations 0 beside coverage.notChecked 'axe/a11y automated scan' is flagged as a contradiction",
    jr.warnings.some((w) => /contradicts itself: `a11y` records 0 violation/.test(w) && /axe\/a11y automated scan/.test(w)));
  check("a report that fails beside a plan claiming pass is flagged", verificationContradictions({ verification: { verifyScreenVerdict: "pass" } }, [reportRef({ rel: "design/verify/x.report.json", verdict: "fail" })]).some((w) => /cannot overrule/.test(w)));
  check("a consistent block raises nothing", verificationContradictions({ verification: { a11y: { tool: "axe", violations: 0 }, coverage: { rendered: ["default"], notChecked: [{ what: "rtl" }] } } }, []).length === 0);
  const gp = checkLive(root, GP);
  check("the live Guided Policies plan: its 7 prose-only deviations are flagged as missing nodeId/field/designed/built",
    gp.warnings.some((w) => /^7 deviation\(s\) are missing fields/.test(w) && /duplicateFooter/.test(w)));
  check("a calibrated deviation {nodeId, field, designed, built, reason} passes",
    deviationWarnings({ deviations: [{ nodeId: "18580:60861", field: "x", designed: 1296.81, built: 1315.75, reason: "status chips aligned to their header" }] }).length === 0);
}

console.log("end to end — plan-skeleton.js writes the plan, the hook checks it:");
{
  const root = liveProject({});
  const SK = path.join(import.meta.dirname, "..", "design-to-code", "plan-skeleton.ts");
  const E = "design/export/pages/__Optimization_management_";
  const planRel = "design/plan/" + JR + ".json";
  const g = spawnSync(process.execPath, [SK, `${E}/${JR}.json`, `${E}/${JR}.vars.json`, "design/export/design-system", "--out", planRel], { cwd: root, encoding: "utf8" });
  const hook = () => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: root }), encoding: "utf8" });
  const r1 = hook();
  check("a fresh skeleton (nothing filled) BLOCKS on its one unanchored subtree — the frame — and on nothing else",
    g.status === 0 && r1.status === 2 && /254 visible design node\(s\) have no anchor/.test(r1.stderr) && /7314:87192 'positions'/.test(r1.stderr) && !/raw colour/.test(r1.stderr));
  check("…its header is complete except the route, and its unfilled token rows are ONE warning, not 33",
    /plan header is missing `route`/.test(r1.stderr) && (r1.stderr.match(/have no token and no recorded decision/g) || []).length === 1 && /33 token row\(s\)/.test(r1.stderr));
  const p = readFixture(path.join(root, planRel), isPlan);
  must(must(p.anchors, "p.anchors")["7314:87192"], "p.anchors['7314:87192']").mapModule = "app/src/layout/Header.tsx";
  p.files = ["app/src/layout/Header.tsx"];
  p.route = "/jet-roles";
  fs.writeFileSync(path.join(root, planRel), JSON.stringify(p, null, 2));
  const r2 = hook();
  const st = computeStatus(readFixture(path.join(root, planRel), isPlan), { cwd: root, planFile: path.join(root, planRel) });
  check(`one anchor on the frame + files[] → the hook passes (exit ${r2.status}); status is computed from the live JetRoles report — @1, so unverified: ${st.status}`,
    r2.status === 0 && st.status === "unverified" && /JetRoles\.report\.json is designtwin\/verify-report@1/.test(st.reasons.join(" ")));
}

console.log("the verify-report@2 shape: incomplete ≠ pass, a changed expectation invalidates the report:");
{
  const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
  // A plan that passes its hook; its report is then swapped between @2 shapes (field names as
  // verify-screen.js --compare writes them since the @2 schema: verdict pass|fail|incomplete, headline, inputs).
  const setup = (report: unknown, expectation: string | undefined) => {
    const root = project({ "a.tsx": "" }, { status: "pending", nodeId: "7314:87192", files: ["a.tsx"], verification: { mode: "rendered", artifacts: ["a.tsx"], deltas: [] } });
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(path.join(root, "a.tsx"), past, past);
    fs.mkdirSync(path.join(root, "design", "verify"), { recursive: true });
    if (expectation !== undefined) fs.writeFileSync(path.join(root, "design", "verify", "JetRoles.expected.json"), expectation);
    fs.writeFileSync(path.join(root, "design", "verify", "JetRoles.report.json"), JSON.stringify(report));
    runHook(root);
    return computeStatus(planOf(root), { cwd: root, planFile: path.join(root, "design", "plan", "login.json") });
  };
  const EXP = JSON.stringify({ schema: "designtwin/verify-expectation@2", frame: { nodeId: "7314:87192", name: "positions " }, hidden: { ids: [] } });
  const v2 = (verdict: string, extra?: object) => Object.assign({ schema: "designtwin/verify-report@2", screen: "positions ", verdict, headline: `${verdict.toUpperCase()} — nodes measured 180/189`, why: [], inputs: { expectationSha256: sha(EXP) }, summary: { componentsAbsent: 0 } }, extra);
  const inc = setup(v2("incomplete"), EXP);
  check(`an @2 report found through its expectation's frame.nodeId; verdict "incomplete" → unverified, quoting the headline (got ${inc.status})`,
    inc.status === "unverified" && inc.reports[0]?.matchedBy === "expectation frame" && /INCOMPLETE — nodes measured 180\/189/.test(inc.reasons.join(" ")));
  const pass = setup(v2("pass"), EXP);
  check(`an @2 "pass" that does not record the export content hash it measured → unverified, saying so (got ${pass.status})`, pass.status === "unverified" && /inputs\.exportContentSha256/.test(pass.reasons.join(" ")));
  const moved = setup(v2("pass"), EXP.replace("positions ", "positions"));
  check(`an @2 "pass" whose inputs.expectationSha256 no longer matches the .expected.json on disk → unverified (got ${moved.status})`,
    moved.status === "unverified" && /inputs\.expectationSha256 no longer matches/.test(moved.reasons.join(" ")));
  const fail = setup(v2("fail"), EXP);
  check(`an @2 "fail" → failed (got ${fail.status})`, fail.status === "failed");
}

console.log("freshness by content, never by clock:");
{
  const VS = path.join(import.meta.dirname, "..", "design-to-code", "verify-screen.ts");
  const before = path.join(FX, "repull", "before.json"), after = path.join(FX, "repull", "after.json");
  const rawB = fs.readFileSync(before, "utf8"), rawA = fs.readFileSync(after, "utf8");
  check("the real no-change re-pull pair: the files differ (exportedAt), the export content hash does not",
    rawB !== rawA && exportContentSha256(parseAs(rawB, isScreenExport, "the export")) === exportContentSha256(parseAs(rawA, isScreenExport, "the export")));
  check("…while a real design edit (one layer renamed) does change it", (() => {
    const d = parseAs(rawA, isScreenExport, "the export");
    const dChild = must(must(must(d.nodes[0], "d.nodes[0]").children, "d.nodes[0].children")[0], "d.nodes[0].children[0]");
    dChild.name += " (edited)";
    return exportContentSha256(d) !== exportContentSha256(parseAs(rawA, isScreenExport, "the export"));
  })());
  check("`_slices[].at` (variables-merge provenance) is stripped too, the rest of a slice is not", (() => {
    const v = (at: string, n: number) => ({ _slices: [{ file: "a", at, n }], exportedAt: at });
    return exportContentSha256(v("t1", 1)) === exportContentSha256(v("t2", 1)) && exportContentSha256(v("t1", 1)) !== exportContentSha256(v("t1", 2));
  })());

  // The real flow in a project laid out like the live one: the repull pair's "before" is the export on
  // disk, the plan anchors the frame and lists Header.tsx, verify-screen --expect/--compare run for real.
  const root = liveProject({});
  const E = "design/export/pages/__Optimization_management_";
  const exportFile = path.join(root, E, JR + ".json");
  for (const f of fs.readdirSync(path.join(root, "design/verify"))) fs.unlinkSync(path.join(root, "design/verify", f)); // only this flow's report
  fs.copyFileSync(before, exportFile);
  const planFile = path.join(root, "design", "plan", JR + ".json");
  fs.writeFileSync(planFile, JSON.stringify({ status: "pending", screenName: "Jet Roles", nodeId: "7314:87192", route: "/jet-roles", file: `${E}/${JR}.json`,
    files: ["app/src/layout/Header.tsx"], anchors: { "7314:87192": { mapModule: "app/src/layout/Header.tsx" } },
    verification: { mode: "rendered", artifacts: ["app/src/layout/Header.tsx"], deltas: [], coverage: { rendered: ["default"], notChecked: [] }, a11y: { tool: "axe-core", violations: 0 } } }, null, 2));
  const vs = (args: string[]) => spawnSync(process.execPath, [VS, ...args], { cwd: root, encoding: "utf8" });
  const hook = () => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: root }), encoding: "utf8" });
  const st = () => computeStatus(readFixture(planFile, isPlan), { cwd: root, planFile });
  const x = vs(["--expect", `${E}/${JR}.json`]);
  fs.writeFileSync(path.join(root, "design/verify/m.json"), JSON.stringify({ measuredAt: "2026-09-23T00:00:00Z", renderer: "test", nodes: [] }));
  vs(["--compare", `design/verify/${JR}.expected.json`, "design/verify/m.json"]);
  const repFile = path.join(root, "design/verify", JR + ".report.json");
  const rep = readFixture(repFile, isVerifyReport);
  const expectation = readFixture(path.join(root, "design/verify", JR + ".expected.json"), isVerifyExpectation);
  check("--expect records the export's content hash in the expectation (exportContentSha256)",
    x.status === 0 && expectation.exportContentSha256 === exportContentSha256(parseAs(rawB, isScreenExport, "the export")));
  check("--compare records WHAT it measured: the export content hash, and the plan's files[] hashed exactly as the Stop hook hashes them",
    rep.inputs?.exportContentSha256 === expectation.exportContentSha256 && rep.inputs?.code?.plan === `design/plan/${JR}.json`
    && JSON.stringify(rep.inputs?.code?.files) === JSON.stringify(hashFiles(["app/src/layout/Header.tsx"], root)) && rep.inputs?.code !== undefined && "gitHead" in rep.inputs.code);
  // The report above is real; its verdict is set to "pass" to stand for a passing render (the probe
  // here measured nothing). Every other field is what --compare wrote.
  rep.verdict = "pass";
  fs.writeFileSync(repFile, JSON.stringify(rep, null, 2));
  hook();
  const s0 = st();
  check(`a passing @2 report that measured this design and this code → verified (got ${s0.status})`, s0.status === "verified");
  const future = new Date(Date.now() + 3600e3);
  fs.utimesSync(path.join(root, "app/src/layout/Header.tsx"), future, future);
  fs.utimesSync(exportFile, future, future);
  const s1 = st();
  check(`\`touch\` on the code and the export changes nothing — no mtime is consulted (got ${s1.status}; before: unverified, "older than the newest file")`, s1.status === "verified");
  // a no-change re-pull: the export is replaced by the real "after" pull, then --expect is re-run
  fs.copyFileSync(after, exportFile);
  const x2 = vs(["--expect", `${E}/${JR}.json`]);
  const s2 = st();
  check(`a no-change re-pull + re-run --expect: --expect says only exportedAt changed, and the screen stays verified (got ${s2.status}; before: unverified)`,
    /only exportedAt changed/.test(x2.stderr) && !/PREVIOUS expectation/.test(x2.stderr) && s2.status === "verified");
  // a real design change
  const edited = parseAs(rawA, isScreenExport, "the export");
  const editedChild = must(must(must(edited.nodes[0], "edited.nodes[0]").children, "edited.nodes[0].children")[0], "edited.nodes[0].children[0]");
  editedChild.name += " (edited)";
  fs.writeFileSync(exportFile, JSON.stringify(edited));
  const s3 = st();
  check(`a real design change → unverified, naming the content hash change (got ${s3.status})`, s3.status === "unverified" && /the design changed since/.test(s3.reasons.join(" ")));
  fs.copyFileSync(after, exportFile);
  // a real code change: the hook re-opens the plan, passes, and the report no longer describes the code
  fs.appendFileSync(path.join(root, "app/src/layout/Header.tsx"), "\n// edited\n");
  const s4a = st().status;
  hook();
  const s4 = st();
  check(`a real code change → stale until the hook re-checks, then unverified: the report measured different code (got ${s4a} → ${s4.status})`,
    s4a === "stale" && s4.status === "unverified" && /measured different code — changed since: app\/src\/layout\/Header\.tsx/.test(s4.reasons.join(" ")));
  const noCode = Object.assign({}, rep, { inputs: Object.assign({}, rep.inputs, { code: undefined }) });
  fs.writeFileSync(repFile, JSON.stringify(noCode));
  check("a report with no inputs.code is never verified — it cannot say which code it measured", /does not record which code it measured/.test(st().reasons.join(" ")));

  // pass-with-deviations and the plan's waivers[]/descopes[]. A fresh --compare of
  // the code as it is now; its verdict is set by hand like the "pass" above.
  vs(["--compare", `design/verify/${JR}.expected.json`, "design/verify/m.json"]);
  const fresh = readFixture(repFile, isVerifyReport);
  const withReport = (verdict: string, waivers: { plan: string; sha256: string } | null) => {
    const r = structuredClone(fresh);
    r.verdict = verdict;
    const inputs = Object.assign({}, r.inputs);
    delete inputs.waivers;
    if (waivers) inputs.waivers = waivers;
    r.inputs = inputs;
    fs.writeFileSync(repFile, JSON.stringify(r, null, 2));
  };
  withReport("pass", null);
  hook();
  const g0 = st();
  check(`a report written before waivers existed (no inputs.waivers) beside a plan with none still verifies (got ${g0.status})`, g0.status === "verified");
  withReport("pass-with-deviations", null);
  const g1hook = spawnSync(process.execPath, [HOOK, planFile], { cwd: root, encoding: "utf8" }); // checked by name: the Stop hook's fast path is silent on a plan it already passed
  const g1 = st();
  check(`every report passing, one "pass-with-deviations" → verified-with-deviations (got ${g1.status}; was: unverified)`,
    g1.status === "verified-with-deviations" && /pass-with-deviations/.test(g1.reasons.join(" ")));
  check("the Stop hook does not block on a pass-with-deviations report, and prints the computed status",
    g1hook.status === 0 && /hook passed · computed status: verified-with-deviations/.test(g1hook.stderr));
  // The owner accepts a delta: the plan gains waivers[] — the hook's planHash must not move.
  const accepted = readFixture(planFile, isPlan);
  const hashBefore = accepted.verification?.hook?.planHash;
  accepted.waivers = [{ nodeId: "7314:87192", field: "font-size", designed: 14, built: 16, exportContentSha256: fresh.inputs?.exportContentSha256 || "", reason: "brand type scale", decidedBy: "owner", decidedAt: "2026-09-30" }];
  fs.writeFileSync(planFile, JSON.stringify(accepted, null, 2));
  const g2 = st();
  check(`adding a waiver does not send the hook back to pending (planHash excludes waivers[]/descopes[]); the report is stale until re-compared (got ${g2.status})`,
    g2.status === "unverified" && !/plan changed after the hook's last check/.test(g2.reasons.join(" ")) && /waivers changed since the last compare — re-run --compare/.test(g2.reasons.join(" ")));
  const g2hook = hook();
  check("…and the hook, re-run, records the same planHash", g2hook.status === 0 && readFixture(planFile, isPlan).verification?.hook?.planHash === hashBefore);
  withReport("pass-with-deviations", { plan: `design/plan/${JR}.json`, sha256: waiversHash(accepted) });
  const g3 = st();
  check(`re-compared with those waivers → verified-with-deviations (got ${g3.status})`, g3.status === "verified-with-deviations");
  const edited2 = readFixture(planFile, isPlan);
  must(must(edited2.waivers, "edited2.waivers")[0], "edited2.waivers[0]").built = 18;
  fs.writeFileSync(planFile, JSON.stringify(edited2, null, 2));
  const g4 = st();
  check(`a waiver edited after the compare → not verified, saying the waivers changed (got ${g4.status})`,
    g4.status === "unverified" && /waivers changed since the last compare — re-run --compare/.test(g4.reasons.join(" ")));
  withReport("fail", { plan: `design/plan/${JR}.json`, sha256: waiversHash(accepted) });
  const g5 = st();
  check(`a failing report stays failed after the owner accepts something, and says to re-compare (got ${g5.status})`,
    g5.status === "failed" && /waivers changed since the last compare/.test(g5.reasons.join(" ")));
  // the plan now maps a shared shell the report never hashed (a report written before the shell was
  // mapped) → unverified, the shell labelled "(not recorded)": one re-compare records it
  const shellPlan = readFixture(planFile, isPlan);
  withReport("pass", { plan: `design/plan/${JR}.json`, sha256: waiversHash(shellPlan) });
  fs.writeFileSync(path.join(root, "app/src/layout/Shell.tsx"), "export const Shell = () => null;\n");
  shellPlan.anchors = { ...shellPlan.anchors, "7314:87192": { mapModule: "app/src/layout/Shell.tsx#Shell" } };
  fs.writeFileSync(planFile, JSON.stringify(shellPlan, null, 2));
  hook();
  const g6 = st();
  check(`a mapped shell the report did not hash → unverified "measured different code — changed since: app/src/layout/Shell.tsx (not recorded)" (got ${g6.status}: ${g6.reasons.join(" | ").slice(0, 200)})`,
    g6.status === "unverified" && /measured different code — changed since: app\/src\/layout\/Shell\.tsx \(not recorded\)/.test(g6.reasons.join(" ")));
}
check("a plan claiming \"pass-with-deviations\" beside that report is no contradiction (/pass/i also matched the new verdict)",
  verificationContradictions({ verification: { verifyScreenVerdict: "pass-with-deviations" } }, [reportRef({ rel: "design/verify/x.report.json", verdict: "pass-with-deviations" })]).length === 0
  && verificationContradictions({ verification: { verifyScreenVerdict: "pass" } }, [reportRef({ rel: "design/verify/x.report.json", verdict: "incomplete" })]).length === 1);
check("[deviations] a plan summarising a pass-with-deviations report as a plain \"pass\" gets a warning to say the deviations",
  verificationContradictions({ verification: { verifyScreenVerdict: "pass" } }, [reportRef({ rel: "design/verify/x.report.json", verdict: "pass-with-deviations" })]).some((w) => /say the accepted deviations/.test(w)));
check("[deviations] a hand-stored \"verified-with-deviations\" is ignored and noted like a stored \"verified\"", (() => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "design-to-code", "verify-build.ts"), "utf8");
  return /COMPUTED_STORED = new Set<string>\(\[[^\]]*"verified-with-deviations"/.test(src);
})());
check("the block message names the file that USES the literal, not the allow-listed token file", (() => {
  const b = blocks({ "app/src/theme/theme.css": ".x { background: #5B5FC7 }", "app/src/Screen.tsx": "<div style={{ color: '#5B5FC7' }} />" },
    { files: ["app/src/theme/theme.css", "app/src/Screen.tsx"], tokens: [brand], allowedLiterals: [{ file: "app/src/theme/theme.css", reason: "generated token source" }], verification: STATIC });
  const bMsg = must(b[0], "b[0]");
  return b.length === 1 && /in app\/src\/Screen\.tsx, but/.test(bMsg) && !/theme\.css/.test(must(bMsg.split(", but")[0], "bMsg.split(', but')[0]"));
})());
check("…nor a file whose only occurrence is the token's own definition line", (() => {
  const b = blocks({ "theme.css": ":root { --brand-600: #5B5FC7; }", "Card.tsx": "<div style={{ color: '#5B5FC7' }} />" },
    { files: ["theme.css", "Card.tsx"], tokens: [brand], verification: STATIC });
  return b.length === 1 && /in Card\.tsx, but/.test(must(b[0], "b[0]"));
})());

console.log("--status on the untouched live plan: precedence, and a why that is never empty:");
{
  // A recorded state: plan as written (stored "verified", no verification.hook), and the
  // original schema-@1 JetRoles.report.json saying fail.
  const root = liveProject({ [JR]: fxPlan(JR), [GP]: fxPlan(GP) });
  const cli = spawnSync(process.execPath, [HOOK, "--status", `design/plan/${JR}.json`, "--json"], { cwd: root, encoding: "utf8" });
  const row = must(parseAs(cli.stdout, isStatusRows, "--status --json")[0], "status row [0]");
  check(`the untouched Jet Roles plan → pending, with a why naming the ignored stored status, the unrun hook, and the @1 report and its verdict (got ${row.status}; why ${row.why === null ? "null" : "set"})`,
    cli.status === 0 && row.status === "pending" && typeof row.why === "string"
    && /stored "status": "verified" was not confirmed/.test(row.why) && /Stop hook has not checked this plan/.test(row.why)
    && /JetRoles\.report\.json is designtwin\/verify-report@1 \(its verdict: "fail"\)/.test(row.why) && /Regenerate it/.test(row.why)
    && !/never built|31 component/.test(row.why));
  const all = parseAs(spawnSync(process.execPath, [HOOK, "--status", "--json"], { cwd: root, encoding: "utf8" }).stdout, isStatusRows, "--status --json");
  check("every non-verified row of --status --json carries a non-empty why", all.length === 2 && all.every((r) => r.status === "verified" || (typeof r.why === "string" && r.why.length > 0)));
  // precedence 2 over 5: an @2 report that FAILS is reported as failed even though the hook never ran
  const rep = readFixture(path.join(root, "design/verify/JetRoles.report.json"), isVerifyReport);
  fs.writeFileSync(path.join(root, "design/verify/JetRoles.report.json"), JSON.stringify(Object.assign(rep, { schema: "designtwin/verify-report@2", headline: "FAIL — nodes measured 76/186" })));
  const r2 = must(parseAs(spawnSync(process.execPath, [HOOK, "--status", `design/plan/${JR}.json`, "--json"], { cwd: root, encoding: "utf8" }).stdout, isStatusRows, "--status --json")[0], "status row [0]");
  check(`precedence: a failing @2 report is "failed" even before the hook has run, and why still says the hook has not (got ${r2.status})`,
    r2.status === "failed" && /says verdict "fail" \(FAIL — nodes measured 76\/186\)/.test(r2.why ?? "") && /hook: the build-screen Stop hook has not checked/.test(r2.why ?? ""));
  check("--help documents the precedence", /First match wins/.test(spawnSync(process.execPath, [HOOK, "--help"], { encoding: "utf8" }).stdout));
}

console.log("field-test fixes:");
{
  // A second plan in a project() root (project() writes design/plan/login.json).
  const addPlan = (root: string, name: string, plan: Plan) => fs.writeFileSync(path.join(root, "design", "plan", name + ".json"), JSON.stringify(plan));
  const planAt = (root: string, name: string) => readFixture(path.join(root, "design", "plan", name + ".json"), isPlan);
  const BLOCKING: Plan = { status: "pending", files: ["a.tsx"], tokens: [brand], verification: STATIC };

  // build-screen's Stop hook is skill-scoped, so it fires in an orchestrator session too.
  check("a session transcript that names no plan: exit 0, nothing blocked, no plan written", (() => {
    const root = project({ "a.tsx": "#5B5FC7" }, BLOCKING);
    const t = path.join(root, "orchestrator.jsonl");
    fs.writeFileSync(t, JSON.stringify({ role: "assistant", text: "spawned two builders" }));
    const r = runHook(root, { cwd: root, transcript_path: t });
    return r.status === 0 && !planOf(root).verification?.hook && !/BLOCKED|raw colour/.test(r.stderr) && r.stderr.trim().split("\n").length <= 1;
  })());
  check("the screen-builder's SubagentStop still finds its plan through agent_transcript_path (and blocks on it)", (() => {
    const root = project({ "a.tsx": "#5B5FC7" }, BLOCKING);
    const t = path.join(root, "agent.jsonl");
    fs.writeFileSync(t, toolUse("Bash", { command: "node plan-skeleton.js … --out design/plan/login.json" }));
    const r = runHook(root, { cwd: root, agent_id: "b1", agent_transcript_path: t, transcript_path: path.join(root, "orchestrator.jsonl") });
    return r.status === 2 && hookOf(root).result === "blocked";
  })());

  // two tokens that share a hex, each defined in the theme, neither used as a literal.
  const surface: PlanTokenRow = { figmaName: "Surface/Page", value: "#1d1d1f", kind: "color", codeToken: "surface-page", verdict: "exact" };
  const canvas: PlanTokenRow = { figmaName: "Surface/Canvas", value: "#1d1d1f", kind: "color", codeToken: "surface-canvas", verdict: "exact" };
  const twoDefs = (css: string) => split({ "theme.css": css, "Card.tsx": '<div className="bg-surface-page text-surface-canvas" />' },
    { files: ["theme.css", "Card.tsx"], tokens: [surface, canvas], verification: STATIC });
  const multi = twoDefs("@theme {\n  --color-surface-page: #1d1d1f;\n  --color-surface-canvas: #1d1d1f;\n}");
  const oneLine = twoDefs("@theme { --color-surface-page: #1d1d1f; --color-surface-canvas: #1d1d1f; }");
  check("two tokens with one hex, each on its own definition line, never used raw → no block", multi.blocking.length === 0);
  check("…and the same with both definitions on ONE line", oneLine.blocking.length === 0);
  check("no blocking message ever has an empty file list ('raw colour #… in , but')",
    [...multi.blocking, ...oneLine.blocking].every((m) => !/ in ,? *, but| in , but/.test(m)));
  check("a definition and a raw usage on the same line still blocks (every occurrence must be a definition)",
    has(split({ "theme.css": ".x { --color-surface-page: #1d1d1f; color: #1d1d1f; }" }, { files: ["theme.css"], tokens: [surface, canvas], verification: STATIC }).blocking, /raw colour #1d1d1f in theme\.css, but/));
  check("the shared hex used raw in a component blocks, naming only that file", (() => {
    const b = split({ "theme.css": "@theme {\n  --color-surface-page: #1d1d1f;\n  --color-surface-canvas: #1d1d1f;\n}", "Card.tsx": "<div style={{ color: '#1d1d1f' }} />" },
      { files: ["theme.css", "Card.tsx"], tokens: [surface, canvas], verification: STATIC }).blocking;
    return b.length === 1 && /in Card\.tsx, but/.test(must(b[0], "b[0]"));
  })());

  // a merge a person decided on is acknowledged once, in the plan.
  const row = (figmaName: string, codeToken: string, extra?: Partial<PlanTokenRow>): PlanTokenRow => ({ figmaName, value: "14", kind: "fontSize", codeToken, verdict: "exact", ...extra });
  check("an `acknowledged` reason on the sharing row silences the merged-token warning",
    !has(problems({ "a.tsx": "" }, { files: ["a.tsx"], verification: STATIC, tokens: [row("Body/Small", "text-sm"), row("Size/Small", "text-sm", { acknowledged: "one type scale step; both names are the same size in every mode" })] }), /DIFFERENT Figma tokens/));
  check("…an empty `acknowledged` does not, and says so", (() => {
    const pr = problems({ "a.tsx": "" }, { files: ["a.tsx"], verification: STATIC, tokens: [row("Body/Small", "text-sm"), row("Size/Small", "text-sm", { acknowledged: " " })] });
    return has(pr, /DIFFERENT Figma tokens/) && has(pr, /empty `acknowledged`/);
  })());
  // a component rendered through a shared shell that another plan lists.
  const reusedBar = { name: "TopBar", nodeId: "1:5", mapModule: "src/components/TopBar.tsx", verdict: "reused" };
  const shellProject = (shellImports: boolean) => {
    const root = project({ "src/screens/ScreenA.tsx": "import { Shell } from '../layout/Shell';", "src/layout/Shell.tsx": shellImports ? "import { TopBar } from '@/components/TopBar';" : "export const Shell = () => null;", "src/components/TopBar.tsx": "" },
      { files: ["src/screens/ScreenA.tsx"], components: [reusedBar], verification: STATIC });
    addPlan(root, "screen-b", { files: ["src/layout/Shell.tsx", "src/components/TopBar.tsx"], verification: STATIC });
    return checkPlan({ plan: planOf(root), file: path.join(root, "design", "plan", "login.json") }, root).warnings;
  };
  check("a reused module imported by a file of ANOTHER plan (a shared shell) is not 'never imported'", !has(shellProject(true), /imports that module/));
  check("…while one no plan's files import is still reported", has(shellProject(false), /'TopBar' is "reused".*no file in files\[\] imports that module/));

  // a deviation that says a node was left out, while the plan says it was reused.
  check("a deviation marking a node omitted while components[] says it was reused warns", has(problems({ "a.tsx": "import { Icon } from '@/ui/Icon';" }, { files: ["a.tsx"], verification: STATIC,
    components: [{ name: "Icon", nodeId: "2:7", mapModule: "@/ui/Icon", verdict: "reused" }],
    deviations: [{ nodeId: "2:7", designed: "group icon", built: "omitted", reason: "icons in the group header were left out" }] }),
  /deviation #0 says node 2:7 was not built, but components\[\] marks 'Icon' "reused"/));
  check("…and so does one whose anchor still maps the node to a module", has(problems({ "a.tsx": "" }, { files: ["a.tsx"], verification: STATIC,
    anchors: { "2:8": { mapModule: "src/Card.tsx" } }, deviations: [{ nodeId: "2:8", designed: "badge", built: null, reason: "no data for it" }] }), /node 2:8 was not built, but anchors\["2:8"\] maps it to src\/Card\.tsx/));
  check("a named non-style field (\"leading icon\") built \"omitted\" on a reused node warns", has(problems({ "a.tsx": "import { Icon } from '@/ui/Icon';" }, { files: ["a.tsx"], verification: STATIC,
    components: [{ name: "Icon", nodeId: "2:7", mapModule: "@/ui/Icon", verdict: "reused" }],
    deviations: [{ nodeId: "2:7", field: "leading icon", designed: "icon", built: "omitted", reason: "no asset" }] }), /node 2:7 was not built/));
  check("built \"omitted (no asset)\" on an anchored node warns", has(problems({ "a.tsx": "" }, { files: ["a.tsx"], verification: STATIC,
    anchors: { "2:8": { mapModule: "src/Card.tsx" } }, deviations: [{ nodeId: "2:8", field: "badge", designed: "badge", built: "omitted (no asset)", reason: "the export has no badge image" }] }), /node 2:8 was not built/));
  check("an ordinary value deviation on a reused node does not", !has(problems({ "a.tsx": "import { Icon } from '@/ui/Icon';" }, { files: ["a.tsx"], verification: STATIC,
    components: [{ name: "Icon", nodeId: "2:7", mapModule: "@/ui/Icon", verdict: "reused" }],
    deviations: [{ nodeId: "2:7", field: "x", designed: 10, built: 12, reason: "aligned to the grid" }] }), /was not built/));

  // web builds must carry data-dt-node tags.
  const anchors4 = { "3:1": { mapModule: "src/ScreenA.tsx" }, "3:2": { mapModule: "src/ScreenA.tsx" }, "3:3": { mapModule: "src/ScreenA.tsx" }, "3:4": { mapModule: "src/ScreenA.tsx" }, "3:5": { omitted: "decorative" } };
  const web = (src: string, extra?: Partial<Plan>, files?: Record<string, string>) => split({ "src/ScreenA.tsx": src, ...files }, { target: "web-tailwind", files: ["src/ScreenA.tsx"], anchors: anchors4, verification: STATIC, ...extra });
  check("a web plan whose files carry no data-dt-node at all BLOCKS, with the figure", has(web("<div>// 3:1</div>").blocking, /no data-dt-node tags.*0 of 4 anchored visible node/));
  check("one tag of four: a WARNING with the coverage figure, not a block", (() => {
    const r = web('<div data-dt-node="3:1" />');
    return r.blocking.length === 0 && has(r.warnings, /tag coverage is 1\/4 anchored visible node\(s\) \(25%\), below 50%/);
  })());
  check("ids from a lookup table count as tags (data-dt-node={IDS.x})", (() => {
    const r = web('const IDS = { a: "3:1", b: "3:2", c: "3:3" };\n<div data-dt-node={IDS.a} />');
    return r.blocking.length === 0 && !has(r.warnings, /tag coverage/) && r.tagCoverage?.tagged === 3 && r.tagCoverage.anchored === 4;
  })());
  check("tags in a shared shell listed by ANOTHER plan count", (() => {
    const root = project({ "src/ScreenA.tsx": "<main />", "src/Shell.tsx": '<nav data-dt-node="3:1" /><header data-dt-node="3:2" /><aside data-dt-node="3:3" />' },
      { target: { profile: "web-tailwind" }, files: ["src/ScreenA.tsx"], anchors: anchors4, verification: STATIC });
    addPlan(root, "screen-b", { files: ["src/Shell.tsx"], verification: STATIC });
    const r = checkPlan({ plan: planOf(root), file: path.join(root, "design", "plan", "login.json") }, root);
    return r.blocking.length === 0 && r.tagCoverage?.tagged === 3;
  })());
  check("the profile falls back to design/target.json when the plan's target is null", has(web("<div />", { target: null }, { "design/target.json": '{"profile":"web-tailwind"}' }).blocking, /no data-dt-node tags/));
  check("a non-web profile is not checked", web("<div />", { target: "swiftui" }).blocking.length === 0 && web("<div />", { target: null }).blocking.length === 0);
  check("the opt-out with a reason skips the check", (() => { const r = web("<div />", { tagging: { off: true, reason: "the host app strips unknown attributes" } }); return r.blocking.length === 0 && !has(r.warnings, /tagging/); })());
  check("…without a reason it is ignored, and says so", (() => { const r = web("<div />", { tagging: { off: true } }); return has(r.blocking, /no data-dt-node tags/) && has(r.warnings, /`tagging\.off` is set with no `reason`/); })());
  check("the hook records tagCoverage {tagged, anchored} (numbers only) in verification.hook", (() => {
    const root = project({ "src/ScreenA.tsx": '<div data-dt-node="3:1" /><div data-dt-node="3:2" />' }, { status: "pending", target: "web-tailwind", files: ["src/ScreenA.tsx"], anchors: anchors4, verification: STATIC });
    const r = runHook(root);
    const tc = hookOf(root).tagCoverage;
    return r.status === 0 && tc !== undefined && tc.tagged === 2 && tc.anchored === 4 && Object.keys(tc).length === 2;
  })());

  // a colour code token nothing declares.
  const colourRows: PlanTokenRow[] = [
    { figmaName: "Surface/Base", value: "#111111", kind: "color", codeToken: "bg-surface-base", verdict: "exact" },
    { figmaName: "Surface/On Base", value: "#222222", kind: "color", codeToken: "text-on-surface-base", verdict: "exact" },
  ];
  const tok = (css: Record<string, string>) => problems({ "src/A.tsx": '<p className="bg-surface-base text-on-surface-base" />', ...css }, { files: ["src/A.tsx"], tokens: colourRows, verification: STATIC });
  check("a colour codeToken declared nowhere (the theme has only its sibling) warns, naming it",
    has(tok({ "src/theme.css": "@theme {\n  --color-surface-base: #111111;\n  --Surface-On-Base: #222222;\n}" }), /1 colour code token\(s\) are declared nowhere.*'text-on-surface-base'/));
  check("…not when a project .css (not in files[]) declares both", !has(tok({ "src/theme.css": "@theme {\n  --color-surface-base: #111111;\n  --color-on-surface-base: #222222;\n}" }), /declared nowhere/));
  check("a declaration under node_modules/ or design/ does not count", has(tok({ "src/theme.css": "@theme { --color-surface-base: #111111; }", "node_modules/x/a.css": ":root { --color-on-surface-base: #222222; }", "design/notes.css": ":root { --color-on-surface-base: #222222; }" }), /declared nowhere.*'text-on-surface-base'/));

  check("an orchestrator whose only mentions are an Agent prompt and a subagent's report: nothing checked", (() => {
    const root = project({ "a.tsx": "#5B5FC7" }, BLOCKING);
    const t = path.join(root, "orchestrator.jsonl");
    fs.writeFileSync(t, [toolUse("Agent", { subagent_type: "screen-builder", prompt: "Build Screen A; its plan is design/plan/login.json" }),
      toolResult("done — wrote design/plan/login.json"), JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "design/plan/login.json is next" }] } }),
      toolUse("Write", { file_path: "design/plan/login.json" }, true)].join("\n"));
    const r = runHook(root, { cwd: root, transcript_path: t });
    return r.status === 0 && !planOf(root).verification?.hook;
  })());
  check("a builder transcript with a Write to the plan: checked", (() => {
    const root = project({ "a.tsx": "#5B5FC7" }, BLOCKING);
    const t = path.join(root, "builder.jsonl");
    fs.writeFileSync(t, toolUse("Write", { file_path: path.join(root, "design", "plan", "login.json"), content: "{}" }));
    return runHook(root, { cwd: root, transcript_path: t }).status === 2 && hookOf(root).result === "blocked";
  })());
  check("a plain CSS property is never a token definition: `border-color: #e5e5e5` with tokens input/border BLOCKS", (() => {
    const tk = (codeToken: string): PlanTokenRow => ({ figmaName: "Line/" + codeToken, value: "#e5e5e5", kind: "color", codeToken, verdict: "exact" });
    return has(split({ "a.css": ".card { border-color: #e5e5e5; }" }, { files: ["a.css"], tokens: [tk("input"), tk("border")], verification: STATIC }).blocking, /raw colour #e5e5e5 in a\.css, but/);
  })());
  check("a module only a SIBLING screen imports (not through this plan's files) is still 'never imported'", (() => {
    const root = project({ "src/A.tsx": "export const A = () => null;", "src/B.tsx": "import { TopBar } from './TopBar';", "src/TopBar.tsx": "" },
      { files: ["src/A.tsx"], components: [{ name: "TopBar", nodeId: "1:5", mapModule: "src/TopBar.tsx", verdict: "reused" }], verification: STATIC });
    addPlan(root, "screen-b", { files: ["src/B.tsx"], verification: STATIC });
    return has(checkPlan({ plan: planOf(root), file: path.join(root, "design", "plan", "login.json") }, root).warnings, /'TopBar' is "reused".*no file in files\[\] imports that module/);
  })());
  // the shell is rendered by an ANCESTOR of this plan's files (Main → routes → this page; Main → Shell → SideNav).
  const ancestorProject = (cycle: boolean) => {
    const root = project({
      "src/Main.tsx": "import { Shell } from './layout/Shell';\nimport { routes } from './routes';",
      "src/routes.tsx": "import { PageA } from './pages/PageA';" + (cycle ? "\nimport { Main } from './Main';" : ""),
      "src/pages/PageA.tsx": cycle ? "import { routes } from '../routes';" : "export const PageA = () => null;",
      "src/layout/Shell.tsx": "import { SideNav } from './SideNav';",
      "src/layout/SideNav.tsx": "",
    }, { files: ["src/routes.tsx", "src/pages/PageA.tsx"], components: [{ name: "SideNav", nodeId: "1:6", mapModule: "src/layout/SideNav.tsx", verdict: "reused" }], verification: STATIC });
    // the shell is shared: listed by more than one plan (a file listed by exactly one OTHER plan is that screen's own)
    addPlan(root, "app-shell", { files: ["src/Main.tsx", "src/layout/Shell.tsx", "src/layout/SideNav.tsx"], verification: STATIC });
    addPlan(root, "screen-c", { files: ["src/layout/Shell.tsx"], verification: STATIC });
    return checkPlan({ plan: planOf(root), file: path.join(root, "design", "plan", "login.json") }, root).warnings;
  };
  check("a module a file RENDERING this plan's files imports through one shell file (Main → Shell → SideNav) is not 'never imported'", !has(ancestorProject(false), /imports that module/));
  check("…and an import cycle in the graph neither hangs nor changes that", !has(ancestorProject(true), /imports that module/));
  check("a sibling screen reached through a common parent (App → Page → {ScreenA, ScreenB}) does not lend plan A ScreenB's imports", (() => {
    const root = project({ "src/App.tsx": "import { Page } from './Page';", "src/Page.tsx": "import { ScreenA } from './ScreenA';\nimport { ScreenB } from './ScreenB';",
      "src/ScreenA.tsx": "export const ScreenA = () => null;", "src/ScreenB.tsx": "import { Widget } from './Widget';", "src/Widget.tsx": "" },
    { files: ["src/ScreenA.tsx"], components: [{ name: "Widget", nodeId: "1:7", mapModule: "src/Widget.tsx", verdict: "reused" }], verification: STATIC });
    addPlan(root, "screen-b", { files: ["src/ScreenB.tsx", "src/Page.tsx", "src/App.tsx"], verification: STATIC });
    return has(checkPlan({ plan: planOf(root), file: path.join(root, "design", "plan", "login.json") }, root).warnings, /'Widget' is "reused".*no file in files\[\] imports that module/);
  })());
  check("a FIELD-level deviation on a reused node (a shadow not built) is not a whole-node omission", !has(problems({ "a.tsx": "import { Card } from '@/ui/Card';" }, { files: ["a.tsx"], verification: STATIC,
    components: [{ name: "Card", nodeId: "2:9", mapModule: "@/ui/Card", verdict: "reused" }],
    deviations: [{ nodeId: "2:9", field: "effects", designed: "drop shadow", built: "none", reason: "shadow dropped: the host theme has no elevation token" }] }), /was not built/));
  {
    const c = (codeToken: string): PlanTokenRow => ({ figmaName: "Brand/" + codeToken, value: "#123456", kind: "color", codeToken, verdict: "exact" });
    const f124 = (codeToken: string) => problems({ "src/A.tsx": "<p />", "src/theme.css": "@theme { --color-primary: #123456; }" }, { files: ["src/A.tsx"], tokens: [c(codeToken)], verification: STATIC });
    check("free-text / modifier / built-in tokens are quiet: 'bg-primary / text-primary', 'text-primary/80', 'bg-white', 'text-gray-500'",
      ["bg-primary / text-primary", "text-primary/80", "hover:bg-primary", "bg-white", "text-gray-500"].every((t) => !has(f124(t), /declared nowhere/)));
    check("'bg-brand' with no --color-brand anywhere warns", has(f124("bg-brand"), /declared nowhere.*'bg-brand' \(needs --color-brand\)/));
  }
  check("no data-dt-node anywhere: the recorded tagged count is 0, even if ids appear in other attributes", (() => {
    const r = web('<div id="3:1" data-testid="3:2" />');
    return has(r.blocking, /no data-dt-node tags/) && r.tagCoverage?.tagged === 0 && r.tagCoverage.anchored === 4;
  })());
  check("a web plan with no files[] gets the 'files is empty' warning, not a tag block", (() => {
    const r = split({}, { target: "web-tailwind", anchors: anchors4, verification: STATIC });
    return r.blocking.length === 0 && has(r.warnings, /`files` is empty/);
  })());

  check("a definition matches free-text codeTokens: 'bg-primary / text-primary', 'text-info/80', 'hover:bg-primary-darker' → no block", (() => {
    const c = (codeToken: string, value: string): PlanTokenRow => ({ figmaName: "Brand/" + codeToken, value, kind: "color", codeToken, verdict: "exact" });
    return split({ "theme.css": "@theme {\n  --color-primary: #2255aa;\n  --color-info: #3377cc;\n  --color-primary-darker: #113366;\n}", "Card.tsx": '<p className="bg-primary text-info/80 hover:bg-primary-darker" />' },
      { files: ["theme.css", "Card.tsx"], tokens: [c("bg-primary / text-primary", "#2255aa"), c("text-info/80", "#3377cc"), c("hover:bg-primary-darker", "#113366")], verification: STATIC }).blocking.length === 0;
  })());
  check("a project with a tailwind.config.* is not checked (Tailwind v3 colours live there)",
    !has(problems({ "src/A.tsx": "<p />", "tailwind.config.js": "module.exports = {}" }, { files: ["src/A.tsx"], tokens: [{ figmaName: "Brand/Main", value: "#123456", kind: "color", codeToken: "bg-brand", verdict: "exact" }], verification: STATIC }), /declared nowhere/));
  {
    const hookWith = (lines: string[], files?: string[]) => {
      const root = project({ "a.tsx": "#5B5FC7", "src/Other.tsx": "" }, { ...BLOCKING, files: files || BLOCKING.files });
      const t = path.join(root, "t.jsonl");
      fs.writeFileSync(t, lines.join("\n"));
      return { r: runHook(root, { cwd: root, transcript_path: t }), root };
    };
    check("a Bash heredoc whose notes mention the plan does not make it this session's", (() => {
      const { r, root } = hookWith([toolUse("Bash", { command: "cat > notes/handoff.md <<'EOF'\nScreen A: design/plan/login.json is still being filled\nEOF" })]);
      return r.status === 0 && !planOf(root).verification?.hook;
    })());
    check("an Edit of a file listed in the plan's files[] makes it this session's", (() => {
      const { r, root } = hookWith([toolUse("Edit", { file_path: "a.tsx", old_string: "x", new_string: "y" })]);
      return r.status === 2 && hookOf(root).result === "blocked";
    })());
    check("a Windows-style path to the plan is matched", (() => {
      const { r } = hookWith([toolUse("Write", { file_path: "C:\\work\\app\\design\\plan\\login.json", content: "{}" })]);
      return r.status === 2;
    })());
    check("a builder that only ran plan-skeleton --out on the plan owns it", (() => {
      const { r } = hookWith([toolUse("Bash", { command: "node \"/opt/plugin/scripts/plan-skeleton.js\" design/export/pages/P/ScreenA__1_2.json --out design/plan/login.json" })]);
      return r.status === 2;
    })());
    check("…while `echo design/plan/login.json` alone does not", hookWith([toolUse("Bash", { command: "echo design/plan/login.json && ls design/plan" })]).r.status === 0);
  }
  {
    // Five open plans; each would BLOCK if checked. login.json alone lists src/OnlyX.tsx; all five list src/Shared.tsx.
    const five = (lines: (root: string) => string[]) => {
      const root = project({ "a.tsx": "#5B5FC7", "src/OnlyX.tsx": "", "src/Shared.tsx": "", "a.json": "{}" }, { ...BLOCKING, files: ["a.tsx", "src/OnlyX.tsx", "src/Shared.tsx"] });
      for (let i = 1; i < 5; i++) addPlan(root, `screen-${i}`, { ...BLOCKING, files: ["a.tsx", "src/Shared.tsx"] });
      fs.writeFileSync(path.join(root, "design", "plan", "login.json"), JSON.stringify({ ...BLOCKING, files: ["b.tsx", "src/OnlyX.tsx", "src/Shared.tsx"] }));
      fs.writeFileSync(path.join(root, "b.tsx"), "#5B5FC7");
      const t = path.join(root, "t.jsonl");
      fs.writeFileSync(t, lines(root).join("\n"));
      const r = runHook(root, { cwd: root, transcript_path: t });
      const checked = ["login", "screen-1", "screen-2", "screen-3", "screen-4"].filter((n) => !!planAt(root, n).verification?.hook);
      return { status: r.status, checked };
    };
    const onlyLogin = (x: { status: number | null; checked: string[] }) => x.status === 2 && x.checked.join() === "login";
    check("an Edit of a file five plans share claims none of them: nothing checked", (() => {
      const x = five(() => [toolUse("Edit", { file_path: "src/Shared.tsx", old_string: "a", new_string: "b" })]);
      return x.status === 0 && x.checked.length === 0;
    })());
    check("an Edit of a file only one plan lists claims that plan alone", onlyLogin(five(() => [toolUse("Edit", { file_path: "src/OnlyX.tsx", old_string: "a", new_string: "b" })])));
    check("`jq … > /tmp/t && mv /tmp/t design/plan/<x>.json` claims the plan", onlyLogin(five(() => [toolUse("Bash", { command: "jq '.route = \"/a\"' design/plan/login.json > /tmp/t && mv /tmp/t design/plan/login.json" })])));
    check("`cp a design/plan/<x>.json` claims the plan", onlyLogin(five(() => [toolUse("Bash", { command: "cp a.json design/plan/login.json" })])));
    check("`sed -i '' 's/a/b/' design/plan/<x>.json` claims the plan", onlyLogin(five(() => [toolUse("Bash", { command: "sed -i '' 's/a/b/' design/plan/login.json" })])));
    check("`python3 -c \"open('design/plan/<x>.json','w')\"` claims the plan", onlyLogin(five(() => [toolUse("Bash", { command: "python3 -c \"import json; json.dump({}, open('design/plan/login.json','w'))\"" })])));
    check("a Bash heredoc written to a file only plan X lists (`cat > src/OnlyX.tsx <<E`) claims X", onlyLogin(five(() => [toolUse("Bash", { command: "cat > src/OnlyX.tsx <<E\nexport const X = 1;\nE" })])));
    check("a relative path resolves against the transcript entry's own cwd", onlyLogin(five((root) => [JSON.stringify({ type: "assistant", cwd: path.join(root, "design"), message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Write", input: { file_path: "plan/login.json", content: "{}" } }] } })])));
  }
  check("the not-imported warning tells the builder to list a shared layout above the screen", has(shellProject(false), /list that layout file in this plan's files\[\] too/));
  {
    const c = (codeToken: string): PlanTokenRow => ({ figmaName: "Brand/" + codeToken, value: "#123456", kind: "color", codeToken, verdict: "exact" });
    const f124 = (codeToken: string, css: string) => problems({ "src/A.tsx": "<p />", "src/theme.css": css }, { files: ["src/A.tsx"], tokens: [c(codeToken)], verification: STATIC });
    check("[tokens] Tailwind v4 `bg-(--brand)` needs --brand; `var(--x, #fff)` needs --x; a trailing `!` is stripped",
      !has(f124("bg-(--brand)", ":root { --brand: #123456; }"), /declared nowhere/) && has(f124("bg-(--brand)", ":root { --color-brand: #123456; }"), /needs --brand\)/)
      && !has(f124("var(--line, #fff)", ":root { --line: #123456; }"), /declared nowhere/) && !has(f124("bg-primary!", "@theme { --color-primary: #123456; }"), /declared nowhere/));
    check("a tailwind.config.mts at a listed file's package root turns the check off",
      !has(problems({ "app/src/A.tsx": "<p />", "app/package.json": "{}", "app/tailwind.config.mts": "export default {}" }, { files: ["app/src/A.tsx"], tokens: [c("bg-brand")], verification: STATIC }), /declared nowhere/));
  }
  check("a style field is read by its LAST segment (`style.shadow`, `fontSize`) — quiet", !has(problems({ "a.tsx": "import { Card } from '@/ui/Card';" }, { files: ["a.tsx"], verification: STATIC,
    components: [{ name: "Card", nodeId: "2:9", mapModule: "@/ui/Card", verdict: "reused" }],
    deviations: [{ nodeId: "2:9", field: "style.shadow", designed: "shadow", built: "omitted", reason: "no elevation token" }, { nodeId: "2:9", field: "fontSize", designed: 13, built: null, reason: "inherits the body size" }] }), /was not built/));
  check("[perf] 1000 files / 40 plans: the hook checks every plan in well under the budget", (() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-perf-"));
    fs.mkdirSync(path.join(root, "design", "plan"), { recursive: true });
    const w = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
    w("src/App.tsx", Array.from({ length: 40 }, (_, p) => `import { S${p} } from './screens/s${p}/f0';`).join("\n") + "\nimport { Shell } from './layout/Shell';");
    w("src/layout/Shell.tsx", "import { Nav } from './Nav';"); w("src/layout/Nav.tsx", "");
    const planPaths: string[] = [];
    for (let p = 0; p < 40; p++) {
      const files: string[] = [];
      for (let f = 0; f < 25; f++) {
        const rel = `src/screens/s${p}/f${f}.tsx`;
        w(rel, (f < 24 ? `import { F } from './f${f + 1}';\n` : "") + `import { Shared${f % 5} } from '../../shared/c${(p + f) % 20}';\nexport const S${p} = () => null;`);
        files.push(rel);
      }
      if (p === 0) files.push("src/App.tsx", "src/layout/Shell.tsx", "src/layout/Nav.tsx");
      if (p === 1) files.push("src/layout/Shell.tsx");
      const file = path.join(root, "design", "plan", `s${p}.json`);
      fs.writeFileSync(file, JSON.stringify({ status: "pending", files, verification: STATIC, components: [{ name: "Nav", nodeId: "9:1", mapModule: "src/layout/Nav.tsx", verdict: "reused" }, { name: "Missing", nodeId: "9:2", mapModule: "src/none/Missing.tsx", verdict: "reused" }] }));
      planPaths.push(file);
    }
    for (let c = 0; c < 20; c++) w(`src/shared/c${c}.tsx`, "");
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [HOOK, ...planPaths], { encoding: "utf8", cwd: root });
    const ms = Date.now() - t0;
    console.log(`    (1000+ files / 40 plans: ${ms} ms)`);
    const navWarned = /'Nav' is "reused"/.test(r.stderr), missingWarned = (r.stderr.match(/'Missing' is "reused"/g) || []).length === 1;
    return r.status === 0 && ms < 20000 && !navWarned && missingWarned;
  })());

  // Duplicate warnings: one line per distinct message in a run, naming every plan that has it.
  check("[dedupe] a warning two plans share is printed once, naming both plans", (() => {
    const merged: PlanTokenRow[] = [row("Body/Small", "text-sm"), row("Size/Small", "text-sm")];
    const root = project({ "a.tsx": "" }, { status: "pending", files: ["a.tsx"], tokens: merged, verification: STATIC });
    addPlan(root, "screen-b", { status: "pending", files: ["a.tsx"], tokens: merged, verification: STATIC });
    const r = runHook(root);
    const lines = r.stderr.split("\n").filter((l) => /DIFFERENT Figma tokens/.test(l));
    return r.status === 0 && lines.length === 1 && /login\.json/.test(must(lines[0], "lines[0]")) && /screen-b\.json/.test(must(lines[0], "lines[0]")) && planAt(root, "screen-b").verification?.hook?.result === "pass";
  })());
}

console.log("map-bootstrap --out (the build-screen gate's remedy must actually create the file):");
const BOOT = path.join(import.meta.dirname, "..", "design-to-code", "map-bootstrap.ts");
const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-boot-"));
const catalogFile = path.join(bootDir, "components.local.json");
const mapFile = path.join(bootDir, "codeconnect.local.json");
fs.writeFileSync(catalogFile, JSON.stringify({ components: [{ type: "COMPONENT", key: "k-btn", id: "1:2", name: "Button", props: {} }] }));
check("--out writes the map file and keeps stdout clean", (() => {
  const r = spawnSync(process.execPath, [BOOT, catalogFile, "--out", mapFile], { encoding: "utf8" });
  return r.status === 0 && r.stdout === "" && /wrote/.test(r.stderr) && must(readFixture(mapFile, isCodeConnectMap).components["k-btn"], "map.components['k-btn']").status === "needs-review";
})());
check("re-running --out MERGES into the existing map — hand edits survive", (() => {
  const map = readFixture(mapFile, isCodeConnectMap);
  const entry = must(map.components["k-btn"], "map.components['k-btn']");
  entry.code.module = "@/ui/Button";
  entry.status = "active"; // a hand edit: a real MapStatus, not the bootstrap default
  fs.writeFileSync(mapFile, JSON.stringify(map));
  const r = spawnSync(process.execPath, [BOOT, catalogFile, "--out", mapFile], { encoding: "utf8" });
  const after = must(readFixture(mapFile, isCodeConnectMap).components["k-btn"], "map.components['k-btn']");
  return r.status === 0 && after.code.module === "@/ui/Button" && after.status === "active" && /merged/.test(r.stderr);
})());
check("without --out it still prints to stdout (back-compat)", (() => {
  const r = spawnSync(process.execPath, [BOOT, catalogFile], { encoding: "utf8" });
  return r.status === 0 && parseAs(r.stdout, isCodeConnectMap, "map-bootstrap stdout").components["k-btn"] !== undefined;
})());
check("an unknown option is refused, not swallowed as a file path", spawnSync(process.execPath, [BOOT, catalogFile, "--output", mapFile], { encoding: "utf8" }).status === 1);

// ---------------------------------------------------------------- report.behaviour → hook WARNINGS, never a block
console.log("behaviour/a11y in the Stop hook (warnings only):");
{
  // looked up by name: a verify-build without it fails these checks cleanly instead of failing to import
  const vb: Record<string, unknown> = { ...verifyBuild };
  const bw = (plan: Plan, refs: ReportRef[], ctx: { cwd?: string; planFile?: string } = {}): string[] | null => (typeof vb.behaviourWarnings === "function" ? verifyBuild.behaviourWarnings(plan, refs, ctx) : null);
  const beh = (fail: number, failed: string[], ran = true, why: string | null = null): ReportRef["behaviour"] => ({ ran, why, fail, warn: 1, failed });
  const R = "design/verify/login.report.json";
  const twoFail = [reportRef({ rel: R, behaviour: beh(2, ["dialog.focus-return", "keyboard.reachable"]) })];
  const w1 = bw({ verification: { mode: "rendered" } }, twoFail);
  check("[15] fail 2 → a warning naming the report, the count and the ids, 'never waived'", !!w1 && w1.some((w) => w.startsWith(`${R}: behaviour/a11y — 2 failures (dialog.focus-return, keyboard.reachable)`) && /never waived: fix it or raise a designer question/.test(w)));
  const w2 = bw({ verification: { mode: "rendered", a11y: { tool: "verify-probe+axe-core 4.13.0", violations: 0 } } }, twoFail);
  check("[15] plan.verification.a11y.violations 0 vs report fail 2 → 'records 0 violations … has 2 failures — copy report.behaviour.summary'", !!w2 && w2.some((w) => /^verification\.a11y records 0 violations but design\/verify\/login\.report\.json behaviour has 2 failures — copy report\.behaviour\.summary$/.test(w)));
  const w3 = bw({ verification: { mode: "rendered", a11y: { tool: "verify-probe", violations: 2 } } }, twoFail);
  check("[15] …equal (2 and 2) → no disagreement (the fail warning stays)", !!w3 && !w3.some((w) => /verification\.a11y records/.test(w)) && w3.some((w) => /2 failures \(/.test(w)));
  const w4 = bw({ verification: { mode: "rendered", a11y: { violations: 0 } } }, [reportRef({ rel: R, behaviour: beh(0, []) })]);
  check("[15] fail 0 and a11y 0 → nothing", !!w4 && w4.length === 0);
  const w5 = bw({ verification: { mode: "rendered" } }, [reportRef({ rel: R, behaviour: beh(0, [], false, "--behaviour off") })]); // (shippedProbe false: still warns)
  check("[15] ran:false '--behaviour off' → 'not run (--behaviour off)' warning", !!w5 && w5.some((w) => w.startsWith(`${R}: behaviour/a11y checks were not run (--behaviour off)`)));
  const w6 = bw({ verification: { mode: "rendered", a11y: { violations: 0 } } }, [reportRef({ rel: R, shippedProbe: true, behaviour: beh(0, [], false, "the measured file carries no behaviour checks (hand-written, or a probe that predates the behaviour checks)") })]);
  check("[15] ran:false (no block) → 'did not run (why)'; no a11y disagreement on a run that did not happen", !!w6 && w6.length === 1 && /did not run \(the measured file carries no behaviour checks/.test(w6[0] ?? ""));
  const w7 = bw({ verification: { mode: "rendered", a11y: { violations: 3 } } }, [reportRef({ rel: R })]);
  check("[15] a report with no behaviour section (predates the behaviour checks) → no behaviour warning", !!w7 && w7.length === 0);
  // the plan's ONE a11y number is compared with the ONE report it came from, never with every matching report
  const own = reportRef({ rel: "design/verify/Crates.report.json", matchedBy: "name", mtimeMs: 2, shippedProbe: true, behaviour: beh(1, ["a11y.name"]) });
  const older = reportRef({ rel: "design/verify/80_1.report.json", matchedBy: "nodeId", mtimeMs: 1, shippedProbe: true, behaviour: beh(3, ["a11y.name"]) });
  const dis = (ws: string[] | null): string[] => (ws || []).filter((w) => /^verification\.a11y records/.test(w));
  const l6a = bw({ verification: { mode: "rendered", a11y: { violations: 1 } } }, [older, own]);
  check("two matching reports (fail 3 by nodeId, fail 1 by name, newer), a11y.violations 1 → no disagreement (the plan's own report agrees)", !!l6a && dis(l6a).length === 0);
  const l6b = bw({ verification: { mode: "rendered", a11y: { violations: 3, report: "design/verify/80_1.report.json" } } }, [own, older]);
  check("a11y.report names the other report (fail 3), violations 3 → no disagreement with the one it does not name", !!l6b && dis(l6b).length === 0);
  const l6c = bw({ verification: { mode: "rendered", a11y: { violations: 3 } } }, [own, older]);
  check("no a11y.report, violations 3 → ONE disagreement, against the plan's own (name-matched, newest) report", !!l6c && dis(l6c).length === 1 && /Crates\.report\.json behaviour has 1 fail/.test(dis(l6c)[0] ?? ""));
  const l6d = bw({ verification: { mode: "rendered", a11y: { violations: 1, report: "./design/verify/Crates.report.md" } } }, [own, older]);
  check("a11y.report naming the .md (with ./) resolves to its report.json", !!l6d && dis(l6d).length === 0 && !l6d.some((w) => /not a verify report found/.test(w)));
  const l6e = bw({ verification: { mode: "rendered", a11y: { violations: 1, report: "design/verify/Gone.report.json" } } }, [own, older]);
  // a11y.report spelled as a bare name, an absolute path, or relative to the plan file still finds its report
  const CTX = { cwd: path.join(os.tmpdir(), "seed-shelf"), planFile: path.join(os.tmpdir(), "seed-shelf", "design", "plan", "login.json") };
  const NF = /not a verify report found/;
  const spell = (report: string, violations: number) => bw({ verification: { mode: "rendered", a11y: { violations, report } } }, [own, older], CTX) ?? [];
  for (const [how, name] of [["a bare file name", "80_1.report.json"], ["an absolute path", path.join(CTX.cwd, "design", "verify", "80_1.report.json")], ["a path relative to the plan file", "../verify/80_1.report.md"]] as const) {
    const agree = spell(name, 3), differ = spell(name, 1);
    check(`a11y.report as ${how} → resolves to 80_1 (agrees: no warning; differs: the disagreement against 80_1, never 'not found')`,
      dis(agree).length === 0 && !agree.some((w) => NF.test(w)) && dis(differ).length === 1 && /80_1\.report\.json behaviour has 3 fail/.test(dis(differ)[0] ?? "") && !differ.some((w) => NF.test(w)));
  }
  check("a bare name matching two reports' basename (other dirs) → the own-screen rule among them, never 'not found'", (() => {
    const a = reportRef({ rel: "design/verify/x/Crates.report.json", matchedBy: "name", mtimeMs: 5, shippedProbe: true, behaviour: beh(2, ["a11y.name"]) });
    const b2 = reportRef({ rel: "design/verify/y/Crates.report.json", matchedBy: "nodeId", mtimeMs: 9, shippedProbe: true, behaviour: beh(4, ["a11y.name"]) });
    const w = bw({ verification: { mode: "rendered", a11y: { violations: 9, report: "Crates.report.json" } } }, [a, b2], CTX) ?? [];
    return dis(w).length === 1 && /x\/Crates\.report\.json behaviour has 2 fail/.test(dis(w)[0] ?? "") && !w.some((m) => NF.test(m));
  })());
  check("two reports share a basename: an absolute path and a plan-relative path pick the one they name (not the basename fallback's)", (() => {
    const x = reportRef({ rel: "design/verify/x/Crates.report.json", matchedBy: "name", mtimeMs: 5, shippedProbe: true, behaviour: beh(2, ["a11y.name"]) });
    const y = reportRef({ rel: "design/verify/y/Crates.report.json", matchedBy: "nodeId", mtimeMs: 9, shippedProbe: true, behaviour: beh(4, ["a11y.name"]) });
    const at = (report: string) => bw({ verification: { mode: "rendered", a11y: { violations: 4, report } } }, [x, y], CTX) ?? [];
    const abs = at(path.join(CTX.cwd, "design", "verify", "y", "Crates.report.json")), rel = at("../verify/y/Crates.report.json");
    const absNoPlan = bw({ verification: { mode: "rendered", a11y: { violations: 4, report: path.join(CTX.cwd, "design", "verify", "y", "Crates.report.json") } } }, [x, y], { cwd: CTX.cwd }) ?? [];
    return dis(abs).length === 0 && dis(rel).length === 0 && dis(absNoPlan).length === 0 && !abs.some((m) => NF.test(m)) && !rel.some((m) => NF.test(m));
  })());
  check("a11y.report naming no located report → says so, compares with none", !!l6e && dis(l6e).length === 0 && l6e.some((w) => /a11y\.report names design\/verify\/Gone\.report\.json, which is not a verify report found/.test(w)));
  check("[15] the a11y-missing warning says to copy report.behaviour.summary", verifyBuild.verificationWarnings({ verification: { mode: "rendered" } }).some((w) => /a11y is missing — copy report\.behaviour\.summary/.test(w)));
  // ONE behaviour warning for the run — the plan's own newest report (or the one a11y.report names) — with its
  // count's singular/plural. design/verify/ is flat (locateReports reads only it), so a re-run with the same --out
  // overwrites its report and every other matched file is another --out: each warns on its own failures, never "not run"
  const own1 = reportRef({ rel: "design/verify/Crates.report.json", matchedBy: "name", mtimeMs: 2, shippedProbe: true, behaviour: beh(1, ["a11y.name"]) });
  const earlier3 = reportRef({ rel: "design/verify/Crates-r1.report.json", matchedBy: "nodeId", mtimeMs: 1, shippedProbe: true, behaviour: beh(3, ["a11y.name", "keyboard.reachable"]) });
  const offOld = reportRef({ rel: "design/verify/Crates-r0.report.json", matchedBy: "nodeId", mtimeMs: 0, shippedProbe: true, behaviour: beh(0, [], false, "--behaviour off") });
  const l5 = bw({ verification: { mode: "rendered" } }, [offOld, own1]) ?? [];
  check("the own report (1 failure) + an earlier --out's report run with --behaviour off → ONE warning: the own report's '1 failure (a11y.name)', no 'not run' for the other file",
    l5.length === 1 && (l5[0] ?? "").startsWith("design/verify/Crates.report.json: behaviour/a11y — 1 failure (a11y.name) —"));
  const l5b = bw({ verification: { mode: "rendered", a11y: { violations: 3, report: "design/verify/Crates-r1.report.json" } } }, [offOld, earlier3, own1]) ?? [];
  check("a11y.report names the earlier file (3 failures) → its warning ('3 failures'), no disagreement, and the own file's 1 failure still warns (another report file is never silenced)",
    l5b.length === 2 && (l5b[0] ?? "").startsWith("design/verify/Crates-r1.report.json: behaviour/a11y — 3 failures (a11y.name, keyboard.reachable)")
    && (l5b[1] ?? "").startsWith("design/verify/Crates.report.json: behaviour/a11y — 1 failure (a11y.name)") && !l5b.some((w) => /records .* but/.test(w)));
  const l5c = bw({ verification: { mode: "rendered", a11y: { violations: 1 } } }, [reportRef({ rel: R, behaviour: beh(2, ["a11y.name"]) })]) ?? [];
  check("the disagreement's own plural: 'records 1 violation but … has 2 failures'", l5c.some((w) => /^verification\.a11y records 1 violation but design\/verify\/login\.report\.json behaviour has 2 failures — /.test(w)));
  // another matched VARIANT of the screen (a narrow-width run, a nodeId-named report) still warns on its failures
  const narrow = reportRef({ rel: "design/verify/Crates@320.report.json", matchedBy: "nodeId", mtimeMs: 3, shippedProbe: true, behaviour: beh(2, ["overflow.narrow", "a11y.name"]) });
  const clean = reportRef({ rel: "design/verify/Crates.report.json", matchedBy: "name", mtimeMs: 4, shippedProbe: true, behaviour: beh(0, []) });
  const darkOff = reportRef({ rel: "design/verify/Crates.dark.report.json", matchedBy: "layer name", mtimeMs: 5, shippedProbe: true, behaviour: beh(0, [], false, "--behaviour off") });
  const l4 = bw({ verification: { mode: "rendered", a11y: { violations: 0 } } }, [narrow, clean, darkOff]) ?? [];
  check("the own report is clean, another variant (Crates@320, nodeId-matched) has 2 failures → ONE warning for that file ('2 failures (overflow.narrow, a11y.name)'), no disagreement (the plan agrees with its own report), no 'not run' for a variant",
    l4.length === 1 && (l4[0] ?? "").startsWith("design/verify/Crates@320.report.json: behaviour/a11y — 2 failures (overflow.narrow, a11y.name) —"));
  const l4b = bw({ verification: { mode: "rendered" } }, [narrow, own1]) ?? [];
  check("two report files both failing → exactly two warnings (the own Crates 1 failure first, then Crates@320 2 failures)",
    l4b.length === 2 && (l4b[0] ?? "").startsWith("design/verify/Crates.report.json: behaviour/a11y — 1 failure") && (l4b[1] ?? "").startsWith("design/verify/Crates@320.report.json: behaviour/a11y — 2 failures"));
  // the "newest round of each file name" grouping is gone (the hook never sees two files with one name): two refs
  // that share a basename (the reports option of the API) are two report files — both warn
  const twinA = reportRef({ rel: "design/verify/a/Crates@320.report.json", matchedBy: "nodeId", mtimeMs: 1, shippedProbe: true, behaviour: beh(4, ["overflow.narrow"]) });
  const twinB = reportRef({ rel: "design/verify/b/Crates@320.report.json", matchedBy: "nodeId", mtimeMs: 3, shippedProbe: true, behaviour: beh(2, ["a11y.name"]) });
  const l3 = bw({ verification: { mode: "rendered", a11y: { violations: 0 } } }, [twinA, twinB, clean]) ?? [];
  check("one warning per other report FILE: two failing files sharing a basename → two warnings (no grouping by name)",
    l3.length === 2 && (l3[0] ?? "").startsWith("design/verify/a/Crates@320.report.json: behaviour/a11y — 4 failures") && (l3[1] ?? "").startsWith("design/verify/b/Crates@320.report.json: behaviour/a11y — 2 failures"));
  check("the a11y-missing warning names `report` among the fields to copy", verifyBuild.verificationWarnings({ verification: { mode: "rendered" } }).some((w) => /\{tool, violations: summary\.fail, warnings: summary\.warn, report: the report\.json it came from\}/.test(w)));

  // end to end: a real --compare report (buildExpectation over a plugin-shaped export) with 2 behaviour fails, through the hook
  const exp = buildExpectation([{ doc: screenExport([{ type: "FRAME", id: "80:1", name: "Crates", box: { x: 0, y: 0, w: 1280, h: 800 }, fills: [{ type: "solid", color: "#ffffff" }] }],
    { exportedAt: "2026-10-02T00:00:00Z", screen: "Crates", nodeId: "80:1" }), label: "login" }]);
  const echo = (n: { nodeId: string }): MeasuredNode => { const styles: MeasuredStyles = {}; const src: Record<string, unknown> = { ...n }; for (const k of STYLE_KEYS) { const v = src[k]; if (v !== undefined) styles[k] = v; } return { nodeId: n.nodeId, styles, matchedBy: "tag" }; };
  const fail = (id: string): BehaviourCheck => ({ id, status: "fail", detail: `${id} failed`, nodeId: "80:1" });
  const behaviour: MeasuredBehaviour = { version: 1, ran: true, browser: { name: "chromium", version: "153.0" }, namesComputedBy: "Playwright (Chromium)", budgetMs: 90000, elapsedMs: 1000, cut: false,
    checks: [fail("a11y.axe"), fail("keyboard.focus-visible"), { id: "a11y.landmarks", status: "pass", detail: "1 main" }], landmarks: [], axe: { ran: true, package: "axe-core", version: "4.13.0", violations: [] }, widths: [], artifacts: [] };
  const rep = compare(exp, { measuredAt: "2026-10-02T01:00:00Z", renderer: "playwright-chromium", nodes: exp.nodes.map(echo), behaviour });
  const files = { "a.tsx": "", "design/verify/login.png": "png", "design/verify/login.report.json": JSON.stringify(rep) };
  const VER = { mode: "rendered", artifacts: ["design/verify/login.png"], deltas: [], coverage: { rendered: ["default"], notChecked: [] } } as const;
  const root = project(files, { status: "pending", files: ["a.tsx"], verification: { ...VER, a11y: { tool: "verify-probe", violations: 0 } } });
  const ref = verifyBuild.locateReports(planOf(root), path.join(root, "design", "plan", "login.json"), root, null).find((r) => r.rel === R);
  check("[15] locateReports summarises report.behaviour {ran, fail 2, failed ids}", JSON.stringify(ref && "behaviour" in ref ? ref.behaviour : undefined) === JSON.stringify({ ran: true, why: null, fail: 2, warn: 0, failed: ["a11y.axe", "keyboard.focus-visible"] }));
  const r1 = runHook(root);
  check("[15] the hook: exit 0 (never blocked), stderr warns '2 failures (a11y.axe, keyboard.focus-visible)' and the a11y disagreement",
    r1.status === 0 && /login\.report\.json: behaviour\/a11y — 2 failures \(a11y\.axe, keyboard\.focus-visible\)/.test(r1.stderr) && /verification\.a11y records 0 violations but .* has 2 failures/.test(r1.stderr));
  {
    // a measured file with no behaviour block: hand-written / non-web (inputs.probe "unknown") → silent; the shipped probe's → warns
    const PROBE = { name: "verify-probe", version: "1.0.0", sha256: "b".repeat(64), playwright: { package: "playwright", version: "1.63.0" }, browser: { name: "chromium", version: "153.0" } };
    const m0 = { measuredAt: "2026-10-02T01:00:00Z", renderer: "playwright-chromium", nodes: exp.nodes.map(echo) };
    const handRep = compare(exp, m0), probeRep = compare(exp, { ...m0, probe: PROBE });
    const at = (r: unknown) => project({ ...files, "design/verify/login.report.json": JSON.stringify(r) }, { status: "pending", files: ["a.tsx"], verification: { ...VER, a11y: { violations: 0 } } });
    const hand = at(handRep), shipped = at(probeRep);
    const refOf = (root: string) => verifyBuild.locateReports(planOf(root), path.join(root, "design", "plan", "login.json"), root, null).find((r) => r.rel === R);
    const hRef = refOf(hand), sRef = refOf(shipped);
    const hw = hRef ? bw({ verification: { mode: "rendered", a11y: { violations: 0 } } }, [hRef]) : null;
    const sw = sRef ? bw({ verification: { mode: "rendered", a11y: { violations: 0 } } }, [sRef]) : null;
    check("[15] no behaviour block, inputs.probe 'unknown' (hand-written / non-web) → no behaviour warning, in the function and in the hook",
      handRep.inputs?.probe === "unknown" && !!hw && hw.length === 0 && !/behaviour\/a11y checks did not run/.test(runHook(hand).stderr));
    check("[15] no behaviour block, inputs.probe = the shipped probe (an older probe) → 'did not run … re-run the shipped probe', in the function and in the hook",
      !!sRef && "shippedProbe" in sRef && sRef.shippedProbe && !!sw && sw.some((w) => /behaviour\/a11y checks did not run \(the measured file carries no behaviour checks.*re-run the shipped probe/.test(w))
      && /login\.report\.json: behaviour\/a11y checks did not run/.test(runHook(shipped).stderr));
  }
  const mal = project({ ...files, "design/verify/login.report.json": JSON.stringify({ ...rep, behaviour: { ran: "maybe" } }) }, { status: "pending", files: ["a.tsx"], verification: { ...VER, a11y: { violations: 0 } } });
  const ref2 = verifyBuild.locateReports(planOf(mal), path.join(mal, "design", "plan", "login.json"), mal, null).find((r) => r.rel === R);
  check("[15] a malformed report.behaviour is read as none (the report itself still located)", !!ref2 && "behaviour" in ref2 && ref2.behaviour === null);
}

console.log("claude-plugin/scripts bundles:");
const SCRIPTS = path.join(import.meta.dirname, "..", "claude-plugin", "scripts");
check("every entry is a committed REAL file (a symlink out of the plugin dir is not installed)", ENTRIES.every((n) => {
  const p = path.join(SCRIPTS, n + ".js");
  return fs.existsSync(p) && !fs.lstatSync(p).isSymbolicLink();
}));
check("bundles are self-contained — no require() that leaves the plugin directory", ENTRIES.every((n) =>
  !/(require\(|from )["']\.\.?\//.test(fs.readFileSync(path.join(SCRIPTS, n + ".js"), "utf8"))));
// Node builtins only (LITERAL specifiers only: a computed require(x)/import(x) is invisible to this regex —
// the one sanctioned computed load, verify-probe's createRequire, is pinned by the next check): a bare package import would fail in an installed plugin (it has no node_modules),
// and an INLINED package — esbuild marks each one with a `// …node_modules/<pkg>/…` path comment — bloats every
// bundle (zod, a bridge dependency, is ~750 KB unminified per script). A bridge module the layer imports
// must not pull one in.
{
  const bad: string[] = [];
  for (const n of ENTRIES) {
    const text = fs.readFileSync(path.join(SCRIPTS, n + ".js"), "utf8");
    for (const m of text.matchAll(/^(?:import|export)\b[^;]*?["']([^"']+)["']\s*;|\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/gm)) {
      // Top-level import/export statements (esbuild emits them at column 0), plus literal import()/require().
      const spec = must(m[1] ?? m[2], "regex group 1 or 2");
      if (!spec.startsWith("node:") && !spec.startsWith(".")) bad.push(`${n}.js imports '${spec}'`);
    }
    for (const m of text.matchAll(/^\/\/ \S*?\bnode_modules\/((?:@[^/\s]+\/)?[^/\s]+)/gm)) bad.push(`${n}.js inlines ${must(m[1], "regex group 1")}`);
  }
  check("bundles use Node builtins only — no package imported or inlined" + (bad.length ? " — " + [...new Set(bad)].join(", ") : ""), bad.length === 0);
}
// The ONE explicit exception (an owner decision): verify-probe.js loads the PROJECT's Playwright — and
// the project's axe-core when it has one — at run time through createRequire(<project>/package.json), a computed
// specifier the literal-import check above cannot see. Both packages go through that one call site. So: exactly
// one createRequire( call site, in that bundle only, and no bundle names a Playwright package or axe-core in a
// literal import/require (axe-core is never bundled).
{
  const DYNAMIC_REQUIRE_ALLOWED: Record<string, number> = { "verify-probe": 1 };
  const wrong: string[] = [];
  for (const n of ENTRIES) {
    const text = fs.readFileSync(path.join(SCRIPTS, n + ".js"), "utf8");
    const calls = [...text.matchAll(/\bcreateRequire\(/g)].length;
    if (calls !== (DYNAMIC_REQUIRE_ALLOWED[n] ?? 0)) wrong.push(`${n}.js has ${calls} createRequire( call(s), allowed ${DYNAMIC_REQUIRE_ALLOWED[n] ?? 0}`);
    if (/(?:\bfrom\s*|\b(?:import|require)\(\s*)["'](?:playwright|playwright-core|@playwright\/test)(?:\/[^"']*)?["']/.test(text)) wrong.push(`${n}.js imports a Playwright package literally`);
    if (/(?:\bfrom\s*|\b(?:import|require)\(\s*)["']axe-core(?:\/[^"']*)?["']/.test(text)) wrong.push(`${n}.js imports axe-core literally`);
  }
  check("dynamic require only where allowed: verify-probe.js has exactly one createRequire( (the project's Playwright and axe-core both go through it), every other bundle has none, none imports Playwright or axe-core literally" + (wrong.length ? " — " + wrong.join("; ") : ""), wrong.length === 0);
}
// the visual diff ports pixelmatch v6.0.0 (ISC) — its licence notice must ship with the code: visual-diff.ts carries it
// as a `/*! … */` legal comment, which esbuild keeps (moved to the end of the file, legalComments "eof" when bundling)
{
  const text = fs.readFileSync(path.join(SCRIPTS, "verify-probe.js"), "utf8");
  check("verify-probe.js carries pixelmatch's ISC licence notice and the Mapbox copyright (the visual diff's port)",
    /ISC License/.test(text) && /Copyright \(c\) 2024, Mapbox/.test(text) && /Permission to use, copy, modify, and\/or distribute this software/.test(text));
}

// A skill that tells the agent to run one of these with no arguments hands it a usage error in the
// gate step (shipped once: drift-lint.js and tokens.js). Every invocation must carry its arguments.
{
  const NEEDS_ARGS = ["design-diff", "drift-lint", "tokens", "map-bootstrap", "get-component", "map-validate", "plan-skeleton", "verify-probe"];
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".md") ? [path.join(d, e.name)] : []);
  const bare: string[] = [];
  for (const f of [...walk(path.join(SCRIPTS, "..", "skills")), ...walk(path.join(SCRIPTS, "..", "agents"))]) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(/scripts\/([a-z-]+)\.js"(\s*)(\S)/g)) {
      const script = must(m[1], "regex group 1");
      const ch = must(m[3], "regex group 3");
      if (NEEDS_ARGS.includes(script) && (ch === "`" || ch === ")")) bare.push(`${path.basename(path.dirname(f))}/${path.basename(f)}: ${script}.js`);
    }
  }
  check("skill docs never invoke an argument-taking script bare" + (bare.length ? " — " + bare.join(", ") : ""), bare.length === 0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-scripts-"));
// An unhandled rejection here still fails the run (Node exits non-zero); nothing awaits this chain.
void build(tmp).then(async () => {
  const stale = ENTRIES.filter((n) => fs.readFileSync(path.join(tmp, n + ".js"), "utf8") !== fs.readFileSync(path.join(SCRIPTS, n + ".js"), "utf8"));
  check("claude-plugin/scripts/ is in sync with design-to-code/ (else: node claude-plugin/build-scripts.ts)" + (stale.length ? " — STALE: " + stale.join(", ") : ""), stale.length === 0);
  check("a bundle runs from outside the repo", (() => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-plugin-"));
    fs.copyFileSync(path.join(SCRIPTS, "drift-lint.js"), path.join(out, "drift-lint.js"));
    // The installed plugin dir carries claude-plugin/package.json ({"type": "module"}); without it Node
    // would fall back to syntax detection for these ESM bundles.
    fs.copyFileSync(path.join(SCRIPTS, "..", "package.json"), path.join(out, "package.json"));
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
  check("--native WITHOUT --also-generic writes ONLY the native file, not the generic set, and names the canonical file", (() => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-tokens-"));
    const input = path.join(out, "tokens.json");
    fs.writeFileSync(input, JSON.stringify({ collections: [{ name: "C", modes: ["M"], default: "M" }], variables: [{ name: "a/b", type: "COLOR", collection: "C", values: { M: "#ffffff" } }] }));
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, "tokens.js"), input, out, "--native", "swiftui"], { encoding: "utf8" });
    return r.status === 0 && fs.existsSync(path.join(out, "DesignTokens.swift")) && !fs.existsSync(path.join(out, "tokens.dtcg.json"))
      && !fs.existsSync(path.join(out, "tokens.css")) && !fs.existsSync(path.join(out, "tokens.resolver.json")) && !fs.existsSync(path.join(out, "tokens"))
      && /wrote DesignTokens\.swift/.test(r.stdout) && /NOT written here.*design\//.test(r.stdout);
  })());

  // stdin is read only when it is not a terminal, never waited on forever.
  const timed = (args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }, feed?: (stdin: Writable) => unknown) => new Promise<{ code: number | null; ms: number; stderr: string }>((resolve) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, [HOOK, ...args], { stdio: ["pipe", "pipe", "pipe"], ...opts });
    let err = "";
    c.stderr.on("data", (d) => { err += d; });
    if (feed) feed(c.stdin);
    const kill = setTimeout(() => c.kill("SIGKILL"), 10000);
    c.on("exit", (code) => { clearTimeout(kill); resolve({ code, ms: Date.now() - t0, stderr: err }); });
  });
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-empty-"));
  const silent = await timed([], { cwd: empty }); // an open pipe that never writes and never closes
  check(`an attached pipe that never delivers a payload does not hang: exit ${silent.code} in ${silent.ms} ms (< 2000)`, silent.code === 0 && silent.ms < 2000);
  const cut = await timed([], { cwd: empty, env: Object.assign({}, process.env, { DTWIN_HOOK_TIMEOUT_MS: "1500" }) }, (s) => s.write("{"));
  check(`a payload with no end-of-file is cut off by the hard timeout, naming what it waited on (exit ${cut.code}, ${cut.ms} ms)`,
    cut.code === 1 && /timed out after 2 s waiting for the hook payload on stdin/.test(cut.stderr) && cut.ms < 5000);
  const posRoot = project({ "a.tsx": "#5B5FC7" }, { status: "pending", files: ["a.tsx"], tokens: [brand], verification: STATIC });
  const pos = await timed([path.join(posRoot, "design", "plan", "login.json")], {});
  check(`a plan path as an argument is checked without touching stdin (exit ${pos.code} in ${pos.ms} ms)`, pos.code === 2 && pos.ms < 2000 && /brand-600/.test(pos.stderr));
  type HooksJson = { hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout: number }> }>> };
  const isHooksJson = (x: unknown): x is HooksJson => isJsonObject(x) && isJsonObject(x.hooks) && Object.values(x.hooks).every((list) => Array.isArray(list) && list.every((e) => isJsonObject(e) && Array.isArray(e.hooks)));
  const hooks = readFixture(path.join(import.meta.dirname, "..", "claude-plugin", "hooks", "hooks.json"), isHooksJson);
  const subagentStop = must(hooks.hooks.SubagentStop, "hooks.hooks.SubagentStop");
  const h = must(must(subagentStop[0], "hooks.hooks.SubagentStop[0]").hooks[0], "hooks.hooks.SubagentStop[0].hooks[0]");
  check("[hooks.json] the SubagentStop gate runs the bundled verify-build.js and gives it longer than its own 60 s cut-off",
    /scripts\/verify-build\.js"?$/.test(h.command) && h.timeout > 60);

  // ---------------------------------------------------------------- first-class auditGate
  // Real audit: design/audit/Studio_Configurations.json (5 blockers, copied verbatim from a
  // recorded run). auditGateWarnings is a WARNING only — this file blocks on exactly two things
  // (a raw colour, an unanchored node) — never a `blocking` entry.
  {
    const auditDoc = readFixture(path.join(import.meta.dirname, "fixtures", "livetest3", "plan", "audit", "Studio_Configurations.json"), isAuditReport);
    const ids = blockerIds(auditDoc);
    check("the real Studio_Configurations audit has 5 blocker ids", ids.length === 5 && ids[0] === "catalog-covers-nothing");
    const mkCwd = () => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "p6-136-"));
      fs.mkdirSync(path.join(d, "design", "audit"), { recursive: true });
      fs.writeFileSync(path.join(d, "design", "audit", "Studio_Configurations.json"), JSON.stringify(auditDoc));
      return d;
    };
    {
      const cwd = mkCwd();
      const plan = { screenName: "Studio Configurations" };
      const w = auditGateWarnings(plan, cwd, null);
      const msg = must(w[0], "w[0]");
      check("a Blocked audit with no auditGate at all on the plan WARNS, naming the file and every blocker id",
        w.length === 1 && /Studio_Configurations\.json/.test(msg) && ids.every((id) => msg.includes(id)));
    }
    {
      const cwd = mkCwd();
      const overrideFirstTwo = [must(ids[0], "ids[0]"), must(ids[1], "ids[1]")];
      const plan = { screenName: "Studio Configurations", auditGate: { auditFile: "design/audit/Studio_Configurations.json", verdict: "blocked", overridden: overrideFirstTwo, reason: "provenance issues, not build issues" } } satisfies Plan;
      const w = auditGateWarnings(plan, cwd, null);
      const msg = must(w[0], "w[0]");
      check("an auditGate that overrides only 2 of 5 blockers WARNS about the 3 not covered",
        w.length === 1 && ids.slice(2).every((id) => msg.includes(id)) && !msg.includes(must(ids[0], "ids[0]")));
    }
    {
      const cwd = mkCwd();
      const plan = { screenName: "Studio Configurations", auditGate: { auditFile: "design/audit/Studio_Configurations.json", verdict: "blocked", overridden: ids } } satisfies Plan;
      const w = auditGateWarnings(plan, cwd, null);
      check("every blocker overridden but no `reason` still WARNS (a reason is required)", w.length === 1 && /reason/.test(must(w[0], "w[0]")));
    }
    {
      const cwd = mkCwd();
      const plan = { screenName: "Studio Configurations", auditGate: { auditFile: "design/audit/Studio_Configurations.json", verdict: "blocked", overridden: ids, reason: "acknowledged", decidedBy: "owner", decidedAt: "2026-09-23" } } satisfies Plan;
      const w = auditGateWarnings(plan, cwd, null);
      check("every blocker overridden with a reason: no warning at all", w.length === 0);
    }
    {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "p6-136-noaudit-"));
      const w = auditGateWarnings({ screenName: "Nothing Here" }, cwd, null);
      check("no audit file at all for this screen: no warning (nothing to gate)", w.length === 0);
    }
    {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "p6-136-bad-"));
      fs.mkdirSync(path.join(cwd, "design", "audit"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "design", "audit", "Studio_Configurations.json"), "{ truncated");
      const w = auditGateWarnings({ screenName: "Studio Configurations" }, cwd, null);
      check("an audit file that cannot be read WARNS that the gate was not checked (was: silently no blockers)",
        w.length === 1 && /Studio_Configurations\.json is not valid JSON .*the audit gate was NOT checked/.test(must(w[0], "w[0]")));
    }
  }
  // ---------------------------------------------------------------- stable ids, legacy + bare codes accepted
  // An audit written before findings carried an `id`: a missing-font blocker on node 1:1, a node-less
  // token-name-collision. Ids now: `missing-font@1:1`, `token-name-collision`; legacy: `missing-font#0`,
  // `token-name-collision#1`.
  {
    const auditDoc = { summary: { blockers: 2, warnings: 1, info: 0 }, findings: [
      { severity: "blocker", code: "missing-font", message: "font", nodeId: "1:1" },
      { severity: "blocker", code: "token-name-collision", message: "collision" },
      { severity: "warning", code: "fixed-size-text", message: "fixed", nodeId: "1:2" },
    ] };
    const mk = () => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "f44-"));
      fs.mkdirSync(path.join(d, "design", "audit"), { recursive: true });
      fs.writeFileSync(path.join(d, "design", "audit", "Sample_Screen__1_1.json"), JSON.stringify(auditDoc));
      return d;
    };
    const gateWith = (overridden: string[]): string[] => auditGateWarnings({ screenName: "Sample Screen", auditGate: { auditFile: "design/audit/Sample_Screen__1_1.json", verdict: "blocked", overridden, reason: "acknowledged", decidedBy: "owner", decidedAt: "2026-10-07" } }, mk(), null);
    const legacy = gateWith(["missing-font#0", "token-name-collision#1"]);
    const notListed = (w: string[]): string[] => w.filter((x) => /not listed in this plan's auditGate\.overridden/.test(x));
    const legacyWarn = (w: string[]): string[] => w.filter((x) => /old positional id/.test(x));
    check(`a plan overriding the legacy positional ids (missing-font#0, token-name-collision#1) still covers its blockers — no "not listed" warning (got ${JSON.stringify(legacy)})`, notListed(legacy).length === 0);
    // …but exactly ONE non-blocking warning maps each legacy entry to its stable id.
    const lw = legacyWarn(legacy);
    check(`legacy ids: exactly one warning, naming both → pairs (got ${JSON.stringify(legacy)})`,
      legacy.length === 1 && lw.length === 1 && (lw[0] ?? "").includes("missing-font#0 → missing-font@1:1") && (lw[0] ?? "").includes("token-name-collision#1 → token-name-collision") && !/drop it/.test(lw[0] ?? ""));
    const stableOnly = gateWith(["missing-font@1:1", "token-name-collision"]);
    check(`stable ids only: no legacy warning at all (got ${JSON.stringify(stableOnly)})`, stableOnly.length === 0);
    const stale = gateWith(["missing-font@1:1", "token-name-collision", "contrast#3"]);
    check(`a positional entry matching no blocker is named "(drop it)" (got ${JSON.stringify(stale)})`,
      stale.length === 1 && /no current blocker: contrast#3 \(drop it\)/.test(stale[0] ?? "")
      // only stale entries → no "Replace each with its stable id" (there is nothing to replace)
      && /None of them covers a current blocker/.test(stale[0] ?? "") && !/Replace each with its stable id/.test(stale[0] ?? ""));
    const both = gateWith(["missing-font#0", "token-name-collision", "contrast#3"]);
    check(`a legacy cover and a stale entry share ONE warning (got ${JSON.stringify(both)})`,
      both.length === 1 && (both[0] ?? "").includes("missing-font#0 → missing-font@1:1") && (both[0] ?? "").includes("contrast#3 (drop it)")
      && /Replace each with its stable id/.test(both[0] ?? ""));
    const bare = gateWith(["missing-font@1:1", "token-name-collision"]);
    check(`a plan overriding the bare code of a node-less blocker (token-name-collision) covers it (got ${JSON.stringify(bare)})`, bare.length === 0);
    const none = gateWith([]);
    const msg = none[0] ?? "";
    check(`a plan overriding nothing: the warning lists the NEW ids, not #i (got ${JSON.stringify(none)})`,
      none.length === 1 && msg.includes("missing-font@1:1") && msg.includes("token-name-collision") && !/#\d/.test(msg));
    const mixed = gateWith(["missing-font#0"]);
    check("a legacy id covers only its own blocker — the other is still listed by its new id",
      notListed(mixed).length === 1 && (notListed(mixed)[0] ?? "").includes("token-name-collision") && !(notListed(mixed)[0] ?? "").includes("missing-font"));
  }
  // a position shifts when an earlier blocker is fixed. Two missing-font blockers; the
  // plan overrode `missing-font#0` (the first). Once 1:1 is fixed the audit holds only missing-font@2:2 — which is
  // now `missing-font#0`, so the old entry silently covers a DIFFERENT blocker. The warning must say so.
  {
    const mkAudit = (nodes: string[]): string => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "leg1-"));
      fs.mkdirSync(path.join(d, "design", "audit"), { recursive: true });
      fs.writeFileSync(path.join(d, "design", "audit", "Sample_Screen__1_1.json"), JSON.stringify({ summary: { blockers: nodes.length, warnings: 0, info: 0 }, findings: nodes.map((nodeId) => ({ severity: "blocker", code: "missing-font", message: "font", nodeId })) }));
      return d;
    };
    const planOver = (overridden: string[]): Plan => ({ screenName: "Sample Screen", auditGate: { auditFile: "design/audit/Sample_Screen__1_1.json", verdict: "blocked", overridden, reason: "acknowledged", decidedBy: "owner", decidedAt: "2026-10-07" } });
    const before = auditGateWarnings(planOver(["missing-font#0"]), mkAudit(["1:1", "2:2"]), null);
    check(`before the fix: missing-font#0 covers 1:1, 2:2 is still not listed (got ${JSON.stringify(before)})`,
      before.some((x) => /not listed/.test(x) && x.includes("missing-font@2:2")) && before.some((x) => x.includes("missing-font#0 → missing-font@1:1")));
    const after = auditGateWarnings(planOver(["missing-font#0"]), mkAudit(["2:2"]), null);
    check(`1:1 fixed: the shifted missing-font#0 now covers 2:2 — the warning names missing-font#0 → missing-font@2:2 (got ${JSON.stringify(after)})`,
      after.length === 1 && (after[0] ?? "").includes("missing-font#0 → missing-font@2:2"));
  }

  {
    // the printed migration retires the old set (`<old>.expected.json.retired`) and keeps its
    // report as history. locateReports must not read that report: an old fail would keep the plan failed forever.
    const root = project({}, { screenName: "Sample Screen", nodeId: "1:2", file: "design/export/pages/P/Sample_Screen__1_2.json" });
    const v = path.join(root, "design", "verify");
    fs.mkdirSync(v, { recursive: true });
    const rep = (verdict: string) => JSON.stringify({ schema: "designtwin/verify-report@2", verdict, screen: "Sample Screen", nodeId: "1:2", why: [], deltas: [], inputs: {} });
    fs.writeFileSync(path.join(v, "Nick.expected.json.retired"), JSON.stringify({ frame: { nodeId: "1:2" } }));
    fs.writeFileSync(path.join(v, "Nick.report.json"), rep("fail"));
    fs.writeFileSync(path.join(v, "Sample_Screen__1_2.expected.json"), JSON.stringify({ frame: { nodeId: "1:2" } }));
    fs.writeFileSync(path.join(v, "Sample_Screen__1_2.report.json"), rep("pass"));
    const pf = path.join(root, "design", "plan", "login.json");
    const rels = (): string[] => verifyBuild.locateReports(planOf(root), pf, root, null).map((r) => r.rel);
    const got = rels();
    check(`a report whose expectation was retired (.retired) is not located; the canonical one is (got ${JSON.stringify(got)})`,
      !got.includes("design/verify/Nick.report.json") && got.includes("design/verify/Sample_Screen__1_2.report.json"));
    const st = computeStatus(planOf(root), { cwd: root, planFile: pf });
    check(`…so the retired fail does not keep the plan failed (got ${st.status})`, st.status !== "failed" && !st.reasons.some((x) => x.includes("Nick")));
    // control: the same report beside a LIVE expectation is still read
    fs.renameSync(path.join(v, "Nick.expected.json.retired"), path.join(v, "Nick.expected.json"));
    check("control: with its expectation in place the same report is located", rels().includes("design/verify/Nick.report.json"));
  }

  report();
});
