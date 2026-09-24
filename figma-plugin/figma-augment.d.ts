// Local augmentation for API surface newer than the pinned @figma/plugin-typings, if any. As of
// 1.138.0 nothing the extractor reads is missing from the typings (audited 2026-09-24), so the only
// declarations here are the build-time constant and the test surface. Add a typed shim ONLY for a
// property you have grepped for in node_modules/@figma/plugin-typings/plugin-api.d.ts and not found,
// citing the developers.figma.com page — never widen a type to make a read compile.

// Baked in by esbuild's `define` (build.js) from figma-plugin/package.json's version — see the
// comment there (finding 327). Declared here, not in bridge.ts, so any file may reference it.
// `declare global` is required, not just `declare const`: this file ends in `export {}`, which makes
// it a MODULE, and a bare ambient declaration in a module file is scoped to that module only.
declare global {
  const __PLUGIN_VERSION__: string;

  // Test surface main.ts exposes so test/harness.ts can drive the read AND write APIs without the
  // bundle's IIFE scoping hiding them (see main.ts's own comment on the assignment). Typed from the
  // real exporting modules via `typeof import(...)` so this can never drift from what main.ts actually
  // assigns.
  // eslint-disable-next-line no-var
  var __designExport: {
    serialize: typeof import("./src/serialize").serialize;
    collectSelection: typeof import("./src/collect").collectSelection;
    collectNode: typeof import("./src/collect").collectNode;
    collectScreenshot: typeof import("./src/collect").collectScreenshot;
    collectFull: typeof import("./src/collect").collectFull;
    collectDesignSystemOnly: typeof import("./src/collect").collectDesignSystemOnly;
    collectLibraryFile: typeof import("./src/collect").collectLibraryFile;
    listPages: typeof import("./src/collect").listPages;
    listChildren: typeof import("./src/collect").listChildren;
    buildDesignSystem: typeof import("./src/components").buildDesignSystem;
    applyWrites: typeof import("./src/writes").applyWrites;
    listLibraries: typeof import("./src/libraries").listLibraries;
    collectLibraryComponents: typeof import("./src/libraries").collectLibraryComponents;
    serializeRun: typeof import("./src/state").serializeRun;
    requestCancel: typeof import("./src/progress").requestCancel;
  } | undefined;
}

export {};
