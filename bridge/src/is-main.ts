// "Was this file run directly, or imported?" — the fallback half of every CLI guard.
//
// Every entry point guards its CLI with `if (import.meta.main ?? isMainFallback(import.meta.url))`.
// `import.meta.main` was only added in Node v24.2.0 (Stability 1); on 24.0/24.1 it is `undefined`, and
// a bare `if (import.meta.main)` there made every CLI exit 0 having done nothing. The literal
// `import.meta.main` stays at each call site (not wrapped in a helper) because
// claude-plugin/build-scripts.ts textually rewrites it to `false` in inlined modules — and
// `false ?? x` is `false`, so the fallback never runs for a bundled library module.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Used ONLY when `import.meta.main` is undefined (Node < 24.2). Both sides are realpath-resolved:
// an npm `bin` shim is a symlink, so argv[1] is the link while import.meta.url is the target.
// Anything that cannot be resolved (no argv[1] under `node -e`, a deleted file) is "not main" —
// the safe answer, since importing must never start a CLI.
export function isMainFallback(metaUrl: string): boolean {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
