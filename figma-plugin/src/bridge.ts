// Bridge dispatch (CLI / MCP over WebSocket, via the UI iframe).
import { collectFull, collectDesignSystemOnly, collectSelection, collectNode, listPages, listChildren, CollectOpts } from "./collect";
import { applyWrites } from "./writes";
import { listLibraries } from "./libraries";
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
    // The tokens/styles/components-only pull — no page/frame walk, no assets. See collect.ts's
    // collectDesignSystemOnly for the one tradeoff (library-variable completeness).
    case "exportDesignSystem":
      return await serializeRun(() => collectDesignSystemOnly(args as CollectOpts));
    case "exportSelection":
      return await serializeRun(() => collectSelection(args as CollectOpts));
    case "exportNode":
      return await serializeRun(() => collectNode(args && args.nodeId, args as CollectOpts));
    case "getSelection":
      return figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name, type: n.type }));
    // UNQUEUED on purpose, both of them. These are the cheap maps you consult to decide WHICH deep
    // pull to run, so routing them through serializeRun would queue them behind the very export they
    // exist to avoid — a 12-minute --all-pages would block "what's in this file?" for 12 minutes.
    // They only READ page/child metadata and mutate none of the per-run state serializeRun protects.
    case "listPages":
      return await listPages(args || {});
    case "listChildren":
      return await listChildren(args && args.nodeId);
    // UNQUEUED for the same reason as the two above: it is the cheap "which libraries feed this file?"
    // map you consult BEFORE deciding what to pull, it mutates no per-run state, and queueing it
    // behind a long export would defeat the point of asking. Its document walk is one
    // findAllWithCriteria per page with skipInvisibleInstanceChildren on — the same cost class as
    // listPages depth 2, not that of an export.
    case "listLibraries":
      return await listLibraries();
    case "write":
      return await serializeRun(() => applyWrites(args && args.ops));
    default:
      throw new Error("unknown cmd: " + cmd);
  }
}
