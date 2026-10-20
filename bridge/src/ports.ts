// ports.ts — the ONLY ports a published plugin can reach. figma-plugin/manifest.json lists these three
// in `networkAccess.allowedDomains`, Figma's match patterns have no port wildcard, and a plugin socket
// to any other port is blocked by Figma before it leaves the iframe. So FIGMA_BRIDGE_PORT is a choice
// of three, not a free number: binding 9999 gives a bridge that nothing can ever connect to. Keep this
// array and the manifest's allowedDomains in sync — they are two halves of one contract.
//
// Its own module (no imports, no load-time effects) so doctor.ts — which must diagnose a bad
// FIGMA_BRIDGE_PORT rather than die of it — reads the same list and the same parse server-core.ts
// binds from, instead of a restated copy the test suite had to assert equal.
export const ALLOWED_PORTS: readonly [number, ...number[]] = [8787, 8788, 8789];

/** FIGMA_BRIDGE_PORT -> the port it selects, or `{ invalid }` (the raw value) when it names none of
 *  ALLOWED_PORTS. Unset or empty selects the first. The value goes through Number(), so surrounding
 *  whitespace is ignored and " 8788" selects 8788; a whitespace-only value is 0, which is invalid. */
export function parsePortEnv(raw: string | undefined): { port: number; invalid?: undefined } | { invalid: string; port?: undefined } {
  if (!raw) return { port: ALLOWED_PORTS[0] };
  const n = Number(raw);
  return ALLOWED_PORTS.includes(n) ? { port: n } : { invalid: raw };
}

/** The bridge's port from FIGMA_BRIDGE_PORT; on an invalid value, says why on stderr and exits 1. A
 *  process that would bind (server-core.ts) or name its daemon socket (daemon.ts) after a port no
 *  plugin can reach has nothing useful left to do. */
export function bridgePortOrExit(raw: string | undefined): number {
  const r = parsePortEnv(raw);
  if (r.port !== undefined) return r.port;
  console.error(
    `[bridge] FIGMA_BRIDGE_PORT=${r.invalid} is not one of ${ALLOWED_PORTS.join(", ")}. The Figma plugin ` +
      "may only open sockets to ports named in its manifest, so a bridge here would never be reachable."
  );
  process.exit(1);
}
