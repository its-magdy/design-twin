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

// The ONE freshness rule, shared with tooling/drift-lint.js: given a parsed catalog, what is its
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

function readSnapshotInfo(outDir) {
  const dir = outDir || process.env.FIGMA_EXPORT_DIR || "design";
  const file = path.join(dir, "design-system.json");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return null; // no export on disk yet — not an error, just nothing to report
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return { file, error: "design-system.json is not valid JSON: " + errMsg(e) };
  }
  const sourceFile = doc && doc.file;
  const { exportedAt, ageMs, problem } = snapshotAge(doc);
  const warning =
    problem === "missing" ? "no exportedAt stamp — freshness unknown (re-export with the current plugin)"
    : problem === "unparseable" ? `exportedAt ('${exportedAt}') is not a parseable timestamp`
    : undefined;
  return { file, exportedAt, ageMs, sourceFile, warning };
}

module.exports = { readSnapshotInfo, snapshotAge };
