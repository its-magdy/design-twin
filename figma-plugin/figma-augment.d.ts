// Local augmentation for API surface newer than the pinned @figma/plugin-typings, if any.
// The extractor reads several beta/2025 properties defensively via `(node as any)`; those need no
// declaration. Add typed shims here only when you want compile-time checking on a specific new prop
// that the installed typings version still lacks. Kept intentionally empty by default.
export {};
