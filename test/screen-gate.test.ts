// Offline tests for the probe's --ready screen gate (design-to-code/screen-gate.ts) on a fake page: what it waits for,
// how it judges a wait that ran out (every miss kind, and the untagged root it takes for the screen), its hints and
// its note. No browser.
// Run with:  bun test/screen-gate.test.ts
import { check, report } from "./assert.ts";
import { ScreenGate } from "../design-to-code/screen-gate.ts";
import type { GatePage, ScreenJudgement } from "../design-to-code/screen-gate.ts";
import type { ScreenTags } from "../design-to-code/probe-page.ts";
import type { Expectation } from "../design-to-code/verify-shared.ts";

const FRAME = "1:1";
const TAG = `[data-dt-node="${FRAME}"]`;
/** a screen root with four own tags */
const EXP: Expectation = { frame: { nodeId: FRAME, w: 1280, h: 800 }, nodes: [
  { nodeId: "1:2", name: "A", type: "TEXT" }, { nodeId: "1:3", name: "B", type: "TEXT" },
  { nodeId: "1:4", name: "C", type: "TEXT" }, { nodeId: "1:5", name: "D", type: "TEXT" },
] };

/** A Playwright-shaped timeout (pwErrorKind reads its name). */
const timeoutError = (): Error => { const e = new Error("locator.waitFor: Timeout 30000ms exceeded."); e.name = "TimeoutError"; return e; };

/** A fake page: what it shows of the own tags (`tags`; "hang" never answers, "gone" throws a closed page), and whether
 *  the frame tag's locator wait is met. Records the selectors waited on. */
function fakePage(o: { tags: ScreenTags | "hang" | "gone"; tagShows: boolean }): GatePage & { waited: string[]; looks: number } {
  const waited: string[] = [];
  const page = {
    waited, looks: 0,
    isClosed: () => false,
    evaluate: async (): Promise<unknown> => {
      page.looks++;
      if (o.tags === "hang") return new Promise<never>(() => undefined);
      if (o.tags === "gone") throw new Error("page.evaluate: Target page, context or browser has been closed");
      return o.tags;
    },
    locator: (selector: string) => ({ first: () => ({ waitFor: async (w: { state: "visible"; timeout: number }): Promise<void> => {
      waited.push(selector);
      if (!o.tagShows) throw new Error(`locator.waitFor: Timeout ${w.timeout}ms exceeded.`);
    } }) }),
  };
  return page;
}
const gateOf = (flag?: string, exp: Expectation | null = EXP, frameId: string | undefined = FRAME): ScreenGate => new ScreenGate({ flag, frameId, expectation: exp });
const missOf = (j: ScreenJudgement) => (j.kind === "miss" ? j : null);

// ---- built from the flag, the frame id and the expectation
{
  const d = gateOf(), x = gateOf("#app"), n = gateOf("none"), u = new ScreenGate({ flag: undefined, frameId: undefined, expectation: EXP });
  const off = new ScreenGate({ flag: undefined, frameId: FRAME, expectation: EXP, taggingOff: true });
  check("[gate] the default waits for the frame's tag; an explicit selector is kept; none, no frame id and a tagging opt-out wait for nothing — each with its start line",
    d.ready === TAG && d.startNote === `ready  ${TAG} (the frame's tag, the default; --ready <selector> or --ready none to change it)`
    && x.ready === "#app" && x.startNote === "ready  #app"
    && n.ready === undefined && n.startNote.startsWith("ready  none")
    && u.ready === undefined && u.startNote.startsWith("note  the expectation names no frame node id")
    && off.ready === undefined && off.startNote.startsWith("note  the --steps plan opts out of tagging"));
}

// ---- wait()
{
  const p = fakePage({ tags: { shown: 0, foreign: null }, tagShows: true });
  await gateOf().wait(p, 100);
  check("[gate] wait() on the default waits for any visible match of the frame's tag", p.waited.join() === `${TAG} >> visible=true`);
  const q = fakePage({ tags: { shown: 0, foreign: null }, tagShows: true });
  await gateOf("none").wait(q, 100);
  check("[gate] wait() without a selector waits for nothing", q.waited.length === 0 && q.looks === 0);
}

// ---- judge(): every miss kind
{
  const g = gateOf();
  const few = missOf(await g.judge(fakePage({ tags: { shown: 1, foreign: null }, tagShows: false }), timeoutError(), true, 30_000));
  check("[gate] miss: too few own tags → byDefault, no foreign root, the look, the count in the message, the default-ready hint",
    few !== null && few.miss.byDefault && few.miss.foreign === null && few.miss.look?.shown === 1
    && few.message === `--ready '${TAG}' never became visible (the page shows 1 of the expectation's 4 own tags — fewer than half): locator.waitFor: Timeout 30000ms exceeded.`
    && g.hint(few.miss, false).startsWith(`${TAG} is the default --ready (the frame's tag), and the page shows too few`)
    && !g.untaggedRootSeen);

  const fr = missOf(await g.judge(fakePage({ tags: { shown: 3, foreign: { id: "7:1", by: "size", encloses: 0 } }, tagShows: false }), timeoutError(), true, 30_000));
  check("[gate] miss: another screen's tagged root → its foreign root, named in the message, the foreign-root hint (with --steps: the plan's navigate list)",
    fr !== null && fr.miss.byDefault && fr.miss.foreign?.id === "7:1"
    && fr.message.includes("another screen's tagged root is on the page: a visible element tagged data-dt-node=\"7:1\"")
    && g.hint(fr.miss, true).includes("the page shows another screen's tagged root (data-dt-node=\"7:1\" has this frame's size)")
    && g.hint(fr.miss, true).includes("check the --steps plan's navigate list"));

  const hung = missOf(await g.judge(fakePage({ tags: "hang", tagShows: false }), timeoutError(), true, 30_000));
  check("[gate] miss: a page that does not answer the look → no look, said in the message, still the default's hint",
    hung !== null && hung.miss.byDefault && hung.miss.look === null && hung.miss.foreign === null
    && hung.message.includes("(the page did not answer within 2s when its tags were counted)"));

  const fonts = fakePage({ tags: { shown: 4, foreign: null }, tagShows: false });
  const notWait = missOf(await g.judge(fonts, new Error("page.evaluate: fonts broke"), false, 30_000));
  check("[gate] miss: a load / fonts failure (not the --ready wait) is not looked at, never taken for the screen",
    notWait !== null && fonts.looks === 0 && notWait.miss.byDefault && notWait.miss.look === null
    && notWait.message === `--ready '${TAG}' never became visible: page.evaluate: fonts broke`);

  const sel = fakePage({ tags: { shown: 4, foreign: null }, tagShows: false });
  const other = missOf(await g.judge(sel, new Error("locator.waitFor: Unexpected token"), true, 30_000));
  check("[gate] miss: a wait error that is no timeout (a bad selector) is not a page to judge: no look", other !== null && sel.looks === 0 && other.miss.look === null);

  const x = gateOf("#app");
  const xp = fakePage({ tags: { shown: 4, foreign: null }, tagShows: false });
  const explicit = missOf(await x.judge(xp, timeoutError(), true, 30_000));
  check("[gate] miss: an explicit --ready → not byDefault (no hint), no look, the plain message",
    explicit !== null && !explicit.miss.byDefault && xp.looks === 0 && x.hint(explicit.miss, false) === ""
    && explicit.message === "--ready '#app' never became visible: locator.waitFor: Timeout 30000ms exceeded.");

  const n = gateOf("none");
  const none = missOf(await n.judge(fakePage({ tags: { shown: 4, foreign: null }, tagShows: false }), new Error("boom"), false, 30_000));
  check("[gate] miss: no selector → the error's own line, not byDefault", none !== null && none.message === "boom" && !none.miss.byDefault && n.hint(none.miss, false) === "");

  const noOwn = gateOf(undefined, { frame: { nodeId: FRAME } });
  const np = fakePage({ tags: { shown: 4, foreign: null }, tagShows: false });
  const bare = missOf(await noOwn.judge(np, timeoutError(), true, 30_000));
  check("[gate] miss: the default with an expectation that names no own tags → byDefault, no look, the default-ready hint",
    bare !== null && bare.miss.byDefault && np.looks === 0 && bare.message === `--ready '${TAG}' never became visible: locator.waitFor: Timeout 30000ms exceeded.`
    && noOwn.hint(bare.miss, false).includes("shows too few of the expectation's own tags"));

  let goneName = "";
  await g.judge(fakePage({ tags: "gone", tagShows: false }), timeoutError(), true, 30_000).catch((e: unknown) => { goneName = e instanceof Error ? e.message : "?"; });
  check("[gate] a page gone during the look rethrows its error (the caller names it)", goneName.includes("has been closed"));
}

// ---- judge(): the untagged root taken for the screen, then wait() and note()
{
  const g = gateOf();
  check("[gate] no note before an untagged root was taken", g.note("size-and-fill") === null && !g.untaggedRootSeen);
  const met = await g.judge(fakePage({ tags: { shown: 2, foreign: null }, tagShows: false }), timeoutError(), true, 2_400);
  check("[gate] half of the own tags and no other screen's root → the screen (untagged root seen)", met.kind === "screen" && g.untaggedRootSeen);
  await g.judge(fakePage({ tags: { shown: 4, foreign: null }, tagShows: false }), timeoutError(), true, 30_000);
  check("[gate] note(): the first wait's length, how the root was found, both fixes; none when the root was found by its tag",
    g.note("size-and-fill") === `the screen root is not tagged: ${TAG} (the default --ready) never showed within 2.4s, but the page shows at least half of the expectation's own tags ` +
      `and no other screen's tagged root, so it was measured as the screen, its root found as the outermost element with the frame's size (±2 px) and a fill — tag the root data-dt-node="1:1", or pass --ready <root selector>`
    && g.note("tag") === null);
  const later = fakePage({ tags: { shown: 3, foreign: null }, tagShows: false });
  await g.wait(later, 500);
  check("[gate] wait() once the untagged root was seen: the own-tags rule, not the frame's tag", later.waited.length === 0 && later.looks >= 1);
  const t0 = Date.now();
  const fails = await g.wait(fakePage({ tags: { shown: 0, foreign: null }, tagShows: true }), 150).then(() => "met", (e: unknown) => (e instanceof Error ? e.name : "?"));
  check("[gate] …and it runs out as a TimeoutError on a page that no longer shows them", fails === "TimeoutError" && Date.now() - t0 < 1_500);
}

report();
