// [SHOT] the on-demand screenshot (collect.ts collectScreenshot).
import { ok } from "../assert.ts";
import type { FakeNode } from "../fake-figma.ts";
import type { Case } from "./helpers.ts";
import { world } from "./scene.ts";

export const cases: Case[] = [{
  name: "[SHOT] screenshot reply carries the node size and the render scale",
  async run() {
    const shot: FakeNode = { type: "FRAME", name: "Shot", id: "sh:1", visible: true, width: 1440, height: 1236,
      exportAsync: async () => new Uint8Array([137, 80, 78, 71]) };
    const { api } = world({ nodes: { "sh:1": shot } });
    const s1 = await api.collectScreenshot("sh:1");
    // pre-change: fails — the reply had id/name/type/reference only.
    ok("collectScreenshot on a 1440×1236 frame → w 1440, h 1236, scale 2048/1440 (the auto cap it rendered at)",
      s1.w === 1440 && s1.h === 1236 && typeof s1.scale === "number" && Math.abs(s1.scale - 2048 / 1440) < 1e-9 && typeof s1.reference === "string");
    const s2 = await api.collectScreenshot("sh:1", { scale: 3 });
    ok("…an explicit scale is the one reported", s2.scale === 3 && s2.w === 1440);
  },
}];
