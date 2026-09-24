// The assertion runner shared by all three suites (harness.ts, bridge.test.ts, design-to-code.test.ts).
// Each used to carry its own collector + report loop, which differed only cosmetically — three exit
// conventions and three output formats for counts the project's docs quote as if they were one thing.
//
//   import { ok, report } from "./assert.ts";
//   ok("name", cond);
//   report();          // prints the summary, then exits 0 (all passed) or 1 (any failed)
//
// `check` is the strict form (cond: boolean); `ok` is its loose twin, kept only until its last
// non-boolean callers are converted (see below).
//
// Results print as they are asserted rather than being held to the end: a suite that throws
// mid-run then still shows how far it got, which two of the three suites previously lost.
//
// `cond` is a boolean, not "anything truthy": `ok("x", obj.list)` passes on an EMPTY array and on a
// "0"-ish string alike, so a condition says what it checks (`.length > 0`, `!== undefined`, `===`).
//
// Fixtures: build them with test/fixtures.ts (typed builders that fill what the producer always writes)
// or check them with `satisfies`. Do NOT add `as unknown as <T>` to force a fixture into a type — that
// is exactly how fixtures drifted from the IR (a missing `tier`, a map entry with no `figma.name`) while
// the types said otherwise. A deliberately MALFORMED input goes through fixtures.ts `malformed()`, which
// says so at the call site.

let pass = 0;
let total = 0;

export function check(name: string, cond: boolean): boolean {
  total++;
  if (cond) { pass++; console.log("  ✓ " + name); }
  else console.log("  ✗ FAIL " + name);
  return cond;
}

// `ok` is now just an alias of `check`, kept so the ~91 existing call sites in test/harness.ts,
// test/bridge.test.ts and test/identity.test.ts (and the name itself, which reads better in some
// places) didn't all need renaming once every call site was made to pass a real boolean.
export function ok(name: string, cond: boolean): boolean {
  return check(name, cond);
}

// Exit non-zero if anything failed. Returns the counts so a caller can use them instead of exiting.
export function report({ exit = true }: { exit?: boolean } = {}): { pass: number; total: number } {
  console.log(`\n${pass}/${total} checks passed`);
  if (exit) process.exit(pass === total ? 0 : 1);
  return { pass, total };
}
