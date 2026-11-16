// timeouts.ts — the per-command time budgets, split out of server-core.ts (same reason as
// staleness.ts): figma-pull.ts's exported, test-driven parseArgs (and read-plan.ts) pick their budgets from this table,
// and it need not load the whole bridge core just to read two constants. No load-time effects. Every caller imports
// them from here.
import { ALLOWED_PORTS } from "./ports.ts";

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
//   write      — a write batch, or a poll of one waiting for the designer's review (`writeTicket`). A batch that waits
//                for review (figma-plugin/src/review.ts) is answered by the plugin itself after at most the hold (below):
//                the result when the designer answered in time, else `{pending, ticket}`. So the budget is the longest
//                hold plus a margin for the batch itself (resolving and building a large tree), the command budget.
//
// The designer's review of a write (docs/write-plane-spec.md decision 18). MCP clients built on the TypeScript SDK time
// a tool call out at 60 s by default, so one figma_write call never holds longer than REVIEW_HOLD_MS (≤ REVIEW_HOLD_MAX_MS
// whatever a caller asks): the plugin then answers `{pending, ticket}` and keeps the card up; the agent polls with the
// ticket. A card whose agent stops polling is withdrawn REVIEW_IDLE_MS after the last pending answer; no card stays up
// longer than REVIEW_CARD_MAX_MS.
export const REVIEW_HOLD_MS = 45000;
export const REVIEW_HOLD_MAX_MS = 50000;
export const REVIEW_IDLE_MS = 120000;
export const REVIEW_CARD_MAX_MS = 15 * 60000;
export const TIMEOUTS = { command: 120000, selection: 120000, list: 300000, export: 300000, exportAll: 900000, write: REVIEW_HOLD_MAX_MS + 70000 };

// The scope -> tier RULE is read-plan.ts's (with the rest of what a read sends): hoisting only the numbers
// still left both front-ends restating which tier an export picks, and they had already drifted once (the
// MCP copy omitted the selection tier).

// How often the bridge pings each connected plugin socket, and so how long a silently dead one (a
// laptop lid closed mid-session, a pulled cable, a renderer that vanished without a FIN) can sit in the
// client registry looking live: a client that has not answered the PREVIOUS ping when the next tick
// fires is terminated, so detection takes between one and two intervals. 30 s is the interval of the
// ws README's own "How to detect and close broken connections?" example. Browsers answer pings in the
// network stack without involving page script, so a plugin busy with a long export still answers.
// createBridge's `heartbeatMs` option overrides it (the test suite uses a short one).
export const HEARTBEAT_MS = 30000;

// How long a NAMED --client target (file name / fileKey, not a c<N> connId) is waited for after the
// first plugin connects. Every open plugin window redials every PLUGIN_REDIAL_MS, one port at a time, so
// a file that is open lands within one walk of the three ports (3 s); 15 s is five such walks — room for
// a window Figma throttles in the background — and a name that never matches fails with the connected
// list instead of holding the terminal for the whole connect window.
export const NAMED_CLIENT_WAIT_MS = 15000;

// The longest delay one setTimeout holds: "When delay is larger than 2147483647 or less than 1, the delay
// will be set to 1" (nodejs.org/api/timers.html#settimeoutcallback-delay-args), so a longer wait would
// fire at once — or, re-armed, spin. Every wait or guard built from a caller's number stays within it.
export const MAX_TIMER_MS = 2147483647;

// How often an open plugin window redials a bridge it has lost or not found yet: figma-plugin ui.template.html
// REDIAL_MS (scheduleReconnect's `ms || REDIAL_MS`; test/ui.test.ts pins the two together), one port of
// the three per attempt (connect() walks BRIDGE_PORTS on every failed dial), so a window that keeps
// missing comes back to the same port every 3 s.
export const PLUGIN_REDIAL_MS = 1000;

// How long a bridge whose plugins have only just started connecting holds a request that does not name
// one file by connId or fileKey (no target, or a file name — names repeat and match as substrings) before
// routing it. Two open files redial on their own clocks, so right after a bridge starts, whichever lands
// first is all there is for a moment — and an unaddressed (or half-addressed) command would silently go to
// that file instead of being refused as ambiguous. A second window can be anywhere in its walk of the
// three ports, so it reaches this bridge's port up to one full walk (3 × PLUGIN_REDIAL_MS) after the
// first; that plus a margin for its `hello` covers every window that is redialling normally, for 3.5 s
// on an unaddressed one-shot command. The walk assumes a refused dial fails at once, as it does on macOS
// and Linux; on Windows a refused localhost connect can take about 2 s, so a walk there is longer and the
// settle covers less of it. A window Figma throttles in the background can still land later.
// Counted from the moment the bridge went from no plugin to one, and restarted when a plugin leaves while
// others stay (it is probably redialling), so a bridge whose plugins have been connected for longer (a
// daemon, a long MCP session) pays nothing until one of them leaves; a connId or fileKey is routed at
// once. A request's own connect window cannot cut the settle short.
export const SETTLE_MS = ALLOWED_PORTS.length * PLUGIN_REDIAL_MS + 500;

// The client-side guard on a request sent through a daemon: every phase the daemon's bridge may spend on it — the
// connect window, then at most NAMED_CLIENT_WAIT_MS for a named target (server-core awaitClient); a wait in the plugin's
// queue behind an earlier run in that file (figma-plugin state.ts scheduleRun), bounded by the command timeout armed
// at send; then the run itself, given the whole command timeout again when it starts (server-core re-arms it on the
// request's `start` frame) — and a margin (it also absorbs the settle, SETTLE_MS), so the daemon's own, clearer error
// normally lands before the guard does. Two command timeouts, because a request that takes no progress never relays
// that `start` to the guard (one that does re-arms the guard on every frame instead, as above). Not always first: the
// MAX_TIMER_MS cap below can cut the sum short.
// Capped at MAX_TIMER_MS: the guard is one setTimeout, which runs a longer delay after 1 ms.
export const daemonGuardMs = (timeoutMs: number, connectWaitMs: number = 0): number =>
  Math.min(2 * timeoutMs + connectWaitMs + Math.min(connectWaitMs, NAMED_CLIENT_WAIT_MS) + 30000, MAX_TIMER_MS);
