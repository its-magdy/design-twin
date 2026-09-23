// Hand-typed declarations for the `ws` package (8.x), which ships no types of its own. Adding
// @types/ws would be a new dependency, so this covers EXACTLY the surface this repo calls — nothing
// more — and is shared by two programs: bridge/tsconfig.json (server-core's WebSocketServer) and
// test/tsconfig.json, which `include`s this file for the test suites' plugin-side WebSocket client
// (bridge.test.ts, mcp-smoke.test.ts). If a new call site needs more of ws, add it here, typed.
//
// A standalone ambient .d.ts on purpose: a `declare module "ws"` inside a regular .ts file is
// rejected ("cannot be augmented") because the specifier resolves to a real, untyped package.
declare module "ws" {
  import type { IncomingMessage, OutgoingHttpHeaders } from "node:http";

  /** What a "message" listener receives: ws's `RawData`. */
  export type RawData = Buffer | ArrayBuffer | Buffer[];

  export interface ClientOptions {
    /** The Origin header to send — the tests send "null", as the plugin's sandboxed iframe does. */
    origin?: string;
  }

  /** One socket: the server's per-connection peer AND the Node-side client the tests connect with. */
  class WebSocket {
    constructor(address: string, options?: ClientOptions);
    /** readyState of an open socket (server-core compares against it). */
    static readonly OPEN: 1;
    readonly readyState: 0 | 1 | 2 | 3;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    // ws passes no arguments to "open"; the rest-of-unknown signature lets a Promise `resolve` be
    // handed in directly (`c.on("open", res)`), which `() => void` would reject.
    on(event: "open", listener: (...args: unknown[]) => void): this;
    on(event: "message", listener: (data: RawData, isBinary: boolean) => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    /** Client only: the server answered the upgrade with a plain HTTP response (e.g. a 401/403). */
    on(event: "unexpected-response", listener: (req: import("node:http").ClientRequest, res: IncomingMessage) => void): this;
  }

  /** The `info` argument of `verifyClient`, as ws builds it from the upgrade request. */
  export interface VerifyClientInfo {
    origin?: string;
    secure: boolean;
    req: IncomingMessage;
  }

  export type VerifyClientCallback = (
    result: boolean,
    code?: number,
    message?: string,
    headers?: OutgoingHttpHeaders,
  ) => void;

  export interface ServerOptions {
    host?: string;
    port?: number;
    /** Largest accepted frame, in bytes. */
    maxPayload?: number;
    /** The async (two-argument) form — the only one this repo uses. */
    verifyClient?: (info: VerifyClientInfo, callback: VerifyClientCallback) => void;
  }

  export class WebSocketServer {
    constructor(options: ServerOptions);
    close(callback?: (err?: Error) => void): void;
    on(event: "connection", listener: (socket: WebSocket, req: IncomingMessage) => void): this;
    on(event: "error", listener: (err: NodeJS.ErrnoException) => void): this;
  }

  export { WebSocket };
  export default WebSocket;
}
