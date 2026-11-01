// bridge-observer.ts — the bridge holder's read-only lifetime: find out who holds the bridge and whether a plugin is on
// it, and change nothing.
//
// bridge-holder.ts takes the bridge (one-shot, serve, session): it commits the token, refreshes an installed plugin
// copy, binds, and may publish on the daemon socket. `dtwin doctor` must do none of that — it is safe to run at any
// moment, including while a daemon or the MCP server holds the port — so it used to re-derive the holder's order
// itself (the daemon address, the socket check, its status, a port probe, a bridge of its own) and read the settings
// again on the way. This module is that order, once, with the holder's own settings and no side effects:
//
//   holder()  the daemon at the address the settings resolve to → { via: "daemon", status }; else the port: free
//             → { via: "free" }, held by something else → { heldBy: websocket | http | unknown } (a plain HTTP GET:
//             a bridge answers 426 — never a WebSocket, which would register as a plugin client on whoever holds it).
//   watch()   only after holder() said free: a bridge of this process's own, with the token as resolved (never
//             committed, so a token nobody saved is never minted to disk), for up to `waitMs`, then closed —
//             { via: "own", clients, badToken, expected }, or { error } when it could not be opened.
//
// doctor.run takes an observer as a dependency (a suite passes a fake) and only words what it says.
import net from "node:net";
import http from "node:http";
import * as daemon from "./daemon.ts";
import type { DaemonStatusView } from "./daemon.ts";
import { daemonAddressOf } from "./settings.ts";
import type { BridgeSettings } from "./settings.ts";
import { errMsg } from "./errmsg.ts";
import type { Bridge, ClientRow } from "./server-core.ts";

/** probePort()'s answer: the port free, or what kind of thing holds it. */
export interface PortProbe {
  free: boolean;
  holder?: "websocket" | "http" | "unknown";
  detail?: string;
}

/** Who holds the bridge. `port` is the probe of the settings' port; `refused` is why the daemon socket's location
 *  cannot be used (daemon.sockProblem) — then no daemon was looked up there. */
export type Holding =
  | { via: "daemon"; status: DaemonStatusView; port: PortProbe; refused: null }
  | { via: "free"; port: PortProbe; refused: string | null }
  | { heldBy: "websocket" | "http" | "unknown"; detail?: string; port: PortProbe; refused: string | null };

/** A token the probe bridge refused (server-core authStats().lastBadToken). */
export interface BadToken { at: number; fingerprint: string | null }

/** What a bridge of this process's own saw in its window. */
export type OwnView =
  | { via: "own"; clients: ClientRow[]; badToken: BadToken | null; expected: string | null }
  | { error: string };

export interface BridgeObserver {
  holder(): Promise<Holding>;
  /** Only when holder() said `free`. Always closes what it opened. */
  watch(waitMs: number): Promise<OwnView>;
}

/** The real observer, for `settings` (read once, at the entry). */
export function bridgeObserver(settings: BridgeSettings): BridgeObserver {
  return {
    async holder() {
      // The daemon is looked up where every other command looks it up: the address the settings resolve to — its
      // socket, or on Windows the pipe named from the token as the settings have it. A refused socket location is
      // reported, not read as "no daemon" (status() alone would only warn on stderr and return null).
      const at = daemonAddressOf(settings);
      const refused = daemon.sockProblem(at);
      const status = refused ? null : await daemon.status(at).catch(() => null);
      const port = await probePort(settings.port);
      if (status) return { via: "daemon", status, port, refused: null };
      if (port.free) return { via: "free", port, refused };
      return { heldBy: port.holder ?? "unknown", ...(port.detail !== undefined ? { detail: port.detail } : {}), port, refused };
    },
    watch: (waitMs) => probePlugin(settings, waitMs),
  };
}

// Is the port free, and if not, what kind of thing holds it? Binds exactly as the bridge does (127.0.0.1), then lets
// go at once. Never opens a WebSocket — see the header.
export function probePort(port: number): Promise<PortProbe> {
  return new Promise<PortProbe>((resolve) => {
    const srv = net.createServer();
    srv.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code !== "EADDRINUSE") return resolve({ free: false, holder: "unknown", detail: errMsg(e) });
      const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1500 }, (res) => {
        res.resume();
        resolve(res.statusCode === 426 ? { free: false, holder: "websocket" } : { free: false, holder: "http", detail: `an HTTP server, answered ${res.statusCode}` });
      });
      req.on("timeout", () => req.destroy(new Error("no HTTP answer")));
      req.on("error", (err) => resolve({ free: false, holder: "unknown", detail: "not an HTTP server: " + errMsg(err) }));
    });
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve({ free: true })));
  });
}

// Open a real bridge on the (free) port and see whether a plugin shows up. The plugin retries every second, one of
// three ports at a time (slower in a background window), hence the wait. The bridge's own stderr chatter is muted for
// the duration: doctor reports the same facts itself, in one place. server-core is imported lazily, so a doctor run
// that never probes does not load it. ALWAYS closes.
export async function probePlugin(settings: BridgeSettings, waitMs: number): Promise<OwnView> {
  const realError = console.error;
  console.error = () => {};
  let bridge: Bridge | null = null;
  try {
    const core = await import("./server-core.ts");
    const b = core.createBridge(settings);
    bridge = b;
    const start = Date.now();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // Only a refusal from THIS probe counts — the last bad token is kept process-wide.
    const refused = () => { const bad = b.authStats().lastBadToken; return bad && bad.at >= start ? bad : null; };
    while (Date.now() - start < waitMs && !b.isConnected() && !refused()) await sleep(200);
    if (b.isConnected()) {
      // The file name arrives in a hello just after the socket opens, and a second open file may be a redial behind:
      // the bridge's own unaddressed wait (server-core awaitClient) covers both — the settle, then each socket's hello
      // or its identification grace — so the files are listed by name. Not bounded by the wait: every window is
      // stretched to the settle, so a probe whose plugin connects pays the settle (3.5 s) after it even with one file
      // open; a window that leaves meanwhile restarts the settle, up to the bridge's cap. A diagnostic can afford
      // that; naming a second open file is worth it.
      await b.awaitClient(null, Math.max(1, waitMs - (Date.now() - start)));
      return { via: "own", clients: b.listClients(), badToken: null, expected: b.authStats().expected };
    }
    return { via: "own", clients: [], badToken: refused(), expected: b.authStats().expected };
  } catch (e) {
    return { error: errMsg(e) };
  } finally {
    if (bridge) bridge.close();
    console.error = realError;
  }
}
