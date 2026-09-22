// Offline tests for design-to-code/verify-build.js (the build-screen Stop-hook gate) and for the
// committed claude-plugin/scripts/ bundles it ships in.
//   node test/verify-build.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { checkPlan, passedStatus, colorLiterals, arbitraryPx, hex6, colorKey, isStale } = require("../design-to-code/verify-build");
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
