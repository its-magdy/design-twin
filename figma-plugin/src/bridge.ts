// Bridge dispatch (CLI / MCP over WebSocket, via the UI iframe).
import { collectFull, collectDesignSystemOnly, collectLibraryFile, collectSelection, collectNode, collectScreenshot, listPages, listChildren } from "./collect";
import { announceRefused, submitWrites } from "./writes";
import { designImpact } from "./creates";
import { editsAllowed } from "./edits";
import { answerTicket, holdNew, holdOf, lastWrite, layersSinceApproval, reviewWrites, waitingTicket } from "./review";
import { listLibraries } from "./libraries";
import { scheduleRun } from "./state";
import { type RunInfo } from "./progress";
// The command/reply contract shared with the bridge (bridge/src/commands.ts): the switch below is
// exhaustive over `Cmd`, each branch sees that command's own `args`, and its reply type is what the
// bridge's `request()` promises its callers. esbuild inlines the module like read-opts.ts.
import { parseCommandRequest, runKind, waitingMessage } from "../../bridge/src/commands.ts";
import { ifDefined } from "../../bridge/src/json-util.ts";
import type {
  Cmd, CommandRequest, Commands, PingReply, WhoamiReply, WriteArgs, WriteReply,
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
  if (!parsed.ok) {
    // A write refused here (an op missing a field the MCP server's schema let through) is said in the window like any
    // other refused write (#206) — an empty batch excepted, which says nothing.
    if (cmd === "write" && !isEmptyBatch(args)) announceRefused(parsed.error);
    throw new Error(parsed.error);
  }
  // WHEN it runs is not the branch's to say: the command's run traits (commands.ts runKind) decide, through
  // the one scheduler (state.ts scheduleRun). A branch below only says WHAT runs, so a new command cannot
  // forget to queue, and no caller — this window's buttons, a daemon, an MCP server — can bypass the order.
  const req = parsed.req;
  // A write may wait for the designer's review (review.ts): its run only checks, resolves and decides, and the hold for
  // the designer's answer comes after it, so a write waiting for review never holds up the runs behind it.
  if (req.cmd === "write") return bridgeWrite(req.args, id);
  // A poll of a waiting write (figma_write {ticket}): answered from the card, whatever runs (an identity command).
  if (req.cmd === "writeTicket") return answerTicket(req.args.ticket, holdOf(req.args.holdMs), req.args.cancel === true);
  return scheduleRun(runKind(req.cmd), work(req), bridgeRun(req.cmd, id));
}

const isEmptyBatch = (args: unknown): boolean => {
  const ops = typeof args === "object" && args !== null ? (args as { ops?: unknown }).ops : undefined;
  return Array.isArray(ops) && ops.length === 0;
};

// applyWrites' first half (writes.ts submitWrites) refuses the batch whole while "Allow edits" is off (edits.ts) — the
// gate lives there, not here, so no caller of it can skip it. A batch that waits for review is answered after the hold:
// its result if the designer answered by then, else `{pending, ticket}` (review.ts).
async function bridgeWrite(args: WriteArgs, id: string | undefined): Promise<WriteReply> {
  // One card at a time: refused before a run starts (the window keeps showing the card that waits).
  const waiting = waitingTicket();
  if (waiting !== null) return { ok: false, applied: [], refused: "waiting", error: waitingMessage(waiting) };
  const s = await scheduleRun(runKind("write"), () => submitWrites(args.ops, args.images), bridgeRun("write", id));
  return "done" in s ? s.done : holdNew(s.card, holdOf(args.holdMs));
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
        // …and whether it would wait for the designer's review in the plugin window (review-policy.ts reads these).
        reviewWrites: await reviewWrites(),
        reviewLayers: layersSinceApproval(),
      };
      const waiting = waitingTicket();
      if (waiting !== null) r.reviewWaiting = waiting;
      return r;
    };
    case "ping": return async () => {
      const r: PingReply = { pong: true, page: figma.currentPage.name, file: figma.root.name };
      const fileKey = readFileKey();
      if (fileKey !== undefined) r.fileKey = fileKey;
      // figma_status: how the last write ended (one its agent stopped asking about included), or the one waiting now.
      const w = lastWrite();
      if (w) r.lastFigmaWrite = w;
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
    // handleBridge runs these two itself (bridgeWrite, answerTicket): a write's hold comes after its run.
    case "write":
    case "writeTicket":
      return async () => { throw new Error(req.cmd + " is answered by handleBridge"); };
    // figma_write's dry run, the half only the file can answer: how much a source edit carries to (sources.ts), and what
    // a create table would make or update (creates.ts). Reads only, so it needs no "Allow edits"; a scene run, so it
    // waits for a write ahead of it.
    case "writeImpact": {
      const ops = req.args.ops;
      return () => designImpact(ops);
    }
    default: {
      // Exhaustive: a command added to commands.ts without a branch here fails to compile. Unreachable
      // at runtime — handleBridge already refused anything outside `Cmd` with the same message.
      const exhaustive: never = req;
      throw new Error("unknown cmd: " + String(exhaustive));
    }
  }
}
