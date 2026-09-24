// timeouts.ts — the per-command time budgets, split out of server-core.ts (same reason as
// staleness.ts): figma-pull.ts's exported, test-driven parseArgs picks its budgets from this table,
// and it must not load server-core (token resolution + a process.exit on a bad FIGMA_BRIDGE_PORT at
// module load) just to read two constants. No load-time effects. server-core.ts re-exports both names.

// Per-COMMAND time budgets, in ONE table. The budget is a property of the work, not of the caller, so
// both front-ends (figma-pull CLI, figma-mcp) read it from here instead of restating the tiers — a
// fourth caller would otherwise inherit `command` again, which is the 120s default tuned for
// ping/getSelection and far too small for anything that walks a page.
//   selection  — one hand-picked selection (small by construction)
//   list       — cheap RELATIVE to an export, not fast: depth 2 loads EVERY page, which Figma's own
//                docs call "slow for large documents". The tool you're told to call FIRST must not be
//                the first to fail on exactly the large files where looking before you pull matters.
//   export     — one page / one node: found the hard way on a ~1000-node file.
//   exportAll  — whole file / --all-pages: measured >15 min on a real 25-page file.
export const TIMEOUTS = { command: 120000, selection: 120000, list: 300000, export: 300000, exportAll: 900000 };

// The scope -> tier RULE, not just the table. Hoisting only the numbers still left both front-ends
// restating which tier an export picks, and they had already drifted (the MCP copy omitted the
// selection tier). One function so a new tier reaches every caller.
export const exportTimeout = ({ selection, allPages }: { selection?: boolean; allPages?: boolean } = {}): number =>
  selection ? TIMEOUTS.selection : allPages ? TIMEOUTS.exportAll : TIMEOUTS.export;

// How often the bridge pings each connected plugin socket, and so how long a silently dead one (a
// laptop lid closed mid-session, a pulled cable, a renderer that vanished without a FIN) can sit in the
// client registry looking live: a client that has not answered the PREVIOUS ping when the next tick
// fires is terminated, so detection takes between one and two intervals. 30 s is the interval of the
// ws README's own "How to detect and close broken connections?" example. Browsers answer pings in the
// network stack without involving page script, so a plugin busy with a long export still answers.
// createBridge's `heartbeatMs` option overrides it (the test suite uses a short one).
export const HEARTBEAT_MS = 30000;
