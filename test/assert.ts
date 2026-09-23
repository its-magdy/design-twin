// The assertion runner shared by all three suites (harness.ts, bridge.test.ts, design-to-code.test.ts).
// Each used to carry its own collector + report loop, which differed only cosmetically — three exit
// conventions and three output formats for counts the project's docs quote as if they were one thing.
//
//   import { ok, report } from "./assert.ts";
//   ok("name", cond);
//   report();          // prints the summary, then exits 0 (all passed) or 1 (any failed)
//
// `check` is an alias for `ok`, kept because design-to-code.test.js reads more naturally with it.
//
// Results print as they are asserted rather than being held to the end: a suite that throws
// mid-run then still shows how far it got, which two of the three suites previously lost.

let pass = 0;
let total = 0;

export function ok(name: string, cond: unknown): boolean {
  total++;
  if (cond) { pass++; console.log("  ✓ " + name); }
  else console.log("  ✗ FAIL " + name);
  return !!cond;
}

export const check = ok;

// Exit non-zero if anything failed. Returns the counts so a caller can use them instead of exiting.
export function report({ exit = true }: { exit?: boolean } = {}): { pass: number; total: number } {
  console.log(`\n${pass}/${total} checks passed`);
  if (exit) process.exit(pass === total ? 0 : 1);
  return { pass, total };
}
