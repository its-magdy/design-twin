// tokens.js — turn the extractor's variable dump into design tokens.
//
// Consumes the `designSystem` shape from figma-plugin/code.js buildDesignSystem()/dumpVariables():
//   { colorProfile?, collections:[{name,modes:[modeName],default,theming}],
//     variables:[{ name:"color/primary", type:"COLOR"|"FLOAT"|"STRING"|"BOOLEAN",
//                  collection, values:{ modeName: "#2563eb" | 123 | {aliasOf:"blue/600"} }, ... }] }
//
// Emits:
//   toDTCG(ds[, warnings, opts]) -> W3C DTCG JSON in the STABLE 2025.10 format (references PRESERVED
//                             as "{group.token}"; structured color {colorSpace,components,alpha?,
//                             hex(6-digit)}; length FLOATs as $type "dimension" {value,unit:"px"},
//                             unitless ones as "number"; every leaf carries a valid $type).
//                             Not emitted: composite types (typography/shadow/…). Modes ride in
//                             $extensions["figma.com"].modes here AND in the resolver below.
//   toResolver(ds[, warnings, opts]) -> { resolver, files }: a DTCG **Resolver Module** 2025.10
//                             document (the spec-blessed portable theming mechanism) plus the token
//                             files it $refs. Each multi-mode collection becomes a modifier whose
//                             contexts are its mode names; base sets carry default-mode values and a
//                             context carries ONLY what differs (same dedup as toCSS).
//   toCSS(ds[, opts])      -> :root + [data-theme="mode"] custom properties (zero-dependency).
//   lintTokens(ds[, opts]) -> string[] of problems (never-silent guarantee): group/leaf collisions,
//                             duplicate names, malformed/missing color, missing default-mode value,
//                             dangling aliases, CSS var-name collisions, empty names.
//
// Defensive by construction: a collision or missing value is skipped + reported, never silently
// producing an illegal DTCG node or `--x: undefined;`. See docs/design-to-code-spec.md.

const round = (x) => Math.round(x * 10000) / 10000;

// --- name handling. CSS custom properties ARE case-sensitive, so var names PRESERVE case
// (only non-[A-Za-z0-9-] is folded) — otherwise "Gray/100" and "gray/100" would collide. ---
// Memoized by name: emitTokens runs toDTCG, toCSS and lintNames over the SAME variable list, and each
// pass re-derives these from the name (a split plus a regex chain per segment, twice over for
// cssVarName). At 500-2000 variables that is ~6 recomputations per token for a value that is a pure
// function of the name. The returned array is shared, so callers must treat it as read-only — no
// current caller mutates it. Cache lifetime is one CLI process / one emitTokens call chain.
const segsCache = new Map();
function segs(name) {
  const key = String(name || "");
  let v = segsCache.get(key);
  if (v === undefined) {
    v = key.split("/").map((s) => s.trim().replace(/[.{}$]/g, "").replace(/\s+/g, "-")).filter(Boolean);
    segsCache.set(key, v);
  }
  return v;
}
const dtcgRef = (tokenName) => "{" + segs(tokenName).join(".") + "}";
const varNameCache = new Map();
const cssVarName = (tokenName) => {
  const key = String(tokenName || "");
  let v = varNameCache.get(key);
  if (v === undefined) varNameCache.set(key, (v = "--" + segs(key).join("-").replace(/[^A-Za-z0-9-]/g, "-")));
  return v;
};

// --- identity: a Figma variable IS its key, never its name -------------------------------------
// Names are not unique. The livetest-3 export held 96 variables with 96 distinct keys and only 94
// distinct names: two variables called `Spacing/Space 4` (24 in the design system's library, 16 in a
// screen-local one) and two called `Spacing/Space 2`. Every emitter here used to key its output on
// the NAME, so the second definition silently overwrote the first — theme.css shipped
// `--spacing-space-4: 16px` for two screens whose own Figma says 24, under a "later definition wins"
// warning that described nothing useful. Worse, `Space 3` (16) and `(Space 3)` (12) are two
// different names that only collide AFTER slugging, so that pair was overwritten with no warning at
// all (livetest-3 findings 44, 94, 95).
//
// So every emitter plans its identifiers here, on the EMITTED identifier (the DTCG path, the CSS
// custom property, the Tailwind variable), and never picks a winner:
//   * the same key listed twice is one variable (the last record is used);
//   * different keys that fold onto one identifier but resolve to the same value in every mode
//     (`Space 2` = 8 under Desktop/Tablet/Mobile vs 8 under Mode 1) are emitted ONCE, and reported;
//   * different keys that fold onto one identifier and DIFFER are ALL emitted, each under the
//     identifier plus `-<first 8 chars of its key>`, and the warning names every key, its values,
//     the screens whose slice carries it, and the identifier it landed on.
const KEY_SUFFIX_LEN = 8;
function identityOf(v) {
  if (v && typeof v.key === "string" && v.key) return "k:" + v.key;
  return "n:" + String((v && v.collection) || "") + "\u0000" + String((v && v.name) || "");
}
const shortKey = (v) => (v && typeof v.key === "string" && v.key ? v.key.slice(0, KEY_SUFFIX_LEN).toLowerCase() : null);
const suffixSlug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Equivalent = every mode either variable declares resolves to the same value (a mode one side lacks
// falls back to that side's own default, which is exactly what every emitter below does with it).
function equivalentVars(a, b, collections) {
  if (a.type !== b.type) return false;
  const ba = JSON.stringify(baseValue(a, collections)), bb = JSON.stringify(baseValue(b, collections));
  if (ba !== bb) return false;
  const at = (v, base, m) => { const x = (v.values || {})[m]; return x === undefined ? base : JSON.stringify(x); };
  for (const m of new Set([...Object.keys(a.values || {}), ...Object.keys(b.values || {})])) if (at(a, ba, m) !== at(b, bb, m)) return false;
  return true;
}

// idOf(v) -> the identifier an emitter would give v on its own (null = the emitter skips v).
// suffix(id, s) -> that identifier disambiguated with `s`.
// exact(v) -> true when v's NAME reaches the identifier without any character being folded away.
//   When two DIFFERENT names collide (`Space 3` vs `(Space 3)`), exactly one of them usually spells
//   the identifier as written; that one keeps it and only the folded one is suffixed — order-free,
//   so re-ordering the input cannot move the plain name. Same-name pairs are always all suffixed.
// Returns { id(v), canonical: Set(v) — the ONE record emitted per identifier, notes[], byName }.
function planIds(vars, idOf, suffix, collections, output, exact) {
  const groups = new Map();
  for (const v of vars) {
    const id = idOf(v);
    if (id == null) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(v);
  }
  const ids = new Map(), canonical = new Set(), notes = [];
  const taken = new Set(groups.keys());
  for (const [id, list] of groups) {
    const byIdent = new Map();
    for (const v of list) byIdent.set(identityOf(v), v); // the same variable read twice: last record
    const members = [...byIdent.values()];
    const clusters = [];
    for (const v of members) {
      const c = clusters.find((cl) => equivalentVars(cl[0], v, collections));
      if (c) c.push(v); else clusters.push([v]);
    }
    if (clusters.length === 1) {
      for (const v of list) ids.set(v, id);
      canonical.add(members[0]);
      if (members.length > 1) notes.push({ output, id, differ: false, members: members.map((v) => ({ v, id })) });
      continue;
    }
    const assigned = new Map();
    const exactOnes = exact ? members.filter((v) => exact(v)) : [];
    const keeper = exactOnes.length === 1 && members.filter((v) => v.name === exactOnes[0].name).length === 1 ? exactOnes[0] : null;
    for (const v of members) {
      if (v === keeper) { assigned.set(identityOf(v), id); canonical.add(v); continue; }
      const s = shortKey(v) || suffixSlug(v.collection) || "alt";
      let nid = suffix(id, s);
      for (let n = 2; taken.has(nid); n++) nid = suffix(id, s + "-" + n);
      taken.add(nid);
      assigned.set(identityOf(v), nid);
      canonical.add(v);
    }
    for (const v of list) ids.set(v, assigned.get(identityOf(v)));
    notes.push({ output, id, differ: true, members: members.map((v) => ({ v, id: assigned.get(identityOf(v)) })) });
  }
  const byName = new Map();
  for (const v of vars) {
    if (!byName.has(v.name)) byName.set(v.name, []);
    byName.get(v.name).push(v);
  }
  return { id: (v) => ids.get(v), canonical, notes, byName };
}

// An alias carries its target's NAME only (that is all the export writes), so a name shared by two
// variables makes the target ambiguous. Equivalent candidates share one identifier and it does not
// matter; otherwise prefer the referrer's own collection, then the lowest key — deterministic, so a
// re-ordered input cannot change the output — and SAY so.
function aliasTarget(plan, name, referrer, warn) {
  const cands = (plan.byName.get(name) || []).filter((c) => plan.id(c) != null);
  if (!cands.length) return null;
  if (new Set(cands.map((c) => plan.id(c))).size === 1) return cands[0];
  const sameColl = cands.filter((c) => referrer && c.collection === referrer.collection);
  const pool = (sameColl.length && new Set(sameColl.map((c) => plan.id(c))).size === 1 ? sameColl : cands)
    .slice().sort((a, b) => String(a.key || "").localeCompare(String(b.key || "")));
  const pick = pool[0];
  if (warn) {
    warn(`alias '${referrer ? referrer.name : "?"}' -> '${name}' is AMBIGUOUS: the export names an alias target by name, and ${cands.length} different variables are called '${name}' ` +
      `(${cands.map((c) => (shortKey(c) ? "key " + shortKey(c) + "…" : "'" + c.collection + "'") + " " + JSON.stringify(c.values)).join(", ")}) — pointed at ${plan.id(pick)}; confirm in Figma which one it really aliases`);
  }
  return pick;
}

// One message per SET of colliding variables, however many outputs it showed up in — the same
// `Space 4` pair collides in tokens.dtcg.json, tokens.css and theme.css, and three near-identical
// paragraphs is how a warning stops being read.
function collisionMessages(notes, opts) {
  const sources = (opts && opts.sources) || null;
  const bySet = new Map();
  for (const n of notes) {
    const k = (n.differ ? "D" : "S") + n.members.map((m) => identityOf(m.v)).sort().join("|");
    if (!bySet.has(k)) bySet.set(k, []);
    bySet.get(k).push(n);
  }
  const out = [];
  for (const group of bySet.values()) {
    const first = group[0];
    const members = first.members.map((m) => m.v);
    const names = [...new Set(members.map((v) => v.name))];
    const who = (v) => {
      const k = shortKey(v);
      const where = k && sources && sources.get(v.key);
      return (k ? `key ${k}…` : `'${v.collection || ""}'`) + ` = ${JSON.stringify(v.values || {})}` +
        (where && where.length ? ` (from ${where.join(", ")})` : "");
    };
    const oneColl = members.every((v) => v.collection === members[0].collection) && members[0].collection;
    const subject = names.length === 1
      ? `${members.length} different Figma variables share the name '${names[0]}'${oneColl ? ` (collection '${members[0].collection}')` : ""}`
      : `${members.length} different Figma variables (${names.map((n) => `'${n}'`).join(", ")}) fold onto one identifier`;
    const where = group.map((n) => `${n.output} ${n.members.map((m) => m.id).join(" / ")}`).join("; ");
    if (first.differ) {
      out.push(`${subject} and resolve DIFFERENTLY — none is dropped, each keeps its own name: ${members.map(who).join(" vs ")}. ` +
        `Emitted as: ${where}. ` +
        (names.length === 1
          ? `Pick by key, never by name. A screen's own .vars.json usually carries only one of them under the plain name — ` +
            `generate that screen's theme from it (or from design-system/tokens.json), not from the merged variables.json.`
          : `The name spelled exactly as the identifier keeps it; a name that only reached it by folding punctuation carries its key.`));
    } else {
      out.push(`${subject} but resolve identically in every mode — emitted ONCE: ${members.map(who).join(" and ")} → ${where}.`);
    }
  }
  return out;
}

// --- Figma's "fully rounded" sentinel ------------------------------------------------------------
// A pill corner exports as a literal 1e9 (cross-check.js reports it as `sentinel-token-value`). It is
// an idiom, not a measurement, and `1000000000px` must never reach a stylesheet (livetest-3 #96).
// Every emitter writes the platform's own idiom instead: 9999px on the web (and in DTCG, with the
// original kept under $extensions), `.infinity` in SwiftUI, `double.infinity` in Flutter, 9999 in
// React Native, and 9999.dp with a CircleShape note in Compose.
const SENTINEL_MIN = 10000; // the same threshold as cross-check.js ABSURD_NUMBER
const WEB_FULL_ROUND = 9999;
function isRadiusVar(v) {
  const scopes = v.scopes || [];
  const narrowed = scopes.length && !scopes.every((s) => s === "ALL_SCOPES");
  if (narrowed) return scopes.includes("CORNER_RADIUS");
  return /radius|corner|round/i.test(String(v.collection || "") + "/" + v.name);
}
function isSentinel(v, raw) {
  if (!v || v.type !== "FLOAT" || isAlias(raw)) return false;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && Math.abs(n) >= SENTINEL_MIN && isRadiusVar(v);
}
const webNumber = (v, raw) => (isSentinel(v, raw) ? WEB_FULL_ROUND : raw);

// --- color: accept #rgb / #rgba / #rrggbb / #rrggbbaa; normalize to 6- or 8-digit lowercase. ---
function normHex(v) {
  if (typeof v !== "string") return null;
  const h = v.replace(/^#/, "");
  if (!/^[0-9a-fA-F]+$/.test(h)) return null;
  const e = (h.length === 3 || h.length === 4) ? h.split("").map((c) => c + c).join("") : h;
  return (e.length === 6 || e.length === 8) ? e.toLowerCase() : null;
}
const isHexish = (v) => typeof v === "string" && /^#/.test(v);
const isAlias = (v) => v && typeof v === "object" && typeof v.aliasOf === "string";

// --- CSS string safety. A custom-property value is a token stream, so a STRING token can break out of
// its declaration three different ways; all three are neutralized with CSS hex escapes (`\3b ` etc.):
//
//   1. Terminators — `;` `{` `}` (plus newlines and backslash) end the declaration or block early.
//   2. Comment delimiters — `/*` opens a comment that swallows every following declaration to the end
//      of the stylesheet (`*/` closes one early). Only the two-character sequences are escaped, so a
//      lone `/` or `*` in a legitimate value (`url(/img.png)`, `2 * 4`) still passes through.
//   3. Unbalanced `(` `)` or quotes — leave the parser inside a function/string to end-of-stylesheet.
//      Balance is checked first so ordinary values keep their delimiters verbatim: `cubic-bezier(.4,0,.2,1)`
//      and `"Inter", sans-serif` are balanced and are NOT escaped.
//
// lintTokens must report every value the emitter rewrites (the never-silent guarantee). Rather than
// keep a detector "twin" that has to be edited in lockstep with the escaper — and whose failure mode
// is invisible, a value quietly rewritten with no warning — the detector below simply ASKS the
// escaper whether it changed anything. The escaper is then the only place the rules live. ---
const CSS_UNSAFE = /[\\\n\r\f;{}]/g;
const hexEsc = (c) => "\\" + c.codePointAt(0).toString(16) + " ";

// True when `(`/`)` or quote characters don't pair up across the whole value.
function cssUnbalanced(s) {
  let depth = 0, dq = 0, sq = 0;
  for (const ch of String(s)) {
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth < 0) return true; }
    else if (ch === '"') dq++;
    else if (ch === "'") sq++;
  }
  return depth !== 0 || dq % 2 !== 0 || sq % 2 !== 0;
}
// Defined below cssEscapeText's declaration point in execution order (function hoisting) — it is
// exactly "would the emitter rewrite this?", so it can never be narrower than the escaper.
const cssNeedsEscape = (s) => typeof s === "string" && cssEscapeText(s) !== s;

// A MODE NAME lands inside an attribute selector — `[data-theme="<mode>"]`. That's a quoted-string
// context, not a value context, so cssEscapeText's rules don't apply: only `"` and `\` are structural
// there, and either one closes the string early and lets the rest of the name inject arbitrary
// selectors and declarations. Mode names are free-form designer strings (the Plugin API documents no
// restriction on them), so escape the two characters that matter. cssAttrNeedsEscape derives from the
// escaper for the same reason as cssNeedsEscape above — one rule, no twin to keep in sync.
const CSS_ATTR_UNSAFE = /["\\]/g;
const cssAttrEscape = (s) => String(s).replace(CSS_ATTR_UNSAFE, hexEsc);
const cssAttrNeedsEscape = (s) => cssAttrEscape(s) !== String(s);

function cssEscapeText(s) {
  const raw = String(s);
  let out = raw.replace(CSS_UNSAFE, hexEsc);
  // Break comment delimiters by escaping only the `*`, so `/` and `*` alone survive untouched.
  out = out.replace(/\/\*/g, "/" + hexEsc("*")).replace(/\*\//g, hexEsc("*") + "/");
  // Only when the value is genuinely unbalanced — balanced parens/quotes are legitimate CSS.
  if (cssUnbalanced(raw)) out = out.replace(/[()"']/g, hexEsc);
  return out;
}

function hexToColorValue(hex, colorProfile) {
  const e = normHex(hex);
  if (!e) return null;
  const n = (i) => parseInt(e.slice(i, i + 2), 16) / 255;
  const value = { colorSpace: colorProfile === "display-p3" ? "display-p3" : "srgb", components: [round(n(0)), round(n(2)), round(n(4))] };
  // DTCG Color Module 2025.10: opacity lives in `alpha`; the `hex` fallback MUST be 6-digit
  // ("to avoid conflicts with the provided alpha value"). An 8-digit hex fallback is non-conformant.
  if (e.length === 8) value.alpha = round(n(6));
  value.hex = "#" + e.slice(0, 6);
  return value;
}

// DTCG 2025.10 $type mapping. `string` became a primitive type in 2025.10 (so STRING is no longer
// typeless). BOOLEAN has NO DTCG type — handled separately (a typeless token is INVALID per spec).
const DTCG_TYPE = { COLOR: "color", FLOAT: "number", STRING: "string" };

function defaultModeName(variable, collections) {
  const c = (collections || []).find((x) => x.name === variable.collection);
  const modes = variable.values ? Object.keys(variable.values) : [];
  if (c && c.default && modes.includes(c.default)) return c.default;
  return modes[0]; // fall back to any present mode rather than emit undefined
}
// The value that should populate $value / :root — never undefined (falls back to any present mode).
// `def` may be passed in when the caller already computed the default mode (avoids recomputing it).
function baseValue(variable, collections, def) {
  const values = variable.values || {};
  if (def === undefined) def = defaultModeName(variable, collections);
  if (values[def] !== undefined) return values[def];
  const firstDefined = Object.keys(values).find((m) => values[m] !== undefined);
  return firstDefined !== undefined ? values[firstDefined] : undefined;
}

// `dimension`: the FLOAT is a length (see unitDecision) — DTCG 2025.10 requires the object form
// {value, unit:"px"|"rem"} for $type "dimension"; a bare number there is non-conformant.
function dtcgValue(raw, colorProfile, dimension, ref) {
  if (isAlias(raw)) return ref ? ref(raw.aliasOf) : dtcgRef(raw.aliasOf);
  if (dimension) {
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? { value: n, unit: "px" } : raw;
  }
  const c = isHexish(raw) ? hexToColorValue(raw, colorProfile) : null;
  return c || raw;
}

// Build nested DTCG groups from "a/b/c". ONE builder behind BOTH emitters that produce DTCG trees:
// toDTCG (a single tree, default-mode values, every mode under $extensions) and toResolver (one tree
// per resolver set, values picked per mode). `pick` is the ONLY thing that varies — typing, the
// dimension/color/alias value shape, the reserved-key guard and the collision guards are shared, so a
// resolver set file and tokens.dtcg.json can never disagree about a token's $type or value form.
//
// `pick` returns SKIP when this particular tree deliberately does not carry the token (the resolver's
// per-mode dedup: unchanged-from-default). That is the ONE omission that is intentional rather than a
// loss, so it is the one that produces no warning; `undefined` still means "no value anywhere" and is
// reported. The value check runs BEFORE the group descent so a skipped token leaves no empty group
// behind in a context file.
// `opts` is the same bag toCSS takes (opts.unitless) — the px-vs-unitless decision for a FLOAT is made
// by the ONE unitDecision() every emitter shares, so tokens.dtcg.json, tokens.css and the resolver set
// files cannot disagree about which numbers are lengths.
const SKIP = Symbol("resolver-set omits this token");
// The DTCG plan: a token's path is its name's segments; two variables that fold onto one path are
// disambiguated on the LAST segment (see planIds). Planned over the WHOLE variable list even when a
// resolver set file only holds one collection, because every set is merged into one namespace.
const DTCG_SEP = "\u0000";
function dtcgPlan(designSystem) {
  const ds = designSystem || {};
  return planIds(ds.variables || [], (v) => { const p = segs(v.name); return p.length ? p.join(DTCG_SEP) : null; },
    (id, s) => id + "-" + s, ds.collections, "tokens.dtcg.json", (v) => !/[.{}$]/.test(String(v.name)));
}
function buildTree(designSystem, warn, opts, pick, withExtensions, plan) {
  const root = {};
  const { collections, colorProfile } = designSystem || {};
  plan = plan || dtcgPlan(designSystem);
  const ref = (referrer) => (name) => {
    const t = aliasTarget(plan, name, referrer, warn);
    return t ? "{" + plan.id(t).split(DTCG_SEP).join(".") + "}" : dtcgRef(name);
  };
  for (const v of (designSystem && designSystem.variables) || []) {
    if (!segs(v.name).length) { warn(`variable with empty/degenerate name skipped: '${v.name}'`); continue; }
    if (!plan.canonical.has(v)) continue; // the same variable twice, or an identical twin — emitted once, reported by planIds
    const path = plan.id(v).split(DTCG_SEP);
    // Reserved keys would let a token name walk into / write onto Object.prototype (prototype pollution)
    // — token maps are semi-trusted third-party dumps, so refuse them explicitly.
    if (path.some((s) => s === "__proto__" || s === "constructor" || s === "prototype")) {
      warn(`token '${v.name}' uses a reserved key (__proto__/constructor/prototype) — skipped`); continue;
    }
    const bv = pick(v);
    if (bv === SKIP) continue;
    if (bv === undefined) { warn(`token '${v.name}' has no value in any mode — skipped`); continue; }

    // Descend, guarding leaf/group collisions instead of clobbering or producing illegal nodes.
    let node = root, collided = false;
    for (let i = 0; i < path.length - 1; i++) {
      if (node[path[i]] === undefined) node[path[i]] = {};
      else if (node[path[i]] && node[path[i]].$value !== undefined) {
        warn(`token '${v.name}' collides with token '${path.slice(0, i + 1).join("/")}' (a name is used as both a value and a group) — skipped`);
        collided = true; break;
      }
      node = node[path[i]];
    }
    if (collided) continue;
    const leafKey = path[path.length - 1];
    if (node[leafKey] !== undefined && node[leafKey].$value === undefined) {
      warn(`token '${v.name}' collides with a group of the same name — skipped`); continue;
    }
    // planIds gave every distinct variable its own path, so an occupied leaf here can only be a
    // path that some OTHER name also reaches after sanitising (reported by planIds). Never overwrite.
    if (node[leafKey] !== undefined) { warn(`token '${v.name}' lands on '${path.join("/")}', which another token already holds — skipped, nothing overwritten`); continue; }

    const leaf = {};
    let type = DTCG_TYPE[v.type];
    if (v.type === "COLOR" && isHexish(bv) && !normHex(bv)) warn(`token '${v.name}' has malformed hex '${bv}'`);
    // A FLOAT that toCSS would emit with `px` IS a dimension; one it leaves unitless (opacity,
    // font-weight) stays a `number`.
    const dimension = v.type === "FLOAT" && unitDecision(v, opts) === "px";
    if (dimension) type = "dimension";
    const aliasRef = ref(v);
    let value = dtcgValue(webNumber(v, bv), colorProfile, dimension, aliasRef);
    if (v.type === "BOOLEAN") {
      // DTCG 2025.10 has no boolean type, and a token with no resolvable $type is INVALID. Coerce to a
      // string token ("true"/"false"); the origin is recorded under $extensions so it round-trips.
      type = "string";
      if (!isAlias(bv)) value = String(value);
      warn(`token '${v.name}' is BOOLEAN — DTCG has no boolean type; emitted as $type:"string" (origin kept in $extensions)`);
    }
    if (!type) { warn(`token '${v.name}' (type ${v.type}) maps to no DTCG $type — skipped (a typeless token is invalid per DTCG 2025.10)`); continue; }
    leaf.$type = type;
    leaf.$value = value;
    if (v.description) leaf.$description = v.description;

    if (!withExtensions) { node[leafKey] = leaf; continue; } // resolver set files: modes live in the resolver

    const values = v.values || {};
    const modeKeys = Object.keys(values);
    const ext = {};
    // Null-prototype: keyed by MODE NAMES, which are free-form designer strings (the Plugin API
    // documents no character/reserved-word restriction on addMode/renameMode) arriving via JSON.parse
    // — which, unlike an object literal, creates a REAL own "__proto__" key. On a plain object
    // `modes["__proto__"] = {...}` sets the prototype instead of an own key, so the mode vanished from
    // the emitted JSON with no warning. Same hardening as toDTCG's reserved-key guard on token NAMES.
    if (modeKeys.length > 1) { ext.modes = Object.create(null); for (const m of modeKeys) if (values[m] !== undefined) ext.modes[m] = dtcgValue(webNumber(v, values[m]), colorProfile, dimension, aliasRef); }
    // The key is the variable's identity (the name is not unique — see planIds), so it travels with
    // the token: a consumer can always get back from an emitted name to the one Figma variable.
    if (typeof v.key === "string" && v.key) ext.key = v.key;
    if (isSentinel(v, bv)) ext.sentinel = { figmaValue: bv, meaning: "fully rounded — emitted as the platform idiom" };
    if (v.scopes && v.scopes.length) ext.scopes = v.scopes;
    if (v.codeSyntax && Object.keys(v.codeSyntax).length) ext.codeSyntax = v.codeSyntax;
    if (v.type === "BOOLEAN") ext.originalType = "boolean"; // marks a boolean coerced to a string token
    // Vendor key `figma.com` — the namespace the DTCG Resolver Module's own examples and Figma's native
    // export use (not the reverse-DNS `com.figma`). Modes are kept here as data-preserving metadata so
    // ONE file still carries everything; the spec-blessed portable theming mechanism is the Resolver
    // Module (per-mode files), emitted alongside by toResolver() — the two are kept in sync by the
    // shared buildTree/dtcgValue path, and the round-trip is asserted in test/design-to-code.test.js.
    if (Object.keys(ext).length) leaf.$extensions = { "figma.com": ext };
    node[leafKey] = leaf;
  }
  return root;
}

// `notes` (internal): when given, name collisions are collected there as objects so emitTokens can
// report each colliding SET once across every output; otherwise they are formatted into `warnings`.
function toDTCG(designSystem, warnings, opts, notes) {
  const warn = (m) => { if (warnings) warnings.push(m); };
  const collections = (designSystem || {}).collections;
  const plan = dtcgPlan(designSystem);
  const tree = buildTree(designSystem, warn, opts, (v) => baseValue(v, collections), true, plan);
  if (notes) notes.push(...plan.notes);
  else for (const m of collisionMessages(plan.notes, opts)) warn(m);
  return tree;
}

// FLOAT unit: Figma FLOAT variables are overwhelmingly dimensions -> `px`; OPACITY/FONT_WEIGHT scopes
// (and any name in opts.unitless) stay unitless so we never emit invalid CSS like `opacity: 0.5px`.
// LINE_HEIGHT/LETTER_SPACING are DELIBERATELY not unitless: per the Figma API these are px|percent
// (LineHeight = {value, unit:"PIXELS"|"PERCENT"} | AUTO), never a CSS-style unitless multiplier — so
// `px` is the safe default. Emitting them unitless would be wrong (`line-height: 24` = 24x font size)
// and for letter-spacing outright invalid CSS (a bare number is not a valid <length>). Use opts.unitless
// to override per-token when a source genuinely encodes a multiplier.
const UNITLESS_SCOPES = new Set(["OPACITY", "FONT_WEIGHT"]);
// Scopes are only a signal when the designer NARROWED them. Figma's default is ALL_SCOPES, and real
// files overwhelmingly leave it there (it's the very smell `hygiene[]` reports) — so a scopes-only
// rule emits `font-weight: 500px` / `opacity: 0.5px` on the common case. Both are invalid CSS the
// browser drops. When scopes carry no signal, fall back to the NAME. Narrow scopes still win, so an
// explicitly-scoped variable is never second-guessed by a name match.
// Matched per `/`-SEGMENT, not as a substring of the whole name. A substring rule (what this was)
// cannot tell "font-weight/bold" from "font-weight-scale/lg": both contain "font-weight" followed by a
// non-letter, but the second is a multiplier — the one FLOAT in the family where dropping the unit is
// the wrong call. Figma names are `/`-delimited groups, so the group IS the unit of meaning: a segment
// that is exactly the property (ignoring case and -/_/space) names it; one that merely starts with it
// names something else. "text/font-weight" and "Opacity/disabled" both still match.
const UNITLESS_NAME_SEGMENTS = new Set(["opacity", "fontweight"]);
function unitlessName(name) {
  // segs() is this module's ONE definition of "a Figma token name split into meaningful segments"
  // (it trims, strips .{}$ and folds whitespace). Re-splitting on "/" here let the unit heuristic
  // segment a name differently from cssVarName/dtcgRef, so the linter could claim a heuristic hit on
  // a token whose emitted var name was built from other segments.
  return segs(name).some((seg) => UNITLESS_NAME_SEGMENTS.has(seg.replace(/[-_ ]/g, "").toLowerCase()));
}
// The SCOPE rule, in one place: a variable is unitless only when EVERY scope says so. Real files scope
// a single FLOAT to several text properties at once (e.g. FONT_WEIGHT + FONT_SIZE + LINE_HEIGHT on one
// "Body" size token) — `.some()` let one unitless scope override the length scopes sitting right next
// to it, emitting a bare number (`--Body-2: 18;`) on what is, in practice, a px value.
// Scopes are a STRONG SIGNAL, not ground truth: per the Plugin API docs on Variable.scopes, setting
// them "does not prevent that variable from being bound in other scopes (for example, via the Plugin
// API). This only limits the variables that are shown in pickers within the Figma UI." So an
// OPACITY-scoped FLOAT can still be bound to a width. It's the best evidence the file has and stays
// authoritative; opts.unitless is the escape hatch when it's wrong.
function scopesSayUnitless(scopes) {
  return !!scopes.length && scopes.every((s) => UNITLESS_SCOPES.has(s));
}
// WHO decided this token's unit, in one place: "override" (the caller named it), "scopes" (the
// designer narrowed them), "name" (no scope signal — the heuristic guessed), or "px" (the default).
// One function so the emitter and the linter cannot disagree about which tokens the heuristic touched:
// numberUnit maps the decision to a unit, and lintNames warns iff the decision was "name".
function unitDecision(variable, opts) {
  if (opts && opts.unitless && opts.unitless.has && opts.unitless.has(variable.name)) return "override";
  const scopes = variable.scopes || [];
  if (scopesSayUnitless(scopes)) return "scopes";
  const narrowed = scopes.length && !scopes.every((s) => s === "ALL_SCOPES");
  if (!narrowed && unitlessName(variable.name)) return "name";
  return "px";
}
function numberUnit(variable, opts) {
  return unitDecision(variable, opts) === "px" ? "px" : "";
}

// A value -> CSS text. Reference -> var(); color -> hex; number -> `${n}${unit}` (0 stays unitless).
function cssValue(raw, unit, ref) {
  if (isAlias(raw)) return "var(" + (ref ? ref(raw.aliasOf) : cssVarName(raw.aliasOf)) + ")";
  const e = isHexish(raw) ? normHex(raw) : null;
  if (e) return "#" + e;
  const fmtNum = (s) => (s === "0" ? "0" : unit ? s + unit : s); // 0 stays unitless; String(0) === "0"
  if (typeof raw === "number") return fmtNum(String(raw));
  if (typeof raw === "string" && /^-?\d+(?:\.\d+)?$/.test(raw)) return fmtNum(raw); // string-number FLOAT
  if (typeof raw === "boolean") return String(raw);
  if (typeof raw === "string") return cssEscapeText(raw); // arbitrary STRING token -> escape CSS breakout chars
  return String(raw);
}

// The tokens.css plan: one custom property per distinct variable (see planIds).
function cssPlan(designSystem) {
  const ds = designSystem || {};
  return planIds(ds.variables || [], (v) => (segs(v.name).length ? cssVarName(v.name) : null), (id, s) => id + "-" + s, ds.collections, "tokens.css",
    (v) => cssVarName(v.name) === "--" + segs(v.name).join("-"));
}

// `notes` (internal): see toDTCG.
function toCSS(designSystem, opts, notes) {
  const collections = (designSystem && designSystem.collections) || [];
  const vars = (designSystem && designSystem.variables) || [];
  const selectorFor = (mode) => (opts && opts.selector ? opts.selector(mode) : `[data-theme="${cssAttrEscape(mode)}"]`);

  // Keyed by custom-property NAME, not pushed as lines. Two records of the SAME variable, or two
  // variables that resolve identically in every mode (seen live: three "Schemes/On Primary" with
  // distinct keys, 22 copies of one declaration), emit ONE declaration. Two variables that fold onto
  // one property and DIFFER each get their own property (planIds) — the browser's "last one wins"
  // is exactly the silent overwrite that shipped `--spacing-space-4: 16px` (livetest-3 #44).
  const plan = cssPlan(designSystem);
  if (notes) notes.push(...plan.notes);
  const ref = (referrer) => (name) => { const t = aliasTarget(plan, name, referrer); return t ? plan.id(t) : cssVarName(name); };
  const rootLines = new Map();
  // Null-prototype: keyed by MODE NAMES (free-form designer strings, reaching us through JSON.parse,
  // which creates a real own "__proto__" key). On a plain object `perMode["__proto__"]` resolves to
  // Object.prototype — truthy, but with no .push — so this line threw an uncaught TypeError and the
  // CLI died AFTER having already written tokens.dtcg.json, leaving a half-written output pair.
  const perMode = Object.create(null);
  for (const v of vars) {
    if (!segs(v.name).length) continue; // skip empty names (would emit invalid `--:`)
    if (!plan.canonical.has(v)) continue;
    const values = v.values || {};
    const def = defaultModeName(v, collections);
    const base = baseValue(v, collections, def);
    if (base === undefined) continue; // never emit `--x: undefined;`
    const baseStr = JSON.stringify(base); // hoisted: base is invariant across the mode loop below
    const unit = numberUnit(v, opts);
    const varName = plan.id(v);
    const r = ref(v);
    rootLines.set(varName, `  ${varName}: ${cssValue(webNumber(v, base), unit, r)};`);
    for (const m of Object.keys(values)) {
      if (m === def || values[m] === undefined) continue;
      if (JSON.stringify(values[m]) === baseStr) continue; // dedup vs the EMITTED base (handles undefined-default)
      (perMode[m] || (perMode[m] = new Map())).set(varName, `  ${varName}: ${cssValue(webNumber(v, values[m]), unit, r)};`);
    }
  }
  let out = rootLines.size ? ":root {\n" + [...rootLines.values()].join("\n") + "\n}\n" : "";
  for (const m of Object.keys(perMode)) out += `\n${selectorFor(m)} {\n` + [...perMode[m].values()].join("\n") + "\n}\n";
  return out;
}

// --- Tailwind v4 theme ------------------------------------------------------------------------
//
// Why this exists (live run #18): `--native <profile>` gives a native project ONE checked-in token
// file every screen imports. A web project had no equivalent — tokens.css is plain custom properties,
// which Tailwind does not turn into utilities, so the builder hand-wrote an `@theme` block from the
// bound token names and pasted the hexes into the plan's allowedLiterals. Two screens built in
// separate sessions would then disagree about what `--color-primary` is called. Same fix as native:
// generate it once.
//
// Tailwind v4 generates a utility from a theme variable's NAMESPACE (tailwindcss.com/docs/theme):
// `--color-*` -> bg-/text-/border-, `--spacing-*` -> p-/m-/gap-, `--radius-*` -> rounded-,
// `--text-*` -> text-<size>, `--font-*` -> font-. So a Figma variable has to be filed under the right
// namespace or it produces a custom property nobody can reach from a class. A FLOAT that carries no
// unit (opacity, font-weight) matches no Tailwind namespace at all; it is still emitted, so `var(--x)`
// works, but it generates no utility — which is the honest outcome, not a silent drop.
//
// Every generated variable sits under a `figma-` sub-namespace (`--radius-figma-xl`, `--spacing-
// figma-space-4`, `--color-figma-primary-primary`), because Tailwind v4's own scale lives in the SAME
// namespaces and an `@theme` variable of the same name REPLACES it. Figma's `XL` radius emitted as
// `--radius-xl: 16px` silently redefined the framework's `rounded-xl` (12px) in every project pulled
// through this tool, and `--radius-l`/`--radius-s` minted `rounded-l`/`rounded-s`, which Tailwind
// already defines as the LEFT/START-corner shorthands (livetest-3 #183). Figma names are free-form, so
// no finite list of Tailwind's defaults (`xl`, `4`, `full`, `red-500`, `sans`, a bare `--spacing`)
// can be relied on; one prefix makes a collision impossible and every design-system utility greppable.
//
// Modes: `@theme` cannot be nested in a selector, so the default mode's values live there and every
// other mode reassigns the SAME custom properties in a plain `[data-theme="…"]` block. Tailwind's
// generated utilities read `var(--color-…)`, so they follow the override with no extra work.
const TW_NAMESPACE = { color: "--color-", dimension: "--spacing-", radius: "--radius-", fontSize: "--text-", fontFamily: "--font-" };
const TW_PREFIX = "figma-";

// The Tailwind key for a token name: kebab-case, lowercased, from the SAME segs() every other
// emitter uses, so `--color-figma-schemes-on-primary` and the DTCG `schemes.on.primary` describe one token.
function twSlug(name) {
  const slug = segs(name).join("-").replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  return slug || "token";
}
function twName(v, opts) {
  const kind = twKind(v, opts);
  return (kind ? TW_NAMESPACE[kind] : "--") + TW_PREFIX + twSlug(v.name);
}

const RADIUS_SCOPES = new Set(["CORNER_RADIUS"]);
function twKind(v, opts) {
  if (v.type === "COLOR") return "color";
  if (v.type === "STRING") return /font.?family|typeface/i.test(String(v.collection) + "/" + v.name) ? "fontFamily" : null;
  if (v.type !== "FLOAT") return null;
  if (unitDecision(v, opts) !== "px") return null; // unitless: opacity/weight — no Tailwind namespace fits
  const scopes = v.scopes || [];
  const narrowed = scopes.length && !scopes.every((s) => s === "ALL_SCOPES");
  if (narrowed && scopes.some((x) => RADIUS_SCOPES.has(x))) return "radius";
  if (narrowed && scopes.includes("FONT_SIZE")) return "fontSize";
  if (!narrowed && /radius|corner|rounded/i.test(v.name)) return "radius";
  if (!narrowed && /font.?size|text.?size|type.?size/i.test(String(v.collection) + "/" + v.name)) return "fontSize";
  return "dimension";
}

// → { text, utilities, tokens, warnings[] }. `warnings` carries the name collisions (the slug folds
// case and punctuation, so `Space 3` and `(Space 3)` land on one Tailwind name even though tokens.css
// kept them apart) unless the internal `notes` array is passed, as emitTokens does.
function toTailwind(designSystem, opts, notes) {
  const collections = (designSystem && designSystem.collections) || [];
  const vars = (designSystem && designSystem.variables) || [];
  const plan = planIds(vars, (v) => (segs(v.name).length ? twName(v, opts) : null), (id, s) => id + "-" + s, collections, "theme.css",
    (v) => /^[A-Za-z0-9-]+$/.test(segs(v.name).join("-")));
  const warnings = [];
  if (notes) notes.push(...plan.notes);
  else warnings.push(...collisionMessages(plan.notes, opts));
  const theme = new Map();
  const perMode = Object.create(null);
  let utilities = 0;
  for (const v of vars) {
    if (!segs(v.name).length) continue;
    if (!plan.canonical.has(v)) continue;
    const def = defaultModeName(v, collections);
    const base = baseValue(v, collections, def);
    if (base === undefined) continue;
    const name = plan.id(v);
    if (twKind(v, opts)) utilities++;
    const unit = numberUnit(v, opts);
    // An alias must point at the TAILWIND name of its target (its own namespace, its own
    // disambiguated name), not the tokens.css one.
    const ref = (n) => { const t = aliasTarget(plan, n, v); return t ? plan.id(t) : "--" + TW_PREFIX + twSlug(n); };
    const val = (raw) => cssValue(webNumber(v, raw), unit, ref);
    const baseStr = JSON.stringify(base);
    theme.set(name, `  ${name}: ${val(base)};`);
    const values = v.values || {};
    for (const m of Object.keys(values)) {
      if (m === def || values[m] === undefined) continue;
      if (JSON.stringify(values[m]) === baseStr) continue;
      (perMode[m] || (perMode[m] = new Map())).set(name, `  ${name}: ${val(values[m])};`);
    }
  }
  let out = '@import "tailwindcss";\n' +
    "/* GENERATED by Design Twin (tokens.js --web tailwind) — do not edit by hand; re-run after a token pull.\n" +
    "   Every design-system variable sits under a `figma-` name (rounded-figma-xl, p-figma-space-4, bg-figma-…),\n" +
    "   so Tailwind's own scale (rounded-xl, p-4, …) keeps its framework meaning. */\n";
  if (theme.size) out += "\n@theme {\n" + [...theme.values()].join("\n") + "\n}\n";
  for (const m of Object.keys(perMode)) out += `\n[data-theme="${cssAttrEscape(m)}"] {\n` + [...perMode[m].values()].join("\n") + "\n}\n";
  return { text: out, utilities, tokens: theme.size, warnings };
}

// --- DTCG Resolver Module (2025.10) -------------------------------------------------------------
// The spec (designtokens.org/tr/2025.10/resolver/) in the sentences this mapping rests on:
//   · "The document MUST provide a version at the root level, and it MUST be `2025.10`."
//   · `resolutionOrder` is the other REQUIRED root key; `name`/`description`/`sets`/`modifiers`/
//     `$schema` are all optional ("MAY").
//   · "A set MUST contain a `sources` array with tokens declared directly, or a reference object
//     pointing to a JSON file containing design tokens, or any combination of the two." Sources merge
//     in array order, last occurrence wins.
//   · "A modifier MUST declare a `contexts` map of a `string` value to an array of token sources." It
//     "SHOULD have two or more contexts, since one is the equivalent of a set" and "MUST NOT have an
//     empty contexts map". Contexts MAY be empty ARRAYS (the spec's own `"false": []` example).
//   · "A modifier MAY declare a `default` value that MUST match one of the keys in `contexts`."
//   · resolutionOrder: "The order is significant, with tokens later in the array overriding any
//     tokens that came before them, in case of conflict."
//   · A reference object is `{ "$ref": <RFC6901 JSON pointer / relative URI> }`; only resolutionOrder
//     may reference a modifier, and sets/modifiers MUST NOT reference another modifier.
//   · "Users SHOULD use the '.resolver.json' file extension to name resolver documents."
//
// The Figma mapping, chosen to be the most conservative reading of the above:
//   collection            -> one SET holding that collection's DEFAULT-mode values (a file $ref).
//   collection with >1 mode -> additionally one MODIFIER named after the collection, whose contexts
//                           are its mode names and whose `default` is the collection's default mode.
//                           A context's file carries ONLY the tokens whose value differs from the
//                           default mode (exactly toCSS's dedup, JSON-equality against the EMITTED
//                           base) — so resolution = base set then context override, which is what
//                           "later in the array overrides" gives us. The default mode therefore
//                           differs in nothing and gets the empty array, no file.
//   single-mode collection -> set only, no modifier (the spec says one context "is the equivalent of
//                           a set", and tools SHOULD error on a 1-context modifier).
//   resolutionOrder       -> every set, then every modifier. Sets are unconditional foundations;
//                           modifiers must be able to override them.
// Nothing here resolves aliases: "Aliases MUST NOT be resolved until this step" (after ordering), so
// `{a.b}` references are passed through verbatim, same as toDTCG.
const RESOLVER_VERSION = "2025.10";
const RESOLVER_SCHEMA = "https://www.designtokens.org/schemas/2025.10/resolver.json";
const RESOLVER_DIR = "tokens"; // set files live in <outDir>/tokens/, the resolver doc in <outDir>/

// RFC6901: `~` and `/` are the two characters a JSON pointer token must escape. Collection names are
// designer-supplied and routinely contain `/`, which would otherwise silently re-point the reference
// at a nested key that does not exist.
const ptrEsc = (s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1");

// File names come from DESIGNER-supplied collection/mode names, which may contain anything: spaces,
// `/`, `..`, emoji, leading dots. Fold to [a-z0-9._-] so a name can never escape <outDir>/tokens/ nor
// hide a file from a shell. Lowercased deliberately: "Light" and "light" are two names but ONE file on
// a case-insensitive filesystem (macOS APFS default), so folding case makes that collision visible to
// the collision check below instead of letting one mode silently overwrite the other.
function fileSlug(s, fallback) {
  const out = String(s == null ? "" : s).trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  return out || fallback;
}

function toResolver(designSystem, warnings, opts) {
  // Dedupe against warnings ALREADY collected (emitTokens shares one array with toDTCG): every token
  // problem toDTCG reports is re-derived here, once per set the token appears in. Reporting the same
  // sentence three times is noise, not evidence — but a NEW problem (a filename collision) still gets
  // through, so the never-silent guarantee holds.
  const seen = new Set(warnings || []);
  const warn = (m) => { if (warnings && !seen.has(m)) { seen.add(m); warnings.push(m); } };

  const ds = designSystem || {};
  const collections = ds.collections || [];
  const vars = ds.variables || [];

  // Group variables by collection NAME — that is what Variable.collection carries. A Map, not an
  // object: the keys are designer strings (`__proto__` is a legal collection name).
  const groups = new Map();
  for (const v of vars) {
    const key = String((v && v.collection) || "");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  const declared = new Map();
  for (const c of collections) if (c && c.name != null && !declared.has(String(c.name))) declared.set(String(c.name), c);
  // ONE plan over every variable: resolver sets are merged into one token namespace, so a set file
  // must use exactly the (disambiguated) paths tokens.dtcg.json uses. Its notes are toDTCG's to report.
  const plan = dtcgPlan(ds);

  // Reserve every emitted path case-insensitively; a sanitized name that lands on a taken path is
  // disambiguated with -2/-3 and REPORTED, never silently overwritten.
  const takenFiles = new Map();
  function reserveFile(base, ext, owner) {
    let candidate = `${RESOLVER_DIR}/${base}${ext}`, n = 1;
    while (takenFiles.has(candidate.toLowerCase())) {
      n += 1;
      const next = `${RESOLVER_DIR}/${base}-${n}${ext}`;
      warn(`resolver file '${candidate}' for ${owner} collides with ${takenFiles.get(candidate.toLowerCase())} after sanitizing the name — wrote '${next}' instead`);
      candidate = next;
    }
    takenFiles.set(candidate.toLowerCase(), owner);
    return candidate;
  }
  // Same rule for the `sets`/`modifiers` map keys, which are JSON-pointer targets: a duplicate key
  // would drop a whole set. The two namespaces are SEPARATE — per the spec's own editorial note, "it
  // is valid for a set to share a name with a modifier"; only duplicates inside one map (or inside
  // resolutionOrder, which we never write inline) are invalid.
  const takenKeys = { set: new Set(), modifier: new Set() };
  function reserveKey(name, kind) {
    let candidate = name, n = 1;
    while (takenKeys[kind].has(candidate)) { n += 1; const next = `${name} ${n}`; warn(`resolver ${kind} name '${candidate}' is already used — renamed to '${next}'`); candidate = next; }
    takenKeys[kind].add(candidate);
    return candidate;
  }

  // Null-prototype: keyed by COLLECTION NAMES / MODE NAMES, free-form designer strings arriving via
  // JSON.parse — which creates a real own "__proto__" key that a plain object would turn into a
  // prototype write (the mode silently vanishes). Same hardening as toDTCG/toCSS.
  const sets = Object.create(null);
  const modifiers = Object.create(null);
  const files = Object.create(null);
  const resolutionOrder = [];
  const modifierRefs = [];

  for (const [collName, groupVars] of groups) {
    const c = declared.get(collName);
    const label = collName || "tokens"; // variables with no collection still need a set name
    const sub = { colorProfile: ds.colorProfile, collections, variables: groupVars };

    // Base set: the SAME values toDTCG puts in $value (baseValue), so the two outputs agree by
    // construction rather than by two parallel implementations.
    const base = buildTree(sub, warn, opts, (v) => baseValue(v, collections), false, plan);
    if (!Object.keys(base).length) continue; // every token in the collection was skipped + reported

    const setName = reserveKey(label, "set");
    const setFile = reserveFile(fileSlug(label, "tokens"), ".json", `set '${label}'`);
    files[setFile] = base;
    sets[setName] = { description: `${label} (default mode values)`, sources: [{ $ref: setFile }], $extensions: { "figma.com": { collection: collName || null } } };
    resolutionOrder.push({ $ref: `#/sets/${ptrEsc(setName)}` });

    // Modes: the collection's declaration, plus any mode that only shows up in a variable's values
    // (the declaration can lag a per-variable dump). Union, so no mode is lost.
    const modes = [];
    for (const m of (c && c.modes) || []) if (!modes.includes(m)) modes.push(m);
    for (const v of groupVars) for (const m of Object.keys((v && v.values) || {})) if (!modes.includes(m)) modes.push(m);
    if (modes.length < 2) continue; // one context "is the equivalent of a set" — emit no modifier

    const contexts = Object.create(null);
    let nonEmpty = 0;
    for (const m of modes) {
      // Per-VARIABLE default mode + dedup, mirroring toCSS exactly: compare against the value actually
      // emitted into the base set (baseValue), not against collection.default, so a variable missing
      // the collection's default mode still dedupes against what it really shipped.
      const tree = buildTree(sub, warn, opts, (v) => {
        const values = (v && v.values) || {};
        const def = defaultModeName(v, collections);
        if (m === def || values[m] === undefined) return SKIP;
        const bv = baseValue(v, collections, def);
        return JSON.stringify(values[m]) === JSON.stringify(bv) ? SKIP : values[m];
      }, false, plan);
      if (!Object.keys(tree).length) { contexts[m] = []; continue; } // spec allows an empty context array
      const file = reserveFile(`${fileSlug(label, "tokens")}.${fileSlug(m, "mode")}`, ".json", `collection '${label}' mode '${m}'`);
      files[file] = tree;
      contexts[m] = [{ $ref: file }];
      nonEmpty += 1;
    }
    if (!nonEmpty) continue; // every mode was identical to the default — a modifier would resolve to nothing

    const modName = reserveKey(label, "modifier");
    const def = c && c.default != null && modes.includes(c.default) ? c.default : modes[0];
    modifiers[modName] = { description: `${label} mode`, contexts, default: def, $extensions: { "figma.com": { collection: collName || null, defaultMode: def } } };
    modifierRefs.push({ $ref: `#/modifiers/${ptrEsc(modName)}` });
  }

  // Modifiers last: they exist to override the unconditional sets, and "tokens later in the array
  // override any tokens that came before them".
  for (const r of modifierRefs) resolutionOrder.push(r);

  const resolver = { $schema: RESOLVER_SCHEMA };
  if (ds.file) resolver.name = String(ds.file); // optional, but the filename alone rarely says which Figma file
  resolver.version = RESOLVER_VERSION; // REQUIRED, MUST be "2025.10"
  resolver.sets = sets;
  if (Object.keys(modifiers).length) resolver.modifiers = modifiers; // omitted rather than empty: nothing to condition on
  resolver.resolutionOrder = resolutionOrder; // REQUIRED
  return { resolver, files };
}

// Never-silent guarantee: every problem the emitters guard against is also reported here so a caller
// can surface it (mirrors the extractor's manifest.warnings discipline).
// `opts` is the SAME object you pass to toCSS. It has to be, because the name-heuristic warning below
// only makes sense for tokens the heuristic actually decided — and `opts.unitless` pre-empts it in
// numberUnit. Linting with different opts than you emitted with reports guesses that were never made.
// Same two warning sources emitTokens uses (toDTCG + lintNames) — toCSS contributes none, so a
// lint-only caller must not pay for building and discarding the whole stylesheet.
function lintTokens(designSystem, opts) {
  const warnings = [];
  const notes = [];
  toDTCG(designSystem, warnings, opts, notes);
  notes.push(...cssPlan(designSystem).notes);
  warnings.push(...collisionMessages(notes, opts));
  lintNames(designSystem, opts, warnings);
  return dedupe(warnings);
}
const dedupe = (list) => [...new Set(list)];

// The half of the lint that does NOT come from toDTCG. Split out so emitTokens can lint off the
// warnings toDTCG already collected instead of building the whole DTCG tree a second time.
function lintNames(designSystem, opts, warnings) {
  const vars = (designSystem && designSystem.variables) || [];
  // Dangling aliases: an aliasOf whose target isn't a defined token.
  const names = new Set(vars.map((v) => segs(v.name).join(".")).filter(Boolean));
  for (const v of vars) for (const m of Object.keys(v.values || {})) {
    const val = v.values[m];
    if (isAlias(val) && !names.has(segs(val.aliasOf).join("."))) warnings.push(`token '${v.name}' (mode ${m}) references undefined token '${val.aliasOf}'`);
  }
  // STRING tokens carrying CSS-structural characters are emitted escaped (see cssEscapeText) — report
  // so the author knows the value was rewritten rather than passed through verbatim. cssNeedsEscape
  // runs the escaper itself, so terminators, comment delimiters and unbalanced parens/quotes are ALL
  // reported by construction — the detector cannot be narrower than the rewrite.
  for (const v of vars) {
    if (v.type !== "STRING") continue;
    for (const m of Object.keys(v.values || {})) {
      if (cssNeedsEscape(v.values[m])) { warnings.push(`token '${v.name}' (mode ${m}) contains CSS-structural characters; escaped for safety in tokens.css`); break; }
    }
  }
  // Mode names that had to be escaped to stay inside their `[data-theme="…"]` selector. Same
  // never-silent rule as the value escaper: if we rewrote it, say so. Collected from both the
  // collection declarations and the per-variable value maps, since either can name a mode.
  const modeNames = new Set();
  for (const c of (designSystem && designSystem.collections) || []) for (const m of c.modes || []) modeNames.add(m);
  for (const v of vars) for (const m of Object.keys(v.values || {})) modeNames.add(m);
  for (const m of modeNames) {
    if (cssAttrNeedsEscape(m)) warnings.push(`mode '${m}' contains a quote or backslash; escaped in its tokens.css selector`);
  }

  // One pass per variable for the three name-derived checks below; `segs`/`cssVarName` are split +
  // regex chains, so computing each once per token keeps the lint linear in the token count.
  //  - Character folding (e.g. "(Space 3)" -> "---Space-3-"): same never-silent rule as the value/mode
  //    escapers. The "expected" form is built from segs() and compared to cssVarName()'s own output, so
  //    the detector is derived from the rewriter rather than being a twin that can drift out of sync.
  //  - FLOATs left unitless because their NAME looked like an opacity/font-weight, with no scope to
  //    confirm it. That is a guess — a defensible one, and better than emitting `opacity: 0.5px`, but it
  //    is still this file rewriting output off a pattern match, and every other such rewrite announces
  //    itself. Say which tokens it touched so a wrong guess is visible; the fix is to narrow the
  //    variable's scopes in Figma (or pass opts.unitless).
  //  - CSS var-name collisions are NOT here any more: they are planned (and reported, naming every
  //    key) by planIds, the same function that decides the emitted names — see cssPlan.
  for (const v of vars) {
    if (v.type === "FLOAT" && unitDecision(v, opts) === "name") {
      warnings.push(`token '${v.name}' has no narrowed scopes (Figma's ALL_SCOPES default); emitted UNITLESS because its name reads as an opacity/font-weight — scope it in Figma to make this explicit`);
    }
    const s = segs(v.name);
    if (!s.length) continue;
    const folded = cssVarName(v.name);
    if (folded !== "--" + s.join("-")) {
      warnings.push(`token '${v.name}' contains characters that are illegal in a CSS custom property; emitted as ${folded}`);
    }
  }
  return warnings;
}

// Both emitters + the lint under ONE opts object and ONE pass over the design system. lintTokens has
// to be called with the same opts as toCSS (it reports guesses the emitter actually made); making
// that one call removes the coupling from the caller instead of documenting it.
// opts.tailwind: also build theme.css in the same pass, so its name collisions are reported in the
// SAME message as tokens.dtcg.json's and tokens.css's. opts.sources: Map(key -> [screen]) so a
// collision warning can say which screen each colliding variable came from.
function emitTokens(designSystem, opts) {
  const warnings = [];
  const notes = [];
  const dtcg = toDTCG(designSystem, warnings, opts, notes);
  const css = toCSS(designSystem, opts, notes);
  const tailwind = opts && opts.tailwind ? toTailwind(designSystem, opts, notes) : undefined;
  // Additive: the resolver is a SECOND view of the same variables (per-mode files instead of
  // $extensions), not a replacement — toDTCG's output is unchanged. It runs after toDTCG so its
  // warning dedupe sees the messages toDTCG already recorded.
  const { resolver, files } = toResolver(designSystem, warnings, opts);
  const collisions = collisionMessages(notes, opts);
  lintNames(designSystem, opts, warnings);
  return { dtcg, css, tailwind, resolver, resolverFiles: files, warnings: dedupe(collisions.concat(warnings)), collisions };
}

module.exports = { toDTCG, toCSS, toResolver, toTailwind, lintTokens, emitTokens, hexToColorValue, cssVarName, TW_PREFIX, WEB_FULL_ROUND };
// tokens-native.js must agree with this file on names, default modes, aliases and units, so it is
// built FROM these helpers (see the note at its top on why it does not require this file back).
Object.assign(module.exports, require("./tokens-native.js")({ segs, isAlias, normHex, defaultModeName, baseValue, unitDecision, isSentinel }));

// CLI: node design-to-code/tokens.js <design-system/tokens.json> [outDir] [--native <platform>] [--package <kotlin.package>]
// --native swiftui | compose | flutter | react-native (a build-screen profile name works too) also
// writes ONE native token file next to the others — move it into the app's source tree and import it
// from every screen (see tokens-native.js for why and for the shape of each file).
// The input is the SPLIT token file — design-system.json is a slim pointer manifest since the split
// and has no `variables` array (see bridge/design-system-layout.js).
if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const { assertNotManifest, readJsonFile, NO_DESIGN_SYSTEM_HINT } = require("./catalog-input.js");
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v === undefined ? "" : v; };
  const native = flag("--native");
  const web = flag("--web");
  const kotlinPackage = flag("--package");
  const input = args[0];
  const outDir = args[1] || ".";
  const USAGE = "usage: node design-to-code/tokens.js <design-system/tokens.json | design/variables.json> [outDir]\n" +
    "       [--native swiftui|compose|flutter|react-native] [--package <kotlin.package>] [--web tailwind]";
  if (args.includes("--help") || args.includes("-h")) { console.log(USAGE); process.exit(0); }
  const stray = args.filter((a) => a.startsWith("-"));
  if (stray.length) { console.error(`tokens: unknown flag ${stray.join(", ")}\n${USAGE}`); process.exit(1); }
  if (!input) { console.error(USAGE); process.exit(1); }
  const { toNative, platformOf } = module.exports;
  if (native !== undefined && !platformOf(native)) { console.error(`--native: unknown platform "${native}"\n${USAGE}`); process.exit(1); }
  const WEB_TARGETS = { tailwind: "theme.css", "web-tailwind": "theme.css" }; // build-screen's profile name works too
  if (web !== undefined && !WEB_TARGETS[web]) { console.error(`--web: unknown target "${web}" (known: tailwind)\n${USAGE}`); process.exit(1); }
  const ds = readJsonFile(input, "token catalog", NO_DESIGN_SYSTEM_HINT + "\n       A single-screen pull DOES write design/variables.json — pass that instead.");
  assertNotManifest(ds, input, "variables", "design-system/tokens.json");
  fs.mkdirSync(outDir, { recursive: true }); // documented usage is `… ./out`; don't die on a raw ENOENT
  // one pass: emit + lint share the same opts and traversal, and a name collision is reported once
  // across every output it touches, naming the screen(s) each colliding variable came from.
  const { dtcg, css, tailwind, resolver, resolverFiles, warnings } = emitTokens(ds, { tailwind: web !== undefined, sources: require("./slice-sources.js").sourcesOf(ds, input, fs, path) });
  fs.writeFileSync(path.join(outDir, "tokens.dtcg.json"), JSON.stringify(dtcg, null, 2));
  fs.writeFileSync(path.join(outDir, "tokens.css"), css);
  // Resolver document + the set files it $refs. The refs are relative to the resolver document, and
  // the keys of resolverFiles ARE those refs — so join each key onto outDir and the links hold.
  // Every key is a fileSlug()ed, collision-checked "tokens/<name>.json"; split on "/" rather than
  // passing the key straight to path.join so the layout is identical on Windows.
  fs.writeFileSync(path.join(outDir, "tokens.resolver.json"), JSON.stringify(resolver, null, 2));
  for (const rel of Object.keys(resolverFiles)) {
    const dest = path.join(outDir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(resolverFiles[rel], null, 2));
  }
  let nativeNote = "";
  if (web !== undefined) {
    const tw = tailwind;
    const file = WEB_TARGETS[web];
    fs.writeFileSync(path.join(outDir, file), tw.text);
    nativeNote += ` + ${file}`;
    if (tw.tokens && !tw.utilities) warnings.push(`--web ${web}: no variable mapped to a Tailwind namespace, so ${file} generates no utilities — every token is a plain custom property you must reference with var()`);
    else if (tw.tokens > tw.utilities) warnings.push(`--web ${web}: ${tw.tokens - tw.utilities} of ${tw.tokens} token(s) match no Tailwind namespace (unitless FLOATs like opacity/font-weight, non-font strings) — emitted as plain --figma-* properties, usable via var() but generating no utility`);
  }
  if (native !== undefined) {
    const n = toNative(ds, native, { package: kotlinPackage || undefined });
    fs.writeFileSync(path.join(outDir, n.file), n.text);
    warnings.push(...n.warnings);
    nativeNote = ` + ${n.file}`;
  }
  warnings.forEach((w) => console.error("warn  " + w));
  console.log(`wrote tokens.dtcg.json + tokens.css + tokens.resolver.json (+${Object.keys(resolverFiles).length} set files under ${RESOLVER_DIR}/)${nativeNote} (${(ds.variables || []).length} variables)`);
}
