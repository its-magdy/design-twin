// The writer for JSON files a person also edits (plans, the component map): atomic, and in the file's own format.
// Shared by bridge/ and design-to-code/ (the layer may import bridge/src; bridge cannot import the layer).
import fs from "node:fs";
import { writeFileAtomic } from "./atomic-write.ts";

// The file's own indentation: the first indented line's leading whitespace (2 spaces when the file has none).
const indentOf = (text: string): string => /\n([ \t]+)\S/.exec(text)?.[1] ?? "  ";

/** `value` as the text of the file it replaces — that file's BOM, indentation, line endings and final newline.
 *  `raw` is the file as read; null (no file yet) → 2 spaces, LF, a final newline. */
export function formatJsonLike(value: unknown, raw: string | null): string {
  if (raw === null) return JSON.stringify(value, null, 2) + "\n";
  const bom = raw.charCodeAt(0) === 0xfeff ? "﻿" : "";
  const text = raw.slice(bom.length);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return bom + JSON.stringify(value, null, indentOf(text)).split("\n").join(eol) + (/\n$/.test(text) ? eol : "");
}

/** Formats `value` like the file (formatJsonLike over `raw`, else the file as it is on disk now) and writes it
 *  atomically — a tmp file beside it, then a rename, so a kill mid-write leaves the old file whole — only when the
 *  bytes change. True when written. */
export function writeJsonLike(file: string, value: unknown, raw?: string | null): boolean {
  let was: string | null = raw ?? null;
  if (raw === undefined) try { was = fs.readFileSync(file, "utf8"); } catch { was = null; }
  const out = formatJsonLike(value, was);
  if (out === was) return false;
  writeFileAtomic(file, out);
  return true;
}
