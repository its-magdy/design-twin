// Doc-guards for the build-screen skill, its web profiles and the screen-builder agent (field-test group 6).
//   node test/build-screen-docs.test.ts
// Each check asserts one rule is STATED in the text a builder reads; the map-status list is also
// compared with the validator's own source so the doc and the code cannot drift apart.
import fs from "node:fs";
import path from "node:path";
import { check, report } from "./assert.ts";
import { PASSING_VERDICTS } from "../design-to-code/plan-waivers.ts";
import * as PM from "../design-to-code/probe-match.ts";

const root = process.env.BUILD_SCREEN_DOCS_ROOT ?? path.join(import.meta.dirname, "..");
const read = (rel: string): string => {
  try { return fs.readFileSync(path.join(root, rel), "utf8"); }
  catch { console.log("  ✗ FAIL cannot read " + rel); return ""; }
};
const flat = (t: string): string => t.replace(/\s*\n\s*/g, " "); // prose wraps; the rules are sentences
const skill = flat(read("claude-plugin/skills/build-screen/SKILL.md"));
const twRaw = read("claude-plugin/skills/build-screen/profiles/web-tailwind.md");
const tw = flat(twRaw);
const cssm = flat(read("claude-plugin/skills/build-screen/profiles/web-css-modules.md"));
const builder = flat(read("claude-plugin/agents/screen-builder.md"));
const validate = read("design-to-code/map-validate.ts");
const step = (n: number): string => skill.split(new RegExp(` ${n}\\. \\*\\*`))[1]?.split(/ \d\. \*\*/)[0] ?? "";

console.log("build-screen docs (group 6):");
// DT-78
check("[DT-78] web-tailwind carries the v4 button cursor snippet", /button:not\(:disabled\)/.test(tw) && /cursor:\s*pointer/.test(tw));
check("[DT-78] web-tailwind: a design with no Pressed variant still gets a default `active:` treatment, recorded as defaulted", /no Pressed variant.{0,200}`active:`|`active:`.{0,200}no Pressed variant/i.test(tw) && /defaulted/.test(tw));
check("[DT-78] web-tailwind: a control wired to nothing must not look live", /wired to nothing.{0,200}(not look live|aria-disabled)/i.test(tw));
check("[DT-78] web-css-modules: button cursor is the browser arrow; set pointer on enabled buttons; `:active` default", /cursor:\s*pointer/.test(cssm) && /arrow/.test(cssm) && /no Pressed variant/i.test(cssm));
check("[DT-78] SKILL step 4: pressed feedback on every pointer type, not only touch", /pressed feedback on every pointer type/i.test(step(4)) && !/pressed feedback on touch/i.test(skill));
check("[DT-78] desktop-only design: designer question in SKILL and web-tailwind, with the default", /desktop-only design/i.test(skill) && /desktop-only design/i.test(tw) && /fluid down to/i.test(tw));
check("[DT-78] step 6 lists desktop-only/invented features among report items", /invented features/i.test(step(6)));
check("[F-113] web-tailwind has a Tables block (Contents + body) with min-w, overflow-x-auto and a `relative` wrapper", /Tables/.test(twRaw.split("\n").slice(0, 9).join("\n")) && /\*\*Tables\*\*.{0,40}`table-fixed`.{0,40}`min-w-/.test(tw) && /`overflow-x-auto` wrapper/.test(tw) && /wrapper `relative`/.test(tw));
check("[F-113] Tables pitfalls: negative margin on the wrapper, caption/border-separate, tolerance", /[Nn]egative margins go on the scroll wrapper/.test(tw) && /<caption>.{0,120}border-separate/.test(tw) && /compare with a tolerance/.test(tw));
// DT-61
check("[DT-61] hover-revealed controls: focus-within + coarse-pointer fallback, never invisible/hidden", /group-focus-within:opacity-100/.test(tw) && /pointer-coarse:opacity-100/.test(tw) && /never `invisible`/.test(tw) && /pointer-coarse:` is v4\.1\+.{0,80}\[@media\(pointer:coarse\)\]:opacity-100/.test(tw));
// DT-79
check("[DT-79] web-tailwind: `@source not` keeps design/ notes out of the compiled CSS", /@source not "/.test(tw) && /not evidence/i.test(tw));
// DT-64
check("[DT-64] a measurable a11y failure (WCAG contrast/target size) is never waived by a decision, deviation or 'kept as designed'", /1\.4\.3/.test(skill) && /2\.5\.8/.test(skill) && /never (be )?(closed|waived).{0,200}(decision|deviation)/i.test(skill) && /kept as designed/i.test(skill));
// DT-65
check("[DT-65] invented features get CSV-injection quoting and an href scheme allow-list", /invented feature/i.test(skill) && /`=`\/`\+`\/`-`\/`@`/.test(skill) && /http\/https\/mailto/.test(skill) && /dangerouslySetInnerHTML/.test(skill));
// DT-24 / D15
check("[DT-24] the absolute 'not the merged variables.json' is gone; the shared-shell rule is present", !/not the merged `variables\.json`/.test(skill) && !/not the merged `variables\.json`/.test(tw) && /shell shared by several screens/i.test(skill) && /shell shared by several screens/i.test(tw));
check("[D15] web-tailwind names `data-theme-<collection>` scoping for shared mode names (declared modes, besides the default)", /data-theme-<collection>/.test(tw) && /only one collection declares \(besides its default\)/.test(tw));
check("[D15] web-css-modules tokens.css note: `data-theme-<collection>` and the tokens.js warning", /data-theme-<collection>.{0,120}tokens\.js. warns which attributes/.test(cssm));
check("[DT-24] web-tailwind: `--font-figma-*` and STRING tokens left out of theme.css", /font-figma-\*/.test(tw) && /STRING/.test(tw));
// DT-26 / D13 / F-32
const statuses = /const STATUSES = \[([^\]]*)\]/.exec(validate)?.[1]?.match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? [];
check("[F-32] the map `status` enum in SKILL.md equals map-validate.ts STATUSES", statuses.length > 0 && skill.includes("`" + statuses.join("` | `") + "`"));
check("[F-32] SKILL.md mentions the optional `note` and that other keys are rejected", /`note`/.test(skill) && /any other key.{0,200}rejected/i.test(skill));
check("[D13] drift-lint no longer 'exits non-zero at 0%'; 0% is a warning with a confirm", !/exits non-zero at 0%/.test(skill) && /0% \(and `catalog-rekeyed`\) is a warning/.test(skill));
check("[DT-26] drift-lint/map-bootstrap read the library catalogs (`components.library.json`, `libraries/`)", /components\.library\.json/.test(skill) && /libraries\/\*\/components\.json.{0,80}libraries\/index\.json/.test(skill) && /design_drift_lint/.test(skill) && /map-bootstrap does the same only with `--screen`/.test(skill));
check("[DT-26] a subagent records the short list, sets awaiting-user and does not confirm for the user (skill and agent)", /subagent.{0,200}awaiting-user.{0,200}(not|never) confirm/i.test(skill) && /awaiting-user.{0,200}(not|never) confirm|(not|never) confirm.{0,200}(list|map)/i.test(builder));

console.log("build-screen docs (group 7, shipped web probe):");
const verifier = flat(read("claude-plugin/agents/visual-verifier.md"));
const verifySkill = flat(read("claude-plugin/skills/verify/SKILL.md"));
const verifyRef = flat(read("claude-plugin/skills/build-screen/references/verify.md"));
check("[G7] the verifier invokes scripts/verify-probe.js, with --check for the renderer and --expected/--url/--out to measure", /scripts\/verify-probe\.js" --check/.test(verifier) && /scripts\/verify-probe\.js".{0,200}--expected .{0,120}--url .{0,120}--out/.test(verifier));
check("[G7] the verify skill invokes verify-probe.js --check (no inline Playwright script) and the probe for measuring", /scripts\/verify-probe\.js" --check/.test(verifySkill) && /verify-probe\.js".{0,200}--expected/.test(verifySkill) && !/node --input-type=module -e/.test(verifySkill));
check("[G7] the verifier forbids writing its own probe and editing/rewriting the probe's measured.json", /never write your own probe/i.test(verifier) && /never (edit|.{0,20}edit).{0,80}(patch|rewrite).{0,40}`measured\.json`/i.test(verifier) && /interactions.{0,300}evidence\.json/.test(verifier) && /:focus-visible.{0,200}(keyboard Tab|Tab)/.test(verifier));
check("[G7] the verifier: exit 3 asks the user, exit 4 reports the navigation log, untagged nodes are reported not matched by hand", /exit 3.{0,200}ask the user/i.test(verifier) && /exit 4.{0,300}navigation log/i.test(verifier) && /tag it.{0,200}do not match them by hand/i.test(verifier));
check("[G7] no skill/agent doc tells the agent to run `npx playwright install` (only the user does; the agent asks)", /never run `npx playwright install`/i.test(verifier) && /never run either yourself/i.test(verifySkill) && !/playwright install[^.]{0,60}if the caller approves/i.test(verifier));
check("[G7] the verify skill: implicit baseline, --against, COVERAGE FELL, and a probe of `unknown` is not comparable", /--against/.test(verifySkill) && /COVERAGE FELL/.test(verifySkill) && /inputs\.probe.{0,40}unknown.{0,200}not comparable/i.test(verifySkill) && /\[--interactions design\/verify\/<Screen>\.evidence\.json\].{0,120}only when the verifier wrote that file/.test(verifySkill));
check("[G7] build-screen step 5 names verify-probe.js and says web measurements are never hand-written", /verify-probe\.js/.test(step(5)) && /never a hand-written one/i.test(step(5)));
check("[G7] references/verify.md: readiness on web is the probe's (fonts.ready, reduced motion, --ready), and networkidle is not used", /verify-probe\.js/.test(verifyRef) && /document\.fonts\.ready/.test(verifyRef) && /reduced motion/i.test(verifyRef) && /does not use `networkidle`/.test(verifyRef));


console.log("verify docs (group 9, pass-with-deviations and waivers):");
{
  const raw = read("claude-plugin/skills/verify/SKILL.md");
  const sec4 = raw.split(/^## 4\. /m)[1]?.split(/^## /m)[0] ?? "";
  const named = [...sec4.matchAll(/^- \*\*([a-z-]+)\*\* —/gm)].map((m) => m[1] ?? "").sort();
  const code = [...PASSING_VERDICTS, "fail", "incomplete"].sort();
  check(`[DT-28] the verdicts verify/SKILL.md §4 names = PASSING_VERDICTS + fail + incomplete (doc: ${named.join(", ")})`, JSON.stringify(named) === JSON.stringify(code));
  const accept = verifySkill.split("--accept")[0]?.slice(-600) ?? "";
  check("[DT-28] the verify skill runs --accept only on the user's explicit word, then re-runs the compare",
    /verify-screen\.js" --accept/.test(verifySkill) && /only on their explicit word/i.test(accept) && /re-run step 4/i.test(verifySkill));
  check("[DT-28] the verify skill: a waiver binds node id + field + designed + built + export hash and reopens; never waivable: missing component, failed interaction, not measured; descopes are the user's",
    /node id \+ field \+ designed value \+ built value.{0,80}whole export/.test(verifySkill) && /reopens/.test(verifySkill)
    && /Never waivable: a missing component, a failed interaction, anything not measured/.test(verifySkill) && /descope.{0,200}only the user decides/i.test(verifySkill)
    && /`undesigned`.{0,200}never blocks a pass/.test(verifySkill));
  check("[DT-28] the screen-builder never writes waivers/descopes or runs --accept", /never write `waivers\[\]` or `descopes\[\]`.{0,80}never run `verify-screen\.js --accept`/.test(builder));
  check("[DT-28] build-screen names verified-with-deviations; sync-design says a re-export reopens waivers",
    /`verified-with-deviations`/.test(skill) && /reopens every waiver/.test(flat(read("claude-plugin/skills/sync-design/SKILL.md"))));
}

console.log("verify docs (group 10, run integrity + agent safety):");
{
  // The one phase list: STATUS_PHASES in design-to-code/verify-run.ts (read as text, like STATUSES above);
  // until that file lands, the list the group's interface fixed.
  const runSrc = fs.existsSync(path.join(root, "design-to-code/verify-run.ts")) ? read("design-to-code/verify-run.ts") : "";
  const fromCode = /STATUS_PHASES\s*=\s*\[([^\]]*)\]/.exec(runSrc)?.[1]?.match(/"([^"]+)"/g)?.map((x) => x.slice(1, -1));
  const phases = fromCode ?? ["queued", "starting", "renderer-found", "renderer-ready", "measuring", "measured", "driving", "done", "failed", "blocked"];
  const chain = (t: string): string[] => {
    const m = [...t.matchAll(/`queued`[^.]*?(?:`blocked`)/g)][0]?.[0] ?? "";
    return [...m.matchAll(/`([a-z-]+)`/g)].map((x) => x[1] ?? "");
  };
  const inDoc = (t: string): string => phases.map((p) => "`" + p + "`").every((p) => t.includes(p)) ? "ok" : "missing";
  check("[F-72] the verifier and references/verify.md list exactly STATUS_PHASES, in order, and the old `comparing`/`rendered` phases are gone",
    JSON.stringify(chain(verifier)) === JSON.stringify(phases) && JSON.stringify(chain(verifyRef)) === JSON.stringify(phases)
    && inDoc(verifySkill) === "ok" && !/`comparing`|`rendered`|`starting\|renderer-found/.test(verifier + verifyRef));
  check("[F-72] status is written with verify-screen.js --status --phase --run (never by hand) and waited on with --wait --run, in the verifier, the verify skill, references/verify.md and build-screen",
    [verifier, verifySkill, verifyRef].every((t) => /--status <Screen> --phase <(phase|p)> --run <id>|--status <screen> --phase <p> --run <id>/.test(t) && /--wait <(Screen|screen)> --run <id>/.test(t))
    && /never by hand/.test(verifier) && /--wait <Screen> --run <id>/.test(skill) && !/"at": "<ISO timestamp>"|date -u \+%Y-%m-%dT%H:%M:%SZ`\. A/.test(verifier));
  check("[F-72] the probe is given --run <id> and writes measuring/measured itself", /verify-probe\.js".{0,300}--run <id>/.test(verifier) && /verify-probe\.js.{0,300}--run <id>/.test(verifySkill));
  // (phrases matched loosely: whitespace and line breaks collapse, case-insensitive where it is prose)
  const ws = (t: string): string => t.replace(/\s+/g, " ");
  check("[D9] [F-91] the verifier stages evidence.json and state PNGs in node_modules/.cache/designtwin-verify/stage/<runId>/ and publishes with --phase done --publish; nothing written into the project while a page is open; watch-ignore is only a suggestion",
    [verifier, verifySkill, verifyRef].every((t) => /node_modules\/\.cache\/designtwin-verify\/stage\/<runId>\//.test(t) && /--publish <stageDir>/.test(t) && !/<os tmpdir>\/designtwin-verify/.test(t))
    && /never write into the project tree while a page of the app is open/i.test(verifier) && /server\.watch\.ignored/.test(verifier) && /@source not/.test(verifier) && /suggestions, never edits/i.test(verifier));
  check("[F-99] every non-measurement claim carries its evidence (command + count, path + stat mtime, navigation log) and unproven leads are listed separately and labelled (verifier and verify skill)",
    [verifier, verifySkill].every((t) => /not a measurement carries its evidence/i.test(t) && /stat` mtime/.test(t) && /navigation log/.test(t) && /unproven leads/.test(t)));
  check("[F-105] close only what you opened, stop only a PID you started and recorded, never pkill -f / killall / pattern kills, reuse the user's dev server",
    [verifier, verifySkill].every((t) => /only what you opened/i.test(t) && /PID you started and recorded/.test(t) && /never `pkill -f`, `killall`/i.test(t) && /(reuse|reusing) a dev server the user/i.test(t)) && /never `pkill -f`/.test(verifyRef));
  check("[H1] the live status lives in the run cache (node_modules/.cache/designtwin-verify/), so heartbeats never touch the project; done publishes design/verify/<S>.status.json (verifier, verify skill, references/verify.md, build-screen)",
    [verifier, verifySkill, verifyRef].every((t) => /node_modules\/\.cache\/designtwin-verify\/<(Screen|screen)>\.status\.json/.test(t) && /heartbeats are free|status writes are free/i.test(ws(t)) && /publish\w* the final status/i.test(ws(t)))
    && /node_modules\/\.cache\/designtwin-verify/.test(skill) && /published as `design\/verify\/<screen>\.status\.json` at `done`/.test(ws(skill)));
  check("[M3] done checks the measured file before it copies anything (verifier, verify skill, references/verify.md)",
    /`done` checks first and publishes only then/.test(ws(verifier)) && [verifySkill, verifyRef].every((t) => /`done` checks the measured file first, then copies/.test(ws(t))));
  check("[F-106] 'a safety check separate from auto mode blocked this request' is labelled a no-verdict denial that retrying will not fix (not a real block); the transient form is 'temporarily unavailable …, so auto mode cannot determine the safety of'",
    [verifier, verifySkill, verifyRef].every((t) => { const x = ws(t); return /safety check separate from auto mode blocked this request.{0,300}(retrying will not|do not retry)/i.test(x) && /temporarily unavailable.{0,20}so auto mode cannot determine the safety of/i.test(x); })
    && !/real\* block \(the classifier names a rule or reason, or "a safety check/.test(ws(verifier)));
  check("[F-106] a permission denial is not a sandbox violation: never dangerouslyDisableSandbox, transient no-verdict retried unchanged at most 2 times, a real block is neither retried nor rephrased, then status blocked + hand-back with a narrow allow rule",
    [verifier, verifySkill].every((t) => /never (set|use) `dangerouslyDisableSandbox`/i.test(t) && /(at most 2 retries|at most twice)/i.test(t) && /(do not rephrase|do not retry or rephrase)/i.test(t) && /blocked on permissions: done \/ remaining/.test(t) && /narrow allow rule/.test(t))
    && /`blocked`/.test(verifyRef) && /dangerouslyDisableSandbox/.test(verifyRef));
  check("[F-107] the probe is bounded by --max-time (exit 4); one re-run after exit 4, then status failed — never a loop", [verifier, verifySkill].every((t) => /--max-time/.test(t) && /ONCE/.test(t) && /status `failed`/.test(t)) && /one re-run/.test(verifyRef));
  check("[DT-29] nodeId and trigger are copied VERBATIM from the expectation row; a pair that matches no row is reported", /VERBATIM from the\s+expectation row/.test(verifier) && /VERBATIM from the expectation row/.test(verifySkill) && /matched no designed interaction/.test(verifier + verifySkill));
  check("[F-102] each interaction records outcome (url-changed | dialog-opened | selector-appeared | state-changed | none) and navEvents; a pass needs exactly one match, an allowed outcome, no unexpected navigation; else not-probed; the example carries both fields",
    [verifier, verifySkill].every((t) => /`url-changed`.{0,20}`dialog-opened`.{0,20}`selector-appeared`.{0,20}`state-changed`.{0,20}`none`/.test(t) && /navEvents/.test(t) && /ONE (matched )?(element|match)/.test(t) && /not-probed/.test(t))
    && /"outcome": "dialog-opened", "navEvents": 0/.test(verifier));
  check("[M1] navEvents counts DOCUMENTS LOADED (a reload or a full navigation) — not framenavigated / pushState / hash changes; navigate, back or url may load one; an in-page url-changed passes wherever allowed",
    [verifier, verifySkill].every((t) => { const x = ws(t); return /documents loaded/i.test(x) && /pushState/.test(x) && /navigate, back or url/.test(x); })
    && /never count `framenavigated`/.test(ws(verifier)) && /load` events/.test(ws(verifier)) && !/probe's navigation log or your own `framenavigated`/.test(ws(verifier)) && !/Only a designed navigation may have/.test(ws(verifier)));
  check("[DT-81] rebuild before measuring a preview/static build; the report prints the build identity and warns SAME BUILD SERVED", [verifier, verifySkill, verifyRef].every((t) => /[Rr]ebuild/.test(t) && /SAME BUILD SERVED/.test(t)));

  // ---- group 10 review fix 2
  // M-1: the probe and --compare write into design/verify too, so every page of the app the agent opened is closed
  // BEFORE either runs — the rule is stated in each doc, and where a doc shows the probe command, it comes first.
  const closeRule = /[Cc]lose every page and browser of the app you opened BEFORE running the probe or `--compare`/;
  const closeAt = (t: string): number => t.search(/close(s)? every page and browser of the app (you|it) opened/i);
  const probeAt = (t: string): number => t.search(/verify-probe\.js"? \\? ?--expected/);
  check("[M-1] verifier, verify skill, references/verify.md and build-screen: close every page and browser of the app you opened BEFORE running the probe or --compare",
    [verifier, verifySkill, verifyRef, skill].every((t) => closeRule.test(t)));
  check("[M-1] …and the close rule comes BEFORE the probe command wherever a doc shows it (verifier §4, verify skill, build-screen)",
    [verifier, verifySkill, skill].every((t) => probeAt(t) > 0 && closeAt(t) >= 0 && closeAt(t) < probeAt(t))
    && /First close every page and browser of the app you opened \(§2\)/.test(verifier) && /first closes every page and browser of the app it opened, then runs the shipped probe/.test(verifySkill));
  check("[M-1] the probe writes only after closing its own browser (verifier, verify skill, references/verify.md)",
    [verifier, verifySkill, verifyRef].every((t) => /opens and closes its own browser,? and writes only after closing it/.test(t)));
  check("[M-1] the verifier no longer says only `done` writes into the project; it names the probe's and --compare's own writes, each with no page open",
    !/Only `done` writes into the project/.test(verifier) && /Three things write into the project, each with no page of the app open: the probe .{0,200}`--compare` .{0,120}`done`/.test(verifier));
  // M-2 / M-a: the run cache is the project's own node_modules (nearest package.json, or the hoisted workspace root,
  // never past .git); the tmpdir fallback (no package.json, PnP) is not shared across the sandbox
  check("[M-2] [M-a] the run cache is beside the nearest package.json at or above design/verify (a hoisted monorepo's workspace root, never past .git); without one (or PnP) the OS temp dir, not shared by sandboxed and unsandboxed commands — run them all the same way",
    [verifier, verifySkill, verifyRef].every((t) => /nearest `package\.json` at or above `design\/verify`/.test(t) && /workspace root/.test(t) && /never past the repo's `\.git`/.test(t)
      && /With no `package\.json` \(or Yarn\s+PnP\)/.test(t) && /sandboxed and unsandboxed commands do not share/.test(t) && /the same way/.test(t) && !/nearest (one|`node_modules`) at or above/.test(t)));
  check("[M-a] exit 6 = the run cache is not accessible: in every --wait exit list, and each doc says run from the project root or allow writes there; the probe only warns",
    [verifier, verifySkill, verifyRef, skill].every((t) => /5 timeout or no progress[^)]{0,40}, 6 run cache not accessible/.test(t))
    && [verifier, verifySkill, verifyRef].every((t) => /Exit 6 from `--status` or `--wait` means the run cache is not writable/.test(t) && /run from the project root, or allow\s+writes there/.test(t) && /the probe only prints the same as a warning/.test(t)));
  check("[L-b] the verifier says the probe measures in its own browser, so a write reloads the agent's OWN open page and its later interaction evidence",
    /the probe measures in its own browser, so what a write\s+reloads is YOUR page/.test(verifier) && /interaction evidence you record on it afterwards/.test(verifier) && !/the measurement records 1 document loaded/.test(verifier));
  // L-4: evidence is staged and published, never written into design/verify directly
  check("[L-4] the verify skill never has the agent write design/verify/<Screen>.evidence.json directly: staged, then published at done",
    !/judges absent, in `design\/verify\/<Screen>\.evidence\.json`/.test(verifySkill) && /in `<Screen>\.evidence\.json` — staged in the run's stage dir and published into `design\/verify\/` at `done`, never written there directly/.test(verifySkill));
  // L-5 / L-7 / L-8
  check("[L-5] --wait exit 5 is 'timeout or no progress' everywhere (never 'no timeout/progress')",
    [verifier, verifySkill, verifyRef].every((t) => /5 timeout or no progress/.test(t) && !/no timeout\/progress/.test(t)));
  check("[L-7] never reinstall dependencies (npm ci / npm install) during a verify run — it clears node_modules/.cache (live status + staged files)",
    [verifier, verifySkill, verifyRef].every((t) => /Never reinstall dependencies \(`npm ci`, `npm install`\) during a verify run/.test(t) && /clears `node_modules\/\.cache`/.test(t)));
  check("[L-8] --status/--wait resolve --dir (default design/verify) against the current directory; from elsewhere pass --dir (absolute works)",
    [verifier, verifySkill, verifyRef].every((t) => /`--status` and `--wait` resolve `--dir` \(default `design\/verify`\) against the current directory/.test(t) && /an absolute path works/.test(t)));
  // L-6: integrity failures outrank the grades
  check("[L-6] the verify skill says an integrity failure makes the verdict incomplete even with high mismatches (the numbers belong to an unverified run)",
    /even when there are high mismatches: those numbers belong to an unverified run/.test(verifySkill) && /even with high mismatches/.test(verifySkill));
}

console.log("verify docs (group 11, match confidence + per-node-type rules):");
{
  // the canonical list from the probe's own source (read through the namespace: an older tree is a clean ✗)
  const pmNs: Record<string, unknown> = { ...PM };
  const canon = Array.isArray(pmNs.CANONICAL_MATCHED_BY) ? pmNs.CANONICAL_MATCHED_BY.filter((x): x is string => typeof x === "string") : [];
  const listed = /`matchedBy` is one of the values the probe writes: ((?:`[a-z-]+`(?:, )?)+)\./.exec(verifier)?.[1]?.match(/`([a-z-]+)`/g)?.map((x) => x.slice(1, -1)) ?? [];
  check(`[F-125] the visual-verifier's matchedBy list = probe-match.ts CANONICAL_MATCHED_BY (doc: ${listed.join(", ")})`, canon.length > 0 && JSON.stringify(listed) === JSON.stringify(canon));
  check("[D32] the verifier says what tag-alias means (another screen's id for the same node, the row's `aliases`) and the D30 caps",
    /`tag-alias` is an element tagged with the id the same node has in another screen's export/.test(verifier) && /`aliases`/.test(verifier)
    && /`text-ordinal` or `tag-alias` is at most medium, by `position` or any value you invent at most\s+low/.test(verifier));
  check("[F-62] the verifier's textBox row: for EVERY TEXT node, and a TEXT node's x/width come from textBox only",
    /\| `textBox` \| for every TEXT node:/.test(verifier) && /x and width are compared from `textBox` only/.test(verifier) && !/\| `textBox` \| for a TEXT node:/.test(verifier));
  check("[DT-74] the verifier: a ring (box-shadow 0 0 0 Npx, five shadows, by content not position) or an inside outline is borderWidth/borderColor with strokeFrom + strokeAlign",
    /`box-shadow: 0 0 0 Npx`/.test(verifier) && /five shadows/.test(verifier) && /never by\s+its position/.test(verifier) && /`outline-offset: -Npx`/.test(verifier) && /`strokeFrom` \(`box-shadow` \| `outline`\)/.test(verifier) && /`strokeAlign`\s+\(`inside` \| `outside`\)/.test(verifier));
  check("[D30] the verify skill: text-ordinal/tag-alias at most medium, position and non-canonical at most low, cappedFrom, a tag removes the cap",
    /`text-ordinal` or `tag-alias` is at most medium; by `position` or any other value a hand-written probe invents \(`structural`, …\), at most low/.test(verifySkill) && /`cappedFrom`/.test(verifySkill) && /removes the cap/.test(verifySkill));
  check("[D39] the verify skill documents cappedBy (\"match\" | \"size\") beside cappedFrom",
    /`cappedFrom`, and `cappedBy` says which cap\(s\) applied \(`"match"` for this one, `"size"` for the\s+`match \(size\)` cap below\)/.test(verifySkill));
  check("[D31] the verify skill: `match (size)` — ≥2× / ≤½ and ≥8px off, hug-growth rule, one medium row, the node's other deltas capped at low, waivable",
    /`match \(size\)`/.test(verifySkill) && /at least twice \(or at most half\)/.test(verifySkill) && /at least 8px off/.test(verifySkill) && /only when the other axis is off too/.test(verifySkill)
    && /one medium `match \(size\)` row/.test(verifySkill) && /caps every other delta of that node at low/.test(verifySkill) && /waiver on\s+`match \(size\)` accepts the element/.test(verifySkill));
  check("[D29] the verify skill: hug text box to box (1px); fixed/fill text by ink width (renderBox.w, 3px, `width (text ink)`), box notComparable",
    /Hug text \(auto width\) is compared box to box, tolerance 1px/.test(verifySkill) && /`renderBox\.w`\), tolerance 3px, labelled `width \(text ink\)`/.test(verifySkill) && /`notComparable`/.test(verifySkill));
  check("[D29] [A7] the verify skill: width not comparable only when the DESIGN truncates (ink ≥ box − 3, or maxLines > 1); otherwise by ink; a placeholder's width/x not comparable",
    /not comparable only when the DESIGN\s+truncates/.test(verifySkill) && /ink ≥ box − 3px/.test(verifySkill) && /`maxLines` > 1/.test(verifySkill) && /compared by ink/.test(verifySkill)
    && /placeholder's width and x\s+are not comparable/.test(verifySkill) && !/Truncated text's width is not comparable/.test(verifySkill));
  check("[D30] [A7] caps: `data-dt-node` and `id` read as tag, no matchedBy is no cap — never 'any value outside the probe's own list' (verify skill and verifier)",
    /synonyms `data-dt-node` and `id` \(read as `tag`\), or no `matchedBy` at all/.test(verifySkill) && !/any\s+value outside the probe's own list/.test(verifySkill)
    && /`data-dt-node` and `id` read as `tag`; no `matchedBy` is no cap/.test(verifier) && !/by `position` or any other value at most/.test(verifier));
  check("[F-75] [F-79] [F-78] [opacity] the verify skill: radius on a layer that draws nothing, padding a fixed axis cannot show, inline FRAME ids, stated opacity + at-rest opacity under a drawn state",
    /radius on a layer that draws nothing/i.test(verifySkill) && /padding a fixed axis cannot show — per side/.test(verifySkill) && /`display: inline`.{0,200}tag the element that owns the box/.test(verifySkill)
    && /Opacity is stated on every node that paints or carries copy/.test(verifySkill) && /measured\s+at rest is not measured for opacity/.test(verifySkill));
  check("[D31] [A7] match (size) names its exemptions: TEXT, leaves, inline matches; a frame root's grown height", /TEXT nodes, leaves and inline matches are exempt/.test(verifySkill) && /frame root's height that\s+only grew/.test(verifySkill));
  check("[DT-48] the verify skill: radius on a <tr>/row group is not measured (rows don't draw corners)", /`border-radius` on a `<tr>`.{0,80}does not\s+render/.test(verifySkill) && /corner\s+cells' radii/.test(verifySkill));
  check("[DT-74] the verify skill: rings/outlines read as the border; CSS-snapped border width vs raw ring width, tolerance 0.5px",
    /`box-shadow: 0 0 0 Npx`/.test(verifySkill) && /`strokeFrom`/.test(verifySkill) && /floors a border to whole pixels, minimum 1px/.test(verifySkill) && /tolerance 0\.5px/.test(verifySkill));
  check("[D33] [DT-47] the verify skill: the shared-shell split and foreign tags are informational, never verdict-changing",
    /nodes measured a\/b \(shared shell c\/d\)/.test(verifySkill) && /`untaggedInstanceSetsInShell`/.test(verifySkill) && /The split never changes the verdict/.test(verifySkill)
    && /`probe\.foreignTags`/.test(verifySkill) && /Foreign tags are informational/.test(verifySkill) && /They never change the verdict/.test(verifySkill));
  check("[F-85] build-screen: a shared shell MAY keep one frame's ids (recovered by component path + name path aliases), but a per-screen id table measures more; either is fine, never invent ids",
    /shell shared by several screens may keep the ids of ONE frame/.test(skill) && /recovers much of it/.test(skill) && /by name path through\s+the aliases/.test(skill)
    && /not repeated names, a shell used twice, or a hand-written probe/.test(skill) && /per-screen id table .{0,80}still measures more/.test(skill) && /Either is fine — never invent ids/.test(skill)
    && !/don't hand-maintain a per-screen id table/.test(skill) && !/keeps the ids of ONE frame/.test(skill));
  check("[D39] capped deltas block a plain pass (incomplete, never fail/pass, 'tag these elements') — verify skill and verifier",
    /any capped delta blocks a plain pass: the verdict is `incomplete`/.test(verifySkill) && /low-confidence matches — tag these elements/.test(verifySkill) && /never `fail`, never `pass`/.test(verifySkill)
    && /Any capped delta keeps the\s+screen from a plain pass \(verdict `incomplete`/.test(verifier));
  check("[D39] a waiver on match (size) lifts ONLY the size cap; a match-confidence cap (position, tag-alias, text-ordinal, hand-written) stays (old 'restores'/'capped lows never block' gone)",
    /`match \(size\)` accepts the element and lifts ONLY the size cap/.test(verifySkill) && /unless a match-confidence cap \(`position`, `tag-alias`, `text-ordinal`, a hand-written\s+value\) also applies/.test(verifySkill)
    && !/restores the node's capped severities/.test(verifySkill) && !/capped lows never block/.test(verifySkill) && !/restores the node's capped/.test(verifier));
  check("[D39] the verdict list: `incomplete` names deltas on low-confidence matches",
    /- \*\*incomplete\*\* —[^]*?deltas on low-confidence matches \(D39[^]*?An integrity/.test(verifySkill));
  check("[F-79] a wrapping list: main-axis padding shows (only its largest child can overflow), cross axis = stacked lines; space-around/space-evenly behave as centred",
    !/never overfull on its main axis/.test(verifySkill) && /overfull only when its largest child alone is wider than the inner width/.test(verifySkill)
      && /cross axis the content is\s+the stacked lines/.test(verifySkill) && /`space-around`\/`space-evenly`, → both/.test(verifySkill));
  check("[F-79] overfull fixed box: only the side the content does not start from is skipped (start → end side; centred → both)",
    /only the side the content does not start from \(start-aligned → the end side; centred, or\s+`space-around`\/`space-evenly`, → both\)/.test(verifySkill));
}
console.log("build-screen docs (group 12a, steps / dialog driving / precedence / overflow):");
{
  const docs = { verifier, verifySkill, verifyRef, skill };
  check("[D40 7] --steps: closed click / waitFor / goto vocabulary, exactly one visible match, never submit, idempotent, exit 4 with nothing written, replayed on the re-run and every driven row (verifier, verify skill)",
    [verifier, verifySkill].every((t) => /`--steps`/.test(t) && /`\{"click": "<selector>"\}`, `\{"waitFor": "<selector>"\}`, `\{"goto": "\/same-origin\/path"\}`/.test(t) && /EXACTLY ONE visible\s+element/i.test(t)
      && /never submits a form/.test(t) && /[Ii]dempotent/.test(t) && /exit 4 and nothing is written/.test(t) && /re-run \(D19\)|D19 re-run/.test(t) && /every page the probe drives an interaction on/.test(t)));
  check("[D40 7] the plan's `route` is advisory; the skill passes the plan to --steps when it has `navigate` (verifier, verify skill, build-screen, references)",
    /`route` is advisory/.test(verifier) && /`route` stays advisory/.test(verifySkill) && /`route` \(advisory free text/.test(skill) && /`route` is advisory/.test(verifyRef)
    && /pass the plan as `--steps`/.test(verifier) && /passes the plan to `--steps` whenever it has one/.test(verifySkill) && /Pass the plan as\s+`--steps` whenever it has `navigate`/.test(skill));
  check("[D40 7] the probe call in every doc shows --steps",
    [verifier, verifySkill, skill].every((t) => /verify-probe\.js[^`]*--steps design\/plan\/<screen>\.json/.test(t)) && /`--steps <plan\.json>`/.test(verifyRef));
  check("[F-70] the shipped probe drives overlay/swap on_click/on_press and plan expect:dialog rows: reveals hover-hidden openers, mouse vs synthetic activation, never ok:false, destination tag inside",
    [verifier, verifySkill].every((t) => /`overlay` or `swap`|`overlay` \/ `swap`/.test(t) && /`on_click` \/ `on_press`/.test(t) && /`expect: "dialog"`/.test(t) && /hover-hidden opener/.test(t) && /`"synthetic"`/.test(t) && /never a user activation/.test(t)
      && /never `ok: false`|NEVER `ok: false`/.test(t) && /`data-dt-node` tag (on or )?INSIDE|tag INSIDE|on or inside/i.test(t)));
  check("[F-70] the dialog contract selectors, in order (verifier, verify skill, references)",
    [verifier, verifySkill, verifyRef].every((t) => /`:modal`, `dialog\[open\]`, `\[role=dialog\]`, `\[role=alertdialog\]`,\s*`\[aria-modal="true"\]`, `:popover-open`/.test(t)));
  check("[F-70] the agent does not re-drive rows the probe drove, drives the rest as before, and its own detector uses the same contract — never `[role=dialog]` alone",
    /Do not re-drive a row the probe drove with `ok: true`/.test(verifier) && /SAME contract the probe does — never a `\[role=dialog\]`-only\s+detector/.test(verifier)
    && /does NOT re-drive rows the probe drove with `ok: true`/.test(verifySkill) && /never `\[role=dialog\]` alone/.test(verifySkill) && /never `\[role=dialog\]` alone/.test(verifyRef));
  check("[D41] builders tag a dialog/overlay's ROOT with its destination frame id (data-dt-node); an untagged dialog is not-probed",
    /Tag a dialog or overlay's root element with its destination frame id/.test(skill) && /root of the modal\/sheet/.test(skill) && /untagged dialog is `not-probed`/.test(skill));
  check("[F-95] plan.navigate / plan.interactions rows {nodeId, trigger, expect, destinationId}; --plan at --expect or auto-discovery; changed after --expect → incomplete until re-run",
    /`plan\.navigate`/.test(skill) && /`plan\.interactions` as `\{nodeId, trigger, expect: "dialog" \| "url" \|\s*"selector:<css>", destinationId\}`/.test(skill) && /`destinationId` required for `dialog`/.test(skill)
    && /Change `plan\.interactions` afterwards and `--compare` is `incomplete` until `--expect` is re-run/.test(skill)
    && /`--plan <plan\.json>`, else the ONE plan in\s+`design\/plan\/` that describes the frame/.test(verifySkill) && /`incomplete` until `--expect` is\s+re-run/.test(verifySkill));
  check("[D41] precedence in plain words: probe rows authoritative only in a --run with an intact status chain; a probe miss never overrides full agent evidence; a `by` field means nothing",
    /authoritative only in a `--run` with an intact status chain/.test(verifySkill) && /A `by` field in a file means nothing/.test(verifySkill) && /a probe miss \(`ok: null`\) or a row cut by the time budget never overrides an agent row that has full D24 evidence/.test(verifySkill)
    && /a probe miss\s+never overrides it/.test(verifier));
  check("[D43] overflowX: a high, waivable delta on the root frame via --accept --node <frame> --field overflowX",
    /`overflowX`, D43/.test(verifySkill) && /HIGH delta on the root frame \(field `overflowX`/.test(verifySkill) && /recorded as in step 6 with `--node <frame id> --field overflowX`/.test(verifySkill) && /`overflowX`, a high waivable delta on the root frame|\(`overflowX`, a high waivable delta/.test(verifyRef));
  check("[D43] overflowX is not judged when designed to scroll horizontally, viewport != design width, clipped, or not measured; fixed never counts, off-canvas absolute/transformed drawers do",
    /designed to scroll horizontally, the viewport is not the design width, the overflow is clipped/.test(verifySkill) && /or the page was not measured/.test(verifySkill) && /`position: fixed` elements never count; an off-canvas\s+absolutely-positioned or transformed drawer does/.test(verifySkill));
  check("[12a] the new report fields: inputs.reach, coverage.pageOverflow, interactionsByProbe, evidenceFrom",
    /`inputs\.reach`/.test(verifySkill) && /`coverage\.pageOverflow`/.test(verifySkill) && /`interactionsByProbe`/.test(verifySkill) && /`evidenceFrom`/.test(verifySkill) && /`measured\.reach`/.test(verifySkill));
  check("[12a] exit 4 lists a failed --steps step in the verifier and the verify skill", /a `--steps` step failed/.test(verifier) && /a `--steps` step that failed/.test(verifySkill));
  void docs;
}
console.log("build-screen docs (group 12a review 1):");
{
  check("[12a r1 L2] a plan `expect: \"dialog\"` row needs an on_click / on_press trigger (verifier, verify skill, build-screen, references)",
    /`expect: "dialog"` \(source `plan`; `--expect` keeps such a row only with an `on_click` \/ `on_press` trigger\)/.test(verifier)
    && /whose trigger must be `on_click` or `on_press`/.test(verifySkill) && /a `dialog` without `destinationId` or on another trigger/.test(verifySkill)
    && /a `dialog` row's trigger is\s+`on_click` or `on_press`/.test(skill) && /`expect: "dialog"` rows \(`on_click` \/ `on_press` only\)/.test(verifyRef));
  check("[12a r1 B2] steps: a `click` matches exactly one visible element, a `waitFor` at least one (verifier, verify skill, build-screen, references)",
    /A `click` selector must\s+match EXACTLY ONE visible element; a `waitFor` succeeds once AT LEAST ONE visible element matches/.test(verifier)
    && /A `click` selector must match exactly ONE visible element \(a `waitFor` succeeds once AT LEAST ONE visible element matches\)/.test(verifySkill)
    && /each `click` selector matches exactly one visible element, a `waitFor` at least one/.test(skill) && /exactly one visible\s+match per `click` \(a `waitFor` needs at least one\)/.test(verifyRef));
  check("[12a r1 M4/L3] disabled openers are not driven and an opener that would submit a form is not clicked — ok:null (verifier, verify skill, references)",
    [verifier, verifySkill].every((t) => /A disabled opener \(`:disabled`,\s+`\[disabled\]` or `aria-disabled="true"`, on it or on an ancestor\) is not driven/.test(t) && /an opener that would submit\s+a form[^.]*is not clicked/.test(t))
    && /skipping a disabled\s+opener \(`:disabled` \/ `\[disabled\]` \/ `aria-disabled`, on it or an ancestor\) and one that would submit a form \(`ok: null`\)/.test(verifyRef));
  check("[12a r1 M2] the destination tag: on or inside the opened element, or on a NEWLY visible ancestor — never one visible before the click (verifier ×2, verify skill, build-screen, references)",
    /or on an ancestor of it that became visible with it — never on one that was already\s+visible/.test(verifier) && /or on a NEWLY visible ancestor of\s+it — never one visible before the click/.test(verifier)
    && /or on an ancestor of it that became visible with it — never one already visible before the click/.test(verifySkill)
    && /or on an ancestor of it that became visible with it \(never one visible before the click\)/.test(skill) && /or on a newly visible ancestor of it/.test(verifyRef));
  check("[12a r1 M3] one plan rule: of several plans, the one listing files[]; --compare picks the same; the re-run names --plan (verify skill, build-screen)",
    /or — when several do — the one\s+that lists `files\[\]`; `--compare` picks the plan by the same rule/.test(verifySkill) && /with the `--plan` it names, when it names one/.test(verifySkill)
    && /of several, the one listing `files\[\]`/.test(skill));
  check("[12a r1 L9] a plan with navigate and a probe run without --steps → an input note (verify skill)", /A plan with `navigate` and a\s+probe run without `--steps` gets an input note/.test(verifySkill));
  check("[12a r1 known limit] probe rows bind only through the run's status chain; a hand-recorded measured file gains no pass power beyond D24 + the destination tag (verify skill)",
    /Known limit: the binding is the run's status chain, nothing more/.test(verifySkill) && /its rows gain no pass power beyond what D24 and the destination tag already demand/.test(verifySkill));
}
console.log("build-screen docs (group 12a review 2):");
{
  check("[12a r2 M-b] --compare checks the plan file --expect merged from while it exists; gone → names both plans and asks for --plan (verify skill, build-screen)",
    /the plan file `--expect` merged from\s+wins while it still exists — an input note says so — and when that file is gone the reason names both plans/.test(verifySkill)
    && /`--compare … --plan <its path now>` or `--expect … --plan <the plan you intend>`/.test(verifySkill)
    && /`--compare`\s+checks the plan file `--expect` merged from while it exists \(if that file moved, pass its new path as `--plan`\)/.test(skill));
  check("[12a r2 L-e/H-a] step load ownership: a click's navigation to ANOTHER URL is the step's own however late; a same-URL new document never is (verifier, verify skill)",
    [verifier, verifySkill].every((t) => /a document\s+load that goes to ANOTHER URL than the page shows \(the fragment ignored\), whether its request starts while the click runs\s+or LATER \(until the next `click` \/ `goto` step or the end of the steps\)|a document load that goes to ANOTHER URL than the page shows \(fragment ignored\), whether its request starts while the click runs or later \(until the next `click` \/ `goto` step or the end of the steps\)/.test(t)
      && /`await save\(\);\s+location\.href = "\/other"` after any delay is the\s+step's own/.test(t) && /A new document at\s+the SAME URL \(`location\.reload\(\)`, a dev-server reload/.test(t)));
  check("[12a r2 L-e/H-a] an in-place click undone by a reload → one re-run with the steps replayed, then a step-specific exit 4 that names the step, not the dev server (verifier, verify skill, references, build-screen)",
    [verifier, verifySkill].every((t) => /the pass is re-run once\s+with the steps replayed \(D19\)/.test(t) && /"the page reloaded \(<url> again, not a navigation\) after step N\s+… had changed it in place"/.test(t)
      && /reach the screen by its own URL \(`--url` or a\s+`goto` step|reach the screen by its own URL, `--url` or a `goto` step/.test(t) && /A reload after a `goto` or (after )?a click's own navigation is\s+(only waited for|only waited for and counted)/.test(t))
    && /a reload undid an in-place `--steps` click on both passes/.test(verifier) && /a reload that undid an in-place `--steps` click on both passes/.test(verifySkill)
    && /Only the reload-during-measurement message points at\s+the dev-server watch/.test(verifier)
    && /a click that reloads the same URL\s+loses what it built, one re-run, then exit 4 naming the step/.test(verifyRef)
    && /a `click` changes the page in place or navigates to another URL, never reloads the one it is on/.test(skill));
  check("[12a r2 M-a] every settle first waits for the document to finish loading (readyState complete, 10 s cap, then a note) (verifier, verify skill)",
    /every settle first waits for the document to finish loading \(`document\.readyState`\s+`"complete"`; at most 10 s per document, then it measures anyway, with the note "the document had not finished loading",/.test(verifier)
    && /every settle first waits for the document to finish loading \(`document\.readyState` `"complete"`, at most 10 s per document, then it measures anyway with a note,/.test(verifySkill));
  check("[12a r2 L-c] the submit refusal also checks the element at the click point (verifier ×2, verify skill ×2)",
    /typeless button inside a `<form>`, on the element or at its click point, is refused/.test(verifier) && /typeless button inside a `<form>`, on it or at its click point\) is not clicked/.test(verifier)
    && /typeless button inside a `<form>`, on the element or at its click point, is refused/.test(verifySkill) && /an opener that would submit a form \(on it or at its click point\) is not clicked/.test(verifySkill));
}
console.log("build-screen docs (group 12a review 3):");
{
  check("[12a r3 M-2] a same-URL new document is never a click's own — not even one its handler starts at once (verifier, verify skill)",
    /never a step's own — not even\s+one the click's handler starts at once \(`draw\(\); location\.reload\(\)`\)/.test(verifier)
    && /is never a step's own, not even one the click's handler starts at once \(`draw\(\); location\.reload\(\)`\)/.test(verifySkill));
  check("[12a r3 M-1] the 10 s load wait is per document: no later settle waits for that document again (verifier, verify skill)",
    /at most 10 s per document[^)]*and no later settle waits for that document again[;)]/.test(verifier) && /at most 10 s per document[^)]*and no later settle waits for that document again[;)]/.test(verifySkill));
  check("[12a fix4/fix5] a link click to the URL already shown owns the load it starts (like a goto; a later same-URL load is a reload); the probe's own loads (--url, goto) wait up to --timeout, then a committed document is measured with the note (verifier, verify skill, references)",
    [verifier, verifySkill].every((t) => /a `click` on a link \(the element or its\s+closest `a\[href\]`, same tab\) to the URL the page already shows/.test(t)
      && /like a `goto`'s \(only the load the click itself starts; a later same-URL load is a reload\)/.test(t)
      && /the probe's own loads — the first `--url` load and a `goto` — wait for\s+the load event up to `--timeout` instead/.test(t)
      && /never finishes loading is then measured with the note "the page had not finished loading when the goto gave up"/.test(t)
      && /a server\s+that never answers — or a page that goes on to one before its load — is still "could not load"/.test(t) && !/measured after 10 s with that note/.test(t))
    && /a link to the URL already shown counts as a `goto` for the load the click starts/.test(verifyRef));
  check("[12a r3 L-1] with steps, always pass --ready on the screen root (or end with a waitFor of it): a click that lands elsewhere is still the step's own (verifier, verify skill, references, build-screen ×2)",
    /With steps, always pass `--ready '\[data-dt-node="<frame id>"\]'` \(or end the steps with a\s+`waitFor` of the screen root\)/.test(verifier) && /an expired session bouncing to a login page/.test(verifier)
    && /With steps, always pass `--ready '\[data-dt-node="<frame id>"\]'` \(or end the steps with a `waitFor` of the screen root\)/.test(verifySkill) && /an expired session bouncing to a login page/.test(verifySkill)
    && /always pass `--ready` with the screen root's tag, or end the\s+steps with a `waitFor` of it/.test(verifyRef)
    && /\[--steps design\/plan\/<screen>\.json --ready '\[data-dt-node="<frame id>"\]'\]/.test(skill) && /with `--ready` on the screen root's tag/.test(skill));
}
console.log("build-screen docs (group 12b):");
{
  check("[12b] verify skill: a \"Behaviour and accessibility\" paragraph — checks never change the verdict, a fail is a Stop-hook warning, a measurable a11y failure is never waived",
    /\*\*Behaviour and accessibility\b/.test(verifySkill) && /never change the verdict/.test(verifySkill) && /Stop hook/.test(verifySkill)
    && /a measurable accessibility failure is never waived/.test(verifySkill) && /raise a designer question/.test(verifySkill));
  check("[12b] verify skill: copy report.behaviour.summary into plan.verification.a11y (tool, violations = fail, warnings = warn)",
    /copy `report\.behaviour\.summary` into `plan\.verification\.a11y`/.test(verifySkill) && /tool: "verify-probe\[\+axe-core x\.y\]"/.test(verifySkill)
    && /violations: summary\.fail/.test(verifySkill) && /warnings: summary\.warn/.test(verifySkill));
  check("[12b fix1] verify skill: a11y.report names the report copied from; summary.fail counts a +N more row's elements; keys only on a button-like opener, outside clicks only on a backdrop, the safe close never a link, closed-menu openers not-run",
    /report: "<the report\.json you copied it from>"/.test(verifySkill) && /`summary\.fail` counts the elements behind a "\+N more" row/.test(verifySkill)
    && /Enter\/Space are pressed only on the opener itself when it is a button-like control/.test(verifySkill)
    && /a click outside a dialog lands only on its backdrop or scrim/.test(verifySkill) && /the safe close is a button clicked with the mouse, or a link only when its `href` is `#`, empty or `javascript:`/.test(verifySkill)
    && /never on another control inside a card or row opener/.test(verifySkill)
    && /a11y:\{tool, violations, warnings, report\}\?\}` \(copied from `report\.behaviour\.summary`\)/.test(skill) && /`verification\.a11y` — `\{tool, violations, warnings, report\}`, copied from `report\.behaviour\.summary`/.test(verifyRef)
    && /an opener inside a closed menu or `<details>` is `not-run` for keyboard reach/.test(verifySkill));
  check("[12b fix5] verify skill Limits: the write block arms per unit at the first key press / click / scroll / hover / resize, a WebSocket opened then never connects, every check from the first action on is not-run; a missing opener/destination = differs; the drive has NO write block; D51 (the sole control only when the container shows nothing of its own); the deferred-write gap",
    /per unit, from its first key press, click, scroll, hover or resize on, every\s+request but GET\/HEAD\/OPTIONS — from the page, its frames, workers, shared workers and service workers alike — is blocked\s+browser-wide, every WebSocket message the page sends is dropped and a WebSocket it opens then never reaches the server,\s+which makes every check of that unit from its first action on `not-run` "the page tried to write"/.test(verifySkill)
    && /the screen's own load\s+and `--steps` may write, as in the measurement pass, and a battery page that then shows other tagged elements than the\s+measured one, or misses the opener or destination the check uses, is `not-run` "the page reached for this check differs\s+from the measured page"/.test(verifySkill)
    && /the probe's drive of the interactions \(before the battery\) has no write block: it never clicks\s+an opener that would submit a form or whose click point is another control inside it/.test(verifySkill)
    && /the one button-like control of a cell or card opener whose centre\s+it fills and that shows nothing of its own outside it/.test(verifySkill)
    && /not\s+covered: a GET with a side effect, a WebSocket opened inside a worker, or a write the page defers past the unit's end —\s+an undo window over about 1 s: it never leaves, the unit's page is closed first, but the check that caused it is judged\s+as if nothing was written\)/.test(verifySkill));
  // review 5 L-4: what the drive refuses and what it cannot see, and D51's content, said exactly (no over-claim)
  check("[12b fix6] verify skill Limits: the drive says it does not see a closed shadow root or a bare click listener; the container's own background is decoration",
    /but it does not see a control in a closed shadow root or one that is\s+only a click listener with no role \(an icon with an onclick, a bare `<svg onclick>`\), and clicks those;/.test(verifySkill)
    && /its own background colour is decoration — the control the mouse open clicks\)/.test(verifySkill)
    && !/no text, image or icon —/.test(verifySkill));
  check("[12b fix7] verify skill Limits: the drive refuses an activating control also under a focusable glyph or editable label, a label's control, a nested page (iframe, object, embed); D51's own content includes a CSS mask, a filled block and positioned labels escaping a clip; an out-of-flow opacity-0 tooltip, an sr-only label (clipped or at left:-9999px), a filled wrapper or hover tint show nothing; an in-flow opacity-0 label counts; not read: an iframe's page, a closed shadow root, a clip-path other than inset()",
    /another control inside it — an activating control \(also under\s+a focusable glyph or an editable label inside it\), a label's control or a nested page \(an iframe, object or embed\), open\s+shadow roots included —/.test(verifySkill)
    && /no visible text, image, icon \(a CSS mask too\), generated content\s+or filled block \(a swatch, a status dot\), open shadow roots and positioned labels escaping a clip included;/.test(verifySkill)
    && /a tooltip at\s+opacity 0 out of flow, an sr-only label \(clipped, or off the page at left:-9999px\) and a filled wrapper or hover tint over\s+the control show nothing, but a label at opacity 0 in flow \(a reveal-on-scroll entrance yet to play\) counts, and so do\s+a progress bar, a meter and a list marker \(its own too\);/.test(verifySkill)
    && /not read: the page inside an iframe \(the iframe itself counts\),\s+a closed shadow root, a clip-path other than inset\(\) \(what it hides counts\)/.test(verifySkill)
    && !/no visible text, image, icon or generated content, open shadow/.test(verifySkill));
  // review 7 / owner D52 (fix 8): the container's own content is decided by pixels too — what counts, what stays decoration, the
  // hover first, the remaining miss
  // review 8 / owner D53 (fix 9): decoration only when pixel-verified plain; shadow roots, the marker and the outside hidden;
  // the known misses said honestly (closed shadow roots, the part outside the viewport, a delayed reveal, RTL, hover side effects)
  // review 9 / owner D54 (fix 10): the ancestors hidden too, their filters / clip-paths / masks off for the plain test, the real
  // rounded outline, the other pseudo-elements, the opener's own background image / two-colour border / stripe and a label laid
  // over it from outside count; every known miss said
  check("[12b fix8/fix9/fix10] verify skill Limits: D52–D54 — the opener hovered first, screenshotted with only its control hidden and with all its content hidden (shadow content, its marker, its other pseudo-elements), the outside and its ancestors hidden in both; any painted difference counts; decoration only its own background colour, a one-colour border, its shadow, and a pixel-verified plain fill or hug wrapper (real rounded outline, filters off); its own background image / two-colour border / stripe, a scroll button and a label laid over it from outside count; a page !important that beats the probe refuses; every known miss",
    /and it shows nothing of its own by its pixels too \(owner decisions\s+D52, D53 and D54\): the opener, hovered first so a control shown only on hover is at its click point, is screenshotted with only that\s+control hidden and with all its content hidden — the content of its open shadow roots, its own list marker and its other\s+pseudo-elements \(a first letter, a placeholder, a file button, a details' content, scroll buttons and markers\) included,\s+and everything outside the opener, its ancestors too, hidden in both shots so a toast, a ticker or a parent repainted by\s+script never decides — any painted difference counts \(a dot, a swatch, a band, a progress bar, a stripe or a 1-px divider\);/.test(verifySkill)
    && /decoration is only its own background colour, a border in one colour \(a 1-px divider on one side too\) and its shadow, and a\s+fill over all of it or a wrapper within 8 px of the control when, screenshotted alone \(filters, clip-paths and masks of the\s+opener and its ancestors off\), they paint one plain colour \(pixel-verified against their real rounded outline; a 1.5-px\s+anti-aliased edge allowed — a clip-path flag, a background-clip stripe, a progress ring, a shadow ring or a second colour is\s+content, and so is a wrapper with its own small shadow or a 1-px frame in another colour, which is refused\);/.test(verifySkill)
    && /also content:\s+the opener's own background image \(a gradient, a url — a progress fill\), its border in two colours or a stripe 2 px wider\s+than its other sides, a scroll button, and a label, image or generated label laid at least half over the opener from outside\s+its element \(a positioned sibling, a parent's `::after`\) — unless it is fixed or sticky \(a toast or banner is ignored\) or\s+hit-testing shows it under the opener's opaque background;/.test(verifySkill)
    && /a page rule that keeps something showing against the probe's hiding rule \(an inline or\s+cascade-layer `!important`\) refuses;/.test(verifySkill)
    && /not seen: a closed shadow root, foreign content inside an ancestor's shadow root, a\s+shadow root attached after the check started, a part of the opener still outside the viewport once scrolled in, content\s+revealed only after a delay, a generated label of an element lying elsewhere on the page; the probe's init CSS \(no\s+transitions\) is lost when a page replaces `document.adoptedStyleSheets` after its load under a strict style CSP; an sr-only\s+label at `right:-9999px` in a right-to-left page counts as content \(that cell is refused\); and since every opener is\s+hovered first, a `mouseenter` \/ `mouseover` side effect also fires on an opener the drive then refuses \(no write block in\s+the drive\);/.test(verifySkill)
    && !/a 1-px anti-aliased edge and rounded corners allowed/.test(verifySkill) && !/decoration is only its own background,\s+border and shadow/.test(verifySkill));
  // review 10 / owner D55 (fix 11): the own inset shadow / ring / mask paint, the tooltip and opacity-0 exemptions, the re-mount
  // refusal, what is refused by rule, what is not seen, the focused element, the named reason
  check("[12b fix11] verify skill Limits: D55 — the opener's own inset shadow / two-colour ring / masked or clipped paint is content; the control's own tooltip and a label at opacity 0 are never foreign; under it only without opacity / blend; a re-mount during the shots refuses; refused by rule: 500,000 elements, a shadow-root opener, a role-less tooltip, an oklch background; not seen: a sibling's relative ::before, text overflowing a 0-height wrapper; the focused element; the refusal names its reason",
    /owner decision D55: also content — the opener's own inset box-shadow offset 2 px or more or blurred \(a\s+stripe, a progress fill, an inner glow\), sharp box-shadow ring layers in more than one colour \(owner decision D56: the\s+ring layers only — its border does not count, nor does a layer in its own background colour where that cannot show: an\s+outer one, a ring-offset, or, owner decision D57, an inset one over an opaque `border-box` \/ `padding-box` background\)\s+and its own paint under a mask or a clip-path other than a rounded `inset\(0\)`;/.test(verifySkill)
    && /never foreign content — a tooltip revealed by the probe's\s+hover \(D56: a `\[role=tooltip\]` element, or the element the control's `aria-describedby` names, not shown before the hover;\s+one already on screen is the opener's own label and refuses\) and a label at effective opacity 0;/.test(verifySkill)
    && /a label counts as under the opener only when no opacity below 1 or blend mode sits on the opener or above it;/.test(verifySkill)
    && /an element\s+the page mounts in the opener while it is screenshotted \(a re-render in the shot's own frame\) refuses/.test(verifySkill)
    && /refused by rule: a page with more than 500,000 elements \(the walk for a label\s+laid over the opener stops there\), an opener whose content is re-created while it is compared \(an empty spacer a\s+framework re-creates, marks a morphdom-style patch strips, a placeholder mounted on `mouseleave`; it can differ between\s+runs\), an opener inside a shadow root, a role-less tooltip or other popover laid over the\s+opener/.test(verifySkill)
    && /a label under an opener whose background\s+is `oklch\(\)`, `lab\(\)` or `color\(\)` \(never proven opaque\); not seen \(owner decision D57: known misses, the drive can\s+write\): a sibling's relative `::before` shifted over the opener from elsewhere, text overflowing a 0-height wrapper\s+beside it, [^;]*; the focused element outside the opener stays shown in both shots; every refusal names its reason/.test(verifySkill));
  // review 11 / owner D56 (fix 12): the tooltip exemption is the one the probe's hover revealed; the ring rule counts ring
  // layers only (not the border, not a background-coloured ring-offset); a re-created opener content refuses (known miss)
  check("[12b fix12] verify skill Limits: D56 — only a tooltip revealed by the probe's hover is never foreign (one on screen before refuses); the ring rule counts ring layers only, not the border or a ring-offset in the background colour; an opener whose content is re-created while it is compared is refused",
    /a tooltip revealed by the probe's\s+hover \(D56: a `\[role=tooltip\]` element, or the element the control's `aria-describedby` names, not shown before the hover;\s+one already on screen is the opener's own label and refuses\)/.test(verifySkill)
    && /\(owner decision D56: the\s+ring layers only — its border does not count, nor does a layer in its own background colour where that cannot show: an\s+outer one, a ring-offset, or, owner decision D57, an inset one over an opaque `border-box` \/ `padding-box` background\)/.test(verifySkill)
    && /an opener whose content is re-created while it is compared \(an empty spacer a\s+framework re-creates, marks a morphdom-style patch strips, a placeholder mounted on `mouseleave`; it can differ between\s+runs\)/.test(verifySkill)
    && !/its border's colour included/.test(verifySkill) && !/the sole\s+control's own tooltip \(`\[role=tooltip\]`/.test(verifySkill));
  // review 12 / owner D57 (fix 13): the ring rule ignores a background-coloured layer only where it cannot show; the known
  // misses of the tooltip record (refused by rule: a pre-mounted hidden tooltip; not seen: display: contents, a re-created label,
  // a page-defined __dtTipPre)
  check("[12b fix13] verify skill Limits: D57 — a background-coloured ring layer is ignored only where it cannot show (outer, or inset over an opaque border-box / padding-box background); refused by rule: a tooltip pre-mounted at scale(0) or off-screen; not seen: a display: contents tooltip / describedby target, a label re-created on the hover with tooltip semantics, a page-defined window.__dtTipPre",
    /nor does a layer in its own background colour where that cannot show: an\s+outer one, a ring-offset, or, owner decision D57, an inset one over an opaque `border-box` \/ `padding-box` background\)/.test(verifySkill)
    && /refused by rule:[^]*?a cell whose sole control has a tooltip pre-mounted but hidden by `transform: scale\(0\)` or\s+moved off-screen \(owner decision D57: it counts as shown before the hover\)/.test(verifySkill)
    && /not seen \(owner decision D57: known misses, the drive can\s+write\):[^;]*, a `display: contents` `\[role=tooltip\]` or `aria-describedby` target laid over the opener, a label the page\s+re-creates as a new element on the hover with tooltip semantics \(`role="tooltip"`, or the control's `aria-describedby`\s+target\), and a page that defines `window.__dtTipPre` itself first turns the record of what was shown before the hover\s+off \(an adversarial page\);/.test(verifySkill)
    && !/a layer in its own background colour, a ring-offset, do not count/.test(verifySkill));
  check("[12b F-110/F-122] verify skill: names computed by Playwright (Chromium), not screen-reader verified; native-picker rows are synthetic",
    /names computed by Playwright \(Chromium\), not screen-reader verified/.test(verifySkill) && /synthetic \(headless\), not a real-browser observation/.test(verifySkill));
  check("[12b D40] verify skill: axe is optional and resolved from the project, never npm install as the agent; limits listed; never --behaviour off",
    /axe-core.{0,80}optional/.test(verifySkill) && /never run `npm install`/.test(verifySkill) && /destructive paths never run/.test(verifySkill)
    && /iframes are not scanned/.test(verifySkill) && /English-only/.test(verifySkill) && /never pass `--behaviour off`/i.test(verifySkill));
  check("[12b DT-77/DT-76] visual-verifier: focus rings checked by keyboard.focus-visible; read report.behaviour, never re-drive the battery; never accept \"cannot emulate forced colours\"",
    /`keyboard\.focus-visible`/.test(verifier) && /read `report\.behaviour`/.test(verifier) && /do not re-drive the battery/.test(verifier)
    && /never accept "the tool cannot emulate forced colours"/i.test(verifier) && /delete-confirm focus, disabled-while-focused and route changes/.test(verifier)
    && /behaviour headline/.test(verifier));
  check("[12b DT-77] build-screen: a CSS-mask tint vanishes under forced colours — forced-color-adjust: none or CanvasText; inline SVG currentColor needs nothing",
    /mask-image.{0,200}forced colou?rs/.test(skill) && /forced-color-adjust: none/.test(skill) && /background-color: CanvasText/.test(skill) && /fill=\"currentColor\"` needs nothing/.test(skill));
  check("[12b DT-76] web-tailwind: v4 outline-hidden removes the outline style, so focus-visible:outline-2 needs focus-visible:outline-solid",
    /outline-hidden.{0,120}outline-style: ?none/.test(tw) && /focus-visible:outline-solid/.test(tw));
  check("[12b DT-60] web-tailwind: hover-revealed actions never `invisible` — a visibility:hidden opener cannot take focus back",
    /never `invisible`.{0,200}(focus back|take focus)/.test(tw));
  check("[12b DT-76/DT-60] web-css-modules: the CSS twin — outline-style none defeats a bare outline-width; opacity not visibility for revealed actions",
    /outline-style: ?none/.test(cssm) && /outline-style: ?solid/.test(cssm) && /opacity: ?0/.test(cssm) && /:focus-within/.test(cssm) && /never `visibility: hidden`.{0,200}(focus back|take focus)/.test(cssm));
  check("[12b] references/verify: the probe runs the battery and axe; a hand-run axe / Tab-through is only for what the probe reports not-run",
    /probe runs the behaviour battery and axe-core/.test(verifyRef) && /only for what the probe reports `not-run`/.test(verifyRef));
  console.log("build-screen docs (group 12c):");
  check("[12c F-89] visual-verifier: opens <S>.diff.png and report.visual, the diff is never the verdict, grid 1x hides differences",
    /\.diff\.png/.test(verifier) && /report\.visual/.test(verifier) && /never the verdict/.test(verifier) && /referenceImage/.test(verifier) && /grid "1x"/.test(verifier));
  check("[12c F-89] verify skill: a Visual diff paragraph names referenceImage and re-running --expect",
    /\*\*Visual diff\*\*/.test(verifySkill) && /referenceImage/.test(verifySkill) && /re-run `--expect` after upgrading/.test(verifySkill) && /never the verdict/.test(verifySkill));
  check("[12c F-89] references/verify: the web probe renders at the reference's scale; Pixels reads report.visual",
    /report\.visual/.test(verifyRef) && /renders at the reference's scale itself/.test(verifyRef));
  // D59 (12c review 1 F-4): the diff cannot see 1-px lines, light tints or replaced text — the regions are where to START
  const flat = (t: string): string => t.replace(/\s+/g, " ");
  const v3 = [verifier, verifySkill, verifyRef].map(flat);
  check("[12c F-4] none of the three docs says to look \"only at the hot regions\"", v3.every((t) => !/only at the hot regions/.test(t)));
  check("[12c F-4] all three start at the hot regions, then still compare the whole reference and build side by side (lines, tints, text changes)",
    v3.every((t) => /start at the hot regions, then still compare the whole reference.{0,40}side by side/.test(t) && /1-px lines/.test(t) && /text-only changes rarely become regions/.test(t)));
  check("[12c F-13] verify skill limits: the 0.2 threshold is blind to small luminance steps and anti-aliasing absorbs thin lines",
    /0\.2 threshold is blind to luminance steps/.test(v3[1] ?? "") && /anti-aliasing detection absorbs much of a thin line/.test(v3[1] ?? ""));
  check("[12c F-2/F-8] verify skill: the reference is read from the project owning the expectation; a positive offset is a note",
    /project that owns the expectation/.test(v3[1] ?? "") && /alignment unverified/.test(v3[1] ?? ""));
}
report();
