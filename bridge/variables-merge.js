// variables-merge.js — design/variables.json accumulates across single-screen pulls.
//
// A `--node`/`--selection` pull returns only the variables THAT node binds. Writing that slice
// straight to design/variables.json (what this module replaced) meant every pull silently deleted
// the previous screen's tokens: pull screen A, pull screen B, and A's theme no longer resolves.
// Nothing warned, because the screen JSON carries raw hex beside every binding — so the build still
// renders, just unthemed. That is the worst shape a data-loss bug can take.
//
// So: merge. A variable's identity is its Figma `key` (stable across files and across pulls); only
// when a key is absent (never seen on a real export, but the field is optional in the IR) do we fall
// back to collection+name, which is the weakest thing that is still not wrong. Collections merge the
// same way, unioning their `modes` — two slices of one collection can legitimately report different
// mode subsets.
//
// Merge direction: the NEW slice wins a value conflict (it is the fresher read of the same file) and
// the disagreement is recorded in `_conflicts` + `hygiene` rather than silently resolved. On the live
// runs that produced this module there were zero conflicts across five slices, which is the expected
// case: the slices are views of one variable set.
//
// Provenance is kept, not inferred: `_slices` records one entry per contributing pull, and the raw
// slice is also written verbatim to variables/<Screen>.json by write-out.js. So "which tokens did
// screen A actually use" survives the merge, and deleting design/variables.json resets everything.

const MERGE_NOTE =
  "Merged across single-screen pulls: this file is the UNION of every --node/--selection export " +
  "written into this directory, keyed on each variable's Figma key. Per-pull slices are kept verbatim " +
  "under variables/. Delete this file to start over.";

function varId(v) {
  if (v && typeof v.key === "string" && v.key) return "k:" + v.key;
  return "n:" + String((v && v.collection) || "") + "\u0000" + String((v && v.name) || "");
}

function collId(c) {
  if (c && typeof c.key === "string" && c.key) return "k:" + c.key;
  return "n:" + String((c && c.name) || "");
}

// Value equality is compared on the fields that DECIDE a token: what it resolves to per mode, and
// what kind of thing it is. Metadata that legitimately differs between slices (scopes reported by a
// partial read, hiddenFromPublishing) is not a conflict, so it does not generate noise.
function sameValue(a, b) {
  return JSON.stringify(a && a.values) === JSON.stringify(b && b.values) && (a && a.type) === (b && b.type);
}

function mergeModes(prev, next) {
  const out = Array.isArray(prev) ? prev.slice() : [];
  for (const m of Array.isArray(next) ? next : []) if (!out.includes(m)) out.push(m);
  return out;
}

// prev/next are whole variables.json documents ({collections, variables, hygiene}). `slice` names the
// pull that produced `next` so the provenance list can carry it. Returns the merged doc plus the
// stats the CLI prints — callers decide how loud to be, this module never logs.
function mergeVariablesDoc(prev, next, slice) {
  const nextDoc = next || {};
  if (!prev || typeof prev !== "object" || (!Array.isArray(prev.variables) && !Array.isArray(prev.collections))) {
    // First pull into this directory: nothing to merge, but stamp the provenance so the second pull
    // has a list to append to rather than an unexplained new key.
    const doc = {
      collections: Array.isArray(nextDoc.collections) ? nextDoc.collections.slice() : [],
      variables: Array.isArray(nextDoc.variables) ? nextDoc.variables.slice() : [],
      hygiene: Array.isArray(nextDoc.hygiene) ? nextDoc.hygiene.slice() : [],
    };
    doc._slices = slice ? [sliceEntry(slice, doc)] : [];
    doc._note = MERGE_NOTE;
    return {
      doc,
      stats: { added: doc.variables.length, updated: 0, kept: 0, conflicts: [], collections: doc.collections.length, first: true },
    };
  }

  const collections = [];
  const collIndex = new Map();
  for (const c of Array.isArray(prev.collections) ? prev.collections : []) {
    const id = collId(c);
    if (collIndex.has(id)) continue;
    collIndex.set(id, collections.length);
    collections.push(Object.assign({}, c));
  }
  for (const c of Array.isArray(nextDoc.collections) ? nextDoc.collections : []) {
    const id = collId(c);
    if (!collIndex.has(id)) {
      collIndex.set(id, collections.length);
      collections.push(Object.assign({}, c));
      continue;
    }
    const at = collIndex.get(id);
    const merged = Object.assign({}, collections[at], c);
    merged.modes = mergeModes(collections[at].modes, c.modes);
    collections[at] = merged;
  }

  const variables = [];
  const varIndex = new Map();
  for (const v of Array.isArray(prev.variables) ? prev.variables : []) {
    const id = varId(v);
    if (varIndex.has(id)) continue;
    varIndex.set(id, variables.length);
    variables.push(v);
  }
  const stats = { added: 0, updated: 0, kept: 0, conflicts: [], collections: collections.length, first: false };
  for (const v of Array.isArray(nextDoc.variables) ? nextDoc.variables : []) {
    const id = varId(v);
    if (!varIndex.has(id)) {
      varIndex.set(id, variables.length);
      variables.push(v);
      stats.added++;
      continue;
    }
    const at = varIndex.get(id);
    const before = variables[at];
    if (sameValue(before, v)) {
      // Same token, same resolution — keep the richer record rather than the newer one, so a slice
      // that happened to read fewer scopes cannot strip fields an earlier slice captured.
      variables[at] = Object.assign({}, v, before);
      stats.kept++;
      continue;
    }
    stats.conflicts.push({
      name: v.name,
      collection: v.collection,
      key: v.key,
      was: before.values,
      now: v.values,
      from: slice && slice.screen,
    });
    variables[at] = v;
    stats.updated++;
  }

  const hygiene = [];
  const seenHy = new Set();
  for (const h of (Array.isArray(prev.hygiene) ? prev.hygiene : []).concat(Array.isArray(nextDoc.hygiene) ? nextDoc.hygiene : [])) {
    const s = String(h);
    if (seenHy.has(s)) continue;
    seenHy.add(s);
    hygiene.push(h);
  }
  for (const c of stats.conflicts) {
    const line =
      `CONFLICT: '${c.name}' (${c.collection}) resolves differently in ${slice && slice.screen ? "'" + slice.screen + "'" : "the newest pull"} ` +
      `than in an earlier pull — the newest value is kept. Check which screen is right before generating a theme.`;
    if (!seenHy.has(line)) {
      seenHy.add(line);
      hygiene.push(line);
    }
  }

  const doc = { collections, variables, hygiene };
  const slices = Array.isArray(prev._slices) ? prev._slices.filter((s) => !slice || s.screen !== slice.screen) : [];
  if (slice) slices.push(sliceEntry(slice, nextDoc));
  doc._slices = slices;
  if (stats.conflicts.length) doc._conflicts = stats.conflicts;
  doc._note = MERGE_NOTE;
  return { doc, stats };
}

function sliceEntry(slice, doc) {
  return {
    screen: slice.screen,
    file: slice.file,
    at: slice.at || new Date().toISOString(),
    variables: Array.isArray(doc && doc.variables) ? doc.variables.length : 0,
    collections: Array.isArray(doc && doc.collections) ? doc.collections.length : 0,
  };
}

module.exports = { mergeVariablesDoc, varId, collId, MERGE_NOTE };
