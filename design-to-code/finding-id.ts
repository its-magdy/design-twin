// finding-id.ts — the one id every audit / cross-check finding carries.
//
// An id is what a plan's `auditGate.overridden` names, so it must survive a re-run that adds or drops an
// UNRELATED finding. A positional scheme (`<code>#<i>`, i = position among the report's blockers) would not: one
// new blocker earlier in the report renumbers every id after it, and a plan's decision silently stops
// matching. The id here depends only on the finding itself:
//   * `code`            — a finding with no node (a file-level finding, e.g. a token-name collision);
//   * `code@nodeId`     — a finding about one node;
//   * `…~2`, `…~3`, …   — the 2nd, 3rd … finding with the SAME base in one report, in report order (the
//                         first keeps the bare base, so the common case never carries a suffix).
// audit.ts and cross-check.ts both call findingIds over their own findings, and audit merges cross-check's
// findings with code/nodeId intact, so a cross-file finding has the same id in both files.
// legacyBlockerIds is the older `#i` rule, kept so verify-build still accepts a plan written against it.

/** One id per finding, in order (see the rule above). */
export function findingIds(findings: ReadonlyArray<{ code: string; nodeId?: string | null | undefined }>): string[] {
  const seen = new Map<string, number>();
  return findings.map((f) => {
    const base = f.nodeId ? `${f.code}@${f.nodeId}` : f.code;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}~${n}`;
  });
}

/** The older positional ids: `<code>#<i>` per BLOCKER, i = its position among the report's blockers (a finding
 *  with no code is `blocker#<i>`). Only blockers get one; the result is as long as the blocker list. */
export function legacyBlockerIds(findings: ReadonlyArray<{ code?: string | null | undefined; severity?: string | null | undefined }>): string[] {
  return findings.filter((f) => f.severity === "blocker").map((f, i) => `${f.code || "blocker"}#${i}`);
}
