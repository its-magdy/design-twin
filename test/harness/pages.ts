// Page-scoped reads: an unreadable page degrading, [LIST] listPages, [CHILDREN] listChildren, [PAGE] --page and
// [MEAS] measurements read from the exported pages.
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { FakeFigma, FakeNode, FullResult } from "../fake-figma.ts";
import { thrown, type Case, type Thrown } from "./helpers.ts";
import { world } from "./scene.ts";

// ---- the unreadable-page file: the base file's one page, then a page whose children read throws, with a failing
// loadAllPagesAsync. PageNode.children THROWS on a page that isn't current and wasn't loaded (dynamic-page access).
const unreadablePageWorld = () => world(
  (fx) => {
    const badPage = { name: "Locked Page", get children(): FakeNode[] { throw new Error("page not loaded"); },
      findAllWithCriteria: () => { throw new Error("page not loaded"); } };
    return { pages: [fx.page1, badPage] };
  },
  { loadAllPagesAsync: async () => { throw new Error("load failed"); } },
);

// ---- [CHILDREN]'s card: two direct children, one of which has a child of its own
const parentFrameOf = () => {
  const grandchild = { id: "gc:1", name: "Icon", type: "VECTOR", width: 12, height: 12 };
  const childText = { id: "ch:1", name: "Label", type: "TEXT", width: 40, height: 12, visible: false };
  const childFrame = { id: "ch:2", name: "Row", type: "FRAME", width: 100, height: 20, children: [grandchild] };
  return { id: "p:children", name: "Card", type: "FRAME", children: [childText, childFrame] };
};

// ---- [PAGE]'s file: two pages that share a name, and a third
const pagesOf = (scrollFrame: FakeNode): FakeNode[] => {
  const pgA: FakeNode = { name: "Screens", id: "p:A", children: [scrollFrame], loadAsync: async () => {}, findAllWithCriteria: () => [] };
  const pgB: FakeNode = { name: "Screens", id: "p:B", children: [], loadAsync: async () => {}, findAllWithCriteria: () => [] };
  const pgC: FakeNode = { name: "Archive", id: "p:C", children: [], loadAsync: async () => {}, findAllWithCriteria: () => [] };
  return [pgA, pgB, pgC];
};

export const cases: Case[] = [{
  name: "an unreadable page degrades, it does not abort",
  async run() {
    // ---- an unreadable page degrades, it does not abort ----
    // PageNode.children THROWS on a page that isn't current and wasn't loaded (dynamic-page access).
    // A failed loadAllPagesAsync must not abort the whole export here.
    const { api } = unreadablePageWorld();
    let fullErr: Thrown | null = null, full: FullResult | null = null;
    try { full = await api.collectFull({ allPages: true, css: false }); } catch (e) { fullErr = thrown(e); }
    ok("unreadable page does NOT abort the export", fullErr === null && !!full);
    ok("readable pages still exported alongside the bad one", !!(full && full.layersDoc.layers.length > 0));
    ok("unreadable page is warned, not silently dropped", !!(full && full.layersDoc.manifest.warnings.some((w) => /Locked Page.*could not be read/.test(w))));
    ok("untraversable page warned in the component catalog too", !!(full && full.layersDoc.manifest.warnings.some((w) => /component catalog.*Locked Page/.test(w))));
    ok("loadAllPagesAsync failure is itself reported", !!(full && full.layersDoc.manifest.warnings.some((w) => /loadAllPagesAsync failed/.test(w))));
  },
}, {
  name: "[LIST] listPages over an unreadable page",
  async run() {
    // ---- [LIST] listPages: the cheap structural index ----
    // Reuses the unreadable-page fixture above (root.children is [goodPage, badPage] and
    // loadAllPagesAsync throws) — the case where an index is most tempting to get wrong.
    const { api } = unreadablePageWorld();
    const listBad = await api.listPages({});
    const badEntry = listBad.pages.find((p) => p.name === "Locked Page");
    ok("[LIST] an unreadable page is still LISTED", !!badEntry);
    // The whole trap: an index that shows a readable-looking page with no frames reads as "this page is
    // empty" and the caller stops looking. It must be distinguishable.
    ok("[LIST] an unreadable page is flagged, not shown as empty", !!badEntry && badEntry.unreadable === true && badEntry.frames === undefined);
    ok("[LIST] and the reason is warned", listBad.manifest.warnings.some((w) => /Locked Page.*could not be read/.test(w)));
    ok("[LIST] a readable page still lists its frames alongside the bad one",
      Array.isArray(listBad.pages.find((p) => p.name === "Page 1")?.frames));
  },
}, {
  name: "[LIST] listPages: the cheap structural index",
  async run() {
    // The base file: one page ("Page 1", the open one, holding the scroll frame).
    const w = world();
    const { api } = w;
    const listed = await api.listPages({});
    ok("[LIST] reports the file name", listed.file === "My File");
    ok("[LIST] lists every page", listed.pages.length === w.figma.root.children.length);
    ok("[LIST] marks the current page", listed.pages.some((p) => p.current === true));
    const lf = must(listed.pages[0], "listed.pages[0]").frames;
    ok("[LIST] top-level frames carry id/name/type", Array.isArray(lf) && lf.length > 0 && lf.every((f) => f.id && f.name && f.type));
    const lfFrames = must(lf, "listed.pages[0].frames");
    ok("[LIST] frames carry size", lfFrames.every((f) => typeof f.w === "number" && typeof f.h === "number"));
    // The POINT of the op: it is an index, not an export. No recursion, no serialization, no assets.
    ok("[LIST] frames do NOT recurse (no children)", lfFrames.every((f) => f.children === undefined));
    ok("[LIST] frames carry no serialized detail (no fills/layout/tokens)",
      lfFrames.every((f) => f.fills === undefined && f.layout === undefined && f.tokens === undefined));
    ok("[LIST] no assets are produced", listed.assets === undefined);
    ok("[LIST] manifest counts pages and frames", listed.manifest.pages === listed.pages.length && typeof listed.manifest.frames === "number");
    // depth 1 = page names only, and must NOT pay for loading pages.
    // depth 2 must load — but PER PAGE, never with the blanket loadAllPagesAsync that the Figma docs
    // say to avoid "unless absolutely necessary". Same total work when every page is walked, but paid
    // incrementally, isolated per page, and without leaving the whole document resident for the session.
    let loadCalls = 0;
    let perPageLoads = 0;
    w.figma.loadAllPagesAsync = async () => { loadCalls++; };
    for (const p of w.figma.root.children) if (!p.loadAsync) p.loadAsync = async () => { perPageLoads++; };
    const depth1 = await api.listPages({ depth: 1 });
    ok("[LIST] depth 1 lists pages", depth1.pages.length === listed.pages.length && depth1.depth === 1);
    ok("[LIST] depth 1 omits frames entirely", depth1.pages.every((p) => p.frames === undefined));
    ok("[LIST] depth 1 loads NOTHING (that's why it's near-free)", loadCalls === 0 && perPageLoads === 0);
    await api.listPages({ depth: 2 });
    ok("[LIST] depth 2 loads each page individually, NOT loadAllPagesAsync",
      loadCalls === 0 && perPageLoads === w.figma.root.children.length);
    // A page that fails to load must cost only ITSELF — the whole reason for loading one at a time.
    const flaky = must(w.figma.root.children[0], "w.figma.root.children[0]");
    flaky.loadAsync = async () => { throw new Error("nope"); };
    const listFlaky = await api.listPages({ depth: 2 });
    ok("[LIST] a page that fails to load is warned, and the others still list",
      listFlaky.manifest.warnings.some((m) => /failed to load/.test(m)) && listFlaky.pages.length === w.figma.root.children.length);
  },
}, {
  name: "[CHILDREN] listChildren: the node-scoped twin of listPages depth 2",
  async run() {
    // ---- [CHILDREN] listChildren: the node-scoped twin of listPages depth 2 ----
    // listPages stops at a PAGE's top-level frames; this peeks one level inside a given NODE instead —
    // same cost model (no recursion, no assets), just addressed by id.
    const leafNode = { id: "leaf:children", name: "Glyph", type: "VECTOR", width: 8, height: 8 }; // no `children` key
    const { api } = world({ nodes: { "p:children": parentFrameOf(), "leaf:children": leafNode } });

    const kids = await api.listChildren("p:children");
    ok("[CHILDREN] reports the queried node's own id/name/type", kids.id === "p:children" && kids.name === "Card" && kids.type === "FRAME");
    ok("[CHILDREN] lists DIRECT children only", kids.children.length === 2);
    ok("[CHILDREN] each child carries id/name/type", kids.children.every((c) => c.id && c.name && c.type));
    ok("[CHILDREN] children carry size", kids.children.every((c) => typeof c.w === "number" && typeof c.h === "number"));
    ok("[CHILDREN] a hidden child is flagged", kids.children.find((c) => c.id === "ch:1")?.hidden === true);
    ok("[CHILDREN] a child that itself has children is flagged hasChildren:true", kids.children.find((c) => c.id === "ch:2")?.hasChildren === true);
    // The whole point of the op: it does NOT recurse. The grandchild must never appear anywhere.
    ok("[CHILDREN] does NOT recurse into grandchildren", JSON.stringify(kids).indexOf("gc:1") === -1);
    ok("[CHILDREN] no serialized detail leaks in (no fills/layout/tokens)",
      kids.children.every((c) => c.fills === undefined && c.layout === undefined && c.tokens === undefined));
    ok("[CHILDREN] no assets are produced", kids.assets === undefined);

    let leafErr: Thrown | null = null;
    try { await api.listChildren("leaf:children"); } catch (e) { leafErr = thrown(e); }
    ok("[CHILDREN] a leaf node (nothing to list) errors rather than returning an empty list", !!leafErr && /leaf/.test(leafErr.message));

    let childrenMissErr: Thrown | null = null;
    try { await api.listChildren("nope:children"); } catch (e) { childrenMissErr = thrown(e); }
    ok("[CHILDREN] an unknown node id errors", !!childrenMissErr && /not in the open file/.test(childrenMissErr.message));

    let childrenEmptyErr: Thrown | null = null;
    try { await api.listChildren(""); } catch (e) { childrenEmptyErr = thrown(e); }
    ok("[CHILDREN] an empty id errors", !!childrenEmptyErr && /No node id/.test(childrenEmptyErr.message));
  },
}, {
  name: "[CHILDREN] a node on an unloaded page",
  async run() {
    // A node on an UNLOADED page: getNodeByIdAsync only sees loaded pages under dynamic-page access, so
    // there has to be a fallback. It must load pages ONE AT A TIME and stop the moment the node
    // resolves — not call loadAllPagesAsync, which the Figma docs say to avoid unless necessary, and
    // which would pay for a 25-page file to find a node on page 1.
    let allPagesCalls = 0, incrementalLoads = 0;
    let unlockedPage = false;
    const lazyPage = { name: "Lazy", id: "p:lazy", loadAsync: async () => { incrementalLoads++; unlockedPage = true; }, get children() { return []; } };
    const laterPage = { name: "Later", id: "p:later", loadAsync: async () => { incrementalLoads++; }, get children() { return []; } };
    const parentFrame = parentFrameOf();
    // The node only resolves once its page has loaded: a lookup whose answer changes mid-run.
    const w = world({ pages: [lazyPage, laterPage] }, {
      loadAllPagesAsync: async () => { allPagesCalls++; },
      getNodeByIdAsync: async (id: string) => (id === "deep:1" && unlockedPage ? parentFrame : null),
    });
    const lazyKids = await w.api.listChildren("deep:1");
    ok("[CHILDREN] a node on an unloaded page is still found", lazyKids.children.length === 2);
    ok("[CHILDREN] the lookup loads pages incrementally, never loadAllPagesAsync", allPagesCalls === 0 && incrementalLoads === 1);
    ok("[CHILDREN] and stops as soon as the node resolves (later pages untouched)", incrementalLoads < w.figma.root.children.length);
  },
}, {
  name: "[CHILDREN] a non-current page is loaded before its children are read",
  async run() {
    // listChildren(pageId) on a page that ISN'T current: under dynamic-page access PageNode.children
    // throws until loadAsync() has run — https://developers.figma.com/docs/plugins/migrating-to-dynamic-loading/.
    // The fake page's `children` getter enforces exactly that.
    let otherPageLoaded = false;
    const otherPageFrame = { id: "opf:1", name: "Hero", type: "FRAME", width: 300, height: 100 };
    const otherPage = {
      type: "PAGE", id: "page:other", name: "Other Page",
      loadAsync: async () => { otherPageLoaded = true; },
      get children() {
        if (!otherPageLoaded) throw new Error("children could not be read (page not loaded)");
        return [otherPageFrame];
      },
    };
    const { api } = world({ nodes: { "page:other": otherPage } });
    const pageKids = await api.listChildren("page:other");
    ok("[CHILDREN] a non-current page is loaded before its children are read", pageKids.children.length === 1 && pageKids.children[0]?.id === "opf:1");
  },
}, {
  name: "[CHILDREN] the current page is still loaded",
  async run() {
    // The CURRENT page is not exempt either — the migration guide is explicit: "If you are accessing the
    // current page using an expression like figma.root.children[x], then you will be required to call
    // loadAsync()". loadPageSafely must run unconditionally for a PAGE node, even when it IS
    // figma.currentPage (a no-op there, but the call must still happen).
    let currentPageLoadCalls = 0;
    const currentPageFrame = { id: "cpf:1", name: "Current Frame", type: "FRAME", width: 10, height: 10 };
    const fakeCurrentPage: FakeFigma["currentPage"] = {
      type: "PAGE", id: "page:current", name: "Current Page",
      loadAsync: async () => { currentPageLoadCalls++; },
      children: [currentPageFrame],
      selection: [],
    };
    const { api } = world({ currentPage: fakeCurrentPage, nodes: { "page:current": fakeCurrentPage } });
    const currentKids = await api.listChildren("page:current");
    ok("[CHILDREN] the current page is still loaded (not skipped) before its children are read",
      currentPageLoadCalls === 1 && currentKids.children.length === 1 && currentKids.children[0]?.id === "cpf:1");
  },
}, {
  name: "[CHILDREN] listChildren(\"0:0\"), the document node",
  async run() {
    // listChildren("0:0") — the DOCUMENT node: its children are PageNodes, and reading `hasChildren` on
    // each of THEM has the identical dynamic-page rule, so every page must be loaded first too.
    let docPageALoaded = false, docPageBLoaded = false;
    const docPageA = {
      type: "PAGE", id: "page:a", name: "A",
      loadAsync: async () => { docPageALoaded = true; },
      get children() { if (!docPageALoaded) throw new Error("not loaded"); return [{ id: "a:frame", name: "F", type: "FRAME" }]; },
    };
    const docPageB = {
      type: "PAGE", id: "page:b", name: "B",
      loadAsync: async () => { docPageBLoaded = true; },
      get children() { if (!docPageBLoaded) throw new Error("not loaded"); return []; },
    };
    const documentNode = { type: "DOCUMENT", id: "0:0", name: "My File", children: [docPageA, docPageB] };
    const { api } = world({ nodes: { "0:0": documentNode } });
    const docKids = await api.listChildren("0:0");
    ok("[CHILDREN] listChildren(\"0:0\") succeeds and lists pages", docKids.children.length === 2 && docKids.children.some((c) => c.id === "page:a"));
    ok("[CHILDREN] each page was loaded before its hasChildren was read", docKids.children.find((c) => c.id === "page:a")?.hasChildren === true && docKids.children.find((c) => c.id === "page:b")?.hasChildren === false);
  },
}, {
  name: "[PAGE] --page: export ONE named page",
  async run() {
    // ---- [PAGE] --page: export ONE named page (not the one that happens to be open) ----
    // Verified against the Plugin API docs: PageNode.loadAsync() loads a single page, root.children is
    // readable without loading, and figma.currentPage does NOT need to change — so a --page export
    // leaves the user's editor where it is. That last fact is what made the metadata bugs below
    // possible: three fields still assumed "exported page == currentPage".
    const w = world((fx) => ({ pages: pagesOf(fx.scrollFrame) }));
    const { api } = w;
    const prevCurrent = w.figma.currentPage;

    const byId = await api.collectFull({ page: "p:A", css: false });
    ok("[PAGE] resolves a page by id", byId.layersDoc.layers.length > 0);
    // The three metadata bugs an API review caught: all reported figma.currentPage, which is NOT the
    // exported page (loadAsync deliberately does not navigate).
    ok("[PAGE] scope is a distinct 'page', not 'current-page'", byId.layersDoc.scope === "page");
    ok("[PAGE] `page` names the EXPORTED page, not the open one", byId.layersDoc.page === "Screens");
    ok("[PAGE] does not navigate the user (currentPage unchanged)", w.figma.currentPage === prevCurrent);
    // Every layer carries its page ID, not just the page NAME. The name is user-editable and the Plugin
    // API guarantees no uniqueness for it — pgA and pgB above are BOTH "Screens" — so a consumer keyed
    // on the name (bridge/pages-layout.js buckets pages into directories) merged two distinct pages
    // into one. The id is the only stable page identity that survives into the export.
    ok("[PAGE] every layer carries its page ID, not just the display name",
      byId.layersDoc.layers.every((l) => l.pageId === "p:A" && l.page === "Screens"));
    ok("[PAGE] and so does every index entry, so the manifest can disambiguate too",
      byId.layersDoc.index.every((e) => e.pageId === "p:A"));

    const byName = await api.collectFull({ page: "Archive", css: false });
    ok("[PAGE] resolves an unambiguous page by name", byName.layersDoc.page === "Archive");
    const byCase = await api.collectFull({ page: "  aRcHiVe ", css: false });
    ok("[PAGE] falls back to a UNIQUE case-insensitive name", byCase.layersDoc.page === "Archive");

    // Figma ALLOWS duplicate page names. Exact-name matching must not pick-first with no guard, which is
    // the likeliest real collision. Nothing here is interactive, so a wrong silent pick is unrecoverable.
    let dupErr: Thrown | null = null;
    try { await api.collectFull({ page: "Screens", css: false }); } catch (e) { dupErr = thrown(e); }
    ok("[PAGE] a DUPLICATE exact name errors instead of picking one", !!dupErr && /ambiguous/.test(dupErr.message));
    ok("[PAGE] the ambiguity error says to use the id", !!dupErr && /use its id/.test(dupErr.message));
    ok("[PAGE] and lists the available pages (self-healing)", !!dupErr && /p:A/.test(dupErr.message) && /p:C/.test(dupErr.message));

    let missErr: Thrown | null = null;
    try { await api.collectFull({ page: "Nope", css: false }); } catch (e) { missErr = thrown(e); }
    ok("[PAGE] an unknown page errors", !!missErr && /no page matches/.test(missErr.message));
    ok("[PAGE] the not-found error lists the valid choices", !!missErr && /Available pages/.test(missErr.message) && /"Archive"/.test(missErr.message));

    // Repeatable, and de-duplicated if the same page is named twice.
    const multi = await api.collectFull({ page: ["p:A", "p:C"], css: false });
    ok("[PAGE] accepts MULTIPLE pages", Array.isArray(multi.layersDoc.pages) && multi.layersDoc.pages.length === 2);
    ok("[PAGE] multi-page export omits the singular `page` field", multi.layersDoc.page === undefined);
    const dedup = await api.collectFull({ page: ["p:A", "p:A"], css: false });
    ok("[PAGE] the same page twice is exported once", dedup.layersDoc.pages === undefined && dedup.layersDoc.page === "Screens");

    // An explicitly-empty selector is a caller bug (an interpolated variable that came out blank) —
    // falling back silently would export the wrong page and say nothing.
    const blank = await api.collectFull({ page: "   ", css: false });
    ok("[PAGE] an empty selector warns rather than silently falling back",
      blank.layersDoc.manifest.warnings.some((m) => /page selector was empty/.test(m)));

    // allPages + page are MUTUALLY EXCLUSIVE. A plain `if (allPages) … else if
    // (page)` would let allPages silently win: a caller asking for one page would get all of them — a plausible
    // export of the WRONG scope. figma-pull's arg parser refuses this, but the MCP path does not go
    // through it, so the guard belongs at the collector where EVERY caller passes through it.
    let bothErr: Thrown | null = null;
    try { await api.collectFull({ allPages: true, page: "p:A", css: false }); } catch (e) { bothErr = thrown(e); }
    ok("[PAGE] allPages + page is REFUSED, not silently resolved", !!bothErr && /different scopes/.test(bothErr.message));
    ok("[PAGE] the scope-conflict error names both ways out", !!bothErr && /page:\[ids\]/.test(bothErr.message) && /whole file/.test(bothErr.message));
    // An all-pages export with no page selector must be unaffected by that guard.
    const stillAll = await api.collectFull({ allPages: true, css: false });
    ok("[PAGE] allPages alone still exports every page", stillAll.layersDoc.scope === "all-pages");
    // A blank selector alongside allPages is NOT a conflict — it trims to nothing, so there is no
    // second scope to conflict with, and refusing it would fail a run that asked for exactly one thing.
    const allBlank = await api.collectFull({ allPages: true, page: "  ", css: false });
    ok("[PAGE] allPages + a BLANK page selector is not a conflict", allBlank.layersDoc.scope === "all-pages");
  },
}, {
  name: "[MEAS] measurements are read from the EXPORTED pages",
  async run() {
    // ---- [MEAS] measurements are read from the EXPORTED pages, not from whatever page is open ----
    // This does not hardcode figma.currentPage, so a --page export of a non-current page does not attach the
    // OPEN page's redlines to a doc about a different page. Each entry carries its own page tag.
    const redline = (id: string) => [{ start: { node: { id } , side: "LEFT" }, end: { node: { id }, side: "RIGHT" }, offset: 8, freeText: id }];
    const w = world((fx) => ({ pages: pagesOf(fx.scrollFrame) }));
    const pgA = must(w.figma.root.children[0], "page p:A"), pgC = must(w.figma.root.children[2], "page p:C");
    pgA.getMeasurements = () => redline("a");
    pgC.getMeasurements = () => redline("c");
    const measMulti = await w.api.collectFull({ page: ["p:A", "p:C"], measurements: true, css: false });
    const measurements = must(measMulti.layersDoc.measurements, "measMulti.layersDoc.measurements");
    ok("[MEAS] each redline is tagged with the page it came from",
      measurements.some((m) => m.page === "Screens" && m.text === "a") &&
      measurements.some((m) => m.page === "Archive" && m.text === "c"));
    ok("[MEAS] and with the page ID too — the name alone can't tell two same-named pages apart",
      measurements.every((m) => m.pageId === (m.text === "a" ? "p:A" : "p:C")));
    // Two pages CAN legitimately share identical redlines — that is data, not an error: emit both.
    pgC.getMeasurements = () => redline("a");
    const measDup = await w.api.collectFull({ page: ["p:A", "p:C"], measurements: true, css: false });
    ok("[MEAS] identical sets on two pages are both emitted, not de-duplicated", must(measDup.layersDoc.measurements, "measDup.layersDoc.measurements").length === 2);
  },
}];
