// delivery.ts — how an MCP export tool hands its read back: inline, written to disk, or refused; and, for a
// write, the note that says what it replaced or kept.
//
// The rules:
//   - writeToDisk:true is an explicit write, and the reply is never measured (a real export is tens of MB);
//   - otherwise the reply comes back inline when it fits the client's limit (write-out.ts inlineLimitChars);
//   - one that does not fit is written to disk on its own (an implicit spill, which keeps `.prev` copies of what it
//     replaces) — unless writeToDisk:false was passed, which is a refusal naming the size: an inline result past the
//     limit is not delivered whole, it is cut off mid-JSON;
//   - the note for a write, from write-out's change report (the .prev files it kept, the layer files it replaced, the
//     .prev files an earlier spill left on disk): only an implicit spill says any of it. An explicit write overwriting
//     its own files is the point of the write, so it keeps nothing and says nothing about earlier copies.
//
// Pure: no filesystem, no clock. What was on disk comes in as the change report; figma-mcp.ts does the writing.
import path from "node:path";
import type { ChangeReport } from "./write-out.ts";

export type Delivery =
  | { kind: "inline"; text: string }
  | { kind: "write"; implicit: false }
  /** `why`: the size the reply was past, for the note. */
  | { kind: "write"; implicit: true; why: string }
  | { kind: "refuse"; message: string };
export type WriteDelivery = Extract<Delivery, { kind: "write" }>;

/** `measure(limit)`: the inline text when it is at most `limit` characters, else null. Called only when inline is an option. */
export function decideDelivery(writeToDisk: boolean | undefined, measure: (limit: number) => string | null, limit: number): Delivery {
  if (writeToDisk === true) return { kind: "write", implicit: false };
  const text = measure(limit);
  if (text !== null) return { kind: "inline", text };
  const why = `this export is past the ${limit.toLocaleString("en-US")} characters (~${Math.round(limit / 4000)}k tokens) the client accepts inline (Claude Code keeps larger results out of the conversation, and MAX_MCP_OUTPUT_TOKENS can only lower this)`;
  if (writeToDisk === false) return { kind: "refuse", message: `${why}, and writeToDisk:false was passed. Omit it (or pass true) to get the files plus a compact index, or narrow the scope (a node id instead of a page, a lower depth).` };
  return { kind: "write", implicit: true, why };
}

/** What a write produced, as the note needs it: a screen (its JSON), a screenshot (its PNG, relative to `dir`), or a
 *  catalog with or without a page walk. `changes`: write-out's report (absent = nothing kept, replaced or earlier). */
export type Written =
  | { kind: "screen"; dir: string; screen: string; changes?: ChangeReport | undefined }
  | { kind: "screenshot"; dir: string; reference: string; changes?: ChangeReport | undefined }
  | { kind: "export"; dir: string; changes?: ChangeReport | undefined };

export interface WriteNote {
  note: string;
  /** The file the write is about: the screen JSON, the PNG, or the export directory. */
  file: string;
  /** A screen spill's .prev: the one it kept, else the one an earlier spill left. */
  prev?: string;
  /** An implicit full/design-system spill: how many .prev copies it kept (0 when none differed). */
  prevKept?: number;
}

const WRITTEN = "Export written to disk; node payloads intentionally omitted from this result. Read the files under outDir (start with the index) to inspect them at your own granularity.";
const ONE_LEVEL = "(one level — the next implicit spill replaces it)";

export function describeWrite(d: WriteDelivery, w: Written): WriteNote {
  const file = w.kind === "screen" ? w.screen : w.kind === "screenshot" ? path.join(w.dir, w.reference) : w.dir;
  if (!d.implicit) return { note: WRITTEN, file };
  const spilled = `Written to disk WITHOUT being asked: ${d.why}, so returning it inline would have been cut off mid-JSON. `;
  const c: ChangeReport = w.changes ?? { kept: [], replaced: [], earlier: [] };
  // A screenshot keeps nothing: its PNG is never overwritten (write-out versions a differing one).
  if (w.kind === "screenshot") return { note: spilled + WRITTEN, file };
  if (w.kind === "screen") {
    // writeScreen keeps ONLY the screen JSON's .prev — its siblings are replaced with no copy.
    const kept = c.kept[0];
    if (kept) return { note: spilled + `It replaced ${w.screen}; the previous version is kept at ${kept} ${ONE_LEVEL}. ` + WRITTEN, file, prev: kept };
    // An unchanged design keeps no new .prev, but the one the first spill wrote still holds the user's original: point at
    // it (an agent that never saw that first result has no other pointer to it).
    const earlier = c.earlier[0];
    if (earlier) return { note: spilled + `An earlier version is still at ${earlier} (this export matched what was on disk). ` + WRITTEN, file, prev: earlier };
    return { note: spilled + WRITTEN, file };
  }
  const n = c.replaced.length;
  const replaced = n ? `It replaced ${n} existing screen file(s) under ${path.join(w.dir, "pages")}` : "";
  let changed = "";
  if (c.kept.length) {
    changed = `${replaced ? replaced + ". The" : "The"} previous version of each changed file — ${c.kept.length} file(s) under pages/ or design-system/ (or design-system.json), e.g. ${c.kept[0]} — is kept beside it as <file>.prev ${ONE_LEVEL}. `;
  } else if (c.earlier.length) {
    // Nothing new kept, but an earlier spill's .prev files still hold what was replaced then.
    changed = `${replaced ? replaced + ". " : ""}Earlier versions are still kept as ${c.earlier.length} .prev file(s) beside their files (this export matched what was on disk). `;
  } else if (replaced) {
    changed = `${replaced} (none differed from what was on disk, so no .prev was kept). `;
  }
  return { note: spilled + changed + WRITTEN, file, prevKept: c.kept.length };
}
