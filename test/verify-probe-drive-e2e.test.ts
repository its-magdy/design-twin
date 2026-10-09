// End-to-end tests for the probe half of the drive, the pooled cases: the BUILT claude-plugin/scripts/verify-probe.js (and the
// built verify-screen.js for --expect / --status / --compare) in a real chromium from a temp consumer project — the project,
// the "Plot Ledger" fixture, the server and the write accounting are test/drive-e2e-fixture.ts. The cases whose outcome rides on
// a few seconds of wall-clock live in test/verify-probe-drive-tail-e2e.test.ts, run one at a time (CI runs the two suites on
// separate runners).
//
// The Beds screen, reached by --steps: its openers driven and graded (a bound verify run's --compare), the same run with the
// behaviour battery on, a goto step and a small --max-time, a reload replaying the steps, a sideways strip, steps that must fail.
// The edge-case repros here (plot-ledger-edge.html, one ?mode= each): a link step, a destination wrapper already on screen +
// disabled / submitting openers, an absolute strip escaping a static clipping wrapper; a click step that navigates late, a
// step's navigation into a half-loaded document, tagged wrappers around a submitting button, a re-mounted destination wrapper,
// containing-block creators, a tagged wrapper taller than the viewport; a link to the URL the page shows (a refresh step),
// late / first / goto navigations into documents that never finish loading, documents without a token, an inline wrapper's
// first-line click point.
// Also: a DOM that never goes quiet, a late / never --ready, a slow image (the probe's own load waited for up
// to --timeout), a same-URL link handled in place then a late navigation away, a target=_top refresh link.
// Own-content detection: own content the earlier check missed (a reveal-on-scroll label, escaping positioned labels, an empty
// ::before logo or status dot, a mask icon, a swatch, a label 8000 elements deep), cell chrome it must not count (a hover tint,
// a filled wrapper, an off-document sr-only label), controls under a focusable glyph, <object> / <embed>.
// Own content by pixels: hover-revealed Deletes, dots / swatches / bands / tiles / form widgets
// drawn by pseudos, borders, shadows and fills, an out-of-flow reveal, overflow-clip-margin, a selection stripe, a tall card in a
// scrolled app shell, and the plain cells that stay driven.
// Also: clip-path / background-clip fills, a shadow host's dot, the container's own marker, a hug
// wrapper's shadow ring, a layered !important, a control mounted on hover, a foreign ticker, transition:all under a strict CSP.
//
// Concurrency (test/pool.ts): every probe / verify-screen run is queued up front (P, the longest first) and runs
// poolSize() at a time (DT_E2E_POOL overrides; 2 under CI) — each still its own `node verify-probe.js` + chromium with its
// own --out; the checks stay in file order, each awaiting its run. An ordered chain (--status --new-run → probe --run → --status
// done → --compare; a run → its --compare) is one queued task. The gotoSteps and wide runs stay pooled: their --max-time caps
// (25 s, 30 s) leave wide margins over a run that takes a few seconds under load.
//
// needs the repo's devDependency `playwright` + chromium. Locally an unavailable renderer prints SKIPPED; in CI
// (CI=true) that is a failure.  Run with:  node test/verify-probe-drive-e2e.test.ts
import { isJsonObject } from "../design-to-code/types.ts";
import type { VerifyMeasured, VerifyReport } from "../design-to-code/types.ts";
import { check, report } from "./assert.ts";
import { READY, ix, loadNote, out, startDriveFixture, stepsSha, type Run } from "./drive-e2e-fixture.ts";
import { limit, poolSize } from "./pool.ts";

const { url, edge, probe, vs, read, readReport, written, writes, writesOf, EXPECTED, QUIET, finish } =
  await startDriveFixture("dt-probe-drive-e2e-", "verify-probe drive e2e — the built bundles in a real chromium, from a temp project:");
const res = (r: VerifyReport | null, id: string): NonNullable<VerifyReport["interactions"]>[number] | undefined => (r?.interactions || []).find((i) => i.nodeId === id);

// ---- the runs (P): every one independent, queued now (the longest first) and run poolSize() at a time, each awaited where its checks are
const POOL = poolSize();
const q = limit(POOL);
const SLOW_NAV = [0, 120, 160, 200, 400, 1500] as const;
const ownPxOut = (mode: string): string => out(`OwnPixels-${mode.replace(/[^\w-]/g, "_")}`);
const ownPxRun = (mode: string): Promise<Run> => probe(["--expected", EXPECTED, "--url", edge(mode), "--out", ownPxOut(mode), "--max-time", "90000"]);
console.log(`pool ${POOL} (DT_E2E_POOL to override)`);
const P = {
  // the main run again with the behaviour battery on (the longest run: first) — its check compares with main's
  bedsOn: q(() => probe(["--expected", EXPECTED, "--url", url(), "--steps", "steps.json", "--ready", READY, "--out", out("BedsOn"), "--behaviour", "on"])),
  // the main run, bound to a verify run: --status --new-run → probe --run → --status done → --compare, in that order
  main: q(async () => {
    const st = await vs(["--status", "Beds", "--phase", "starting", "--new-run", "--dir", "design/verify"]);
    const runId = /^run (\S+) rev 1$/m.exec(st.stdout)?.[1] ?? "";
    const r2 = await probe(["--expected", EXPECTED, "--url", url(), "--steps", "steps.json", "--ready", READY, ...(runId ? ["--run", runId] : [])]);
    const done = await vs(["--status", "Beds", "--phase", "done", "--run", runId, "--dir", "design/verify"]);
    const c2 = await vs(["--compare", EXPECTED, out("Beds") + ".measured.json", "--out", out("Beds")]);
    return { runId, r2, done, c2 };
  }),
  noToken: q(() => probe(["--expected", QUIET, "--url", edge("no-token"), "--out", out("NoToken"), "--steps", "steps-no-token.json", "--max-time", "60000"])),
  churnDomGoto: q(() => probe(["--expected", QUIET, "--url", edge("link-step"), "--out", out("ChurnDomGoto"), "--steps", "steps-goto-churn.json", "--max-time", "60000"])),
  gotoHang: q(() => probe(["--expected", QUIET, "--url", edge("link-step"), "--out", out("GotoHang"), "--steps", "steps-goto-hang.json", "--ready", READY, "--timeout", "15000", "--max-time", "60000"])),
  hangFirst: q(() => probe(["--expected", QUIET, "--url", edge("hang-first"), "--out", out("HangFirst"), "--steps", "steps-click-only.json", "--ready", READY, "--timeout", "15000", "--max-time", "60000"])),
  ownContent3: q(() => probe(["--expected", EXPECTED, "--url", edge("own-content-3"), "--out", out("OwnContent3"), "--max-time", "90000"])),
  // the run, then its --compare
  wide: q(async () => {
    const r5 = await probe(["--expected", EXPECTED, "--url", url("wide"), "--out", out("Wide"), "--steps", "steps.json", "--ready", READY, "--max-time", "30000"]);
    const c5 = await vs(["--compare", EXPECTED, out("Wide") + ".measured.json", "--out", out("Wide")]);
    return { r5, c5 };
  }),
  slowImg: q(() => probe(["--expected", QUIET, "--url", `${edge("slow-img")}&d=13000`, "--out", out("SlowImg"), "--timeout", "30000", "--max-time", "60000"])),
  lateReady: q(() => probe(["--expected", QUIET, "--url", edge("late-ready"), "--out", out("LateReady"), "--ready", READY, "--timeout", "30000", "--max-time", "60000"])),
  readyNever: q(() => probe(["--expected", QUIET, "--url", `${edge("late-ready")}&d=99999999`, "--out", out("ReadyNever"), "--ready", READY, "--timeout", "12000", "--max-time", "60000"])),
  hangLate: q(() => probe(["--expected", QUIET, "--url", edge("hang-late"), "--out", out("HangLate"), "--steps", "steps-click-only.json", "--ready", READY, "--max-time", "60000"])),
  churnDom: q(() => probe(["--expected", QUIET, "--url", edge("churn-dom"), "--out", out("ChurnDom"), "--max-time", "60000"])),
  gotoSteps: q(() => probe(["--expected", EXPECTED, "--url", url(), "--out", out("GotoSteps"), "--steps", "steps-goto.json", "--ready", READY, "--max-time", "25000"])),
  ownContent2: q(() => probe(["--expected", EXPECTED, "--url", edge("own-content-2"), "--out", out("OwnContent2"), "--max-time", "90000"])),
  px1: q(() => ownPxRun("own-pixels-1")),
  ownContent: q(() => probe(["--expected", EXPECTED, "--url", edge("own-content"), "--out", out("OwnContent"), "--max-time", "90000"])),
  px2: q(() => ownPxRun("own-pixels-2")),
  coveredTall: q(() => probe(["--expected", EXPECTED, "--url", edge("covered-tall"), "--out", out("CoveredTall"), "--max-time", "60000"])),
  px4: q(() => ownPxRun("own-pixels-4")),
  px3: q(() => ownPxRun("own-pixels-3")),
  clickHidden: q(() => probe(["--expected", EXPECTED, "--url", edge("click-hidden"), "--out", out("ClickHidden"), "--max-time", "90000"])),
  clickHidden2: q(() => probe(["--expected", EXPECTED, "--url", edge("click-hidden-2"), "--out", out("ClickHidden2"), "--max-time", "90000"])),
  pxTall: q(() => ownPxRun("tall-shell")),
  ancestor: q(() => probe(["--expected", EXPECTED, "--url", edge("ancestor"), "--out", out("Ancestor"), "--max-time", "90000"])),
  pxCsp: q(() => ownPxRun("own-pixels-csp&csp=1")),
  cardCentre: q(() => probe(["--expected", EXPECTED, "--url", edge("card-centre"), "--out", out("CardCentre"), "--max-time", "90000"])),
  remount: q(() => probe(["--expected", EXPECTED, "--url", edge("remount"), "--out", out("Remount"), "--max-time", "90000"])),
  wrapperOpener: q(() => probe(["--expected", EXPECTED, "--url", edge("wrapper-submit"), "--out", out("WrapperSubmitOpener"), "--max-time", "90000"])),
  reload: q(() => probe(["--expected", QUIET, "--url", url("reload-on-first-hover"), "--out", out("Reload"), "--steps", "design/plan/Beds__70_1.json", "--ready", READY, "--max-time", "60000"])),
  ambiguous: q(() => probe(["--expected", EXPECTED, "--url", url(), "--out", out("Ambiguous"), "--steps", "steps-ambiguous.json"])),
  clickNavSlow: q(() => probe(["--expected", QUIET, "--url", edge("clicknav-slow"), "--out", out("ClickNavSlow"), "--steps", "steps-click-only.json", "--max-time", "60000"])),
  noSteps: q(() => probe(["--expected", EXPECTED, "--url", url(), "--out", out("NoSteps"), "--ready", READY, "--timeout", "3000"])),
  waitMany: q(() => probe(["--expected", QUIET, "--url", url(), "--out", out("WaitMany"), "--steps", "steps-waitfor-many.json"])),
  linkLateAway: q(() => probe(["--expected", QUIET, "--url", edge("link-inplace-late-away"), "--out", out("LinkLateAway"), "--steps", "steps-click-only.json", "--ready", READY, "--max-time", "60000"])),
  linkStep: q(() => probe(["--expected", QUIET, "--url", edge("link-step"), "--out", out("LinkStep"), "--steps", "steps-reload-step.json", "--ready", READY, "--max-time", "60000"])),
  sameLink: q(() => probe(["--expected", QUIET, "--url", `${edge("same-link")}&section=beds`, "--out", out("SameLink"), "--steps", "steps-click-only.json", "--ready", READY, "--max-time", "60000"])),
  sameLinkTop: q(() => probe(["--expected", QUIET, "--url", `${edge("same-link")}&section=beds&target=_top`, "--out", out("SameLinkTop"), "--steps", "steps-click-only.json", "--ready", READY, "--max-time", "60000"])),
  absEscape: q(() => probe(["--expected", QUIET, "--url", edge("abs-escape"), "--out", out("AbsEscape"), "--max-time", "60000"])),
  cbCreators: q(() => probe(["--expected", QUIET, "--url", edge("cb-creators"), "--out", out("CbCreators"), "--max-time", "60000"])),
  wrapperStep: q(() => probe(["--expected", QUIET, "--url", edge("wrapper-submit"), "--out", out("WrapperSubmitStep"), "--steps", "steps-click-only.json", "--max-time", "60000"])),
  tallWrapper: q(() => probe(["--expected", QUIET, "--url", edge("tall-wrapper"), "--out", out("TallWrapper"), "--steps", "steps-click-only.json", "--max-time", "60000"])),
  submit: q(() => probe(["--expected", EXPECTED, "--url", url(), "--out", out("Submit"), "--steps", "steps-submit.json"])),
  inlineWrap: q(() => probe(["--expected", QUIET, "--url", edge("inline-wrap"), "--out", out("InlineWrap"), "--steps", "steps-click-only.json", "--max-time", "60000"])),
  fill: q(() => probe(["--expected", EXPECTED, "--url", url(), "--out", out("Fill"), "--steps", "steps-fill.json"])),
};
// a click step navigating to another URL `delay` ms after the click (its ownership does not ride on the timing)
const slowNav = SLOW_NAV.map((delay) => ({ delay, run: q(() => probe(["--expected", QUIET, "--url", `${edge("slow-nav")}&delay=${delay}`, "--out", out(`SlowNav${delay}`), "--steps", "steps-reload-step.json", "--max-time", "60000"])) }));

// ---- the screen behind a click
const r1 = await P.noSteps;
check("1 no --steps + --ready on the section's root (only there after a click) → exit 4, nothing written", r1.status === 4 && !written(out("NoSteps")));

// the main run, bound to a verify run: --status --new-run → probe --run → --status done → --compare (one queued task: P.main)
const { runId, r2, done, c2 } = await P.main;
const m2 = read(out("Beds"));
if (r2.status !== 0) console.log(r2.stderr);
check("2 --steps (click the sidebar button, waitFor the root) → exit 0, measured.json written", r2.status === 0 && m2 !== null);
check("2 measured.reach: 2 steps, sha256 of their canonical JSON, source '--steps steps.json', the url after the steps",
  m2?.reach?.steps.length === 2 && m2.reach.sha256 === stepsSha && m2.reach.source === "--steps steps.json" && /plot-ledger\.html#beds$/.test(m2.reach.url));
check("2 the steps' pushState is no navigation: afterInitialLoad 0, re-runs 0", m2?.navigation?.afterInitialLoad === 0 && m2.navigation.reruns === 0);
check("2 the Beds section's specs are measured (the frame root by tag, its heading by tag)", m2?.frame?.nodeId === "70:1" && m2.frame.via === "tag"
  && (m2.nodes || []).some((n) => n.nodeId === "70:2" && n.matchedBy === "tag"));

// what the probe drove
const e6 = ix(m2, "70:44");
check("6 a hover-revealed row action (visibility:hidden until its tagged <tr> is hovered) opening a native <dialog> via showModal → ok:true, dialog-opened, detectedBy :modal, mouse, revealedBy the row, destination inside, navEvents 0",
  e6?.ok === true && e6.outcome === "dialog-opened" && e6.detectedBy === ":modal" && e6.activation === "mouse" && e6.revealedBy === "[data-dt-node=\"70:41\"]"
  && e6.destination?.nodeId === "70:60" && e6.destination.inside && e6.navEvents === 0 && e6.selectorCount === 1 && e6.selector === "[data-dt-node=\"70:44\"]");
check("[seam] 6 opened recorded raw: modal true, position fixed, a rect", e6?.opened?.modal === true && e6.opened.position === "fixed" && e6.opened.rect.w > 0);
const e7 = ix(m2, "70:45");
check("7 a div role=dialog aria-modal → ok:true, detectedBy [role=dialog]", e7?.ok === true && e7.outcome === "dialog-opened" && e7.detectedBy === "[role=dialog]" && e7.destination?.inside === true);
const e8 = ix(m2, "70:46");
check("8 a dialog without the destination tag → ok:null, destination.inside false, the detail says to tag it", e8?.ok === null && e8.detectedBy === ":modal" && e8.destination?.inside === false && /tag the dialog's root/.test(e8.detail || ""));
const e9 = ix(m2, "70:47");
check("9 a dead button → ok:null, outcome none (never ok:false)", e9?.ok === null && e9.outcome === "none" && e9.activation === "mouse");
check("the probe never writes ok:false", (m2?.interactions || []).length === 8 && (m2?.interactions || []).every((i) => i.ok !== false));
const e10 = ix(m2, "70:48");
check("10 a click that reloads the page → navEvents 1, ok:null", e10?.ok === null && e10.navEvents === 1);
const e11 = ix(m2, "70:49");
check("11 an opener under a transparent layer → synthetic click, ok:null 'not a user activation' (the dialog did open)", e11?.ok === null && e11.activation === "synthetic"
  && e11.detectedBy === ":modal" && /not a user activation/.test(e11.detail || "") && /intercepts pointer events/.test(e11.detail || ""));
const e12 = ix(m2, "70:50");
check("12 a plan-only opener (plan.interactions expect dialog) → driven: ok:true, dialog-opened, the dialog itself carries the tag", e12?.ok === true && e12.detectedBy === ":modal" && e12.destination?.inside === true);
const e13 = ix(m2, "70:53");
check("[planner default 1] a panel that is only the destination tag (no dialog contract) → ok:true, selector-appeared, detectedBy destination-tag", e13?.ok === true && e13.outcome === "selector-appeared" && e13.detectedBy === "destination-tag");
check("14 measured.page at the design width: scrollWidth = clientWidth = 1024, not scrollable, no offenders, standards mode",
  m2?.page?.scrollWidth === 1024 && m2.page.clientWidth === 1024 && m2.page.viewport.w === 1024 && !m2.page.scrollable && m2.page.offenders.length === 0 && m2.page.overflowX === "visible" && m2.page.compatMode === "CSS1Compat");

if (done.status !== 0) console.log(done.stderr);
const rep2 = readReport(out("Beds"));
if (rep2 === null) console.log(c2.stderr);
check("6 --compare: the hover-revealed overlay passes (was not-probed: nothing drove it)", res(rep2, "70:44")?.result === "pass");
check("12 --compare: the plan row is graded (source plan) and passes", res(rep2, "70:50")?.result === "pass" && res(rep2, "70:50")?.source === "plan");
check("8 --compare: the untagged dialog is not-probed, never pass", res(rep2, "70:46")?.result === "not-probed");
check("9/10/11 --compare: dead, reloading and covered openers are not-probed, never fail", ["70:47", "70:48", "70:49"].every((id) => res(rep2, id)?.result === "not-probed"));
check("15 run-bound (--run, done, compare without --interactions) → the probe's rows are graded as the probe's (evidenceFrom probe)",
  runId !== "" && done.status === 0 && res(rep2, "70:44")?.evidenceFrom === "probe" && (rep2?.coverage?.interactionsByProbe ?? 0) >= 4);
check("14 --compare at the design width: pageOverflow ok, no overflowX delta", rep2?.coverage?.pageOverflow === "ok" && !(rep2.deltas || []).some((d) => d.field === "overflowX"));
check("--compare: inputs.reach (2 steps, matches the plan's navigate)", rep2?.inputs?.reach?.steps === 2 && rep2.inputs.reach.matchesPlan === true);

// the behaviour battery runs AFTER the drive, in its own pages — the same run with behaviour on records the same
// interaction evidence (hover-revealed, role=dialog, untagged, dead, reloading, covered, plan-only, panel openers)
const bOn = out("BedsOn");
const rOn = await P.bedsOn;
const mOn = read(bOn);
if (rOn.status !== 0) console.log(rOn.stderr);
check("13 --behaviour on: exit 0, measured.behaviour ran, and measured.interactions identical to the --behaviour off run's",
  rOn.status === 0 && mOn?.behaviour?.ran === true && (m2?.interactions || []).length === 8 && JSON.stringify(mOn.interactions) === JSON.stringify(m2?.interactions)
  && m2?.behaviour?.ran === false);

// a step that loads a page (goto) is the probe's own navigation; a small --max-time leaves no driving budget
const b3 = out("GotoSteps");
const r3 = await P.gotoSteps;
const m3 = read(b3);
if (r3.status !== 0) console.log(r3.stderr);
check("2b a goto step (a document load) → exit 0, reach 3 steps, afterInitialLoad 0 (the step's load is the probe's own)", r3.status === 0 && m3?.reach?.steps.length === 3 && m3.navigation?.afterInitialLoad === 0);
const cut3 = (m3?.interactions || []).filter((i) => i.cut === "budget");
check("budget: --max-time 25 s leaves ≤ 10 s of driving → rows cut: ok:null, cut budget, 'not-run: time budget'; the measured file still written",
  cut3.length > 0 && cut3.every((i) => i.ok === null && i.detail === "not-run: time budget"));
// (Budget25000 / Budget30000 and the replaceState run: the tail suite)

// a reload during measurement → one full re-run, which replays the steps (the plan's navigate as --steps)
const b4 = out("Reload");
const r4 = await P.reload;
const m4 = read(b4);
if (r4.status !== 0) console.log(r4.stderr);
check("3 a reload on the first hover → exit 0, re-runs 1, the steps replayed (the root measured by tag), a note on the kept storage",
  r4.status === 0 && m4?.navigation?.reruns === 1 && m4.frame?.via === "tag" && m4.frame.nodeId === "70:1" && (m4.notes || []).some((n) => /replayed the steps in the same browser context/.test(n)));
check("--steps <plan>: the plan's navigate list, source names the plan file, the same sha", m4?.reach?.source === "--steps design/plan/Beds__70_1.json" && m4.reach.sha256 === stepsSha);

// a sideways overflow only in the section the steps reach
const b5 = out("Wide");
const { r5, c5 } = await P.wide;
const m5 = read(b5);
if (r5.status !== 0) console.log(r5.stderr);
check("13 a 1700px strip in the Beds section → page.scrollWidth ≥ 1600, scrollable, the strip named among the offenders",
  r5.status === 0 && (m5?.page?.scrollWidth ?? 0) >= 1600 && m5?.page?.scrollable === true && m5.page.offenders.some((o) => o.dt === "70:57"));
const rep5 = readReport(b5);
if (rep5 === null) console.log(c5.stderr);
const ov = (rep5?.deltas || []).find((d) => d.field === "overflowX");
check("13 --compare: one HIGH overflowX delta on the root frame (expected clientWidth, actual scrollWidth)", ov?.severity === "high" && ov.nodeId === "70:1" && ov.expected === 1024 && typeof ov.actual === "number" && ov.actual >= 1600);

// steps that must fail: ambiguous, a submit, a step outside the vocabulary
const r6 = await P.ambiguous;
check("4 a step matching 2 visible elements → exit 4 'matched 2', the step and the navigation log printed, nothing written",
  r6.status === 4 && /step 1 \{click: "\.nav-btn"\} matched 2 visible element/.test(r6.stderr) && /navigation log/.test(r6.stderr) && !written(out("Ambiguous")));
const r7 = await P.submit;
check("5 a step clicking a form's typeless button → exit 4 'never submit', nothing written", r7.status === 4 && /never submit/.test(r7.stderr) && !written(out("Submit")));
const r8 = await P.fill;
check("a {fill} step → exit 2 naming it (the vocabulary is click / waitFor / goto)", r8.status === 2 && /\{fill: …\} is not a step/.test(r8.stderr) && !written(out("Fill")));

// a waitFor is met by one or more visible matches (a click still needs exactly one: check 4 above)
const b10 = out("WaitMany");
const r10 = await P.waitMany;
if (r10.status !== 0) console.log(r10.stderr);
check("a waitFor step matching 7 visible elements → met (exit 0, reach 2 steps)", r10.status === 0 && read(b10)?.reach?.steps.length === 2);

// ---- edge-page repros (plot-ledger-edge.html)
// (ReloadSettle, ReloadSettleNoReady, ReloadStep, GotoReload, ReloadLate: the tail suite)
const b13 = out("LinkStep");
const r13 = await P.linkStep;
const m13 = read(b13);
if (r13.status !== 0) console.log(r13.stderr);
check("a step whose click follows a link → that load is the step's own: afterInitialLoad 0, re-runs 0, the root by tag",
  r13.status === 0 && m13?.navigation?.afterInitialLoad === 0 && m13.navigation.reruns === 0 && m13.frame?.via === "tag" && /section=beds/.test(m13.reach?.url ?? ""));
// (SlowReach: the tail suite)

// an ancestor-tagged opener, with no write made
const b15 = out("Ancestor");
const r15 = await P.ancestor;
const m15 = read(b15);
if (r15.status !== 0) console.log(r15.stderr);
const e47 = ix(m15, "70:47"), e49 = ix(m15, "70:49");
check("an unrelated dialog opening inside a destination-tagged wrapper that was already on screen → destination NOT inside, ok:null",
  e47?.ok === null && e47.detectedBy === "[role=dialog]" && e47.destination?.inside === false && /not inside the opened element/.test(e47.detail || ""));
check("a destination-tagged wrapper that appears with its dialog (an ancestor, newly visible) → inside, ok:true",
  e49?.ok === true && e49.detectedBy === "[role=dialog]" && e49.destination?.inside === true);
check("disabled openers (aria-disabled on it / on an ancestor, [disabled]) → ok:null 'opener is disabled — not driven', no activation",
  ["70:44", "70:45", "70:46"].every((id) => { const e = ix(m15, id); return e?.ok === null && e.detail === "opener is disabled — not driven" && e.activation === undefined; }));
check("a typeless <button> in a <form> as the opener → ok:null 'opener would submit a form', not clicked",
  ix(m15, "70:48")?.ok === null && /^opener would submit a form/.test(ix(m15, "70:48")?.detail || "") && ix(m15, "70:48")?.activation === undefined);
const w15 = writesOf(edge("ancestor"));
check(`no opener's handler ran a write (server saw: ${w15.join(", ") || "nothing"})`, r15.status === 0 && w15.length === 0);

// the drive's click point (the opener's centre) is another control inside the opener → never clicked
const bCC = out("CardCentre");
const rCC = await P.cardCentre;
const mCC = read(bCC);
if (rCC.status !== 0) console.log(rCC.stderr);
check("a card opener whose centre is its own Delete button (a 2nd control beside it) → not driven: ok:null 'the opener's click point is another control inside it (<button aria-label=\"Delete bed\">) — tag that control or the opener's own clickable element', no activation",
  ix(mCC, "70:47")?.ok === null && /^the opener's click point is another control inside it \(<button aria-label="Delete bed">\) — tag that control or the opener's own clickable element/.test(ix(mCC, "70:47")?.detail || "") && ix(mCC, "70:47")?.activation === undefined);
check("a cell whose ONLY focusable is its centred icon button → that button is the opener: driven, ok:true", ix(mCC, "70:49")?.ok === true && ix(mCC, "70:49")?.activation === "mouse");
const refused = (id: string): boolean => ix(mCC, id)?.ok === null && /^the opener's click point is another control inside it \(<button aria-label="Delete bed">\) — tag that control or the opener's own clickable element/.test(ix(mCC, id)?.detail || "") && ix(mCC, id)?.activation === undefined;
check("a card with its own label whose ONLY control is its centred Delete → not the card's own control: not driven, ok:null naming <button aria-label=\"Delete bed\">, no activation", refused("70:45"));
check("a cell whose only other content is an sr-only label → its centred button is the opener: driven, ok:true", ix(mCC, "70:53")?.ok === true && ix(mCC, "70:53")?.activation === "mouse");
check("a FOCUSABLE card (role=button tabindex=0) and an <a href> card, each with a centred Delete → not driven, ok:null naming the Delete, no activation", refused("70:46") && refused("70:48"));
const wCC = writesOf(edge("card-centre"));
check(`the drive pressed no Delete (server saw: ${wCC.join(", ") || "nothing"})`, rCC.status === 0 && wCC.length === 0);

// what the centre click would press beyond a plain focusable inside the card — a label's checkbox, a role=button
// span without tabindex, a shadow-DOM button (also through slotted text), an iframe — never clicked; a plain cell is still driven
const notDrivenFor = (m: VerifyMeasured | null, id: string, ctl: string): boolean => ix(m, id)?.ok === null && ix(m, id)?.activation === undefined
  && (ix(m, id)?.detail || "").startsWith(`the opener's click point is another control inside it (${ctl}) — tag that control or the opener's own clickable element`);
const bCH = out("ClickHidden");
const rCH = await P.clickHidden;
const mCH = read(bCH);
if (rCH.status !== 0) console.log(rCH.stderr);
check("a <label for> its checkbox at the card's centre (70:44) and a label wrapping its checkbox (70:45) → not driven, ok:null naming the checkbox (the label's control)",
  notDrivenFor(mCH, "70:44", "<input type=\"checkbox\" aria-label=\"Packed\">") && notDrivenFor(mCH, "70:45", "<input type=\"checkbox\" aria-label=\"Done\">"));
check("a centred span role=button WITHOUT tabindex (70:46) → not driven, ok:null naming it", notDrivenFor(mCH, "70:46", "<span role=\"button\" aria-label=\"Delete bed\">"));
check("a web component's shadow <button> at the centre (70:47), and text slotted into a shadow <button> (70:50) → not driven, ok:null naming the shadow button",
  notDrivenFor(mCH, "70:47", "<button aria-label=\"Delete\">") && notDrivenFor(mCH, "70:50", "<button aria-label=\"Remove\">"));
check("an iframe at the card's centre (70:48) → not driven, ok:null naming <iframe>", notDrivenFor(mCH, "70:48", "<iframe>"));
check("a cell whose ONLY focusable is its centred icon button (70:49) → still driven, ok:true, mouse", ix(mCH, "70:49")?.ok === true && ix(mCH, "70:49")?.activation === "mouse");
const wCH = writesOf(edge("click-hidden"));
check(`the drive toggled no checkbox and pressed no Delete (server saw: ${wCH.join(", ") || "nothing"})`, rCH.status === 0 && wCH.length === 0);

// a card's own content the check must see (display:contents text, shadow text, a ::before label, a
// background-image logo) → its centred Delete is never clicked; a cell's text that shows nothing (an opacity-0 tooltip, a
// clip-path-only sr-only label, an opacity-0 wrapper, an aria-hidden scale(0) tooltip) → its button is the opener's: driven
const bOC = out("OwnContent");
const rOC = await P.ownContent;
const mOC = read(bOC);
if (rOC.status !== 0) console.log(rOC.stderr);
check("cards whose own label is text in display:contents wrappers (70:44), a shadow-root title (70:45), a ::before label (70:46) or a background-image logo (70:47) → not driven, ok:null naming the centred Delete",
  ["70:44", "70:45", "70:46", "70:47"].every((id) => notDrivenFor(mOC, id, "<button aria-label=\"Delete bed\">")));
check("cells whose sole centred button sits beside an opacity-0 tooltip (70:48), a clip-path-only sr-only label (70:49), an opacity-0 wrapper's tooltip (70:50) or an aria-hidden scale(0) tooltip (70:53) → driven, ok:true, mouse (was: refused)",
  ["70:48", "70:49", "70:50", "70:53"].every((id) => ix(mOC, id)?.ok === true && ix(mOC, id)?.activation === "mouse"));
const wOC = writesOf(edge("own-content"));
check(`the drive pressed no Delete (server saw: ${wOC.join(", ") || "nothing"})`, rOC.status === 0 && wOC.length === 0);

// a covered opener's synthetic click starts from the drive's own scroll — its evidence never depends on how many
// Playwright click retries (each scrolling with another alignment) fitted into the 2 s
const bCT = out("CoveredTall");
const rCT = await P.coveredTall;
const eCT = ix(read(bCT), "70:49");
if (rCT.status !== 0) console.log(rCT.stderr);
check(`a covered opener in view on a tall page → synthetic click from the drive's scroll: opened.scrollY 0 (saw ${String(eCT?.opened?.scrollY)}), the dialog detected`,
  rCT.status === 0 && eCT?.activation === "synthetic" && eCT.opened?.scrollY === 0 && eCT.detectedBy === "[role=dialog]");

// own content the check missed or misread — an in-flow opacity-0 label fading in once scrolled into
// view, labels escaping a 1 × 1 overflow:hidden wrapper (absolute, fixed), an empty ::before logo on a background-image, a CSS-mask
// icon, a colour swatch → the centred Delete is never clicked; a hover tint over a whole cell and a filled wrapper around its sole
// button are the cell's own chrome → driven
const bO2 = out("OwnContent2");
const rO2 = await P.ownContent2;
const mO2 = read(bO2);
if (rO2.status !== 0) console.log(rO2.stderr);
check("a card below the fold whose label is opacity 0 in flow until it is scrolled into view (reveal-on-scroll, 70:44) → not driven, ok:null naming the centred Delete (was: pressed)",
  notDrivenFor(mO2, "70:44", "<button aria-label=\"Delete bed\">"));
check("a label absolutely (70:45) or fixed (70:46) positioned inside a 1 × 1 overflow:hidden static wrapper → not driven, ok:null naming the centred Delete",
  notDrivenFor(mO2, "70:45", "<button aria-label=\"Delete bed\">") && notDrivenFor(mO2, "70:46", "<button aria-label=\"Delete bed\">"));
check("an empty ::before logo on a background-image (70:47), a CSS-mask icon (70:48), a colour swatch (70:49) → not driven, ok:null naming the centred Delete",
  ["70:47", "70:48", "70:49"].every((id) => notDrivenFor(mO2, id, "<button aria-label=\"Delete bed\">")));
check("a cell under a pointer-events:none hover tint over the whole cell (70:50), a cell whose sole button sits in a filled wrapper (70:53) → driven, ok:true, mouse",
  ["70:50", "70:53"].every((id) => ix(mO2, id)?.ok === true && ix(mO2, id)?.activation === "mouse"));
const wO2 = writesOf(edge("own-content-2"));
check(`the drive pressed no Delete (server saw: ${wO2.join(", ") || "nothing"})`, rO2.status === 0 && mO2 !== null && wO2.length === 0);

// an sr-only label off the document's start edge shows nothing; an empty ::before status dot on a
// background colour is content, an empty ::after tint over the whole cell and an out-of-flow opacity-0 ::after tooltip are not;
// a label 8000 elements deep is found without a stack overflow
const bO3 = out("OwnContent3");
const rO3 = await P.ownContent3;
const mO3 = read(bO3);
if (rO3.status !== 0) console.log(rO3.stderr);
check("a cell whose sr-only label is at left:-9999px (off the document's start edge) → driven, ok:true, mouse (was: refused)",
  ix(mO3, "70:44")?.ok === true && ix(mO3, "70:44")?.activation === "mouse");
check("a card's status dot drawn by an empty ::before on a background colour beside its centred Delete (70:45) → not driven, ok:null naming the Delete",
  notDrivenFor(mO3, "70:45", "<button aria-label=\"Delete bed\">"));
check("a cell with an out-of-flow opacity-0 ::after tooltip (70:47), the plain cell (70:49) → driven, ok:true, mouse",
  ["70:47", "70:49"].every((id) => ix(mO3, id)?.ok === true && ix(mO3, id)?.activation === "mouse"));
// the container's OWN ::before / ::after are hidden in the all-content shot — a tint the cell paints with its
// own ::after over the whole cell is a painted pseudo of its own: its sole button is not taken for the opener's
check("a cell painting a tint with its own empty ::after over the whole cell (70:46) → not driven by the pixels, ok:null naming its button",
  notDrivenFor(mO3, "70:46", "<button aria-label=\"Open bed\">") && /paints something of its own beside it/.test(ix(mO3, "70:46")?.detail ?? ""));
check(`a card whose label is 8000 elements deep (70:48) → a clean refusal naming the Delete, no 'driving failed' (saw: ${ix(mO3, "70:48")?.detail ?? "no row"})`,
  notDrivenFor(mO3, "70:48", "<button aria-label=\"Delete bed\">"));
const wO3 = writesOf(edge("own-content-3"));
check(`the drive pressed no Delete (server saw: ${wO3.join(", ") || "nothing"})`, rO3.status === 0 && mO3 !== null && wO3.length === 0);

// an activating control anywhere on the click point's path wins over a merely focusable element below it; an
// <object> / <embed> is a nested browsing context → never clicked (a write from inside them carries the subframe's own URL:
// charged to every run)
const bR6c = out("ClickHidden2");
const rR6c = await P.clickHidden2;
const mR6c = read(bR6c);
if (rR6c.status !== 0) console.log(rR6c.stderr);
check("a centred <button> Delete whose glyph is a tabindex=-1 span (70:44) → not driven, ok:null naming the button (was: pressed)",
  notDrivenFor(mR6c, "70:44", "<button aria-label=\"Delete bed\">"));
check("a span role=button Delete with a tabindex=-1 glyph (70:45) or a contenteditable label (70:46) → not driven, ok:null naming the span role=button",
  notDrivenFor(mR6c, "70:45", "<span role=\"button\" aria-label=\"Delete bed\">") && notDrivenFor(mR6c, "70:46", "<span role=\"button\" aria-label=\"Delete bed\">"));
check("an <object> (70:47) and an <embed> (70:48) at the card's centre showing a page whose Delete fills them → not driven, ok:null naming <object> / <embed>",
  notDrivenFor(mR6c, "70:47", "<object type=\"text/html\">") && notDrivenFor(mR6c, "70:48", "<embed type=\"text/html\">"));
check("the plain cell (70:49) → still driven, ok:true, mouse", ix(mR6c, "70:49")?.ok === true && ix(mR6c, "70:49")?.activation === "mouse");
const wR6c = writesOf(edge("click-hidden-2"));
check(`the drive pressed no Delete inside the openers (server saw: ${wR6c.join(", ") || "nothing"})`, rR6c.status === 0 && mR6c !== null && wR6c.length === 0);
// (SmoothShell, SmoothShellImportant, SmoothShellPainted: the tail suite)

// a container's sole centred control is its own only when the container paints nothing of its
// own beside it — decided by pixels (only that control hidden vs all its content hidden), as a union with the DOM check; the
// opener is hovered first, so a hover-revealed Delete is at the click point. Every Delete here writes; none may be pressed
const ownPx = async (mode: string, pending: Promise<Run>): Promise<{ m: VerifyMeasured | null; status: number | null; writes: string[] }> => {
  const r = await pending;
  if (r.status !== 0) console.log(r.stderr);
  return { m: read(ownPxOut(mode)), status: r.status, writes: writesOf(edge(mode)) };
};
const DEL = "<button aria-label=\"Delete bed\">";
const byPixels = (m: VerifyMeasured | null, id: string): boolean => notDrivenFor(m, id, DEL) && /paints something of its own beside it/.test(ix(m, id)?.detail ?? "");
const drivenOk = (m: VerifyMeasured | null, ids: string[]): boolean => ids.every((id) => ix(m, id)?.ok === true && ix(m, id)?.activation === "mouse");
const p1 = await ownPx("own-pixels-1", P.px1);
check("a labelled card whose centred Delete shows only on :hover — by visibility (70:44), display (70:45), opacity + pointer-events (70:46) → not driven, ok:null naming the Delete (was: pressed)",
  ["70:44", "70:45", "70:46"].every((id) => notDrivenFor(p1.m, id, DEL)));
check("a status dot drawn by the card's own empty ::before (70:47), by an empty ::before of a wrapper holding the Delete (70:48), a swatch drawn by the card's own ::after (70:49) → not driven by the pixels, naming the Delete (was: pressed)",
  ["70:47", "70:48", "70:49"].every((id) => byPixels(p1.m, id)));
check("a cell under a hover tint over the whole cell (70:53), a cell whose sole button sits in a filled wrapper (70:50) → still driven, ok:true, mouse",
  drivenOk(p1.m, ["70:53", "70:50"]));
check(`the drive pressed no Delete (server saw: ${p1.writes.join(", ") || "nothing"})`, p1.status === 0 && p1.m !== null && p1.writes.length === 0);
const p2 = await ownPx("own-pixels-2", P.px2);
check("a dot drawn by a border (70:46), a swatch drawn by a box-shadow (70:47), a band across the centre (70:48), a colour tile holding the Delete (70:49) → not driven by the pixels, naming the Delete (was: pressed)",
  ["70:46", "70:47", "70:48", "70:49"].every((id) => byPixels(p2.m, id)));
check("a <progress> (70:44), a <meter> (70:45) → not driven, naming the Delete — now by the DOM's media rule, before the pixels (was: pressed)",
  ["70:44", "70:45"].every((id) => notDrivenFor(p2.m, id, DEL) && !/paints something of its own beside it/.test(ix(p2.m, id)?.detail ?? "")));
check("a cell with a Tailwind sr-only label (70:53), a cell with a transform:scale(0) aria-hidden tooltip (70:50) → still driven, ok:true, mouse",
  drivenOk(p2.m, ["70:53", "70:50"]));
check(`the drive pressed no Delete (server saw: ${p2.writes.join(", ") || "nothing"})`, p2.status === 0 && p2.m !== null && p2.writes.length === 0);
const p3 = await ownPx("own-pixels-3", P.px3);
check("a card below the fold whose out-of-flow label fades in once scrolled into view (70:44) → not driven, naming the Delete (was: pressed)",
  notDrivenFor(p3.m, "70:44", DEL));
check("a label painted past its 1 × 1 overflow:clip box by overflow-clip-margin (70:45) → not driven, naming the Delete (was: pressed)",
  notDrivenFor(p3.m, "70:45", DEL));
check("a cell with a 3-px selection stripe beside its icon button (70:46) → not driven, naming the button: a painted stripe is the cell's own content",
  notDrivenFor(p3.m, "70:46", "<button aria-label=\"Open bed\">"));
check("a cell with an icon inside its button (70:47), a clip-path sr-only label (70:48), an opacity-0 tooltip (70:49), a left:-9999px sr-only label (70:53), the plain cell (70:50) → still driven, ok:true, mouse",
  drivenOk(p3.m, ["70:47", "70:48", "70:49", "70:53", "70:50"]));
check(`the drive pressed no Delete (server saw: ${p3.writes.join(", ") || "nothing"})`, p3.status === 0 && p3.m !== null && p3.writes.length === 0);
// under a strict style CSP: the probe hides by its own constructed sheet (CSSOM), which a CSP never blocks
const pC = await ownPx("own-pixels-csp&csp=1", P.pxCsp);
check("[CSP] under style-src 'nonce-…' a card's own ::before status dot beside its sole centred Delete (70:44) → not driven by the pixels, naming the Delete; the plain cell (70:53) → driven",
  byPixels(pC.m, "70:44") && drivenOk(pC.m, ["70:53"]));
check("under the same CSP a cell whose button has transition:all (70:50) → driven, ok:true, mouse (was: refused 'could not hide its control' — the init CSS <style> was blocked)",
  drivenOk(pC.m, ["70:50"]));
check(`[CSP] the drive pressed no Delete (server saw: ${pC.writes.join(", ") || "nothing"})`, pC.status === 0 && pC.m !== null && pC.writes.length === 0);
// the boxes kept as decoration only when their pixels are plain, a shadow host's own content,
// the container's own ::marker, a layered !important, everything outside the container hidden in both shots (a foreign ticker),
// a control unmounted when the pointer leaves
const p4 = await ownPx("own-pixels-4", P.px4);
const isD53 = (m: VerifyMeasured | null, id: string, re: RegExp): boolean => notDrivenFor(m, id, DEL) && re.test(ix(m, id)?.detail ?? "");
check("an inset:0 fill clipped to a corner flag by clip-path (70:44), one painted only in a 4-px content box by background-clip (70:45) → never kept as decoration: not driven by the pixels, naming the Delete (was: pressed)",
  byPixels(p4.m, "70:44") && byPixels(p4.m, "70:45"));
check("a web-component card whose shadow root holds a status dot beside its slotted sole Delete (70:46) → not driven by the pixels, naming the Delete (was: pressed)",
  byPixels(p4.m, "70:46"));
check("a card that is a list item with its own '1.' marker (70:47) → not driven, naming the Delete (was: pressed)", notDrivenFor(p4.m, "70:47", DEL));
check("a wrapper hugging the Delete whose box-shadow paints a ring (70:48) → not a plain fill: not driven, naming the Delete (was: pressed)",
  isD53(p4.m, "70:48", /not a plain fill/));
check("a status dot forced visible by an !important inside a cascade layer (70:49) → the probe's rule did not take: not driven, naming the Delete (was: pressed)",
  isD53(p4.m, "70:49", /kept <span> inside the opener showing/));
check("a cell whose button is mounted on hover and unmounted when the pointer leaves (70:53), a cell under a foreign ticker repainting every 10 ms (70:50) → driven, ok:true, mouse",
  drivenOk(p4.m, ["70:53", "70:50"]));
check(`the drive pressed no Delete (server saw: ${p4.writes.join(", ") || "nothing"})`, p4.status === 0 && p4.m !== null && p4.writes.length === 0);
// in an app shell scrolled so a tall card's label lies above the shell's top, the label is still the card's own
// (scrolling the shell reaches it): its Delete is never clicked; a plain cell in the same shell is driven
const pT = await ownPx("tall-shell", P.pxTall);
check("a 900-px card in a scrolled app shell, its label above the shell's top, its Delete under the click point (70:44) → not driven, naming the Delete (was: pressed)",
  notDrivenFor(pT.m, "70:44", DEL));
check("a cell in the same shell (70:53) → driven, ok:true, mouse", drivenOk(pT.m, ["70:53"]));
check(`the drive pressed no Delete (server saw: ${pT.writes.join(", ") || "nothing"})`, pT.status === 0 && pT.m !== null && pT.writes.length === 0);

// an absolute strip escaping a static overflow:hidden wrapper widens the page and is named; a clipped one is not
const b16 = out("AbsEscape");
const r16 = await P.absEscape;
const m16 = read(b16);
if (r16.status !== 0) console.log(r16.stderr);
check("an absolute element inside a static overflow:hidden wrapper → page scrolls sideways and it is named among the offenders; one clipped by a positioned wrapper is not",
  r16.status === 0 && m16?.page?.scrollable === true && (m16.page.scrollWidth ?? 0) >= 1500 && m16.page.offenders.some((o) => o.dt === "70:57") && !m16.page.offenders.some((o) => o.dt === "70:58"));

// ---- late-navigation repros (plot-ledger-edge.html)
// a click step whose page navigates to ANOTHER URL only later (an app that awaits a request first) — that navigation
// is the step's own however late it starts: no re-run, not after the initial load. 0 and 120 ms are guards.
for (const { delay, run: pending } of slowNav) {
  const b = out(`SlowNav${delay}`);
  const r = await pending;
  const m = read(b);
  if (r.status !== 0) console.log(r.stderr);
  check(`${delay <= 120 ? "[guard] " : ""}a click step navigating ${delay} ms after the click → the step's own: exit 0, the root by tag, afterInitialLoad 0, re-runs 0, reach url section=beds`,
    r.status === 0 && m?.frame?.via === "tag" && m.frame.nodeId === "70:1" && m.navigation?.afterInitialLoad === 0 && m.navigation.reruns === 0 && /section=beds/.test(m.reach?.url ?? ""));
}
// the click's navigation commits at once into a document that stays half-loaded (quiet) for 2.5 s — waited for
const bM = out("ClickNavSlow");
const rM = await P.clickNavSlow;
const mM = read(bM);
if (rM.status !== 0) console.log(rM.stderr);
check("a step's navigation into a half-loaded document (no --ready) → its load is waited for: the root by tag, its heading measured, afterInitialLoad 0",
  rM.status === 0 && mM?.frame?.via === "tag" && (mM.nodes || []).some((n) => n.nodeId === "70:2" && n.matchedBy === "tag") && mM.navigation?.afterInitialLoad === 0);
// (ClickReloads and TokenSwitch: the tail suite)
// a tagged wrapper whose click point is a typeless <button> in a <form> — as a step, and as an opener
const bC = out("WrapperSubmitStep");
const rC = await P.wrapperStep;
check("a step clicking a tagged wrapper whose click point is a form's typeless button → exit 4 'never submit' (at its click point), nothing written",
  rC.status === 4 && /would submit a form \(a <button> without a type inside a <form> \(it submits\) at its click point\) — a step must navigate, never submit/.test(rC.stderr) && !written(bC));
const bC2 = out("WrapperSubmitOpener");
const rC2 = await P.wrapperOpener;
const eC2 = ix(read(bC2), "70:47");
check("an opener that is a tagged wrapper around a form's typeless button → ok:null 'opener would submit a form (… at its click point)', not clicked",
  rC2.status === 0 && eC2?.ok === null && /^opener would submit a form \(.*at its click point\)/.test(eC2.detail || "") && eC2.activation === undefined);
const wC = writesOf(edge("wrapper-submit"));
check(`no form was submitted (server saw: ${wC.join(", ") || "nothing"})`, wC.length === 0);
// a destination wrapper the app re-mounts in place around an unrelated dialog is not newly visible → not inside
const bB = out("Remount");
const rB = await P.remount;
const eB = ix(read(bB), "70:47");
check("an unrelated dialog inside a destination wrapper re-mounted in the same place → destination NOT inside, ok:null",
  rB.status === 0 && eB?.ok === null && eB.detectedBy === "[role=dialog]" && eB.destination?.inside === false);
// containing-block creators beyond transform
const bD = out("CbCreators");
const rD = await P.cbCreators;
const mD = read(bD);
if (rD.status !== 0) console.log(rD.stderr);
check("position:fixed under a transformed ancestor widens the page and is named; absolute under a filtered overflow:hidden wrapper or a contain:layout one is not",
  rD.status === 0 && mD?.page?.scrollable === true && mD.page.offenders.some((o) => o.dt === "70:57") && !mD.page.offenders.some((o) => o.dt === "70:58" || o.dt === "70:59"));

// ---- same-URL reload repros (plot-ledger-edge.html)
// (ClickReloadsSync / ClickReloads100 / ClickReloadsOnce and HangImg: the tail suite)
// a tagged wrapper taller than the viewport — Playwright clicks the middle of what shows, where a form's typeless
// button is (the middle of the whole box is empty) → refused as a step
const bT = out("TallWrapper");
const rT = await P.tallWrapper;
const wT = writesOf(edge("tall-wrapper"));
check(`a step clicking a wrapper taller than the viewport whose on-screen middle is a form's typeless button → exit 4 'never submit' (at its click point), nothing written, nothing submitted (server saw: ${wT.join(", ") || "nothing"})`,
  rT.status === 4 && /would submit a form \(a <button> without a type inside a <form> \(it submits\) at its click point\)/.test(rT.stderr) && !written(bT) && wT.length === 0);

// ---- link and late-navigation steps
const loadNoteAfter = (m: VerifyMeasured | null, sec: number): boolean => (m?.notes || []).some((n) => n.includes(`the page had not finished loading when the goto gave up after ${sec}s`));
// a click on a link to the URL the page already shows (here a URL tab, the tag on a span inside the <a>) is a refresh
// step — its load is the step's own (not a lost state, a re-run, or exit 4 "changed it in place")
const bSL = out("SameLink");
const rSL = await P.sameLink;
const mSL = read(bSL);
if (rSL.status !== 0) console.log(rSL.stderr);
check("a step clicking a link to the URL the page shows (a URL tab) → its load is the step's own: exit 0, afterInitialLoad 0, re-runs 0, the root by tag (was: exit 4 'changed it in place')",
  rSL.status === 0 && mSL?.navigation?.afterInitialLoad === 0 && mSL.navigation.reruns === 0 && mSL.frame?.via === "tag" && mSL.frame.nodeId === "70:1");
// a late click navigation into a document that never finishes loading → its own 10 s, then measured with the note
const bHL = out("HangLate");
const rHL = await P.hangLate;
const sHL = rHL.ms;
const mHL = read(bHL);
if (rHL.status !== 0) console.log(rHL.stderr);
check(`a click navigating 400 ms later into a document that never finishes loading → exit 0 in ${Math.round(sHL / 1000)} s, the root by tag, the 'had not finished loading' note (was: exit 4 'kept navigating' + the dev-server hint)`,
  rHL.status === 0 && mHL?.frame?.via === "tag" && mHL.frame.nodeId === "70:1" && loadNote(mHL) && mHL.navigation?.afterInitialLoad === 0);
// (LateSlow and the ReloadHang guard: the tail suite)
// the probe's own load (--url, a goto step) of a document that never finishes loading is waited for up
// to --timeout, then (it committed) measured with the note — not "could not load"
const bHF = out("HangFirst");
const rHF = await P.hangFirst;
const mHF = read(bHF);
if (rHF.status !== 0) console.log(rHF.stderr);
check("--url a document that never finishes loading (--timeout 15 s) → its load waited for up to --timeout, then exit 0, the root by tag, the note 'after 15s' (was: 'could not load', then a note after 10 s)",
  rHF.status === 0 && mHF?.frame?.via === "tag" && mHF.frame.nodeId === "70:1" && loadNoteAfter(mHF, 15));
const bGH = out("GotoHang");
const rGH = await P.gotoHang;
const mGH = read(bGH);
if (rGH.status !== 0) console.log(rGH.stderr);
check("a goto step to a document that never finishes loading → waited for up to --timeout, then exit 0, afterInitialLoad 0, the root by tag, the note 'after 15s'",
  rGH.status === 0 && mGH?.navigation?.afterInitialLoad === 0 && mGH.frame?.via === "tag" && mGH.frame.nodeId === "70:1" && loadNoteAfter(mGH, 15));
// (LateLoad: the tail suite)
// with no per-document token ("" on every document) a timed-out document's note is never shared with the next one
const bNT = out("NoToken");
const rNT = await P.noToken;
const mNT = read(bNT);
if (rNT.status !== 0) console.log(rNT.stderr);
check("no token on any document: after one document's load timed out, the next step's half-loaded document is still waited for (not skipped as that known timed-out one) → exit 0, the root by tag, its heading measured",
  rNT.status === 0 && mNT?.frame?.via === "tag" && mNT.frame.nodeId === "70:1" && (mNT.nodes || []).some((n) => n.nodeId === "70:2"));
// Playwright clicks the middle of the FIRST content quad (a wrapping inline element's first line), not of its box
const bIW = out("InlineWrap");
const rIW = await P.inlineWrap;
const wIW = writesOf(edge("inline-wrap"));
check(`a step clicking an inline span whose first line is a form's typeless button (its box's middle is not) → exit 4 'never submit' at its click point, nothing written, nothing submitted (server saw: ${wIW.join(", ") || "nothing"})`,
  rIW.status === 4 && /would submit a form \(a <button> without a type inside a <form> \(it submits\) at its click point\)/.test(rIW.stderr) && !written(bIW) && wIW.length === 0);

// ---- slow, churning and same-URL documents
const notes = (m: VerifyMeasured | null): string[] => m?.notes || [];
// the probe's own load never reads as "moved" — a DOM that never goes quiet is measured with the no-navigation note
const bCD = out("ChurnDom");
const rCD = await P.churnDom;
const mCD = read(bCD);
if (rCD.status !== 0) console.log(rCD.stderr);
check("a DOM that never goes quiet on the --url page (no navigation) → exit 0, the root by tag, 'the DOM was still changing after 10s (no navigation)' (was: exit 4 'kept navigating')",
  rCD.status === 0 && mCD?.frame?.via === "tag" && notes(mCD).some((n) => /the DOM was still changing after 10s \(no navigation\)/.test(n)));
const bCG = out("ChurnDomGoto");
const rCG = await P.churnDomGoto;
const mCG = read(bCG);
if (rCG.status !== 0) console.log(rCG.stderr);
check("the same after a goto step → exit 0, afterInitialLoad 0, the still-changing note (was: exit 4 'kept navigating')",
  rCG.status === 0 && mCG?.navigation?.afterInitialLoad === 0 && notes(mCG).some((n) => /the DOM was still changing after 10s \(no navigation\)/.test(n)));
// --ready on the --url page keeps the full --timeout (the screen appears at 12 s)
const bLR = out("LateReady");
const rLR = await P.lateReady;
const mLR = read(bLR);
if (rLR.status !== 0) console.log(rLR.stderr);
check("--ready that appears 12 s after load with --timeout 30000 → exit 0, the root by tag (was: exit 4 'kept navigating' at 10 s)",
  rLR.status === 0 && mLR?.frame?.via === "tag" && mLR.frame.nodeId === "70:1");
const bRN = out("ReadyNever");
const rRN = await P.readyNever;
check("a --ready that never appears → exit 4 \"--ready … never became visible\" at --timeout, not 'kept navigating', nothing written",
  rRN.status === 4 && /--ready '\[data-dt-node="70:1"\]' never became visible/.test(rRN.stderr) && !/kept navigating/.test(rRN.stderr) && !written(bRN));
// a slow-but-finishing page (an image answered at 13 s, --timeout 30000) is measured fully loaded, with no note
const bSI = out("SlowImg");
const rSI = await P.slowImg;
const mSI = read(bSI);
if (rSI.status !== 0) console.log(rSI.stderr);
check("an image finishing 13 s after the --url load (--timeout 30000) → its load waited for: exit 0, no 'had not finished loading' note (was: measured half-loaded at 10 s)",
  rSI.status === 0 && mSI?.frame?.via === "tag" && !notes(mSI).some((n) => /had not finished loading/.test(n)));
// (SlowStay and LinkInplaceReload / LinkEmptyReload: the tail suite)
// a same-URL link handled in place whose app navigates AWAY 1.2 s later — still the step's own navigation
const bLA = out("LinkLateAway");
const rLA = await P.linkLateAway;
const mLA = read(bLA);
if (rLA.status !== 0) console.log(rLA.stderr);
check("a same-URL link handled in place, then a navigation to another URL 1.2 s later → the step's own: exit 0, afterInitialLoad 0, re-runs 0, the root by tag (was: exit 4 'reloaded … again')",
  rLA.status === 0 && mLA?.navigation?.afterInitialLoad === 0 && mLA.navigation.reruns === 0 && mLA.frame?.via === "tag");
// target=_top is the same tab — a refresh link
const bTT = out("SameLinkTop");
const rTT = await P.sameLinkTop;
const mTT = read(bTT);
if (rTT.status !== 0) console.log(rTT.stderr);
check("a refresh link with target=_top → its load is the step's own: exit 0, afterInitialLoad 0, re-runs 0 (was: exit 4 'changed it in place')",
  rTT.status === 0 && mTT?.navigation?.afterInitialLoad === 0 && mTT.navigation.reruns === 0 && mTT.frame?.via === "tag");
// (SlowChurn, BounceHang and RedirSlow: the tail suite)

// every run has settled before the per-suite checks below
await Promise.all([...Object.values(P), ...slowNav.map((s) => s.run)]);

// what --compare wrote reads as a report at all (guards against a half-written run)
check("the bound compare wrote a v2 report", rep2 !== null && isJsonObject(rep2.inputs));
// Per run above, and no run in this suite made a write at all — no fixture has a write the drive or a step may make (the tail
// suite holds the same check over its own runs)
check(`across every run the server received no write (saw: ${writes.join(", ") || "none"})`, writes.length === 0);

finish();
report();
