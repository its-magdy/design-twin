// The keys the quick-keys block (bridge/src/quick-keys.ts) names are the keys the plugin really emits.
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { IrNode } from "../../bridge/src/doc-types.ts";
import { QUICK_KEYS } from "../../bridge/src/quick-keys.ts";
import type { Case } from "./helpers.ts";
import { world } from "./scene.ts";

export const cases: Case[] = [{
  // ---- the keys the quick-keys block (bridge/src/quick-keys.ts) names are the keys the plugin really emits ----
  // Builders guessed Plugin API names (`characters`, `width`, `visible`, `layout.scroll`); the doc says
  // `text`, `box.w`, `hidden`, a top-level `scroll`. Serialize one scroll screen and check both halves:
  // every key the doc names is there (and named in QUICK_KEYS), and the guessed ones are nowhere.
  name: "the keys the quick-keys block names are the keys the plugin really emits",
  async run() {
    const { api } = world();
    const qkText = { type: "TEXT", name: "Title", visible: true, id: "qk:t", characters: "Hello", fontName: { family: "Inter", style: "Bold" },
      fontSize: 20, width: 120, height: 24, absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 24 }, getStyledTextSegments: () => [] };
    const qkHiddenKid = { type: "FRAME", name: "Toast", visible: true, id: "qk:hk", width: 10, height: 10, layoutMode: "NONE", children: [] };
    const qkHidden = { type: "FRAME", name: "Banner", visible: false, id: "qk:h", width: 50, height: 20, layoutMode: "NONE", children: [qkHiddenKid] };
    const qkAbs = { type: "FRAME", name: "Badge", visible: true, id: "qk:a", x: 7, y: 9, width: 12, height: 12, layoutMode: "NONE",
      layoutPositioning: "ABSOLUTE", children: [] };
    const qkRow = { type: "FRAME", name: "Row", visible: true, id: "qk:r", width: 100, height: 40, layoutMode: "HORIZONTAL", itemSpacing: 0,
      paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, children: [qkAbs] };
    const qkScreen = { type: "FRAME", name: "Screen", visible: true, id: "qk:s", width: 375, height: 800, layoutMode: "NONE",
      overflowDirection: "VERTICAL", numberOfFixedChildren: 1, clipsContent: true, children: [qkText, qkHidden, qkRow] };
    const qk = await api.serialize(qkScreen, 0, false);
    const [qkT, qkH, qkR] = must(qk.children, "qk.children");
    const qkHK = must(qkH?.children?.[0], "qk hidden child");
    const qkA = must(qkR?.children?.[0], "qk absolute child");
    const named = (key: string): boolean => QUICK_KEYS.includes("`" + key);
    ok("a TEXT carries `text` (not `characters`)", qkT?.text === "Hello" && named("text"));
    ok("size is `box.w` (not `width`)", qkT?.box?.w === 120 && named("box.w"));
    ok("scroll is a top-level `scroll`", qk.scroll === "vertical" && named("scroll"));
    ok("`fixedChildren` is the pinned count", qk.fixedChildren === 1 && named("fixedChildren"));
    ok("`clip` rides along with it", qk.clip === true && named("clip"));
    ok("`hidden` sits on the switched-off layer only, not on its child", qkH?.hidden === true && qkHK.hidden === undefined && named("hidden"));
    ok("an absolute child carries `absolute` + its own `x`", qkA.absolute === true && qkA.x === 7 && named("absolute") && named("x"));
    ok("the TEXT has no `layout` key (only a node that holds children has one)", !!qkT && !("layout" in qkT));
    const qkWalk = (n: IrNode, f: (n: IrNode) => void): void => { f(n); (n.children || []).forEach((c) => qkWalk(c, f)); };
    const qkGuessed: string[] = [];
    qkWalk(qk, (n) => {
      for (const k of ["characters", "width", "height", "visible"]) if (k in n) qkGuessed.push(n.name + "." + k);
      if (n.layout && "scroll" in n.layout) qkGuessed.push(n.name + ".layout.scroll");
    });
    ok("no `characters` / `width` / `height` / `visible` / `layout.scroll` anywhere in the export (" + qkGuessed.join(",") + ")", qkGuessed.length === 0);
  },
}];
