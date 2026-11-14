// seed-file.ts — figma_write's `seedTokens {file, collection?}`: a project's token file read into the create tables
// (token-seed.ts maps it) BEFORE anything else looks at the batch, like a `treeFile` (spec-file.ts). The op becomes
// its createVariables and createStyles ops in place, so the dry run, every check, the one-undo write and the put-back
// are the create tables' own, and no token value passes through the model.
//
// Every file read — the token file, a resolver's every `$ref` — stays inside the directory the server was started in
// (the `resolve` callback refuses the rest), is a regular file, at most MAX_SPEC_FILE_BYTES, and JSON. A `$ref` that is
// a URL, an absolute path, a pointer into the resolver or a fragment is refused (token-seed.ts refProblem).
//
// The reply to a seeded table is cut to what changed: the rows created or updated (with their ids) and a count of the
// unchanged ones, with the tokens that were not seeded beside them. A second identical seed reports no change.
import fs from "node:fs";
import path from "node:path";
import type { AppliedWrite, CreateOutcome, WritePreviewStep, WriteResult } from "./commands.ts";
import { MAX_SPEC_FILE_BYTES } from "./spec-file.ts";
import { isResolverDoc, resolverRefs, SEED_FORMATS, seedFromDtcg, seedFromResolver, type SeedOp, type SeedUnmapped } from "./token-seed.ts";

/** The most files one resolver may name (its sets' and contexts' `$ref`s). */
export const MAX_SEED_FILES = 200;
/** The most ops one figma_write runs (its schema's cap), counted after seedTokens became its tables. */
export const MAX_WRITE_OPS = 50;

/** What one seedTokens op became: the input op's index, the file, and where its tables sit in the batch sent on. */
export interface SeedRecord {
  index: number;
  file: string;
  /** the first of its tables in the batch sent to the plugin, and how many there are */
  first: number;
  count: number;
  /** each table: a collection's name, or null for the styles; and its row names in order */
  tables: Array<{ collection: string | null; names: string[] }>;
  unmapped: SeedUnmapped[];
}
type InOp = { op: string; file?: unknown; collection?: unknown } & Record<string, unknown>;

/** The extensions of the formats this does not read: CSS, Tailwind's theme.css and the native token files. */
const NOT_READ = /\.(css|scss|sass|less|swift|kt|kts|dart|js|jsx|ts|tsx|mjs|cjs)$/i;

/** A JSON file read whole, or why it is not: missing, not a file, too big, not JSON. */
function readJson(file: string, at: string): { json: unknown } | { error: string } {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return { error: `${at}: no file at ${file}` }; }
  if (!stat.isFile()) return { error: `${at}: ${file} is not a file` };
  if (stat.size > MAX_SPEC_FILE_BYTES) return { error: `${at}: ${file} is ${stat.size} bytes; a token file is at most ${MAX_SPEC_FILE_BYTES}` };
  try { return { json: JSON.parse(fs.readFileSync(file, "utf8")) as unknown }; } catch (e) {
    return { error: `${at}: ${file} is not valid JSON (${e instanceof Error ? e.message : String(e)}); seedTokens reads ${SEED_FORMATS}` };
  }
}

/**
 * Every seedTokens op replaced by the tables its file makes, or the first problem: a file that is refused, not read,
 * or makes nothing; a seedTokens after an op that is not a create table (they run first); more than MAX_WRITE_OPS ops
 * once expanded. `resolve` turns a path into the file to read and throws, with the reason, when it refuses it.
 */
export function loadSeedTokens<T extends InOp>(ops: readonly T[], resolve: (p: string, what: string) => string): { ops: Array<T | SeedOp>; seeds: SeedRecord[] } | { error: string } {
  const out: Array<T | SeedOp> = [];
  const seeds: SeedRecord[] = [];
  const firstOther = ops.findIndex((o) => o.op !== "seedTokens" && o.op !== "createVariables" && o.op !== "createStyles");
  for (const [i, o] of ops.entries()) {
    if (o.op !== "seedTokens") { out.push(o); continue; }
    const at = `ops[${i}]`;
    if (firstOther >= 0 && i > firstOther) return { error: `${at}: seedTokens goes before every other op of a batch (it comes after ops[${firstOther}], a ${String(ops[firstOther]?.op)}): its tables run first, so the ops after them can name what they make` };
    if (typeof o.file !== "string" || !o.file.trim()) return { error: `${at}.file: must be the path of the token file (${SEED_FORMATS})` };
    if (o.collection !== undefined && (typeof o.collection !== "string" || !o.collection.trim())) return { error: `${at}.collection: must be a collection name (a non-empty string)` };
    if (NOT_READ.test(o.file)) return { error: `${at}.file: '${o.file}' is not read (CSS and native token files lose the '/' grouping of the names); seedTokens reads ${SEED_FORMATS}` };
    let file: string;
    try { file = resolve(o.file, `${at}.file`); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
    const top = readJson(file, `${at}.file`);
    if ("error" in top) return top;
    const result = (() => {
      if (!isResolverDoc(top.json)) return seedFromDtcg(top.json, { collection: typeof o.collection === "string" ? o.collection : undefined, source: o.file });
      if (o.collection !== undefined) return { error: `${at}.collection: a resolver names its collections (each set's); leave \`collection\` out` };
      const refs = resolverRefs(top.json);
      if ("error" in refs) return { error: `${o.file}: ${refs.error}` };
      if (refs.refs.length > MAX_SEED_FILES) return { error: `${o.file} names ${refs.refs.length} files; a resolver read here names at most ${MAX_SEED_FILES}` };
      const files = new Map<string, unknown>();
      for (const ref of refs.refs) {
        const what = `${at}.file (${o.file}) $ref '${ref}'`;
        let p: string;
        try { p = resolve(path.join(path.dirname(file), ref), what); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
        const r = readJson(p, what);
        if ("error" in r) return r;
        files.set(ref, r.json);
      }
      return seedFromResolver(top.json, files, { source: o.file });
    })();
    if ("error" in result) return { error: result.error.startsWith("ops[") ? result.error : `${at} (seedTokens): ${result.error}` };
    seeds.push({
      index: i, file: o.file, first: out.length, count: result.ops.length, unmapped: result.unmapped,
      tables: result.ops.map((t) => (t.op === "createVariables" ? { collection: t.collection, names: t.variables.map((r) => r[0]) } : { collection: null, names: t.styles.map((s) => s.name) })),
    });
    out.push(...result.ops);
  }
  if (seeds.length && out.length > MAX_WRITE_OPS) {
    return { error: `the batch is ${out.length} ops once seedTokens made its tables (${seeds.map((s) => s.count + " from " + s.file).join(", ")}), and figma_write takes at most ${MAX_WRITE_OPS}: send the other ops in another call` };
  }
  return { ops: out, seeds };
}

/** The input op each op of the expanded batch came from (the same index when nothing was seeded). */
export function inputIndex(seeds: readonly SeedRecord[], expanded: number): number {
  let shift = 0;
  for (const s of seeds) {
    if (expanded < s.first) break;
    if (expanded < s.first + s.count) return s.index;
    shift += s.count - 1;
  }
  return expanded - shift;
}

/** One seeded table as the reply gives it: only the rows created or updated, and how many were unchanged. */
interface SeededTable {
  collection?: string;
  styles?: true;
  id?: string;
  result?: CreateOutcome;
  modesAdded?: string[];
  created?: Array<[string, string]>;
  updated?: Array<[string, string]>;
  unchanged: number;
}
/** What a seedTokens op did, in the reply's `applied`, at the op's own index. */
export interface SeededWrite { seeded: string; tables: SeededTable[]; unmapped?: SeedUnmapped[] }

function seededTable(t: SeedRecord["tables"][number], a: AppliedWrite | undefined): SeededTable {
  const created: Array<[string, string]> = [], updated: Array<[string, string]> = [];
  let unchanged = 0;
  for (const [j, row] of ((a && a.rows) || []).entries()) {
    const [id, what] = row;
    const name = t.names[j] ?? id;
    if (what === "created") created.push([name, id]);
    else if (what === "updated") updated.push([name, id]);
    else unchanged++;
  }
  return {
    ...(t.collection !== null ? { collection: t.collection } : { styles: true as const }),
    ...(a && a.id !== undefined ? { id: a.id } : {}),
    ...(a && a.result !== undefined ? { result: a.result } : {}),
    ...(a && a.modesAdded && a.modesAdded.length ? { modesAdded: a.modesAdded } : {}),
    ...(created.length ? { created } : {}),
    ...(updated.length ? { updated } : {}),
    unchanged,
  };
}

/** A write's reply with each seedTokens op's tables folded back into one entry at the op's index (only what changed),
 *  and a failure's op index given as the batch the agent sent. Nothing to do when nothing was seeded. */
export function seededReply(r: WriteResult, seeds: readonly SeedRecord[]): WriteResult | (Omit<WriteResult, "applied"> & { applied: Array<AppliedWrite | SeededWrite> }) {
  if (!seeds.length) return r;
  if (!r.ok) {
    if (r.failedAt === undefined) return r;
    const seed = seeds.find((s) => r.failedAt !== undefined && r.failedAt >= s.first && r.failedAt < s.first + s.count);
    const note = seeds.map((s) => `ops[${s.index}] (seedTokens '${s.file}') became ops[${s.first}${s.count > 1 ? "–" + (s.first + s.count - 1) : ""}] of the batch: ` +
      s.tables.map((t) => (t.collection !== null ? "createVariables '" + t.collection + "'" : "createStyles")).join(", ")).join("; ");
    return { ...r, failedAt: inputIndex(seeds, r.failedAt), ...(seed ? { failedOp: "seedTokens" } : {}), error: (r.error || "") + " (" + note + ")" };
  }
  const applied: Array<AppliedWrite | SeededWrite> = [];
  let k = 0;
  for (let e = 0; e < r.applied.length;) {
    const s = seeds[k];
    if (s && e === s.first) {
      const tables = s.tables.map((t, j) => seededTable(t, r.applied[e + j]));
      applied.push({ seeded: s.file, tables, ...(s.unmapped.length ? { unmapped: s.unmapped } : {}) });
      e += s.count;
      k++;
      continue;
    }
    const a = r.applied[e];
    if (a) applied.push(a);
    e++;
  }
  return { ...r, applied };
}

/** A dry run's step for a seedTokens op: its tables' steps under it, and the tokens not seeded. */
export interface SeedPreviewStep {
  index: number;
  op: "seedTokens";
  effect: "creates";
  target: string;
  change: string;
  tables: Array<Omit<WritePreviewStep, "index">>;
  unmapped: SeedUnmapped[];
  invalid?: string;
  refusedByFile?: string;
}
/** A dry run's steps with each seedTokens op's tables folded into one step at the op's index; the counts follow. */
export function seededPreview(p: { steps: WritePreviewStep[] } & Record<string, unknown>, seeds: readonly SeedRecord[]): Record<string, unknown> {
  if (!seeds.length) return p;
  const steps: Array<WritePreviewStep | SeedPreviewStep> = [];
  let k = 0;
  for (let e = 0; e < p.steps.length;) {
    const s = seeds[k];
    if (s && e === s.first) {
      const tables = p.steps.slice(e, e + s.count).map(({ index: _i, ...rest }) => rest);
      const vars = s.tables.filter((t) => t.collection !== null);
      const styles = s.tables.find((t) => t.collection === null);
      const change = "seeds from '" + s.file + "': " + [
        ...vars.map((t) => "collection '" + t.collection + "' (" + t.names.length + " variable" + (t.names.length === 1 ? "" : "s") + ")"),
        ...(styles ? [styles.names.length + " style" + (styles.names.length === 1 ? "" : "s")] : []),
      ].join(", ") + (s.unmapped.length ? "; " + s.unmapped.length + " token" + (s.unmapped.length === 1 ? " is" : "s are") + " not seeded (`unmapped`)" : "");
      const invalid = tables.map((t) => t.invalid).filter((x): x is string => x !== undefined);
      const refused = tables.map((t) => t.refusedByFile).filter((x): x is string => x !== undefined);
      steps.push({
        index: s.index, op: "seedTokens", effect: "creates", target: s.file, change, tables, unmapped: s.unmapped,
        ...(invalid.length ? { invalid: invalid.join("\n") } : {}), ...(refused.length ? { refusedByFile: refused.join("\n") } : {}),
      });
      e += s.count;
      k++;
      continue;
    }
    const step = p.steps[e];
    if (step) steps.push({ ...step, index: inputIndex(seeds, e) });
    e++;
  }
  const refusedByFile = steps.filter((x) => x.refusedByFile !== undefined).length;
  const { refusedByFile: _r, ...rest } = p;
  return {
    ...rest,
    creates: steps.filter((x) => x.effect === "creates").length,
    invalid: steps.filter((x) => x.invalid !== undefined).length,
    ...(refusedByFile ? { refusedByFile } : {}),
    steps,
  };
}
