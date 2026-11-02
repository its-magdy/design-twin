// presence.ts — which connected file a target names: none of them, exactly one, or several.
//
// The one decision behind every "is the plugin there, and which file do I mean?" answer: server-core's resolveClient
// (route the request, or refuse it), the waits in its awaitClient, figma_status and the dry run's "Allow edits" read
// (figma-mcp), `dtwin list clients`, and doctor. Each used to count rows for itself (0 / 1 / > 1, with or without a
// target); they now ask this, and only word the answer.
//
// The target rules, in order: an exact connId, then an exact fileKey, then a case-insensitive substring of the file
// name. No target names every connected file. A substring matching several files is "ambiguous", never the first.
// Pure: rows in, an answer out — the registry's entries, a listing's rows, or a daemon's relayed rows all fit.

/** What presence() reads of a row. */
export interface Addressable {
  connId?: string | null | undefined;
  fileKey?: string | null | undefined;
  file?: string | null | undefined;
}

export type Presence<R> =
  | { kind: "none" }
  | { kind: "one"; row: R }
  | { kind: "ambiguous"; rows: R[] };

/** The rows `target` names (every row for no target). */
export function matchTarget<R extends Addressable>(rows: readonly R[], target: string | null | undefined): R[] {
  if (target === undefined || target === null || target === "") return [...rows];
  const byId = rows.find((r) => r.connId === target);
  if (byId) return [byId];
  const byKey = rows.find((r) => r.fileKey && r.fileKey === target);
  if (byKey) return [byKey];
  const lower = target.toLowerCase();
  return rows.filter((r) => r.file && r.file.toLowerCase().includes(lower));
}

/** none | one(row) | ambiguous(rows) for `target` among `rows`. */
export function presence<R extends Addressable>(rows: readonly R[], target?: string | null): Presence<R> {
  const matched = matchTarget(rows, target);
  const [only] = matched;
  if (only === undefined) return { kind: "none" };
  if (matched.length === 1) return { kind: "one", row: only };
  return { kind: "ambiguous", rows: matched };
}
