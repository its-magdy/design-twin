// [WIRE-ARGS] handleBridge checks `args` against commands.ts before any collector runs.
import { ok } from "../assert.ts";
import type { Case } from "./helpers.ts";
import { world } from "./scene.ts";

export const cases: Case[] = [{
  name: "[WIRE-ARGS] handleBridge checks `args` against commands.ts before any collector runs",
  async run() {
    // Driven through main.ts's real `bridge` message (the path the UI iframe relays a CLI/MCP frame on),
    // so what is asserted is the `bridge-result` a caller actually receives.
    const w = world();
    /** One bridge frame in, its bridge-result out, plus whether it reached serializeRun (a run-begin). */
    const wire = async (cmd: string, args: unknown): Promise<{ ok: boolean | undefined; result: unknown; error: string | undefined; queued: boolean }> => {
      const posted = await w.send({ type: "bridge", id: "wire-1", cmd, args });
      const r = posted.find((m) => m.type === "bridge-result");
      return { ok: r && r.ok, result: r && r.result, error: r && r.error, queued: posted.some((m) => m.type === "run-begin") };
    };

    // The text for a missing node id is "No node id provided." It must stay byte-identical, AND the request
    // must be refused before it is queued (exportNode/screenshot must not go through serializeRun and post
    // run-begin before the collector throws).
    for (const [cmd, args] of [["exportNode", {}], ["exportNode", { nodeId: null }], ["exportNode", null], ["screenshot", {}]] as const) {
      const r = await wire(cmd, args);
      ok(`[WIRE-ARGS] ${cmd} ${JSON.stringify(args)} -> "No node id provided." (unchanged), refused before queueing`,
        r.ok === false && r.error === "No node id provided." && !r.queued);
    }
    // listChildren is a scene read, never bracketed, so "refused before queueing" is not observable as a run-begin;
    // paired with its wrong-typed twin instead (without the guard: "Node 5 is not in the open file…").
    const listNoId = await wire("listChildren", {});
    const listBadId = await wire("listChildren", { nodeId: 5 });
    ok("[WIRE-ARGS] listChildren {} -> \"No node id provided.\" (unchanged); nodeId:5 -> named type error",
      listNoId.ok === false && listNoId.error === "No node id provided." &&
      listBadId.ok === false && listBadId.error === "bad listChildren args: `nodeId` is not a string");

    // Wrong-typed args. Without the guard, nodeId 5 would be looked up as "5" ("Node 5 is not in the open file…"),
    // depth "2" would silently mean depth 2, scale "x" the default, and a bogus write op would come back
    // as an ok:false reply after the batch started.
    const badNode = await wire("exportNode", { nodeId: 5 });
    ok("[WIRE-ARGS] exportNode nodeId:5 -> named type error, not queued",
      badNode.ok === false && badNode.error === "bad exportNode args: `nodeId` is not a string" && !badNode.queued);
    const badDepth = await wire("listPages", { depth: "2" });
    ok("[WIRE-ARGS] listPages depth:\"2\" -> refused with the allowed values",
      badDepth.ok === false && badDepth.error === "bad listPages args: `depth` is not 1 or 2" && badDepth.result === undefined);
    const badScale = await wire("screenshot", { nodeId: "1:0", scale: "x" });
    ok("[WIRE-ARGS] screenshot scale:\"x\" -> refused, not queued",
      badScale.ok === false && badScale.error === "bad screenshot args: `scale` is not a number" && !badScale.queued);
    const badOp = await wire("write", { ops: [{ op: "bogus" }] });
    ok("[WIRE-ARGS] write with an unknown op -> refused before the batch starts",
      badOp.ok === false && badOp.error === "bad write args: `ops[0].op` is not one of createFrame | createText | setFill | setText" && !badOp.queued);

    // Tolerance kept: an undeclared key is ignored, and non-object args read as {} — paired with a
    // refusal on the same command so the pair fails if the check were dropped.
    const depth1 = await wire("listPages", { depth: 1, notDeclared: true });
    const depthBad = await wire("listPages", { depth: 3, notDeclared: true });
    const depth1Reply = depth1.result;
    ok("[WIRE-ARGS] listPages: depth 1 + an undeclared key is served at depth 1; depth 3 is refused",
      depth1.ok === true && typeof depth1Reply === "object" && depth1Reply !== null && "depth" in depth1Reply && depth1Reply.depth === 1 &&
      depthBad.ok === false && depthBad.error === "bad listPages args: `depth` is not 1 or 2");
    const pingJunk = await wire("ping", 7);
    const libBad = await wire("exportLibrary", { asLibrary: 5 });
    ok("[WIRE-ARGS] ping with non-object args still pongs; exportLibrary asLibrary:5 is refused, not queued",
      pingJunk.ok === true && JSON.stringify(pingJunk.result) === JSON.stringify({ pong: true, page: "Page 1", file: "My File", fileKey: "FILEKEY1234567" }) &&
      libBad.ok === false && libBad.error === "bad exportLibrary args: `asLibrary` is not a string" && !libBad.queued);
  },
}];
