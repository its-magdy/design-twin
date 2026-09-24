// ports.ts — the ONLY ports a published plugin can reach. figma-plugin/manifest.json lists these three
// in `networkAccess.allowedDomains`, Figma's match patterns have no port wildcard, and a plugin socket
// to any other port is blocked by Figma before it leaves the iframe. So FIGMA_BRIDGE_PORT is a choice
// of three, not a free number: binding 9999 gives a bridge that nothing can ever connect to. Keep this
// array and the manifest's allowedDomains in sync — they are two halves of one contract.
//
// Its own module (no imports, no load-time effects) so doctor.ts — which must diagnose a bad
// FIGMA_BRIDGE_PORT rather than die of it — reads the same list server-core.ts binds from, instead of
// a restated copy the test suite had to assert equal.
export const ALLOWED_PORTS: readonly number[] = [8787, 8788, 8789];
