// Bridge dispatch (CLI / MCP over WebSocket, via the UI iframe).
import { collectFull, collectDesignSystemOnly, collectLibraryFile, collectSelection, collectNode, collectScreenshot, listPages, listChildren, CollectOpts } from "./collect";
import { applyWrites } from "./writes";
import { listLibraries } from "./libraries";
import { serializeRun } from "./state";
import { RunInfo } from "./progress";

// Every queued command announces itself to the plugin window under the SAME label the caller used, so
// a designer watching Figma go busy can see that a CLI/MCP pull — and which one — is walking their
// file, rather than being left to guess. Built from `cmd` rather than hand-written per case: a new
// queued op then cannot ship without a label.
const bridgeRun = (cmd: string): RunInfo => ({ source: "bridge", label: cmd });

// Identity of THIS plugin run, minted once when the bundle is first evaluated. It is the only way to
// tell two simultaneously-running instances apart from the bridge side: `fileKey` is gated to private
// plugins (see whoami below) and `figma.root.name` is a human-editable string that duplicated files
// share. Deliberately NOT crypto.randomUUID — the Figma sandbox has no `crypto`.
const INSTANCE_ID = "fig-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
const INSTANCE_STARTED_AT = Date.now();

export async function handleBridge(cmd: string, args: any): Promise<any> {
  switch (cmd) {
    // The probe for the multi-file question: run it in two files at once and compare `instanceId`.
    // UNQUEUED (like ping/getSelection) on purpose — it must stay answerable DURING a long export,
    // since "is the other file's connection still alive while this one works?" is half of what it
    // exists to measure.
    //
    // It answers four things in one call:
    //   instanceId / startedAt / uptimeMs — two distinct ids => two instances really do coexist; a
    //     CHANGED id on a later call => Figma tore the plugin runtime down and re-ran it (the
    //     southleft/figma-console-mcp#67 failure), which a reconnect alone would not reveal.
    //   fileKey                          — undefined => `enablePrivatePluginApi` is not in effect for
    //     a locally-imported plugin, so routing must fall back to a server-minted connection id.
    //   file / page                      — human labels for a connection listing, never routing keys.
    case "whoami": {
      const r: any = {
        instanceId: INSTANCE_ID,
        startedAt: INSTANCE_STARTED_AT,
        uptimeMs: Date.now() - INSTANCE_STARTED_AT,
        file: figma.root.name,
        page: figma.currentPage.name,
        pageId: figma.currentPage.id,
        editorType: figma.editorType,
      };
      // Same guarded read as `ping`: `fileKey` is typed `string | undefined` and only populated for
      // private plugins, but touching it must never throw the probe that exists to test for it.
      try {
        r.fileKey = typeof (figma as any).fileKey !== "undefined" ? (figma as any).fileKey : null;
      } catch (e) {
        r.fileKey = null;
      }
      r.fileKeyAvailable = typeof r.fileKey === "string" && r.fileKey.length > 0;
      return r;
    }
    case "ping": {
      const r: any = { pong: true, page: figma.currentPage.name, file: figma.root.name };
      try { if (typeof (figma as any).fileKey !== "undefined") r.fileKey = (figma as any).fileKey; } catch (e) {}
      return r;
    }
    // The extraction/write commands mutate shared per-run state (and the document), so they go through
    // serializeRun — this is the same chain the UI's manual runs use, so a bridge pull and a manual
    // export can never overlap. ping/getSelection are read-only and stay responsive (unqueued).
    case "exportFull":
      return await serializeRun(() => collectFull(args as CollectOpts), bridgeRun(cmd));
    // The tokens/styles/components-only pull — no page/frame walk, no assets. See collect.ts's
    // collectDesignSystemOnly for the one tradeoff (library-variable completeness).
    case "exportDesignSystem":
      return await serializeRun(() => collectDesignSystemOnly(args as CollectOpts), bridgeRun(cmd));
    // The library-file pull. QUEUED like its export siblings (not unqueued like listLibraries): it runs
    // the full catalog build and mutates the same per-run state they do.
    case "exportLibrary":
      return await serializeRun(() => collectLibraryFile(args as CollectOpts & { asLibrary?: string }), bridgeRun(cmd));
    case "exportSelection":
      return await serializeRun(() => collectSelection(args as CollectOpts), bridgeRun(cmd));
    case "exportNode":
      return await serializeRun(() => collectNode(args && args.nodeId, args as CollectOpts), bridgeRun(cmd));
    // The on-demand single-node screenshot — deliberately its own op rather than a mode of exportNode:
    // it skips serialize() and the recursive asset walk entirely (see collectScreenshot's comment), so
    // routing it through exportNode's shape would mislead a caller into thinking it got a tree back.
    case "screenshot":
      return await serializeRun(() => collectScreenshot(args && args.nodeId, { scale: args && args.scale }), bridgeRun(cmd));
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
      return await serializeRun(() => applyWrites(args && args.ops), bridgeRun(cmd));
    default:
      throw new Error("unknown cmd: " + cmd);
  }
}
