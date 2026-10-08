// source-stamp.ts — which connected Figma file answered a read, stamped onto its reply (P4 #33, L-5).
//
// A screen export result has no field of its own naming its source file (unlike design-system.json / a
// library catalog, which the plugin itself stamps), so the caller that knows WHICH client answered — the
// bridge's requestWithClient, or a daemon relaying it — stamps it here before the reply reaches
// write-out.ts, which persists it onto the screen JSON and its index row. Shared by the CLI and the MCP
// server so both paths write the same field. Unstamped (never guessed) when no client was handed back
// (a daemon too old to relay it) or the client has no file name yet.
import type { Stamped } from "./write-out.ts";

export function stampSource<R extends object>(sent: { reply: R; client: { file: string | null; fileKey: string | null } | null }): Stamped<R> {
  const r: Stamped<R> = sent.reply;
  const src = sent.client;
  if (src && src.file) { r.sourceFile = src.file; if (src.fileKey) r.sourceFileKey = src.fileKey; }
  return r;
}
