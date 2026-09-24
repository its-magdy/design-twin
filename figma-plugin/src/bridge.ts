// Bridge dispatch (CLI / MCP over WebSocket, via the UI iframe).
import { collectFull, collectDesignSystemOnly, collectLibraryFile, collectSelection, collectNode, collectScreenshot, listPages, listChildren } from "./collect";
import { applyWrites } from "./writes";
import { listLibraries } from "./libraries";
import { serializeRun } from "./state";
import { type RunInfo } from "./progress";
// The command/reply contract shared with the bridge (bridge/src/commands.ts): the switch below is
// exhaustive over `Cmd`, each branch sees that command's own `args`, and its reply type is what the
// bridge's `request()` promises its callers. esbuild inlines the module like read-opts.ts.
import { isCmd } from "../../bridge/src/commands.ts";
import type {
  Cmd, CommandRequest, Commands, DesignSystemReply, FullExportReply, PingReply, ScreenReply, ScreenshotReply, WhoamiReply,
} from "../../bridge/src/commands.ts";

// `args` arrives over the bridge as parsed JSON — genuinely unknown shape until narrowed per command.
function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

// Every queued command announces itself to the plugin window under the SAME label the caller used, so
// a designer watching Figma go busy can see that a CLI/MCP pull — and which one — is walking their
// file, rather than being left to guess. Built from `cmd` rather than hand-written per case: a new
// queued op then cannot ship without a label.
const bridgeRun = (cmd: Cmd): RunInfo => ({ source: "bridge", label: cmd });

// Identity of THIS plugin run, minted once when the bundle is first evaluated. It is the only way to
// tell two simultaneously-running instances apart from the bridge side: `fileKey` is gated to private
// plugins (see whoami below) and `figma.root.name` is a human-editable string that duplicated files
// share. Deliberately NOT crypto.randomUUID — the Figma sandbox has no `crypto`.
const INSTANCE_ID = "fig-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
const INSTANCE_STARTED_AT = Date.now();

// `figma.fileKey` is typed `string | undefined` (gated to private plugins —
// https://developers.figma.com/docs/plugins/api/properties/figma-filekey/), but touching it must
// never throw the probe that exists to test for it. One guarded read for whoami and ping alike.
function readFileKey(): string | undefined {
  try {
    return typeof figma.fileKey === "string" ? figma.fileKey : undefined;
  } catch {
    return undefined;
  }
}

export async function handleBridge(cmd: string, args: unknown): Promise<unknown> {
  if (!isCmd(cmd)) throw new Error("unknown cmd: " + cmd);
  // The ONE boundary between the wire and the contract: `args` is parsed JSON, and each collector
  // re-validates what it reads (a missing nodeId is "No node id provided.", not a type error here).
  const req = { cmd, args: isRecord(args) ? args : {} } as CommandRequest;
  return dispatch(req);
}

// The collectors are typed `Promise<Obj>` in collect.ts (an untyped record); each branch below is
// where their result is taken as the reply the contract promises for that command.
async function dispatch(req: CommandRequest): Promise<Commands[Cmd]["reply"]> {
  switch (req.cmd) {
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
      const fileKey = readFileKey();
      const r: WhoamiReply = {
        instanceId: INSTANCE_ID,
        startedAt: INSTANCE_STARTED_AT,
        uptimeMs: Date.now() - INSTANCE_STARTED_AT,
        file: figma.root.name,
        page: figma.currentPage.name,
        pageId: figma.currentPage.id,
        editorType: figma.editorType,
        // Finding 327: baked in at build time (build.js's esbuild `define`) from
        // figma-plugin/package.json — the one way to tell a stale plugin in Figma apart from a
        // freshly reloaded one, since neither startedAt nor code.js's mtime can. Reused verbatim by
        // the `hello` announcement below (main.ts's get-identity -> ui.html -> bridge), so `whoami`,
        // `dtwin list clients` and `dtwin doctor` can never disagree about which build is running.
        pluginVersion: __PLUGIN_VERSION__,
        fileKey: fileKey ?? null,
        fileKeyAvailable: typeof fileKey === "string" && fileKey.length > 0,
      };
      return r;
    }
    case "ping": {
      const r: PingReply = { pong: true, page: figma.currentPage.name, file: figma.root.name };
      const fileKey = readFileKey();
      if (fileKey !== undefined) r.fileKey = fileKey;
      return r;
    }
    // The extraction/write commands mutate shared per-run state (and the document), so they go through
    // serializeRun — this is the same chain the UI's manual runs use, so a bridge pull and a manual
    // export can never overlap. ping/getSelection are read-only and stay responsive (unqueued).
    case "exportFull": {
      const a = req.args;
      return serializeRun(() => collectFull(a) as Promise<FullExportReply>, bridgeRun(req.cmd));
    }
    // The tokens/styles/components-only pull — no page/frame walk, no assets. See collect.ts's
    // collectDesignSystemOnly for the one tradeoff (library-variable completeness).
    case "exportDesignSystem": {
      const a = req.args;
      return serializeRun(() => collectDesignSystemOnly(a) as Promise<DesignSystemReply>, bridgeRun(req.cmd));
    }
    // The library-file pull. QUEUED like its export siblings (not unqueued like listLibraries): it runs
    // the full catalog build and mutates the same per-run state they do.
    case "exportLibrary": {
      const a = req.args;
      return serializeRun(() => collectLibraryFile(a) as Promise<DesignSystemReply>, bridgeRun(req.cmd));
    }
    case "exportSelection": {
      const a = req.args;
      return serializeRun(() => collectSelection(a) as Promise<ScreenReply>, bridgeRun(req.cmd));
    }
    case "exportNode": {
      const a = req.args;
      return serializeRun(() => collectNode(a.nodeId, a) as Promise<ScreenReply>, bridgeRun(req.cmd));
    }
    // The on-demand single-node screenshot — deliberately its own op rather than a mode of exportNode:
    // it skips serialize() and the recursive asset walk entirely (see collectScreenshot's comment), so
    // routing it through exportNode's shape would mislead a caller into thinking it got a tree back.
    case "screenshot": {
      const a = req.args;
      // `scale` is re-checked at runtime: the frame is JSON, and a non-number here must read as "default".
      const scale = typeof a.scale === "number" ? a.scale : undefined;
      return serializeRun(() => collectScreenshot(a.nodeId, { scale }) as Promise<ScreenshotReply>, bridgeRun(req.cmd));
    }
    case "getSelection":
      return figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name, type: n.type }));
    // UNQUEUED on purpose, both of them. These are the cheap maps you consult to decide WHICH deep
    // pull to run, so routing them through serializeRun would queue them behind the very export they
    // exist to avoid — a 12-minute --all-pages would block "what's in this file?" for 12 minutes.
    // They only READ page/child metadata and mutate none of the per-run state serializeRun protects.
    case "listPages":
      return (await listPages(req.args)) as Commands["listPages"]["reply"];
    case "listChildren":
      return (await listChildren(req.args.nodeId)) as Commands["listChildren"]["reply"];
    // UNQUEUED for the same reason as the two above: it is the cheap "which libraries feed this file?"
    // map you consult BEFORE deciding what to pull, it mutates no per-run state, and queueing it
    // behind a long export would defeat the point of asking. Its document walk is one
    // findAllWithCriteria per page with skipInvisibleInstanceChildren on — the same cost class as
    // listPages depth 2, not that of an export.
    case "listLibraries":
      return (await listLibraries()) as Commands["listLibraries"]["reply"];
    case "write": {
      const ops = req.args.ops;
      return serializeRun(() => applyWrites(Array.isArray(ops) ? ops : []), bridgeRun(req.cmd));
    }
    default: {
      // Exhaustive: a command added to commands.ts without a branch here fails to compile. Unreachable
      // at runtime — handleBridge already refused anything outside `Cmd` with the same message.
      const exhaustive: never = req;
      throw new Error("unknown cmd: " + String(exhaustive));
    }
  }
}
