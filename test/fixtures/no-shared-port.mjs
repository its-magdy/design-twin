// Preload (`node --import <this> …`): a TCP listen on 8787–8789 — the ports a live Figma session and other
// Claude sessions use — binds an ephemeral port instead, and the real one is printed on stderr as
// `[no-shared-port] <asked> -> <port>` once it is listening, so a test can dial it. Nothing else changes:
// FIGMA_BRIDGE_PORT still names the daemon socket (designtwin-<port>.sock), and a unix-socket listen is a
// string, never remapped. Plain .mjs so it runs as a preload without a type-stripping step of its own.
import net from "node:net";

const SHARED = (p) => typeof p === "number" && p >= 8787 && p <= 8789;
const orig = net.Server.prototype.listen;
net.Server.prototype.listen = function (...a) {
  let asked = null;
  if (SHARED(a[0])) { asked = a[0]; a[0] = 0; }
  else if (a[0] && typeof a[0] === "object" && SHARED(a[0].port)) { asked = a[0].port; a[0] = { ...a[0], port: 0 }; }
  if (asked !== null) {
    this.once("listening", () => {
      const addr = this.address();
      if (addr && typeof addr === "object") process.stderr.write(`[no-shared-port] ${asked} -> ${addr.port}\n`);
    });
  }
  return orig.apply(this, a);
};
