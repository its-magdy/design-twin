// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.


// design-to-code/cross-check.ts
import fs7 from "node:fs";
import path5 from "node:path";

// design-to-code/types.ts
function isJsonObject(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// design-to-code/export-shape.ts
function isIrNode(x) {
  return isJsonObject(x) && typeof x.id === "string" && typeof x.type === "string" && (x.children === void 0 || Array.isArray(x.children));
}
function isScreenExport(x) {
  return isJsonObject(x) && Array.isArray(x.nodes) && x.nodes.every(isIrNode);
}
function isLayerFile(x) {
  return isJsonObject(x) && !Array.isArray(x.nodes) && isIrNode(x.tree);
}
function isScreenDoc(x) {
  return isScreenExport(x) || isLayerFile(x) || isIrNode(x);
}
isScreenDoc.expected = "a screen export: {nodes:[\u2026]} whose every node has a string id and type, a layer file {tree: node}, or a bare node {id, type, \u2026}";
function screenRoots(doc) {
  if (isScreenExport(doc)) return doc.nodes;
  if (isLayerFile(doc)) return [doc.tree];
  if (isIrNode(doc)) return [doc];
  return [];
}
function screenExportOf(doc) {
  return isScreenExport(doc) ? doc : null;
}

// bridge/src/json-util.ts
function nullProto() {
  return /* @__PURE__ */ Object.create(null);
}
function isRecord(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function isStringArray(x) {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}
function ifDefined(key, v) {
  const o = {};
  if (v !== void 0) o[key] = v;
  return o;
}

// design-to-code/map-util.ts
var alnumKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
function getOrInit(m, k, init) {
  const have = m.get(k);
  if (have !== void 0) return have;
  const made = init();
  m.set(k, made);
  return made;
}

// design-to-code/component-match.ts
function visibleInstances(doc, label) {
  const out = [];
  const roots = screenRoots(doc);
  const walk2 = (n) => {
    if (!n || typeof n !== "object" || n.hidden === true) return;
    if (n.type === "INSTANCE" && n.mainComponent) {
      const mc = n.mainComponent;
      out.push({
        screen: label,
        nodeId: n.id,
        layer: n.name,
        name: mc.setName || mc.name || n.name,
        ...ifDefined("key", mc.key),
        ...ifDefined("setKey", mc.setKey),
        remote: mc.remote === true,
        variant: parseVariant(n.component) || parseVariant(mc.variant),
        props: n.props && typeof n.props === "object" ? n.props : {}
      });
    }
    for (const c of n.children || []) walk2(c);
  };
  for (const r of roots) walk2(r);
  return out;
}
function parseVariant(s) {
  if (isJsonObject(s)) {
    const out2 = Object.fromEntries(Object.entries(s).filter((e) => typeof e[1] === "string"));
    return Object.keys(out2).length ? out2 : null;
  }
  if (!s || typeof s !== "string" || !s.includes("=")) return null;
  const out = {};
  for (const part of s.split(/,\s*(?=[^,=]+=)/)) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : null;
}
var baseProp = (p) => String(p).split("#")[0] ?? "";
var SHARED_PAGE = /shared|style ?guide|foundation|core|global|design.?system|librar|banner|badge/i;
function signature(inst, cand) {
  const props = {};
  for (const [k, v] of Object.entries(cand.props || {})) props[baseProp(k)] = v;
  const reasons = [];
  let score = 40, verified = true;
  reasons.push("name matches catalog entry verbatim");
  const variant = inst.variant;
  if (variant) {
    const axes = Object.keys(variant);
    const known = axes.filter((k) => props[k] && props[k].type === "VARIANT");
    if (known.length === axes.length) {
      score += 25;
      reasons.push(`all ${axes.length} variant prop name(s) exist as VARIANT props`);
    } else {
      verified = false;
      score += known.length ? 10 : -15;
      reasons.push(known.length ? `${known.length}/${axes.length} variant prop names exist` : "variant prop names are NOT on this candidate");
    }
    const bad = Object.entries(variant).filter(([k, val]) => {
      const d = props[k];
      return d && d.type === "VARIANT" && !(d.options || []).includes(val);
    }).map(([k]) => k);
    if (known.length && !bad.length) {
      score += 25;
      reasons.push(`variant value(s) ${known.map((k) => `${k}=${variant[k]}`).join(", ")} are in the option list`);
    } else if (bad.length) {
      verified = false;
      score -= 20;
      reasons.push(`variant value(s) not in option list (${bad.map((k) => `${k}=${variant[k]}`).join(", ")})`);
    }
  } else if (cand.type === "COMPONENT") {
    score += 15;
    reasons.push("instance has no variant string and the catalog entry is a plain COMPONENT");
  } else {
    verified = false;
    reasons.push(`instance sets no variant but the catalog entry is a ${cand.type}`);
  }
  const own = Object.keys(inst.props || {}).filter((k) => !variant || !(baseProp(k) in variant));
  if (own.length) {
    const typed = own.filter((k) => {
      const d = props[baseProp(k)], v = inst.props[k];
      if (!d) return false;
      if (typeof v === "boolean") return d.type === "BOOLEAN";
      return d.type === "TEXT" || d.type === "INSTANCE_SWAP" || d.type === "VARIANT";
    });
    if (typed.length === own.length) {
      score += 15;
      reasons.push(`all ${own.length} non-variant prop name(s) exist on the definition`);
    } else {
      verified = false;
      score += typed.length ? 5 : -10;
      reasons.push(typed.length ? `${typed.length}/${own.length} non-variant prop names exist with a matching type` : "none of the instance prop names exist on this definition");
    }
  }
  if (SHARED_PAGE.test(String(cand.page || ""))) {
    score += 5;
    reasons.push(`lives on a shared page (${cand.page})`);
  }
  return { verified, score, reasons };
}
var sigOf = (c) => JSON.stringify(Object.entries(c.props || {}).map(([k, v]) => [baseProp(k), v.type, v.options || null]).sort());
function matchByNameAndSignature(instances, catalog, library) {
  const comps = catalog && catalog.components || [];
  const byName = /* @__PURE__ */ new Map();
  comps.forEach((c, i) => {
    getOrInit(byName, c.name, () => []).push(Object.assign({ _order: i }, c));
  });
  const catKeys = new Set(comps.map((c) => c.key).filter((k) => !!k));
  const libKeys = new Set((library && library.components || []).map((c) => c.key).filter((k) => !!k));
  const libNames = new Set((library && library.components || []).map((c) => c.name));
  const groups = /* @__PURE__ */ new Map();
  for (const inst of instances) {
    const group = groups.get(inst.name);
    if (group) group.push(inst);
    else groups.set(inst.name, [inst]);
  }
  const rows = [];
  for (const [name, list] of groups) {
    const byKey = list.some((i) => catKeys.has(i.key ?? "") || catKeys.has(i.setKey ?? ""));
    const row = {
      name,
      instances: list.length,
      nodeIds: list.map((i) => i.nodeId),
      screens: [...new Set(list.map((i) => i.screen).filter((s) => !!s))],
      instanceKeys: [...new Set(list.map((i) => i.setKey || i.key).filter((k) => !!k))],
      remote: list.every((i) => i.remote),
      byKey,
      match: null,
      alternatives: [],
      reasons: []
    };
    const cands = byName.get(name) || [];
    if (!cands.length) {
      const inLibrary = list.some((i) => libKeys.has(i.key ?? "") || libKeys.has(i.setKey ?? ""));
      row.reasons.push(`no catalog entry named ${JSON.stringify(name)}`);
      row.reasons.push(inLibrary ? "its key IS in components.library.json \u2014 a third-party library both files consume, not the design system's own component" : libNames.has(name) ? "the name appears in components.library.json \u2014 a third-party library the design system consumes, not one of its own components" : "not a component of the exported design system (typically an external icon library) \u2014 expected, not a miss");
      rows.push(row);
      continue;
    }
    if (cands.length > 1) row.candidates = cands.map((c) => ({ ...ifDefined("id", c.id), ...ifDefined("key", c.key), name: c.name }));
    const [firstInst, ...otherInsts] = list;
    const scored = cands.map((c) => {
      const first = signature(firstInst, c);
      const per = [first, ...otherInsts.map((i) => signature(i, c))];
      return { c, verified: per.every((p) => p.verified), score: Math.min(...per.map((p) => p.score)), reasons: first.reasons, failing: per.find((p) => !p.verified) };
    }).sort((a, b) => Number(b.verified) - Number(a.verified) || b.score - a.score || a.c._order - b.c._order);
    const best = scored[0];
    if (best === void 0) throw new Error("component-match: a non-empty candidate list scored to nothing");
    if (!best.verified) {
      row.reasons.push(`${cands.length} catalog entr${cands.length === 1 ? "y is" : "ies are"} named ${JSON.stringify(name)}, but no prop signature agrees: ` + (best.failing ? best.failing.reasons.filter((r) => /NOT|not in|none of|\d+\/\d+|sets no variant/.test(r)).join("; ") : "signature mismatch") + " \u2014 a name alone is not a match");
      rows.push(row);
      continue;
    }
    const verifiedOnes = scored.filter((s) => s.verified);
    const runnerUp = verifiedOnes[1];
    const ties = verifiedOnes.filter((s) => s.score === best.score && s !== best);
    row.match = { ...ifDefined("id", best.c.id), ...ifDefined("key", best.c.key), name: best.c.name, type: best.c.type, ...ifDefined("page", best.c.page) };
    row.evidence = list.some((i) => i.variant || Object.keys(i.props || {}).length) ? "name+signature" : "name+no-props";
    row.reasons = best.reasons.slice();
    if (ties.length) {
      const identical = ties.every((t) => sigOf(t.c) === sigOf(best.c));
      row.reasons.push(identical ? `${ties.length + 1} catalog entries named "${name}" score identically \u2014 they are duplicates of one definition (same props, same variants); the first in the catalog is used` : `${ties.length + 1} catalog entries named "${name}" score identically with DIFFERENT signatures \u2014 the first in the catalog is used; confirm which one`);
      row.tie = identical ? "duplicate-definitions" : "different-signatures";
    } else if (scored.length > 1) {
      row.reasons.push(`beat ${scored.length - 1} same-named candidate(s)${runnerUp ? ` by ${best.score - runnerUp.score} pts` : " (their prop signatures do not agree)"}`);
    }
    row.alternatives = verifiedOnes.filter((s) => s !== best).map((s) => ({ ...ifDefined("id", s.c.id), ...ifDefined("key", s.c.key), ...ifDefined("page", s.c.page), score: s.score }));
    row.reasons.push("key lookup: " + (byKey ? "matched" : "NO MATCH (the instance's key is not in the catalog \u2014 re-keyed)"));
    rows.push(row);
  }
  const proposals = rows.filter((r) => !!r.match && !r.byKey);
  return {
    rows,
    proposals,
    summary: {
      instances: instances.length,
      names: rows.length,
      byKey: rows.filter((r) => r.byKey).length,
      proposed: proposals.length,
      proposedWithSignature: proposals.filter((r) => r.evidence === "name+signature").length,
      withCandidates: rows.filter((r) => (byName.get(r.name) || []).length).length,
      unmatched: rows.filter((r) => !r.match).length,
      remote: instances.filter((i) => i.remote).length
    }
  };
}
function nameVerdict(row) {
  if (row.match && row.tie === "different-signatures") {
    return { status: "ambiguous", reason: `several catalog entries named ${JSON.stringify(row.name)} agree with the instance equally but have DIFFERENT signatures \u2014 confirm which one` };
  }
  if (row.match) return { status: "matched", reason: `name + ${row.evidence === "name+no-props" ? "no props to check (a plain component)" : "prop signature"}${row.tie === "duplicate-definitions" ? "; same-named duplicates of one definition" : ""}` };
  const n = (row.candidates || []).length;
  if (n > 1) return { status: "ambiguous", reason: `${n} catalog entries are named ${JSON.stringify(row.name)} and none agrees with the instance's prop signature \u2014 confirm which one, if any` };
  const why = (row.reasons || []).find((r) => /no catalog entry named|no prop signature agrees/.test(r));
  return { status: "unmatched", reason: why || `no catalog entry named ${JSON.stringify(row.name)} agrees with the instance` };
}
var REKEY_MIN_PROPOSALS = 3;
var REKEY_MIN_SHARE = 0.5;
function isRekeyed(result) {
  const s = result.summary;
  return s.names > 0 && s.byKey / s.names <= 0.05 && s.proposedWithSignature >= REKEY_MIN_PROPOSALS && s.withCandidates > 0 && s.proposedWithSignature / s.withCandidates >= REKEY_MIN_SHARE;
}

// design-to-code/finding-id.ts
function findingIds(findings) {
  const seen = /* @__PURE__ */ new Map();
  return findings.map((f) => {
    const base = f.nodeId ? `${f.code}@${f.nodeId}` : f.code;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}~${n}`;
  });
}

// design-to-code/cli-args.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// bridge/src/errmsg.ts
var errMsg = (e) => typeof e === "string" ? e : String(e && e.message || e);
var errCode = (e) => e && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : void 0;

// design-to-code/cli-args.ts
var SELF = fileURLToPath(import.meta.url);
var shellQuote = (p) => /["$`\\!]/.test(p) ? `'${p.replaceAll("'", `'\\''`)}'` : `"${p}"`;
var scriptCmd = (name) => `node ${shellQuote(path.join(path.dirname(SELF), name + path.extname(SELF)))}`;
function joinNegativeValues(argv, options) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i], next = argv[i + 1];
    if (tok === void 0) continue;
    if (tok === "--") {
      out.push(...argv.slice(i));
      break;
    }
    const name = tok.startsWith("--") ? tok.slice(2) : void 0;
    if (name !== void 0 && next !== void 0 && options[name]?.type === "string" && /^-\d/.test(next)) {
      out.push(`${tok}=${next}`);
      i++;
    } else out.push(tok);
  }
  return out;
}
function cliParse(tool, argv, options, usage, exitCode, parse) {
  const args = joinNegativeValues(argv, options);
  try {
    return parse(args);
  } catch (e) {
    const code = errCode(e);
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      const { tokens } = parseArgs({ args, options, strict: false, allowPositionals: true, tokens: true });
      const unknown = [...new Set(tokens.flatMap((t) => t.kind === "option" && !(t.name in options) ? [t.rawName] : []))];
      console.error(`${tool}: unknown flag ${unknown.join(", ")}
${usage}`);
    } else if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      const msg = e instanceof Error ? e.message : "";
      const m = /Option '(-[\w-]+|--[\w-]+)/.exec(msg);
      console.error(`${tool}: ${m ? m[1] : "an option"} ${/does not take an argument/.test(msg) ? "takes no value" : "needs a value"}
${usage}`);
    } else {
      console.error(`${tool}: ${errMsg(e)}
${usage}`);
    }
    process.exit(exitCode);
  }
}

// design-to-code/catalog-input.ts
import fs2 from "node:fs";

// design-to-code/read-json.ts
import fs from "node:fs";
function readFailure(e) {
  const code = e && typeof e === "object" && "code" in e ? e.code : void 0;
  if (code === "ENOENT") return { error: "does not exist", missing: true };
  return {
    error: code === "EISDIR" ? "is a directory, not a file" : code === "EACCES" ? "is not readable (permission denied)" : `could not be read (${String(code || e)})`
  };
}
function readJson(file, guard) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return readFailure(e);
  }
  if (buf.length >= 2 && (buf[0] === 255 && buf[1] === 254 || buf[0] === 254 && buf[1] === 255)) {
    return { error: "is UTF-16, not UTF-8 \u2014 re-save it as UTF-8" };
  }
  let raw = buf.toString("utf8");
  if (raw.charCodeAt(0) === 65279) raw = raw.slice(1);
  let parsed;
  try {
    const value = JSON.parse(raw);
    parsed = value;
  } catch (e) {
    return { error: `is not valid JSON \u2014 ${errMsg(e)}` };
  }
  if (!guard(parsed)) return { error: `is not ${guard.expected || "the expected kind of document"}` };
  return { doc: parsed };
}
function readJsonOrNull(file, guard) {
  const r = readJson(file, guard);
  return "doc" in r ? r.doc : null;
}

// design-to-code/catalog-input.ts
function readDocFile(file, what, guard, hint) {
  const r = readJson(file, guard);
  if ("doc" in r) return r.doc;
  const ioFailure = r.missing || /^(is a directory|is not readable|could not be read)/.test(r.error);
  console.error(`error  ${what}: '${file}' ${r.error}${ioFailure ? "." : ""}` + (ioFailure && hint ? `
       ${hint}` : ""));
  process.exit(2);
}
function readOptionalDoc(file, what, guard) {
  return fs2.existsSync(file) ? readDocFile(file, what, guard) : null;
}

// bridge/src/is-main.ts
import fs3 from "node:fs";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function isMainFallback(metaUrl) {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return fs3.realpathSync(argv1) === fs3.realpathSync(fileURLToPath2(metaUrl));
  } catch {
    return false;
  }
}

// design-to-code/map-validate.ts
var STATUSES = ["active", "deprecated", "needs-review"];
var KEYS = {
  root: ["version", "figmaFileKey", "components"],
  entry: ["figma", "code", "props", "variantOverrides", "childrenByLayer", "status", "note"],
  figma: ["key", "id", "name", "unstable"],
  code: ["module", "export", "targets"],
  target: ["module", "export"],
  vo: ["when", "code"],
  voCode: ["module", "export"],
  children: ["layerNamePattern", "slot"],
  prop: Object.assign(nullProto(), {
    enum: ["kind", "codeProp", "values", "default", "omitDefault"],
    boolean: ["kind", "codeProp", "default", "omitDefault"],
    string: ["kind", "codeProp"],
    instance: ["kind", "codeProp", "slot"]
  })
};
var PROP_KINDS = Object.keys(KEYS.prop);
var isStr = (v) => typeof v === "string";
var isBool = (v) => typeof v === "boolean";
var noExtra = (obj, allowed, at, err) => {
  if (!Array.isArray(allowed)) return;
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) err(`${at}.${k}`, "unknown property (additionalProperties:false)");
};
var optStrings = (obj, keys, at, err) => {
  for (const k of keys) if (obj[k] !== void 0 && !isStr(obj[k])) err(`${at}.${k}`, "must be a string");
};
function validateMap(map) {
  const errors = [];
  const err = (path6, message) => errors.push({ path: path6, message });
  if (!isRecord(map)) return { ok: false, errors: [{ path: "", message: "map must be an object" }] };
  noExtra(map, KEYS.root, "", err);
  if (map.version !== 1) err("version", "must be 1");
  if (map.figmaFileKey !== void 0 && !isStr(map.figmaFileKey)) err("figmaFileKey", "must be a string");
  if (!isRecord(map.components)) {
    err("components", "must be an object");
    return { ok: false, errors };
  }
  for (const key of Object.keys(map.components)) {
    const e = map.components[key];
    const at = `components.${key}`;
    if (!isRecord(e)) {
      err(at, "entry must be an object");
      continue;
    }
    noExtra(e, KEYS.entry, at, err);
    if (!isRecord(e.figma)) err(`${at}.figma`, "required object");
    else {
      noExtra(e.figma, KEYS.figma, `${at}.figma`, err);
      if (!isStr(e.figma.name)) err(`${at}.figma.name`, "required string");
      optStrings(e.figma, ["key", "id"], `${at}.figma`, err);
      if (e.figma.unstable !== void 0 && !isBool(e.figma.unstable)) err(`${at}.figma.unstable`, "must be a boolean");
    }
    if (!isRecord(e.code)) err(`${at}.code`, "required object");
    else {
      noExtra(e.code, KEYS.code, `${at}.code`, err);
      if (!isStr(e.code.module)) err(`${at}.code.module`, "required string");
      if (!isStr(e.code.export)) err(`${at}.code.export`, "required string");
      if (e.code.targets !== void 0) {
        if (!isRecord(e.code.targets)) err(`${at}.code.targets`, "must be an object");
        else for (const t of Object.keys(e.code.targets)) {
          const tv = e.code.targets[t], ta = `${at}.code.targets.${t}`;
          if (!isRecord(tv)) err(ta, "must be an object");
          else {
            noExtra(tv, KEYS.target, ta, err);
            optStrings(tv, ["module", "export"], ta, err);
          }
        }
      }
    }
    if (e.status !== void 0 && (!isStr(e.status) || !STATUSES.includes(e.status))) err(`${at}.status`, `must be one of ${STATUSES.join("|")}`);
    optStrings(e, ["note"], at, err);
    if (e.props !== void 0) {
      if (!isRecord(e.props)) err(`${at}.props`, "must be an object");
      else for (const pn of Object.keys(e.props)) validateProp(e.props[pn], `${at}.props.${pn}`, err);
    }
    if (e.variantOverrides !== void 0) {
      if (!Array.isArray(e.variantOverrides)) err(`${at}.variantOverrides`, "must be an array");
      else e.variantOverrides.forEach((vo, i) => {
        const va = `${at}.variantOverrides[${i}]`;
        if (!isRecord(vo)) {
          err(va, "must be an object");
          return;
        }
        noExtra(vo, KEYS.vo, va, err);
        if (!isRecord(vo.when)) err(`${va}.when`, "required object");
        else for (const wk of Object.keys(vo.when)) if (!isStr(vo.when[wk])) err(`${va}.when.${wk}`, "value must be a string");
        if (!isRecord(vo.code)) err(`${va}.code`, "required object");
        else {
          noExtra(vo.code, KEYS.voCode, `${va}.code`, err);
          if (!isStr(vo.code.module)) err(`${va}.code.module`, "required string");
          if (!isStr(vo.code.export)) err(`${va}.code.export`, "required string");
        }
      });
    }
    if (e.childrenByLayer !== void 0) {
      if (!isRecord(e.childrenByLayer)) err(`${at}.childrenByLayer`, "must be an object");
      else {
        noExtra(e.childrenByLayer, KEYS.children, `${at}.childrenByLayer`, err);
        optStrings(e.childrenByLayer, ["layerNamePattern", "slot"], `${at}.childrenByLayer`, err);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
function validateProp(p, at, err) {
  if (!isRecord(p)) {
    err(at, "prop must be an object");
    return;
  }
  const allowed = typeof p.kind === "string" ? KEYS.prop[p.kind] : void 0;
  if (!Array.isArray(allowed)) {
    err(`${at}.kind`, `must be one of ${PROP_KINDS.join("|")}`);
    return;
  }
  noExtra(p, allowed, at, err);
  if (p.kind !== "instance" && !isStr(p.codeProp)) err(`${at}.codeProp`, "required string");
  if (p.kind === "instance" && p.codeProp !== void 0 && !isStr(p.codeProp)) err(`${at}.codeProp`, "must be a string");
  if (p.kind === "instance" && p.slot !== void 0 && !isStr(p.slot)) err(`${at}.slot`, "must be a string");
  if (p.kind === "enum") {
    if (p.values !== void 0 && !isRecord(p.values)) err(`${at}.values`, "must be an object (VARIANT option -> code value)");
    else if (isRecord(p.values)) for (const k of Object.keys(p.values)) {
      const t = typeof p.values[k];
      if (p.values[k] !== null && !["string", "number", "boolean"].includes(t)) err(`${at}.values.${k}`, "value must be string|number|boolean|null");
    }
    if (p.default !== void 0 && !["string", "number", "boolean"].includes(typeof p.default)) err(`${at}.default`, "must be string|number|boolean");
  }
  if (p.kind === "boolean" && p.default !== void 0 && !isBool(p.default)) err(`${at}.default`, "must be a boolean");
  if ((p.kind === "enum" || p.kind === "boolean") && p.omitDefault !== void 0 && !isBool(p.omitDefault)) err(`${at}.omitDefault`, "must be a boolean");
}
function isCodeConnectMap(x) {
  return validateMap(x).ok;
}
isCodeConnectMap.expected = "a valid component map (the map-validate script lists what is wrong with it)";
if (false) process.exitCode = main(process.argv.slice(2));

// design-to-code/probe-steps.ts
function isPlanExpect(x) {
  return x === "dialog" || x === "url" || typeof x === "string" && x.startsWith("selector:") && x.length > "selector:".length;
}

// design-to-code/doc-guards.ts
function optArrayOf(x, each) {
  return x === void 0 || Array.isArray(x) && x.every(each);
}
var isObj = isJsonObject;
var optObj = (x) => x === void 0 || isObj(x);
var optStr = (x) => x === void 0 || typeof x === "string";
var anyObject = (x) => isObj(x);
function isVariable(x) {
  return isObj(x) && typeof x.name === "string" && typeof x.type === "string" && isObj(x.values) && optStr(x.collection);
}
function isVariableCollection(x) {
  return isObj(x) && typeof x.name === "string" && isStringArray(x.modes);
}
function isTokensDoc(x) {
  return isObj(x) && optArrayOf(x.variables, isVariable) && optArrayOf(x.collections, isVariableCollection) && optArrayOf(x._slices, anyObject) && optArrayOf(x._conflicts, anyObject) && (x.hygiene === void 0 || isStringArray(x.hygiene));
}
isTokensDoc.expected = "a token catalog: an object whose `variables` (each {name, type, values}) and `collections` (each {name, modes[]}), when present, are arrays";
function isCatalogComponent(x) {
  return isObj(x) && typeof x.name === "string" && optStr(x.key) && optStr(x.id) && optObj(x.props) && optArrayOf(x.variants, anyObject);
}
function isComponentsCatalog(x) {
  return isObj(x) && Array.isArray(x.components) && x.components.every(isCatalogComponent);
}
isComponentsCatalog.expected = "a component catalog: an object with a `components` array of {name, type, key?, id?, props?}";
function isComponentDetailFile(x) {
  return isObj(x) && typeof x.name === "string" && optArrayOf(x.variants, anyObject) && optObj(x.node);
}
isComponentDetailFile.expected = "a component detail file: an object with a `name` and `variants[]` or `node`";
function isTextStylesDoc(x) {
  return isObj(x) && Array.isArray(x.styles) && x.styles.every((s) => isObj(s) && typeof s.name === "string");
}
isTextStylesDoc.expected = "a text-style sheet: an object with a `styles` array of {name, \u2026}";
function isScreenAssetsDoc(x) {
  return isObj(x) && optArrayOf(x.heavy, (h) => isObj(h) && typeof h.file === "string" && typeof h.bytes === "number" && (h.paths === void 0 || typeof h.paths === "number") && (h.embeddedRaster === void 0 || typeof h.embeddedRaster === "number")) && optArrayOf(x.files, (f) => isObj(f) && typeof f.file === "string" && optStr(f.node));
}
isScreenAssetsDoc.expected = "a screen asset manifest: an object whose `heavy` ({file, bytes}) and `files` ({file, node?}), when present, are arrays";
function isLibrariesIndex(x) {
  return isObj(x) && Array.isArray(x.libraries) && x.libraries.every((r) => isObj(r) && typeof r.dir === "string" && optStr(r.libraryName) && (r.collectionKeys === void 0 || isStringArray(r.collectionKeys)));
}
isLibrariesIndex.expected = "a library index: an object with a `libraries` array of {dir, libraryName?, collectionKeys?}";
var SEVERITIES = ["blocker", "warning", "info"];
function isAuditOverridesDoc(x) {
  return isObj(x) && Array.isArray(x.overrides) && x.overrides.every((o) => isObj(o) && typeof o.code === "string" && typeof o.severity === "string" && SEVERITIES.includes(o.severity) && typeof o.reason === "string" && o.reason.trim() !== "" && ["nodeId", "token", "component", "collection", "mode", "category", "state", "screen", "decidedBy", "decidedAt"].every((k) => optStr(o[k])));
}
isAuditOverridesDoc.expected = "an audit overrides file: { overrides: [{ code, severity: blocker|warning|info, reason (non-empty), nodeId?, token?, component?, collection?, mode?, category?, state?, screen?, decidedBy?, decidedAt? }] }";
function isAuditReport(x) {
  return isObj(x) && isObj(x.summary) && Array.isArray(x.findings) && x.findings.every((f) => isObj(f) && typeof f.severity === "string" && typeof f.code === "string");
}
isAuditReport.expected = "an audit report (written by the audit script's --out): an object with `summary` and a `findings` array of {severity, code, message}";
function isProposal(x) {
  return isObj(x) && typeof x.name === "string";
}
function isProposalList(x) {
  return Array.isArray(x) && x.every(isProposal);
}
isProposalList.expected = "a list of component proposals: an array of {name, catalog, confirmed, \u2026}";
function isIndexRowLike(x) {
  return isObj(x) && typeof x.id === "string" && typeof x.name === "string";
}
function isPagesRootIndex(x) {
  return isObj(x) && Array.isArray(x.pageDirs) && x.pageDirs.every((d) => isObj(d) && optStr(d.dir) && optStr(d.index)) && (x.layers === void 0 || Array.isArray(x.layers) && x.layers.every(isIndexRowLike));
}
isPagesRootIndex.expected = "the export's pages/index.json: an object with a `pageDirs` array (and `layers`, when present, an array of {id, name, file})";
function isPageIndex(x) {
  return isObj(x) && Array.isArray(x.layers) && x.layers.every(isIndexRowLike);
}
isPageIndex.expected = "a page index (pages/<Page>/index.json): an object with a `layers` array of {id, name, file}";
function isVerifyExpectation(x) {
  return isObj(x) && isObj(x.frame) && Array.isArray(x.nodes) && x.nodes.every((n) => isObj(n) && typeof n.nodeId === "string") && optArrayOf(x.instances, anyObject) && optArrayOf(x.interactions, anyObject) && optArrayOf(x.notComparable, anyObject);
}
isVerifyExpectation.expected = "a verify expectation (the verify-screen script's --expect output): an object with `frame` and a `nodes` array of {nodeId, \u2026}";
var isNameVersion = (x) => isObj(x) && typeof x.version === "string" && (typeof x.package === "string" || typeof x.name === "string");
function isProbeIdentity(x) {
  return isObj(x) && typeof x.name === "string" && (x.version === null || typeof x.version === "string") && typeof x.sha256 === "string" && isNameVersion(x.playwright) && isNameVersion(x.browser);
}
function isBuildIdentity(x) {
  return isObj(x) && typeof x.url === "string" && (x.mode === "vite-dev" || x.mode === "static" || x.mode === "unknown") && typeof x.assets === "number" && typeof x.assetsSha256 === "string" && (x.unhashed === void 0 || typeof x.unhashed === "number") && (x.gitHead === null || typeof x.gitHead === "string") && (x.gitDirty === null || typeof x.gitDirty === "boolean");
}
var isProbeFrame = (x) => isObj(x) && typeof x.nodeId === "string" && typeof x.selector === "string" && typeof x.via === "string" && isObj(x.rect);
var isCountMap = (x) => isObj(x) && Object.values(x).every((v) => typeof v === "number");
var isNavigation = (x) => isObj(x) && Array.isArray(x.events) && typeof x.afterInitialLoad === "number" && typeof x.reruns === "number";
var isTagsNotInExpectation = (x) => isObj(x) && typeof x.count === "number" && Array.isArray(x.ids) && x.ids.every((r) => isObj(r) && typeof r.id === "string" && typeof r.elements === "number");
var isReasonMap = (x) => isObj(x) && Object.values(x).every((v) => typeof v === "string");
var isNum = (x) => typeof x === "number" && Number.isFinite(x);
function isProbeReach(x) {
  return isObj(x) && Array.isArray(x.steps) && x.steps.every(isObj) && typeof x.sha256 === "string" && typeof x.source === "string" && typeof x.url === "string";
}
function isPageOverflow(x) {
  return isObj(x) && isObj(x.viewport) && isNum(x.viewport.w) && isNum(x.viewport.h) && isNum(x.scrollWidth) && isNum(x.clientWidth) && typeof x.overflowX === "string" && typeof x.scrollable === "boolean" && Array.isArray(x.offenders) && x.offenders.every((o) => isObj(o) && typeof o.path === "string" && (o.dt === null || typeof o.dt === "string") && isNum(o.right)) && optStr(x.compatMode);
}
var BEHAVIOUR_STATUSES = ["pass", "fail", "warn", "not-run", "unsupported"];
var isBehaviourStatus = (x) => typeof x === "string" && BEHAVIOUR_STATUSES.some((s) => s === x);
function isBehaviourCheck(x) {
  return isObj(x) && typeof x.id === "string" && isBehaviourStatus(x.status) && typeof x.detail === "string";
}
function isMeasuredBehaviour(x) {
  return isObj(x) && x.version === 1 && typeof x.ran === "boolean" && (x.ran ? Array.isArray(x.checks) && x.checks.every(isBehaviourCheck) : typeof x.why === "string");
}
function isMeasuredVisual(x) {
  return isObj(x) && x.version === 1 && typeof x.ran === "boolean" && (x.ran ? isNum(x.differingPct) && isNum(x.shiftTolerantPct) && Array.isArray(x.regions) : typeof x.why === "string");
}
var MEASURED_EXTRAS = [
  ["probe", isProbeIdentity, "the shipped probe's identity {name, version, sha256, playwright:{package, version}, browser:{name, version}} \u2014 read as probe: unknown"],
  ["frame", isProbeFrame, "a probe frame {nodeId, selector, via, rect}"],
  ["frames", (x) => Array.isArray(x) && x.every(isProbeFrame), "a list of probe frames {nodeId, selector, via, rect}"],
  ["navigation", isNavigation, "a navigation log {events[], afterInitialLoad, reruns}"],
  ["matchedByCensus", isCountMap, "a {rule: count} map"],
  ["notMeasured", Array.isArray, "a list \u2014 the probe's reasons for unmatched nodes are not used"],
  // the run it belongs to and the build it was served
  ["runId", (x) => typeof x === "string" && x !== "", "a run id (string) \u2014 the measurement is tied to no verify run"],
  ["build", isBuildIdentity, "a build identity {url, mode: vite-dev|static|unknown, assets, assetsSha256, gitHead, gitDirty} \u2014 read as build: unknown"],
  // the shipped probe's foreign tags
  ["tagsNotInExpectation", isTagsNotInExpectation, "a foreign-tag list {count, ids: [{id, elements}]}"],
  // the steps replayed, the page's overflow, the behaviour/a11y block
  ["reach", isProbeReach, "the probe's steps {steps[], sha256, source, url}"],
  ["page", isPageOverflow, "a page overflow {viewport:{w,h}, scrollWidth, clientWidth, overflowX, scrollable, offenders[]} \u2014 page overflow not measured"],
  ["behaviour", isMeasuredBehaviour, "a behaviour block {version: 1, ran: true, checks: [{id, status: pass|fail|warn|not-run|unsupported, detail}], \u2026} or {version: 1, ran: false, why} \u2014 behaviour/a11y not reported"],
  // the visual diff (informational)
  ["visual", isMeasuredVisual, "a visual block {version: 1, ran: true, differingPct, shiftTolerantPct, regions: [\u2026], \u2026} or {version: 1, ran: false, why} \u2014 the visual diff not reported"]
];
function isMeasuredCore(x) {
  return isObj(x) && optArrayOf(x.nodes, (n) => isObj(n) && typeof n.nodeId === "string") && optArrayOf(x.components, anyObject) && optArrayOf(x.interactions, anyObject) && (x.artifacts === void 0 || Array.isArray(x.artifacts)) && optStr(x.mode) && optStr(x.expectationSha256);
}
function isVerifyMeasured(x) {
  return isMeasuredCore(x) && MEASURED_EXTRAS.every(([k, ok]) => x[k] === void 0 || ok(x[k])) && (x.nodes === void 0 || Array.isArray(x.nodes) && x.nodes.every((n) => !isObj(n) || n.unmeasured === void 0 || isReasonMap(n.unmeasured)));
}
isVerifyMeasured.expected = "probe measurements: an object whose `nodes` (each {nodeId, styles}), `components`, `interactions` and `artifacts`, when present, are arrays";
function isEvidence(x) {
  return isObj(x) && typeof x.nodeId === "string";
}
function isInteractionEvidenceList(x) {
  return Array.isArray(x) && x.every(isEvidence);
}
isInteractionEvidenceList.expected = "interaction evidence: a JSON array of {nodeId, trigger, ok, selector, selectorCount, detail}";
function isMeasuredComponentList(x) {
  return Array.isArray(x) && x.every((c) => isObj(c) && optStr(c.setName) && optStr(c.name) && optStr(c.nodeId) && (c.present === void 0 || typeof c.present === "boolean"));
}
isMeasuredComponentList.expected = "component evidence: a JSON array of {setName|nodeId, present: true|false}";
function isVerifyReport(x) {
  return isObj(x) && optStr(x.schema) && optStr(x.verdict) && optStr(x.screen) && optStr(x.nodeId) && optStr(x.headline) && (x.why === void 0 || isStringArray(x.why)) && (x.integrity === void 0 || isStringArray(x.integrity)) && optArrayOf(x.deltas, anyObject) && optObj(x.inputs);
}
isVerifyReport.expected = "a verify report (the verify-screen script's --compare output): an object with `verdict`, `why[]`, `deltas[]`, `inputs`";
var PLAN_ARRAYS = ["files", "tokens", "components", "hidden", "anchorsSuggested", "deviations", "allowedLiterals", "waivers", "descopes"];
var PLAN_OBJECTS = ["anchors", "verification", "counts"];
var PLAN_STRINGS = ["schema", "screen", "screenName", "nodeId", "route", "file", "exportedAt", "status"];
function planProblem(x) {
  if (!isObj(x)) return "is not a plan (the file holds " + (Array.isArray(x) ? "an array" : x === null ? "null" : typeof x) + ", not an object)";
  for (const k of PLAN_ARRAYS) if (x[k] !== void 0 && !Array.isArray(x[k])) return `is not a valid plan: \`${k}\` must be an array`;
  for (const k of PLAN_OBJECTS) if (x[k] !== void 0 && !isObj(x[k])) return `is not a valid plan: \`${k}\` must be an object`;
  for (const k of PLAN_STRINGS) if (x[k] !== void 0 && x[k] !== null && typeof x[k] !== "string") return `is not a valid plan: \`${k}\` must be a string`;
  if (x.files !== void 0 && !isStringArray(x.files)) return "is not a valid plan: `files` must be an array of paths (strings)";
  for (const k of ["tokens", "components", "allowedLiterals", "deviations", "hidden", "anchorsSuggested", "waivers", "descopes"]) {
    const list = x[k];
    if (Array.isArray(list) && !list.every(isObj)) return `is not a valid plan: every \`${k}\` entry must be an object`;
  }
  if (Array.isArray(x.tokens) && !x.tokens.every((t) => isObj(t) && (t.figmaName === null || optStr(t.figmaName)))) return "is not a valid plan: a `tokens` row's `figmaName` must be a string";
  if (Array.isArray(x.components) && !x.components.every((c) => isObj(c) && typeof c.name === "string")) return "is not a valid plan: every `components` row needs its `name`";
  if (isObj(x.anchors) && !Object.values(x.anchors).every(isObj)) return "is not a valid plan: every `anchors` entry must be an object";
  if (x.auditGate !== void 0 && x.auditGate !== null && !isObj(x.auditGate)) return "is not a valid plan: `auditGate` must be an object or null";
  if (x.target !== void 0 && x.target !== null && typeof x.target !== "string" && !isObj(x.target)) return "is not a valid plan: `target` must be a profile name, an object or null";
  if (x.tagging !== void 0 && x.tagging !== null && !(isObj(x.tagging) && (x.tagging.off === void 0 || typeof x.tagging.off === "boolean") && optStr(x.tagging.reason))) return 'is not a valid plan: `tagging` must be {"off": true, "reason": "\u2026"}';
  if (Array.isArray(x.tokens) && !x.tokens.every((t) => isObj(t) && optStr(t.acknowledged))) return "is not a valid plan: a `tokens` row's `acknowledged` must be a string (the reason)";
  if (isObj(x.verification) && x.verification.hook !== void 0 && !isObj(x.verification.hook)) return "is not a valid plan: `verification.hook` must be an object";
  for (const k of ["navigate", "interactions"]) if (x[k] !== void 0 && !Array.isArray(x[k])) return `is not a valid plan: \`${k}\` must be an array`;
  return null;
}
function isPlan(x) {
  return planProblem(x) === null;
}
isPlan.expected = "a plan (started by the plan-skeleton script): an object whose files/tokens/components/deviations are arrays of objects and whose anchors/verification are objects";
var reqStr = (v) => typeof v === "string" && v.trim() !== "";
function isPlanWaiver(x) {
  return isObj(x) && reqStr(x.nodeId) && reqStr(x.field) && x.designed !== void 0 && x.built !== void 0 && reqStr(x.exportContentSha256) && reqStr(x.reason) && reqStr(x.decidedBy) && reqStr(x.decidedAt) && (x.tolerance === void 0 || typeof x.tolerance === "number" && x.tolerance >= 0) && optStr(x.cause);
}
isPlanWaiver.expected = "a plan waiver {nodeId, field, designed, built, exportContentSha256, reason, decidedBy, decidedAt, tolerance?, cause?}";
function isPlanDescope(x) {
  return isObj(x) && reqStr(x.nodeId) && reqStr(x.trigger) && optStr(x.destinationId) && reqStr(x.exportContentSha256) && reqStr(x.reason) && reqStr(x.decidedBy) && reqStr(x.decidedAt);
}
isPlanDescope.expected = "a plan descope {nodeId, trigger, destinationId?, exportContentSha256, reason, decidedBy, decidedAt}";
function isPlanInteraction(x) {
  return isObj(x) && reqStr(x.nodeId) && reqStr(x.trigger) && isPlanExpect(x.expect) && (x.destinationId === void 0 || reqStr(x.destinationId)) && optStr(x.name);
}
isPlanInteraction.expected = "a plan interaction {nodeId, trigger, expect: dialog | url | selector:<css>, destinationId?, name?}";
function isStringRecord(x) {
  return isObj(x) && Object.values(x).every((v) => typeof v === "string");
}
isStringRecord.expected = "an object of strings";

// design-to-code/hidden.ts
var hiddenSelf = (node) => !!(node && typeof node === "object" && "hidden" in node && node.hidden);

// design-to-code/control-kind.ts
var TOGGLE_WORD = /\b(checkbox|check box|radio|switch|toggle)\b/i;
function controlKind(name) {
  const s = String(name || "");
  const toggle = TOGGLE_WORD.test(s);
  if (!toggle && /\b(select|dropdown|drop ?down|combo ?box|multi-?select|picker)\b/i.test(s.replace(/\bselect ?all\b/gi, ""))) return "select";
  if (/\b(input|text ?field|textfield|search|textarea)\b/i.test(s)) return "input";
  if (toggle) return "toggle";
  if (/\b(tab|tabs|segmented|nav ?item|navigation item)\b/i.test(s)) return "tab";
  if (/\blink\b/i.test(s)) return "link";
  if (/\b(button|btn|cta|icon ?button|chip)\b/i.test(s)) return "button";
  return null;
}
var isBoundaryKind = (a) => [a.name, a.mainComponent && a.mainComponent.setName, a.component].some((l) => {
  const k = controlKind(l);
  return k === "input" || k === "select" || k === "toggle";
});
function outermostControl(near) {
  for (let i = 0; i < near.length; i++) {
    const a = near[i];
    if (a && a.type === "INSTANCE" && isBoundaryKind(a)) return i;
  }
  for (let i = near.length - 1; i >= 0; i--) {
    const a = near[i];
    if (a && isBoundaryKind(a)) return i;
  }
  return -1;
}
var DISABLED_WORD = /^(disabled|inactive|is ?disabled)$/i;
var ON_VALUE = /^(true|yes|on)$/i;
function isDisabledLayer(layer) {
  for (const part of String(layer.mainComponent && layer.mainComponent.name || "").split(",")) {
    const [k = "", v = ""] = part.split("=").map((x) => x.trim());
    if (DISABLED_WORD.test(v) || DISABLED_WORD.test(k) && ON_VALUE.test(v)) return true;
  }
  for (const [k, v] of Object.entries(layer.props || {})) {
    if (DISABLED_WORD.test(k.trim()) && (v === true || typeof v === "string" && ON_VALUE.test(v.trim()))) return true;
    if (!layer.mainComponent && typeof v === "string" && /^disabled$/i.test(v.trim())) return true;
  }
  return false;
}

// design-to-code/color.ts
var HEX = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
function normHex(v) {
  if (typeof v !== "string") return null;
  const g = HEX.exec(v.trim())?.[1];
  if (g === void 0) return null;
  const h = g.toLowerCase();
  return "#" + (h.length <= 4 ? h.split("").map((c) => c + c).join("") : h);
}
function colorKey(v) {
  const h = normHex(v);
  return h === null ? null : h.length === 7 ? h + "ff" : h;
}
function parseHex(v) {
  const k = colorKey(v);
  if (k === null) return null;
  const n = (i) => parseInt(k.slice(i, i + 2), 16);
  return { r: n(1), g: n(3), b: n(5), a: n(7) / 255 };
}
var NUM = "[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:e[+-]?\\d+)?";
var PCT = `${NUM}%`;
var CH = `${NUM}%?`;
var CH_OR_NONE = `(?:${CH}|none)`;
var legacy = (ch) => `\\(\\s*(${ch})\\s*,\\s*(${ch})\\s*,\\s*(${ch})\\s*(?:,\\s*(${CH})\\s*)?\\)`;
var RGB_LEGACY = new RegExp(`^rgba?(?:${legacy(PCT)}|${legacy(NUM)})$`);
var RGB_MODERN = new RegExp(`^rgba?\\(\\s*(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s*(?:/\\s*(${CH_OR_NONE})\\s*)?\\)$`);
var OK = new RegExp(`^(oklab|oklch)\\(\\s*(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s*(?:/\\s*(${CH_OR_NONE})\\s*)?\\)$`);
var SRGB = new RegExp(`^color\\(\\s*srgb\\s+(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s*(?:/\\s*(${CH_OR_NONE})\\s*)?\\)$`);
function clampOpacityPct(n) {
  return Math.min(100, Math.max(0, n));
}
function composeAlpha(alpha, opacityPct) {
  return alpha * (clampOpacityPct(opacityPct) / 100);
}
function compositeOver(fg, bg) {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1
  };
}
function luminance(c) {
  const ch = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}
function contrastRatio(a, b) {
  const la = luminance(a), lb = luminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// design-to-code/design-system-dir.ts
import fs4 from "node:fs";
import path2 from "node:path";

// bridge/src/design-system-layout.ts
var DIR = "design-system";
var COMPONENTS_DIR = "components";
var TOKENS = "tokens.json";
var STYLES_PAINT = "styles.paint.json";
var STYLES_TEXT = "styles.text.json";
var STYLES_EFFECT = "styles.effect.json";
var STYLES_GRID = "styles.grid.json";
var COMPONENTS_LOCAL = "components.local.json";
var COMPONENTS_LIBRARY = "components.library.json";
var HYGIENE = "hygiene.json";
var MANIFEST = "design-system.json";
var DESIGN_SYSTEM_DIR = DIR;
var DESIGN_SYSTEM_FILES = {
  TOKENS,
  STYLES_PAINT,
  STYLES_TEXT,
  STYLES_EFFECT,
  STYLES_GRID,
  COMPONENTS_LOCAL,
  COMPONENTS_LIBRARY,
  COMPONENTS_DIR,
  HYGIENE,
  MANIFEST
};

// bridge/src/library-layout.ts
var { TOKENS: TOKENS2, STYLES_PAINT: STYLES_PAINT2, STYLES_TEXT: STYLES_TEXT2, STYLES_EFFECT: STYLES_EFFECT2, STYLES_GRID: STYLES_GRID2, HYGIENE: HYGIENE2 } = DESIGN_SYSTEM_FILES;
var COMPONENTS = "components.json";

// design-to-code/design-system-dir.ts
var { TOKENS: TOKENS3, STYLES_TEXT: STYLES_TEXT3, COMPONENTS_LOCAL: COMPONENTS_LOCAL2, COMPONENTS_LIBRARY: COMPONENTS_LIBRARY2 } = DESIGN_SYSTEM_FILES;
function readDesignSystemDir(dir) {
  const local = path2.join(dir, COMPONENTS_LOCAL2);
  const isLibrary = !fs4.existsSync(local) && fs4.existsSync(path2.join(dir, COMPONENTS));
  return {
    tokens: readOptionalDoc(path2.join(dir, TOKENS3), "design-system tokens", isTokensDoc),
    components: readOptionalDoc(isLibrary ? path2.join(dir, COMPONENTS) : local, "component catalog", isComponentsCatalog),
    componentsLibrary: readOptionalDoc(path2.join(dir, COMPONENTS_LIBRARY2), "library component catalog", isComponentsCatalog),
    stylesText: readOptionalDoc(path2.join(dir, STYLES_TEXT3), "text styles", isTextStylesDoc),
    componentsFile: isLibrary ? COMPONENTS : COMPONENTS_LOCAL2,
    isLibrary
  };
}

// design-to-code/cross-check.ts
import { parseArgs as parseArgs2 } from "node:util";

// design-to-code/slice-sources.ts
import fs5 from "node:fs";
import path3 from "node:path";
function sourcesOf(doc, docPath) {
  const out = /* @__PURE__ */ new Map();
  const add = (key, screen) => {
    if (typeof key !== "string" || !key || !screen) return;
    const list = out.get(key) || [];
    if (!list.includes(screen)) list.push(screen);
    out.set(key, list);
  };
  const base = docPath ? path3.dirname(docPath) : ".";
  for (const sl of doc && Array.isArray(doc._slices) ? doc._slices : []) {
    if (!sl) continue;
    let read = false;
    if (typeof sl.file === "string") {
      const slice = readJsonOrNull(path3.join(base, sl.file.replace(/\.json$/, ".vars.json")), isTokensDoc);
      if (slice) {
        for (const v of slice.variables || []) add(v.key, sl.screen);
        read = true;
      }
    }
    if (!read) for (const k of Array.isArray(sl.keys) ? sl.keys : []) add(k, sl.screen);
  }
  for (const c of doc && Array.isArray(doc._conflicts) ? doc._conflicts : []) {
    for (const vr of c && "variants" in c && c.variants || []) for (const sc of vr.screens || []) add(vr.key, sc);
  }
  if (!out.size && docPath && /\.vars\.json$/.test(docPath)) {
    for (const v of doc && doc.variables || []) add(v.key, path3.basename(docPath, ".vars.json"));
  }
  return out;
}
function variablesContext(screenFiles, varsFile, opts) {
  const invalid = [];
  const readTokens = (f) => {
    if (!f) return null;
    const r = readJson(f, isTokensDoc);
    if ("doc" in r) return r.doc;
    if (!r.missing) invalid.push({ file: f, error: r.error });
    return null;
  };
  const files = screenFiles || [];
  const own = files.map((f) => readTokens(String(f).replace(/\.json$/, ".vars.json")));
  let variablesPath = varsFile || null;
  const firstFile = files[0];
  if (!variablesPath && firstFile !== void 0) {
    const exportRoot = path3.resolve(path3.dirname(firstFile), "..", "..");
    const rootVars = path3.join(exportRoot, "variables.json");
    const sibling = path3.join(path3.dirname(firstFile), "variables.json");
    if (fs5.existsSync(rootVars)) variablesPath = rootVars;
    else if (fs5.existsSync(sibling)) variablesPath = sibling;
    else if (opts && opts.sliceFallback && files.length === 1 && own[0]) variablesPath = String(firstFile).replace(/\.json$/, ".vars.json");
  }
  const variablesDoc = readTokens(variablesPath);
  let staleLegacy = null;
  if (firstFile !== void 0) {
    const legacy2 = path3.join(path3.resolve(path3.dirname(firstFile), "..", ".."), "..", "variables.json");
    if (fs5.existsSync(legacy2) && path3.resolve(legacy2) !== path3.resolve(variablesPath || "")) staleLegacy = legacy2;
  }
  return { own, variablesPath, variablesDoc, sliceSources: variablesDoc ? sourcesOf(variablesDoc, variablesPath) : null, staleLegacy, invalid };
}

// bridge/src/project-layout.ts
import fs6 from "node:fs";
import path4 from "node:path";
var DESIGN_DIR = "design";
var EXPORT_SUBDIR = "export";
var EXPORT_DIR = path4.join(DESIGN_DIR, EXPORT_SUBDIR);
var TARGET_FILE = path4.join(DESIGN_DIR, "target.json");
var MAP_FILE = path4.join(DESIGN_DIR, "codeconnect.local.json");
var LEGACY_MAP_FILE = "codeconnect.local.json";
var PLAN_DIR = path4.join(DESIGN_DIR, "plan");
var AUDIT_DIR = path4.join(DESIGN_DIR, "audit");
var VERIFY_DIR = path4.join(DESIGN_DIR, "verify");
var TAILWIND_SOURCE_NOT_NOTE = `Tailwind v4 scans every file git does not ignore, ${DESIGN_DIR}/ included, so class names quoted in ${DESIGN_DIR}/ notes, audits and plans end up in your CSS. Next to \`@import "tailwindcss";\` in your CSS entry, add \`@source not "<path from that CSS file to ${DESIGN_DIR}/>";\` (e.g. \`@source not "../${DESIGN_DIR}";\` for src/app.css) \u2014 Tailwind v4.1+`;
var VITE_WATCH_IGNORED_NOTE = `With Tailwind v4's automatic source detection, rewriting an existing text file under ${DESIGN_DIR}/ (a re-export, a verify report) makes Vite fully reload the open page. Either add \`server: { watch: { ignored: ['**/${DESIGN_DIR}/**'] } }\` in vite.config (merge it with any existing \`server.watch\` options), or the Tailwind \`@source not\` above \u2014 both stop it`;
var slashed = (p) => p.split(path4.sep).join("/");
var VERIFY_GITIGNORE_NOTE = `${slashed(VERIFY_DIR)}/ is regenerated on every verify run (measurements, screenshots, reports) \u2014 consider adding \`${slashed(VERIFY_DIR)}/\` to .gitignore; decisions live in ${slashed(PLAN_DIR)}/ and are not affected`;
var EXPORT_MARKERS = ["pages", "design-system", "design-system.json", "variables.json", "assets", "libraries"];
function looksLikeExportDir(dir) {
  try {
    if (!fs6.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return EXPORT_MARKERS.some((m) => fs6.existsSync(path4.join(dir, m)));
}
function findExportDir(cwd) {
  const modern = path4.join(cwd, EXPORT_DIR);
  const legacy2 = path4.join(cwd, DESIGN_DIR);
  const modernExists = looksLikeExportDir(modern);
  const legacyExists = looksLikeExportDir(legacy2);
  if (modernExists) return { dir: modern, layout: "export-subdir", rel: EXPORT_DIR, parallelLegacy: legacyExists };
  if (legacyExists) return { dir: legacy2, layout: "legacy-flat", rel: DESIGN_DIR };
  return { dir: modern, layout: "none", rel: EXPORT_DIR };
}
function findMapFile(cwd) {
  const modern = path4.join(cwd, MAP_FILE);
  if (fs6.existsSync(modern)) return { file: modern, rel: MAP_FILE, legacy: false };
  const legacy2 = path4.join(cwd, LEGACY_MAP_FILE);
  if (fs6.existsSync(legacy2)) return { file: legacy2, rel: LEGACY_MAP_FILE, legacy: true };
  return { file: modern, rel: MAP_FILE, legacy: false, missing: true };
}

// design-to-code/cross-check.ts
var SEVERITY_ORDER = { blocker: 0, warning: 1, info: 2 };
var ABSURD_NUMBER = 1e4;
var WRONG_CATALOG_PCT = 5;
function walk(node, fn) {
  if (!node || typeof node !== "object") return;
  if (hiddenSelf(node)) return;
  fn(node);
  for (const c of node.children || []) walk(c, fn);
}
function crossCheck(input) {
  const screens = input.screens || [];
  const variables = input.variables || null;
  const tokens = input.tokens || null;
  const components = input.components || null;
  const componentsLibrary = input.componentsLibrary || null;
  const stylesText = input.stylesText || null;
  const catFile = input.componentsFile || "components.local.json";
  const LIST_LIBRARIES = "`dtwin list libraries --client <the screen's file>` (MCP: `figma_list_libraries`)";
  const EXPORT_LIBRARY = input.designSystemIsLibrary ? 'check that the library export you passed is the one the screen consumes (a DUPLICATED library file re-keys everything \u2014 re-export the original with `dtwin pull --as-library "<name>"`, CLI only)' : 'export it with `dtwin pull --as-library "<name>"` (CLI only \u2014 the MCP server has no library export)';
  const findings = [];
  const notChecked = [];
  const push = (severity, code, message, extra) => {
    findings.push(Object.assign({ severity, code, message }, extra || {}));
  };
  const usedTokenNames = /* @__PURE__ */ new Map();
  const instances = [];
  const fonts = /* @__PURE__ */ new Map();
  const textStyles = /* @__PURE__ */ new Map();
  const resolvedModes = /* @__PURE__ */ new Map();
  for (const s of screens) {
    const label = s.label || screenExportOf(s.doc)?.screen || "screen";
    for (const root of screenRoots(s.doc)) {
      if (root && root.resolvedModes) {
        for (const [coll, mode] of Object.entries(root.resolvedModes)) {
          getOrInit(resolvedModes, coll, () => /* @__PURE__ */ new Set()).add(mode);
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
  const visible = [];
  screens.forEach((s) => {
    const label = s.label || screenExportOf(s.doc)?.screen || "screen";
    for (const i of visibleInstances(s.doc, label)) {
      visible.push(i);
      instances.push({ screen: label, nodeId: i.nodeId, name: i.layer, ...ifDefined("key", i.key), ...ifDefined("setKey", i.setKey), setName: i.name, propNames: Object.keys(i.props || {}) });
    }
  });
  const dsCollByKey = /* @__PURE__ */ new Map();
  const dsCollByName = /* @__PURE__ */ new Map();
  for (const c of tokens && tokens.collections || []) {
    if (c.key) dsCollByKey.set(c.key, c);
    if (c.name) dsCollByName.set(alnumKey(c.name), c);
  }
  const screenColls = variables && variables.collections || [];
  let foreignPatch = null;
  if (!tokens) {
    notChecked.push(
      "collection provenance \u2014 no design-system tokens.json was given, so nothing could verify that the screen's variables come from the design system you exported. Run `dtwin pull --design-system` and pass it."
    );
  } else if (!screenColls.length) {
    notChecked.push(
      input.variablesPath ? `collection provenance \u2014 ${input.variablesPath} was checked but carries no collections for this screen, so its own token library is unknown.` : `collection provenance \u2014 no variables.json was found (looked in design/export/variables.json), so the screen's own token library is unknown.`
    );
  } else {
    const foreign = [];
    for (const c of screenColls) {
      if (c.key && dsCollByKey.has(c.key)) continue;
      const twin = dsCollByName.get(alnumKey(c.name));
      foreign.push({ name: c.name, ...ifDefined("key", c.key), ...ifDefined("twinKey", twin && twin.key), ...ifDefined("twinName", twin && twin.name) });
    }
    if (foreign.length) {
      const sameNameDifferentKey = foreign.filter((f) => f.twinKey);
      const all = foreign.length === screenColls.length;
      foreignPatch = {
        foreign,
        head: `${foreign.length} of ${screenColls.length} variable collection(s) the screen binds are NOT in the design-system export \u2014 the screen consumes a DIFFERENT library than the one you pulled. ` + (sameNameDifferentKey.length ? `${sameNameDifferentKey.length} of them carry a design-system collection's name under a different key (${sameNameDifferentKey.slice(0, 3).map((f) => `'${f.name}'`).join(", ")}), which is the signature of a DUPLICATED Figma file: duplicating a library re-keys everything while leaving names and values identical. ` : "") + `Names and values may still line up (check the collisions below), but nothing here is the same variable. `,
        tail: `Only to find the owning file: run ${LIST_LIBRARIES} \u2014 variable collections are the ONE thing Figma attributes to a library by name \u2014 then open that file and ${EXPORT_LIBRARY}.`,
        at: findings.length
      };
      push(
        "warning",
        "foreign-token-library",
        foreignPatch.head + foreignPatch.tail,
        { collections: foreign, confirm: `${all ? "None" : `Only ${screenColls.length - foreign.length} of ${screenColls.length}`} of the screen's variable collections are in the design system you passed \u2014 is it the library this screen uses? Until confirmed, values come from the screen's own .vars.json.` }
      );
    } else {
      push("info", "token-library-matches", `all ${screenColls.length} variable collection(s) the screen binds resolve to the design-system export by key.`, {});
    }
  }
  const dsVarByName = /* @__PURE__ */ new Map();
  for (const v of tokens && tokens.variables || []) if (v.name) dsVarByName.set(v.name, v);
  const sliceSources = input.sliceSources || null;
  const labels = screens.map((s) => s.label || screenExportOf(s.doc)?.screen || "screen");
  const own = screens.map((s) => s && s.vars && Array.isArray(s.vars.variables) ? s.vars.variables : null);
  let varScope = "own";
  let screenVars = [];
  const none = [];
  if (own.length && own.every((o) => !!o)) {
    screenVars = none.concat(...own);
  } else if (variables && sliceSources && sliceSources.size) {
    varScope = "union-by-source";
    screenVars = (variables && variables.variables || []).filter((v) => {
      const from = v.key ? sliceSources.get(v.key) : void 0;
      return !from || from.some((sc) => labels.includes(sc));
    });
  } else {
    varScope = "union";
    screenVars = variables && variables.variables || [];
  }
  const screenVarsByName = /* @__PURE__ */ new Map();
  for (const v of screenVars) {
    if (!v || !v.name) continue;
    const list = screenVarsByName.get(v.name);
    if (!list) screenVarsByName.set(v.name, [v]);
    else if (!list.some((x) => x.key && x.key === v.key || !x.key && !v.key && x.collection === v.collection)) list.push(v);
  }
  const screenVarByName = new Map([...screenVarsByName].map(([n, l]) => [n, l[0]]));
  const shortKey = (v) => v && typeof v.key === "string" && v.key ? v.key.slice(0, 8) + "\u2026" : null;
  const fromWhere = (v) => {
    const sc = v && v.key && sliceSources && sliceSources.get(v.key);
    return sc && sc.length ? ` (from ${sc.join(", ")})` : "";
  };
  function flatten(v) {
    const out = {};
    for (const [mode, val] of Object.entries(v && v.values || {})) {
      out[mode] = val && typeof val === "object" ? "aliasOf" in val ? "-> " + val.aliasOf : JSON.stringify(val) : String(val);
    }
    return out;
  }
  function valueSet(v) {
    return new Set(Object.values(flatten(v)));
  }
  function sameResolution(a, b) {
    const fa = flatten(a), fb = flatten(b);
    const shared = Object.keys(fa).filter((m) => m in fb);
    if (shared.length) return shared.every((m) => fa[m] === fb[m]);
    const sa = valueSet(a), sb = valueSet(b);
    if (!sa.size || !sb.size) return null;
    for (const x of sa) if (sb.has(x)) return null;
    return false;
  }
  if (foreignPatch) {
    const fp = foreignPatch;
    const foreignNames = new Set(fp.foreign.map((f2) => f2.name));
    const foreignKeys = new Set(fp.foreign.map((f2) => f2.key).filter((k) => !!k));
    const screenKeys = new Set(screenColls.map((c) => c.key).filter((k) => !!k));
    const sharedNames = new Set(screenColls.filter((c) => c.key && dsCollByKey.has(c.key) && foreignNames.has(c.name)).map((c) => c.name));
    const nameMap = { agree: 0, differ: 0, undecidable: 0, absent: 0 };
    let ambiguous = 0;
    const seen = /* @__PURE__ */ new Set();
    for (const v of screenVars) {
      if (!v || !v.name || !v.collection) continue;
      const byKey = !!v.collectionKey && screenKeys.has(v.collectionKey);
      if (byKey ? !foreignKeys.has(v.collectionKey ?? "") : !foreignNames.has(v.collection)) continue;
      const id = v.key || `${v.collection}\0${v.name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!byKey && sharedNames.has(v.collection)) ambiguous++;
      const dv = dsVarByName.get(v.name);
      if (!dv) {
        nameMap.absent++;
        continue;
      }
      const r = sameResolution(v, dv);
      if (r === true) nameMap.agree++;
      else if (r === false) nameMap.differ++;
      else nameMap.undecidable++;
    }
    const n = seen.size;
    let offline = "";
    if (n) {
      offline = `Offline check (no Figma needed): of the ${n} variables in those collections, ${nameMap.agree} have a design-system variable of the same name resolving the same in every shared mode, ${nameMap.differ} resolve differently (listed as token-name-collision), ${nameMap.undecidable} cannot be compared (no shared mode), ${nameMap.absent} have no same-name variable. ` + (nameMap.differ === 0 && nameMap.agree > 0 ? `Mapping by NAME is safe for the ${nameMap.agree}: the screen's own .vars.json is the ground truth for names and values. ` : "") + (nameMap.agree === 0 && nameMap.absent === n ? `None of them exists here by name \u2014 this is not the screen's library; pull the one it uses. ` : "") + (ambiguous ? `(${ambiguous} of them come from a collection whose name a design-system collection also has \u2014 this export predates collection keys on variables; re-pull to tell them apart.) ` : "");
    }
    const f = findings[fp.at];
    if (f) {
      f.message = fp.head + offline + fp.tail;
      f.nameMap = ambiguous ? { ...nameMap, ambiguous } : nameMap;
    }
  }
  if (tokens && screenVarByName.size) {
    const collisions = [], missing = [];
    for (const [name, list] of screenVarsByName) {
      const dv = dsVarByName.get(name);
      if (!dv) {
        let near = null;
        for (const dname of dsVarByName.keys()) if (alnumKey(dname) === alnumKey(name) && dname !== name) {
          near = dname;
          break;
        }
        if (usedTokenNames.has(name) || near) missing.push({ name, near });
        continue;
      }
      for (const sv of list) {
        if (sameResolution(sv, dv) === false) {
          collisions.push({ name, ...ifDefined("key", sv.key), twins: list, sv, screen: flatten(sv), designSystem: flatten(dv), usedAt: (usedTokenNames.get(name) || []).slice(0, 3) });
        }
      }
    }
    const dsByNorm = /* @__PURE__ */ new Map();
    for (const [dname, dv] of dsVarByName) {
      const k = alnumKey(dname);
      getOrInit(dsByNorm, k, () => []).push({ name: dname, v: dv });
    }
    for (const [name, list] of screenVarsByName) {
      if (dsVarByName.has(name)) continue;
      for (const cand of dsByNorm.get(alnumKey(name)) || []) {
        for (const sv of list) {
          if (sameResolution(sv, cand.v) === false) {
            collisions.push({ name, ...ifDefined("key", sv.key), twins: list, sv, alsoKnownAs: cand.name, screen: flatten(sv), designSystem: flatten(cand.v), usedAt: (usedTokenNames.get(name) || []).slice(0, 3) });
          }
        }
      }
    }
    const scopeNote = varScope === "own" ? "" : varScope === "union-by-source" ? " (read from the merged variables.json, restricted to the variables its slice records for this screen \u2014 pass the screen's .vars.json to be exact)" : " (read from the MERGED variables.json: this screen's own .vars.json was not available, so this may be another screen's variable \u2014 check its key)";
    for (const c of collisions) {
      const twinNote = c.twins.length > 1 ? ` This screen's own variables include ${c.twins.length} DIFFERENT variables called '${c.name}': ` + c.twins.map((t) => `${shortKey(t) ? "key " + shortKey(t) : "'" + (t.collection || "") + "'"} = ${JSON.stringify(flatten(t))}${fromWhere(t)}`).join(" vs ") + ` \u2014 only the one(s) listed as colliding differ from the design system.` : "";
      const used = c.usedAt.length > 0;
      const message = `The screen's '${c.name}'${shortKey(c.sv) ? ` (key ${shortKey(c.sv)})` : ""} and the design system's '${c.alsoKnownAs || c.name}' ${c.alsoKnownAs ? "differ only by case or punctuation" : "share a name"} but resolve DIFFERENTLY: screen ${JSON.stringify(c.screen)} vs design system ${JSON.stringify(c.designSystem)}` + (Object.keys(c.screen).some((m) => m in c.designSystem) ? ". " : " \u2014 no mode name is shared and the two value sets are disjoint. ") + `Slugging the name onto the existing token would silently apply the wrong value \u2014 namespace the screen's copy, or confirm which library is authoritative.` + twinNote + scopeNote;
      const extra = { token: c.name, ...ifDefined("key", c.key), ...ifDefined("alsoKnownAs", c.alsoKnownAs), screenValue: c.screen, designSystemValue: c.designSystem, usedAt: c.usedAt, scope: varScope };
      if (used) push("blocker", "token-name-collision", message, extra);
      else push("warning", "token-name-collision", message, { ...extra, confirm: `'${c.name}' has different values here and in the design system, but no visible layer on this screen binds it \u2014 which one is authoritative if it is used later?` });
    }
    if (variables && varScope !== "union") {
      const mine = new Set(screenVars.map((v) => v.key).filter(Boolean));
      const unionByName = /* @__PURE__ */ new Map();
      for (const v of variables && variables.variables || []) {
        if (!v || !v.name || !v.key) continue;
        getOrInit(unionByName, v.name, () => /* @__PURE__ */ new Map()).set(v.key, v);
      }
      for (const [name, byKey] of unionByName) {
        if (byKey.size < 2) continue;
        const all = [...byKey.values()];
        const others = all.filter((v) => !mine.has(v.key));
        if (!others.length) continue;
        if (new Set(all.flatMap((v) => Object.values(flatten(v)))).size <= 1) continue;
        if (all.every((v) => JSON.stringify(flatten(v)) === JSON.stringify(flatten(all[0])))) continue;
        const ours = all.filter((v) => mine.has(v.key));
        push(
          "info",
          "token-name-collision-elsewhere",
          `'${name}' is ${all.length} different variables in the merged variables.json \u2014 ` + all.map((v) => `key ${shortKey(v)} = ${JSON.stringify(flatten(v))}${fromWhere(v)}`).join(" vs ") + ". " + (ours.length ? `THIS screen's own variables carry only key ${ours.map(shortKey).join(", ")}, so the ambiguity belongs to ${[...new Set(others.flatMap((v) => sliceSources && v.key && sliceSources.get(v.key) || []))].join(", ") || "another screen"} \u2014 do not change this screen's value to match it.` : `THIS screen carries none of them.`) + ` Generate this screen's theme from its own .vars.json (or design-system/tokens.json), not from the union.`,
          { token: name, keys: all.map((v) => v.key), mine: ours.map((v) => v.key) }
        );
      }
    }
    if (missing.length) {
      push(
        "warning",
        "token-absent-from-design-system",
        `${missing.length} token name(s) the screen binds do not exist in the design-system export` + (missing.some((m) => m.near) ? ` (${missing.filter((m) => m.near).length} differ from a design-system name only by case or punctuation \u2014 e.g. ` + missing.filter((m) => m.near).slice(0, 2).map((m) => `'${m.name}' vs '${m.near}'`).join(", ") + ")" : "") + `: ${missing.slice(0, 8).map((m) => "'" + m.name + "'").join(", ")}${missing.length > 8 ? ", \u2026" : ""}. Build these as literals with a recorded decision \u2014 do not invent a design-system token for them.`,
        { tokens: missing }
      );
    }
  }
  if (variables || varScope === "own") {
    const dangling = [];
    for (const name of usedTokenNames.keys()) {
      if (screenVarByName.has(name) || dsVarByName.has(name)) continue;
      dangling.push(name);
    }
    if (dangling.length) {
      push(
        "warning",
        "unresolvable-token",
        `${dangling.length} token name(s) are bound by a node but defined in NEITHER design/export/variables.json nor the design-system export: ${dangling.slice(0, 8).map((n) => "'" + n + "'").join(", ")}${dangling.length > 8 ? ", \u2026" : ""}. Re-pull the screen (variables.json now merges, so nothing is lost) or treat the node's raw value as authoritative.`,
        { tokens: dangling }
      );
    }
  }
  let rekey = null;
  let proposals = [];
  const coverage = { instances: instances.length, distinct: 0, matchedByKey: 0, matchedByLocalKey: 0, matchedByName: 0, ambiguousName: 0, unmatched: 0, pct: null, localPct: null, entries: [] };
  const localComps = components && components.components || [];
  const localKeys = new Set(localComps.map((c) => c.key).filter((k) => !!k));
  const catalog = localComps.concat(componentsLibrary && componentsLibrary.components || []);
  if (!catalog.length) {
    notChecked.push(`component coverage \u2014 no ${catFile} was given, so every instance counts as new by default.`);
  } else if (!instances.length) {
    notChecked.push("component coverage \u2014 the screen export contains no INSTANCE nodes to compare.");
  } else {
    const byKey = /* @__PURE__ */ new Map();
    for (const c of catalog) if (c.key) byKey.set(c.key, c);
    rekey = localComps.length ? matchByNameAndSignature(visible, components, componentsLibrary) : null;
    const rowByName = new Map((rekey ? rekey.rows : []).map((r) => [r.name, r]));
    const distinct = /* @__PURE__ */ new Map();
    for (const i of instances) {
      const id = i.setKey || i.key || "name:" + alnumKey(i.setName);
      getOrInit(distinct, id, () => Object.assign({ count: 0 }, i)).count++;
    }
    coverage.distinct = distinct.size;
    for (const i of distinct.values()) {
      const byKeyHit = i.setKey && byKey.get(i.setKey) || i.key && byKey.get(i.key);
      if (byKeyHit) {
        coverage.matchedByKey++;
        const local = !!byKeyHit.key && localKeys.has(byKeyHit.key);
        if (local) coverage.matchedByLocalKey++;
        coverage.entries.push({ setName: i.setName, ...ifDefined("key", i.setKey || i.key), matchedBy: "key", scope: local ? "local" : "library", verified: true, catalogName: byKeyHit.name, instances: i.count });
        continue;
      }
      const row = rowByName.get(i.setName);
      const verdict = row ? nameVerdict(row) : null;
      const matched = row && verdict && verdict.status === "matched" ? row.match : null;
      if (row && matched) {
        coverage.matchedByName++;
        const cat = localComps.find((c) => matched.key ? c.key === matched.key : matched.id !== void 0 && c.id === matched.id);
        const props = Object.keys(cat && cat.props || {}).map((p) => alnumKey(String(p).split("#")[0]));
        const hit = i.propNames.filter((p) => props.includes(alnumKey(String(p).split("#")[0]))).length;
        coverage.entries.push({
          setName: i.setName,
          ...ifDefined("key", i.setKey || i.key),
          matchedBy: "name",
          verified: false,
          catalogName: matched.name,
          ...ifDefined("catalogKey", matched.key),
          ...ifDefined("evidence", row.evidence),
          propOverlap: `${hit}/${i.propNames.length}`,
          instances: i.count
        });
      } else if (row && verdict && verdict.status === "ambiguous") {
        coverage.ambiguousName++;
        coverage.entries.push({ setName: i.setName, ...ifDefined("key", i.setKey || i.key), matchedBy: null, ambiguous: true, candidates: (row.candidates || []).length, reason: verdict.reason, instances: i.count });
      } else {
        coverage.unmatched++;
        coverage.entries.push({
          setName: i.setName,
          ...ifDefined("key", i.setKey || i.key),
          matchedBy: null,
          verified: false,
          reason: verdict ? verdict.reason : `no ${catFile} to match names against (a components.library.json name alone is not a match)`,
          instances: i.count
        });
      }
    }
    coverage.pct = Math.round(coverage.matchedByKey / coverage.distinct * 100);
    coverage.localPct = Math.round(coverage.matchedByLocalKey / coverage.distinct * 100);
    const rekeyedBy = rekey && coverage.localPct <= WRONG_CATALOG_PCT && isRekeyed(rekey) ? rekey : null;
    const rekeyed = !!rekeyedBy;
    coverage.rekey = rekey ? Object.assign({ rekeyed }, rekey.summary) : null;
    const proposedNames = new Set(rekeyedBy ? rekeyedBy.proposals.map((r) => r.name) : []);
    const buckets = { localKey: 0, libraryKey: 0, proposed: 0, nameOnly: 0, ambiguous: 0, newWork: 0 };
    for (const e of coverage.entries) {
      const b = e.matchedBy === "key" ? e.scope === "local" ? "localKey" : "libraryKey" : proposedNames.has(e.setName) ? "proposed" : e.matchedBy === "name" ? "nameOnly" : e.ambiguous ? "ambiguous" : "newWork";
      e.bucket = b;
      buckets[b]++;
    }
    coverage.buckets = buckets;
    const visibleSets = new Set(instances.map((i) => i.setKey || i.key || "name:" + alnumKey(i.setName)));
    const hiddenOnly = /* @__PURE__ */ new Set();
    const everyInstance = (n) => {
      if (!n || typeof n !== "object") return;
      if (n.type === "INSTANCE" && n.mainComponent) {
        const mc = n.mainComponent, id = mc.setKey || mc.key || "name:" + alnumKey(mc.setName || mc.name);
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
        `0 of ${s.names} component(s) on this screen resolve to ${catFile} by key, but ${s.proposed} of the ${s.withCandidates} whose NAME is in the catalog also match it by prop signature (variant axes + values, prop names + types)${s.remote ? `, and ${s.remote} of the ${s.instances} visible instance(s) say remote:true` : ""}. That is not a foreign library \u2014 it is the SAME components under new keys: one or both Figma files are duplicates (duplicating a file re-mints every component key), or the library was re-published. Proposed matches (confirm each before reuse \u2014 nothing is auto-accepted): ` + props.slice(0, 12).map((r) => `'${r.name}' \u2192 ${r.catalog ? r.catalog.id : "?"}${r.evidence === "name+no-props" ? " (no props to compare \u2014 weaker)" : ""}${r.tie === "duplicate-definitions" ? " (duplicate definitions, harmless tie)" : ""}${r.alreadyMapped ? " (already mapped)" : ""}`).join(", ") + (props.length > 12 ? `, \u2026 (${props.length} in all \u2014 see componentProposals)` : "") + `. ` + // Labels only — what is already in the map, and what other exported screens share
        (mapped ? toConfirm ? `${props.length} proposals, ${mapped} already mapped in the component map \u2014 confirm only the other ${toConfirm}. ` : `All ${props.length} proposals are already mapped in the component map \u2014 nothing is left to confirm. ` : "") + (shared ? `${shared} of the proposals to confirm are on other exported screens too (shared chrome) \u2014 confirm those once. ` : "") + `${residual.length} name(s) are not in ${catFile}` + (buckets.libraryKey ? ` \u2014 of the table's rows, ${buckets.libraryKey} are third-party components.library.json key matches and ${buckets.newWork} new work` : ` and stay new work`) + (residual.length ? ` (${residual.slice(0, 5).map((r) => `'${r.name}'`).join(", ")}${residual.length > 5 ? ", \u2026" : ""})` : "") + `. To use them: show the user the list, set "confirmed": true on each accepted entry of componentProposals in this report's JSON, then run the map-bootstrap script (\`<${catFile}> --out design/codeconnect.local.json --from-proposals <this report>.json\`) \u2014 it stubs ONLY the confirmed ones, keyed by the screen's own instance key.`,
        { rekey: s, proposals: props.length, confirm: `${toConfirm} component(s) match the catalog by name and prop signature but not by key (a duplicated or re-published file)${mapped ? ` \u2014 ${mapped} more are already mapped` : ""} \u2014 confirm the proposed matches before reusing them as mappings.` }
      );
    } else if (coverage.localPct <= WRONG_CATALOG_PCT) {
      push(
        "warning",
        "catalog-covers-nothing",
        `${coverage.matchedByLocalKey} of ${coverage.distinct} component(s) used on this screen (${coverage.localPct}%) are in ${catFile} by key \u2014 the catalog you exported is not the library this screen is built from. ` + (coverage.matchedByKey > coverage.matchedByLocalKey ? `${coverage.matchedByKey - coverage.matchedByLocalKey} more match components.library.json, which only means both files consume the same third-party set. ` : "") + (coverage.matchedByName ? `${coverage.matchedByName} match BY NAME only and are marked unverified: a lead, not a mapping. ` : "") + (coverage.ambiguousName ? `${coverage.ambiguousName} more share a name with SEVERAL catalog entries ('Component 1'-class names) and are deliberately left unmatched. ` : "") + `A "318/318 mapped" count measures the catalog against itself and means nothing here. To find the owning library: open any instance in Figma and use right-click > "Go to main component" \u2014 it jumps to the file that defines it. Then connect that file and ${EXPORT_LIBRARY}. Until then every instance is correctly a \`verdict:"new"\` build, not a port of the catalog.` + (rekey && rekey.summary.withCandidates ? ` (Checked for the duplicated-file case too: only ${rekey.summary.proposedWithSignature} of the ${rekey.summary.withCandidates} name twin(s) also agree on prop signature \u2014 too few to call it the same library under new keys.)` : ""),
        { coverage: { distinct: coverage.distinct, byLocalKey: coverage.matchedByLocalKey, byKey: coverage.matchedByKey, byName: coverage.matchedByName, ambiguousName: coverage.ambiguousName, localPct: coverage.localPct }, confirm: `Only ${coverage.localPct}% of this screen's components are in ${catFile} by key \u2014 is that the component library this screen is built from? Until confirmed, every instance is new work.` }
      );
    } else if (coverage.localPct < 100) {
      push(
        "warning",
        "partial-catalog-coverage",
        `${coverage.matchedByLocalKey} of ${coverage.distinct} component(s) on this screen (${coverage.localPct}%) resolve to ${catFile} by key` + (coverage.matchedByName ? `, ${coverage.matchedByName} more by name only (unverified)` : "") + `. The rest are new work: ${coverage.entries.filter((e) => !e.matchedBy).slice(0, 6).map((e) => "'" + e.setName + "'").join(", ")}.`,
        { coverage: { distinct: coverage.distinct, byLocalKey: coverage.matchedByLocalKey, byKey: coverage.matchedByKey, byName: coverage.matchedByName, localPct: coverage.localPct } }
      );
    } else {
      push("info", "catalog-covers-screen", `all ${coverage.distinct} component(s) on this screen resolve to ${catFile} by key.`, {});
    }
    const named = coverage.entries.filter((e) => e.matchedBy === "name" && !proposedNames.has(e.setName));
    if (named.length) {
      push(
        "info",
        "name-matched-components",
        `${named.length} component(s) have no key in the catalog but DO have an exact name twin there whose prop signature agrees: ` + named.slice(0, 10).map((e) => `'${e.setName}' (${e.evidence === "name+no-props" ? "no props to compare" : `props ${e.propOverlap}`})`).join(", ") + (named.length > 10 ? `, \u2026` : "") + `. Mapped BY NAME, UNVERIFIED \u2014 confirm one with "Go to main component" before reusing any of their code; if that one instance points at the catalog's file, the rest almost certainly do too.`,
        { components: named.map((e) => ({ setName: e.setName, ...ifDefined("catalogName", e.catalogName), ...ifDefined("catalogKey", e.catalogKey), ...ifDefined("propOverlap", e.propOverlap), verified: false })) }
      );
    }
    const amb = coverage.entries.filter((e) => e.ambiguous && !proposedNames.has(e.setName));
    const firstAmb = amb[0];
    if (firstAmb) {
      push(
        "warning",
        "ambiguous-component-name",
        `${amb.length} component(s) share their name with SEVERAL catalog entries, and no prop signature picks one of them, so they were left unmatched on purpose: ` + amb.slice(0, 8).map((e) => `'${e.setName}' (${e.candidates} candidates)`).join(", ") + (amb.length > 8 ? ", \u2026" : "") + `. Generic names like these are what the design system's own hygiene report flags as duplicated/unnamed \u2014 binding code to one of them by name would be a guess with a 1-in-${firstAmb.candidates} chance.`,
        { components: amb.map((e) => ({ setName: e.setName, ...ifDefined("candidates", e.candidates) })) }
      );
    }
  }
  const sorted = [...fonts.entries()].sort((a, b) => b[1] - a[1]);
  const [main2, ...strays] = sorted;
  if (fonts.size > 1 && main2) {
    const [mainFamily, mainCount] = main2;
    const total = sorted.reduce((n, [, c]) => n + c, 0);
    push(
      "warning",
      "font-family-stray",
      `${total} text node(s) use ${sorted.length} different font families: ${sorted.map(([f, c]) => `${f} (${c})`).join(", ")}. '${mainFamily}' carries ${mainCount}; the rest are strays \u2014 usually a starter-kit style (Figma's Material 3 kit leaks \`material-theme/*\`) left on a layer. Ask the designer before shipping a second webfont for ${strays.reduce((n, [, c]) => n + c, 0)} node(s).`,
      { families: sorted.map(([family, count2]) => ({ family, count: count2 })) }
    );
  }
  if (stylesText && fonts.size) {
    const dsFamilies = new Set(stylesText.styles.map((s) => s.font).filter((f) => !!f));
    const foreign = [...fonts.keys()].filter((f) => dsFamilies.size && !dsFamilies.has(f));
    if (foreign.length) {
      push(
        "warning",
        "font-not-in-design-system",
        `font ${foreign.map((f) => `'${f}'`).join(", ")} appears on the screen but NO design-system text style uses it (the design system's text styles are all ${[...dsFamilies].join(", ")}). Nothing in the export declares a font file or a webfont for either, so "is it installed and licensed" is a question only the designer can answer.`,
        { fonts: foreign, designSystemFonts: [...dsFamilies] }
      );
    }
  }
  if (stylesText && stylesText.styles && textStyles.size) {
    const dsByName = new Map((stylesText.styles || []).map((s) => [s.name, s]));
    const dsNorm = /* @__PURE__ */ new Map();
    for (const s of stylesText.styles || []) dsNorm.set(alnumKey(s.name), s.name);
    const absent = [], nearMiss = [];
    for (const name of textStyles.keys()) {
      if (dsByName.has(name)) continue;
      const near = dsNorm.get(alnumKey(name));
      if (near) nearMiss.push({ name, near });
      else absent.push(name);
    }
    if (nearMiss.length) {
      push(
        "warning",
        "text-style-near-miss",
        `${nearMiss.length} text style name(s) differ from a design-system style ONLY by case or punctuation: ` + nearMiss.map((n) => `'${n.name}' vs '${n.near}'`).join(", ") + `. That is the exact near-miss a name-based mapping binds wrongly and silently. Confirm they are the same style before reusing it.`,
        { styles: nearMiss, confirm: `${nearMiss.map((n) => `'${n.name}' = '${n.near}'`).join(", ")} \u2014 the same style? Until confirmed, use the screen's own text values, not the design-system style.` }
      );
    }
    if (absent.length) {
      push(
        "warning",
        "text-style-absent",
        `${absent.length} of ${textStyles.size} text style(s) used on the screen are not in the design-system export: ` + absent.slice(0, 8).map((n) => "'" + n + "'").join(", ") + (absent.length > 8 ? ", \u2026" : "") + ".",
        { styles: absent }
      );
    }
  }
  const absurd = [];
  const seenAbsurd = /* @__PURE__ */ new Set();
  const allVars = (tokens && tokens.variables || []).concat(variables && variables.variables || []);
  for (const v of allVars) {
    for (const [mode, val] of Object.entries(v && v.values || {})) {
      const n = typeof val === "number" ? val : val && typeof val === "object" && "value" in val && typeof val.value === "number" ? val.value : null;
      if (n == null || Math.abs(n) < ABSURD_NUMBER) continue;
      const id = JSON.stringify([v.collection ?? null, v.name, mode]);
      if (seenAbsurd.has(id)) continue;
      seenAbsurd.add(id);
      absurd.push({ name: v.name, collection: v.collection, mode, value: n });
    }
  }
  const firstAbsurd = absurd[0];
  if (firstAbsurd) {
    push(
      "warning",
      "sentinel-token-value",
      `${absurd.length} token value(s) are sentinels, not measurements: ` + absurd.slice(0, 4).map((a) => `'${a.name}' = ${a.value} (${a.mode})`).join(", ") + (absurd.length > 4 ? ", \u2026" : "") + `. Figma's "fully rounded" corner exports as a literal 1e9. Emit these as the platform's own idiom (CSS 9999px or 50%, SwiftUI .infinity, Compose CircleShape) \u2014 never as \`${firstAbsurd.value}px\`.`,
      { tokens: absurd }
    );
  }
  const multiModeColls = [];
  const seenColl = /* @__PURE__ */ new Set();
  const allColls = (tokens && tokens.collections || []).concat(screenColls);
  for (const c of allColls) {
    if (!Array.isArray(c.modes) || c.modes.length <= 1) continue;
    if (seenColl.has(c.name)) continue;
    seenColl.add(c.name);
    multiModeColls.push(c);
  }
  for (const c of multiModeColls) {
    const seen = resolvedModes.get(c.name);
    if (!seen || !seen.size) continue;
    const only = seen.size === 1 ? [...seen][0] : void 0;
    if (only !== void 0 && c.modes.length > 1) {
      const rest = c.modes.filter((m) => m !== only);
      const colour = [...tokens && tokens.variables || [], ...variables && variables.variables || []].some((v) => v.collection === c.name && v.type === "COLOR");
      const example = colour ? "a dark surface token that stays dark in Light" : `a size or spacing value that should differ in '${rest[0] ?? "another mode"}' but keeps its '${only}' value`;
      push(
        "warning",
        "single-mode-export",
        `every exported frame resolved collection '${c.name}' in mode '${only}', but it defines ${c.modes.length} modes (${c.modes.join(", ")}). The other ${rest.length} mode(s) are DERIVED from variable values, never seen rendered \u2014 so any element whose ${only}-mode token has no sensible counterpart (${example}) will be mechanically correct and visually broken. Export a frame in ${rest.map((m) => `'${m}'`).join(" / ")} too, or have the designer confirm the derivation before it ships.`,
        { collection: c.name, exportedMode: only, modes: c.modes }
      );
    }
  }
  mixedModeBindings(screens, variables, tokens, push);
  contrastPerMode(screens, variables, tokens, push, resolvedModes);
  contrastRendered(screens, variables, tokens, push);
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code));
  const ids = findingIds(findings);
  findings.forEach((f, i) => {
    const id = ids[i];
    if (id !== void 0) f.id = id;
  });
  const count = (s) => findings.filter((f) => f.severity === s).length;
  return {
    summary: { blockers: count("blocker"), warnings: count("warning"), info: count("info") },
    coverage,
    // The confirmation list (catalog-rekeyed). Every entry starts unconfirmed; map-bootstrap.ts
    // --from-proposals stubs only the ones a person set "confirmed": true on.
    // Unconfirmed first (shared chrome before screen-only), already-mapped last.
    componentProposals: proposals,
    componentResidual: rekey && coverage.rekey && coverage.rekey.rekeyed ? rekey.rows.filter((r) => !r.match).map((r) => ({ name: r.name, instances: r.instances, reasons: r.reasons })) : [],
    findings,
    notChecked,
    inputs: {
      screens: screens.map((s) => s.label),
      variables: !!variables,
      tokens: !!tokens,
      components: !!components,
      stylesText: !!stylesText
    }
  };
}
function labelProposals(rekey, visible, map, siblings) {
  const mapKeys = /* @__PURE__ */ new Set();
  for (const [k, e] of Object.entries(map && map.components || {})) {
    mapKeys.add(k);
    if (e && e.figma && e.figma.key) mapKeys.add(e.figma.key);
  }
  const keysOf = /* @__PURE__ */ new Map();
  for (const i of visible) {
    const ks = getOrInit(keysOf, i.name, () => /* @__PURE__ */ new Set());
    if (i.key) ks.add(i.key);
    if (i.setKey) ks.add(i.setKey);
  }
  const others = rekey.proposals.length && siblings ? siblings().map((s) => {
    const ks = /* @__PURE__ */ new Set();
    for (const i of visibleInstances(s.doc, s.label)) {
      if (i.key) ks.add(i.key);
      if (i.setKey) ks.add(i.setKey);
    }
    return ks;
  }) : null;
  const out = rekey.proposals.map((r) => {
    const keys = keysOf.get(r.name) || new Set(r.instanceKeys);
    const mapped = [...keys].some((k) => mapKeys.has(k));
    return {
      name: r.name,
      instances: r.instances,
      screens: r.screens,
      instanceKeys: r.instanceKeys,
      remote: r.remote,
      catalog: r.match,
      ...ifDefined("evidence", r.evidence),
      tie: r.tie || null,
      alternatives: r.alternatives,
      reasons: r.reasons,
      confirmed: false,
      ...mapped ? { alreadyMapped: true } : {},
      ...ifDefined("sharedWith", others ? others.filter((o) => [...keys].some((k) => o.has(k))).length : void 0)
    };
  });
  const rank = (p) => p.alreadyMapped ? 2 : (p.sharedWith || 0) > 0 ? 0 : 1;
  return out.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || (b.p.sharedWith || 0) - (a.p.sharedWith || 0) || a.i - b.i).map((x) => x.p);
}
function exportSiblings(files) {
  const checked = new Set(files.map((f) => path5.resolve(f)));
  const roots = /* @__PURE__ */ new Set();
  for (const f of checked) {
    const pages = path5.dirname(path5.dirname(f));
    if (path5.basename(pages) === "pages" && fs7.existsSync(path5.join(pages, "index.json"))) roots.add(path5.dirname(pages));
  }
  if (!roots.size) return null;
  return () => {
    const out = [];
    const seen = new Set(checked);
    for (const root of roots) {
      const index = readJsonOrNull(path5.join(root, "pages", "index.json"), isPagesRootIndex);
      if (!index) continue;
      let rows = index.layers || [];
      if (!index.layers) {
        for (const pd of index.pageDirs) {
          const idx = pd.dir ? readJsonOrNull(path5.join(root, "pages", pd.dir, "index.json"), isPageIndex) : null;
          if (idx) rows = rows.concat(idx.layers);
        }
      }
      for (const row of rows) {
        const rel = row.file;
        if (!rel || path5.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) continue;
        const file = path5.resolve(root, rel);
        if (seen.has(file)) continue;
        seen.add(file);
        const doc = readJsonOrNull(file, isScreenDoc);
        if (doc) out.push({ doc, label: path5.basename(file, ".json") });
      }
    }
    return out;
  };
}
var MIN_CONTRAST = 4.5;
function composedRgba(color, opacity) {
  if (!color || opacity === null || !Number.isFinite(opacity)) return null;
  return { ...color, a: composeAlpha(color.a, opacity) };
}
var aliasName = (val) => val && typeof val === "object" && "aliasOf" in val && typeof val.aliasOf === "string" && val.aliasOf ? val.aliasOf : null;
function resolveNumberWith(valueOf, name, depth) {
  if (depth > 8) return null;
  const val = valueOf(name);
  if (typeof val === "number") return Number.isFinite(val) ? val : null;
  const next = aliasName(val);
  return next ? resolveNumberWith(valueOf, next, depth + 1) : null;
}
function resolveColourWith(valueOf, name, depth) {
  if (depth > 8) return null;
  const val = valueOf(name);
  if (typeof val === "string") return parseHex(val);
  const next = aliasName(val);
  if (next) return resolveColourWith(valueOf, next, depth + 1);
  if (val && typeof val === "object" && "composed" in val) {
    const { color, opacity } = val.composed;
    const c = typeof color === "string" ? parseHex(color) : resolveColourWith(valueOf, color.aliasOf, depth + 1);
    const o = typeof opacity === "number" ? opacity : resolveNumberWith(valueOf, opacity.aliasOf, depth + 1);
    return composedRgba(c, o);
  }
  return null;
}
function contrastPerMode(screens, variables, tokens, push, resolvedModes) {
  const defs = /* @__PURE__ */ new Map();
  for (const v of tokens && tokens.variables || []) if (v.name) defs.set(v.name, v);
  for (const v of variables && variables.variables || []) if (v.name) defs.set(v.name, v);
  if (!defs.size) return;
  function valueIn(name, mode) {
    const v = defs.get(name);
    if (!v || !v.values) return void 0;
    const val = v.values[mode];
    if (val !== void 0) return val;
    const keys = Object.keys(v.values);
    const [onlyKey] = keys;
    return keys.length === 1 && onlyKey !== void 0 ? v.values[onlyKey] : void 0;
  }
  const resolve = (name, mode, depth) => resolveColourWith((n) => valueIn(n, mode), name, depth);
  const modes = /* @__PURE__ */ new Set();
  const allColls = (tokens && tokens.collections || []).concat(variables && variables.collections || []);
  for (const c of allColls) {
    for (const m of c && c.modes || []) modes.add(m);
  }
  const rendered = /* @__PURE__ */ new Set();
  for (const set of (resolvedModes || /* @__PURE__ */ new Map()).values()) for (const m of set) rendered.add(m);
  for (const m of rendered) modes.delete(m);
  if (!modes.size) return;
  if (!rendered.size) return;
  const pairs = /* @__PURE__ */ new Map();
  for (const s of screens) {
    for (const root of screenRoots(s.doc)) {
      walkWithBg(root, null, (n, bgToken) => {
        if (n.type !== "TEXT" || !bgToken) return;
        const fg = n.tokens && (n.tokens.fills || n.tokens.textRangeFills) || (n.fills || []).map((f) => f && f.tokens && f.tokens.color).find(Boolean);
        if (!fg || typeof fg !== "string") return;
        const key = fg + "|" + bgToken;
        const pair = getOrInit(pairs, key, () => ({ fg, bg: bgToken, nodes: [], sample: n.name }));
        if (pair.nodes.length < 4) pair.nodes.push(n.id);
      });
    }
  }
  if (!pairs.size) return;
  const failures = [];
  for (const p of pairs.values()) {
    for (const mode of modes) {
      const fg = resolve(p.fg, mode, 0);
      const bg = resolve(p.bg, mode, 0);
      if (!fg || !bg) continue;
      const r = contrastRatio(fg.a < 1 ? compositeOver(fg, bg) : fg, bg);
      if (r >= MIN_CONTRAST) continue;
      failures.push({ mode, fg: p.fg, bg: p.bg, ratio: Number(r.toFixed(2)), nodes: p.nodes, sample: p.sample });
    }
  }
  if (!failures.length) return;
  const byMode = /* @__PURE__ */ new Map();
  for (const f of failures) {
    getOrInit(byMode, f.mode, () => []).push(f);
  }
  for (const [mode, list] of byMode) {
    push(
      "warning",
      "derived-mode-contrast",
      `in mode '${mode}', ${list.length} text/background token pair(s) fall below WCAG AA (${MIN_CONTRAST}:1): ` + list.slice(0, 4).map((f) => `'${f.fg}' on '${f.bg}' = ${f.ratio}:1 (e.g. ${f.sample})`).join("; ") + (list.length > 4 ? ", \u2026" : "") + `. No frame was exported in '${mode}', so this mode is DERIVED from variable values and nobody has ever seen it rendered \u2014 the derivation is mechanically correct and visually broken. Export a '${mode}' frame, or get the designer to say which token each of these should use there. Do not invent an override and call it done.`,
      { mode, pairs: list, confirm: `Mode '${mode}' was never drawn and ${list.length} derived text/background pair(s) in it fail contrast \u2014 ship '${mode}' as derived, or will the designer supply it?` }
    );
  }
}
function walkWithBg(node, bgToken, fn) {
  if (!node || typeof node !== "object") return;
  if (hiddenSelf(node)) return;
  const bg = backdropTokenAfter(node, bgToken);
  fn(node, bg);
  for (const c of node.children || []) walkWithBg(c, bg, fn);
}
function backdropTokenAfter(n, above) {
  if (n.type === "TEXT") return above;
  const fills = (n.fills || []).filter(Boolean);
  const nodeTok = n.tokens && typeof n.tokens.fills === "string" && n.tokens.fills ? n.tokens.fills : null;
  if (!fills.length) return nodeTok ?? above;
  let cur = above;
  for (const f of fills) {
    if (f.opacity === 0) continue;
    if (f.type !== "solid") {
      cur = null;
      continue;
    }
    const c = parseHex(f.color);
    if (c && c.a <= 0) continue;
    const t = f.tokens && f.tokens.color;
    const tok = typeof t === "string" && t ? t : fills.length === 1 ? nodeTok : null;
    cur = tok && (!c || c.a >= 1) ? tok : null;
  }
  return cur;
}
function fillToken(n) {
  const own = n.tokens && n.tokens.fills || (n.fills || []).map((f) => f && f.tokens && f.tokens.color).find(Boolean);
  return own && typeof own === "string" ? own : null;
}
function textToken(n) {
  const t = n.tokens || {}, tt = n.textTokens || {};
  for (const x of [t.fills, t.textRangeFills, fillToken(n), tt.fills]) if (typeof x === "string" && x) return x;
  return null;
}
function colourBindings(n) {
  const out = [];
  const add = (x) => {
    for (const s of Array.isArray(x) ? x : [x]) if (typeof s === "string" && s && !out.includes(s)) out.push(s);
  };
  for (const [k, v] of Object.entries(n.tokens || {})) if (/fill|stroke/i.test(k)) add(v);
  for (const f of n.fills || []) add(f && f.tokens && f.tokens.color);
  add((n.textTokens || {}).fills);
  return out;
}
function mixedModeBindings(screens, variables, tokens, push) {
  for (const s of screens) {
    const label = s.label || screenExportOf(s.doc)?.screen || "screen";
    const defs = /* @__PURE__ */ new Map();
    for (const doc of [tokens, variables, s.vars || null]) for (const v of doc && doc.variables || []) if (v.name) defs.set(v.name, v);
    const colls = [...s.vars && s.vars.collections || [], ...variables && variables.collections || [], ...tokens && tokens.collections || []];
    const collOf = (v) => {
      const keyed = v.collectionKey ? colls.find((c) => c.key === v.collectionKey && Array.isArray(c.modes)) : void 0;
      if (keyed) return keyed;
      const named = colls.filter((c) => c.name === v.collection && Array.isArray(c.modes));
      const modes = Object.keys(v.values || {});
      return named.find((c) => modes.every((m) => c.modes.includes(m))) ?? named[0];
    };
    for (const root of screenRoots(s.doc)) {
      const rm = root.resolvedModes;
      if (!rm) continue;
      const use = /* @__PURE__ */ new Map();
      walk(root, (n) => {
        for (const name of colourBindings(n)) {
          const v = defs.get(name);
          if (!v || v.type !== "COLOR") continue;
          const c = collOf(v);
          const mode = c ? rm[c.name] : void 0;
          if (!c || c.modes.length < 2 || mode === void 0) continue;
          const u = getOrInit(use, c.name, () => ({ coll: c, mode, count: 0, tokens: [], nodes: [], samples: [] }));
          u.count++;
          if (!u.tokens.includes(name) && u.tokens.length < 20) u.tokens.push(name);
          if (!u.nodes.includes(n.id) && u.nodes.length < 8) u.nodes.push(n.id);
          if (u.samples.length < 3) u.samples.push(`'${name}' on '${n.name}'`);
        }
      });
      const groups = [];
      for (const u of use.values()) {
        const joined = groups.filter((g) => g.some((o) => o.coll.modes.some((m) => u.coll.modes.includes(m))));
        const merged = [...joined.flat(), u];
        for (const g of joined) groups.splice(groups.indexOf(g), 1);
        groups.push(merged);
      }
      for (const group of groups) {
        const perMode = /* @__PURE__ */ new Map();
        for (const u of group) perMode.set(u.mode, (perMode.get(u.mode) || 0) + u.count);
        if (perMode.size < 2) continue;
        const [major] = [...perMode].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
        if (major === void 0) continue;
        const majority = group.filter((u) => u.mode === major);
        const minority = group.filter((u) => u.mode !== major && u.coll.modes.includes(major));
        const first = minority[0];
        if (!first) continue;
        const names = (list) => list.map((u) => `'${u.coll.name}'`).join(", ");
        const minModes = [...new Set(minority.map((u) => `'${u.mode}'`))].join("/");
        push(
          "warning",
          "mixed-mode-bindings",
          `'${label}' renders ${names(majority)} in '${major}' (\xD7${perMode.get(major)} bindings) but ` + minority.map((u) => `'${u.coll.name}' in '${u.mode}' (\xD7${u.count}: ${u.samples.join(", ")}${u.count > u.samples.length ? " \u2026" : ""})`).join(", ") + ` \u2014 ${minority.length > 1 ? "tokens from these collections show their" : `a token from '${first.coll.name}' shows its`} ${minModes} value in a '${major}' screen. Pin ${names(minority)} to '${major}' in Figma (the frame's variable mode), or alias these tokens under a role name in code \u2014 a theme built from one mode per collection gives them their '${major}' value, which nobody drew.`,
          {
            ...ifDefined("nodeId", first.nodes[0]),
            // the first node binding a minority-mode token
            bindings: [...majority, ...minority].map((u) => ({ collection: u.coll.name, mode: u.mode, tokens: u.tokens, nodes: u.nodes })),
            confirm: `'${label}' binds ${minority.reduce((k, u) => k + u.count, 0)} colour token(s) from ${names(minority)} in ${minModes} while the rest of the screen is '${major}' \u2014 intended, or should they follow '${major}'? Until confirmed, build what was drawn (the ${minModes} values).`
          }
        );
      }
    }
  }
}
var LARGE_TEXT_PX = 24;
var LARGE_BOLD_TEXT_PX = 18.66;
var NON_TEXT_CONTRAST = 3;
function isLargeText(n) {
  const f = n.font;
  const size = f && typeof f.size === "number" ? f.size : 0;
  const bold = !!f && (typeof f.weightValue === "number" ? f.weightValue >= 700 : /(^|\s)(extra\s*)?(bold|black|heavy)/i.test(f.weight || "") && !/semi|demi/i.test(f.weight || ""));
  return size >= LARGE_TEXT_PX || size >= LARGE_BOLD_TEXT_PX && bold;
}
var isDisabledVariant = (n) => n.type === "INSTANCE" && isDisabledLayer(n);
function contrastRendered(screens, variables, tokens, push) {
  const rows = /* @__PURE__ */ new Map();
  for (const s of screens) {
    const label = s.label || screenExportOf(s.doc)?.screen || "screen";
    const defs = /* @__PURE__ */ new Map();
    for (const doc of [tokens, variables, s.vars || null]) for (const v of doc && doc.variables || []) if (v.name) defs.set(v.name, v);
    if (!defs.size) continue;
    const colls = [...s.vars && s.vars.collections || [], ...variables && variables.collections || [], ...tokens && tokens.collections || []];
    for (const root of screenRoots(s.doc)) {
      const rm = root.resolvedModes || {};
      const modeOf = (v) => {
        const keys = Object.keys(v.values || {});
        const coll = v.collection;
        const r = coll !== void 0 ? rm[coll] : void 0;
        if (r !== void 0 && keys.includes(r)) return r;
        const hasDefault = (c) => c.default !== void 0 && keys.includes(c.default);
        const byKey = v.collectionKey ? colls.find((c) => c.key === v.collectionKey && hasDefault(c)) : void 0;
        const def = (byKey ?? colls.find((c) => c.name === coll && hasDefault(c)))?.default;
        if (def !== void 0) return def;
        return keys.length === 1 ? keys[0] : void 0;
      };
      const valueOf = (name) => {
        const v = defs.get(name);
        const m = v ? modeOf(v) : void 0;
        return v && m !== void 0 ? v.values[m] : void 0;
      };
      const resolve = (name) => resolveColourWith(valueOf, name, 0);
      const modeLabel = (...names) => {
        const ms = [];
        for (const nm of names) {
          const v = defs.get(nm);
          const m = v && Object.keys(v.values || {}).length > 1 ? modeOf(v) : void 0;
          if (m !== void 0 && !ms.includes(m)) ms.push(m);
        }
        return ms.join("/") || "single mode";
      };
      const check = (kind, fgTok, bgTok, required, nodeId) => {
        const fg = resolve(fgTok), bg = resolve(bgTok);
        if (!fg || !bg) return;
        if (kind === "non-text" && fg.a <= 0) return;
        const r = contrastRatio(fg.a < 1 ? compositeOver(fg, bg) : fg, bg);
        if (r >= required) return;
        const mode = modeLabel(fgTok, bgTok);
        const row = getOrInit(rows, [kind, fgTok, bgTok, mode].join("\0"), () => ({ kind, fg: fgTok, bg: bgTok, mode, ratio: Number(r.toFixed(2)), required, screens: [], nodes: [] }));
        if (!row.screens.includes(label)) row.screens.push(label);
        if (row.nodes.length < 4 && !row.nodes.includes(nodeId)) row.nodes.push(nodeId);
      };
      const visit = (n, above, disabled, ancestors, aboves) => {
        if (hiddenSelf(n)) return;
        const off = disabled || isDisabledVariant(n);
        const next = backdropTokenAfter(n, above);
        if (!off && n.type === "TEXT") {
          const fg = textToken(n);
          if (fg && above) check("text", fg, above, isLargeText(n) ? NON_TEXT_CONTRAST : MIN_CONTRAST, n.id);
        } else if (!off && n.type !== "LINE") {
          const st = n.tokens && n.tokens.strokes;
          const w = n.strokes ? Math.max(n.strokes.weight || 0, ...Object.values(n.strokes.weights || {}).map((x) => x || 0)) : 0;
          const colours = n.strokes && n.strokes.colors || [];
          const painted = !colours.length || colours.some((c) => {
            const x = parseHex(c);
            return !x || x.a > 0;
          });
          const outer = typeof st === "string" && st && w > 0 && painted ? outermostControl([n, ...ancestors.slice(-3).reverse()]) : -1;
          const outside = outer < 0 ? null : outer === 0 ? above : aboves[ancestors.length - outer] ?? null;
          const bg = outside ? resolve(outside) : null;
          if (typeof st === "string" && outside && bg) {
            let inner = null, unknown = false;
            for (const l of [...ancestors.slice(ancestors.length - outer), n]) {
              const fills = (l.fills || []).filter(Boolean);
              const lt = !fills.length && l.tokens && typeof l.tokens.fills === "string" ? resolve(l.tokens.fills) : null;
              if (lt) inner = compositeOver(lt, inner || bg);
              for (const f of fills) {
                if (f.opacity === 0) continue;
                if (f.type !== "solid") {
                  unknown = true;
                  break;
                }
                const c = parseHex(f.color);
                if (c && c.a > 0) inner = compositeOver(c, inner || bg);
              }
            }
            const rescued = !!inner && contrastRatio(inner, bg) >= NON_TEXT_CONTRAST;
            if (!rescued && !unknown) check("non-text", st, outside, NON_TEXT_CONTRAST, n.id);
          }
        }
        const chain = [...ancestors, n], chainAbove = [...aboves, above];
        for (const c of n.children || []) visit(c, next, off, chain, chainAbove);
      };
      visit(root, null, false, [], []);
    }
  }
  if (!rows.size) return;
  const list = [...rows.values()].sort((a, b) => b.screens.length - a.screens.length || a.ratio - b.ratio || a.fg.localeCompare(b.fg));
  push(
    "info",
    "token-pair-contrast",
    `${list.length} token pair(s) fail WCAG in the rendered mode(s) \u2014 ask the designer once per pair: ` + list.slice(0, 8).map((p) => `${p.kind === "text" ? "" : "stroke "}'${p.fg}' on '${p.bg}' (${p.mode}) ${p.ratio}:1 < ${p.required}:1 \u2014 ${p.screens.length} screen(s)`).join("; ") + (list.length > 8 ? `; \u2026 (${list.length} in all \u2014 see tokenPairs)` : "") + `. Token-level: the token-bound background (a gradient / image / raw or translucent fill in between is not judged), no compositing \u2014 the per-screen audit's low-contrast / non-text-contrast / contrast-manual measure what renders.`,
    { tokenPairs: list }
  );
}
function toMarkdown(res) {
  const L = [];
  L.push(`# Cross-file check \u2014 ${res.inputs.screens.join(", ") || "(no screens)"}`, "");
  L.push(
    `**${res.summary.blockers} blocker(s)**, ${res.summary.warnings} warning(s), ${res.summary.info} info. Every check here is a JOIN between the screen and the design system \u2014 none of it is visible from either file alone.`,
    ""
  );
  const c = res.coverage;
  if (c && c.distinct) {
    L.push("## Component coverage of THIS screen", "");
    L.push(`| | count |`, `|---|---|`);
    L.push(`| visible instances on the screen | ${c.instances} |`);
    L.push(`| **distinct components** (each lands in exactly one row below) | **${c.distinct}** |`);
    const b = c.buckets || {};
    L.push(`| in **the component catalog** by key (verified) | ${b.localKey || 0} (${c.localPct}%) |`);
    L.push(`| in components.library.json by key (a shared third-party set) | ${b.libraryKey || 0} |`);
    if (c.rekey && c.rekey.rekeyed) L.push(`| same name **and** prop signature as a catalog entry \u2014 proposed, confirm below | ${b.proposed || 0} |`);
    L.push(`| exact name twin only (**unverified**) | ${b.nameOnly || 0} |`);
    L.push(`| name shared with several catalog entries \u2014 left unmatched | ${b.ambiguous || 0} |`);
    L.push(`| no match at all \u2014 new work | ${b.newWork || 0} |`);
    if (c.hiddenOnly) L.push(`| *(not counted: components used only on hidden layers \u2014 not built)* | ${c.hiddenOnly} |`);
    L.push("");
  }
  if (res.componentProposals && res.componentProposals.length) {
    L.push("## Proposed component matches \u2014 confirm before reuse", "");
    L.push(
      "*Matched by name + prop signature because the keys were re-minted (a duplicated file or a re-published library).",
      'Nothing here is accepted until a person sets `"confirmed": true` on the entry in the JSON report.*',
      ""
    );
    const all = res.componentProposals;
    const groups = [
      ["Shared with other exported screens \u2014 confirm once", all.filter((p) => !p.alreadyMapped && (p.sharedWith || 0) > 0)],
      [all.some((p) => p.sharedWith !== void 0) ? "This screen only" : "To confirm", all.filter((p) => !p.alreadyMapped && !((p.sharedWith || 0) > 0))],
      ["Already in the component map \u2014 nothing to confirm", all.filter((p) => p.alreadyMapped)]
    ];
    for (const [title, list] of groups) {
      if (!list.length) continue;
      L.push(`### ${title} (${list.length})`, "");
      L.push("| instance name | \xD7 | \u2192 catalog | id | page | evidence | shared with | why |", "|---|--:|---|---|---|---|--:|---|");
      for (const p of list) {
        const cat = p.catalog;
        if (!cat) continue;
        L.push(`| \`${p.name}\` | ${p.instances} | \`${cat.name}\` | ${cat.id} | ${cat.page || ""} | ${p.evidence}${p.tie ? ` (${p.tie})` : ""} | ${p.sharedWith === void 0 ? "?" : `${p.sharedWith} other screen(s)`} | ${p.reasons.join("; ")} |`);
      }
      L.push("");
    }
    if (res.componentResidual && res.componentResidual.length) {
      const twin = new Set((c && c.entries ? c.entries : []).filter((e) => e.bucket === "libraryKey").map((e) => e.setName));
      const fresh = res.componentResidual.filter((r) => !twin.has(r.name)), known = res.componentResidual.filter((r) => twin.has(r.name));
      L.push(`**Not in the component catalog (${res.componentResidual.length}):** ` + (known.length ? `${known.length} are in components.library.json by key \u2014 third-party, see the table: ${known.map((r) => `\`${r.name}\``).join(", ")}. ` : "") + `${fresh.length} are new work${fresh.length ? ": " + fresh.map((r) => `\`${r.name}\``).join(", ") : ""}.`, "");
    }
  }
  for (const sev of ["blocker", "warning", "info"]) {
    const fs8 = res.findings.filter((f) => f.severity === sev);
    if (!fs8.length) continue;
    L.push(`## ${sev === "blocker" ? "Blockers" : sev === "warning" ? "Warnings" : "Info"} (${fs8.length})`, "");
    for (const f of fs8) L.push(`- \`${f.code}\` ${f.message}`);
    L.push("");
  }
  const pairs = res.findings.find((f) => f.code === "token-pair-contrast")?.tokenPairs || [];
  if (pairs.length) {
    L.push("## Token pairs below WCAG in the rendered modes \u2014 ask once per pair", "");
    L.push("| kind | foreground | background | mode | ratio | needs | screens | nodes |", "|---|---|---|---|--:|--:|---|---|");
    for (const p of pairs) {
      L.push(`| ${p.kind} | \`${p.fg}\` | \`${p.bg}\` | ${p.mode} | ${p.ratio}:1 | ${p.required}:1 | ${p.screens.length}: ${p.screens.slice(0, 4).join(", ")}${p.screens.length > 4 ? ", \u2026" : ""} | ${p.nodes.join(", ")} |`);
    }
    L.push("");
  }
  if (res.notChecked.length) {
    L.push("## Not checked", "", "*These are gaps in the INPUT, not clean results:*", "");
    for (const n of res.notChecked) L.push(`- ${n}`);
    L.push("");
  }
  return L.join("\n") + "\n";
}
function main(argv) {
  const USAGE = `usage: ${scriptCmd("cross-check")} <screen.json>... [--design-system design/export/design-system | design/export/libraries/<dir>] [--variables design/export/variables.json] [--map design/codeconnect.local.json] [--out design/audit/<screen>.cross] [--json] [--gate]`;
  const OPTIONS = {
    "design-system": { type: "string" },
    variables: { type: "string" },
    map: { type: "string" },
    out: { type: "string" },
    json: { type: "boolean" },
    gate: { type: "boolean" },
    help: { type: "boolean", short: "h" }
  };
  const { values: flags, positionals: files } = cliParse("cross-check", argv, OPTIONS, USAGE, 2, (args) => parseArgs2({ args, options: OPTIONS, allowPositionals: true }));
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  if (!files.length) {
    console.error(USAGE);
    return 2;
  }
  const { "design-system": dsDir, variables: varsFile, map: mapFlag, out } = flags;
  const jsonOnly = !!flags.json, gate = !!flags.gate;
  const ctx = variablesContext(files, varsFile);
  for (const bad of ctx.invalid) console.error(`error  variables: '${bad.file}' ${bad.error}`);
  if (ctx.invalid.length) return 2;
  const screens = files.map((f, i) => ({ doc: readDocFile(f, "screen export", isScreenDoc), label: path5.basename(f, ".json"), ...ifDefined("vars", ctx.own[i]) }));
  const dsBase = dsDir || path5.join(findExportDir(process.cwd()).rel, DESIGN_SYSTEM_DIR);
  const { variablesPath, variablesDoc } = ctx;
  if (variablesPath) console.error(`variables: ${variablesPath}`);
  if (ctx.staleLegacy) {
    console.error(`warn  ${ctx.staleLegacy} also exists and was NOT used (stale sibling of design/export/) \u2014 remove it or re-pull into design/export/.`);
  }
  const ds = readDesignSystemDir(dsBase);
  let map = null;
  if (mapFlag) map = readDocFile(mapFlag, "component map", isCodeConnectMap);
  else {
    const mapAt = findMapFile(process.cwd());
    const found = mapAt.missing ? void 0 : mapAt.rel;
    const r = found ? readJson(found, isCodeConnectMap) : null;
    if (found && r && "doc" in r) {
      map = r.doc;
      console.error(`map: ${found}`);
    } else if (found && r && "error" in r) console.error(`warn  ${found} ${r.error} \u2014 proposals are not labelled alreadyMapped (pass --map to fail on it)`);
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
    siblings: exportSiblings(files)
  });
  if (jsonOnly) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  } else if (out) {
    fs7.mkdirSync(path5.dirname(out), { recursive: true });
    fs7.writeFileSync(out + ".json", JSON.stringify(res, null, 2) + "\n");
    fs7.writeFileSync(out + ".md", toMarkdown(res));
    console.error(`wrote ${out}.json and ${out}.md`);
  } else {
    process.stdout.write(toMarkdown(res));
  }
  console.error(`${res.summary.blockers} blocker(s), ${res.summary.warnings} warning(s), ${res.summary.info} info`);
  for (const n of res.notChecked) console.error(`note  not checked: ${n}`);
  return gate && res.summary.blockers > 0 ? 1 : 0;
}
if (import.meta.main ?? isMainFallback(import.meta.url)) process.exitCode = main(process.argv.slice(2));
export {
  ABSURD_NUMBER,
  SEVERITY_ORDER,
  WRONG_CATALOG_PCT,
  composedRgba,
  crossCheck,
  exportSiblings,
  toMarkdown
};
