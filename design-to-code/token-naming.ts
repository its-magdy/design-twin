// token-naming.ts — what a Figma variable is called in code, in both directions.
//
// FORWARD: the name each emitter writes — the CSS custom property (tokens.css), the Tailwind v4 theme variable
// (theme.css: a namespace + the `figma-` prefix), the native identifier (SwiftUI / Compose / Flutter / React Native),
// and the key tag a colliding variable carries. tokens.ts and tokens-native.ts name variables only through these.
//
// REVERSE: whether a name declared in code (`--color-figma-brand-600:`, `brand600 =`) is the definition of the token a
// plan's free-text codeToken names (`bg-figma-brand-600`, `var(--x)`, `ColorsTokens.brand600`) — the Stop hook's
// (verify-build.ts) "a token's own definition line is not a usage of its colour" — and which custom properties a
// codeToken needs declared. The reverse is built from the forward constants (namespaces, prefix, key tag), so a change
// to what the emitters write is a change to what the gate recognises; test/token-naming.test.ts round-trips them.
import { segs } from "./tokens-core.ts";
import { alnumKey } from "./map-util.ts";

// ================================================================ forward

// --- the key tag. Names are not unique (tokens.ts "identity"): two variables that fold onto one identifier and differ
// are both emitted, each under the identifier plus the first KEY_TAG_LEN characters of its Figma key.
const KEY_TAG_LEN = 8;
/** The tag a colliding variable's identifier carries: its key's first 8 characters, lower-cased (null without a key). */
export const keyTag = (key: unknown): string | null => (typeof key === "string" && key ? key.slice(0, KEY_TAG_LEN).toLowerCase() : null);
/** Where an identifier lives: a CSS custom property (tokens.css, theme.css) or a native identifier. */
export type NameTarget = "css" | "native";
const SUFFIX_SEP: Record<NameTarget, string> = { css: "-", native: "_" };
/** The identifier a colliding variable gets: `id` + the target's separator + `suffix` (its key tag, else a fallback). */
export const disambiguated = (id: string, suffix: string, target: NameTarget): string => id + SUFFIX_SEP[target] + suffix;

// --- tokens.css. CSS custom properties ARE case-sensitive, so var names PRESERVE case (only non-[A-Za-z0-9-] is
// folded) — otherwise "Gray/100" and "gray/100" would collide.
const varNameCache = new Map<string, string>();
/** The tokens.css custom property of a token name: `--` + its segments joined by `-`, case kept. */
export function cssVarName(tokenName: string): string {
  const key = String(tokenName || "");
  let v = varNameCache.get(key);
  if (v === undefined) varNameCache.set(key, (v = "--" + segs(key).join("-").replace(/[^A-Za-z0-9-]/g, "-")));
  return v;
}

// --- theme.css (Tailwind v4). The namespace a variable is filed under decides which utilities it makes (tokens.ts
// "Tailwind v4 theme"); every generated variable sits under the `figma-` sub-namespace so Tailwind's own scale cannot be
// redefined.
/** The Tailwind namespace a variable is filed under (tokens.ts twKind decides it); null = none fits. */
export type TwKind = "color" | "dimension" | "radius" | "fontSize" | "fontFamily";
const TW_NAMESPACE: Record<TwKind, string> = { color: "color", dimension: "spacing", radius: "radius", fontSize: "text", fontFamily: "font" };
export const TW_PREFIX = "figma-";
// The Tailwind key for a token name: kebab-case, lowercased, from the SAME segs() every other emitter uses, so
// `--color-figma-schemes-on-primary` and the DTCG `schemes.on.primary` describe one token.
function twSlug(name: string): string {
  const slug = segs(name).join("-").replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  return slug || "token";
}
/** The theme.css variable of a token name filed under `kind`: `--<namespace>-figma-<slug>`, or `--figma-<slug>` for none. */
export const tailwindVarName = (tokenName: string, kind: TwKind | null): string => "--" + (kind ? TW_NAMESPACE[kind] + "-" : "") + TW_PREFIX + twSlug(tokenName);

// --- native. Union of the four languages' reserved words that a token path can realistically spell.
const RESERVED = new Set(("default,class,object,in,is,as,do,if,else,for,while,return,var,val,let,func,fun,import,package,switch,case,break," +
  "continue,true,false,null,nil,self,super,this,new,static,final,const,enum,struct,extension,protocol,init,internal,public,private,open,operator," +
  "typealias,interface,when,try,catch,throw,void,with,get,set,dynamic,external,factory,mixin,part,required,show,hide,on,type,function,delete," +
  "export,yield,await,async,inout,repeat,guard,defer,where,any,some,lerp,copyWith,hashCode,toString,description").split(","));
const words = (s: string): string[] => String(s).replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
/** The native identifier for a name's parts (a token's segments, a mode name): camelCase, legal in all four languages. */
export function nativeIdentifier(parts: readonly string[]): string {
  const w = parts.flatMap(words);
  let id = w.map((x, i) => (i === 0 ? x.charAt(0).toLowerCase() + x.slice(1) : x.charAt(0).toUpperCase() + x.slice(1))).join("");
  if (!id) id = "token";
  if (/^[0-9]/.test(id)) id = "n" + id;
  if (RESERVED.has(id)) id += "Token";
  return id;
}

// ================================================================ reverse

// What differs between a declared name and the utility / variable that uses it, stripped to a CORE both sides share:
//   * a category prefix — a Tailwind namespace the emitter files under (TW_NAMESPACE), the other names a hand-written
//     theme uses for the same thing, and the utilities that read them (`bg-`, `gap-x-`, `rounded-` …). Longest first,
//     so `gap-x-` and `font-size-` are not read as `gap-` and `font-`;
//   * the `figma-` prefix (TW_PREFIX);
//   * a key tag (`-e26d506e` on the web, `_e26d506e` native: disambiguated) — 8 hex digits only, so a word is never one.
const CATEGORY_PREFIXES = [...new Set([
  ...Object.values(TW_NAMESPACE),
  "colors", "space", "rounded", "font-size", "font-weight", "leading", "tracking", "shadow",
  "bg", "border", "fill", "stroke", "ring", "outline", "gap", "gap-x", "gap-y",
  "p", "px", "py", "pt", "pr", "pb", "pl", "m", "mx", "my", "mt", "mr", "mb", "ml",
  "w", "h", "size", "inset", "top", "left", "right", "bottom",
])].sort((a, b) => b.length - a.length);
const CATEGORY = new RegExp(`^(${CATEGORY_PREFIXES.join("|")})-`);
const KEY_TAG = new RegExp(`[${Object.values(SUFFIX_SEP).join("")}][0-9a-f]{${KEY_TAG_LEN}}$`);
function tokenCore(x: unknown): string {
  let s = String(x || "").toLowerCase().replace(/^--/, "").replace(/^var\(--|\)$/g, "");
  s = s.replace(CATEGORY, "");
  s = s.replace(new RegExp(`^${TW_PREFIX}`), "").replace(KEY_TAG, "");
  return alnumKey(s);
}

// A free-text codeToken ("bg-primary / text-primary/80", "hover:bg-x", "var(--x)", "brand-600") split into the names it
// stands for — ONE reading, shared by the definition check and the undeclared-token check: split on whitespace, " / "
// and commas; strip variants (`hover:`), `!` and an opacity modifier (`/80`); `var(--x)` and `--x` name the custom
// property; a colour utility names `--color-<name>` (`builtin` when <name> is a Tailwind built-in colour, a width or an
// arbitrary value).
const COLOUR_UTILITY = /^(bg|text|border|ring|fill|stroke|outline|divide|placeholder|decoration|accent|caret|from|via|to|shadow)-(.+)$/;
const TW_PALETTE = /^(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}$/;
const TW_KEYWORD = new Set(["white", "black", "transparent", "current", "inherit"]);
interface TokenPart { text: string; prop: string | null; builtin: boolean }
function tokenParts(codeToken: string): TokenPart[] {
  const out: TokenPart[] = [];
  // `var(--x, fallback)` → `var(--x)` before splitting on commas
  for (const raw of codeToken.replace(/var\(\s*(--[\w-]+)\s*,[^)]*\)/g, "var($1)").split(/[\s,]+/)) {
    let t = raw.trim().toLowerCase().replace(/!$/, ""); // trailing `!` (Tailwind v4 important)
    if (!t || t === "/") continue;
    const v = /^var\((--[\w-]+)\)$/.exec(t);
    if (v && v[1]) { out.push({ text: v[1], prop: v[1], builtin: false }); continue; }
    if (t.startsWith("--")) { const n = t.replace(/:$/, ""); out.push({ text: n, prop: n, builtin: false }); continue; }
    t = t.slice(t.lastIndexOf(":") + 1).replace(/^!/, "").replace(/\/[\w.[\]%]+$/, "");
    const v4 = /^[a-z-]+-\((--[\w-]+)\)$/.exec(t); // Tailwind v4 `bg-(--brand)` reads the property directly
    if (v4 && v4[1]) { out.push({ text: t, prop: v4[1], builtin: false }); continue; }
    const name = COLOUR_UTILITY.exec(t)?.[2];
    if (!name) { out.push({ text: t, prop: null, builtin: false }); continue; }
    out.push({ text: t, prop: `--color-${name}`, builtin: TW_KEYWORD.has(name) || TW_PALETTE.test(name) || /^[\d.]+$|^\[/.test(name) });
  }
  return out;
}
// A native token is read through its collection — `ColorsTokens.brand600`, `LocalColorsTokens.current.brand600`,
// `Theme.of(context).extension<ColorsTokens>()!.brand600` — and the generated file declares the member alone
// (`brand600 = Color(0xFF…)`). A generated token line and a component's styling argument are the same syntax
// (`color = Color(0xFF…)`, `colors: [Color(0xFF…)]`, `backgroundImage: "…"`), so the line cannot tell them apart; its
// SCOPE can. A dotted reference stands for its last member only when the declaration sits inside a block whose head
// names one of the reference's containers — the container's own body (`class ColorsTokens {`, `object SpacingTokens {`),
// an instance of it (`val ColorsTokensLight = ColorsTokens(`, `static const light = ColorsTokens(`) or its initialiser
// (`export const colorsTokens = {`), as in every generated token file. A component that merely binds the name
// (`const colorsTokens = useColorsTokens()`) opens no block around its own styles. A member that is a styling property
// name (`color`, `background`, `tintColor`, … — key tag stripped) is refused even there. Either way the token still
// matches when the codeToken names it bare, exactly as before the rule.
interface MemberRef { member: string; containers: string[] }
const STYLE_PROPERTY = /^(color|background|foreground|fill|stroke|tint|border|outline|shadow|.*color)$/;
const IDENT = /^[A-Za-z_$][\w$]*$/;
function memberRefs(codeToken: string): MemberRef[] {
  const out: MemberRef[] = [];
  for (const raw of codeToken.split(/[\s,]+/)) {
    const part = raw.trim().replace(/!$/, "");
    const dot = part.lastIndexOf(".");
    const member = part.slice(dot + 1);
    if (dot <= 0 || !IDENT.test(member) || /(^|[^\w])\d+\.\w+$/.test(part)) continue; // `p-1.5` is a utility, not a member
    if (STYLE_PROPERTY.test(alnumKey(member.toLowerCase().replace(KEY_TAG, "")))) continue;
    // the path's own segments (`Theme`, `of`, `extension`) and generic arguments (`ColorsTokens`) — not call arguments
    const path = part.slice(0, dot).replace(/\([^()]*\)/g, "()");
    // (a container names a type or a collection — it has a capital: `ColorsTokens`, `colorsTokens`; never `light`, `current`)
    const containers = [...path.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]).filter((n) => n.length >= 3 && /[A-Z]/.test(n));
    if (containers.length) out.push({ member, containers });
  }
  return out;
}
// Is a block the container's own? Its head must DECLARE the container (`data class ColorsTokens`, `public struct
// ColorsTokens: …`, `object SpacingTokens`), CONSTRUCT it into a binding (`val ColorsTokensLight = ColorsTokens`, `static const light =
// ColorsTokens`) or INITIALISE a binding of that name (`export const colorsTokens: Record<…> = `) — the shapes the
// generated files have. A head that only mentions it is a local override (`ColorsTokens.light.copy`,
// `extension<ColorsTokens>()!.copyWith`, `const o: Partial<ColorsTokens> = `) — a hand-picked value. Compose's
// `LocalColorsTokens` provides `ColorsTokens` instances, so a `Local<C>` container also accepts C's blocks.
const escapeRe = (s: string): string => s.replace(/[$]/g, "\\$");
function headNames(head: string, container: string): boolean {
  const names = container.startsWith("Local") && container.length > 5 ? [container, container.slice(5)] : [container];
  return names.some((n) => {
    const c = escapeRe(n);
    return new RegExp(`\\b(?:class|struct|object|interface|enum|extension)\\s+${c}(?![\\w$])`).test(head)
      || new RegExp(`=\\s*${c}\\s*$`).test(head)
      || new RegExp(`(?:^|[^\\w$.])(?:const|val|var|let|final)\\s+${c}(?![\\w$])[^=]*=\\s*$`).test(head);
  });
}
// Every spelling a declaration of this token may carry, whatever file it is in: the whole codeToken, each part, each
// part's property.
function tokenCandidates(codeToken: string): string[] {
  const out = [codeToken];
  for (const p of tokenParts(codeToken)) {
    out.push(p.text);
    if (p.prop) out.push(p.prop);
  }
  return [...new Set(out)];
}

/** Is `declared` (a name a line of code declares) the definition of the token `codeToken` names? Exactly — after
 *  normalising both sides (`--color-x`, `var(--x)`, `bg-x`, the `figma-` prefix, a key tag all reduce to the same core) —
 *  never by substring: with tokens `input` and `border`, `border-color:` is a CSS property, not either token's
 *  definition. In a stylesheet only a custom property (`--x:`) declares a token. `enclosing` gives the heads of the
 *  blocks around the declaration (code-scanner.ts enclosingHeads): a qualified native reference's member counts only
 *  inside a block that names its container. */
export function namesToken(declared: string, codeToken: string, opts: { stylesheet: boolean; enclosing?: () => readonly string[] }): boolean {
  if (opts.stylesheet && !declared.startsWith("--")) return false;
  const exact = alnumKey(declared), core = tokenCore(declared);
  if (!exact) return false;
  const same = (c: string): boolean => exact === alnumKey(c) || (!!core && core === tokenCore(c));
  if (tokenCandidates(codeToken).some(same)) return true;
  const refs = opts.enclosing ? memberRefs(codeToken).filter((m) => same(m.member)) : [];
  if (!refs.length || !opts.enclosing) return false;
  const heads = opts.enclosing();
  return refs.some((m) => m.containers.some((c) => heads.some((h) => headNames(h, c))));
}

/** The custom properties `codeToken` needs declared (lower-cased): `--x` for `--x` / `var(--x)`, `--color-<name>` for a
 *  colour utility that is not a Tailwind built-in. Anything else (a bare name, `Color.brand`) needs none. */
export const requiredCustomProps = (codeToken: string): string[] => [...new Set(tokenParts(codeToken).filter((p) => p.prop && !p.builtin).map((p) => String(p.prop)))];
