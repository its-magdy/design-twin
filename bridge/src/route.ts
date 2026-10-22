// route.ts — the one way a front-end reaches the Figma plugin, whoever holds the bridge.
//
// There are two ways to reach a plugin, and so two adapters behind one interface (Upstream):
//   - own:    this process holds the bridge (server-core's createBridge) — the CLI with no daemon running, or
//             the MCP server that bound the port first;
//   - daemon: another process holds it and serves it on the daemon socket (daemon.ts) — any dtwin command
//             while `dtwin serve` runs, or a second MCP server.
// The adapters only translate shapes. The RULES sit above them, in the Route, so the CLI and the MCP server
// cannot drift apart again (they had: a named-client wait done two ways, a stall check only one of them ran,
// the listClients/connectionInfo fallbacks copied). A route owns:
//   - the connect window: how long a request waits for a plugin (and for a named file, `namedWaitMs`, which is
//     the same window unless the policy says otherwise) before it is resolved against whatever is connected.
//     A one-shot route over its own bridge spends it once, up front (connect()); every other route spends it
//     per request (the daemon waits inside each one);
//   - the never-connected guard: a one-shot route whose window ran out with no plugin EVER connected says so
//     in its own words, rather than resolveClient's "not connected" (which is right for one that left);
//   - the stall check (server-core requestWithClient `stallMs`): one-shot, own bridge, export-class commands
//     only — the case where a freshly opened bridge can sit on a plugin too busy to answer at all. A daemon's
//     or a long-lived server's connection is warm, so they never pay for it;
//   - progress: only an export-class command hears ticks (a ping or a page list has none worth hearing);
//   - listClients and connectionInfo, from whichever side holds the bridge.
// MCP's sharing layer (figma-mcp.ts holder) decides per call WHICH upstream to use; a route takes that
// decision as a function, so it re-resolves exactly when the sharing layer does.
//
// Side-effect free, like daemon.ts: figma-pull.ts imports it at module level, and only types come from
// server-core (which resolves the token and may exit at load).
import { TIMEOUTS, daemonGuardMs } from "./timeouts.ts";
import { ifDefined } from "./json-util.ts";
import type { Cmd, Commands } from "./commands.ts";
import type { Bridge, ClientRow, ConnectionInfo, ProgressTick } from "./server-core.ts";
import type { DaemonBridge, DaemonConnection, DaemonStatusView } from "./daemon.ts";

/** A connection id as the registry mints it ("c" + a per-bridge sequence number). A target of this form
 *  names one socket, so it never depends on identification: waits for a client never hold it for a name. */
export function isConnId(target: string): boolean {
  return /^c\d+$/.test(target);
}

/**
 * `info` re-described for the connection `connId` — the `clients[]` row with that connId supplies
 * `connId`, `connectedAt` and `connectionUptimeMs` (its `uptimeMs`); every other field (`connected`,
 * `clientsConnected`, `clients`, `connectionsThisRun`, `takeovers`, `lastTakeoverAt`) is kept. A null/absent
 * connId, or one not among `clients`, returns `info` unchanged. Pure — works on a daemon's relayed
 * `status().connection` as well as on the own bridge's connectionInfo().
 */
export function connectionFor(info: ConnectionInfo, connId: string | null | undefined): ConnectionInfo {
  if (!connId) return info;
  const row = (info.clients || []).find((c) => c && c.connId === connId);
  if (!row) return info;
  return { ...info, connId: row.connId, connectedAt: row.connectedAt, connectionUptimeMs: row.uptimeMs };
}

/** The commands that walk a tree (and can run for minutes): the ones a stall check and progress ticks are for. */
const EXPORT_CLASS: ReadonlySet<string> = new Set<Cmd>(["exportNode", "exportSelection", "exportFull", "exportDesignSystem", "exportLibrary", "screenshot"]);
export const isExportClass = (cmd: string): boolean => EXPORT_CLASS.has(cmd);

/** What a request resolved with, and WHICH connected file answered (null only from a daemon too old to say). */
export interface Sent<C extends Cmd> { reply: Commands[C]["reply"]; client: ClientRow | null }

/** One request as an adapter takes it: no rules applied, every field passed through. */
export interface UpstreamRequest {
  /** the per-command budget (TIMEOUTS.command when absent) */
  timeoutMs?: number | undefined;
  /** connId / fileKey / file-name substring; absent = the only connected file */
  target?: string | null | undefined;
  /** > 0: wait that long for the target first (server-core awaitClient) */
  waitMs?: number | undefined;
  /** > 0: server-core's stall check (own bridge only; a daemon never runs it) */
  stallMs?: number | undefined;
  onProgress?: ((tick: ProgressTick) => void) | undefined;
  signal?: AbortSignal | undefined;
}

/** Who holds the bridge a route reached: this process, or a daemon (its pid; port and pluginConnected kept
 *  for a daemon too old to relay its whole connection). */
export type Owner = { kind: "own" } | { kind: "daemon"; pid: number | null; port: number | null; pluginConnected: boolean | null };

/** connectionInfo's answer: the socket half of whoami (null from a daemon too old to relay it), and its holder. */
export interface RouteConnection { connection: ConnectionInfo | null; owner: Owner }

/** The seam. Two adapters: ownUpstream (a bridge this process holds) and daemonUpstream (a daemon's socket). */
export interface Upstream {
  kind: "own" | "daemon";
  /** Where it is reached: own, the bridge's ws:// URL; daemon, its socket path. For the log line that says so. */
  address: string;
  request<C extends Cmd>(cmd: C, args: Commands[C]["args"], o: UpstreamRequest): Promise<Sent<C>>;
  /** Wait up to `waitMs` for a plugin (and `target`), then say whether any has connected in this bridge's
   *  life. A daemon answers null at once: it waits inside each request instead (the frame's waitForConnection). */
  awaitClient(target: string | null | undefined, waitMs: number): Promise<{ everConnected: boolean } | null>;
  listClients(): Promise<ClientRow[]>;
  connectionInfo(connId?: string | null): Promise<RouteConnection>;
}

/** The own adapter: server-core's positional requestWithClient, behind the seam. */
export function ownUpstream(bridge: Bridge): Upstream {
  return {
    kind: "own",
    address: "ws://localhost:" + bridge.port,
    request: (cmd, args, o) => bridge.requestWithClient(cmd, args, o.timeoutMs ?? TIMEOUTS.command, o.target, o.stallMs, o.onProgress, o.signal, ifDefined("waitMs", o.waitMs)),
    async awaitClient(target, waitMs) {
      await bridge.awaitClient(target, waitMs);
      return { everConnected: bridge.connectionInfo().connectionsThisRun > 0 };
    },
    listClients: async () => bridge.listClients(),
    connectionInfo: async (connId) => ({ connection: bridge.connectionInfo(connId ?? undefined), owner: { kind: "own" } }),
  };
}

/** The daemon adapter: a request becomes a socket frame (the connect window rides on it as waitForConnection,
 *  and the outer guard is sized for it — daemonGuardMs); listings come from the daemon's __status. */
export function daemonUpstream(conn: DaemonConnection, status: () => Promise<DaemonStatusView | null>): Upstream {
  return {
    kind: "daemon",
    address: conn.sock,
    request(cmd, args, o) {
      const timeoutMs = o.timeoutMs ?? TIMEOUTS.command;
      const waitMs = o.waitMs && o.waitMs > 0 ? o.waitMs : 0;
      return conn.requestWithClient({ cmd, args, timeoutMs, ...ifDefined("client", o.target ?? undefined), ...(waitMs > 0 ? { waitForConnection: waitMs } : {}) },
        daemonGuardMs(timeoutMs, waitMs), o.onProgress, o.signal);
    },
    awaitClient: async () => null,
    listClients: async () => (await status())?.clients || [],
    async connectionInfo(connId) {
      // An older daemon may omit fields (daemon.ts DaemonStatusView) — reported as null, never guessed.
      const st = await status();
      const owner: Owner = { kind: "daemon", pid: st?.pid ?? null, port: st?.port ?? null, pluginConnected: st?.pluginConnected ?? null };
      return { connection: st?.connection ? connectionFor(st.connection, connId) : null, owner };
    },
  };
}

/** What daemon.serve() drives, made from a bridge this process holds: requests go through the own adapter.
 *  `close` replaces the bridge's own (the MCP server's wrapper, which also forgets the bridge). */
export function servedBridge(bridge: Bridge, close: () => void = () => bridge.close()): DaemonBridge {
  return {
    port: bridge.port,
    isConnected: () => bridge.isConnected(),
    request: ownUpstream(bridge).request,
    close,
    listClients: () => bridge.listClients(),
    connectionInfo: () => bridge.connectionInfo(),
  };
}

export interface RoutePolicy {
  /** How long a request waits for a plugin to connect before it is resolved against whatever is there. */
  connectWaitMs: number;
  /** The CLI with no daemon: a bridge opened for one command. Spends the window once, up front, and is the
   *  one case the stall check and the never-connected guard are for. */
  oneShot: boolean;
  /** The stall window (one-shot, own bridge, export-class only); FIGMA_BRIDGE_STALL_MS, else 20 s. */
  stallMs?: number;
  /** The connect window for a NAMED target (a file name or fileKey, not a connId); `connectWaitMs` when absent.
   *  The CLI passes none: its `--timeout` is the window for every target, named or not (and server-core's
   *  awaitClient already caps a name at NAMED_CLIENT_WAIT_MS once a plugin is connected). The MCP server, whose
   *  connectWaitMs is 0, passes NAMED_CLIENT_WAIT_MS: every open window redials on its own clock, so the file
   *  asked for may land a moment after another. */
  namedWaitMs?: number;
}

export interface RouteRequest {
  timeoutMs?: number | undefined;
  target?: string | null | undefined;
  /** Heard only by an export-class command. */
  onProgress?: ((tick: ProgressTick) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export interface Route {
  /** Spend the connect window (a one-shot route over its own bridge; otherwise nothing to wait for here) —
   *  once: later calls answer the first one's result. Requests and listClients call it themselves; a caller
   *  calls it first only to time the wait. `target` is what that first wait waits for. */
  connect(target?: string | null): Promise<{ waitedMs: number }>;
  request<C extends Cmd>(cmd: C, args: Commands[C]["args"], o?: RouteRequest): Promise<Sent<C>>;
  listClients(): Promise<ClientRow[]>;
  /** The socket half of whoami for `connId` (the connection a request was answered by), and who holds it. */
  connectionInfo(connId?: string | null): Promise<RouteConnection>;
}

/** The window's text for the never-connected guard. */
const neverConnected = (windowMs: number): Error => new Error(
  `no Figma plugin connected within ${Math.round(windowMs / 1000)}s. In Figma DESKTOP open the file and run Plugins → Development → Design Twin, then run this again (--timeout <seconds> waits longer; \`dtwin doctor\` says what is wrong if it still won't connect).`,
);

const stallFromEnv = (): number => Number(process.env.FIGMA_BRIDGE_STALL_MS) || 20000;

/** A route over whatever `upstream` answers (called per use: MCP's sharing layer re-resolves the holder). */
export function createRoute(upstream: () => Promise<Upstream>, policy: RoutePolicy): Route {
  const namedWaitMs = policy.namedWaitMs ?? policy.connectWaitMs;
  const stallMs = policy.stallMs ?? stallFromEnv();
  let connected: Promise<{ waitedMs: number; everConnected: boolean | null }> | null = null;

  // The connect window a request carries: namedWaitMs for a named file, the policy's own for anything else.
  const windowFor = (target: string | null | undefined): number => {
    const named = !!target && !isConnId(target);
    return named ? namedWaitMs : policy.connectWaitMs;
  };

  function spend(up: Upstream, target: string | null | undefined) {
    return (connected ??= (async () => {
      if (!policy.oneShot || up.kind !== "own") return { waitedMs: 0, everConnected: null };
      const t0 = Date.now();
      const r = await up.awaitClient(target, policy.connectWaitMs);
      return { waitedMs: Date.now() - t0, everConnected: r ? r.everConnected : null };
    })());
  }

  return {
    async connect(target) {
      const { waitedMs } = await spend(await upstream(), target);
      return { waitedMs };
    },
    async request(cmd, args, o = {}) {
      const up = await upstream();
      const exportClass = isExportClass(cmd);
      // A one-shot route over its own bridge has spent its window up front: a plugin that connected and has
      // gone since is resolveClient's to report, at once — not another window.
      const spentUpFront = policy.oneShot && up.kind === "own";
      if (spentUpFront) {
        const c = await spend(up, o.target);
        if (c.everConnected === false) throw neverConnected(policy.connectWaitMs);
      }
      return up.request(cmd, args, {
        timeoutMs: o.timeoutMs,
        target: o.target,
        waitMs: spentUpFront ? 0 : windowFor(o.target),
        stallMs: spentUpFront && exportClass ? stallMs : undefined,
        onProgress: exportClass ? o.onProgress : undefined,
        signal: o.signal,
      });
    },
    async listClients() {
      const up = await upstream();
      // No plugin within the window is this listing's legitimate "none", not the never-connected error.
      if (policy.oneShot) await spend(up, null);
      return up.listClients();
    },
    async connectionInfo(connId) {
      return (await upstream()).connectionInfo(connId);
    },
  };
}
