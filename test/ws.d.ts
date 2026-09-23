// "ws" ships no types, and @types/ws is not a dependency of this repo. This ambient shim types the
// whole module `any` at this untyped third-party-module boundary (R8) for the two test files
// (bridge.test.ts, mcp-smoke.test.ts) that import it directly. A `declare module "ws" { … }` placed
// inside a regular .ts file is rejected by TS ("cannot be augmented") because the specifier resolves
// to a real, untyped file — the fix has to live in a standalone ambient .d.ts.
declare module "ws" {
  const WebSocket: any;
  export default WebSocket;
}
