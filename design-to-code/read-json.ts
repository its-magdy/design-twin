// read-json.ts — the ONE way the design-to-code layer reads a JSON document off disk.
//
// readJson(file, guard) reads, parses and checks the file against a doc-guards.ts guard, and returns
// either the typed document or a one-line reason. It never throws and never exits: each caller keeps its
// own reporting convention (a CLI prints the reason and exits 2; a best-effort lookup treats an
// unreadable file as absent). This replaces the `JSON.parse(fs.readFileSync(f)) as T` reads — and the five
// generic `<T>(f) => … as T` helpers — that trusted every file to be what its name said.
import fs from "node:fs";
import { errMsg } from "../bridge/src/errmsg.ts";
import type { DocGuard } from "./doc-guards.ts";

/** readJson()'s result: the document, or why there is none. `missing` is set when the file does not exist. */
export type ReadResult<T> = { doc: T } | { error: string; missing?: true };

/** Any JSON value at all — for a caller that narrows the parsed value itself. */
export const anyJson: DocGuard<unknown> = (_x: unknown): _x is unknown => true;

// Why a read failed, in words (the same wording catalog-input.ts's readJsonFile has always printed).
function readFailure(e: unknown): { error: string; missing?: true } {
  const code = e && typeof e === "object" && "code" in e ? e.code : undefined;
  if (code === "ENOENT") return { error: "does not exist", missing: true };
  return {
    error: code === "EISDIR" ? "is a directory, not a file"
      : code === "EACCES" ? "is not readable (permission denied)"
      : `could not be read (${String(code || e)})`,
  };
}

/** Read + parse + check. The reason is a phrase that follows the file name: `'<file>' <error>`. */
export function readJson<T>(file: string, guard: DocGuard<T>): ReadResult<T> {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) { return readFailure(e); }
  let parsed: unknown;
  try { const value: unknown = JSON.parse(raw); parsed = value; } catch (e) { return { error: `is not valid JSON — ${errMsg(e)}` }; }
  if (!guard(parsed)) return { error: `is not ${guard.expected || "the expected kind of document"}` };
  return { doc: parsed };
}

/** The document, or null when it is absent, unreadable or the wrong shape — for best-effort lookups. */
export function readJsonOrNull<T>(file: string, guard: DocGuard<T>): T | null {
  const r = readJson(file, guard);
  return "doc" in r ? r.doc : null;
}
