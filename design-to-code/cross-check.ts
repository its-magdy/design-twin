// cross-check.ts — does the screen you are about to build actually come from the design system you
// exported?
//
// Every other check in this repo reasons INSIDE one file. audit.ts walks one screen's own JSON;
// drift-lint.ts compares a map against the catalog it was bootstrapped from. Both can return a clean
// green while the screen and the design system are two unrelated Figma files — which is exactly what
// happened on the live run that produced this module:
//
//   * 0 of 65 instance keys on the screen matched any of the 318 components in the catalog, and
//     drift-lint still printed "318/318 components mapped · 0 error(s)" because its coverage metric
//     measures the catalog against itself and never against the screen.
//   * every collection key differed between the screen's variables and the design system's
//     (Semantic Variables 02 was ebac83f1… in one and 64113d4c… in the other) — the design file had
//     been DUPLICATED, which re-keys everything while leaving names and values identical.
//   * two names collided across the two libraries with DIFFERENT values: `(Space 3)` = 12 on the
//     screen vs `Space 3` = 16 in the design system; `light blue` = #1289db vs #94e2ff. A builder who
//     slugs the name and reaches for the existing token silently gets the wrong number.
//
// None of that is visible from either file alone. It is only visible from the JOIN, which is what
// this module is. It reports; it never rewrites anyone's data.
//
// Inputs are the shapes the plugin already writes, read as-is:
//   screens      [{ doc: design/<Screen>.json, label }]
//   variables    design/variables.json            — the tokens the SCREENS bind (their library)
//   tokens       design/design-system/tokens.json — the tokens the DESIGN SYSTEM defines
//   components   design/design-system/components.local.json   (+ .library.json, optional)
//   stylesText   design/design-system/styles.text.json        (optional)
// Every input is optional: with only screens it still reports the within-screen absurdities (a radius
// of a billion, font strays), and says plainly which cross-file checks it could not run.

import fs from "node:fs";
import path from "node:path";
import { visibleInstances, matchByNameAndSignature, nameVerdict, isRekeyed } from "./component-match.ts";
import { findingIds } from "./finding-id.ts";
import { isCodeConnectMap } from "./map-validate.ts";
import { readJson, readJsonOrNull } from "./read-json.ts";
import { isPageIndex, isPagesRootIndex } from "./doc-guards.ts";
// hidden.ts's one predicate: `hidden: true` on the node or an ancestor. Both walks below return at a
// hidden node, so its whole subtree is skipped — ancestry is carried by not descending.
import { hiddenSelf } from "./hidden.ts";
import { parseHex, contrastRatio, composeAlpha, compositeOver } from "./color.ts";
import type { Rgba } from "./color.ts";
import { readDocFile } from "./catalog-input.ts";
import { readDesignSystemDir } from "./design-system-dir.ts";
import { cliParse, scriptCmd } from "./cli-args.ts";
import { parseArgs } from "node:util";
import { variablesContext } from "./slice-sources.ts";
import type { SliceSources } from "./slice-sources.ts";
import { isScreenDoc, screenExportOf, screenRoots } from "./export-shape.ts";
import type {
  CatalogComponent, CodeConnectMap, ComponentProposal, ComponentsCatalog, ContrastFailure, CoverageBucket, FindingExtras, CrossCheckCoverage, CrossCheckFinding, CrossCheckFindingCode, CrossCheckReport,
  BlockerCode, IndexRow, IrNode, MatchResult, MatchRow, ScreenDoc, Severity, TextStyle, TextStylesDoc, TokensDoc, Variable, VariableCollection, VariableValue,
} from "./types.ts";
import { ifDefined } from "../bridge/src/json-util.ts";
import { getOrInit } from "./map-util.ts";
import { isMainFallback } from "../bridge/src/is-main.ts"; // import.meta.main is undefined before Node 24.2

const SEVERITY_ORDER: Record<Severity, number> = { blocker: 0, warning: 1, info: 2 };

// Figma's "fully rounded" idiom exports as a literal 1e9 (live finding 30). Anything at or past this
// is not a designed number, it is a sentinel, and it must never reach generated CSS as `1000000000px`.
const ABSURD_NUMBER = 10000;

// A component-key overlap at or below this is not "partial coverage", it is the wrong catalog.
const WRONG_CATALOG_PCT = 5;

/** One screen handed to crossCheck(): its export, the label findings cite, and its own <Screen>.vars.json slice. */
export interface CrossCheckScreen { doc: ScreenDoc | null | undefined; label: string; vars?: TokensDoc | null }
/** crossCheck()'s input bag — every file optional; `notChecked` says which checks that cost. */
export interface CrossCheckInput {
  screens?: CrossCheckScreen[];
  variables?: TokensDoc | null;
  /** only for the "no collections" note's wording */
  variablesPath?: string | null;
  sliceSources?: SliceSources | null;
  tokens?: TokensDoc | null;
  components?: ComponentsCatalog | null;
  componentsLibrary?: ComponentsCatalog | null;
  stylesText?: TextStylesDoc | null;
  /** the component catalog's file as findings should name it (default "components.local.json"; a
   *  --as-library export's is "components.json") */
  componentsFile?: string;
  /** the design-system dir given IS a --as-library export — changes the "export the library" advice */
  designSystemIsLibrary?: boolean;
  /** F-47: the project's component map (codeconnect.local.json) — a proposal it already covers is labelled
   *  `alreadyMapped` and listed last; nothing else changes */
  map?: CodeConnectMap | null;
  /** F-47: the OTHER exported screens (exportSiblings), called only when there are proposals — each
   *  proposal's `sharedWith` counts the ones using the same component; null/absent = unknown (no field) */
  siblings?: (() => CrossCheckScreen[]) | null;
}

// D1: "blocker" only with a BlockerCode — any other blocker is a compile error.
interface Push {
  (severity: "blocker", code: BlockerCode & CrossCheckFindingCode, message: string, extra?: FindingExtras): void;
  (severity: "warning" | "info", code: CrossCheckFindingCode, message: string, extra?: FindingExtras): void;
}

// Visible layers only: a token bound on a layer the designer switched off is not built, so it is not
// a token the build has to resolve (livetest-3 P2a — the same rule as audit.ts and verify-screen.ts).
function walk(node: IrNode | null | undefined, fn: (n: IrNode) => void): void {
  if (!node || typeof node !== "object") return;
  if (hiddenSelf(node)) return;
  fn(node);
  for (const c of node.children || []) walk(c, fn);
}


// Names are compared case- and punctuation-insensitively ONLY to find near-misses worth reporting.
// Nothing is ever auto-bound on a normalised name — `Medium/14 Medium` vs `Medium/14 medium`
// (live finding 38) is precisely the near-miss a name-based mapper gets wrong silently, so it is
// surfaced as a question rather than resolved.
const norm = (s: unknown): string => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

interface UsedAt { screen: string; nodeId: string; field: string }
interface ScreenInstance { screen: string; nodeId: string; name: string; key?: string; setKey?: string; setName: string; propNames: string[] }
interface Collision {
  name: string; key?: string; twins: Variable[]; sv: Variable; alsoKnownAs?: string;
  screen: Record<string, string>; designSystem: Record<string, string>; usedAt: UsedAt[];
}

function crossCheck(input: CrossCheckInput): CrossCheckReport {
  const screens = input.screens || [];
  const variables = input.variables || null;
  const tokens = input.tokens || null;
  const components = input.components || null;
  const componentsLibrary = input.componentsLibrary || null;
  const stylesText = input.stylesText || null;
  const catFile = input.componentsFile || "components.local.json";
  // F-19: the remediation hints named only the CLI. Listing libraries has an MCP twin; exporting a
  // library does not (the MCP export tool's own description points at the CLI's --as-library).
  const LIST_LIBRARIES = "`dtwin list libraries --client <the screen's file>` (MCP: `figma_list_libraries`)";
  const EXPORT_LIBRARY = input.designSystemIsLibrary
    ? "check that the library export you passed is the one the screen consumes (a DUPLICATED library file re-keys everything — re-export the original with `dtwin pull --as-library \"<name>\"`, CLI only)"
    : "export it with `dtwin pull --as-library \"<name>\"` (CLI only — the MCP server has no library export)";

  const findings: CrossCheckFinding[] = [];
  const notChecked: string[] = [];
  const push: Push = (severity: Severity, code: CrossCheckFindingCode, message: string, extra?: FindingExtras): void => { findings.push(Object.assign({ severity, code, message }, extra || {})); };

  // ---------------------------------------------------------------- what the screens actually use
  const usedTokenNames = new Map<string, UsedAt[]>(); // name -> [{screen, nodeId, field}]
  const instances: ScreenInstance[] = []; // { screen, nodeId, name, key, setKey, setName, propNames }
  const fonts = new Map<string, number>(); // family -> count
  const textStyles = new Map<string, number>(); // style name -> count
  const resolvedModes = new Map<string, Set<string>>(); // collection name -> Set(mode)

  for (const s of screens) {
    const label = s.label || screenExportOf(s.doc)?.screen || "screen";
    for (const root of screenRoots(s.doc)) {
      if (root && root.resolvedModes) {
        for (const [coll, mode] of Object.entries(root.resolvedModes)) {
          getOrInit(resolvedModes, coll, () => new Set<string>()).add(mode);
        }
      }
      walk(root, (n) => {
        for (const [field, name] of Object.entries(n.tokens || {})) {
          if (typeof name !== "string") continue;
          getOrInit(usedTokenNames, name, () => []).push({ screen: label, nodeId: n.id, field });
        }
        for (const f of n.fills || []) {
          const t = f && f.tokens && f.tokens.color;
          if (typeof t === "string") {
            getOrInit(usedTokenNames, t, () => []).push({ screen: label, nodeId: n.id, field: "fills" });
          }
        }
        if (n.font && n.font.family) fonts.set(n.font.family, (fonts.get(n.font.family) || 0) + 1);
        const ts = n.styles && n.styles.text;
        if (ts) textStyles.set(ts, (textStyles.get(ts) || 0) + 1);
      });
    }
  }

  // Component instances: VISIBLE ones only. A hidden layer is not built, so it is not a component the
  // build has to map either — counting them put 112 instances / 61 components on a screen that renders
  // 51 / 41 (livetest-3), and skewed every percentage below.
  const visible: ReturnType<typeof visibleInstances> = [];
  screens.forEach((s) => {
    const label = s.label || screenExportOf(s.doc)?.screen || "screen";
    for (const i of visibleInstances(s.doc, label)) {
      visible.push(i);
      instances.push({ screen: label, nodeId: i.nodeId, name: i.layer, ...ifDefined("key", i.key), ...ifDefined("setKey", i.setKey), setName: i.name, propNames: Object.keys(i.props || {}) });
    }
  });

  // ---------------------------------------------------------------- (a) collections from elsewhere
  const dsCollByKey = new Map<string, VariableCollection>();
  const dsCollByName = new Map<string, VariableCollection>();
  for (const c of (tokens && tokens.collections) || []) {
    if (c.key) dsCollByKey.set(c.key, c);
    if (c.name) dsCollByName.set(norm(c.name), c);
  }
  const screenColls = (variables && variables.collections) || [];

  if (!tokens) {
    notChecked.push(
      "collection provenance — no design-system tokens.json was given, so nothing could verify that the screen's " +
        "variables come from the design system you exported. Run `dtwin pull --design-system` and pass it."
    );
  } else if (!screenColls.length) {
    notChecked.push(
      (input.variablesPath
        ? `collection provenance — ${input.variablesPath} was checked but carries no collections for this screen, so its own token library is unknown.`
        : `collection provenance — no variables.json was found (looked in design/export/variables.json), so the screen's own token library is unknown.`)
    );
  } else {
    const foreign: Array<{ name: string; key?: string; twinKey?: string; twinName?: string }> = [];
    for (const c of screenColls) {
      if (c.key && dsCollByKey.has(c.key)) continue;
      const twin = dsCollByName.get(norm(c.name));
      foreign.push({ name: c.name, ...ifDefined("key", c.key), ...ifDefined("twinKey", twin && twin.key), ...ifDefined("twinName", twin && twin.name) });
    }
    if (foreign.length) {
      const sameNameDifferentKey = foreign.filter((f) => f.twinKey);
      // D11: a warning to confirm, never a blocker — "you passed the wrong design system" has a default
      // (build from the screen's own .vars.json values) and a question, not a hard stop.
      const all = foreign.length === screenColls.length;
      push(
        "warning",
        "foreign-token-library",
        `${foreign.length} of ${screenColls.length} variable collection(s) the screen binds are NOT in the design-system export — ` +
          `the screen consumes a DIFFERENT library than the one you pulled. ` +
          (sameNameDifferentKey.length
            ? `${sameNameDifferentKey.length} of them carry a design-system collection's name under a different key ` +
              `(${sameNameDifferentKey.slice(0, 3).map((f) => `'${f.name}'`).join(", ")}), which is the signature of a DUPLICATED Figma file: ` +
              `duplicating a library re-keys everything while leaving names and values identical. `
            : "") +
          `Names and values may still line up (check the collisions below), but nothing here is the same variable. ` +
          `To find the real owner: run ${LIST_LIBRARIES} — variable collections are the ONE thing ` +
          `Figma attributes to a library by name — then open that file and ${EXPORT_LIBRARY}.`,
        { collections: foreign, confirm: `${all ? "None" : `Only ${screenColls.length - foreign.length} of ${screenColls.length}`} of the screen's variable collections are in the design system you passed — is it the library this screen uses? Until confirmed, values come from the screen's own .vars.json.` }
      );
    } else {
      push("info", "token-library-matches", `all ${screenColls.length} variable collection(s) the screen binds resolve to the design-system export by key.`, {});
    }
  }

  // ---------------------------------------------------------------- (c) name collisions and gaps
  const dsVarByName = new Map<string, Variable>();
  for (const v of (tokens && tokens.variables) || []) if (v.name) dsVarByName.set(v.name, v);

  // WHICH variables are this screen's. A variable is its Figma key; its name is not unique. The
  // merged variables.json of livetest-3 held two `Space 4` (24 from the design system's library, 16
  // from a screen-local one), and a name-keyed map over the UNION kept the 16 — so every screen was
  // told its `Space 4` collides with the design system's 24, including the two whose own slices carry
  // only the 24 (finding 40/106/137). A builder who believed it would have shipped 16.
  // So the comparison runs on THIS screen's own variables: its <Screen>.vars.json when the caller has
  // it (screens[].vars), else the union's variables whose recorded source includes this screen, else
  // — only when nothing better exists — the union itself, and then the message says so.
  const sliceSources = input.sliceSources || null; // Map(key -> [screen label]) for the union
  const labels = screens.map((s) => s.label || screenExportOf(s.doc)?.screen || "screen");
  const own = screens.map((s) => (s && s.vars && Array.isArray(s.vars.variables) ? s.vars.variables : null));
  let varScope = "own";
  let screenVars: Variable[] = [];
  const none: Variable[] = [];
  if (own.length && own.every((o): o is Variable[] => !!o)) {
    screenVars = none.concat(...own);
  } else if (variables && sliceSources && sliceSources.size) {
    varScope = "union-by-source";
    screenVars = ((variables && variables.variables) || []).filter((v) => {
      const from = v.key ? sliceSources.get(v.key) : undefined; // no key, or a key no slice claims: kept
      return !from || from.some((sc) => labels.includes(sc));
    });
  } else {
    varScope = "union";
    screenVars = (variables && variables.variables) || [];
  }
  const screenVarsByName = new Map<string, [Variable, ...Variable[]]>(); // name -> [variable], distinct by key
  for (const v of screenVars) {
    if (!v || !v.name) continue;
    const list = screenVarsByName.get(v.name);
    if (!list) screenVarsByName.set(v.name, [v]);
    else if (!list.some((x) => (x.key && x.key === v.key) || (!x.key && !v.key && x.collection === v.collection))) list.push(v);
  }
  const screenVarByName = new Map([...screenVarsByName].map(([n, l]): [string, Variable] => [n, l[0]]));
  const shortKey = (v: Variable | null | undefined): string | null => (v && typeof v.key === "string" && v.key ? v.key.slice(0, 8) + "…" : null);
  const fromWhere = (v: Variable): string => {
    const sc = v && v.key && sliceSources && sliceSources.get(v.key);
    return sc && sc.length ? ` (from ${sc.join(", ")})` : "";
  };

  // What a variable resolves to, flattened to a comparable scalar per mode. Aliases compare by their
  // TARGET name: two libraries that both alias `Primary/Primary` -> `Purple Shades/Purple 100` agree,
  // and that is the common, safe case (live finding 68) — it must not be reported as a conflict.
  function flatten(v: Variable | null | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [mode, val] of Object.entries((v && v.values) || {})) {
      // A composed colour ({composed: {color, opacity}}) is shown as its JSON — it has no single alias to follow.
      out[mode] = val && typeof val === "object" ? ("aliasOf" in val ? "-> " + val.aliasOf : JSON.stringify(val)) : String(val);
    }
    return out;
  }
  // Mode NAMES are per-collection and two libraries rarely agree on them: the live case had the screen's
  // Spacing on Desktop/Tablet/Mobile and the design system's on a lone "Mode 1". With no shared mode an
  // early version returned "cannot say" and `(Space 3)`=12 vs `Space 3`=16 went unreported — the single
  // most dangerous collision in the whole run.
  //
  // Aligning on each collection's `default` mode does not work either, because the thing being detected
  // is name collision: that file has TWO collections called `Spacing`, so any map keyed on the collection
  // NAME picks the wrong default. So compare the SET of values instead. Sets that share nothing are a
  // real disagreement whatever the modes are called; sets that overlap at all are not provably wrong, and
  // this reports only what it can prove.
  function valueSet(v: Variable): Set<string> {
    return new Set(Object.values(flatten(v)));
  }
  function sameResolution(a: Variable, b: Variable): boolean | null {
    const fa = flatten(a), fb = flatten(b);
    const shared = Object.keys(fa).filter((m) => m in fb);
    if (shared.length) return shared.every((m) => fa[m] === fb[m]);
    const sa = valueSet(a), sb = valueSet(b);
    if (!sa.size || !sb.size) return null;
    for (const x of sa) if (sb.has(x)) return null; // some overlap — not provably a disagreement
    return false; // disjoint under every mode either side defines
  }

  if (tokens && screenVarByName.size) {
    const collisions: Collision[] = [], missing: Array<{ name: string; near: string | null }> = [];
    for (const [name, list] of screenVarsByName) {
      const dv = dsVarByName.get(name);
      if (!dv) {
        // A near-miss on the name is worth more than a flat "missing": it is where a name-based
        // mapper silently binds to the wrong token.
        let near: string | null = null;
        for (const dname of dsVarByName.keys()) if (norm(dname) === norm(name) && dname !== name) { near = dname; break; }
        if (usedTokenNames.has(name) || near) missing.push({ name, near });
        continue;
      }
      // Every one of THIS screen's variables called `name` is compared on its own — never a
      // last-one-wins pick between them.
      for (const sv of list) {
        if (sameResolution(sv, dv) === false) {
          collisions.push({ name, ...ifDefined("key", sv.key), twins: list, sv, screen: flatten(sv), designSystem: flatten(dv), usedAt: (usedTokenNames.get(name) || []).slice(0, 3) });
        }
      }
    }
    // Names that differ only by punctuation/case ACROSS the two libraries, where the values differ —
    // `(Space 3)`=12 vs `Space 3`=16 is the live case, and it is worse than a missing token because a
    // slugger maps them onto the same CSS custom property.
    const dsByNorm = new Map<string, Array<{ name: string; v: Variable }>>();
    for (const [dname, dv] of dsVarByName) {
      const k = norm(dname);
      getOrInit(dsByNorm, k, () => []).push({ name: dname, v: dv });
    }
    for (const [name, list] of screenVarsByName) {
      if (dsVarByName.has(name)) continue;
      for (const cand of dsByNorm.get(norm(name)) || []) {
        for (const sv of list) {
          if (sameResolution(sv, cand.v) === false) {
            collisions.push({ name, ...ifDefined("key", sv.key), twins: list, sv, alsoKnownAs: cand.name, screen: flatten(sv), designSystem: flatten(cand.v), usedAt: (usedTokenNames.get(name) || []).slice(0, 3) });
          }
        }
      }
    }
    const scopeNote =
      varScope === "own" ? "" :
      varScope === "union-by-source" ? " (read from the merged variables.json, restricted to the variables its slice records for this screen — pass the screen's .vars.json to be exact)" :
      " (read from the MERGED variables.json: this screen's own .vars.json was not available, so this may be another screen's variable — check its key)";
    for (const c of collisions) {
      const twinNote = c.twins.length > 1
        ? ` This screen's own variables include ${c.twins.length} DIFFERENT variables called '${c.name}': ` +
          c.twins.map((t) => `${shortKey(t) ? "key " + shortKey(t) : "'" + (t.collection || "") + "'"} = ${JSON.stringify(flatten(t))}${fromWhere(t)}`).join(" vs ") +
          ` — only the one(s) listed as colliding differ from the design system.`
        : "";
      // D1: a clash blocks only when the screen really USES the token (a visible layer binds it); a clash on
      // a variable the slice merely carries is a warning to confirm.
      const used = c.usedAt.length > 0;
      // Both subjects are named, whether the names are identical or only near-identical (livetest-3 #326).
      const message =
        `The screen's '${c.name}'${shortKey(c.sv) ? ` (key ${shortKey(c.sv)})` : ""} and the design system's '${c.alsoKnownAs || c.name}' ` +
          `${c.alsoKnownAs ? "differ only by case or punctuation" : "share a name"} but resolve DIFFERENTLY: ` +
          `screen ${JSON.stringify(c.screen)} vs design system ${JSON.stringify(c.designSystem)}` +
          (Object.keys(c.screen).some((m) => m in c.designSystem) ? ". " : " — no mode name is shared and the two value sets are disjoint. ") +
          `Slugging the name onto the existing token would silently apply the wrong value — namespace the screen's copy, or confirm which library is authoritative.` +
          twinNote + scopeNote;
      const extra: FindingExtras = { token: c.name, ...ifDefined("key", c.key), ...ifDefined("alsoKnownAs", c.alsoKnownAs), screenValue: c.screen, designSystemValue: c.designSystem, usedAt: c.usedAt, scope: varScope };
      if (used) push("blocker", "token-name-collision", message, extra);
      else push("warning", "token-name-collision", message, { ...extra, confirm: `'${c.name}' has different values here and in the design system, but no visible layer on this screen binds it — which one is authoritative if it is used later?` });
    }
    // The union's own ambiguity, when it is NOT this screen's: said once, as a note naming the other
    // screen, so nobody "fixes" this screen's correct value to match someone else's variable.
    if (variables && varScope !== "union") {
      const mine = new Set(screenVars.map((v) => v.key).filter(Boolean));
      const unionByName = new Map<string, Map<string, Variable>>();
      for (const v of (variables && variables.variables) || []) {
        if (!v || !v.name || !v.key) continue;
        getOrInit(unionByName, v.name, () => new Map<string, Variable>()).set(v.key, v);
      }
      for (const [name, byKey] of unionByName) {
        if (byKey.size < 2) continue;
        const all = [...byKey.values()];
        const others = all.filter((v) => !mine.has(v.key));
        if (!others.length) continue; // the screen carries every one of them — handled above
        // Identical everywhere (`Space 2` = 8 under Desktop/Tablet/Mobile and 8 under Mode 1) is not a
        // collision a builder can get wrong.
        if (new Set(all.flatMap((v) => Object.values(flatten(v)))).size <= 1) continue;
        if (all.every((v) => JSON.stringify(flatten(v)) === JSON.stringify(flatten(all[0])))) continue;
        const ours = all.filter((v) => mine.has(v.key));
        push(
          "info",
          "token-name-collision-elsewhere",
          `'${name}' is ${all.length} different variables in the merged variables.json — ` +
            all.map((v) => `key ${shortKey(v)} = ${JSON.stringify(flatten(v))}${fromWhere(v)}`).join(" vs ") + ". " +
            (ours.length
              // every `v` here was indexed by its (non-empty) key above, so the `v.key &&` never short-circuits
              ? `THIS screen's own variables carry only key ${ours.map(shortKey).join(", ")}, so the ambiguity belongs to ${[...new Set(others.flatMap((v) => (sliceSources && v.key && sliceSources.get(v.key)) || []))].join(", ") || "another screen"} — do not change this screen's value to match it.`
              : `THIS screen carries none of them.`) +
            ` Generate this screen's theme from its own .vars.json (or design-system/tokens.json), not from the union.`,
          { token: name, keys: all.map((v) => v.key), mine: ours.map((v) => v.key) }
        );
      }
    }
    if (missing.length) {
      push(
        "warning",
        "token-absent-from-design-system",
        `${missing.length} token name(s) the screen binds do not exist in the design-system export` +
          (missing.some((m) => m.near)
            ? ` (${missing.filter((m) => m.near).length} differ from a design-system name only by case or punctuation — e.g. ` +
              missing.filter((m) => m.near).slice(0, 2).map((m) => `'${m.name}' vs '${m.near}'`).join(", ") + ")"
            : "") +
          `: ${missing.slice(0, 8).map((m) => "'" + m.name + "'").join(", ")}${missing.length > 8 ? ", …" : ""}. ` +
          `Build these as literals with a recorded decision — do not invent a design-system token for them.`,
        { tokens: missing }
      );
    }
  }

  // Bound names with no definition ANYWHERE (neither library) — the screen references a variable
  // neither export carries, which usually means an opt-in read was skipped or the slice is partial.
  if (variables || varScope === "own") {
    const dangling: string[] = [];
    for (const name of usedTokenNames.keys()) {
      if (screenVarByName.has(name) || dsVarByName.has(name)) continue;
      dangling.push(name);
    }
    if (dangling.length) {
      push(
        "warning",
        "unresolvable-token",
        `${dangling.length} token name(s) are bound by a node but defined in NEITHER design/variables.json nor the design-system export: ` +
          `${dangling.slice(0, 8).map((n) => "'" + n + "'").join(", ")}${dangling.length > 8 ? ", …" : ""}. ` +
          `Re-pull the screen (variables.json now merges, so nothing is lost) or treat the node's raw value as authoritative.`,
        { tokens: dangling }
      );
    }
  }

  // ---------------------------------------------------------------- (b) catalog coverage
  let rekey: MatchResult | null = null;
  let proposals: ComponentProposal[] = [];
  const coverage: CrossCheckCoverage = { instances: instances.length, distinct: 0, matchedByKey: 0, matchedByLocalKey: 0, matchedByName: 0, ambiguousName: 0, unmatched: 0, pct: null, localPct: null, entries: [] };
  // The LOCAL catalog is the one that matters: components.local.json is what map-bootstrap keys
  // codeconnect.local.json on and what build-screen resolves an instance against. components.library.json
  // is the design-system file's own list of components it CONSUMES from elsewhere, so a hit there means
  // "both files use the same third-party icon set", not "this screen is built from your design system".
  // Counted separately for exactly that reason — folding them together turned a 0% local match into a
  // reassuring-looking 13%.
  const localComps = (components && components.components) || [];
  const localKeys = new Set(localComps.map((c) => c.key).filter((k): k is string => !!k));
  const catalog: CatalogComponent[] = localComps.concat((componentsLibrary && componentsLibrary.components) || []);
  if (!catalog.length) {
    notChecked.push(`component coverage — no ${catFile} was given, so every instance counts as new by default.`);
  } else if (!instances.length) {
    notChecked.push("component coverage — the screen export contains no INSTANCE nodes to compare.");
  } else {
    const byKey = new Map<string, CatalogComponent>();
    for (const c of catalog) if (c.key) byKey.set(c.key, c);
    // DT-27: the name stage is component-match's — the SAME rows plan-skeleton reads, judged by the same
    // nameVerdict — so the coverage table and the plan's catalog column cannot disagree on a component.
    // Its catalog is the LOCAL one (components.library.json only explains residuals there), so a name
    // that exists only in the library is no longer a name match here (K-5; a key hit there still counts).
    // Duplicating a Figma file re-mints every component key, so 0% by key is ALSO what a duplicated design
    // system looks like — and there the names AND prop signatures still agree. Its matches are only ever
    // proposals for a person to confirm.
    rekey = localComps.length ? matchByNameAndSignature(visible, components, componentsLibrary) : null;
    const rowByName = new Map<string, MatchRow>((rekey ? rekey.rows : []).map((r): [string, MatchRow] => [r.name, r]));
    // Distinct on the SET key where there is one: a screen using six Button variants is one component
    // to map, not six, and counting variants would flatter the coverage number.
    const distinct = new Map<string, ScreenInstance & { count: number }>();
    for (const i of instances) {
      const id = i.setKey || i.key || "name:" + norm(i.setName);
      getOrInit(distinct, id, () => Object.assign({ count: 0 }, i)).count++;
    }
    coverage.distinct = distinct.size;
    for (const i of distinct.values()) {
      const byKeyHit = (i.setKey && byKey.get(i.setKey)) || (i.key && byKey.get(i.key));
      if (byKeyHit) {
        coverage.matchedByKey++;
        const local = !!byKeyHit.key && localKeys.has(byKeyHit.key);
        if (local) coverage.matchedByLocalKey++;
        coverage.entries.push({ setName: i.setName, ...ifDefined("key", i.setKey || i.key), matchedBy: "key", scope: local ? "local" : "library", verified: true, catalogName: byKeyHit.name, instances: i.count });
        continue;
      }
      // Name fallback. Never authoritative: a name match is a CANDIDATE, carried with `verified: false`
      // so build-screen can say "mapped by name, unverified" instead of either pretending it is a real
      // mapping or throwing away the only lead there is. A match needs the prop SIGNATURE to agree too —
      // that is what separates a real rename from two unrelated components both called `Header` — and a
      // name several entries share is AMBIGUOUS (a coin flip, left unmatched) unless the signature picks
      // one or they are duplicates of one definition (nameVerdict).
      const row = rowByName.get(i.setName);
      const verdict = row ? nameVerdict(row) : null;
      const matched = row && verdict && verdict.status === "matched" ? row.match : null;
      if (row && matched) {
        coverage.matchedByName++;
        // how many of the instance's prop names the matched entry declares (informational)
        const cat = localComps.find((c) => (matched.key ? c.key === matched.key : matched.id !== undefined && c.id === matched.id));
        const props = Object.keys((cat && cat.props) || {}).map((p) => norm(String(p).split("#")[0]));
        const hit = i.propNames.filter((p) => props.includes(norm(String(p).split("#")[0]))).length;
        coverage.entries.push({
          setName: i.setName,
          ...ifDefined("key", i.setKey || i.key),
          matchedBy: "name",
          verified: false,
          catalogName: matched.name,
          ...ifDefined("catalogKey", matched.key),
          ...ifDefined("evidence", row.evidence),
          propOverlap: `${hit}/${i.propNames.length}`,
          instances: i.count,
        });
      } else if (row && verdict && verdict.status === "ambiguous") {
        coverage.ambiguousName++;
        coverage.entries.push({ setName: i.setName, ...ifDefined("key", i.setKey || i.key), matchedBy: null, ambiguous: true, candidates: (row.candidates || []).length, reason: verdict.reason, instances: i.count });
      } else {
        coverage.unmatched++;
        coverage.entries.push({
          setName: i.setName, ...ifDefined("key", i.setKey || i.key), matchedBy: null, verified: false,
          reason: verdict ? verdict.reason : `no ${catFile} to match names against (a components.library.json name alone is not a match)`,
          instances: i.count,
        });
      }
    }
    coverage.pct = Math.round((coverage.matchedByKey / coverage.distinct) * 100);
    coverage.localPct = Math.round((coverage.matchedByLocalKey / coverage.distinct) * 100);

    // Before concluding "wrong catalog": the copy/re-key case (livetest-3 #226) — `rekey` above.
    // the re-key result, only when it says the catalog was re-keyed (null otherwise)
    const rekeyedBy = rekey && coverage.localPct <= WRONG_CATALOG_PCT && isRekeyed(rekey) ? rekey : null;
    const rekeyed = !!rekeyedBy;
    coverage.rekey = rekey ? Object.assign({ rekeyed }, rekey.summary) : null;

    // ONE bucket per distinct visible component (livetest-3 #318: the table's rows summed to 62 on a
    // 41-component screen, because an ambiguous name was counted as "left unmatched" AND as "new work",
    // and names the re-key pass had proposed still sat in the old buckets). Order of precedence: key
    // (local, then library) > confirmed-able proposal > unverified name twin > ambiguous name > new.
    const proposedNames = new Set(rekeyedBy ? rekeyedBy.proposals.map((r) => r.name) : []);
    const buckets: Record<CoverageBucket, number> = { localKey: 0, libraryKey: 0, proposed: 0, nameOnly: 0, ambiguous: 0, newWork: 0 };
    for (const e of coverage.entries) {
      const b: CoverageBucket = e.matchedBy === "key" ? (e.scope === "local" ? "localKey" : "libraryKey")
        : proposedNames.has(e.setName) ? "proposed"
        : e.matchedBy === "name" ? "nameOnly"
        : e.ambiguous ? "ambiguous"
        : "newWork";
      e.bucket = b;
      buckets[b]++;
    }
    coverage.buckets = buckets; // sums to coverage.distinct, by construction
    // Components used ONLY on hidden layers: not built, so not in any bucket — but said, so the gap
    // between "instances in the file" and "components to build" is explained rather than silent.
    const visibleSets = new Set(instances.map((i) => i.setKey || i.key || "name:" + norm(i.setName)));
    const hiddenOnly = new Set<string>();
    // (`walk` skips hidden layers, so this one count walks everything itself.)
    const everyInstance = (n: IrNode | null | undefined): void => {
      if (!n || typeof n !== "object") return;
      if (n.type === "INSTANCE" && n.mainComponent) {
        const mc = n.mainComponent, id = mc.setKey || mc.key || "name:" + norm(mc.setName || mc.name);
        if (!visibleSets.has(id)) hiddenOnly.add(id);
      }
      for (const c of n.children || []) everyInstance(c);
    };
    for (const s of screens) for (const root of screenRoots(s.doc)) everyInstance(root);
    coverage.hiddenOnly = hiddenOnly.size;
    if (rekeyedBy) {
      const s = rekeyedBy.summary;
      proposals = labelProposals(rekeyedBy, visible, input.map || null, input.siblings || null);
      const props = proposals;
      const mapped = props.filter((p) => p.alreadyMapped).length, toConfirm = props.length - mapped;
      const shared = props.filter((p) => !p.alreadyMapped && (p.sharedWith || 0) > 0).length;
      const residual = rekeyedBy.rows.filter((r) => !r.match);
      push(
        "warning",
        "catalog-rekeyed",
        `0 of ${s.names} component(s) on this screen resolve to ${catFile} by key, but ${s.proposed} of the ${s.withCandidates} whose NAME is in the catalog ` +
          `also match it by prop signature (variant axes + values, prop names + types)${s.remote ? `, and ${s.remote} of the ${s.instances} visible instance(s) say remote:true` : ""}. ` +
          `That is not a foreign library — it is the SAME components under new keys: one or both Figma files are duplicates (duplicating a file re-mints every ` +
          `component key), or the library was re-published. Proposed matches (confirm each before reuse — nothing is auto-accepted): ` +
          props.slice(0, 12).map((r) => `'${r.name}' → ${r.catalog ? r.catalog.id : "?"}${r.evidence === "name+no-props" ? " (no props to compare — weaker)" : ""}${r.tie === "duplicate-definitions" ? " (duplicate definitions, harmless tie)" : ""}${r.alreadyMapped ? " (already mapped)" : ""}`).join(", ") +
          (props.length > 12 ? `, … (${props.length} in all — see componentProposals)` : "") + `. ` +
          // F-47: labels only — what is already in the map, and what other exported screens share
          (mapped ? (toConfirm ? `${props.length} proposals, ${mapped} already mapped in the component map — confirm only the other ${toConfirm}. ` : `All ${props.length} proposals are already mapped in the component map — nothing is left to confirm. `) : "") +
          (shared ? `${shared} of the proposals to confirm are on other exported screens too (shared chrome) — confirm those once. ` : "") +
          `${residual.length} name(s) are not in ${catFile}` +
          (buckets.libraryKey
            ? ` — of the table's rows, ${buckets.libraryKey} are third-party components.library.json key matches and ${buckets.newWork} new work`
            : ` and stay new work`) +
          (residual.length ? ` (${residual.slice(0, 5).map((r) => `'${r.name}'`).join(", ")}${residual.length > 5 ? ", …" : ""})` : "") + `. ` +
          `To use them: show the user the list, set "confirmed": true on each accepted entry of componentProposals in this report's JSON, then run ` +
          `the map-bootstrap script (\`<${catFile}> --out design/codeconnect.local.json --from-proposals <this report>.json\`) — it stubs ONLY the confirmed ones, keyed by the screen's own instance key.`,
        { rekey: s, proposals: props.length, confirm: `${toConfirm} component(s) match the catalog by name and prop signature but not by key (a duplicated or re-published file)${mapped ? ` — ${mapped} more are already mapped` : ""} — confirm the proposed matches before reusing them as mappings.` }
      );
    } else if (coverage.localPct <= WRONG_CATALOG_PCT) {
      push(
        "warning",
        "catalog-covers-nothing",
        `${coverage.matchedByLocalKey} of ${coverage.distinct} component(s) used on this screen (${coverage.localPct}%) are in ${catFile} by key — ` +
          `the catalog you exported is not the library this screen is built from. ` +
          (coverage.matchedByKey > coverage.matchedByLocalKey
            ? `${coverage.matchedByKey - coverage.matchedByLocalKey} more match components.library.json, which only means both files consume the same third-party set. `
            : "") +
          (coverage.matchedByName ? `${coverage.matchedByName} match BY NAME only and are marked unverified: a lead, not a mapping. ` : "") +
          (coverage.ambiguousName ? `${coverage.ambiguousName} more share a name with SEVERAL catalog entries ('Component 1'-class names) and are deliberately left unmatched. ` : "") +
          `A "318/318 mapped" count measures the catalog against itself and means nothing here. ` +
          `To find the owning library: open any instance in Figma and use right-click > "Go to main component" — it jumps to the file that ` +
          `defines it. Then connect that file and ${EXPORT_LIBRARY}. ` +
          `Until then every instance is correctly a \`verdict:"new"\` build, not a port of the catalog.` +
          (rekey && rekey.summary.withCandidates
            ? ` (Checked for the duplicated-file case too: only ${rekey.summary.proposedWithSignature} of the ${rekey.summary.withCandidates} name twin(s) also agree on prop signature — ` +
              `too few to call it the same library under new keys.)`
            : ""),
        { coverage: { distinct: coverage.distinct, byLocalKey: coverage.matchedByLocalKey, byKey: coverage.matchedByKey, byName: coverage.matchedByName, ambiguousName: coverage.ambiguousName, localPct: coverage.localPct }, confirm: `Only ${coverage.localPct}% of this screen's components are in ${catFile} by key — is that the component library this screen is built from? Until confirmed, every instance is new work.` }
      );
    } else if (coverage.localPct < 100) {
      push(
        "warning",
        "partial-catalog-coverage",
        `${coverage.matchedByLocalKey} of ${coverage.distinct} component(s) on this screen (${coverage.localPct}%) resolve to ${catFile} by key` +
          (coverage.matchedByName ? `, ${coverage.matchedByName} more by name only (unverified)` : "") +
          `. The rest are new work: ${coverage.entries.filter((e) => !e.matchedBy).slice(0, 6).map((e) => "'" + e.setName + "'").join(", ")}.`,
        { coverage: { distinct: coverage.distinct, byLocalKey: coverage.matchedByLocalKey, byKey: coverage.matchedByKey, byName: coverage.matchedByName, localPct: coverage.localPct } }
      );
    } else {
      push("info", "catalog-covers-screen", `all ${coverage.distinct} component(s) on this screen resolve to ${catFile} by key.`, {});
    }
    // ONE finding for the whole name-matched set. Emitting one per component produced 37 identical
    // paragraphs on the live run — a list nobody reads is the same as no list.
    const named = coverage.entries.filter((e) => e.matchedBy === "name" && !proposedNames.has(e.setName));
    if (named.length) {
      push(
        "info",
        "name-matched-components",
        `${named.length} component(s) have no key in the catalog but DO have an exact name twin there whose prop signature agrees: ` +
          named.slice(0, 10).map((e) => `'${e.setName}' (${e.evidence === "name+no-props" ? "no props to compare" : `props ${e.propOverlap}`})`).join(", ") + (named.length > 10 ? `, …` : "") +
          `. Mapped BY NAME, UNVERIFIED — confirm one with "Go to main component" before reusing any of their code; ` +
          `if that one instance points at the catalog's file, the rest almost certainly do too.`,
        { components: named.map((e) => ({ setName: e.setName, ...ifDefined("catalogName", e.catalogName), ...ifDefined("catalogKey", e.catalogKey), ...ifDefined("propOverlap", e.propOverlap), verified: false })) }
      );
    }
    const amb = coverage.entries.filter((e) => e.ambiguous && !proposedNames.has(e.setName));
    const firstAmb = amb[0]; // set exactly when amb.length
    if (firstAmb) {
      push(
        "warning",
        "ambiguous-component-name",
        `${amb.length} component(s) share their name with SEVERAL catalog entries, and no prop signature picks one of them, so they were left unmatched on purpose: ` +
          amb.slice(0, 8).map((e) => `'${e.setName}' (${e.candidates} candidates)`).join(", ") + (amb.length > 8 ? ", …" : "") +
          `. Generic names like these are what the design system's own hygiene report flags as duplicated/unnamed — ` +
          `binding code to one of them by name would be a guess with a 1-in-${firstAmb.candidates} chance.`,
        { components: amb.map((e) => ({ setName: e.setName, ...ifDefined("candidates", e.candidates) })) }
      );
    }
  }

  // ---------------------------------------------------------------- font-family strays
  const sorted = [...fonts.entries()].sort((a, b) => b[1] - a[1]);
  const [main, ...strays] = sorted;
  if (fonts.size > 1 && main) {
    const [mainFamily, mainCount] = main;
    const total = sorted.reduce((n, [, c]) => n + c, 0);
    push(
      "warning",
      "font-family-stray",
      `${total} text node(s) use ${sorted.length} different font families: ${sorted.map(([f, c]) => `${f} (${c})`).join(", ")}. ` +
        `'${mainFamily}' carries ${mainCount}; the rest are strays — usually a starter-kit style (Figma's Material 3 kit leaks \`material-theme/*\`) ` +
        `left on a layer. Ask the designer before shipping a second webfont for ${strays.reduce((n, [, c]) => n + c, 0)} node(s).`,
      { families: sorted.map(([family, count]) => ({ family, count })) }
    );
  }
  if (stylesText && fonts.size) {
    const dsFamilies = new Set(stylesText.styles.map((s) => s.font).filter((f): f is string => !!f));
    const foreign = [...fonts.keys()].filter((f) => dsFamilies.size && !dsFamilies.has(f));
    if (foreign.length) {
      push(
        "warning",
        "font-not-in-design-system",
        `font ${foreign.map((f) => `'${f}'`).join(", ")} appears on the screen but NO design-system text style uses it ` +
          `(the design system's text styles are all ${[...dsFamilies].join(", ")}). ` +
          `Nothing in the export declares a font file or a webfont for either, so "is it installed and licensed" is a question only the designer can answer.`,
        { fonts: foreign, designSystemFonts: [...dsFamilies] }
      );
    }
  }

  // ---------------------------------------------------------------- text-style strays / near-misses
  if (stylesText && stylesText.styles && textStyles.size) {
    const dsByName = new Map((stylesText.styles || []).map((s): [string, TextStyle] => [s.name, s]));
    const dsNorm = new Map<string, string>();
    for (const s of stylesText.styles || []) dsNorm.set(norm(s.name), s.name);
    const absent: string[] = [], nearMiss: Array<{ name: string; near: string }> = [];
    for (const name of textStyles.keys()) {
      if (dsByName.has(name)) continue;
      const near = dsNorm.get(norm(name));
      if (near) nearMiss.push({ name, near });
      else absent.push(name);
    }
    if (nearMiss.length) {
      push(
        "warning",
        "text-style-near-miss",
        `${nearMiss.length} text style name(s) differ from a design-system style ONLY by case or punctuation: ` +
          nearMiss.map((n) => `'${n.name}' vs '${n.near}'`).join(", ") +
          `. That is the exact near-miss a name-based mapping binds wrongly and silently. Confirm they are the same style before reusing it.`,
        { styles: nearMiss, confirm: `${nearMiss.map((n) => `'${n.name}' = '${n.near}'`).join(", ")} — the same style? Until confirmed, use the screen's own text values, not the design-system style.` }
      );
    }
    if (absent.length) {
      push(
        "warning",
        "text-style-absent",
        `${absent.length} of ${textStyles.size} text style(s) used on the screen are not in the design-system export: ` +
          absent.slice(0, 8).map((n) => "'" + n + "'").join(", ") + (absent.length > 8 ? ", …" : "") + ".",
        { styles: absent }
      );
    }
  }

  // ---------------------------------------------------------------- absurd token values
  const absurd: Array<{ name: string; collection: string | undefined; mode: string; value: number }> = [];
  const seenAbsurd = new Set<string>(); // the same variable appears in both the design system and the screen slice
  const allVars: Variable[] = ((tokens && tokens.variables) || []).concat((variables && variables.variables) || []);
  for (const v of allVars) {
    for (const [mode, val] of Object.entries((v && v.values) || {})) {
      // ts-port: legacy/producer-mismatch read kept as-is — a boxed `{value: n}` mode value (the producer writes the number itself).
      const n = typeof val === "number" ? val : val && typeof val === "object" && "value" in val && typeof val.value === "number" ? val.value : null;
      if (n == null || Math.abs(n) < ABSURD_NUMBER) continue;
      // a variable whose collection the export could not name (collection absent) is its own bucket
      const id = JSON.stringify([v.collection ?? null, v.name, mode]);
      if (seenAbsurd.has(id)) continue;
      seenAbsurd.add(id);
      absurd.push({ name: v.name, collection: v.collection, mode, value: n });
    }
  }
  const firstAbsurd = absurd[0]; // set exactly when absurd.length
  if (firstAbsurd) {
    push(
      "warning",
      "sentinel-token-value",
      `${absurd.length} token value(s) are sentinels, not measurements: ` +
        absurd.slice(0, 4).map((a) => `'${a.name}' = ${a.value} (${a.mode})`).join(", ") + (absurd.length > 4 ? ", …" : "") +
        `. Figma's "fully rounded" corner exports as a literal 1e9. Emit these as the platform's own idiom ` +
        `(CSS 9999px or 50%, SwiftUI .infinity, Compose CircleShape) — never as \`${firstAbsurd.value}px\`.`,
      { tokens: absurd }
    );
  }

  // ---------------------------------------------------------------- single-mode export
  // Deduped by collection NAME: the same collection is present in both the design system's tokens and
  // the screen's slice, and reporting it twice was just noise.
  const multiModeColls: VariableCollection[] = [];
  const seenColl = new Set<string>();
  const allColls: VariableCollection[] = ((tokens && tokens.collections) || []).concat(screenColls);
  for (const c of allColls) {
    if (!Array.isArray(c.modes) || c.modes.length <= 1) continue;
    if (seenColl.has(c.name)) continue;
    seenColl.add(c.name);
    multiModeColls.push(c);
  }
  for (const c of multiModeColls) {
    const seen = resolvedModes.get(c.name);
    if (!seen || !seen.size) continue;
    const only = seen.size === 1 ? [...seen][0] : undefined; // a Set<string>: set exactly when size is 1
    if (only !== undefined && c.modes.length > 1) {
      const rest = c.modes.filter((m) => m !== only);
      // F-20: the example fits the collection — a colour theme's failure is a surface that stays dark; a
      // number collection's (sizes, spacing — often one mode per breakpoint) is a value that never changes.
      const colour = [...((tokens && tokens.variables) || []), ...((variables && variables.variables) || [])].some((v) => v.collection === c.name && v.type === "COLOR");
      const example = colour ? "a dark surface token that stays dark in Light" : `a size or spacing value that should differ in '${rest[0] ?? "another mode"}' but keeps its '${only}' value`;
      push(
        "warning",
        "single-mode-export",
        `every exported frame resolved collection '${c.name}' in mode '${only}', but it defines ${c.modes.length} modes (${c.modes.join(", ")}). ` +
          `The other ${rest.length} mode(s) are DERIVED from variable values, never seen rendered — so any element whose ${only}-mode token has no ` +
          `sensible counterpart (${example}) will be mechanically correct and visually broken. ` +
          `Export a frame in ${rest.map((m) => `'${m}'`).join(" / ")} too, or have the designer confirm the derivation before it ships.`,
        { collection: c.name, exportedMode: only, modes: c.modes }
      );
    }
  }

  // ---------------------------------------------------------------- contrast in the modes nobody drew
  //
  // When only the Dark frame was exported, every other mode is DERIVED from variable values and has
  // never been seen rendered. On the live run that derivation was mechanically correct and visually
  // broken in exactly one place: `Backgrounds/Side menu` resolves to `Indigo 400` in Light — still a
  // dark surface — while the sidebar's own label token flips to a dark gray, so the Light sidebar's
  // navigation labels were near-invisible. The audit asked the right question; nothing answered it.
  //
  // Everything needed to answer it is already on disk: each text node carries the token its colour is
  // bound to, its ancestors carry the token their background is bound to, and the variable file gives
  // both tokens' value in EVERY mode. So resolve the pair per mode and do the contrast arithmetic.
  contrastPerMode(screens, variables, tokens, push, resolvedModes);

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code));
  // F-44: every finding carries the id a plan's auditGate.overridden names (finding-id.ts) — the same
  // function audit.ts uses, over the report in its final order.
  const ids = findingIds(findings);
  findings.forEach((f, i) => { const id = ids[i]; if (id !== undefined) f.id = id; });
  const count = (s: Severity): number => findings.filter((f) => f.severity === s).length;
  return {
    summary: { blockers: count("blocker"), warnings: count("warning"), info: count("info") },
    coverage,
    // The confirmation list (catalog-rekeyed). Every entry starts unconfirmed; map-bootstrap.ts
    // --from-proposals stubs only the ones a person set "confirmed": true on.
    // F-47: unconfirmed first (shared chrome before screen-only), already-mapped last.
    componentProposals: proposals,
    componentResidual: rekey && coverage.rekey && coverage.rekey.rekeyed ? rekey.rows.filter((r) => !r.match).map((r) => ({ name: r.name, instances: r.instances, reasons: r.reasons })) : [],
    findings,
    notChecked,
    inputs: {
      screens: screens.map((s) => s.label),
      variables: !!variables,
      tokens: !!tokens,
      components: !!components,
      stylesText: !!stylesText,
    },
  };
}


// ---------------------------------------------------------------- F-47: proposals, labelled
// On a re-keyed file most proposals are the shell every screen shares (header, sidebar, page title),
// re-proposed on every screen, and several are already in the map. Two LABELS say so — nothing is
// auto-confirmed, no severity changes:
//   * alreadyMapped — the map has an entry under, or whose figma.key is, one of the name's instance keys /
//     set keys (the screen's own keys: an entry under the catalog key alone resolves no re-keyed instance);
//   * sharedWith    — how many OTHER exported screens use the same component (by instance or set key);
//                     absent when the export's other screens are unknown (K-12: unexported ones never count).
// Order: to confirm first — shared before screen-only, most-shared first — then the already-mapped ones.
function labelProposals(rekey: MatchResult, visible: ReturnType<typeof visibleInstances>, map: CodeConnectMap | null, siblings: (() => CrossCheckScreen[]) | null): ComponentProposal[] {
  const mapKeys = new Set<string>();
  for (const [k, e] of Object.entries((map && map.components) || {})) {
    mapKeys.add(k);
    if (e && e.figma && e.figma.key) mapKeys.add(e.figma.key);
  }
  // every key and set key the screen's instances of a name carry (proposal.instanceKeys has one per instance)
  const keysOf = new Map<string, Set<string>>();
  for (const i of visible) {
    const ks = getOrInit(keysOf, i.name, () => new Set<string>());
    if (i.key) ks.add(i.key);
    if (i.setKey) ks.add(i.setKey);
  }
  const others = rekey.proposals.length && siblings ? siblings().map((s) => {
    const ks = new Set<string>();
    for (const i of visibleInstances(s.doc, s.label)) { if (i.key) ks.add(i.key); if (i.setKey) ks.add(i.setKey); }
    return ks;
  }) : null;
  const out = rekey.proposals.map((r): ComponentProposal => {
    const keys = keysOf.get(r.name) || new Set<string>(r.instanceKeys);
    // the screen's OWN keys only: a map entry under the catalog key (a map-bootstrap stub) resolves no re-keyed instance
    const mapped = [...keys].some((k) => mapKeys.has(k));
    return {
      name: r.name, instances: r.instances, screens: r.screens, instanceKeys: r.instanceKeys, remote: r.remote,
      catalog: r.match, ...ifDefined("evidence", r.evidence), tie: r.tie || null, alternatives: r.alternatives, reasons: r.reasons, confirmed: false,
      ...(mapped ? { alreadyMapped: true as const } : {}),
      ...ifDefined("sharedWith", others ? others.filter((o) => [...keys].some((k) => o.has(k))).length : undefined),
    };
  });
  const rank = (p: ComponentProposal): number => (p.alreadyMapped ? 2 : (p.sharedWith || 0) > 0 ? 0 : 1);
  return out.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || (b.p.sharedWith || 0) - (a.p.sharedWith || 0) || a.i - b.i).map((x) => x.p);
}

// The OTHER screens of the export a screen file sits in (<root>/pages/<Page>/<Screen>.json, rows from
// <root>/pages/index.json — or each page's own index.json for an older export), minus the files being
// checked. A thunk: nothing is read until a report has proposals to label. null when a file is not inside
// such an export (a legacy design/<Screen>.json) — sharedWith is then unknown, not 0.
function exportSiblings(files: readonly string[]): (() => CrossCheckScreen[]) | null {
  const checked = new Set(files.map((f) => path.resolve(f)));
  const roots = new Set<string>();
  for (const f of checked) {
    const pages = path.dirname(path.dirname(f));
    if (path.basename(pages) === "pages" && fs.existsSync(path.join(pages, "index.json"))) roots.add(path.dirname(pages));
  }
  if (!roots.size) return null;
  return () => {
    const out: CrossCheckScreen[] = [];
    const seen = new Set<string>(checked);
    for (const root of roots) {
      const index = readJsonOrNull(path.join(root, "pages", "index.json"), isPagesRootIndex);
      if (!index) continue;
      let rows: IndexRow[] = index.layers || [];
      if (!index.layers) {
        for (const pd of index.pageDirs) {
          const idx = pd.dir ? readJsonOrNull(path.join(root, "pages", pd.dir, "index.json"), isPageIndex) : null;
          if (idx) rows = rows.concat(idx.layers);
        }
      }
      for (const row of rows) {
        const rel = row.file;
        if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) continue; // a path inside the export only
        const file = path.resolve(root, rel);
        if (seen.has(file)) continue;
        seen.add(file);
        const doc = readJsonOrNull(file, isScreenDoc);
        if (doc) out.push({ doc, label: path.basename(file, ".json") });
      }
    }
    return out;
  };
}

// ---------------------------------------------------------------- contrast (WCAG 2.2: color.ts)
// WCAG AA for body text. Large text is 3:1, but the export does not reliably say which is which and
// over-reporting a heading is far cheaper than missing an unreadable nav label.
const MIN_CONTRAST = 4.5;


/**
 * A composed colour's ONE RGBA from its two resolved halves; null when either half did not resolve.
 * The opacity is a 0–100 percentage (REST API variables types, VariableComposedColor.opacity:
 * https://developers.figma.com/docs/rest-api/variables-types/), clamped and multiplied into the colour's
 * alpha by color.ts composeAlpha (Help Center 14506821864087 for the clamp; the multiply is an
 * inference — see composeAlpha).
 */
function composedRgba(color: Rgba | null, opacity: number | null): Rgba | null {
  if (!color || opacity === null || !Number.isFinite(opacity)) return null;
  return { ...color, a: composeAlpha(color.a, opacity) };
}

function contrastPerMode(screens: CrossCheckScreen[], variables: TokensDoc | null, tokens: TokensDoc | null, push: Push, resolvedModes: Map<string, Set<string>>): void {
  const defs = new Map<string, Variable>(); // token name -> variable record (the screen's own library wins: it is what the screen binds)
  for (const v of (tokens && tokens.variables) || []) if (v.name) defs.set(v.name, v);
  for (const v of (variables && variables.variables) || []) if (v.name) defs.set(v.name, v);
  if (!defs.size) return;

  // A token's raw value in one mode (the single mode of a one-mode variable stands in for any mode).
  function valueIn(name: string, mode: string): VariableValue | undefined {
    const v = defs.get(name);
    if (!v || !v.values) return undefined;
    const val = v.values[mode];
    if (val !== undefined) return val;
    const keys = Object.keys(v.values);
    const [onlyKey] = keys;
    return keys.length === 1 && onlyKey !== undefined ? v.values[onlyKey] : undefined; // several modes and none of them is this one — do not guess
  }
  const aliasName = (val: unknown): string | null =>
    val && typeof val === "object" && "aliasOf" in val && typeof val.aliasOf === "string" && val.aliasOf ? val.aliasOf : null;
  // A FLOAT token's number in one mode, following aliases (the opacity half of a composed colour).
  function resolveNumber(name: string, mode: string, depth: number): number | null {
    if (depth > 8) return null;
    const val = valueIn(name, mode);
    if (typeof val === "number") return Number.isFinite(val) ? val : null;
    const next = aliasName(val);
    return next ? resolveNumber(next, mode, depth + 1) : null;
  }
  // A token's hex in one mode, following aliases. Depth-limited rather than cycle-tracked: a Figma
  // alias chain is two or three links in practice, and a malformed file must not hang the check.
  function resolve(name: string, mode: string, depth: number): Rgba | null {
    if (depth > 8) return null;
    const val = valueIn(name, mode);
    if (typeof val === "string") return parseHex(val);
    const next = aliasName(val);
    if (next) return resolve(next, mode, depth + 1);
    // A composed colour (doc-types ComposedColor): the colour half (alias -> resolved, hex -> parsed)
    // and the opacity half (a number, or an alias -> that FLOAT's number), folded by composedRgba.
    if (val && typeof val === "object" && "composed" in val) {
      const { color, opacity } = val.composed;
      const c = typeof color === "string" ? parseHex(color) : resolve(color.aliasOf, mode, depth + 1);
      const o = typeof opacity === "number" ? opacity : resolveNumber(opacity.aliasOf, mode, depth + 1);
      return composedRgba(c, o);
    }
    return null;
  }

  // Which modes to check: every mode of every collection that actually defines one of the tokens in
  // play. Names are per-collection, so this is a union of names, not a cross-product.
  const modes = new Set<string>();
  const allColls: VariableCollection[] = ((tokens && tokens.collections) || []).concat((variables && variables.collections) || []);
  for (const c of allColls) {
    for (const m of (c && c.modes) || []) modes.add(m);
  }
  // Skip the modes the export was actually RENDERED in. Those already have a contrast check that is
  // strictly better — audit.ts walks the real composited backgrounds, where this one can only see the
  // nearest token-bound ancestor and will call a header sitting on an absolutely-positioned child
  // white-on-white. This check exists for the modes NOBODY HAS SEEN, and saying so is most of its value.
  const rendered = new Set<string>();
  for (const set of (resolvedModes || new Map<string, Set<string>>()).values()) for (const m of set) rendered.add(m);
  for (const m of rendered) modes.delete(m);
  if (!modes.size) return; // every mode of this system was exported — nothing is being derived
  if (!rendered.size) return; // nothing was resolved at all: no basis for calling any mode "derived"

  const pairs = new Map<string, { fg: string; bg: string; nodes: string[]; sample: string }>(); // "fg|bg" -> { fg, bg, nodes:[], sample }
  for (const s of screens) {
    for (const root of screenRoots(s.doc)) {
      walkWithBg(root, null, (n, bgToken) => {
        if (n.type !== "TEXT" || !bgToken) return;
        const fg = (n.tokens && (n.tokens.fills || n.tokens.textRangeFills)) ||
          ((n.fills || []).map((f) => f && f.tokens && f.tokens.color).find(Boolean));
        if (!fg || typeof fg !== "string") return;
        const key = fg + "|" + bgToken;
        const pair = getOrInit(pairs, key, () => ({ fg, bg: bgToken, nodes: [], sample: n.name }));
        if (pair.nodes.length < 4) pair.nodes.push(n.id);
      });
    }
  }
  if (!pairs.size) return;

  const failures: ContrastFailure[] = [];
  for (const p of pairs.values()) {
    for (const mode of modes) {
      const fg = resolve(p.fg, mode, 0);
      const bg = resolve(p.bg, mode, 0);
      if (!fg || !bg) continue; // this pair is not defined in this mode — say nothing rather than guess
      // A translucent text colour (alpha < 1, e.g. a composed colour) renders as a MIX with its
      // background, and WCAG 2.2's contrast ratio is defined on what renders
      // (https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio): composite it over the background first
      // (color.ts compositeOver — the conventional reading). An opaque fg is used as is, so opaque
      // pairs compute exactly what they did before.
      const r = contrastRatio(fg.a < 1 ? compositeOver(fg, bg) : fg, bg);
      if (r >= MIN_CONTRAST) continue;
      failures.push({ mode, fg: p.fg, bg: p.bg, ratio: Number(r.toFixed(2)), nodes: p.nodes, sample: p.sample });
    }
  }
  if (!failures.length) return;

  // Grouped by mode, because the actionable unit is "Light is broken", not thirty separate rows.
  const byMode = new Map<string, ContrastFailure[]>();
  for (const f of failures) {
    getOrInit(byMode, f.mode, () => []).push(f);
  }
  for (const [mode, list] of byMode) {
    push(
      "warning",
      "derived-mode-contrast",
      `in mode '${mode}', ${list.length} text/background token pair(s) fall below WCAG AA (${MIN_CONTRAST}:1): ` +
        list.slice(0, 4).map((f) => `'${f.fg}' on '${f.bg}' = ${f.ratio}:1 (e.g. ${f.sample})`).join("; ") +
        (list.length > 4 ? ", …" : "") +
        `. No frame was exported in '${mode}', so this mode is DERIVED from variable values and nobody has ever seen it rendered — ` +
        `the derivation is mechanically correct and visually broken. Export a '${mode}' frame, or get the designer to say ` +
        `which token each of these should use there. Do not invent an override and call it done.`,
      { mode, pairs: list, confirm: `Mode '${mode}' was never drawn and ${list.length} derived text/background pair(s) in it fail contrast — ship '${mode}' as derived, or will the designer supply it?` }
    );
  }
}

// Walk carrying the nearest ancestor background TOKEN down the tree — a text node's contrast is
// against whatever surface it sits on, which is virtually never its own parent's own fill.
function walkWithBg(node: IrNode | null | undefined, bgToken: string | null, fn: (n: IrNode, bg: string | null) => void): void {
  if (!node || typeof node !== "object") return;
  // Was `node.visible === false`, which the export never uses — so every hidden layer's text was
  // contrast-checked. `hidden` (and, by not descending, its ancestry) is the flag.
  if (hiddenSelf(node)) return;
  let bg = bgToken;
  const own = (node.tokens && node.tokens.fills) ||
    ((node.fills || []).map((f) => f && f.tokens && f.tokens.color).find(Boolean));
  if (own && typeof own === "string" && node.type !== "TEXT") bg = own;
  fn(node, bg);
  for (const c of node.children || []) walkWithBg(c, bg, fn);
}

function toMarkdown(res: CrossCheckReport): string {
  const L: string[] = [];
  L.push(`# Cross-file check — ${res.inputs.screens.join(", ") || "(no screens)"}`, "");
  L.push(
    `**${res.summary.blockers} blocker(s)**, ${res.summary.warnings} warning(s), ${res.summary.info} info. ` +
      `Every check here is a JOIN between the screen and the design system — none of it is visible from either file alone.`,
    ""
  );
  const c = res.coverage;
  if (c && c.distinct) {
    L.push("## Component coverage of THIS screen", "");
    L.push(`| | count |`, `|---|---|`);
    L.push(`| visible instances on the screen | ${c.instances} |`);
    L.push(`| **distinct components** (each lands in exactly one row below) | **${c.distinct}** |`);
    const b: Partial<Record<CoverageBucket, number>> = c.buckets || {};
    L.push(`| in **the component catalog** by key (verified) | ${b.localKey || 0} (${c.localPct}%) |`);
    L.push(`| in components.library.json by key (a shared third-party set) | ${b.libraryKey || 0} |`);
    if (c.rekey && c.rekey.rekeyed) L.push(`| same name **and** prop signature as a catalog entry — proposed, confirm below | ${b.proposed || 0} |`);
    L.push(`| exact name twin only (**unverified**) | ${b.nameOnly || 0} |`);
    L.push(`| name shared with several catalog entries — left unmatched | ${b.ambiguous || 0} |`);
    L.push(`| no match at all — new work | ${b.newWork || 0} |`);
    if (c.hiddenOnly) L.push(`| *(not counted: components used only on hidden layers — not built)* | ${c.hiddenOnly} |`);
    L.push("");
  }
  if (res.componentProposals && res.componentProposals.length) {
    L.push("## Proposed component matches — confirm before reuse", "");
    L.push("*Matched by name + prop signature because the keys were re-minted (a duplicated file or a re-published library).",
      "Nothing here is accepted until a person sets `\"confirmed\": true` on the entry in the JSON report.*", "");
    // F-47: grouped by what a person has to do — confirm a shared one once, confirm a screen-only one, or
    // nothing (already mapped). Labels only; every row is still unconfirmed in the JSON.
    const all = res.componentProposals;
    const groups: Array<[string, ComponentProposal[]]> = [
      ["Shared with other exported screens — confirm once", all.filter((p) => !p.alreadyMapped && (p.sharedWith || 0) > 0)],
      [all.some((p) => p.sharedWith !== undefined) ? "This screen only" : "To confirm", all.filter((p) => !p.alreadyMapped && !((p.sharedWith || 0) > 0))],
      ["Already in the component map — nothing to confirm", all.filter((p) => p.alreadyMapped)],
    ];
    for (const [title, list] of groups) {
      if (!list.length) continue;
      L.push(`### ${title} (${list.length})`, "");
      L.push("| instance name | × | → catalog | id | page | evidence | shared with | why |", "|---|--:|---|---|---|---|--:|---|");
      for (const p of list) {
        // crossCheck builds every proposal from a ProposedMatchRow (match typed non-null), so no row is skipped
        const cat = p.catalog;
        if (!cat) continue;
        L.push(`| \`${p.name}\` | ${p.instances} | \`${cat.name}\` | ${cat.id} | ${cat.page || ""} | ${p.evidence}${p.tie ? ` (${p.tie})` : ""} | ${p.sharedWith === undefined ? "?" : `${p.sharedWith} other screen(s)`} | ${p.reasons.join("; ")} |`);
      }
      L.push("");
    }
    if (res.componentResidual && res.componentResidual.length) {
      const twin = new Set((c && c.entries ? c.entries : []).filter((e) => e.bucket === "libraryKey").map((e) => e.setName));
      const fresh = res.componentResidual.filter((r) => !twin.has(r.name)), known = res.componentResidual.filter((r) => twin.has(r.name));
      L.push(`**Not in the component catalog (${res.componentResidual.length}):** ` +
        (known.length ? `${known.length} are in components.library.json by key — third-party, see the table: ${known.map((r) => `\`${r.name}\``).join(", ")}. ` : "") +
        `${fresh.length} are new work${fresh.length ? ": " + fresh.map((r) => `\`${r.name}\``).join(", ") : ""}.`, "");
    }
  }
  for (const sev of ["blocker", "warning", "info"] as const) {
    const fs = res.findings.filter((f) => f.severity === sev);
    if (!fs.length) continue;
    L.push(`## ${sev === "blocker" ? "Blockers" : sev === "warning" ? "Warnings" : "Info"} (${fs.length})`, "");
    for (const f of fs) L.push(`- \`${f.code}\` ${f.message}`);
    L.push("");
  }
  if (res.notChecked.length) {
    L.push("## Not checked", "", "*These are gaps in the INPUT, not clean results:*", "");
    for (const n of res.notChecked) L.push(`- ${n}`);
    L.push("");
  }
  return L.join("\n") + "\n";
}

export { crossCheck, toMarkdown, composedRgba, exportSiblings, ABSURD_NUMBER, WRONG_CATALOG_PCT };

// CLI: node design-to-code/cross-check.ts <screen.json>... [--design-system design/design-system]
//        [--variables design/variables.json] [--map design/codeconnect.local.json] [--out design/audit/<screen>.cross] [--json] [--gate]
// Every input is checked as it is read (doc-guards.ts / export-shape.ts): a file that is not the kind of
// document it should be is a one-line error and exit 2.
function main(argv: string[]): number {
  const USAGE =
    `usage: ${scriptCmd("cross-check")} <screen.json>... [--design-system design/export/design-system | design/export/libraries/<dir>] ` +
    "[--variables design/variables.json] [--map design/codeconnect.local.json] [--out design/audit/<screen>.cross] [--json] [--gate]";
  const OPTIONS = {
    "design-system": { type: "string" }, variables: { type: "string" }, map: { type: "string" }, out: { type: "string" }, json: { type: "boolean" }, gate: { type: "boolean" }, help: { type: "boolean", short: "h" },
  } as const;
  const { values: flags, positionals: files } = cliParse("cross-check", argv, OPTIONS, USAGE, 2, (args) => parseArgs({ args, options: OPTIONS, allowPositionals: true }));
  if (flags.help) { console.log(USAGE); return 0; }
  if (!files.length) { console.error(USAGE); return 2; }
  const { "design-system": dsDir, variables: varsFile, map: mapFlag, out } = flags;
  const jsonOnly = !!flags.json, gate = !!flags.gate;

  // Optional inputs are read only when present: the whole point is that this runs on a project that
  // has a screen and nothing else, and SAYS which checks it could not do (notChecked) rather than
  // dying on a missing design system. One that IS there but is not what it should be fails loud.
  // The screen's own slice (<Screen>.vars.json) and the merged union are discovered by the SAME code
  // audit.ts uses (slice-sources.ts variablesContext): the union is the export root's variables.json
  // (P4 #38/#39), never a stale design/variables.json above design/export/ (P4 #14/#201), and the
  // token-collision check reads each screen's own slice (livetest-3 #40/#311).
  const ctx = variablesContext(files, varsFile);
  for (const bad of ctx.invalid) console.error(`error  variables: '${bad.file}' ${bad.error}`);
  if (ctx.invalid.length) return 2;
  const screens: CrossCheckScreen[] = files.map((f, i) => ({ doc: readDocFile(f, "screen export", isScreenDoc), label: path.basename(f, ".json"), ...ifDefined("vars", ctx.own[i]) })); // own[i] is set: own is files.map(...)
  const dsBase = dsDir || "design/design-system";
  const { variablesPath, variablesDoc } = ctx;
  if (variablesPath) console.error(`variables: ${variablesPath}`);
  // A stale legacy-layout `design/variables.json` next to `design/export/` (finding 14's fallout) is
  // never auto-read, but a user should be told it exists and was NOT the file used, since it can
  // carry a different, older set of slices than the one actually checked.
  if (ctx.staleLegacy) {
    console.error(`warn  ${ctx.staleLegacy} also exists and was NOT used (stale sibling of design/export/) — remove it or re-pull into design/export/.`);
  }
  // design-system/ or a library export's libraries/<dir>/ (components.json) — design-system-dir.ts, shared with audit.ts
  const ds = readDesignSystemDir(dsBase);
  // F-47: the component map only LABELS proposals (alreadyMapped). --map is checked like any named input;
  // the default (design/codeconnect.local.json, else ./codeconnect.local.json — plan-skeleton's discovery)
  // is optional, so a broken one is a warning, never a failed check.
  let map: CodeConnectMap | null = null;
  if (mapFlag) map = readDocFile(mapFlag, "component map", isCodeConnectMap);
  else {
    const found = ["design/codeconnect.local.json", "codeconnect.local.json"].find((f) => fs.existsSync(f));
    const r = found ? readJson(found, isCodeConnectMap) : null;
    if (found && r && "doc" in r) { map = r.doc; console.error(`map: ${found}`); }
    else if (found && r && "error" in r) console.error(`warn  ${found} ${r.error} — proposals are not labelled alreadyMapped (pass --map to fail on it)`);
  }
  const res = crossCheck({
    screens,
    sliceSources: ctx.sliceSources,
    variables: variablesDoc,
    variablesPath,
    tokens: ds.tokens,
    components: ds.components,
    componentsLibrary: ds.componentsLibrary,
    stylesText: ds.stylesText,
    componentsFile: ds.componentsFile,
    designSystemIsLibrary: ds.isLibrary,
    map,
    siblings: exportSiblings(files),
  });
  if (jsonOnly) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  } else if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out + ".json", JSON.stringify(res, null, 2) + "\n");
    fs.writeFileSync(out + ".md", toMarkdown(res));
    console.error(`wrote ${out}.json and ${out}.md`);
  } else {
    process.stdout.write(toMarkdown(res));
  }
  console.error(`${res.summary.blockers} blocker(s), ${res.summary.warnings} warning(s), ${res.summary.info} info`);
  for (const n of res.notChecked) console.error(`note  not checked: ${n}`);
  return gate && res.summary.blockers > 0 ? 1 : 0;
}

if (import.meta.main ?? isMainFallback(import.meta.url)) process.exitCode = main(process.argv.slice(2));
