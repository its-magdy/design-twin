// test/node-artefacts.test.ts — which plan / verify sets / audit report belong to a node, which node an artefact is of,
// and the one "one node, one X" refusal (design-to-code/node-artefacts.ts), on temp projects at the module's interface.
// Every CLI that names, finds or refuses a node's artefacts asks this module, so its rules are tested here once.
// Run with:  bun test/node-artefacts.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nodeArtefacts, planNode } from "../design-to-code/node-artefacts.ts";
import { planRows } from "../design-to-code/resolve-screen-core.ts";
import { writeStatus } from "../design-to-code/verify-run.ts";
import { check, report } from "./assert.ts";

/** A temp project: `put` writes a JSON (or raw text) file under it. */
function project(): { root: string; put: (rel: string, doc: unknown) => string; done: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dt-node-artefacts-"));
  const put = (rel: string, doc: unknown): string => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, typeof doc === "string" ? doc : JSON.stringify(doc));
    return rel;
  };
  return { root, put, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- the node a plan is of
console.log("planNode — a plan's node: its nodeId, else the id its own file name carries; never a name it holds:");
{
  check("[plan-node] nodeId wins over the id its file name carries", planNode({ nodeId: "9:9" }, "design/plan/Bins__1_1.json") === "9:9");
  check("[plan-node] no nodeId: the id its file name carries", planNode({}, "design/plan/Bins__1_1.json") === "1:1");
  check("[plan-node] an instance sublayer's id in the file name", planNode({}, "design/plan/Chip__I5_2_30_7.json") === "I5:2;30:7");
  check("[plan-node] a `screen` or `file` header naming a node is no identity: null", planNode({ screen: "Bins__1_1", file: "pages/P/Bins__1_1.json" }, "design/plan/Bins.json") === null);
}

console.log("plans / plansOf / idlessPlans — every plan of the plan dir, by that one rule:");
{
  const p = project();
  p.put("design/plan/A__1_1.json", {});
  p.put("design/plan/B.json", { nodeId: "1:1" });
  p.put("design/plan/C.json", { screen: "C__1_1" });
  p.put("design/plan/D__1_1.json", { nodeId: "3:3" });
  p.put("design/plan/broken.json", "{ not json");
  p.put("design/plan/notes.md", "# not a plan");
  const art = nodeArtefacts(p.root);
  const { plans, bad } = art.plans();
  check("[plans] every readable *.json plan, sorted, with its node", same(plans.map((x) => [x.file, x.nodeId]),
    [["design/plan/A__1_1.json", "1:1"], ["design/plan/B.json", "1:1"], ["design/plan/C.json", null], ["design/plan/D__1_1.json", "3:3"]]));
  check("[plans] an unreadable plan is reported with why, never dropped", bad.length === 1 && bad[0]?.file === "design/plan/broken.json" && /not valid JSON/.test(bad[0].error));
  check("[plans] plansOf(1:1): by nodeId and by file name (D__1_1 is 3:3's — its nodeId wins)", same(art.plansOf("1:1").map((x) => x.file), ["design/plan/A__1_1.json", "design/plan/B.json"]));
  check("[plans] idlessPlans: the plans that name no node", same(art.idlessPlans(), ["design/plan/C.json"]));
  // resolve-screen reads the plan header through the same rule (it used to take `nodeId` only)
  check("[plans] resolve-screen's plan rows take a plan's node by the same rule", planRows(path.join(p.root, "design/plan")).find((r) => r.file === "A__1_1.json")?.nodeId === "1:1");
  const elsewhere = nodeArtefacts(p.root, { planDir: path.join(p.root, "nowhere") });
  check("[plans] a plan dir that does not exist holds none", elsewhere.plans().plans.length === 0 && elsewhere.idlessPlans().length === 0);
  p.done();
}

// ---------------------------------------------------------------- the node a verify set is of
console.log("setNode — a set's node: the one id its name, expectation and report carry (two: none):");
{
  const p = project();
  p.put("design/verify/Agree__1_1.expected.json", { frame: { nodeId: "1:1" } });
  p.put("design/verify/Agree__1_1.report.json", { nodeId: "1:1" });
  p.put("design/verify/Clash__1_1.expected.json", { frame: { nodeId: "1:1" } });
  p.put("design/verify/Clash__1_1.report.json", { nodeId: "2:2" });
  p.put("design/verify/Named__4_4.report.json", { screen: "Named" });
  p.put("design/verify/Nickname.expected.json", { frame: { nodeId: "5:5" } });
  p.put("design/verify/Renamed__6_6.expected.json", { frame: { nodeId: "7:7" } });
  const art = nodeArtefacts(p.root);
  check("[set-node] expectation and report agree", art.setNode("Agree__1_1") === "1:1");
  check("[set-node] expectation and report disagree: no node (never one of the two)", art.setNode("Clash__1_1") === null);
  check("[set-node] …and it holds BOTH nodes: a claim on either is refused, naming it",
    !art.claim("verify set", "1:1", { layerName: "Clash" }).ok && !art.claim("verify set", "2:2", { layerName: "Two" }).ok && art.setsOf("2:2").stems.includes("Clash__1_1"));
  check("[set-node] files that say nothing: the id the set name carries", art.setNode("Named__4_4") === "4:4");
  check("[set-node] a variant's name carries its stem's id", art.setNode("Named__4_4.dark") === "4:4");
  check("[set-node] a legacy-named set: its expectation's frame", art.setNode("Nickname") === "5:5");
  check("[set-node] files that disagree with the name: no node", art.setNode("Renamed__6_6") === null);
  const misnamed = art.claim("verify set", "7:7", { layerName: "Renamed" });
  check(`[set-node] setNode, setsOf and claim agree: a set named for 6:6 whose frame is 7:7 holds both, so neither gets a set past it (${misnamed.ok ? "ok" : misnamed.why})`,
    !misnamed.ok && misnamed.why === "node 7:7's verify set Renamed__6_6 also carries node 6:6 (its name, expectation and report disagree) — one node, one verify set: keep one node's files"
    && same(art.setsOf("7:7").stems, ["Renamed__6_6"]) && same(art.setsOf("6:6").stems, ["Renamed__6_6"]) && !art.claim("verify set", "6:6", { layerName: "Renamed" }).ok);
  check("[set-node] a legacy-named set of the node is listed, a variant's under its stem", same(art.setsOf("5:5"), { stems: [], legacy: ["Nickname"] }) && same(art.setsOf("4:4").stems, ["Named__4_4"]));
  p.put("design/verify/Gone.expected.json.retired", { frame: { nodeId: "4:4" } });
  check("[set-node] a retired set holds nothing", !art.setsOf("4:4").legacy.includes("Gone"));
  p.done();
}

console.log("setsOf / claim('verify set') — the stem a node's verify files take:");
{
  const p = project();
  p.put("design/verify/Old__5_6.expected.json", { frame: { nodeId: "5:6" } });
  p.put("design/verify/Nick.expected.json", { frame: { nodeId: "5:6" } });
  const art = nodeArtefacts(p.root);
  check("[sets] setsOf: grammar-named stems and legacy-named sets of the node", same(art.setsOf("5:6"), { stems: ["Old__5_6"], legacy: ["Nick"] }));
  const one = art.claim("verify set", "5:6", { layerName: "New" });
  check("[sets] one set of the node: its stem is fixed (a frame renamed in Figma keeps it); legacy sets listed", one.ok && one.name === "Old__5_6" && one.existing && same(one.legacy, ["Nick"]));
  const fresh = art.claim("verify set", "8:8", { layerName: "Fresh Screen" });
  check("[sets] no set of the node: <safe(layer)>__<id>, not existing", fresh.ok && fresh.name === "Fresh_Screen__8_8" && !fresh.existing);
  const other = art.claim("verify set", "5:6", { target: "New__5_6" });
  check(`[sets] a target name when the node has a set under another: refused, naming it — a legacy-named set never refuses (${other.ok ? "ok" : other.why})`,
    !other.ok && other.why === "node 5:6 already has a verify set (Old__5_6) — one node, one verify set");
  const mine = art.claim("verify set", "5:6", { target: "Old__5_6" });
  check("[sets] the node's own stem as the target: taken, the legacy sets listed", mine.ok && mine.existing && same(mine.legacy, ["Nick"]));
  p.put("design/verify/New__5_6.report.json", { nodeId: "5:6" });
  const two = art.claim("verify set", "5:6", { layerName: "New" });
  check(`[sets] two grammar-named sets of the node: refused, naming both (${two.ok ? "ok" : two.why})`,
    !two.ok && two.why === "node 5:6 has 2 verify sets (New__5_6, Old__5_6) — one node, one verify set: keep one" && same(two.holders, ["New__5_6", "Old__5_6"]));
  p.done();
}

console.log("claim('verify set') — a run open in the run cache names its set before any file of it exists:");
{
  const p = project();
  p.put("package.json", {});
  p.put("design/verify/Old_Trays__1_1.expected.json", { frame: { nodeId: "1:1" } });
  const verifyDir = path.join(p.root, "design/verify");
  const queued = nodeArtefacts(p.root, { openSets: ["New_Trays__1_1"] }).claim("verify set", "1:1", { layerName: "Seed Trays" });
  check(`[open-run] an open run's set is a stem of its node: two stems, refused (${queued.ok ? "ok" : queued.why})`,
    !queued.ok && queued.why === "node 1:1 has 2 verify sets (New_Trays__1_1, Old_Trays__1_1) — one node, one verify set: keep one");
  writeStatus(path.join(verifyDir, "New_Trays__1_1"), { runId: "run-t", phase: "queued", by: "agent" });
  const read = nodeArtefacts(p.root).claim("verify set", "1:1", { layerName: "Seed Trays" });
  check(`[open-run] read from the run cache: the refusal names the run and the command that ends it — no file of it is there to find (${read.ok ? "ok" : read.why})`,
    !read.ok && read.why.startsWith("node 1:1 has 2 verify sets (an open run run-t under New_Trays__1_1 (no file of it yet; end it: ")
    && read.why.includes("--status New_Trays__1_1 --phase failed --run run-t --dir ") && read.why.endsWith(", Old_Trays__1_1) — one node, one verify set: keep one"));
  check("[open-run] …and a new plan of the node has no stem to take", !nodeArtefacts(p.root).claim("plan", "1:1", { layerName: "Seed Trays" }).ok);
  p.done();
}

// ---------------------------------------------------------------- a node's plan
console.log("claim('plan') — a node has one plan, named by its node:");
{
  const p = project();
  const art = nodeArtefacts(p.root);
  const odd = art.claim("plan", "5:6", { layerName: "Sample A", target: "design/plan/my-plan.json" });
  check(`[plan] a new plan under another name: refused, naming <stem>.json (${odd.ok ? "ok" : odd.why})`,
    !odd.ok && odd.why === "a new plan of node 5:6 is named by its node: design/plan/Sample_A__5_6.json, not my-plan.json");
  const ok = art.claim("plan", "5:6", { layerName: "Sample A", target: "design/plan/Sample_A__5_6.json" });
  check("[plan] the new plan at <stem>.json is taken", ok.ok && ok.name === "design/plan/Sample_A__5_6.json" && !ok.existing);
  // the verify dir names the node by an older stem (the layer renamed since): the plan takes that stem
  p.put("design/verify/Older_Name__5_6.expected.json", { frame: { nodeId: "5:6" } });
  const stem = art.claim("plan", "5:6", { layerName: "Sample A" });
  check("[plan] the stem is the one the node's verify set already has", stem.ok && stem.name === "design/plan/Older_Name__5_6.json");
  // a plan of the node already there, by its nodeId: it is the plan, under any name
  p.put("design/plan/hand-named.json", { nodeId: "5:6" });
  const have = art.claim("plan", "5:6", { layerName: "Sample A" });
  check("[plan] an existing plan is the node's plan, whatever its name", have.ok && have.name === "design/plan/hand-named.json" && have.existing);
  const second = art.claim("plan", "5:6", { layerName: "Sample A", target: "design/plan/Older_Name__5_6.json" });
  check(`[plan] a second plan of the node: refused, naming the first (${second.ok ? "ok" : second.why})`,
    !second.ok && second.why === "node 5:6 already has a plan (design/plan/hand-named.json) — one node, one plan" && same(second.holders, ["design/plan/hand-named.json"]));
  const itself = art.claim("plan", "5:6", { target: path.join(p.root, "design/plan/hand-named.json") });
  check("[plan] the existing plan itself (spelt absolute) is taken", itself.ok && itself.existing);
  // by the id its file name carries (no nodeId) too
  p.put("design/plan/Older_Name__5_6.json", {});
  const two = art.claim("plan", "5:6", { layerName: "Sample A" });
  check(`[plan] two plans of the node: refused, naming both (${two.ok ? "ok" : two.why})`,
    !two.ok && two.why === "node 5:6 has 2 plans (design/plan/Older_Name__5_6.json, design/plan/hand-named.json) — one node, one plan: keep one");
  // another plan dir (plan-skeleton --out <dir>/<x>.json) is its own: the node's plans there, spelt as that dir is
  const other = path.join(p.root, "elsewhere");
  const there = nodeArtefacts(p.root, { planDir: other }).claim("plan", "5:6", { layerName: "Sample A" });
  check("[plan] a plan dir of its own: spelt as given", there.ok && there.name === path.join(other, "Older_Name__5_6.json"));
  // two verify sets of the node: no stem to name a new plan by
  p.put("design/verify/Sample_A__5_6.report.json", { nodeId: "5:6" });
  const stemless = nodeArtefacts(p.root, { planDir: other }).claim("plan", "5:6", { layerName: "Sample A" });
  check(`[plan] a node with two verify sets: no new plan (the set refusal) (${stemless.ok ? "ok" : stemless.why})`, !stemless.ok && /has 2 verify sets/.test(stemless.why));
  p.done();
}

// ---------------------------------------------------------------- a node's audit report
console.log("auditsOf / claim('audit report') — a node has one audit report pair:");
{
  const p = project();
  p.put("design/audit/positions___7314_87192.json", { nodeIds: ["7314:87192"], findings: [] });
  p.put("design/audit/positions___7314_87192.cross.json", { nodeIds: ["7314:87192"] });
  p.put("design/audit/Nickname.json", { nodeIds: ["1:1"], findings: [] });
  p.put("design/audit/Older__1_1.json", { findings: [] });
  p.put("design/audit/Wrong__1_1.json", { nodeIds: ["2:2"], findings: [] });
  p.put("design/audit/Empty__3_3.json", { nodeIds: [], findings: [] });
  const art = nodeArtefacts(p.root);
  check("[audit] auditsOf: by nodeIds[], else (none recorded) the id its name carries; a sidecar is never a report; nodeIds[] wins over the name",
    same(art.auditsOf("1:1"), ["design/audit/Nickname.json", "design/audit/Older__1_1.json"]) && same(art.auditsOf("7314:87192"), ["design/audit/positions___7314_87192.json"]));
  check("[audit] an empty nodeIds[] records no node, as an absent one: the file name's id", same(art.auditsOf("3:3"), ["design/audit/Empty__3_3.json"])
    && !art.claim("audit report", "3:3", { target: "design/audit/other.json" }).ok && art.auditFor("9:9", { screenName: "Empty" }) === null);
  const nick = art.claim("audit report", "7314:87192", { target: "design/audit/custom-name.json" });
  check(`[audit] a report under a new name for an audited node: refused, naming the existing one (${nick.ok ? "ok" : nick.why})`,
    !nick.ok && nick.why === "node 7314:87192 already has an audit report (design/audit/positions___7314_87192.json) — one node, one audit report");
  check("[audit] its own name again: taken", art.claim("audit report", "7314:87192", { target: "design/audit/positions___7314_87192.json" }).ok);
  check("[audit] a sidecar beside its own report: taken", art.claim("audit report", "7314:87192", { target: "design/audit/positions___7314_87192.library.json" }).ok);
  check("[audit] a node with no report: taken", art.claim("audit report", "9:9", { target: "design/audit/x.json" }).ok);
  p.done();
}

console.log("auditFor — the audit the build gate reads for a node:");
{
  const p = project();
  const art = nodeArtefacts(p.root);
  p.put("design/audit/Nickname.json", { nodeIds: ["1:1"], findings: [] });
  // the bug: a nickname report audit.ts counts as node 1:1's was invisible to the gate, which matched by name only
  check("[gate] a report under a nickname whose nodeIds[] has the node is that node's audit", art.auditFor("1:1", { screenName: "positions " }) === "design/audit/Nickname.json");
  fs.rmSync(path.join(p.root, "design/audit/Nickname.json"));
  p.put("design/audit/Jet_Roles__9_9.json", { nodeIds: ["9:9"], findings: [] });
  check("[gate] a report of ANOTHER node is never taken by name", art.auditFor("1:1", { screenName: "Jet Roles" }) === null);
  check("[gate] …but a plan that names no node still finds it by name", art.auditFor(null, { screenName: "Jet Roles" }) === "design/audit/Jet_Roles__9_9.json");
  fs.rmSync(path.join(p.root, "design/audit/Jet_Roles__9_9.json"));
  // the name fallback (reports that name no node): exact slug, either with or without the `__<id>` suffix — never a prefix
  p.put("design/audit/Jet_Roles_Detail__9_9.json", { findings: [] });
  p.put("design/audit/Job.json", { findings: [] });
  check("[gate] \"Jet Roles\" never takes Jet_Roles_Detail__9_9.json (longer name) nor Job.json (shorter)", art.auditFor(null, { screenName: "Jet Roles" }) === null);
  p.put("design/audit/Detail___Overview__8_8.json", { findings: [] });
  check("[gate] a doubled separator in the layer name: \"Detail\" does not match Detail___Overview__8_8, \"Detail - Overview\" does",
    art.auditFor(null, { screenName: "Detail" }) === null && art.auditFor(null, { screenName: "Detail - Overview" }) === "design/audit/Detail___Overview__8_8.json");
  p.put("design/audit/jet-roles.json", { findings: [] });
  check("[gate] the exact case/punctuation-insensitive name of a report naming no node", art.auditFor(null, { screenName: "Jet Roles" }) === "design/audit/jet-roles.json");
  check("[gate] the screen file's own basename wins first",
    art.auditFor(null, { screenFile: path.join(p.root, "design/export/pages/P/Jet_Roles_Detail__9_9.json"), screenName: "Jet Roles" }) === "design/audit/Jet_Roles_Detail__9_9.json");
  p.put("design/audit/Login__1_1.cross.json", { findings: [] });
  p.put("design/audit/Login__1_1.json", { findings: [] });
  check("[gate] by name, a sidecar is skipped and the report itself found", art.auditFor(null, { screenName: "Login" }) === "design/audit/Login__1_1.json");
  check("[gate] no audit dir: none", nodeArtefacts(path.join(p.root, "nowhere")).auditFor("1:1", { screenName: "Login" }) === null);
  p.done();
}

report();
