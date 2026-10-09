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
  let buf: Buffer;
  try { buf = fs.readFileSync(file); } catch (e) { return readFailure(e); }
  // A UTF-16 BOM (FF FE little-endian, FE FF big-endian) means decoding as UTF-8 below would either
  // throw or (worse) silently produce mojibake that then fails JSON.parse with a confusing error — catch
  // it up front and say what is actually wrong.
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    return { error: "is UTF-16, not UTF-8 — re-save it as UTF-8" };
  }
  let raw = buf.toString("utf8");
  // A UTF-8 BOM (EF BB BF, decoded as U+FEFF) is invisible but not valid JSON syntax — strip it before
  // parsing (verified: JSON.parse of a BOM'd file throws "Unexpected token" otherwise).
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
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
