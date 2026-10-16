// design-to-code/screen-key.ts: the set-name grammar (`<stem>` / `<stem>.<slug>`), the verify dir's sets (existing,
// legacy, retired) and screenKey — a query to (node id, stem) through resolve-screen's exact stages only.
// Invented screens, temp dirs only.
//   node test/screen-key.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, report } from "./assert.ts";
import {
  allSets, canonicalStemsFor, existingStem, formatSetName, legacySetsFor, nodeIdFromSetName, parseSetName, screenKey, setNodeId, variantSlug, verifySets,
} from "../design-to-code/screen-key.ts";
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
  check("formatSetName refuses a slug outside [a-z0-9-]+", threw);
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
  check("setNodeId: the expectation's frame, else the report; two different ids name none",
    setNodeId(dir, "Beds") === "1:1" && setNodeId(dir, "Beds@320") === "1:1" && setNodeId(dir, "Mixed") === null && setNodeId(dir, "Nothing") === null);
  check("canonicalStemsFor / existingStem: the one grammar-named stem of the node", JSON.stringify(canonicalStemsFor(dir, "1:1")) === JSON.stringify(["Plots__1_1"]) && existingStem(dir, "1:1") === "Plots__1_1" && existingStem(dir, "2:2") === null);
  check(`legacySetsFor: the live legacy-named sets of the node (got ${JSON.stringify(legacySetsFor(dir, "1:1"))})`, JSON.stringify(legacySetsFor(dir, "1:1")) === JSON.stringify(["Beds", "Beds@320"]) && JSON.stringify(legacySetsFor(dir, "2:2")) === JSON.stringify(["Sheds"]));
  put(path.join(dir, "Yard__1_1.report.json"), { nodeId: "1:1" });
  check("two grammar-named stems for one node: existingStem names neither", existingStem(dir, "1:1") === null && canonicalStemsFor(dir, "1:1").length === 2);
  check("a verify dir that does not exist holds no sets", allSets(path.join(dir, "missing")).length === 0 && existingStem(path.join(dir, "missing"), "1:1") === null);
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
  check(`a whitespace-insensitive hit names no key (got ${keyOf(fold)})`, fold.status === "unresolved" && /only ignoring spaces/.test(fold.why));
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
  check("a legacy-named set of the node counts as another name (run --migrate)", legacy.status === "unresolved" && /Sheds/.test(legacy.why) && /--migrate/.test(legacy.why));
  fs.rmSync(root, { recursive: true, force: true });
}

report();
