// Bridge dispatch (CLI / MCP over WebSocket, via the UI iframe).
import { collectFull, collectDesignSystemOnly, collectLibraryFile, collectSelection, collectNode, collectScreenshot, listPages, listChildren } from "./collect";
import { applyWrites } from "./writes";
import { editsAllowed } from "./edits";
import { listLibraries } from "./libraries";
import { scheduleRun } from "./state";
import { type RunInfo } from "./progress";
// The command/reply contract shared with the bridge (bridge/src/commands.ts): the switch below is
// exhaustive over `Cmd`, each branch sees that command's own `args`, and its reply type is what the
// bridge's `request()` promises its callers. esbuild inlines the module like read-opts.ts.
import { parseCommandRequest, runKind } from "../../bridge/src/commands.ts";
import { ifDefined } from "../../bridge/src/json-util.ts";
import type {
  Cmd, CommandRequest, Commands, PingReply, WhoamiReply,
} from "../../bridge/src/commands.ts";

// Every command announces itself to the plugin window under the SAME label the caller used, so
// a designer watching Figma go busy can see that a CLI/MCP pull — and which one — is walking their
// file, rather than being left to guess. Built from `cmd` rather than hand-written per case: a new
// command then cannot ship without a label.
// `requestId` is the bridge frame's id: what a later `{ type: "cancel", id }` frame is matched on. It
// never reaches the label (the plugin window shows the label).
const bridgeRun = (cmd: Cmd, id: string | undefined): RunInfo => ({ source: "bridge", label: cmd, ...ifDefined("requestId", id) });

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

// `id` is the bridge request id (main.ts passes the frame's `raw.id`; absent for the internal
// get-identity call and the `__designExport` test surface).
export async function handleBridge(cmd: string, args: unknown, id?: string): Promise<unknown> {
  // The ONE boundary between the wire and the contract: `args` is parsed JSON, checked here against
  // the command's declared `*Args` (commands.ts parseCommandRequest) before any collector sees it. A
  // missing nodeId still reads "No node id provided." (NO_NODE_ID, the collectors' own text), an
  // unknown `cmd` still reads "unknown cmd: <cmd>", and an undeclared key is ignored as it always was.
  const parsed = parseCommandRequest(cmd, args);
  if (!parsed.ok) throw new Error(parsed.error);
  // WHEN it runs is not the branch's to say: the command's run traits (commands.ts runKind) decide, through
  // the one scheduler (state.ts scheduleRun). A branch below only says WHAT runs, so a new command cannot
  // forget to queue, and no caller — this window's buttons, a daemon, an MCP server — can bypass the order.
  const req = parsed.req;
  return scheduleRun(runKind(req.cmd), work(req), bridgeRun(req.cmd, id));
}

// The collectors return their own typed envelopes (collect.ts ScreenResult/FullResult/…), which are
// subtypes of the replies the contract promises; each branch below is where that is checked.
function work(req: CommandRequest): () => Promise<Commands[Cmd]["reply"]> {
  switch (req.cmd) {
    // The probe for the multi-file question: run it in two files at once and compare `instanceId`.
    // An identity read — it must stay answerable DURING a long export, since "is the other file's
    // connection still alive while this one works?" is half of what it exists to measure.
    //
    // It answers four things in one call:
    //   instanceId / startedAt / uptimeMs — two distinct ids => two instances really do coexist; a
    //     CHANGED id on a later call => Figma tore the plugin runtime down and re-ran it (the
    //     southleft/figma-console-mcp#67 failure), which a reconnect alone would not reveal.
    //   fileKey                          — undefined => `enablePrivatePluginApi` is not in effect for
    //     a locally-imported plugin, so routing must fall back to a server-minted connection id.
    //   file / page                      — human labels for a connection listing, never routing keys.
    case "whoami": return async () => {
      const fileKey = readFileKey();
      const r: WhoamiReply = {
        instanceId: INSTANCE_ID,
        startedAt: INSTANCE_STARTED_AT,
        uptimeMs: Date.now() - INSTANCE_STARTED_AT,
        file: figma.root.name,
        page: figma.currentPage.name,
        pageId: figma.currentPage.id,
        editorType: figma.editorType,
        // Baked in at build time (build.ts's esbuild `define`) from
        // figma-plugin/package.json — the one way to tell a stale plugin in Figma apart from a
        // freshly reloaded one, since neither startedAt nor code.js's mtime can. Reused verbatim by
        // the `hello` announcement below (main.ts's get-identity -> ui.html -> bridge), so `whoami`,
        // `dtwin list clients` and `dtwin doctor` can never disagree about which build is running.
        pluginVersion: __PLUGIN_VERSION__,
        fileKey: fileKey === undefined ? null : fileKey,
        fileKeyAvailable: typeof fileKey === "string" && fileKey.length > 0,
        // So figma_write's dry run can say a real write would be refused before anyone sends one.
        editsAllowed: await editsAllowed(),
      };
      return r;
    };
    case "ping": return async () => {
      const r: PingReply = { pong: true, page: figma.currentPage.name, file: figma.root.name };
      const fileKey = readFileKey();
      if (fileKey !== undefined) r.fileKey = fileKey;
      return r;
    };
    // The extraction/write commands mutate shared per-run state (and the document): exclusive runs, on the
    // same chain the UI's manual runs use, so a bridge pull and a manual export can never overlap.
    case "exportFull": {
      const a = req.args;
      return () => collectFull(a);
    }
    // The tokens/styles/components-only pull — no page/frame walk, no assets. See collect.ts's
    // collectDesignSystemOnly for the one tradeoff (library-variable completeness).
    case "exportDesignSystem": {
      const a = req.args;
      return () => collectDesignSystemOnly(a);
    }
    // The library-file pull: exclusive like its export siblings (listLibraries is only a scene read). It
    // runs the full catalog build and mutates the same per-run state they do.
    case "exportLibrary": {
      const a = req.args;
      return () => collectLibraryFile(a);
    }
    case "exportSelection": {
      const a = req.args;
      return () => collectSelection(a);
    }
    case "exportNode": {
      const a = req.args;
      return () => collectNode(a.nodeId, a);
    }
    // The on-demand single-node screenshot — deliberately its own op rather than a mode of exportNode:
    // it skips serialize() and the recursive asset walk entirely (see collectScreenshot's comment), so
    // routing it through exportNode's shape would mislead a caller into thinking it got a tree back.
    case "screenshot": {
      const a = req.args;
      // `scale` is a number or absent (parseCommandRequest); a value <= 0 still means "default" in collectReference.
      return () => collectScreenshot(a.nodeId, ifDefined("scale", a.scale));
    }
    case "getSelection":
      return async () => figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name, type: n.type }));
    // Scene reads, these three and getSelection: the cheap maps you consult to decide WHICH deep pull to run.
    // They mutate none of the per-run state an exclusive run owns, but they wait for the run ahead of them (it
    // may hold skipInvisibleInstanceChildren on — commands.ts RunKind), unbracketed: a listing behind a long
    // export waits for it, and a listing in an idle file answers at once.
    case "listPages": {
      const a = req.args;
      return () => listPages(a);
    }
    case "listChildren": {
      const nodeId = req.args.nodeId;
      return () => listChildren(nodeId);
    }
    // Its document walk is one findAllWithCriteria per page with skipInvisibleInstanceChildren on — the same
    // cost class as listPages depth 2, not that of an export.
    case "listLibraries":
      return () => listLibraries();
    // applyWrites refuses the batch whole while "Allow edits" is off (edits.ts) — the gate lives there, not
    // here, so no caller of it can skip it.
    case "write": {
      const ops = req.args.ops;
      return () => applyWrites(ops);
    }
    default: {
      // Exhaustive: a command added to commands.ts without a branch here fails to compile. Unreachable
      // at runtime — handleBridge already refused anything outside `Cmd` with the same message.
      const exhaustive: never = req;
      throw new Error("unknown cmd: " + String(exhaustive));
    }
  }
}
