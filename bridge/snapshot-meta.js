// snapshot-meta.js — reads the freshness stamp a figma-pull export already left on disk.
//
// design-system.json's `exportedAt` (ISO timestamp) and `file` (figma.root.name) are stamped by the
// PLUGIN itself (collect.ts/components.ts's buildDesignSystem()) — nothing here invents a new field,
// it only reads what's already written. Kept as its own dependency-free CJS module (same pattern as
// errmsg.js / node-id.js) so both the MCP entry (ESM, via createRequire) and the test suite (CJS) can
// read it without importing figma-mcp.mts itself, which has top-level side effects (opens the bridge
// WebSocket server, connects an MCP stdio transport) that would make it unsafe to require from a test.
//
// Never throws: a missing/unreadable/malformed snapshot is reported as such, not silently treated as
// "no snapshot" or crashed on — figma_status's whole point is to say what it knows, loudly.
const fs = require("fs");
const path = require("path");
const { errMsg } = require("./errmsg.js");

// The ONE freshness rule, shared with design-to-code/drift-lint.js: given a parsed catalog, what is its
// export timestamp and how old is it? Callers own the POLICY (max-age threshold, warning codes,
// wording); this owns only "which field, and is it parseable". Two copies of the parse rule meant
// figma_status and drift-lint could disagree about the same file on disk.
// `problem` is "missing" (no stamp at all) or "unparseable" (stamp present, not a date).
function snapshotAge(doc, now) {
  const exportedAt = doc && doc.exportedAt;
  if (!exportedAt) return { exportedAt: undefined, ageMs: undefined, problem: "missing" };
  const t = Date.parse(exportedAt);
  if (Number.isNaN(t)) return { exportedAt, ageMs: undefined, problem: "unparseable" };
  return { exportedAt, ageMs: (now || Date.now()) - t };
}

// Which file carries the freshness stamp, in order of how much of the design it covers.
// design-system.json only exists after a `--design-system` or full pull; `pages/index.json` after a
// page walk; a single-screen pull (`--node`/selection) writes ONLY `design/<Screen>.json`. Reporting
// "nothing exported yet" to someone who has just exported a screen is wrong and sends them to re-run
// a pull they already ran (live run #5), so a screen doc counts as an export too — it is exactly as
// stamped as the others.
// design/ also holds files this tool GENERATES from an export — tokens.dtcg.json,
// tokens.resolver.json, target.json, an audit report. Those carry no export stamp (or a different
// one) and must never be mistaken for the export itself, so a screen doc is identified by SHAPE, not
// by being a .json that isn't on a blacklist: a real one carries `nodes[]` (a single-screen pull) or
// `layers[]`/`pageDirs[]` (a page walk). A blacklist would need updating every time a new output
// file is added; this does not.
function looksLikeExport(doc) {
  return !!doc && typeof doc === "object" &&
    (Array.isArray(doc.nodes) || Array.isArray(doc.layers) || Array.isArray(doc.pageDirs) ||
     Array.isArray(doc.components) || Array.isArray(doc.variables) || (doc.files && typeof doc.files === "object"));
}

// Which file carries the freshness stamp, in order of how much of the design it covers.
// design-system.json only exists after a `--design-system` or full pull; `pages/index.json` after a
// page walk; a single-screen pull (`--node`/selection) writes ONLY `design/<Screen>.json`. Reporting
// "nothing exported yet" to someone who has just exported a screen is wrong and sends them to re-run
// a pull they already ran (live run #5), so a screen doc counts as an export too — it is exactly as
// stamped as the others.
// `named: true` means the filename alone identifies it as an export, so its shape is not second-
// guessed (a hand-trimmed design-system.json is still a design-system.json). Only the DISCOVERED
// files have to earn it via looksLikeExport.
function snapshotCandidates(dir) {
  const out = [{ f: path.join(dir, "design-system.json"), named: true },
               { f: path.join(dir, "pages", "index.json"), named: true }];
  // Then any other top-level .json, newest first. Top level only — never a recursive walk, since this
  // runs on every figma_status/doctor call and design/assets/ can hold thousands of files.
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  const rest = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".json") || e.name === "design-system.json") continue;
    const f = path.join(dir, e.name);
    try { rest.push({ f, mtime: fs.statSync(f).mtimeMs }); } catch { /* vanished mid-read */ }
  }
  rest.sort((a, b) => b.mtime - a.mtime);
  return out.concat(rest.map((r) => ({ f: r.f, named: false })));
}

function readSnapshotInfo(outDir) {
  // Same resolution order as write-out.js's resolveOutDir, plus the legacy flat layout: a project
  // that exported before design/export/ existed must still report its snapshot, not "nothing yet".
  const dir = outDir || process.env.FIGMA_EXPORT_DIR || require("./project-layout.js").findExportDir(process.cwd()).dir;
  const cands = snapshotCandidates(dir);
  let file = null, doc = null, parseError = null, fallback = null;
  for (const { f: cand, named } of cands) {
    let raw;
    try { raw = fs.readFileSync(cand, "utf8"); } catch { continue; }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // A corrupt export is worth reporting even though a later candidate might still be readable —
      // but only for a file we KNOW was meant to be an export. Remember it and keep looking.
      if (named && parseError === null) parseError = { file: cand, error: path.basename(cand) + " is not valid JSON: " + errMsg(e) };
      continue;
    }
    if (!named && !looksLikeExport(parsed)) continue; // a generated file (tokens.*.json, target.json, an audit)
    // A STAMPED export always wins over an unstamped one. design/variables.json is the case that
    // forces this: a single-screen pull writes it alongside the screen doc, it is export-shaped
    // (variables[]), and it carries no exportedAt of its own — so picking purely by order would
    // report "freshness unknown" while a perfectly stamped screen doc sat right next to it.
    if (!parsed.exportedAt) { if (fallback === null) fallback = { file: cand, doc: parsed }; continue; }
    file = cand; doc = parsed; break;
  }
  if (file === null && fallback !== null) { file = fallback.file; doc = fallback.doc; }
  if (file === null) return parseError; // null when there is simply no export on disk yet — not an error
  const label = path.basename(file);
  // A screen doc has no `file` (that is a design-system field); its `screen` is the human label, so
  // fall back to it rather than reporting the source as unknown.
  const sourceFile = (doc && doc.file) || (doc && typeof doc.screen === "string" ? doc.screen : undefined);
  const { exportedAt, ageMs, problem } = snapshotAge(doc);
  const warning =
    problem === "missing" ? `no exportedAt stamp in ${label} — freshness unknown (re-export with the current plugin)`
    : problem === "unparseable" ? `exportedAt ('${exportedAt}') is not a parseable timestamp`
    : undefined;
  return { file, exportedAt, ageMs, sourceFile, warning };
}

module.exports = { readSnapshotInfo, snapshotAge };
