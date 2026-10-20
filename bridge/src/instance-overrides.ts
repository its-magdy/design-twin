// The length an INSTANCE's `overrides` list is cut to. The plugin (components.ts instanceOverrides)
// keeps the first OVERRIDE_CAP entries and warns; a consumer that sees a list this long cannot know
// what was cut, so it treats the list as possibly incomplete (asset-owners.ts, design-to-code's
// audit). Defined once because the consumers infer truncation from the producer's cap: two copies
// that drift apart would read a cut list as complete. ES2019-safe and import-free: the plugin
// bundles it.
export const OVERRIDE_CAP = 100;
