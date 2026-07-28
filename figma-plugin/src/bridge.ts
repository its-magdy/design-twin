// Bridge dispatch (CLI / MCP over WebSocket, via the UI iframe).
import { collectFull, collectSelection, collectNode, CollectOpts } from "./collect";
import { applyWrites } from "./writes";
import { serializeRun } from "./state";

export async function handleBridge(cmd: string, args: any): Promise<any> {
  switch (cmd) {
    case "ping": {
      const r: any = { pong: true, page: figma.currentPage.name, file: figma.root.name };
      try { if (typeof (figma as any).fileKey !== "undefined") r.fileKey = (figma as any).fileKey; } catch (e) {}
      return r;
    }
    // The extraction/write commands mutate shared per-run state (and the document), so they go through
    // serializeRun — this is the same chain the UI's manual runs use, so a bridge pull and a manual
    // export can never overlap. ping/getSelection are read-only and stay responsive (unqueued).
    case "exportFull":
      return await serializeRun(() => collectFull(args as CollectOpts));
    case "exportSelection":
      return await serializeRun(() => collectSelection(args as CollectOpts));
    case "exportNode":
      return await serializeRun(() => collectNode(args && args.nodeId, args as CollectOpts));
    case "getSelection":
      return figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name, type: n.type }));
    case "write":
      return await serializeRun(() => applyWrites(args && args.ops));
    default:
      throw new Error("unknown cmd: " + cmd);
  }
}
