// design-to-code/screen-key.ts: the set-name grammar (`<stem>` / `<stem>.<slug>`), the verify dir's sets (existing,
// legacy, retired) and screenKey — a query to (node id, stem) through resolve-screen's exact stages only.
// Invented screens, temp dirs only.
//   bun test/screen-key.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, report } from "./assert.ts";
import {
  MAX_SLUG, RESERVED_SLUGS, allSets, expectationSetProblem, formatSetName, isVariantSlug, nodeIdFromSetName, outBaseOf,
  parseSetName, screenKey, setKey, setNameOfFile, statusBaseOf, variantProblem, variantSlug, verifySets,
} from "../design-to-code/screen-key.ts";
import { writeStatus } from "../design-to-code/verify-run.ts";
import type { ScreenKey } from "../design-to-code/screen-key.ts";

const tmp = (tag: string): string => fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-key-" + tag + "-"));
const put = (file: string, body: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n");
};
const expectation = (nodeId: string, name: string): unknown => ({ schema: "designtwin/verify-expectation@2", frame: { nodeId, name } });
const keyOf = (k: ScreenKey): string => (k.status === "resolved" ? `${k.nodeId} ${k.stem}` : `unresolved: ${k.why}`);

console.log("the set-name grammar:");
{
  const table: Array<[string, string | null]> = [
    ["Plots__1_1", "Plots__1_1|1:1|"], ["Plots__1_1.dark", "Plots__1_1|1:1|dark"], ["Plots__1_1.w-320", "Plots__1_1|1:1|w-320"],
    ["Chip__I5_2_30_7.hover", "Chip__I5_2_30_7|I5:2;30:7|hover"], ["layer__3_4", "layer__3_4|3:4|"],
    // legacy names: a nickname, an id-less name, `@`/`-` variants, an upper-case or dotted slug, an empty slug
    ["Plots", null], ["Plots__1_1@320", null], ["Plots__1_1-r1", null], ["Plots__1_1.Dark", null], ["Plots__1_1.dark.wide", null],
    ["Plots__1_1.", null], ["Plots.dark", null], ["Plot-s__1_1", null], ["", null],
  ];
  const bad = table.filter(([n, want]) => {
    const p = parseSetName(n);
    return (p === null ? null : `${p.stem}|${p.nodeId}|${p.variant ?? ""}`) !== want;
  });
  check(`parseSetName reads the table (wrong: ${JSON.stringify(bad)})`, bad.length === 0);
  check("formatSetName: the stem alone, or `<stem>.<slug>`", formatSetName("Plots__1_1") === "Plots__1_1" && formatSetName("Plots__1_1", null) === "Plots__1_1" && formatSetName("Plots__1_1", "dark") === "Plots__1_1.dark");
  let threw = false;
  try { formatSetName("Plots__1_1", "Dark"); } catch { threw = true; }
  check("formatSetName refuses a slug outside the grammar", threw);
  check("nodeIdFromSetName reads the stem before the first '.'", nodeIdFromSetName("Plots__1_1.dark") === "1:1" && nodeIdFromSetName("Plots__1_1") === "1:1" && nodeIdFromSetName("Plots@320") === null && nodeIdFromSetName("Plots__1_1@320") === null);
  check("variantSlug: lower case, other runs one '-', none at the ends", variantSlug("Dark") === "dark" && variantSlug("@320") === "320" && variantSlug("Wide View!") === "wide-view" && variantSlug("dark@320") === "dark-320" && variantSlug("__") === "");
  check("every formatted name parses back to its parts", ["dark", "w-320", "r1"].every((s) => { const p = parseSetName(formatSetName("Plots__1_1", s)); return p !== null && p.variant === s && p.stem === "Plots__1_1"; }));
}

console.log("\nthe verify dir's sets:");
{
  const dir = tmp("sets");
  put(path.join(dir, "Plots__1_1.expected.json"), expectation("1:1", "Plots"));
  put(path.join(dir, "Plots__1_1.report.json"), { nodeId: "1:1" });
  put(path.join(dir, "Plots__1_1.dark.expected.json"), expectation("1:1", "Plots"));
  put(path.join(dir, "Plots__1_1.png"), "png");
  put(path.join(dir, "Beds.expected.json"), expectation("1:1", "Plots"));
  put(path.join(dir, "Beds@320.report.json"), { nodeId: "1:1" });
  put(path.join(dir, "Rows.expected.json.retired"), expectation("1:1", "Plots"));
  put(path.join(dir, "Rows.report.json"), { nodeId: "1:1" });
  put(path.join(dir, "Sheds.expected.json"), expectation("2:2", "Sheds"));
  put(path.join(dir, "Mixed.expected.json"), expectation("3:3", "Mixed"));
  put(path.join(dir, "Mixed.report.json"), { nodeId: "4:4" });
  const all = allSets(dir);
  check(`allSets names every set once, a retired one flagged (got ${JSON.stringify(all)})`,
    JSON.stringify(all.map((s) => `${s.name}${s.retired ? "*" : ""}`)) === JSON.stringify(["Beds", "Beds@320", "Mixed", "Plots__1_1", "Plots__1_1.dark", "Rows*", "Sheds"]));
  check("verifySets leaves the retired one out", !verifySets(dir).includes("Rows") && verifySets(dir).length === 6);
  // which sets hold a node, and the node a set is of: test/node-artefacts.test.ts
  check("a verify dir that does not exist holds no sets", allSets(path.join(dir, "missing")).length === 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\nscreenKey with an export index (exact stages only):");
{
  const root = tmp("index");
  const exportDir = path.join(root, "export"), verifyDir = path.join(root, "verify"), planDir = path.join(root, "plan");
  put(path.join(exportDir, "pages", "index.json"), { pageDirs: [{ page: "P", dir: "P" }], layers: [
    { name: "Seed Trays", title: "Trays", id: "1:1", type: "FRAME", page: "P", file: "pages/P/Seed_Trays__1_1.json" },
    { name: "Compost", id: "2:1", type: "FRAME", page: "P", file: "pages/P/Compost__2_1.json" },
    { name: "Bins", title: "Compost", id: "2:2", type: "FRAME", page: "P", file: "pages/P/Bins__2_2.json" },
    { name: "Hedge Rows", id: "3:1", type: "FRAME", page: "P", file: "pages/P/Hedge_Rows__3_1.json" },
  ] });
  put(path.join(planDir, "Orchard.json"), { file: "Orchard.json", screenName: "Orchard", nodeId: "3:1" });
  const k = (q: string): ScreenKey => screenKey(q, { exportDir, planDir, verifyDir });
  check(`a node id → the indexed name's stem (got ${keyOf(k("1:1"))})`, keyOf(k("1:1")) === "1:1 Seed_Trays__1_1");
  check("an exact layer name, a title, a plan screenName and a carried id give the same key",
    [k("Seed Trays"), k("Trays"), k("Seed_Trays__1_1"), k("design/verify/Seed_Trays__1_1.report.json")].every((x) => keyOf(x) === "1:1 Seed_Trays__1_1") && keyOf(k("Orchard")) === "3:1 Hedge_Rows__3_1");
  const fold = k("hedge-rows");
  check(`a whitespace-insensitive hit names no key — its row is a candidate (got ${keyOf(fold)}; ${fold.status === "unresolved" ? JSON.stringify(fold.candidates.map((c) => c.id)) : ""})`,
    fold.status === "unresolved" && /matched only ignoring spaces/.test(fold.why) && JSON.stringify(fold.candidates.map((c) => c.id)) === JSON.stringify(["3:1"]));
  const foldSet = setKey("hedge-rows", { exportDir, planDir, verifyDir });
  check("[setKey] a whitespace-insensitive hit names no set either — the candidate listed", foldSet.status === "unresolved" && JSON.stringify(foldSet.candidates.map((c) => c.id)) === JSON.stringify(["3:1"]));
  check("an ambiguous exact union names no key, listing both", (() => { const a = k("Compost"); return a.status === "unresolved" && a.candidates.length === 2; })());
  check("a text-search hit names no key", (() => { const a = k("Seed"); return a.status === "unresolved" && /text search/.test(a.why); })());
  check("an unknown name names no key", k("Greenhouse").status === "unresolved");
  // the stem is fixed once a set exists: a frame renamed in Figma keeps the set it has
  put(path.join(verifyDir, "Seedlings__1_1.expected.json"), expectation("1:1", "Seedlings"));
  const fixed = k("Seed Trays");
  check(`with a set under the node's earlier name, that stem (got ${keyOf(fixed)})`, fixed.status === "resolved" && fixed.stem === "Seedlings__1_1" && fixed.existing && fixed.name === "Seed Trays");
  put(path.join(verifyDir, "Trays.expected.json"), expectation("1:1", "Seed Trays"));
  const withLegacy = k("1:1");
  check("a legacy-named set of the node is listed beside the key", withLegacy.status === "resolved" && JSON.stringify(withLegacy.legacy) === JSON.stringify(["Trays"]));
  put(path.join(verifyDir, "Seed_Trays__1_1.report.json"), { nodeId: "1:1" });
  const two = k("1:1");
  check(`two grammar-named sets for the node name no key (got ${keyOf(two)})`, two.status === "unresolved" && /2 verify sets/.test(two.why));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("\nscreenKey without an export index:");
{
  const root = tmp("noindex");
  const verifyDir = path.join(root, "verify");
  const k = (q: string): ScreenKey => screenKey(q, { exportDir: path.join(root, "export"), verifyDir });
  check(`a canonical stem is taken as written (got ${keyOf(k("Plots__1_1"))})`, keyOf(k("Plots__1_1")) === "1:1 Plots__1_1" && keyOf(k("design/verify/Plots__1_1.expected.json")) === "1:1 Plots__1_1");
  check("a name or a nickname is not", k("Plots").status === "unresolved" && k("Plots@320").status === "unresolved");
  check("a bare node id with no set is not", k("1:1").status === "unresolved");
  put(path.join(verifyDir, "Beds__1_1.expected.json"), expectation("1:1", "Beds"));
  check("a bare node id the verify dir names → that set's stem", keyOf(k("1:1")) === "1:1 Beds__1_1");
  const other = k("Plots__1_1");
  check(`a canonical stem whose node another set holds under a different name names no key (got ${keyOf(other)})`, other.status === "unresolved" && /Beds__1_1/.test(other.why));
  check("…the set's own stem is taken", keyOf(k("Beds__1_1")) === "1:1 Beds__1_1");
  put(path.join(verifyDir, "Sheds.expected.json"), expectation("2:2", "Sheds"));
  const legacy = k("Sheds__2_2");
  check(`a legacy-named set of the node never refuses its canonical stem: taken, the legacy set listed for --migrate (got ${JSON.stringify(legacy)})`,
    legacy.status === "resolved" && legacy.stem === "Sheds__2_2" && JSON.stringify(legacy.legacy) === JSON.stringify(["Sheds"]));
  fs.rmSync(root, { recursive: true, force: true });
}


console.log("\n[slug] the variant slug rule:");
{
  const ok = ["dark", "w-320", "r1", "320", "a".repeat(MAX_SLUG), "w320-dialog"];
  const no = ["Dark", "w--320", "-dark", "dark-", "a".repeat(MAX_SLUG + 1), "dark.wide", "dark_wide", "", ...RESERVED_SLUGS];
  check(`[slug] accepted: ${ok.join(", ")}`, ok.every((s) => isVariantSlug(s) && variantProblem(s) === null));
  check(`[slug] refused: ${no.filter((s) => isVariantSlug(s)).join(", ") || "every one"} (want none accepted)`, no.every((s) => !isVariantSlug(s) && variantProblem(s) !== null));
  check("[slug] the reserved words are the set's file tails and tool words", ["diff", "forced-colors", "expected", "report", "measured", "status", "evidence", "prev", "retired", "json", "md", "png", "tmp"].every((s) => RESERVED_SLUGS.has(s)));
  check("[slug] variantProblem says why: reserved, too long, or not a slug — with the slug to use when there is one",
    /reserved/.test(variantProblem("diff") ?? "") && /at most 32/.test(variantProblem("a".repeat(33)) ?? "") && /use 'dark'/.test(variantProblem("Dark") ?? "")
    && /use 'wide-view'/.test(variantProblem("Wide View") ?? "") && !/use '/.test(variantProblem("--") ?? "") && !/use '/.test(variantProblem("Diff") ?? ""));
  check("[slug] Plots__1_1.diff / .forced-colors / .Dark / .w--320 are legacy names (parseSetName null), formatSetName refuses the slug",
    ["Plots__1_1.diff", "Plots__1_1.forced-colors", "Plots__1_1.w--320", "Plots__1_1.report"].every((n) => parseSetName(n) === null)
    && ["diff", "w--320", "a".repeat(33)].every((s) => { try { formatSetName("Plots__1_1", s); return false; } catch { return true; } }));
}

console.log("\n[statusBaseOf] / setNameOfFile / [outBaseOf] / expectationSetProblem:");
{
  check("[statusBaseOf] setNameOfFile: the basename without .expected.json (else .json)",
    setNameOfFile(path.join("design", "verify", "Plots__1_1.dark.expected.json")) === "Plots__1_1.dark" && setNameOfFile("Plots__1_1.json") === "Plots__1_1" && setNameOfFile("Plots") === "Plots");
  check("[statusBaseOf] <the expectation's dir>/<set name>", statusBaseOf(path.join("a", "b", "Plots__1_1.dark.expected.json")) === path.join("a", "b", "Plots__1_1.dark")
    && statusBaseOf("Plots__1_1.expected.json") === "Plots__1_1");
  const root = tmp("out");
  const prev = process.cwd();
  process.chdir(root);
  try {
    fs.mkdirSync(path.join("qa", "verify"), { recursive: true });
    put(path.join("qa", "file.txt"), "x");
    const S = "Plots__1_1";
    const o = (out: string | undefined, def = path.join("design", "verify")): string => { const r = outBaseOf(out, S, def); return "error" in r ? `error: ${r.error}` : `${r.base}|${r.dir}|${r.deprecated}`; };
    check(`[outBaseOf] none → <default dir>/<set> (got ${o(undefined)})`, o(undefined) === `${path.join("design", "verify", S)}|${path.join("design", "verify")}|false` && o(undefined, "exp") === `${path.join("exp", S)}|exp|false`);
    check(`[outBaseOf] an existing directory → <dir>/<set> (got ${o(path.join("qa", "verify"))})`, o(path.join("qa", "verify")) === `${path.join("qa", "verify", S)}|${path.join("qa", "verify")}|false`);
    check(`[outBaseOf] an existing file → refused (got ${o(path.join("qa", "file.txt"))})`, /^error: --out .* is a file — --out takes the verify directory; this set is Plots__1_1$/.test(o(path.join("qa", "file.txt"))));
    check(`[outBaseOf] a new path ending in a separator → that directory (got ${o("new/")})`, o("new/") === `${path.join("new", S)}|new|false`);
    // "\\" is a separator on Windows only: on POSIX `new\\` is a file name, never the directory `new`
    if (process.platform === "win32") check(`[outBaseOf] Windows: a new path ending in "\\" → that directory (got ${o("new\\")})`, o("new\\") === `${path.join("new", S)}|new|false`);
    else check(`[outBaseOf] POSIX: a new path ending in "\\" is a file name, not a directory → refused (got ${o("new\\")})`, /^error: --out new\\ is not a directory/.test(o("new\\")));
    check(`[outBaseOf] the project's verify dir, not there yet → that directory (got ${o(path.join("design", "verify"), "elsewhere")})`, o(path.join("design", "verify"), "elsewhere") === `${path.join("design", "verify", S)}|${path.join("design", "verify")}|false`);
    check(`[outBaseOf] <dir>/<the set's name> → the base itself, deprecated (got ${o(path.join("design", "verify", S))})`, o(path.join("design", "verify", S)) === `${path.join("design", "verify", S)}|${path.join("design", "verify")}|true`);
    check(`[outBaseOf] a basename that is the set's in another case → refused (got ${o(path.join("design", "verify", "plots__1_1"))})`, /^error: .*this set is Plots__1_1$/.test(o(path.join("design", "verify", "plots__1_1"))));
    check(`[outBaseOf] any other new basename (a nickname) → refused (got ${o(path.join("design", "verify", "Plots"))})`, /^error: --out .* is not a directory/.test(o(path.join("design", "verify", "Plots"))));
  } finally { process.chdir(prev); }
  const v = path.join("design", "verify");
  check("expectationSetProblem: a legacy name → run --migrate", /legacy-named verify set — run verify-screen --migrate/.test(expectationSetProblem(path.join(v, "Plots.expected.json"), "1:1", v) ?? ""));
  check("expectationSetProblem: a name of another node → named for node A, its frame is B", /named for node 1:1, its frame is 2:2/.test(expectationSetProblem(path.join(v, "Plots__1_1.expected.json"), "2:2", v) ?? ""));
  check("expectationSetProblem: the frame's own name (a variant too, or no frame id) → none", expectationSetProblem(path.join(v, "Plots__1_1.expected.json"), "1:1", v) === null
    && expectationSetProblem(path.join(v, "Plots__1_1.dark.expected.json"), "1:1", v) === null && expectationSetProblem(path.join(v, "Plots__1_1.expected.json"), undefined, v) === null);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("\n[setKey] a query to the set --status / --wait key a run by:");
{
  const root = tmp("setkey");
  const exportDir = path.join(root, "export"), verifyDir = path.join(root, "verify");
  const sk = (q: string, withIndex = true): string => { const k = setKey(q, { exportDir: withIndex ? exportDir : path.join(root, "none"), verifyDir }); return k.status === "resolved" ? `${k.nodeId} ${k.name} ${k.variant ?? "-"} ${k.existing}` : `unresolved: ${k.why}`; };
  put(path.join(exportDir, "pages", "index.json"), { pageDirs: [{ page: "P", dir: "P" }], layers: [
    { name: "Seed Trays", id: "1:1", type: "FRAME", page: "P", file: "pages/P/Seed_Trays__1_1.json" },
    { name: "Sheds", id: "2:2", type: "FRAME", page: "P", file: "pages/P/Sheds__2_2.json" },
  ] });
  check(`[setKey] a variant set name is kept, with and without an index (got ${sk("Seed_Trays__1_1.dark")} / ${sk("Seed_Trays__1_1.dark", false)})`,
    sk("Seed_Trays__1_1.dark") === "1:1 Seed_Trays__1_1.dark dark false" && sk("Seed_Trays__1_1.dark", false) === "1:1 Seed_Trays__1_1.dark dark false");
  check(`[setKey] a file tail is dropped: a status / measured / prev path names its set (got ${sk(path.join("design", "verify", "Seed_Trays__1_1.dark.status.json"))})`,
    sk(path.join("design", "verify", "Seed_Trays__1_1.dark.status.json")) === "1:1 Seed_Trays__1_1.dark dark false" && sk("Seed_Trays__1_1.expected.prev.json", false) === "1:1 Seed_Trays__1_1 - false"
    && sk("Seed_Trays__1_1.measured.json") === "1:1 Seed_Trays__1_1 - false");
  check(`[setKey] a name or node id → the base set (got ${sk("Seed Trays")} / ${sk("1:1")})`, sk("Seed Trays") === "1:1 Seed_Trays__1_1 - false" && sk("1:1") === "1:1 Seed_Trays__1_1 - false");
  // the frame was renamed in Figma after its set was written: the set keeps its name
  put(path.join(verifyDir, "Old_Trays__1_1.expected.json"), expectation("1:1", "Old Trays"));
  check(`[setKey] after a Figma rename, the name and the id find the existing Old_Trays__1_1 (got ${sk("Seed Trays")} / ${sk("1:1")})`,
    sk("Seed Trays") === "1:1 Old_Trays__1_1 - true" && sk("1:1") === "1:1 Old_Trays__1_1 - true" && sk("Old_Trays__1_1.dark") === "1:1 Old_Trays__1_1.dark dark true");
  const other = sk("Seed_Trays__1_1");
  check(`[setKey] another stem of the node → unresolved, naming the set it has (got ${other})`, /^unresolved: node 1:1 already has a verify set \(Old_Trays__1_1\) — one node, one verify set: pass that name$/.test(other));
  put(path.join(verifyDir, "Shed.expected.json"), expectation("2:2", "Sheds"));
  const legacyName = sk("Shed");
  check(`[setKey] a legacy-named set's own name → unresolved, with --migrate (got ${legacyName})`, /^unresolved: Shed is a legacy-named verify set — run verify-screen --migrate --apply/.test(legacyName));
  const legacyKey = setKey("Shed.expected.json", { exportDir, verifyDir });
  check("[setKey] …and says which legacy set it named (legacySet)", legacyKey.status === "unresolved" && legacyKey.legacySet === "Shed");
  // a run open in the run cache of a set with no files yet (openSets) fixes the node's stem like a set on disk
  const withOpen = (q: string): string => { const k = setKey(q, { exportDir, verifyDir, openSets: ["Shed_Run__2_2"] }); return k.status === "resolved" ? `${k.name} ${k.existing}` : `unresolved: ${k.why}`; };
  check(`[setKey] an open run's set fixes the stem: the name and the id → Shed_Run__2_2, existing (got ${withOpen("Sheds")} / ${withOpen("2:2")})`,
    withOpen("Sheds") === "Shed_Run__2_2 true" && withOpen("2:2") === "Shed_Run__2_2 true" && /^unresolved: node 2:2 already has a verify set \(Shed_Run__2_2\)/.test(withOpen("Sheds__2_2")));
  // that run's live status is in the run cache and no file of its set is in the verify dir: a refusal names the run, and
  // the command that ends it — not a set the user cannot find there
  put(path.join(root, "package.json"), {});
  writeStatus(path.join(verifyDir, "Shed_Run__2_2"), { runId: "run-s", phase: "queued", by: "agent" });
  const endIt = "--status Shed_Run__2_2 --phase failed --run run-s --dir ";
  const runRefusal = withOpen("Sheds__2_2");
  check(`[setKey] the other name is only an open run: the refusal says so and how to end it (got ${runRefusal})`,
    runRefusal.startsWith("unresolved: node 2:2 already has a verify set (an open run run-s under Shed_Run__2_2 (no file of it yet; end it: ") && runRefusal.includes(endIt));
  const legacyOnly = setKey("Sheds", { exportDir, verifyDir });
  check(`[setKey] a node with only a legacy set → its new stem, not existing, the legacy set listed (got ${JSON.stringify(legacyOnly)})`,
    legacyOnly.status === "resolved" && legacyOnly.name === "Sheds__2_2" && !legacyOnly.existing && JSON.stringify(legacyOnly.legacy) === JSON.stringify(["Shed"]));
  check(`[setKey] no index: a nickname is unresolved (got ${sk("Trays", false)})`, sk("Trays", false).startsWith("unresolved"));
  fs.rmSync(root, { recursive: true, force: true });
}

report();
