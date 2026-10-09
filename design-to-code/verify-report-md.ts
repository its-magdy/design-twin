// verify-report-md.ts — how a verify-screen --compare report reads: reportToMarkdown() renders <Screen>.report.md (the
// headlines, what was checked, the behaviour and visual sections, the previous round, the grouped causes and every list),
// and probeLine() is the stderr line naming the probe and how the nodes were matched. Rendering only: every number comes
// from the report compare() built (verify-compare.ts). A library: the CLI is verify-screen.ts.
import type { BehaviourCheck, ReportBehaviour, ReportVisual, VerifyDelta, VerifyReport, VerifyReportV2 } from "./types.ts";
import { getOrInit } from "./map-util.ts";
import { fmt, pctText } from "./verify-shared.ts";
import { MATCH_BUCKETS, MATCH_LABEL, NAMES_LABEL, VISUAL_NOT_APPLICABLE } from "./verify-compare.ts";

/** The census as "tag 3 · text 1 · ordinal 0 · position 0" (the four the probe always reports, then any other non-zero bucket). */
function matchedLine(census: Record<string, number> | undefined): string {
  const c = census || {};
  const always = ["tag", "text", "textOrdinal", "position"];
  const keys = [...always, ...MATCH_BUCKETS.filter((b) => !always.includes(b) && (c[b] ?? 0) > 0)];
  return keys.map((k) => `${MATCH_LABEL[k] ?? k} ${c[k] ?? 0}`).join(" · ");
}
/**
 * The second stderr line after the headline: which probe produced the numbers, and how the nodes
 * were found. `probe verify-probe 1.2.3 (sha 1a2b3c4d5e6f…) · playwright 1.63.0 · chromium 140.0 · matched: tag N · text N · ordinal N · position N`.
 */
export function probeLine(r: Pick<VerifyReport, "inputs" | "coverage">): string {
  const p = r.inputs && r.inputs.probe;
  const who = p && p !== "unknown"
    ? `probe ${p.name} ${p.version ?? "(no version)"} (sha ${p.sha256.slice(0, 12)}…) · ${p.playwright.package} ${p.playwright.version} · ${p.browser.name} ${p.browser.version}`
    : "probe unknown (hand-written — not comparable round to round)";
  return `${who} · matched: ${matchedLine(r.coverage && r.coverage.matchedBy)}`;
}

const VISUAL_MD_ROWS = 10;
/** The md section "Visual diff — informational, not part of the verdict". */
function visualMarkdown(v: ReportVisual): string[] {
  const L: string[] = ["## Visual diff — informational, not part of the verdict", ""];
  L.push("*The pixel diff never changes the fidelity verdict above. Font rasterisation alone differs 1–3% on text-heavy screens (Figma's renderer vs Chromium), so read the regions, not the percentage.*", "");
  if (!v.ran) {
    L.push(v.why === VISUAL_NOT_APPLICABLE ? "Not applicable (no web probe)." : `Not run (${mdText(v.why) || "no reason recorded"}).`, "");
    return L;
  }
  L.push(`${pctText(v.shiftTolerantPct ?? 0)}% of the compared pixels differ after the shift tolerance (${pctText(v.differingPct ?? 0)}% before it; anti-aliased edge pixels excluded) · ${v.regionsTotal ?? v.regions.length} hot region(s).`, "");
  if (v.reference) L.push(`Reference: ${mdText(v.reference.path)} at ${v.scale ?? "?"}x (geometry from the ${v.reference.from === "index" ? "export index" : "export root, recomputed"}).`, "");
  if (v.grid === "1x") L.push("Grid: **resampled to 1x** — the capture and the reference crop differ by more than 2 px, so both were resampled to the design size (up or down); resampling can hide a difference.", "");
  else if (v.grid) L.push("Grid: the reference's own pixel grid (the build rendered at the reference's scale).", "");
  if (v.reference && v.reference.colorProfile) L.push(`Colour profile: ${mdText(v.reference.colorProfile)} — colours are compared without colour management, so colour differences are unreliable.`, "");
  if (v.regions.length) {
    L.push("| Region (x, y) | Size | Differ | Built nodes | Designed nodes |", "|---|---|---|---|---|");
    for (const g of v.regions.slice(0, VISUAL_MD_ROWS)) {
      L.push(`| ${Math.round(g.rect.x)}, ${Math.round(g.rect.y)} | ${Math.round(g.rect.w)}×${Math.round(g.rect.h)} | ${pctText(g.pct)}% (${g.pixels} px) | ${g.built.map(mdText).join(", ")} | ${g.designed.map(mdText).join(", ")} |`);
    }
    const total = v.regionsTotal ?? v.regions.length;
    if (total > Math.min(v.regions.length, VISUAL_MD_ROWS)) L.push(`| …and ${total - Math.min(v.regions.length, VISUAL_MD_ROWS)} more (the largest are listed) | | | | |`);
    L.push("");
  }
  if (v.diff) L.push(`Diff image: ${mdText(v.diff.path)}${v.diff.exists ? "" : " (missing on disk)"}`, "");
  if (v.against) L.push(`Against the previous round (${mdText(v.against.report)}): visual: ${pctText(v.against.before)} % → ${pctText(v.against.after)} % (same reference, same grid; never the verdict).`, "");
  for (const n of v.notes) L.push(`- ${mdText(n)}`);
  if (v.notes.length) L.push("");
  return L;
}

// behaviour text comes from the page (accessible names, text, element paths like "body > div > <span>") — escaped
// for markdown AND inline HTML, so "focus went to <body>" never renders as "focus went to ", and a | or newline never
// breaks the table. No code spans: a backtick inside one cannot be escaped.
export const mdText = (x: string | undefined): string => (x ?? "").replace(/\r?\n|\r/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/\|/g, "\\|").replace(/`/g, "\\`");
const behaviourWhere = (c: BehaviourCheck): string => [c.nodeId ? mdText(c.nodeId) : "", c.trigger ? `(${mdText(c.trigger)})` : "", c.target ? mdText(c.target) : ""].filter(Boolean).join(" ");
const BEHAVIOUR_MD_ROWS = 80;
/** The md section "Behaviour and accessibility — not part of the verdict". */
function behaviourMarkdown(b: ReportBehaviour): string[] {
  const L: string[] = ["## Behaviour and accessibility — not part of the verdict", ""];
  L.push("*These checks never change the fidelity verdict above. A failed check is still a measurable accessibility failure: fix it or raise a designer question.*", "");
  if (!b.ran) {
    L.push(`Not run (${mdText(b.why) || "no reason recorded"}).`, "");
    return L;
  }
  const s = b.summary;
  L.push(`${s.fail} fail · ${s.warn} warn · ${s.pass} pass · ${s.notRun} not run${s.unsupported ? ` · ${s.unsupported} unsupported` : ""}`, "");
  const fails = b.checks.filter((c) => c.status === "fail");
  if (fails.length) {
    L.push(`### Failed (${fails.length})`, "");
    for (const c of fails) L.push(`- **${mdText(c.id)}**${behaviourWhere(c) ? ` ${behaviourWhere(c)}` : ""}${c.variant ? ` [${mdText(c.variant)}]` : ""} — ${mdText(c.detail)}`);
    L.push("");
  }
  if (b.checks.length) {
    L.push("| Status | Check | Node/target | Variant | Detail |", "|---|---|---|---|---|");
    for (const c of b.checks.slice(0, BEHAVIOUR_MD_ROWS)) L.push(`| ${c.status} | ${mdText(c.id)} | ${behaviourWhere(c)} | ${mdText(c.variant)} | ${mdText(c.detail)}${c.synthetic ? " *(synthetic (headless), not a real-browser observation)*" : ""} |`);
    if (b.checks.length > BEHAVIOUR_MD_ROWS) L.push(`| …and ${b.checks.length - BEHAVIOUR_MD_ROWS} more (report.json lists all) | | | | |`);
    L.push("");
  }
  L.push(`Accessible names: ${NAMES_LABEL}${b.namesComputedBy ? ` (${mdText(b.namesComputedBy)})` : ""}.`, "");
  if (b.axe) L.push("version" in b.axe ? `axe-core ${mdText(b.axe.version)} ran on the main frame (iframes not scanned): critical/serious violations fail, moderate/minor warn.` : `axe-core: not run — ${mdText(b.axe.notRun)}.`, "");
  if (b.artifacts && b.artifacts.length) L.push(`Behaviour artifacts: ${b.artifacts.map(mdText).join(", ")}`, "");
  if (b.writeBlock) L.push(`Write block: ${mdText(b.writeBlock)}`, "");
  return L;
}

export function reportToMarkdown(r: VerifyReportV2): string {
  const L: string[] = [];
  L.push(`# Verify — ${r.screen}`, "");
  L.push(`**${r.headline || r.verdict.toUpperCase()}**`, "");
  L.push(`**${mdText(r.behaviour.headline)}**`, "");
  L.push(mdText(r.visual.headline), "");
  L.push(`renderer ${r.renderer}${r.viewport ? ` at ${typeof r.viewport === "object" ? JSON.stringify(r.viewport) : r.viewport}` : ""} · measured ${r.measuredAt}` +
    (r.inputs && r.inputs.expectationSha256 ? ` · against expectation ${r.inputs.expectationSha256.slice(0, 12)}…` : "") + (r.inputs && r.inputs.runId ? ` · run ${r.inputs.runId}` : ""), "");
  // how the probe reached the screen (never the verdict)
  const rc = r.inputs && r.inputs.reach;
  if (rc) L.push(`Reached by ${rc.steps} step(s) (sha ${rc.sha256.slice(0, 12)}…, ${rc.source})${rc.matchesPlan === true ? " — the plan's navigate" : rc.matchesPlan === false ? " — **not the plan's navigate**" : ""}.`, "");
  // which build was served (a stale preview measures old code)
  const b = r.inputs && r.inputs.build;
  L.push(b && b !== "unknown"
    ? `Build served: ${b.mode} ${b.url} · ${b.assets} asset(s), sha256 ${b.assetsSha256.slice(0, 12)}…${b.unhashed ? ` (partial: ${b.unhashed} body(ies) not hashed)` : ""} · git ${b.gitHead ? b.gitHead.slice(0, 12) : "none"}${b.gitDirty ? " (uncommitted changes)" : ""}`
    : "Build served: build identity unknown (the measured file records none — measured by a hand-written or older probe).", "");
  if (r.why.length) {
    L.push("Why this is not a pass:", "");
    for (const w of r.why) L.push(`- ${w}`);
    L.push("");
  }
  const c = r.coverage;
  L.push("## What was actually checked", "");
  L.push("| | |", "|---|---|");
  L.push(`| node specs measured | ${c.nodesMeasured} / ${c.nodesExpected}${c.nodesMatchedByComponentPath ? ` (${c.nodesMatchedByComponentPath} via a shared component's internal path)` : ""}${c.nodesFolded ? ` (+${c.nodesFolded} folded into a measured ancestor, out of the count)` : ""} |`);
  if (c.sharedShell) L.push(`| of which in a shared shell (informational — matched through another screen's id, or plan anchors[id].shared) | ${c.sharedShell.measured} / ${c.sharedShell.expected} in ${c.sharedShell.instances.map((i) => `${i.name} \`${i.nodeId}\` ${i.measured}/${i.expected}`).join(", ")} |`);
  L.push(`| individual values compared | ${c.fieldsChecked} |`);
  L.push(`| values on measured nodes the probe did not report | ${c.fieldsNotMeasured} |`);
  if (c.fieldsNeverMeasured.length) L.push(`| **fields present in 0 measurements** | ${c.fieldsNeverMeasured.map((f) => `\`${f.field}\`${f.probeSent ? ` (probe sent \`${f.probeSent.join("`, `")}\`)` : ""}`).join(", ")} |`);
  L.push(`| design values excluded by method (listed below) | ${c.valuesNotComparable} |`);
  L.push(`| values the method cannot read unaided | ${c.valuesUnverifiable} |`);
  if (c.hiddenLayersSkipped) L.push(`| hidden layers skipped (not built, not measured, not driven) | ${c.hiddenLayersSkipped.layers} layer(s) · ${c.hiddenLayersSkipped.specsSkipped} spec(s) · ${c.hiddenLayersSkipped.instancesSkipped} instance(s) · ${c.hiddenLayersSkipped.interactionsSkipped} interaction(s) |`);
  L.push(`| instance sets the probe could point at (data-dt-node / component evidence — coverage, NOT presence) | ${c.instanceSetsWithEvidence} / ${c.instanceSets} |`);
  L.push(`| designed interactions: pass / fail / not-probed | ${c.interactionsPassed} / ${c.interactionsFailed} / ${c.interactionsNotProbed} of ${c.interactionsExpected}` +
    `${c.interactionsUndesigned ? ` · ${c.interactionsUndesigned} undesigned (destination never exported)` : ""}${c.interactionsDescoped ? ` · ${c.interactionsDescoped} descoped by the owner` : ""}` +
    `${c.interactionsByProbe ? ` · ${c.interactionsByProbe} driven by the shipped probe (dialog contract)` : ""} |`);
  if (c.pageOverflow !== undefined) L.push(`| page overflow at the design width (overflowX) | ${c.pageOverflow} |`);
  if (c.deltasAccepted) L.push(`| value mismatches accepted by a plan waiver (listed, out of the counts) | ${c.deltasAccepted} |`);
  L.push("");
  L.push(...behaviourMarkdown(r.behaviour));
  L.push(...visualMarkdown(r.visual));
  if (r.against) {
    const a = r.against;
    L.push(`Against the previous round (${a.report}): nodes measured ${a.nodesMeasured.before ?? "?"} → ${a.nodesMeasured.after}, expected ${a.nodesExpected.before ?? "?"} → ${a.nodesExpected.after}` +
      `${a.probeChanged === true ? " · **the probe changed**" : a.probeChanged === null ? " · probe identity unknown on both rounds" : ""}${a.expectationChanged ? " · the expectation changed" : ""}. This never changes the verdict.`, "");
    const d = a.deltas;
    if (d && d.sameMeasured) {
      const rc = d.reclassified || [];
      L.push(`Previous deltas (node + field): **the same measured file as last round** — nothing about the build changed, so nothing is fixed, new or lost; ${d.unchanged} still open` +
        `${rc.length ? `, ${rc.length} reclassified by the compare (or the expectation): ${rc.filter((x) => x.change === "gone").length} no longer a delta, ${rc.filter((x) => x.change === "new").length} newly a delta` : ""}.`, "");
      if (rc.length) {
        L.push(`## Reclassified (${rc.length})`, "", "*Same measured file — the compare changed, not the build.*", "", "| Node | Field | Change | Was |", "|---|---|---|---|");
        for (const x of rc.slice(0, 40)) L.push(`| \`${x.nodeId}\` | ${x.field} | ${x.change === "gone" ? "no longer a delta" : "newly a delta"} | ${x.change === "gone" ? fmt(x.was) : ""} |`);
        if (rc.length > 40) L.push(`| …and ${rc.length - 40} more | | | |`);
        L.push("");
      }
    } else if (d) {
      const nu = d.nowUnverifiable || [];
      L.push(`Previous deltas (node + field): ${d.fixed} fixed · ${d.unchanged} still open · ${d.new} new · ${d.lostCoverage.length ? `**${d.lostCoverage.length} lost coverage** (gone only because they were not measured this round)` : "0 lost coverage"}` +
        `${nu.length ? ` · ${nu.length} now unverifiable by method (measured, but the compare no longer reads it)` : ""}.`, "");
      if (nu.length) {
        L.push(`## Now unverifiable by method (${nu.length})`, "", "*A previous delta whose value was measured this round, but the compare now declines it — not lost coverage, not a fix.*", "", "| Node | Field | Was | Why |", "|---|---|---|---|");
        for (const x of nu.slice(0, 40)) L.push(`| \`${x.nodeId}\` | ${x.field} | ${fmt(x.was)} | ${x.why} |`);
        if (nu.length > 40) L.push(`| …and ${nu.length - 40} more | | | |`);
        L.push("");
      }
    }
    if (a.sameBuild === true && r.headline.includes("SAME BUILD SERVED")) L.push("**The same build was served as last round although the code changed** — a stale preview or dist? Rebuild before measuring a preview.", "");
    if (d && d.lostCoverage.length) {
      L.push(`## Lost coverage (${d.lostCoverage.length})`, "", "*A previous delta that is gone only because its node or value was not measured — not a fix.*", "", "| Node | Field | Was | Why |", "|---|---|---|---|");
      for (const x of d.lostCoverage.slice(0, 40)) L.push(`| \`${x.nodeId}\` | ${x.field} | ${fmt(x.was)} | ${x.why} |`);
      if (d.lostCoverage.length > 40) L.push(`| …and ${d.lostCoverage.length - 40} more | | | |`);
      L.push("");
    }
  }
  L.push("## How nodes were matched", "");
  const ip = r.inputs && r.inputs.probe;
  L.push(ip && ip !== "unknown" ? `Probe: ${ip.name} ${ip.version ?? "(no version)"} · sha256 ${ip.sha256.slice(0, 12)}… · ${ip.playwright.package} ${ip.playwright.version} · ${ip.browser.name} ${ip.browser.version}` : "Probe: unknown (a hand-written measured.json — its numbers are not comparable round to round).", "");
  L.push("| rule | node specs |", "|---|---|");
  for (const b of MATCH_BUCKETS) if ((c.matchedBy[b] ?? 0) > 0 || b === "tag") L.push(`| ${MATCH_LABEL[b] ?? b} | ${c.matchedBy[b] ?? 0} |`);
  L.push("");
  if (r.deltas.length) {
    // one line per cause first (a group = one cause, many rows); the table still lists every row.
    const groups = new Map<string, VerifyDelta[]>();
    for (const d of r.deltas) if (d.group) getOrInit(groups, d.group, () => []).push(d);
    if (groups.size) {
      L.push(`## Grouped causes (${groups.size})`, "", "*Presentational: every row still counts on its own.*", "");
      for (const [g, list] of groups) {
        const rootId = g.startsWith("placement:") ? g.slice("placement:".length) : null;
        const root = rootId ? list.find((d) => d.nodeId === rootId) : undefined;
        const open = list.filter((d) => !d.accepted);
        L.push(`- \`${g}\` — ${list[0]?.field ?? ""}, **${list.length} rows**${root ? ` (${root.name || root.nodeId} and ${list.length - 1} inside it)` : ` (${fmt(list[0]?.expected)} → ${fmt(list[0]?.actual)})`}` +
          `${open.length < list.length ? ` · ${list.length - open.length} accepted` : ""} — accept together: \`--accept <report> --group ${g} --reason … --by …\``);
      }
      L.push("");
    }
    L.push(`## Value mismatches (${r.deltas.length})`, "", "| Severity | Node | Field | Expected | Actual | Token | Group / accepted |", "|---|---|---|---|---|---|---|");
    for (const d of r.deltas) {
      const status = d.accepted ? `accepted — ${d.accepted.reason} (${d.accepted.decidedBy}, ${d.accepted.decidedAt})` : d.group ? `\`${d.group}\`` : "";
      L.push(`| ${d.accepted ? `~~${d.severity}~~` : d.severity} | ${d.name || ""} \`${d.nodeId}\` | ${d.field} | ${withUnit(d.expected, d.unit)} | ${withUnit(d.actual, d.unit)} | ${d.token || "—"} | ${status} |`);
    }
    L.push("");
  }
  const wv = r.waivers;
  if (wv && (wv.reopened.length || wv.unused.length)) {
    L.push("## Plan waivers that no longer apply", "");
    for (const w of wv.reopened) L.push(`- **reopened** \`${w.nodeId}\` (${w.field}) — ${w.why}`);
    for (const w of wv.unused) L.push(`- unused \`${w.nodeId}\` (${w.field})${w.why ? ` — ${w.why}` : ""}`);
    L.push("");
  }
  if (r.folded && r.folded.length) {
    L.push(`## Folded into a measured ancestor (${r.folded.length} node specs, out of the count)`, "");
    for (const f of r.folded) L.push(`- \`${f.nodeId}\` ${f.name || ""} → \`${f.into}\` — ${f.why}`);
    L.push("");
  }
  if (r.componentsAbsent.length) {
    L.push(`## Components the probe reported ABSENT (${r.componentsAbsent.length})`, "");
    for (const m of r.componentsAbsent) L.push(`- **${m.setName}** — e.g. \`${m.nodeIds[0]}\`${m.detail ? ` — ${m.detail}` : ""}`);
    L.push("");
  }
  if (r.untaggedInstanceSets.length) {
    L.push(`## Instance sets with no evidence in the probe (${r.untaggedInstanceSets.length})`, "",
      "*Tag coverage, not presence: these carry no `data-dt-node` and no reported setName. They may well be built — a repeated row rendered by one `.map()` or a shared shell is expected to leave gaps here. Not a failure on its own.*", "");
    for (const m of r.untaggedInstanceSets.slice(0, 40)) L.push(`- ${m.setName} — ${m.instances} instance(s), e.g. \`${m.nodeIds[0]}\``);
    if (r.untaggedInstanceSets.length > 40) L.push(`- …and ${r.untaggedInstanceSets.length - 40} more`);
    L.push("");
  }
  const inShell = r.untaggedInstanceSetsInShell || [];
  if (inShell.length) {
    L.push(`## Instance sets with no evidence, inside the shared shell (${inShell.length})`, "", "*Built once for every screen — listed apart, not this screen's work. Not a failure on its own.*", "");
    for (const m of inShell.slice(0, 40)) L.push(`- ${m.setName} — ${m.instances} instance(s), e.g. \`${m.nodeIds[0]}\``);
    if (inShell.length > 40) L.push(`- …and ${inShell.length - 40} more`);
    L.push("");
  }
  const bad = r.interactions.filter((i) => i.result === "fail" || i.result === "not-probed");
  if (bad.length) {
    L.push(`## Designed interactions not confirmed (${bad.length})`, "");
    for (const i of bad) L.push(`- \`${i.nodeId}\` ${i.name || ""} — ${i.trigger} → ${i.action}${i.destinationId ? ` (${i.destinationId})` : ""}${i.source === "plan" ? " [plan]" : ""}: **${i.result}**${i.detail ? ` — ${i.detail}` : ""}`);
    L.push("");
  }
  // a result filed under a node + trigger nothing designed — never graded, so it never helped the verdict
  const um = (r.probe && r.probe.unmatchedInteractionEvidence) || [];
  if (um.length) {
    L.push(`## Probe results that matched no designed interaction (${um.length})`, "", "*Copy nodeId and trigger verbatim from the expectation's interactions[]; these results were not graded.*", "");
    for (const u of um.slice(0, 40)) L.push(`- \`${u.nodeId}\` ${u.trigger}${u.hint ? ` — ${u.hint}` : ""}`);
    if (um.length > 40) L.push(`- …and ${um.length - 40} more`);
    L.push("");
  }
  const ungraded = r.interactions.filter((i) => i.result === "undesigned" || i.result === "descoped");
  if (ungraded.length) {
    L.push(`## Interactions not graded (${ungraded.length})`, "", "*undesigned: the destination was never exported; descoped: the owner removed it (plan.descopes).*", "");
    for (const i of ungraded) L.push(`- \`${i.nodeId}\` ${i.name || ""} — ${i.trigger} → ${i.action}${i.destinationId ? ` (${i.destinationId})` : ""}: **${i.result}**${i.detail ? ` — ${i.detail}` : ""}${i.note ? ` — ${i.note}` : ""}`);
    L.push("");
  }
  const inf = r.inferred || [];
  if (inf.length) {
    L.push(`## Inferred, not designed (${inf.length})`, "", "*What the build does that the design never drew — judged against best practice and the design's intent, never 'matched'. Not part of the verdict.*", "");
    for (const x of inf.slice(0, 40)) {
      const what = [x.trigger, x.state ? `state ${x.state}` : undefined].filter((v): v is string => !!v).join(", ");
      L.push(`- ${x.nodeId ? `\`${x.nodeId}\` ` : ""}${x.name ? `${mdText(x.name)} ` : ""}[${x.kind}]${what ? ` ${mdText(what)}` : ""}${x.built ? ` — built: ${mdText(x.built)}` : ""} — ${mdText(x.why)}`);
    }
    if (inf.length > 40) L.push(`- …and ${inf.length - 40} more`);
    L.push("");
  }
  if (r.notMeasured.length) {
    L.push(`## Not measured (${r.notMeasured.length} node specs)`, "", "*Gaps in the probe, not clean results.*", "");
    for (const n of r.notMeasured.slice(0, 40)) L.push(`- \`${n.nodeId}\` ${n.name || ""} — ${n.why}`);
    if (r.notMeasured.length > 40) L.push(`- …and ${r.notMeasured.length - 40} more`);
    L.push("");
  }
  if (r.fieldsNotMeasured.length) {
    L.push(`## Values the probe did not report on measured nodes (${r.fieldsNotMeasured.length})`, "");
    for (const n of r.fieldsNotMeasured.slice(0, 40)) L.push(`- \`${n.nodeId}\` ${n.name || ""} (${n.field}) — ${n.why}`);
    if (r.fieldsNotMeasured.length > 40) L.push(`- …and ${r.fieldsNotMeasured.length - 40} more`);
    L.push("");
  }
  if (r.notComparable.length || r.unverifiable.length) {
    L.push(`## Excluded by method (${r.notComparable.length + r.unverifiable.length})`, "", "*Stated so they are not mistaken for passes.*", "");
    // (an `unverifiable` row carries `expected`, not `value` — only a notComparable row prints one)
    for (const n of [...r.unverifiable, ...r.notComparable].slice(0, 40)) L.push(`- \`${n.nodeId}\` ${n.name || ""} (${n.field}${"value" in n && n.value !== undefined ? ` ${fmt(n.value)}` : ""}) — ${n.why}`);
    if (r.notComparable.length + r.unverifiable.length > 40) L.push(`- …and ${r.notComparable.length + r.unverifiable.length - 40} more`);
    L.push("");
  }
  const p: Partial<VerifyReportV2["probe"]> = r.probe || {};
  if ((p.unknownKeys && p.unknownKeys.length) || (p.unknownTopLevelKeys && p.unknownTopLevelKeys.length) || p.duplicateNodeIds || p.interactionEvidenceOnHiddenLayers || p.measuredIdsOnHiddenLayers || p.measuredIdsNotInExpectation || p.foreignTags || (p.inputNotes && p.inputNotes.length)) {
    L.push("## About the probe's input", "");
    for (const k of p.unknownKeys || []) L.push(`- key \`${k.key}\` (${k.count}×) is not read by verify-screen${k.canonical ? ` — the canonical key is \`${k.canonical}\`` : ""}`);
    for (const k of p.unknownTopLevelKeys || []) L.push(`- top-level key \`${k.key}\` is not read by verify-screen${k.canonical ? ` — the canonical key is \`${k.canonical}\`` : ""}`);
    if (p.duplicateNodeIds) L.push(`- ${p.duplicateNodeIds} duplicate node id(s) in nodes[] — the first measurement of each id was used`);
    if (p.measuredIdsOnHiddenLayers) L.push(`- ${p.measuredIdsOnHiddenLayers} measurement(s) are for hidden layers and were ignored`);
    for (const n of p.inputNotes || []) L.push(`- ${n}`);
    if (p.measuredIdsNotInExpectation) L.push(`- ${p.measuredIdsNotInExpectation} measured node id(s) are not in the expectation (e.g. ${(p.measuredIdsNotInExpectationSample || []).map((id) => `\`${id}\``).join(", ")}) — measured against another screen or an older expectation?`);
    if (p.interactionEvidenceOnHiddenLayers) L.push(`- ${p.interactionEvidenceOnHiddenLayers} interaction result(s) are for hidden layers and were ignored — a hidden layer cannot be driven`);
    const ft = p.foreignTags;
    if (ft) L.push(`- ${ft.total} tag(s)/id(s) on the page name no node of this expectation (informational): ${ft.prefixDrift} prefix drift (an expected node's \`;\` path under another instance id — a stale or other screen's id table?), ${ft.alias} another screen's id for one of these nodes (alias), ${ft.unknown} unknown${ft.sample.length ? ` — e.g. ${ft.sample.map((id) => `\`${id}\``).join(", ")}` : ""}`);
    L.push("");
  }
  L.push("## Limits of this method", "");
  for (const l of r.limits || []) L.push(`- ${l}`);
  return L.join("\n") + "\n";
}
// A value that already ends in its unit is printed once (a probe's "28px" must not print as "28pxpx").
const withUnit = (v: unknown, unit: string | undefined): string => { const t = fmt(v); return unit && !t.endsWith(unit) ? t + unit : t; };
