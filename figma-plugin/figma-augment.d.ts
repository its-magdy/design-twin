// Local augmentation for API surface newer than the pinned @figma/plugin-typings, if any.
// The extractor reads several beta/2025 properties defensively via `(node as any)`; those need no
// declaration. Add typed shims here only when you want compile-time checking on a specific new prop
// that the installed typings version still lacks.

// Baked in by esbuild's `define` (build.js) from figma-plugin/package.json's version — see the
// comment there (finding 327). Declared here, not in bridge.ts, so any file may reference it.
// `declare global` is required, not just `declare const`: this file ends in `export {}`, which makes
// it a MODULE, and a bare ambient declaration in a module file is scoped to that module only.
declare global {
  const __PLUGIN_VERSION__: string;
}

export {};
