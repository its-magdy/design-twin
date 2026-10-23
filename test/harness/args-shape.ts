// [ARGS-SHAPE] every bridge command's args guard (bridge/src/commands.ts argsShapeError). A pure function: no world.
import { ok } from "../assert.ts";
import { argsShapeError, type Cmd } from "../../bridge/src/commands.ts";
import type { Case } from "./helpers.ts";

export const cases: Case[] = [{
  // ---------- [ARGS-SHAPE] every command's guard: its documented args pass, a wrong-typed variant names the field ----------
  name: "[ARGS-SHAPE] every command's guard: its documented args pass, a wrong-typed variant names the field",
  async run() {
    const cases: Array<[cmd: Cmd, good: unknown, bad: unknown, want: string]> = [
      ["ping", {}, 7, "bad ping args: not an object"],
      ["whoami", {}, [], "bad whoami args: not an object"],
      ["getSelection", {}, null, "bad getSelection args: not an object"],
      ["listLibraries", {}, "x", "bad listLibraries args: not an object"],
      ["listPages", { depth: 2 }, { depth: "2" }, "bad listPages args: `depth` is not 1 or 2"],
      ["listChildren", { nodeId: "1:2" }, { nodeId: 5 }, "bad listChildren args: `nodeId` is not a string"],
      ["exportFull", { allPages: false, page: ["Home", "0:1"], css: true, skipAssets: true }, { page: [1] }, "bad exportFull args: `page` is not a string or an array of strings"],
      ["exportFull", { page: "Home" }, { allPages: "yes" }, "bad exportFull args: `allPages` is not a boolean"],
      ["exportDesignSystem", { variantVisuals: true }, { variantVisuals: "yes" }, "bad exportDesignSystem args: `variantVisuals` is not a boolean"],
      ["exportLibrary", { asLibrary: "Acme UI", variantVisuals: false }, { asLibrary: 5 }, "bad exportLibrary args: `asLibrary` is not a string"],
      ["exportSelection", { css: true, measurements: false }, { css: 1 }, "bad exportSelection args: `css` is not a boolean"],
      ["exportNode", { nodeId: "1:2", css: true }, { nodeId: 5 }, "bad exportNode args: `nodeId` is not a string"],
      ["exportNode", { nodeId: "1:2" }, {}, "No node id provided."],
      ["screenshot", { nodeId: "1:2", scale: 2 }, { nodeId: "1:2", scale: "x" }, "bad screenshot args: `scale` is not a number"],
      ["write", { ops: [{ op: "createFrame", name: "F", width: 10, height: 10, layoutMode: "VERTICAL", itemSpacing: 4, padding: [1, 2, 3, 4], fill: "#fff" }, { op: "setText", nodeId: "1:2", text: "hi" }] },
        { ops: [{ op: "createFrame", padding: [1, 2, 3] }] }, "bad write args: `ops[0].padding` is not four numbers"],
      ["write", { ops: [] }, {}, "bad write args: `ops` is missing"],
    ];
    for (const [cmd, good, bad, want] of cases) {
      const gotGood = argsShapeError(cmd, good), gotBad = argsShapeError(cmd, bad);
      ok(`[ARGS-SHAPE] ${cmd}: ${JSON.stringify(good)} passes, ${JSON.stringify(bad)} -> ${want}`, gotGood === null && gotBad === want);
    }
  },
}];
