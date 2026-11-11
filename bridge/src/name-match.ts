// name-match.ts — resolve a name an agent typed against the things a file has, never guessing.
//
// The write plane's rule (docs/write-plane-spec.md decision 15): a name that matches nothing, or more than one
// thing, refuses the write and lists up to three candidates. This is that rule in one pure function, shared by every
// write that takes a name (variable collections and modes today; components, variables and styles next) and by the
// CLI's "did you mean" (verbs.ts `distance`). Pure and dependency-free: the plugin bundle imports it.

/** Levenshtein distance between two strings. */
export function distance(a: string, b: string): number {
  // Levenshtein, one row at a time. `row` is the previous row (row[j] = distance(a[0..i-1), b[0..j)));
  // `diag`/`left` carry row[j-1] and the new row's [j-1] so no cell is read by index.
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  let last = b.length; // the bottom-right cell: row[b.length]
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    let diag = i - 1; // row[0] of the previous row
    let left = i;     // next[0]
    for (const [k, up] of row.slice(1).entries()) { // k = j - 1, up = row[j]
      const cur = Math.min(up + 1, left + 1, diag + (a[i - 1] === b[k] ? 0 : 1));
      next.push(cur);
      diag = up;
      left = cur;
    }
    row = next;
    last = left;
  }
  return last;
}

/** How many candidates a refusal lists. */
export const MAX_CANDIDATES = 3;

/** The up-to-three of `names` closest to `ref` (case-insensitive edit distance; a name containing `ref`, or
 *  contained in it, ranks first), without repeats, nearest first and in listing order on a tie. */
export function nearestNames(ref: string, names: readonly string[], max: number = MAX_CANDIDATES): string[] {
  const r = ref.toLowerCase();
  const scored = [...new Set(names)].map((n, i) => {
    const l = n.toLowerCase();
    return { n, i, contains: l.includes(r) || r.includes(l) ? 0 : 1, d: distance(r, l) };
  });
  scored.sort((a, b) => a.contains - b.contains || a.d - b.d || a.i - b.i);
  return scored.slice(0, max).map((s) => s.n);
}

/** What `ref` resolved to: exactly one item, nothing (with the nearest names), or several (all of them). */
export type NameMatch<T> =
  | { kind: "one"; item: T }
  | { kind: "none"; candidates: string[] }
  | { kind: "many"; matches: T[] };

/**
 * `ref` against `items`. An exact identifier (any of `exact(item)`: an id, a key) wins outright — it names one thing
 * by definition. Otherwise the name must equal exactly one item's `name(item)`, case and all: a near miss is never
 * taken, it is offered as a candidate.
 */
export function matchByName<T>(ref: string, items: readonly T[], name: (t: T) => string, exact: (t: T) => readonly string[] = () => []): NameMatch<T> {
  const byId = items.filter((t) => exact(t).includes(ref));
  if (byId.length === 1 && byId[0] !== undefined) return { kind: "one", item: byId[0] };
  const byName = items.filter((t) => name(t) === ref);
  if (byName.length === 1 && byName[0] !== undefined) return { kind: "one", item: byName[0] };
  if (byName.length > 1) return { kind: "many", matches: byName };
  return { kind: "none", candidates: nearestNames(ref, items.map(name)) };
}

/** `'a', 'b', 'c'` — names quoted for a refusal sentence. */
export function quoteList(names: readonly string[]): string {
  return names.map((n) => "'" + n + "'").join(", ");
}
