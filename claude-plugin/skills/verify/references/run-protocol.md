# Verify run protocol

How one verify run reports progress, where its files live, and how it treats processes and permissions. The
verify skill, the build-screen skill and the visual-verifier agent all follow this one copy. `<scripts>` below is
the plugin's scripts folder — the skill or agent that sent you here gives its real path.

For the visual-verifier, the plugin's PreToolUse hook (`scripts/verifier-guard.js`) refuses pattern kills,
dependency and browser installs (reinstalls included) and `dangerouslyDisableSandbox` outright, so the rules below
about those are written for the orchestrator and the builder, whose calls no hook checks.

## Contents
- Status: one run, one id
- Waiting on a run
- The run cache
- What writes into the project, and when
- Stage, then publish
- Scratch scripts
- Processes
- Permission denials
- Bounded runs
- When a run ends `blocked` or `failed`

## Status: one run, one id

A pass takes minutes and prints nothing, so the caller cannot tell progress from a hang. Report progress through
the tool, never by hand — the tool stamps `rev`, `at` and the file hashes itself, atomically:

```bash
node "<scripts>/verify-screen.js" --status <Screen> --phase <p> --run <id> [--detail "<one line>"]
```

Use the run id you were given. Only when you were given none does your first call use `--new-run` instead of `--run`
(it prints `run <id> rev <n>`) — starting a new run while the caller holds an id forks it, and the caller's
`--wait` then ends in exit 5. Without `--run` a call only continues a run that has not ended. A run id is good for ONE pass: each verifier pass and each re-verify round
gets its own new run id. A run that ended (`done`, `failed`, `blocked`) takes no more writes, with or without
`--run <id>` — `--status` and the probe's `--run` both refuse them (exit 2). If the id you were given has already
ended, start a new run with `--new-run` and say so.

Phases, in order: `queued` → `starting` → `renderer-found` → `renderer-ready` → `measuring` → `measured` → `driving` → `done` (or `failed`, or `blocked`)

`renderer-ready` is whatever "ready to capture" means on the stack — dev server answering, simulator booted,
emulator up, test harness compiled. On web the probe writes `measuring` and `measured` itself when it is given
`--run <id>`. `measured` and `done` check the file: `<Screen>.measured.json` must exist and name the current
expectation (on native, write it before sending `measured`). Write `failed` with the reason when you give up, so
the last phase is never left hanging. The status (`designtwin/verify-status@2`) holds `runId`, `rev`, `phase`,
`detail`, `at` and the shas of the expectation, measured and evidence files.

## Waiting on a run

```bash
node "<scripts>/verify-screen.js" --wait <Screen> --run <id>
```

Exit 0 done and the measured file matches (and the evidence file, when the run published one), 1 failed or
`blocked` on permissions, 5 timeout or no progress, 6 run cache not accessible; defaults `--timeout 1200` s and
`--stall 300` s. Use it instead of a hand-rolled poll loop: a moving `rev` means work is happening, a `rev` that
has not moved for minutes is a real stall, and `phase` names the step to blame. `--wait` on an id that already
ended returns at once on that run's old `done`.

A pass legitimately takes far longer inside a build than standalone. Standalone is one capture against finished
code with the renderer often already warm; inside a build it runs once per fix round (render → report deltas →
the builder edits → re-render), each round paying its own cold start, and cold start is the expensive part on
every stack (a simulator boot or a Gradle build more so than a dev server). One observed run took ~25 min inside a
build with two fix rounds and ~3.5 min standalone afterwards. Budget per round, and treat a phase that stops
advancing for minutes as the real hang.

## The run cache

Heartbeats are free: every `--status` call writes the LIVE status in the run cache,
`node_modules/.cache/designtwin-verify/<Screen>.status.json` (the path is printed), which no dev server watches —
so a status write never touches the page being measured. `done` publishes the final status as
`design/verify/<Screen>.status.json`, the durable record.

The `node_modules` is the project's own: beside the nearest `package.json` at or above `design/verify` (the
workspace root's in a hoisted monorepo; never past the repo's `.git`), created if missing. With no `package.json`
(or Yarn PnP) the run cache is under the OS temp dir, which sandboxed and unsandboxed commands do not share — run
every `--status`, `--wait`, probe and `--compare` of one run the same way (all sandboxed or all not).

Exit 6 from `--status` or `--wait` means the run cache is not writable (or readable) from where you ran it — the
sandbox's write scope is the current directory and the temp dir — so run from the project root, or allow writes
there; the probe only prints the same as a warning and keeps its exit codes. `--status` and `--wait` resolve
`--dir` (default `design/verify`) against the current directory; from anywhere but the project root pass `--dir`
(an absolute path works).

Never reinstall dependencies (`npm ci`, `npm install`) during a verify run: it clears `node_modules/.cache` — the
live status and the staged files with it.

## What writes into the project, and when

Three things write into the project, each with no page of the app open: the probe (`measured.json` and the PNG —
it opens and closes its own browser, and writes only after closing it), `--compare` (the report — the caller runs
it after the verifier hands back), and `done` (the final status and the staged files). Close every page and
browser of the app you opened BEFORE running the probe or `--compare`: the probe measures in its own browser, so
what a write reloads is YOUR page — one still open when the probe or `--compare` writes is reloaded by the dev
server, loses the state you drove it into, and any interaction evidence you record on it afterwards counts that
reload as a document loaded (a `navEvents` the compare will not pass).

Measure the build the user will run. A `vite preview` or static server serves the LAST build: rebuild first, then
measure (an unchanged-but-stale preview measures old code). The probe records the build identity in
`measured.json`, and the report prints it and warns `SAME BUILD SERVED` (never verdict-changing) when the served
build did not change although the code did.

## Stage, then publish

Never write into the project tree while a page of the app is open. A dev server watches the project: on a Vite +
Tailwind v4 app, rewriting a file under `design/` while a Playwright session is connected fully reloads the very
page being measured. Keep everything else the run produces (`<Screen>.evidence.json`, state PNGs) in the run's
stage dir, `node_modules/.cache/designtwin-verify/stage/<runId>/` (`--status` prints it as `stage` and creates
it), close the browser, then publish in one step:

```bash
node "<scripts>/verify-screen.js" --status <Screen> --phase done --run <id> --publish <stageDir>
```

`done` checks the measured file first, then copies: it refuses (exit 1, nothing copied) when `measured.json` is
missing, was measured against a different expectation, in another run, or is not the file the probe recorded in
this run. `--publish` then copies each staged file into `design/verify/` atomically, and only evidence published in
this run is recorded as this run's. If the project reloads anyway, suggest Vite `server.watch.ignored:
['**/design/**']` or a Tailwind `@source not` for `design/`; these are suggestions, never edits to the project's
config.

## Scratch scripts

A throwaway script written to look at something goes in `node_modules/.cache/designtwin-verify/scratch/`
(project-local, writable from the project root, created on demand) — never under `src/` or `design/`, where the
project's linter, type-checker and dev server pick it up. Delete it when done. Write it (e.g. `scratch/drive.cjs`)
with the Write tool, never a shell heredoc (`cat <<EOF`) or `node -e`: Claude Code asks for approval of those for a
script holding braces and quotes.

Two allow rules cover this. `Edit(node_modules/.cache/designtwin-verify/**)` lets the Write tool write there (Claude
Code checks file writes against `Edit(...)` rules only, so a `Write(...)` path rule is never consulted; the same tree
holds the staged evidence). `Bash(node node_modules/.cache/designtwin-verify/scratch/*)` lets the script run.

## Processes

Close only what you opened; stop only a PID you started and recorded. Record the PID when you start a dev server
and stop that one and nothing else — never `pkill -f`, `killall` or any pattern kill: they take down the user's own
servers and editors. Reuse a dev server the user already runs rather than starting a second.

## Permission denials

A permission denial is not a sandbox violation. Never set `dangerouslyDisableSandbox`, and never ask the caller to
approve a bypass (nor the user, when you are the orchestrator). Three kinds:

- *Transient, no verdict* ("… is temporarily unavailable (…), so auto mode cannot determine the safety of …",
  "gave no verdict (timed out, …)", "could not evaluate this action … run with --debug"): wait a few seconds and
  retry the SAME command unchanged, at most twice, doing only read-only work meanwhile.
- *No verdict that retrying will not fix* ("a safety check separate from auto mode blocked this request because of
  earlier conversation content — it isn't about the action itself"): not a decision about the command, but the
  same conversation trips it again — do not retry; finish any other work you can, then stop.
- *A real block* (the classifier names a rule or reason): do not retry or rephrase it, and do not split the command
  to get round it.

Then write status phase `blocked` (detail = the denied command) and hand back "blocked on permissions: done /
remaining", suggesting the user approve it or add a narrow allow rule for `node …/verify-probe.js` /
`node …/verify-screen.js`, and `Edit(node_modules/.cache/designtwin-verify/**)` plus
`Bash(node node_modules/.cache/designtwin-verify/scratch/*)` when a scratch script or staged evidence was denied.

## Bounded runs

The probe stops itself at `--max-time` (default 180000 ms) with exit 4 and nothing written. Re-run it ONCE after an
exit 4 (with `--run` its exit 3/4 bumps the status, phase still `measuring`), then write status `failed` with the
navigation log — one re-run, never a loop.

## When a run ends `blocked` or `failed`

When the verifier hands back `blocked` (or `failed`), the run is over — report it, never overwrite it. Report the
reason from the status detail (the `detail` of the live status file — the path `--status` printed) and what
remains, and never write `done` over a run the verifier ended as `blocked`: a `done` there would hide the block from
`--compare`. An ended `blocked` stays `blocked` — the orchestrator reports its detail and never overwrites it with
`done`. To retry once the cause is fixed (a permission granted), the next attempt starts a new run with
`--new-run`.
