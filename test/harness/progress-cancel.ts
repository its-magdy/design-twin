// [PROGRESS] / [CANCEL] a long export must be watchable AND stoppable (progress.ts, state.ts's run chain).
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { FakeNode, FullResult, RunInfo } from "../fake-figma.ts";
import { thrown, type Case, type Thrown } from "./helpers.ts";
import { world } from "./scene.ts";

export const cases: Case[] = [{
  // One case: the cancel half asserts what a cancel leaves behind for the NEXT run (state reset, a stale
  // cancel not carried over), so its runs share one plugin instance on purpose.
  name: "[PROGRESS] / [CANCEL] a long export must be watchable AND stoppable",
  async run() {
    // An --all-pages pull measured 10+ minutes on a real file, during which the plugin window said only
    // "Exporting…" and offered no way out. Both halves are driven through serializeRun (the same entry
    // point main.ts and bridge.ts use) because progress and cancellation only exist inside a bracketed
    // run — a collector called directly must stay completely silent, which is asserted below.
    const w = world();
    const { api, figma, posted } = w;
    const { scrollFrame } = w.fx;
    const pcPage = (id: string, name: string, kids: FakeNode[]) => ({ id, name, children: kids || [], loadAsync: async () => {}, findAllWithCriteria: () => [] });
    const pc1 = pcPage("p:pc1", "Home", [scrollFrame]);
    const pc2 = pcPage("p:pc2", "Checkout", []);
    const pc3 = pcPage("p:pc3", "Archive", []);
    figma.root.children = [pc1, pc2, pc3];
    // Only this run's frames: drop the `selection` frame main.ts posts when it loads.
    posted.length = 0;

    const run = await api.serializeRun(() => api.collectFull({ allPages: true, css: false }), { source: "ui", label: "test-full" });
    ok("[PROGRESS] the export itself is unaffected — it still returns its layers", run.layersDoc.layers.length > 0);
    ok("[PROGRESS] the run is bracketed by run-begin … run-end",
      posted[0]?.type === "run-begin" && posted[posted.length - 1]?.type === "run-end");
    ok("[PROGRESS] run-begin names WHO asked (so a bridge pull isn't mistaken for your own click)",
      posted[0]?.source === "ui" && posted[0]?.label === "test-full");
    const pageFrames = posted.filter((m) => m.type === "progress" && m.phase === "pages" && m.page);
    // Page boundaries are the frames that must NEVER be dropped by the throttle — a missed one leaves
    // the status line naming a page the walk already finished.
    ok("[PROGRESS] one frame per page boundary, 1-based, with the total",
      [1, 2, 3].every((i) => pageFrames.some((m) => m.page?.index === i && m.page?.of === 3)));
    ok("[PROGRESS] the frame carries the page NAME for display…", pageFrames.some((m) => m.page?.index === 2 && m.page?.name === "Checkout"));
    // Page names are NOT unique in Figma; the id is the identity. Same rule as the exported docs.
    ok("[PROGRESS] …and the pageId, which is the actual identity", pageFrames.some((m) => m.page?.pageId === "p:pc2"));
    ok("[PROGRESS] running node/asset counters ride along", pageFrames.every((m) => typeof m.nodes === "number" && typeof m.assets === "number"));
    ok("[PROGRESS] the design-system phase is announced (the walk going quiet reads as a hang otherwise)",
      posted.some((m) => m.type === "progress" && m.phase === "design-system"));

    posted.length = 0;
    await api.collectFull({ css: false });
    ok("[PROGRESS] a collector driven OUTSIDE a bracketed run posts nothing at all", posted.length === 0);

    // ---- cancel mid-export, on a BRIDGE-triggered run ----
    // The trap page requests the cancel while its children are being read, so the very next safe point
    // (the top-level frame loop) is where the walk aborts.
    posted.length = 0;
    let cancelHit = null as RunInfo | null; // widened: TS cannot see the getter below assign it
    const trapPage = { id: "p:trap", name: "Trap", loadAsync: async () => {}, findAllWithCriteria: () => [],
      get children() { cancelHit = api.requestCancel(); return [scrollFrame]; } };
    figma.root.children = [trapPage, pc2];
    let cancelErr: Thrown | null = null, cancelled: FullResult | null = null;
    try {
      cancelled = await api.serializeRun(() => api.collectFull({ allPages: true, css: false }), { source: "bridge", label: "exportFull" });
    } catch (e) { cancelErr = thrown(e); }
    // (c): a cancelled run must REJECT. A partial layers doc returned as if complete is the silent
    // truncation this codebase refuses everywhere else.
    ok("[CANCEL] a cancelled run rejects — no partial doc is ever handed back", cancelled === null && !!cancelErr);
    // (a): this exact string is what main.ts puts in `bridge-result.error`, so the CLI/MCP fails fast
    // with a human cause instead of sitting out its request timeout.
    ok("[CANCEL] with the message the CLI/MCP prints verbatim", /export cancelled by the designer in Figma/.test(must(cancelErr, "cancelErr").message));
    ok("[CANCEL] the cancel was matched to the live run", !!(cancelHit && cancelHit.source === "bridge" && cancelHit.label === "exportFull"));
    ok("[CANCEL] the bridge-triggered run was visible in the plugin window, and for whom",
      posted.some((m) => m.type === "run-begin" && m.source === "bridge" && m.label === "exportFull"));
    ok("[CANCEL] the run is still closed out, so the UI cannot hang on a cancelled export",
      posted[posted.length - 1]?.type === "run-end");

    // ---- cancel INSIDE the component-catalog walk ----
    // The one place a run flips a GLOBAL Figma toggle (skipInvisibleInstanceChildren). Its `finally`
    // has to restore it on the cancellation path too, or every later export silently loses hidden
    // instance children.
    posted.length = 0;
    figma.skipInvisibleInstanceChildren = false;
    const catA = { id: "p:catA", name: "Cat A", children: [], loadAsync: async () => {},
      findAllWithCriteria: () => { api.requestCancel(); return []; } };
    figma.root.children = [catA, pcPage("p:catB", "Cat B", [])];
    let dsErr: Thrown | null = null;
    try { await api.serializeRun(() => api.collectDesignSystemOnly({}), { source: "ui", label: "exportDesignSystem" }); } catch (e) { dsErr = thrown(e); }
    ok("[CANCEL] a cancel inside the component-catalog page walk aborts it as well",
      !!dsErr && /export cancelled by the designer in Figma/.test(dsErr.message));
    ok("[CANCEL] and skipInvisibleInstanceChildren is restored, not stranded on", figma.skipInvisibleInstanceChildren === false);
    delete figma.skipInvisibleInstanceChildren;

    // (b): the whole point of resetting state — the NEXT export has to work.
    posted.length = 0;
    figma.root.children = [pc1, pc2];
    const after = await api.serializeRun(() => api.collectFull({ allPages: true, css: false }), { source: "ui", label: "after-cancel" });
    ok("[CANCEL] state is fully reset: the very next export runs to completion", after.layersDoc.layers.length > 0);
    ok("[CANCEL] …and reports progress normally again", posted.some((m) => m.type === "progress" && m.phase === "pages"));

    // (d): a cancel that landed on a run which finished before reaching a safe point must not carry
    // over. The flag is cleared at the START of every run precisely so a stale one can't kill the next.
    await api.serializeRun(async () => { api.requestCancel(); return "done"; }, { source: "ui", label: "stale" });
    const survivor = await api.serializeRun(() => api.collectFull({ allPages: true, css: false }), { source: "ui", label: "next" });
    ok("[CANCEL] a STALE cancel does not abort the following export", survivor.layersDoc.layers.length > 0);
    ok("[CANCEL] a cancel with nothing running is refused outright, not armed for later", api.requestCancel() === null);
  },
}];
