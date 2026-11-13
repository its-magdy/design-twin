// spec-file.ts — a createTree spec given as a path (docs/write-plane-spec.md decision 10).
//
// figma_write takes a tree spec inline (`tree`) or as a JSON file on disk (`treeFile`). A spec a script produced costs
// the model no tokens to send, and a corrected one is re-sent by path without retyping it. The MCP server reads the
// file and puts its content in the op as `tree` BEFORE anything else looks at the batch, so a spec given by path goes
// through exactly the checks, the dry run and the write the same spec inline does: the plugin never sees a path.
//
// Writes stay on the MCP server: the CLI has no write command, and this is not one.
import fs from "node:fs";

/** The biggest spec file read: a 500-node spec (tree-spec.ts MAX_TREE_NODES) is far below it. */
export const MAX_SPEC_FILE_BYTES = 2 * 1024 * 1024;

/** An op as figma_write receives it: the wire fields, and `treeFile`. */
type InOp = { op: string; tree?: unknown; treeFile?: string | undefined } & Record<string, unknown>;

/**
 * Every op with the spec its `treeFile` names read into `tree` (and `treeFile` gone), or the first problem: a path on an
 * op other than createTree, a path beside an inline spec, a file that is missing, too big or not JSON. `resolve` turns
 * the given path into the file to read (the server keeps it inside the directory it was started in) and throws, with
 * the reason, when it refuses it.
 */
export function loadSpecFiles<T extends InOp>(ops: readonly T[], resolve: (p: string, what: string) => string): { ops: T[] } | { error: string } {
  const out: T[] = [];
  for (const [i, o] of ops.entries()) {
    if (o.treeFile === undefined) { out.push(o); continue; }
    const at = `ops[${i}].treeFile`;
    if (o.op !== "createTree") return { error: `${at}: only a createTree op takes a spec from a file` };
    if (o.tree !== undefined) return { error: `ops[${i}]: give the spec inline (\`tree\`) or as a path (\`treeFile\`), not both` };
    let file: string;
    try { file = resolve(o.treeFile, at); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { return { error: `${at}: no file at ${file}` }; }
    if (!stat.isFile()) return { error: `${at}: ${file} is not a file` };
    if (stat.size > MAX_SPEC_FILE_BYTES) return { error: `${at}: ${file} is ${stat.size} bytes; a spec file is at most ${MAX_SPEC_FILE_BYTES} (send a large screen as several trees)` };
    let tree: unknown;
    try { tree = JSON.parse(fs.readFileSync(file, "utf8")) as unknown; } catch (e) {
      return { error: `${at}: ${file} is not valid JSON (${e instanceof Error ? e.message : String(e)})` };
    }
    const { treeFile: _path, ...rest } = o;
    out.push({ ...rest, tree } as T);
  }
  return { ops: out };
}
