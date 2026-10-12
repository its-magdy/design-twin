// End-to-end tests for the probe half of the drive, the serial tail: the BUILT claude-plugin/scripts/verify-probe.js in a real
// chromium from a temp consumer project of its own (test/drive-e2e-fixture.ts — the same project, "Plot Ledger" fixture, server
// and write accounting as the pooled suite, test/verify-probe-drive-e2e.test.ts).
//
// Why serial: these are the cases with POSITIVE timing assertions — a --max-time budget that must be honoured, a reload /
// navigation / replaceState N ms after a load or a click, a load answered just past the 10 s cap or the --timeout, the
// token-switch poll spacing, the scroll-restore cap. They run strictly one at a time (no pool), so concurrent chromiums' CPU
// cannot flip them; CI runs this suite and the pooled one on separate runners, and never two browser suites at once on one.
//
// The repros (plot-ledger.html, plot-ledger-edge.html, one ?mode= each): the drive's own budget at a small --max-time, a
// replaceState after load, a reload while settling into a half-loaded document (with and without --ready), a reload after a
// step's in-place click, a goto step whose page then reloads, a reload while waiting for --ready, driving pages whose reach
// never answers (budget), a covered opener in a smooth app shell (also forced by a page's !important rule, and a page that
// reads the scroll it painted, &painted=1); a click that reloads the same URL (every time, at once, 100 ms later, once), a
// document replaced right after settling, a step's navigation into a document that never finishes loading; a late navigation
// into a document that loads late, a reload into a never-loading one after an in-place click, a load note gone stale, the
// measured-anyway document's own late load, same-URL links handled in place then a reload, the real "kept navigating"
// duration, a page going on to a server that never answers before its load, a client redirect's late own load.
//
// needs the repo's devDependency `playwright` + chromium. Locally an unavailable renderer prints SKIPPED; in CI
// (CI=true) that is a failure.  Run with:  node test/verify-probe-drive-tail-e2e.test.ts
import { check, report } from "./assert.ts";
import { READY, ix, loadNote, out, startDriveFixture, type Run } from "./drive-e2e-fixture.ts";

const { url, edge, probe, read, written, writes, EXPECTED, QUIET, finish } =
  await startDriveFixture("dt-probe-drive-tail-e2e-", "verify-probe drive e2e, serial tail — the built bundles in a real chromium, from a temp project:");

// ---- the runs (T): each started only when the one before it has finished (wall-clock windows, see the header)
const T = {
  budget25000: () => probe(["--expected", EXPECTED, "--url", url(), "--out", out("Budget25000"), "--steps", "steps.json", "--ready", READY, "--max-time", "25000"]),
  budget30000: () => probe(["--expected", EXPECTED, "--url", url(), "--out", out("Budget30000"), "--steps", "steps.json", "--ready", READY, "--max-time", "30000"]),
  replace: () => probe(["--expected", QUIET, "--url", url("replace-state"), "--out", out("Replace"), "--max-time", "60000"]),
  reloadSettle: () => probe(["--expected", QUIET, "--url", edge("reload-settle"), "--out", out("ReloadSettle"), "--ready", READY, "--max-time", "60000"]),
  reloadSettleNoReady: () => probe(["--expected", QUIET, "--url", edge("reload-settle"), "--out", out("ReloadSettleNoReady"), "--max-time", "60000"]),
  reloadStep: () => probe(["--expected", QUIET, "--url", edge("reload-step"), "--out", out("ReloadStep"), "--steps", "steps-reload-step.json", "--ready", READY, "--max-time", "60000"]),
  gotoReload: () => probe(["--expected", QUIET, "--url", edge("reload-after-goto"), "--out", out("GotoReload"), "--steps", "steps-goto-reload.json", "--ready", READY, "--max-time", "60000"]),
  reloadLate: () => probe(["--expected", QUIET, "--url", edge("reload-late"), "--out", out("ReloadLate"), "--steps", "steps-click-only.json", "--ready", READY, "--max-time", "60000"]),
  slowReach: () => probe(["--expected", EXPECTED, "--url", edge("slow-reach"), "--out", out("SlowReach"), "--timeout", "30000", "--max-time", "22000"]),
  smoothShell: () => probe(["--expected", EXPECTED, "--url", edge("smooth-shell"), "--out", out("SmoothShell"), "--max-time", "60000"]),
  smoothShellImportant: () => probe(["--expected", EXPECTED, "--url", `${edge("smooth-shell")}&important=1`, "--out", out("SmoothShellImportant"), "--max-time", "60000"]),
  smoothShellPainted: () => probe(["--expected", EXPECTED, "--url", `${edge("smooth-shell")}&important=1&painted=1`, "--out", out("SmoothShellPainted"), "--max-time", "60000"]),
  clickReloads: () => probe(["--expected", QUIET, "--url", edge("click-reloads"), "--out", out("ClickReloads"), "--steps", "steps-click-only.json", "--ready", READY, "--max-time", "60000"]),
  tokenSwitch: () => probe(["--expected", QUIET, "--url", edge("token-switch"), "--out", out("TokenSwitch"), "--max-time", "60000"]),
  clickReloadsSync: () => probe(["--expected", QUIET, "--url", `${edge("click-reloads")}&delay=sync`, "--out", out("ClickReloadsSync"), "--steps", "steps-click-only.json", "--max-time", "60000"]),
  clickReloads100: () => probe(["--expected", QUIET, "--url", `${edge("click-reloads")}&delay=100`, "--out", out("ClickReloads100"), "--steps", "steps-click-only.json", "--ready", READY, "--max-time", "60000"]),
  clickReloadsOnce: () => probe(["--expected", QUIET, "--url", `${edge("click-reloads")}&delay=sync&once=1`, "--out", out("ClickReloadsOnce"), "--steps", "steps-click-only.json", "--max-time", "60000"]),
  hangImg: () => probe(["--expected", QUIET, "--url", edge("hang-img"), "--out", out("HangImg"), "--steps", "steps-reload-step.json", "--ready", READY, "--max-time", "22000"]),
  lateSlow: () => probe(["--expected", QUIET, "--url", edge("late-slow"), "--out", out("LateSlow"), "--steps", "steps-click-only.json", "--ready", READY, "--max-time", "60000"]),
  reloadHang: () => probe(["--expected", QUIET, "--url", edge("reload-hang"), "--out", out("ReloadHang"), "--steps", "steps-click-only.json", "--ready", READY, "--max-time", "60000"]),
  lateLoad: () => probe(["--expected", QUIET, "--url", edge("late-load"), "--out", out("LateLoad"), "--steps", "steps-late.json", "--ready", READY, "--max-time", "60000"]),
  slowStay: () => probe(["--expected", QUIET, "--url", `${edge("slow-stay")}&d=7000`, "--out", out("SlowStay"), "--steps", "steps-slow-stay.json", "--ready", READY, "--timeout", "5000", "--max-time", "60000"]),
  linkInplaceReload: () => probe(["--expected", QUIET, "--url", `${edge("link-inplace-reload")}&d=300`, "--out", out("LinkInplaceReload"), "--steps", "steps-click-only.json", "--max-time", "60000"]),
  linkEmptyReload: () => probe(["--expected", QUIET, "--url", `${edge("link-empty-reload")}&d=300`, "--out", out("LinkEmptyReload"), "--steps", "steps-click-only.json", "--max-time", "60000"]),
  // (--ready on an element that never comes keeps the settle on the page while it navigates)
  slowChurn: () => probe(["--expected", QUIET, "--url", edge("slow-churn"), "--out", out("SlowChurn"), "--ready", "#never-drawn", "--timeout", "12000", "--max-time", "60000"]),
  bounceHang: () => probe(["--expected", QUIET, "--url", edge("bounce-hang"), "--out", out("BounceHang"), "--timeout", "12000", "--max-time", "40000"]),
  redirSlow: () => probe(["--expected", QUIET, "--url", edge("redir-slow"), "--out", out("RedirSlow"), "--steps", "steps-redir-slow.json", "--ready", READY, "--timeout", "30000", "--max-time", "90000"]),
};
console.log(`serial: ${Object.keys(T).length} runs, one at a time`);

// the drive keeps its own budget (min(60 s, --max-time left − 15 s)) whatever the behaviour battery reserves after it — at a
// small --max-time the first rows are still driven (--behaviour off: no behaviour work at all)
for (const [mt, ids] of [["25000", ["70:44"]], ["30000", ["70:44", "70:45"]]] as const) {
  const bm = out(`Budget${mt}`);
  const rm = await T[`budget${mt}`]();
  const mm = read(bm);
  if (rm.status !== 0) console.log(rm.stderr);
  check(`--max-time ${Number(mt) / 1000} s, --behaviour off: ${ids.join(" and ")} driven ok:true as the drive alone drives them (its budget never shrinks for the behaviour battery)`,
    rm.status === 0 && ids.every((id) => ix(mm, id)?.ok === true && ix(mm, id)?.cut === undefined));
}

// a same-document URL rewrite after load (replaceState) is no navigation — only a document load is
const b9 = out("Replace");
const r9 = await T.replace();
const m9 = read(b9);
if (r9.status !== 0) console.log(r9.stderr);
check("a replaceState 100 ms after load (no --steps) → afterInitialLoad 0 (framenavigated logged, never counted)",
  r9.status === 0 && m9?.navigation?.afterInitialLoad === 0 && (m9.navigation.events || []).some((e) => e.type === "framenavigated" && /tab=harvest/.test(e.url)));

// a reload 300 ms after load into a document that stays half-loaded for 2.5 s — the probe must wait for it
const b11 = out("ReloadSettle");
const r11 = await T.reloadSettle();
const m11 = read(b11);
if (r11.status !== 0) console.log(r11.stderr);
check("a reload while settling into a half-loaded document → waited for: the root by tag, its heading measured, afterInitialLoad 1 (the reload's load), re-runs 0",
  r11.status === 0 && m11?.frame?.via === "tag" && m11.frame.nodeId === "70:1" && (m11.nodes || []).some((n) => n.nodeId === "70:2" && n.matchedBy === "tag")
  && m11.navigation?.afterInitialLoad === 1 && m11.navigation.reruns === 0);
const b11b = out("ReloadSettleNoReady");
const r11b = await T.reloadSettleNoReady();
const m11b = read(b11b);
check("the same without --ready (nothing to wait for but the quiet window) → still the reloaded document, measured once it loaded",
  r11b.status === 0 && m11b?.frame?.via === "tag" && m11b.navigation?.afterInitialLoad === 1);

// (steps) a load the step did not start is not the probe's own — it counts, and (the click's state is gone) the
// pass is re-run once with the steps replayed
const b12 = out("ReloadStep");
const r12 = await T.reloadStep();
const m12 = read(b12);
if (r12.status !== 0) console.log(r12.stderr);
check("a reload 300 ms after a step's in-place click → not absorbed by the step: afterInitialLoad 1, re-runs 1 (steps replayed), the root by tag",
  r12.status === 0 && m12?.navigation?.afterInitialLoad === 1 && m12.navigation.reruns === 1 && m12.frame?.via === "tag");
const b12b = out("GotoReload");
const r12b = await T.gotoReload();
const m12b = read(b12b);
if (r12b.status !== 0) console.log(r12b.stderr);
check("a goto step whose page then reloads by itself → the goto's load is absorbed, the reload's is not: afterInitialLoad 1, re-runs 0",
  r12b.status === 0 && m12b?.navigation?.afterInitialLoad === 1 && m12b.navigation.reruns === 0 && m12b.frame?.via === "tag");
const b12c = out("ReloadLate");
const r12c = await T.reloadLate();
const m12c = read(b12c);
if (r12c.status !== 0) console.log(r12c.stderr);
check("a reload 1 s after an in-place click (while waiting for --ready, the section lost) → re-run with the steps replayed: exit 0, re-runs 1, the root by tag",
  r12c.status === 0 && m12c?.navigation?.reruns === 1 && m12c.navigation.afterInitialLoad === 1 && m12c.frame?.via === "tag");

// every driving page's reach hangs (the server never answers again); --timeout 30 s, --max-time 22 s → about 6 s of
// driving: the cut closes the row's context mid-reach, so the run ends inside --max-time with the measured file written
const b14 = out("SlowReach");
const r14 = await T.slowReach();
const s14 = r14.ms;
const m14 = read(b14);
if (r14.status !== 0) console.log(r14.stderr);
check(`a driving reach that never answers is cut by the budget mid-reach → exit 0 in ${Math.round(s14 / 1000)} s (< 22 s), measured written, every row ok:null cut budget`,
  r14.status === 0 && s14 < 22_000 && m14 !== null && (m14.interactions || []).length === 8 && (m14.interactions || []).every((i) => i.ok === null && i.cut === "budget"));

// a covered opener in a scroll-behavior:smooth app-shell scroller — the drive's scroll is restored at once,
// so the synthetic click lands on the shell as the drive had it; nothing the page itself scrolls animates either (the probe's
// init CSS); with the page's own !important ID rule beating the init CSS, the restore is still instant
const bR6s = out("SmoothShell");
const rR6s = await T.smoothShell();
const mR6s = read(bR6s), eR6s = ix(mR6s, "70:49"), jR6s = ix(mR6s, "70:50");
if (rR6s.status !== 0) console.log(rR6s.stderr);
check(`a covered opener in a smooth-scrolling app shell → synthetic click with the shell back at its scroll: the popover anchored at click time is at y 100 (saw ${String(eR6s?.opened?.rect.y)}), the dialog detected`,
  rR6s.status === 0 && eR6s?.activation === "synthetic" && eR6s.opened?.rect.y === 100 && eR6s.detectedBy === "[role=dialog]");
check(`the page's own scroll in a smooth shell (scrollTo 300 on click, 70:50) is instant under the probe: its popover is at y 400 (saw ${String(jR6s?.opened?.rect.y)})`,
  jR6s?.activation === "mouse" && jR6s.opened?.rect.y === 400);
const bR6i = out("SmoothShellImportant");
const rR6i = await T.smoothShellImportant();
const eR6i = ix(read(bR6i), "70:49");
if (rR6i.status !== 0) console.log(rR6i.stderr);
check(`the same shell forced smooth by the page's !important ID rule → the drive's restore is still instant: y 100 (saw ${String(eR6i?.opened?.rect.y)})`,
  rR6i.status === 0 && eR6i?.activation === "synthetic" && eR6i.opened?.rect.y === 100);
// the same !important-smooth shell, where the page reads the scroll in requestAnimationFrame —
// its popover is anchored at the shell's scroll in the last frame PAINTED before the click: 100 only when the drive's restore held
// for frames before its synthetic click (restore, two frames, look again — twice in a row), deterministic under any load (a single
// restore right before the click could still be moved by a smooth scroll Playwright's retry started)
const bR6p = out("SmoothShellPainted");
const rR6p = await T.smoothShellPainted();
const eR6p = ix(read(bR6p), "70:49");
if (rR6p.status !== 0) console.log(rR6p.stderr);
check(`the !important-smooth shell, popover anchored at the last painted frame's scroll → the restored scroll held before the synthetic click: y 100 (saw ${String(eR6p?.opened?.rect.y)})`,
  rR6p.status === 0 && eR6p?.activation === "synthetic" && eR6p.opened?.rect.y === 100);

// a click that reloads the SAME URL after changing the page in place, every time → exit 4 naming the step, not the watch-tree hint
const bR = out("ClickReloads");
const rR = await T.clickReloads();
check("a click that reloads the same URL after its in-place change, on the pass and the re-run → exit 4, nothing written, the step named, 'not a navigation step', no watch-tree hint",
  rR.status === 4 && !written(bR) && /after step 1 \{click: "\[data-dt-node=\\?"70:30\\?"\]"\} had changed it in place/.test(rR.stderr)
  && /on the first pass and again on the re-run/.test(rR.stderr) && /not a\s+navigation step/.test(rR.stderr) && !/watch tree/.test(rR.stderr) && /navigation log/.test(rR.stderr));
// the document replaced right after settling (simulated by a token that changes at the first plain read after the
// settle polls) → the pass compares against the token settle saw quiet → one re-run
const bA = out("TokenSwitch");
const rA = await T.tokenSwitch();
const mA = read(bA);
if (rA.status !== 0) console.log(rA.stderr);
check("a document replaced between settling and measuring → caught (the settled token is compared): exit 0, re-runs 1",
  rA.status === 0 && mA?.navigation?.reruns === 1 && mA.frame?.via === "tag");

// a same-URL navigation is never a click's own, even one its handler starts at once or 100 ms later — after the
// click's in-place change it loses the steps' state: one re-run, then (every time) the step-specific exit 4
const stepLost = (r: Run): boolean => r.status === 4 && /after step 1 \{click: "\[data-dt-node=\\?"70:30\\?"\]"\} had changed it in place/.test(r.stderr)
  && /on the first pass and again on the re-run/.test(r.stderr) && !/watch tree/.test(r.stderr);
// a same-URL reload at once / 100 ms after the click's in-place change, every time or once
const bS = out("ClickReloadsSync");
const rS = await T.clickReloadsSync();
if (!stepLost(rS)) console.log(rS.stderr);
check("`draw(); location.reload()` in the click handler, every time (no --ready) → the reload is not the click's: one re-run, then exit 4 naming the step, nothing written (was: exit 0 measuring the default section)",
  stepLost(rS) && !written(bS));
const bH = out("ClickReloads100");
const rH = await T.clickReloads100();
if (!stepLost(rH)) console.log(rH.stderr);
check("a reload 100 ms after the click's in-place change, every time (--ready) → exit 4 naming the step (was: the generic '--ready never visible')",
  stepLost(rH) && !written(bH) && !/never became visible/.test(rH.stderr));
const bO = out("ClickReloadsOnce");
const rO = await T.clickReloadsOnce();
const mO = read(bO);
if (rO.status !== 0) console.log(rO.stderr);
check("the same sync reload on the first click only → re-run with the steps replayed: exit 0, re-runs 1, afterInitialLoad 1, the root by tag",
  rO.status === 0 && mO?.navigation?.reruns === 1 && mO.navigation.afterInitialLoad === 1 && mO.frame?.via === "tag" && mO.frame.nodeId === "70:1");
// the click's navigation lands on a document whose image never loads — the load wait is per document: the click's
// settle waits its 10 s, the waitFor step's and the --ready settle do not wait again (10 s each would pass --max-time)
const bG = out("HangImg");
const rG = await T.hangImg();
const sG = rG.ms;
const mG = read(bG);
if (rG.status !== 0) console.log(rG.stderr);
check(`a step's navigation into a document that never finishes loading + a waitFor step + --ready → exit 0 in ${Math.round(sG / 1000)} s (< 22 s: one 10 s load wait, not three), the root by tag, the 'had not finished loading' note`,
  rG.status === 0 && sG < 22_000 && mG?.frame?.via === "tag" && (mG.notes || []).some((n) => /the document had not finished loading after 10s/.test(n)));

// a document a late navigation brings in gets its own 10 s for its load (per document), not the rest of the settle's
const bLS = out("LateSlow");
const rLS = await T.lateSlow();
const mLS = read(bLS);
if (rLS.status !== 0) console.log(rLS.stderr);
check("a click navigating 7 s later into a document that loads 5 s after (--ready its root) → settled on, not 'kept navigating': exit 0, the root by tag, its heading measured, a quiet window of its own (no load / still-changing note)",
  rLS.status === 0 && mLS?.frame?.via === "tag" && mLS.frame.nodeId === "70:1" && (mLS.nodes || []).some((n) => n.nodeId === "70:2")
  && !(mLS.notes || []).some((n) => /had not finished loading|still changing/.test(n)));
// guard: no load wait decides a lost state — a reload after an in-place click into a document that never
// finishes loading still loses the steps' state (at its commit): one re-run, then the step-specific exit 4
const bRH = out("ReloadHang");
const rRH = await T.reloadHang();
if (!stepLost(rRH)) console.log(rRH.stderr);
check("a reload after the click's in-place change into a document that never finishes loading, every time → exit 4 naming the step, nothing written (was: 'kept navigating' + the dev-server hint)",
  stepLost(rRH) && !written(bRH));
// a document whose load timed out in one settle and completed before a later one carries no stale note
const bLL = out("LateLoad");
const rLL = await T.lateLoad();
const mLL = read(bLL);
if (rLL.status !== 0) console.log(rLL.stderr);
check("a document whose load timed out in the click's settle and completed before the next ones → exit 0, the root by tag, no 'had not finished loading' note",
  rLL.status === 0 && mLL?.frame?.via === "tag" && mLL !== null && !loadNote(mLL));

// the measured-anyway --url document's own late load (after a click changed it in place) is no reload
const bSS = out("SlowStay");
const rSS = await T.slowStay();
const mSS = read(bSS);
if (rSS.status !== 0) console.log(rSS.stderr);
check("the --url document taken after --timeout 5 s (its load given up) loads at 7 s, after the click changed it in place (while a waitFor step waits) → its own late load: exit 0, re-runs 0, the root by tag (was: 'the page reloaded … after step 1', exit 4)",
  rSS.status === 0 && mSS?.navigation?.reruns === 0 && mSS.frame?.via === "tag" && mSS.frame.nodeId === "70:1");
// a link to the current URL that the app handles in place, then a reload 300 ms later — a genuine reload (a re-run)
for (const [mode, label] of [["link-inplace-reload", "a link to the URL"], ["link-empty-reload", "an <a href=\"\">"]] as const) {
  const b = out(mode === "link-inplace-reload" ? "LinkInplaceReload" : "LinkEmptyReload");
  const r = await (mode === "link-inplace-reload" ? T.linkInplaceReload() : T.linkEmptyReload());
  const m = read(b);
  if (r.status !== 0) console.log(r.stderr);
  check(`${label} handled in place, the page reloading 300 ms later (once) → not the link's load: afterInitialLoad 1, re-runs 1, the root by tag (was: swallowed, the other section measured)`,
    r.status === 0 && m?.navigation?.afterInitialLoad === 1 && m.navigation.reruns === 1 && m.frame?.via === "tag" && m.frame.nodeId === "70:1");
}
// "kept navigating for Ns" states the real duration (a first new document at 8 s has its own window; the next one ends it)
const bKN = out("SlowChurn");
const rKN = await T.slowChurn();
if (!/kept navigating/.test(rKN.stderr)) console.log(rKN.stderr);
const kn = /kept navigating for (\d+)s/.exec(rKN.stderr);
check(`a reload at 8 s into a never-loading document that reloads again 6 s later → exit 4 'kept navigating for ${kn?.[1] ?? "?"}s' (the real duration, > 10 s; not a fixed 10s)`,
  rKN.status === 4 && kn !== null && Number(kn[1]) > 11 && !written(bKN));

// ---- pages going on to a server that never answers
// a page that arrives and goes on (before its load) to a server that never answers → "could not load" at --timeout
const bBH = out("BounceHang");
const rBH = await T.bounceHang();
const sBH = rBH.ms;
if (!/could not load/.test(rBH.stderr)) console.log(rBH.stderr);
check(`the --url page goes on, before its load, to a server that never answers → exit 4 'could not load' at --timeout (${Math.round(sBH / 1000)} s < 30 s), nothing written (was: a hang until --max-time)`,
  rBH.status === 4 && /could not load/.test(rBH.stderr) && sBH < 30_000 && !written(bBH));
// a document the page redirected to itself, measured "anyway" at 10 s, whose load comes after an in-place click
const bRS = out("RedirSlow");
const rRS = await T.redirSlow();
const mRS = read(bRS);
if (rRS.status !== 0) console.log(rRS.stderr);
check("a client redirect to a document whose load comes at 11 s (past the 10 s cap), after a click changed it in place → its own late load: exit 0, re-runs 0, the root by tag (was: 'the page reloaded … after step 2', exit 4)",
  rRS.status === 0 && mRS?.navigation?.reruns === 0 && mRS.frame?.via === "tag" && mRS.frame.nodeId === "70:1");


// Per run above, and no run in this suite made a write at all — no fixture has a write the drive or a step may make (the pooled
// suite holds the same check over its own runs)
check(`across every run the server received no write (saw: ${writes.join(", ") || "none"})`, writes.length === 0);

finish();
report();
