// tokens-core.ts — the name readers every token emitter shares: a token name's segments and a Figma name made safe
// inside a generated comment. What a variable IS (colour, length, radius, font size, opacity percentage, …) is
// variable-class.ts's; a variable's default mode and value are variable-resolve.ts's, with every other mode rule.
//
// tokens.ts (DTCG / CSS / Resolver / Tailwind) and tokens-native.ts (SwiftUI / Compose / Flutter /
// React Native) must agree on a token's segments, so both import them from here. They live in
// their own module because tokens.ts imports tokens-native.ts (for toNative): tokens-native.ts importing
// them back from tokens.ts would be a cycle, which makes the bundler wrap tokens.ts as an inner module
// whose `import.meta.main` CLI guard then never fires.

// --- a Figma token name split into its `/` segments (trimmed, .{}$ stripped, whitespace folded to -).
// Memoized by name: emitTokens runs toDTCG, toCSS and lintNames over the SAME variable list, and each
// pass re-derives these from the name (a split plus a regex chain per segment, twice over for
// cssVarName). At 500-2000 variables that is ~6 recomputations per token for a value that is a pure
// function of the name. The returned array is shared, so callers must treat it as read-only — no
// current caller mutates it. Cache lifetime is one CLI process / one emitTokens call chain.
const segsCache = new Map<string, string[]>();
function segs(name: string | null | undefined): string[] {
  const key = String(name || "");
  let v = segsCache.get(key);
  if (v === undefined) {
    v = key.split("/").map((s) => s.trim().replace(/[.{}$]/g, "").replace(/\s+/g, "-")).filter(Boolean);
    segsCache.set(key, v);
  }
  return v;
}

// A Figma name (a collection, a variable, a source file) inside a generated comment: a line terminator would end a `//`
// comment and turn the rest of the name into code (JS/TS also end a line at U+2028/U+2029), `*/` would close a
// `/* */` or `/** */` one, a NUL makes swiftc warn, and a bidirectional control reorders how an editor shows the code
// around it (a Trojan Source line) — so each of those controls (and every other C0/C1 control but the tab) is a space
// and `*/` is `* /`.
const COMMENT_CONTROLS = /\r\n|[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const commentText = (s: unknown): string => String(s).replace(COMMENT_CONTROLS, " ").replace(/\*\//g, "* /");

export { segs, commentText };
