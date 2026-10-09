// Doc-guards for the build-screen skill, its web profiles and the screen-builder agent.
//   node test/build-screen-docs.test.ts
// Each check asserts one rule is STATED in the text a builder reads; the map-status list is also
// compared with the validator's own source so the doc and the code cannot drift apart.
import fs from "node:fs";
import path from "node:path";
import { check, report } from "./assert.ts";
import { PASSING_VERDICTS } from "../design-to-code/plan-waivers.ts";
import * as PM from "../design-to-code/probe-match.ts";
import { QUICK_KEYS } from "../bridge/src/quick-keys.ts";

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

console.log("build-screen docs:");
check("web-tailwind carries the v4 button cursor snippet", /button:not\(:disabled\)/.test(tw) && /cursor:\s*pointer/.test(tw));
check("web-tailwind: a design with no Pressed variant still gets a default `active:` treatment, recorded as defaulted", /no Pressed variant.{0,200}`active:`|`active:`.{0,200}no Pressed variant/i.test(tw) && /defaulted/.test(tw));
check("web-tailwind: a control wired to nothing must not look live", /wired to nothing.{0,200}(not look live|aria-disabled)/i.test(tw));
check("web-css-modules: button cursor is the browser arrow; set pointer on enabled buttons; `:active` default", /cursor:\s*pointer/.test(cssm) && /arrow/.test(cssm) && /no Pressed variant/i.test(cssm));
check("SKILL step 4: pressed feedback on every pointer type, not only touch", /pressed feedback on every pointer type/i.test(step(4)) && !/pressed feedback on touch/i.test(skill));
check("desktop-only design: designer question in SKILL and web-tailwind, with the default", /desktop-only design/i.test(skill) && /desktop-only design/i.test(tw) && /fluid down to/i.test(tw));
check("step 6 lists desktop-only/invented features among report items", /invented features/i.test(step(6)));
check("web-tailwind has a Tables block (Contents + body) with min-w, overflow-x-auto and a `relative` wrapper", /Tables/.test(twRaw.split("\n").slice(0, 9).join("\n")) && /\*\*Tables\*\*.{0,40}`table-fixed`.{0,40}`min-w-/.test(tw) && /`overflow-x-auto` wrapper/.test(tw) && /wrapper `relative`/.test(tw));
check("Tables pitfalls: negative margin on the wrapper, caption/border-separate, tolerance", /[Nn]egative margins go on the scroll wrapper/.test(tw) && /<caption>.{0,120}border-separate/.test(tw) && /compare with a tolerance/.test(tw));
check("hover-revealed controls: focus-within + coarse-pointer fallback, never invisible/hidden", /group-focus-within:opacity-100/.test(tw) && /pointer-coarse:opacity-100/.test(tw) && /never `invisible`/.test(tw) && /pointer-coarse:` is v4\.1\+.{0,80}\[@media\(pointer:coarse\)\]:opacity-100/.test(tw));
check("web-tailwind: `@source not` keeps design/ notes out of the compiled CSS", /@source not "/.test(tw) && /not evidence/i.test(tw));
check("a measurable a11y failure (WCAG contrast/target size) is never waived by a decision, deviation or 'kept as designed'", /1\.4\.3/.test(skill) && /2\.5\.8/.test(skill) && /never (be )?(closed|waived).{0,200}(decision|deviation)/i.test(skill) && /kept as designed/i.test(skill));
check("invented features get CSV-injection quoting and an href scheme allow-list", /invented feature/i.test(skill) && /`=`\/`\+`\/`-`\/`@`/.test(skill) && /http\/https\/mailto/.test(skill) && /dangerouslySetInnerHTML/.test(skill));
check("the absolute 'not the merged variables.json' is gone; the shared-shell rule is present", !/not the merged `variables\.json`/.test(skill) && !/not the merged `variables\.json`/.test(tw) && /shell shared by several screens/i.test(skill) && /shell shared by several screens/i.test(tw));
check("web-tailwind names `data-theme-<collection>` scoping for shared mode names (declared modes, besides the default)", /data-theme-<collection>/.test(tw) && /only one collection declares \(besides its default\)/.test(tw));
check("web-css-modules tokens.css note: `data-theme-<collection>` and the tokens.js warning", /data-theme-<collection>.{0,120}tokens\.js. warns which attributes/.test(cssm));
check("web-tailwind: `--font-figma-*` and STRING tokens left out of theme.css", /font-figma-\*/.test(tw) && /STRING/.test(tw));
const statuses = /const STATUSES = \[([^\]]*)\]/.exec(validate)?.[1]?.match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? [];
check("the map `status` enum in SKILL.md equals map-validate.ts STATUSES", statuses.length > 0 && skill.includes("`" + statuses.join("` | `") + "`"));
check("SKILL.md mentions the optional `note` and that other keys are rejected", /`note`/.test(skill) && /any other key.{0,200}rejected/i.test(skill));
check("drift-lint no longer 'exits non-zero at 0%'; 0% is a warning with a confirm", !/exits non-zero at 0%/.test(skill) && /0% \(and `catalog-rekeyed`\) is a warning/.test(skill));
check("drift-lint/map-bootstrap read the library catalogs (`components.library.json`, `libraries/`)", /components\.library\.json/.test(skill) && /libraries\/\*\/components\.json.{0,80}libraries\/index\.json/.test(skill) && /design_drift_lint/.test(skill) && /map-bootstrap does the same only with `--screen`/.test(skill));
check("a subagent records the short list, sets awaiting-user and does not confirm for the user (skill and agent)", /subagent.{0,200}awaiting-user.{0,200}(not|never) confirm/i.test(skill) && /awaiting-user.{0,200}(not|never) confirm|(not|never) confirm.{0,200}(list|map)/i.test(builder));

console.log("build-screen docs (shipped web probe):");
const verifier = flat(read("claude-plugin/agents/visual-verifier.md"));
const verifySkill = flat(read("claude-plugin/skills/verify/SKILL.md"));
const verifyRef = flat(read("claude-plugin/skills/build-screen/references/verify.md"));
check("the verifier invokes scripts/verify-probe.js, with --check for the renderer and --expected/--url/--out to measure", /scripts\/verify-probe\.js" --check/.test(verifier) && /scripts\/verify-probe\.js".{0,200}--expected .{0,120}--url .{0,120}--out/.test(verifier));
check("the verify skill invokes verify-probe.js --check (no inline Playwright script) and the probe for measuring", /scripts\/verify-probe\.js" --check/.test(verifySkill) && /verify-probe\.js".{0,200}--expected/.test(verifySkill) && !/node --input-type=module -e/.test(verifySkill));
check("the verifier forbids writing its own probe and editing/rewriting the probe's measured.json", /never write your own probe/i.test(verifier) && /never (edit|.{0,20}edit).{0,80}(patch|rewrite).{0,40}`measured\.json`/i.test(verifier) && /interactions.{0,300}evidence\.json/.test(verifier) && /:focus-visible.{0,200}(keyboard Tab|Tab)/.test(verifier));
check("the verifier: exit 3 asks the user, exit 4 reports the navigation log, untagged nodes are reported not matched by hand", /exit 3.{0,200}ask the user/i.test(verifier) && /exit 4.{0,300}navigation log/i.test(verifier) && /tag it.{0,200}do not match them by hand/i.test(verifier));
check("no skill/agent doc tells the agent to run `npx playwright install` (only the user does; the agent asks)", /never run `npx playwright install`/i.test(verifier) && /never run either yourself/i.test(verifySkill) && !/playwright install[^.]{0,60}if the caller approves/i.test(verifier));
check("the verify skill: implicit baseline, --against, COVERAGE FELL, and a probe of `unknown` is not comparable", /--against/.test(verifySkill) && /COVERAGE FELL/.test(verifySkill) && /inputs\.probe.{0,40}unknown.{0,200}not comparable/i.test(verifySkill) && /\[--interactions design\/verify\/<Screen>\.evidence\.json\].{0,120}only when the verifier wrote that file/.test(verifySkill));
check("build-screen step 5 names verify-probe.js and says web measurements are never hand-written", /verify-probe\.js/.test(step(5)) && /never a hand-written one/i.test(step(5)));
check("references/verify.md: readiness on web is the probe's (fonts.ready, reduced motion, --ready), and networkidle is not used", /verify-probe\.js/.test(verifyRef) && /document\.fonts\.ready/.test(verifyRef) && /reduced motion/i.test(verifyRef) && /does not use `networkidle`/.test(verifyRef));


console.log("verify docs (pass-with-deviations and waivers):");
{
  const raw = read("claude-plugin/skills/verify/SKILL.md");
  const sec4 = raw.split(/^## 4\. /m)[1]?.split(/^## /m)[0] ?? "";
  const named = [...sec4.matchAll(/^- \*\*([a-z-]+)\*\* —/gm)].map((m) => m[1] ?? "").sort();
  const code = [...PASSING_VERDICTS, "fail", "incomplete"].sort();
  check(`the verdicts verify/SKILL.md §4 names = PASSING_VERDICTS + fail + incomplete (doc: ${named.join(", ")})`, JSON.stringify(named) === JSON.stringify(code));
  const accept = verifySkill.split("--accept")[0]?.slice(-600) ?? "";
  check("the verify skill runs --accept only on the user's explicit word, then re-runs the compare",
    /verify-screen\.js" --accept/.test(verifySkill) && /only on their explicit word/i.test(accept) && /re-run step 4/i.test(verifySkill));
  check("the verify skill: a waiver binds node id + field + designed + built + export hash and reopens; never waivable: missing component, failed interaction, not measured; descopes are the user's",
    /node id \+ field \+ designed value \+ built value.{0,80}whole export/.test(verifySkill) && /reopens/.test(verifySkill)
    && /Never waivable: a missing component, a failed interaction, anything not measured/.test(verifySkill) && /descope.{0,200}only the user decides/i.test(verifySkill)
    && /`undesigned`.{0,200}never blocks a pass/.test(verifySkill));
  check("the screen-builder never writes waivers/descopes or runs --accept", /never write `waivers\[\]` or `descopes\[\]`.{0,80}never run `verify-screen\.js --accept`/.test(builder));
  check("build-screen names verified-with-deviations; sync-design says a re-export reopens waivers",
    /`verified-with-deviations`/.test(skill) && /reopens every waiver/.test(flat(read("claude-plugin/skills/sync-design/SKILL.md"))));
}

console.log("verify docs (run integrity + agent safety):");
{
  // The one phase list: STATUS_PHASES in design-to-code/verify-run.ts (read as text, like STATUSES above);
  // until that file lands, the agreed phase list.
  const runSrc = fs.existsSync(path.join(root, "design-to-code/verify-run.ts")) ? read("design-to-code/verify-run.ts") : "";
  const fromCode = /STATUS_PHASES\s*=\s*\[([^\]]*)\]/.exec(runSrc)?.[1]?.match(/"([^"]+)"/g)?.map((x) => x.slice(1, -1));
  const phases = fromCode ?? ["queued", "starting", "renderer-found", "renderer-ready", "measuring", "measured", "driving", "done", "failed", "blocked"];
  const chain = (t: string): string[] => {
    const m = [...t.matchAll(/`queued`[^.]*?(?:`blocked`)/g)][0]?.[0] ?? "";
    return [...m.matchAll(/`([a-z-]+)`/g)].map((x) => x[1] ?? "");
  };
  const inDoc = (t: string): string => phases.map((p) => "`" + p + "`").every((p) => t.includes(p)) ? "ok" : "missing";
  check("the verifier and references/verify.md list exactly STATUS_PHASES, in order, and the old `comparing`/`rendered` phases are gone",
    JSON.stringify(chain(verifier)) === JSON.stringify(phases) && JSON.stringify(chain(verifyRef)) === JSON.stringify(phases)
    && inDoc(verifySkill) === "ok" && !/`comparing`|`rendered`|`starting\|renderer-found/.test(verifier + verifyRef));
  check("status is written with verify-screen.js --status --phase --run (never by hand) and waited on with --wait --run, in the verifier, the verify skill, references/verify.md and build-screen",
    [verifier, verifySkill, verifyRef].every((t) => /--status <Screen> --phase <(phase|p)> --run <id>|--status <screen> --phase <p> --run <id>/.test(t) && /--wait <(Screen|screen)> --run <id>/.test(t))
    && /never by hand/.test(verifier) && /--wait <Screen> --run <id>/.test(skill) && !/"at": "<ISO timestamp>"|date -u \+%Y-%m-%dT%H:%M:%SZ`\. A/.test(verifier));
  check("the probe is given --run <id> and writes measuring/measured itself", /verify-probe\.js".{0,300}--run <id>/.test(verifier) && /verify-probe\.js.{0,300}--run <id>/.test(verifySkill));
  // (phrases matched loosely: whitespace and line breaks collapse, case-insensitive where it is prose)
  const ws = (t: string): string => t.replace(/\s+/g, " ");
  check("the verifier stages evidence.json and state PNGs in node_modules/.cache/designtwin-verify/stage/<runId>/ and publishes with --phase done --publish; nothing written into the project while a page is open; watch-ignore is only a suggestion",
    [verifier, verifySkill, verifyRef].every((t) => /node_modules\/\.cache\/designtwin-verify\/stage\/<runId>\//.test(t) && /--publish <stageDir>/.test(t) && !/<os tmpdir>\/designtwin-verify/.test(t))
    && /never write into the project tree while a page of the app is open/i.test(verifier) && /server\.watch\.ignored/.test(verifier) && /@source not/.test(verifier) && /suggestions, never edits/i.test(verifier));
  check("every non-measurement claim carries its evidence (command + count, path + stat mtime, navigation log) and unproven leads are listed separately and labelled (verifier and verify skill)",
    [verifier, verifySkill].every((t) => /not a measurement carries its evidence/i.test(t) && /stat` mtime/.test(t) && /navigation log/.test(t) && /unproven leads/.test(t)));
  check("close only what you opened, stop only a PID you started and recorded, never pkill -f / killall / pattern kills, reuse the user's dev server",
    [verifier, verifySkill].every((t) => /only what you opened/i.test(t) && /PID you started and recorded/.test(t) && /never `pkill -f`, `killall`/i.test(t) && /(reuse|reusing) a dev server the user/i.test(t)) && /never `pkill -f`/.test(verifyRef));
  check("the live status lives in the run cache (node_modules/.cache/designtwin-verify/), so heartbeats never touch the project; done publishes design/verify/<S>.status.json (verifier, verify skill, references/verify.md, build-screen)",
    [verifier, verifySkill, verifyRef].every((t) => /node_modules\/\.cache\/designtwin-verify\/<(Screen|screen)>\.status\.json/.test(t) && /heartbeats are free|status writes are free/i.test(ws(t)) && /publish\w* the final status/i.test(ws(t)))
    && /node_modules\/\.cache\/designtwin-verify/.test(skill) && /published as `design\/verify\/<screen>\.status\.json` at `done`/.test(ws(skill)));
  check("done checks the measured file before it copies anything (verifier, verify skill, references/verify.md)",
    /`done` checks first and publishes only then/.test(ws(verifier)) && [verifySkill, verifyRef].every((t) => /`done` checks the measured file first, then copies/.test(ws(t))));
  check("'a safety check separate from auto mode blocked this request' is labelled a no-verdict denial that retrying will not fix (not a real block); the transient form is 'temporarily unavailable …, so auto mode cannot determine the safety of'",
    [verifier, verifySkill, verifyRef].every((t) => { const x = ws(t); return /safety check separate from auto mode blocked this request.{0,300}(retrying will not|do not retry)/i.test(x) && /temporarily unavailable.{0,20}so auto mode cannot determine the safety of/i.test(x); })
    && !/real\* block \(the classifier names a rule or reason, or "a safety check/.test(ws(verifier)));
  check("a permission denial is not a sandbox violation: never dangerouslyDisableSandbox, transient no-verdict retried unchanged at most 2 times, a real block is neither retried nor rephrased, then status blocked + hand-back with a narrow allow rule",
    [verifier, verifySkill].every((t) => /never (set|use) `dangerouslyDisableSandbox`/i.test(t) && /(at most 2 retries|at most twice)/i.test(t) && /(do not rephrase|do not retry or rephrase)/i.test(t) && /blocked on permissions: done \/ remaining/.test(t) && /narrow allow rule/.test(t))
    && /`blocked`/.test(verifyRef) && /dangerouslyDisableSandbox/.test(verifyRef));
  check("the probe is bounded by --max-time (exit 4); one re-run after exit 4, then status failed — never a loop", [verifier, verifySkill].every((t) => /--max-time/.test(t) && /ONCE/.test(t) && /status `failed`/.test(t)) && /one re-run/.test(verifyRef));
  check("nodeId and trigger are copied VERBATIM from the expectation row; a pair that matches no row is reported", /VERBATIM from the\s+expectation row/.test(verifier) && /VERBATIM from the expectation row/.test(verifySkill) && /matched no designed interaction/.test(verifier + verifySkill));
  check("each interaction records outcome (url-changed | dialog-opened | selector-appeared | state-changed | none) and navEvents; a pass needs exactly one match, an allowed outcome, no unexpected navigation; else not-probed; the example carries both fields",
    [verifier, verifySkill].every((t) => /`url-changed`.{0,20}`dialog-opened`.{0,20}`selector-appeared`.{0,20}`state-changed`.{0,20}`none`/.test(t) && /navEvents/.test(t) && /ONE (matched )?(element|match)/.test(t) && /not-probed/.test(t))
    && /"outcome": "dialog-opened", "navEvents": 0/.test(verifier));
  check("navEvents counts DOCUMENTS LOADED (a reload or a full navigation) — not framenavigated / pushState / hash changes; navigate, back or url may load one; an in-page url-changed passes wherever allowed",
    [verifier, verifySkill].every((t) => { const x = ws(t); return /documents loaded/i.test(x) && /pushState/.test(x) && /navigate, back or url/.test(x); })
    && /never count `framenavigated`/.test(ws(verifier)) && /load` events/.test(ws(verifier)) && !/probe's navigation log or your own `framenavigated`/.test(ws(verifier)) && !/Only a designed navigation may have/.test(ws(verifier)));
  check("rebuild before measuring a preview/static build; the report prints the build identity and warns SAME BUILD SERVED", [verifier, verifySkill, verifyRef].every((t) => /[Rr]ebuild/.test(t) && /SAME BUILD SERVED/.test(t)));

  // the probe and --compare write into design/verify too, so every page of the app the agent opened is closed
  // BEFORE either runs — the rule is stated in each doc, and where a doc shows the probe command, it comes first.
  const closeRule = /[Cc]lose every page and browser of the app you opened BEFORE running the probe or `--compare`/;
  const closeAt = (t: string): number => t.search(/close(s)? every page and browser of the app (you|it) opened/i);
  const probeAt = (t: string): number => t.search(/verify-probe\.js"? \\? ?--expected/);
  check("verifier, verify skill, references/verify.md and build-screen: close every page and browser of the app you opened BEFORE running the probe or --compare",
    [verifier, verifySkill, verifyRef, skill].every((t) => closeRule.test(t)));
  check("…and the close rule comes BEFORE the probe command wherever a doc shows it (verifier §4, verify skill, build-screen)",
    [verifier, verifySkill, skill].every((t) => probeAt(t) > 0 && closeAt(t) >= 0 && closeAt(t) < probeAt(t))
    && /First close every page and browser of the app you opened \(§2\)/.test(verifier) && /first closes every page and browser of the app it opened, then runs the shipped probe/.test(verifySkill));
  check("the probe writes only after closing its own browser (verifier, verify skill, references/verify.md)",
    [verifier, verifySkill, verifyRef].every((t) => /opens and closes its own browser,? and writes only after closing it/.test(t)));
  check("the verifier no longer says only `done` writes into the project; it names the probe's and --compare's own writes, each with no page open",
    !/Only `done` writes into the project/.test(verifier) && /Three things write into the project, each with no page of the app open: the probe .{0,200}`--compare` .{0,120}`done`/.test(verifier));
  // The run cache is the project's own node_modules (nearest package.json, or the hoisted workspace root,
  // never past .git); the tmpdir fallback (no package.json, PnP) is not shared across the sandbox
  check("the run cache is beside the nearest package.json at or above design/verify (a hoisted monorepo's workspace root, never past .git); without one (or PnP) the OS temp dir, not shared by sandboxed and unsandboxed commands — run them all the same way",
    [verifier, verifySkill, verifyRef].every((t) => /nearest `package\.json` at or above `design\/verify`/.test(t) && /workspace root/.test(t) && /never past the repo's `\.git`/.test(t)
      && /With no `package\.json` \(or Yarn\s+PnP\)/.test(t) && /sandboxed and unsandboxed commands do not share/.test(t) && /the same way/.test(t) && !/nearest (one|`node_modules`) at or above/.test(t)));
  check("exit 6 = the run cache is not accessible: in every --wait exit list, and each doc says run from the project root or allow writes there; the probe only warns",
    [verifier, verifySkill, verifyRef, skill].every((t) => /5 timeout or no progress[^)]{0,40}, 6 run cache not accessible/.test(t))
    && [verifier, verifySkill, verifyRef].every((t) => /Exit 6 from `--status` or `--wait` means the run cache is not writable/.test(t) && /run from the project root, or allow\s+writes there/.test(t) && /the probe only prints the same as a warning/.test(t)));
  check("the verifier says the probe measures in its own browser, so a write reloads the agent's OWN open page and its later interaction evidence",
    /the probe measures in its own browser, so what a write\s+reloads is YOUR page/.test(verifier) && /interaction evidence you record on it afterwards/.test(verifier) && !/the measurement records 1 document loaded/.test(verifier));
  // evidence is staged and published, never written into design/verify directly
  check("the verify skill never has the agent write design/verify/<Screen>.evidence.json directly: staged, then published at done",
    !/judges absent, in `design\/verify\/<Screen>\.evidence\.json`/.test(verifySkill) && /in `<Screen>\.evidence\.json` — staged in the run's stage dir and published into `design\/verify\/` at `done`, never written there directly/.test(verifySkill));
  check("--wait exit 5 is 'timeout or no progress' everywhere (never 'no timeout/progress')",
    [verifier, verifySkill, verifyRef].every((t) => /5 timeout or no progress/.test(t) && !/no timeout\/progress/.test(t)));
  check("never reinstall dependencies (npm ci / npm install) during a verify run — it clears node_modules/.cache (live status + staged files)",
    [verifier, verifySkill, verifyRef].every((t) => /Never reinstall dependencies \(`npm ci`, `npm install`\) during a verify run/.test(t) && /clears `node_modules\/\.cache`/.test(t)));
  check("--status/--wait resolve --dir (default design/verify) against the current directory; from elsewhere pass --dir (absolute works)",
    [verifier, verifySkill, verifyRef].every((t) => /`--status` and `--wait` resolve `--dir` \(default `design\/verify`\) against the current directory/.test(t) && /an absolute path works/.test(t)));
  // integrity failures outrank the grades
  check("the verify skill says an integrity failure makes the verdict incomplete even with high mismatches (the numbers belong to an unverified run)",
    /even when there are high mismatches: those numbers belong to an unverified run/.test(verifySkill) && /even with high mismatches/.test(verifySkill));
}

console.log("verify docs (match confidence + per-node-type rules):");
{
  // the canonical list from the probe's own source (read through the namespace: an older tree is a clean ✗)
  const pmNs: Record<string, unknown> = { ...PM };
  const canon = Array.isArray(pmNs.CANONICAL_MATCHED_BY) ? pmNs.CANONICAL_MATCHED_BY.filter((x): x is string => typeof x === "string") : [];
  const listed = /`matchedBy` is one of the values the probe writes: ((?:`[a-z-]+`(?:, )?)+)\./.exec(verifier)?.[1]?.match(/`([a-z-]+)`/g)?.map((x) => x.slice(1, -1)) ?? [];
  check(`the visual-verifier's matchedBy list = probe-match.ts CANONICAL_MATCHED_BY (doc: ${listed.join(", ")})`, canon.length > 0 && JSON.stringify(listed) === JSON.stringify(canon));
  check("the verifier says what tag-alias means (another screen's id for the same node, the row's `aliases`) and the caps",
    /`tag-alias` is an element tagged with the id the same node has in another screen's export/.test(verifier) && /`aliases`/.test(verifier)
    && /`text-ordinal` or `tag-alias` is at most medium, by `position` or any value you invent at most\s+low/.test(verifier));
  check("the verifier's textBox row: for EVERY TEXT node, and a TEXT node's x/width come from textBox only",
    /\| `textBox` \| for every TEXT node:/.test(verifier) && /x and width are compared from `textBox` only/.test(verifier) && !/\| `textBox` \| for a TEXT node:/.test(verifier));
  check("the verifier: a ring (box-shadow 0 0 0 Npx, five shadows, by content not position) or an inside outline is borderWidth/borderColor with strokeFrom + strokeAlign",
    /`box-shadow: 0 0 0 Npx`/.test(verifier) && /five shadows/.test(verifier) && /never by\s+its position/.test(verifier) && /`outline-offset: -Npx`/.test(verifier) && /`strokeFrom` \(`box-shadow` \| `outline`\)/.test(verifier) && /`strokeAlign`\s+\(`inside` \| `outside`\)/.test(verifier));
  check("the verify skill: text-ordinal/tag-alias at most medium, position and non-canonical at most low, cappedFrom, a tag removes the cap",
    /`text-ordinal` or `tag-alias` is at most medium; by `position` or any other value a hand-written probe invents \(`structural`, …\), at most low/.test(verifySkill) && /`cappedFrom`/.test(verifySkill) && /removes the cap/.test(verifySkill));
  check("the verify skill documents cappedBy (\"match\" | \"size\") beside cappedFrom",
    /`cappedFrom`, and `cappedBy` says which cap\(s\) applied \(`"match"` for this one, `"size"` for the\s+`match \(size\)` cap below\)/.test(verifySkill));
  check("the verify skill: `match (size)` — ≥2× / ≤½ and ≥8px off, hug-growth rule, one medium row, the node's other deltas capped at low, waivable",
    /`match \(size\)`/.test(verifySkill) && /at least twice \(or at most half\)/.test(verifySkill) && /at least 8px off/.test(verifySkill) && /only when the other axis is off too/.test(verifySkill)
    && /one medium `match \(size\)` row/.test(verifySkill) && /caps every other delta of that node at low/.test(verifySkill) && /waiver on\s+`match \(size\)` accepts the element/.test(verifySkill));
  check("the verify skill: hug text box to box (1px); fixed/fill text by ink width (renderBox.w, 3px, `width (text ink)`), box notComparable",
    /Hug text \(auto width\) is compared box to box, tolerance 1px/.test(verifySkill) && /`renderBox\.w`\), tolerance 3px, labelled `width \(text ink\)`/.test(verifySkill) && /`notComparable`/.test(verifySkill));
  check("the verify skill: width not comparable only when the DESIGN truncates (ink ≥ box − 3, or maxLines > 1); otherwise by ink; a placeholder's width/x not comparable",
    /not comparable only when the DESIGN\s+truncates/.test(verifySkill) && /ink ≥ box − 3px/.test(verifySkill) && /`maxLines` > 1/.test(verifySkill) && /compared by ink/.test(verifySkill)
    && /placeholder's width and x\s+are not comparable/.test(verifySkill) && !/Truncated text's width is not comparable/.test(verifySkill));
  check("caps: `data-dt-node` and `id` read as tag, no matchedBy is no cap — never 'any value outside the probe's own list' (verify skill and verifier)",
    /synonyms `data-dt-node` and `id` \(read as `tag`\), or no `matchedBy` at all/.test(verifySkill) && !/any\s+value outside the probe's own list/.test(verifySkill)
    && /`data-dt-node` and `id` read as `tag`; no `matchedBy` is no cap/.test(verifier) && !/by `position` or any other value at most/.test(verifier));
  check("[opacity] the verify skill: radius on a layer that draws nothing, padding a fixed axis cannot show, inline FRAME ids, stated opacity + at-rest opacity under a drawn state",
    /radius on a layer that draws nothing/i.test(verifySkill) && /padding a fixed axis cannot show — per side/.test(verifySkill) && /`display: inline`.{0,200}tag the element that owns the box/.test(verifySkill)
    && /Opacity is stated on every node that paints or carries copy/.test(verifySkill) && /measured\s+at rest is not measured for opacity/.test(verifySkill));
  check("match (size) names its exemptions: TEXT, leaves, inline matches; a frame root's grown height", /TEXT nodes, leaves and inline matches are exempt/.test(verifySkill) && /frame root's height that\s+only grew/.test(verifySkill));
  check("the verify skill: radius on a <tr>/row group is not measured (rows don't draw corners)", /`border-radius` on a `<tr>`.{0,80}does not\s+render/.test(verifySkill) && /corner\s+cells' radii/.test(verifySkill));
  check("the verify skill: rings/outlines read as the border; CSS-snapped border width vs raw ring width, tolerance 0.5px",
    /`box-shadow: 0 0 0 Npx`/.test(verifySkill) && /`strokeFrom`/.test(verifySkill) && /floors a border to whole pixels, minimum 1px/.test(verifySkill) && /tolerance 0\.5px/.test(verifySkill));
  check("the verify skill: the shared-shell split and foreign tags are informational, never verdict-changing",
    /nodes measured a\/b \(shared shell c\/d\)/.test(verifySkill) && /`untaggedInstanceSetsInShell`/.test(verifySkill) && /The split never changes the verdict/.test(verifySkill)
    && /`probe\.foreignTags`/.test(verifySkill) && /Foreign tags are informational/.test(verifySkill) && /They never change the verdict/.test(verifySkill));
  check("build-screen: a shared shell MAY keep one frame's ids (recovered by component path + name path aliases), but a per-screen id table measures more; either is fine, never invent ids",
    /shell shared by several screens may keep the ids of ONE frame/.test(skill) && /recovers much of it/.test(skill) && /by name path through\s+the aliases/.test(skill)
    && /not repeated names, a shell used twice, or a hand-written probe/.test(skill) && /per-screen id table .{0,80}still measures more/.test(skill) && /Either is fine — never invent ids/.test(skill)
    && !/don't hand-maintain a per-screen id table/.test(skill) && !/keeps the ids of ONE frame/.test(skill));
  check("capped deltas block a plain pass (incomplete, never fail/pass, 'tag these elements') — verify skill and verifier",
    /any capped delta blocks a plain pass: the verdict is `incomplete`/.test(verifySkill) && /low-confidence matches — tag these elements/.test(verifySkill) && /never `fail`, never `pass`/.test(verifySkill)
    && /Any capped delta keeps the\s+screen from a plain pass \(verdict `incomplete`/.test(verifier));
  check("a waiver on match (size) lifts ONLY the size cap; a match-confidence cap (position, tag-alias, text-ordinal, hand-written) stays (old 'restores'/'capped lows never block' gone)",
    /`match \(size\)` accepts the element and lifts ONLY the size cap/.test(verifySkill) && /unless a match-confidence cap \(`position`, `tag-alias`, `text-ordinal`, a hand-written\s+value\) also applies/.test(verifySkill)
    && !/restores the node's capped severities/.test(verifySkill) && !/capped lows never block/.test(verifySkill) && !/restores the node's capped/.test(verifier));
  check("the verdict list: `incomplete` names deltas on low-confidence matches",
    /- \*\*incomplete\*\* —[^]*?deltas on low-confidence matches \(any\s+delta a match cap lowered\)[^]*?An integrity/.test(verifySkill));
  check("a wrapping list: main-axis padding shows (only its largest child can overflow), cross axis = stacked lines; space-around/space-evenly behave as centred",
    !/never overfull on its main axis/.test(verifySkill) && /overfull only when its largest child alone is wider than the inner width/.test(verifySkill)
      && /cross axis the content is\s+the stacked lines/.test(verifySkill) && /`space-around`\/`space-evenly`, → both/.test(verifySkill));
  check("overfull fixed box: only the side the content does not start from is skipped (start → end side; centred → both)",
    /only the side the content does not start from \(start-aligned → the end side; centred, or\s+`space-around`\/`space-evenly`, → both\)/.test(verifySkill));
}
console.log("build-screen docs (steps / dialog driving / precedence / overflow):");
{
  const docs = { verifier, verifySkill, verifyRef, skill };
  check("--steps: closed click / waitFor / goto vocabulary, exactly one visible match, never submit, idempotent, exit 4 with nothing written, replayed on the re-run and every driven row (verifier, verify skill)",
    [verifier, verifySkill].every((t) => /`--steps`/.test(t) && /`\{"click": "<selector>"\}`, `\{"waitFor": "<selector>"\}`, `\{"goto": "\/same-origin\/path"\}`/.test(t) && /EXACTLY ONE visible\s+element/i.test(t)
      && /never submits a form/.test(t) && /[Ii]dempotent/.test(t) && /exit 4 and nothing is written/.test(t) && /its re-run after a same-URL reload/.test(t) && /every page the probe drives an interaction on/.test(t)));
  check("the plan's `route` is advisory; the skill passes the plan to --steps only when it has `navigate` (verifier, verify skill, build-screen, references)",
    /`route` is advisory/.test(verifier) && /`route` stays advisory/.test(verifySkill) && /`route` \(advisory free text/.test(skill) && /`route` is advisory/.test(verifyRef)
    && /pass the plan as `--steps`/.test(verifier) && /pass the plan to `--steps` only when it has a `navigate` list/.test(verifySkill) && /Pass the plan as\s+`--steps` whenever it has `navigate`/.test(skill));
  check("the probe call in every doc shows --steps",
    [verifier, verifySkill, skill].every((t) => /verify-probe\.js[^`]*--steps design\/plan\/<screen>\.json/.test(t)) && /`--steps <plan\.json>`/.test(verifyRef));
  check("the shipped probe drives overlay/swap on_click/on_press and plan expect:dialog rows: reveals hover-hidden openers, mouse vs synthetic activation, never ok:false, destination tag inside",
    [verifier, verifySkill].every((t) => /`overlay` or `swap`|`overlay` \/ `swap`/.test(t) && /`on_click` \/ `on_press`/.test(t) && /`expect: "dialog"`/.test(t) && /hover-hidden opener/.test(t) && /`"synthetic"`/.test(t) && /never a user activation/.test(t)
      && /never `ok: false`|NEVER `ok: false`/.test(t) && /`data-dt-node` tag (on or )?INSIDE|tag INSIDE|on or inside/i.test(t)));
  check("the dialog contract selectors, in order (verifier, verify skill, references)",
    [verifier, verifySkill, verifyRef].every((t) => /`:modal`, `dialog\[open\]`, `\[role=dialog\]`, `\[role=alertdialog\]`,\s*`\[aria-modal="true"\]`, `:popover-open`/.test(t)));
  check("the agent does not re-drive rows the probe drove, drives the rest as before, and its own detector uses the same contract — never `[role=dialog]` alone",
    /Do not re-drive a row the probe drove with `ok: true`/.test(verifier) && /SAME contract the probe does — never a `\[role=dialog\]`-only\s+detector/.test(verifier)
    && /does NOT re-drive rows the probe drove with `ok: true`/.test(verifySkill) && /never `\[role=dialog\]` alone/.test(verifySkill) && /never `\[role=dialog\]` alone/.test(verifyRef));
  check("builders tag a dialog/overlay's ROOT with its destination frame id (data-dt-node); an untagged dialog is not-probed",
    /Tag a dialog or overlay's root element with its destination frame id/.test(skill) && /root of the modal\/sheet/.test(skill) && /untagged dialog is `not-probed`/.test(skill));
  check("plan.navigate / plan.interactions rows {nodeId, trigger, expect, destinationId}; --plan at --expect or auto-discovery; changed after --expect → incomplete until re-run",
    /`plan\.navigate`/.test(skill) && /`plan\.interactions` as `\{nodeId, trigger, expect: "dialog" \| "url" \|\s*"selector:<css>", destinationId\}`/.test(skill) && /`destinationId` required for `dialog`/.test(skill)
    && /Change `plan\.interactions` afterwards and `--compare` is `incomplete` until `--expect` is re-run/.test(skill)
    && /`--plan <plan\.json>`, else the ONE plan in\s+`design\/plan\/` that describes the frame/.test(verifySkill) && /`incomplete` until `--expect` is\s+re-run/.test(verifySkill));
  check("precedence in plain words: probe rows authoritative only in a --run with an intact status chain; a probe miss never overrides full agent evidence; a `by` field means nothing",
    /authoritative only in a `--run` with an intact status chain/.test(verifySkill) && /A `by` field in a file means nothing/.test(verifySkill) && /a probe miss \(`ok: null`\) or a row cut by the time budget never overrides an agent row that has full evidence/.test(verifySkill)
    && /a probe miss\s+never overrides it/.test(verifier));
  check("overflowX: a high, waivable delta on the root frame via --accept --node <frame> --field overflowX",
    /Page overflow at the design width \(`overflowX`\)/.test(verifySkill) && /HIGH delta on the root frame \(field `overflowX`/.test(verifySkill) && /recorded as in step 6 with `--node <frame id> --field overflowX`/.test(verifySkill) && /`overflowX`, a high waivable delta on the root frame|\(`overflowX`, a high waivable delta/.test(verifyRef));
  check("overflowX is not judged when designed to scroll horizontally, viewport != design width, clipped, or not measured; fixed never counts, off-canvas absolute/transformed drawers do",
    /designed to scroll horizontally, the viewport is not the design width, the overflow is clipped/.test(verifySkill) && /or the page was not measured/.test(verifySkill) && /`position: fixed` elements never count; an off-canvas\s+absolutely-positioned or transformed drawer does/.test(verifySkill));
  check("the new report fields: inputs.reach, coverage.pageOverflow, interactionsByProbe, evidenceFrom",
    /`inputs\.reach`/.test(verifySkill) && /`coverage\.pageOverflow`/.test(verifySkill) && /`interactionsByProbe`/.test(verifySkill) && /`evidenceFrom`/.test(verifySkill) && /`measured\.reach`/.test(verifySkill));
  check("exit 4 lists a failed --steps step in the verifier and the verify skill", /a `--steps` step failed/.test(verifier) && /a `--steps` step that failed/.test(verifySkill));
  void docs;
}
console.log("build-screen docs (dialog triggers + step matching):");
{
  check("a plan `expect: \"dialog\"` row needs an on_click / on_press trigger (verifier, verify skill, build-screen, references)",
    /`expect: "dialog"` \(source `plan`; `--expect` keeps such a row only with an `on_click` \/ `on_press` trigger\)/.test(verifier)
    && /whose trigger must be `on_click` or `on_press`/.test(verifySkill) && /a `dialog` without `destinationId` or on another trigger/.test(verifySkill)
    && /a `dialog` row's trigger is\s+`on_click` or `on_press`/.test(skill) && /`expect: "dialog"` rows \(`on_click` \/ `on_press` only\)/.test(verifyRef));
  check("steps: a `click` matches exactly one visible element, a `waitFor` at least one (verifier, verify skill, build-screen, references)",
    /A `click` selector must\s+match EXACTLY ONE visible element; a `waitFor` succeeds once AT LEAST ONE visible element matches/.test(verifier)
    && /A `click` selector must match exactly ONE visible element \(a `waitFor` succeeds once AT LEAST ONE visible element matches\)/.test(verifySkill)
    && /each `click` selector matches exactly one visible element, a `waitFor` at least one/.test(skill) && /exactly one visible\s+match per `click` \(a `waitFor` needs at least one\)/.test(verifyRef));
  check("disabled openers are not driven and an opener that would submit a form is not clicked — ok:null (verifier, verify skill, references)",
    [verifier, verifySkill].every((t) => /A disabled opener \(`:disabled`,\s+`\[disabled\]` or `aria-disabled="true"`, on it or on an ancestor\) is not driven/.test(t) && /an opener that would submit\s+a form[^.]*is not clicked/.test(t))
    && /skipping a disabled\s+opener \(`:disabled` \/ `\[disabled\]` \/ `aria-disabled`, on it or an ancestor\) and one that would submit a form \(`ok: null`\)/.test(verifyRef));
  check("the destination tag: on or inside the opened element, or on a NEWLY visible ancestor — never one visible before the click (verifier ×2, verify skill, build-screen, references)",
    /or on an ancestor of it that became visible with it — never on one that was already\s+visible/.test(verifier) && /or on a NEWLY visible ancestor of\s+it — never one visible before the click/.test(verifier)
    && /or on an ancestor of it that became visible with it — never one already visible before the click/.test(verifySkill)
    && /or on an ancestor of it that became visible with it \(never one visible before the click\)/.test(skill) && /or on a newly visible ancestor of it/.test(verifyRef));
  check("one plan rule: of several plans, the one listing files[]; --compare picks the same; the re-run names --plan (verify skill, build-screen)",
    /or — when several do — the one\s+that lists `files\[\]`; `--compare` picks the plan by the same rule/.test(verifySkill) && /with the `--plan` it names, when it names one/.test(verifySkill)
    && /of several, the one listing `files\[\]`/.test(skill));
  check("a plan with navigate and a probe run without --steps → an input note (verify skill)", /A plan with `navigate` and a\s+probe run without `--steps` gets an input note/.test(verifySkill));
  check("[known limit] probe rows bind only through the run's status chain; a hand-recorded measured file gains no pass power beyond the evidence rules + the destination tag (verify skill)",
    /Known limit: the binding is the run's status chain, nothing more/.test(verifySkill) && /its rows gain no pass power beyond what the evidence rules and the destination tag already demand/.test(verifySkill));
}
console.log("build-screen docs (plan file for --compare + step load ownership):");
{
  check("--compare checks the plan file --expect merged from while it exists; gone → names both plans and asks for --plan (verify skill, build-screen)",
    /the plan file `--expect` merged from\s+wins while it still exists — an input note says so — and when that file is gone the reason names both plans/.test(verifySkill)
    && /`--compare … --plan <its path now>` or `--expect … --plan <the plan you intend>`/.test(verifySkill)
    && /`--compare`\s+checks the plan file `--expect` merged from while it exists \(if that file moved, pass its new path as `--plan`\)/.test(skill));
  check("step load ownership: a click's navigation to ANOTHER URL is the step's own however late; a same-URL new document never is (verifier, verify skill)",
    [verifier, verifySkill].every((t) => /a document\s+load that goes to ANOTHER URL than the page shows \(the fragment ignored\), whether its request starts while the click runs\s+or LATER \(until the next `click` \/ `goto` step or the end of the steps\)|a document load that goes to ANOTHER URL than the page shows \(fragment ignored\), whether its request starts while the click runs or later \(until the next `click` \/ `goto` step or the end of the steps\)/.test(t)
      && /`await save\(\);\s+location\.href = "\/other"` after any delay is the\s+step's own/.test(t) && /A new document at\s+the SAME URL \(`location\.reload\(\)`, a dev-server reload/.test(t)));
  check("an in-place click undone by a reload → one re-run with the steps replayed, then a step-specific exit 4 that names the step, not the dev server (verifier, verify skill, references, build-screen)",
    [verifier, verifySkill].every((t) => /the pass is re-run once\s+with the steps replayed[,;] (and )?the same again is exit 4/.test(t) && /"the page reloaded \(<url> again, not a navigation\) after step N\s+… had changed it in place"/.test(t)
      && /reach the screen by its own URL \(`--url` or a\s+`goto` step|reach the screen by its own URL, `--url` or a `goto` step/.test(t) && /A reload after a `goto` or (after )?a click's own navigation is\s+(only waited for|only waited for and counted)/.test(t))
    && /a reload undid an in-place `--steps` click on both passes/.test(verifier) && /a reload that undid an in-place `--steps` click on both passes/.test(verifySkill)
    && /Only the reload-during-measurement message points at\s+the dev-server watch/.test(verifier)
    && /a click that reloads the same URL\s+loses what it built, one re-run, then exit 4 naming the step/.test(verifyRef)
    && /a `click` changes the page in place or navigates to another URL, never reloads the one it is on/.test(skill));
  check("every settle first waits for the document to finish loading (readyState complete, 10 s cap, then a note) (verifier, verify skill)",
    /every settle first waits for the document to finish loading \(`document\.readyState`\s+`"complete"`; at most 10 s per document, then it measures anyway, with the note "the document had not finished loading",/.test(verifier)
    && /every settle first waits for the document to finish loading \(`document\.readyState` `"complete"`, at most 10 s per document, then it measures anyway with a note,/.test(verifySkill));
  check("the submit refusal also checks the element at the click point (verifier ×2, verify skill ×2)",
    /typeless button inside a `<form>`, on the element or at its click point, is refused/.test(verifier) && /typeless button inside a `<form>`, on it or at its click point\) is not clicked/.test(verifier)
    && /typeless button inside a `<form>`, on the element or at its click point, is refused/.test(verifySkill) && /an opener that would submit a form \(on it or at its click point\) is not clicked/.test(verifySkill));
}
console.log("build-screen docs (same-URL documents + load wait):");
{
  check("a same-URL new document is never a click's own — not even one its handler starts at once (verifier, verify skill)",
    /never a step's own — not even\s+one the click's handler starts at once \(`draw\(\); location\.reload\(\)`\)/.test(verifier)
    && /is never a step's own, not even one the click's handler starts at once \(`draw\(\); location\.reload\(\)`\)/.test(verifySkill));
  check("the 10 s load wait is per document: no later settle waits for that document again (verifier, verify skill)",
    /at most 10 s per document[^)]*and no later settle waits for that document again[;)]/.test(verifier) && /at most 10 s per document[^)]*and no later settle waits for that document again[;)]/.test(verifySkill));
  check("a link click to the URL already shown owns the load it starts (like a goto; a later same-URL load is a reload); the probe's own loads (--url, goto) wait up to --timeout, then a committed document is measured with the note (verifier, verify skill, references)",
    [verifier, verifySkill].every((t) => /a `click` on a link \(the element or its\s+closest `a\[href\]`, same tab\) to the URL the page already shows/.test(t)
      && /like a `goto`'s \(only the load the click itself starts; a later same-URL load is a reload\)/.test(t)
      && /the probe's own loads — the first `--url` load and a `goto` — wait for\s+the load event up to `--timeout` instead/.test(t)
      && /never finishes loading is then measured with the note "the page had not finished loading when the goto gave up"/.test(t)
      && /a server\s+that never answers — or a page that goes on to one before its load — is still "could not load"/.test(t) && !/measured after 10 s with that note/.test(t))
    && /a link to the URL already shown counts as a `goto` for the load the click starts/.test(verifyRef));
  check("with steps, always pass --ready on the screen root (or end with a waitFor of it): a click that lands elsewhere is still the step's own (verifier, verify skill, references, build-screen ×2)",
    /With steps, always pass `--ready '\[data-dt-node="<frame id>"\]'` \(or end the steps with a\s+`waitFor` of the screen root\)/.test(verifier) && /an expired session bouncing to a login page/.test(verifier)
    && /With steps, always pass `--ready '\[data-dt-node="<frame id>"\]'` \(or end the steps with a `waitFor` of the screen root\)/.test(verifySkill) && /an expired session bouncing to a login page/.test(verifySkill)
    && /always pass `--ready` with the screen root's tag, or end the\s+steps with a `waitFor` of it/.test(verifyRef)
    && /\[--steps design\/plan\/<screen>\.json --ready '\[data-dt-node="<frame id>"\]'\]/.test(skill) && /with `--ready` on the screen root's tag/.test(skill));
}
console.log("build-screen docs:");
{
  check("verify skill: a \"Behaviour and accessibility\" paragraph — checks never change the verdict, a fail is a Stop-hook warning, a measurable a11y failure is never waived",
    /\*\*Behaviour and accessibility\b/.test(verifySkill) && /never change the verdict/.test(verifySkill) && /Stop hook/.test(verifySkill)
    && /a measurable accessibility failure is never waived/.test(verifySkill) && /raise a designer question/.test(verifySkill));
  check("verify skill: copy report.behaviour.summary into plan.verification.a11y (tool, violations = fail, warnings = warn)",
    /copies `report\.behaviour\.summary` into `plan\.verification\.a11y`/.test(verifySkill) && /`tool` being `"axe-core <version>"` when axe-core ran, else\s+`"verify-probe behaviour checks"`/.test(verifySkill) // the strings plan-record writes
    && /violations: summary\.fail/.test(verifySkill) && /warnings: summary\.warn/.test(verifySkill));
  check("verify skill: a11y.report names the report copied from; summary.fail counts a +N more row's elements; keys only on a button-like opener, outside clicks only on a backdrop, the safe close never a link, closed-menu openers not-run",
    /report: "<the report\.json you copied it from>"/.test(verifySkill) && /`summary\.fail` counts the elements behind a "\+N more" row/.test(verifySkill)
    && /Enter\/Space are pressed only on the opener itself when it is a button-like control/.test(verifySkill)
    && /a click outside a dialog lands only on its backdrop or scrim/.test(verifySkill) && /the safe close is a button clicked with the mouse, or a link only when its `href` is `#`, empty or `javascript:`/.test(verifySkill)
    && /never on another control inside a card or row opener/.test(verifySkill)
    && /a11y:\{tool, violations, warnings, report\}\?\}` \(copied from `report\.behaviour\.summary`\)/.test(skill) && /`verification\.a11y` — `\{tool, violations, warnings, report\}`, copied from `report\.behaviour\.summary`/.test(verifyRef)
    && /an opener inside a closed menu or `<details>` is `not-run` for keyboard reach/.test(verifySkill));
  check("verify skill Limits: the write block arms per unit at the first key press / click / scroll / hover / resize, a WebSocket opened then never connects, every check from the first action on is not-run; a missing opener/destination = differs; the drive has NO write block; the opener check (the sole control only when the container shows nothing of its own); the deferred-write gap",
    /per unit, from its first key press, click, scroll, hover or resize on, every\s+request but GET\/HEAD\/OPTIONS — from the page, its frames, workers, shared workers and service workers alike — is blocked\s+browser-wide, every WebSocket message the page sends is dropped and a WebSocket it opens then never reaches the server,\s+which makes every check of that unit from its first action on `not-run` "the page tried to write"/.test(verifySkill)
    && /the screen's own load\s+and `--steps` may write, as in the measurement pass, and a battery page that then shows other tagged elements than the\s+measured one, or misses the opener or destination the check uses, is `not-run` "the page reached for this check differs\s+from the measured page"/.test(verifySkill)
    && /the probe's drive of the interactions \(before the battery\) has no write block: it never clicks\s+an opener that would submit a form or whose click point is another control inside it/.test(verifySkill)
    && /the one button-like control of a cell or card opener whose centre\s+it fills and that shows nothing of its own outside it/.test(verifySkill)
    && /not\s+covered: a GET with a side effect, a WebSocket opened inside a worker, or a write the page defers past the unit's end —\s+an undo window over about 1 s: it never leaves, the unit's page is closed first, but the check that caused it is judged\s+as if nothing was written\)/.test(verifySkill));
  // what the drive refuses and what it cannot see, and the opener check's content, said exactly (no over-claim)
  check("verify skill Limits: the drive says it does not see a closed shadow root or a bare click listener; the container's own background is decoration",
    /but it does not see a control in a closed shadow root or one that is\s+only a click listener with no role \(an icon with an onclick, a bare `<svg onclick>`\), and clicks those;/.test(verifySkill)
    && /its own background colour is decoration — the control the mouse open clicks\)/.test(verifySkill)
    && !/no text, image or icon —/.test(verifySkill));
  check("verify skill Limits: the drive refuses an activating control also under a focusable glyph or editable label, a label's control, a nested page (iframe, object, embed); the opener's own content includes a CSS mask, a filled block and positioned labels escaping a clip; an out-of-flow opacity-0 tooltip, an sr-only label (clipped or at left:-9999px), a filled wrapper or hover tint show nothing; an in-flow opacity-0 label counts; not read: an iframe's page, a closed shadow root, a clip-path other than inset()",
    /another control inside it — an activating control \(also under\s+a focusable glyph or an editable label inside it\), a label's control or a nested page \(an iframe, object or embed\), open\s+shadow roots included —/.test(verifySkill)
    && /no visible text, image, icon \(a CSS mask too\), generated content\s+or filled block \(a swatch, a status dot\), open shadow roots and positioned labels escaping a clip included;/.test(verifySkill)
    && /a tooltip at\s+opacity 0 out of flow, an sr-only label \(clipped, or off the page at left:-9999px\) and a filled wrapper or hover tint over\s+the control show nothing, but a label at opacity 0 in flow \(a reveal-on-scroll entrance yet to play\) counts, and so do\s+a progress bar, a meter and a list marker \(its own too\);/.test(verifySkill)
    && /not read: the page inside an iframe \(the iframe itself counts\),\s+a closed shadow root, a clip-path other than inset\(\) \(what it hides counts\)/.test(verifySkill)
    && !/no visible text, image, icon or generated content, open shadow/.test(verifySkill));
  // the container's own content is decided by pixels too — what counts, what stays decoration, the
  // hover first, the remaining miss
  // decoration only when pixel-verified plain; shadow roots, the marker and the outside hidden;
  // the known misses said honestly (closed shadow roots, the part outside the viewport, a delayed reveal, RTL, hover side effects)
  // the ancestors hidden too, their filters / clip-paths / masks off for the plain test, the real
  // rounded outline, the other pseudo-elements, the opener's own background image / two-colour border / stripe and a label laid
  // over it from outside count; every known miss said
  check("verify skill Limits: the opener hovered first, screenshotted with only its control hidden and with all its content hidden (shadow content, its marker, its other pseudo-elements), the outside and its ancestors hidden in both; any painted difference counts; decoration only its own background colour, a one-colour border, its shadow, and a pixel-verified plain fill or hug wrapper (real rounded outline, filters off); its own background image / two-colour border / stripe, a scroll button and a label laid over it from outside count; a page !important that beats the probe refuses; every known miss",
    /and it shows nothing of its own by its pixels too: the opener, hovered first so a control shown only on hover is at its click point, is screenshotted with only that\s+control hidden and with all its content hidden — the content of its open shadow roots, its own list marker and its other\s+pseudo-elements \(a first letter, a placeholder, a file button, a details' content, scroll buttons and markers\) included,\s+and everything outside the opener, its ancestors too, hidden in both shots so a toast, a ticker or a parent repainted by\s+script never decides — any painted difference counts \(a dot, a swatch, a band, a progress bar, a stripe or a 1-px divider\);/.test(verifySkill)
    && /decoration is only its own background colour, a border in one colour \(a 1-px divider on one side too\) and its shadow, and a\s+fill over all of it or a wrapper within 8 px of the control when, screenshotted alone \(filters, clip-paths and masks of the\s+opener and its ancestors off\), they paint one plain colour \(pixel-verified against their real rounded outline; a 1.5-px\s+anti-aliased edge allowed — a clip-path flag, a background-clip stripe, a progress ring, a shadow ring or a second colour is\s+content, and so is a wrapper with its own small shadow or a 1-px frame in another colour, which is refused\);/.test(verifySkill)
    && /also content:\s+the opener's own background image \(a gradient, a url — a progress fill\), its border in two colours or a stripe 2 px wider\s+than its other sides, a scroll button, and a label, image or generated label laid at least half over the opener from outside\s+its element \(a positioned sibling, a parent's `::after`\) — unless it is fixed or sticky \(a toast or banner is ignored\) or\s+hit-testing shows it under the opener's opaque background;/.test(verifySkill)
    && /a page rule that keeps something showing against the probe's hiding rule \(an inline or\s+cascade-layer `!important`\) refuses;/.test(verifySkill)
    && /not seen: a closed shadow root, foreign content inside an ancestor's shadow root, a\s+shadow root attached after the check started, a part of the opener still outside the viewport once scrolled in, content\s+revealed only after a delay, a generated label of an element lying elsewhere on the page; the probe's init CSS \(no\s+transitions\) is lost when a page replaces `document.adoptedStyleSheets` after its load under a strict style CSP; an sr-only\s+label at `right:-9999px` in a right-to-left page counts as content \(that cell is refused\); and since every opener is\s+hovered first, a `mouseenter` \/ `mouseover` side effect also fires on an opener the drive then refuses \(no write block in\s+the drive\);/.test(verifySkill)
    && !/a 1-px anti-aliased edge and rounded corners allowed/.test(verifySkill) && !/decoration is only its own background,\s+border and shadow/.test(verifySkill));
  // the own inset shadow / ring / mask paint, the tooltip and opacity-0 exemptions, the re-mount
  // refusal, what is refused by rule, what is not seen, the focused element, the named reason
  check("verify skill Limits: the opener's own inset shadow / two-colour ring / masked or clipped paint is content; the control's own tooltip and a label at opacity 0 are never foreign; under it only without opacity / blend; a re-mount during the shots refuses; refused by rule: 500,000 elements, a shadow-root opener, a role-less tooltip, an oklch background; not seen: a sibling's relative ::before, text overflowing a 0-height wrapper; the focused element; the refusal names its reason",
    /the drive\); also content — the opener's own inset box-shadow offset 2 px or more or blurred \(a\s+stripe, a progress fill, an inner glow\), sharp box-shadow ring layers in more than one colour \(the\s+ring layers only — its border does not count, nor does a layer in its own background colour where that cannot show: an\s+outer one, a ring-offset, or an inset one over an opaque `border-box` \/ `padding-box` background\)\s+and its own paint under a mask or a clip-path other than a rounded `inset\(0\)`;/.test(verifySkill)
    && /never foreign content — a tooltip revealed by the probe's\s+hover \(a `\[role=tooltip\]` element, or the element the control's `aria-describedby` names, not shown before the hover;\s+one already on screen is the opener's own label and refuses\) and a label at effective opacity 0;/.test(verifySkill)
    && /a label counts as under the opener only when no opacity below 1 or blend mode sits on the opener or above it;/.test(verifySkill)
    && /an element\s+the page mounts in the opener while it is screenshotted \(a re-render in the shot's own frame\) refuses/.test(verifySkill)
    && /refused by rule: a page with more than 500,000 elements \(the walk for a label\s+laid over the opener stops there\), an opener whose content is re-created while it is compared \(an empty spacer a\s+framework re-creates, marks a morphdom-style patch strips, a placeholder mounted on `mouseleave`; it can differ between\s+runs\), an opener inside a shadow root, a role-less tooltip or other popover laid over the\s+opener/.test(verifySkill)
    && /a label under an opener whose background\s+is `oklch\(\)`, `lab\(\)` or `color\(\)` \(never proven opaque\); not seen \(known misses, the drive can\s+write\): a sibling's relative `::before` shifted over the opener from elsewhere, text overflowing a 0-height wrapper\s+beside it, [^;]*; the focused element outside the opener stays shown in both shots; every refusal names its reason/.test(verifySkill));
  // the tooltip exemption is the one the probe's hover revealed; the ring rule counts ring
  // layers only (not the border, not a background-coloured ring-offset); a re-created opener content refuses (known miss)
  check("verify skill Limits: only a tooltip revealed by the probe's hover is never foreign (one on screen before refuses); the ring rule counts ring layers only, not the border or a ring-offset in the background colour; an opener whose content is re-created while it is compared is refused",
    /a tooltip revealed by the probe's\s+hover \(a `\[role=tooltip\]` element, or the element the control's `aria-describedby` names, not shown before the hover;\s+one already on screen is the opener's own label and refuses\)/.test(verifySkill)
    && /\(the\s+ring layers only — its border does not count, nor does a layer in its own background colour where that cannot show: an\s+outer one, a ring-offset, or an inset one over an opaque `border-box` \/ `padding-box` background\)/.test(verifySkill)
    && /an opener whose content is re-created while it is compared \(an empty spacer a\s+framework re-creates, marks a morphdom-style patch strips, a placeholder mounted on `mouseleave`; it can differ between\s+runs\)/.test(verifySkill)
    && !/its border's colour included/.test(verifySkill) && !/the sole\s+control's own tooltip \(`\[role=tooltip\]`/.test(verifySkill));
  // the ring rule ignores a background-coloured layer only where it cannot show; the known
  // misses of the tooltip record (refused by rule: a pre-mounted hidden tooltip; not seen: display: contents, a re-created label,
  // a page-defined __dtTipPre)
  check("verify skill Limits: a background-coloured ring layer is ignored only where it cannot show (outer, or inset over an opaque border-box / padding-box background); refused by rule: a tooltip pre-mounted at scale(0) or off-screen; not seen: a display: contents tooltip / describedby target, a label re-created on the hover with tooltip semantics, a page-defined window.__dtTipPre",
    /nor does a layer in its own background colour where that cannot show: an\s+outer one, a ring-offset, or an inset one over an opaque `border-box` \/ `padding-box` background\)/.test(verifySkill)
    && /refused by rule:[^]*?a cell whose sole control has a tooltip pre-mounted but hidden by `transform: scale\(0\)` or\s+moved off-screen \(it counts as shown before the hover\)/.test(verifySkill)
    && /not seen \(known misses, the drive can\s+write\):[^;]*, a `display: contents` `\[role=tooltip\]` or `aria-describedby` target laid over the opener, a label the page\s+re-creates as a new element on the hover with tooltip semantics \(`role="tooltip"`, or the control's `aria-describedby`\s+target\), and a page that defines `window.__dtTipPre` itself first turns the record of what was shown before the hover\s+off \(an adversarial page\);/.test(verifySkill)
    && !/a layer in its own background colour, a ring-offset, do not count/.test(verifySkill));
  check("verify skill: names computed by Playwright (Chromium), not screen-reader verified; native-picker rows are synthetic",
    /names computed by Playwright \(Chromium\), not screen-reader verified/.test(verifySkill) && /synthetic \(headless\), not a real-browser observation/.test(verifySkill));
  check("verify skill: axe is optional and resolved from the project, never npm install as the agent; limits listed; never --behaviour off",
    /axe-core.{0,80}optional/.test(verifySkill) && /never run `npm install`/.test(verifySkill) && /destructive paths never run/.test(verifySkill)
    && /iframes are not scanned/.test(verifySkill) && /English-only/.test(verifySkill) && /never pass `--behaviour off`/i.test(verifySkill));
  check("visual-verifier: focus rings checked by keyboard.focus-visible; read report.behaviour, never re-drive the battery; never accept \"cannot emulate forced colours\"",
    /`keyboard\.focus-visible`/.test(verifier) && /read `report\.behaviour`/.test(verifier) && /do not re-drive the battery/.test(verifier)
    && /never accept "the tool cannot emulate forced colours"/i.test(verifier) && /delete-confirm focus, disabled-while-focused and route changes/.test(verifier)
    && /behaviour headline/.test(verifier));
  check("build-screen: a CSS-mask tint vanishes under forced colours — forced-color-adjust: none or CanvasText; inline SVG currentColor needs nothing",
    /mask-image.{0,200}forced colou?rs/.test(skill) && /forced-color-adjust: none/.test(skill) && /background-color: CanvasText/.test(skill) && /fill=\"currentColor\"` needs nothing/.test(skill));
  check("web-tailwind: v4 outline-hidden removes the outline style, so focus-visible:outline-2 needs focus-visible:outline-solid",
    /outline-hidden.{0,120}outline-style: ?none/.test(tw) && /focus-visible:outline-solid/.test(tw));
  check("web-tailwind: hover-revealed actions never `invisible` — a visibility:hidden opener cannot take focus back",
    /never `invisible`.{0,200}(focus back|take focus)/.test(tw));
  check("web-css-modules: the CSS twin — outline-style none defeats a bare outline-width; opacity not visibility for revealed actions",
    /outline-style: ?none/.test(cssm) && /outline-style: ?solid/.test(cssm) && /opacity: ?0/.test(cssm) && /:focus-within/.test(cssm) && /never `visibility: hidden`.{0,200}(focus back|take focus)/.test(cssm));
  check("references/verify: the probe runs the battery and axe; a hand-run axe / Tab-through is only for what the probe reports not-run",
    /probe runs the behaviour battery and axe-core/.test(verifyRef) && /only for what the probe reports `not-run`/.test(verifyRef));
  console.log("build-screen docs:");
  check("visual-verifier: opens <S>.diff.png and report.visual, the diff is never the verdict, grid 1x hides differences",
    /\.diff\.png/.test(verifier) && /report\.visual/.test(verifier) && /never the verdict/.test(verifier) && /referenceImage/.test(verifier) && /grid "1x"/.test(verifier));
  check("verify skill: a Visual diff paragraph names referenceImage and re-running --expect",
    /\*\*Visual diff\*\*/.test(verifySkill) && /referenceImage/.test(verifySkill) && /written before the visual diff existed/.test(verifySkill) && /re-run `--expect`/.test(verifySkill) && /never the verdict/.test(verifySkill));
  check("references/verify: the web probe renders at the reference's scale; Pixels reads report.visual",
    /report\.visual/.test(verifyRef) && /renders at the reference's scale itself/.test(verifyRef));
  // The diff cannot see 1-px lines, light tints or replaced text — the regions are where to START
  const flat = (t: string): string => t.replace(/\s+/g, " ");
  const v3 = [verifier, verifySkill, verifyRef].map(flat);
  check("none of the three docs says to look \"only at the hot regions\"", v3.every((t) => !/only at the hot regions/.test(t)));
  check("all three start at the hot regions, then still compare the whole reference and build side by side (lines, tints, text changes)",
    v3.every((t) => /start at the hot regions, then still compare the whole reference.{0,40}side by side/.test(t) && /1-px lines/.test(t) && /text-only changes rarely become regions/.test(t)));
  check("verify skill limits: the 0.2 threshold is blind to small luminance steps and anti-aliasing absorbs thin lines",
    /0\.2 threshold is blind to luminance steps/.test(v3[1] ?? "") && /anti-aliasing detection absorbs much of a thin line/.test(v3[1] ?? ""));
  check("verify skill: the reference is read from the project owning the expectation; a positive offset is a note",
    /project that owns the expectation/.test(v3[1] ?? "") && /alignment unverified/.test(v3[1] ?? ""));
}
console.log("build-screen docs (assets):");
{
  const irf = flat(read("claude-plugin/skills/build-screen/references/ir-fields.md"));
  const exl = flat(read("claude-plugin/skills/build-screen/references/export-layout.md"));
  const ext = flat(read("claude-plugin/skills/extract/SKILL.md"));
  const readme = flat(read("bridge/README.md"));
  const mcp = flat(read("bridge/src/figma-mcp.ts"));
  const hv = flat(read("claude-plugin/skills/audit-design/references/heuristics.md"));
  const ck = flat(read("claude-plugin/skills/audit-design/references/checklist.md"));
  check("ir-fields: assetSkipped \"hidden\" + assetFrom (the visible twin's file, still hidden:true)", /`assetSkipped`.{0,400}`"hidden"`/.test(irf) && /`assetFrom`/.test(irf) && /keeps `hidden:true`/.test(irf));
  check("ir-fields: sourceTransform is already drawn into the asset file — never rotate/flip again", /`sourceTransform`.{0,200}drawn into it\. Never rotate or flip/.test(irf) && /bare `rotation`\/`flipped` still applies on a `geometry` leaf/.test(irf));
  check("ir-fields: layout is absent on asset/geometry/assetSkipped leaves", /`layout` is absent on asset, `geometry` and `assetSkipped` leaves/.test(irf));
  check("extract manifest table: assetsHidden + hiddenNodes, and any geometry fallback warns", /\| `assetsHidden` \|/.test(ext) && /\| `hiddenNodes` \|/.test(ext) && /any fallback warns and names them/.test(ext));
  check("export-layout: .assets.json row fields and 'search owner/name, not file names'", ["name", "owner", "context", "usedBy", "usedByCount", "hiddenUses", "reuseKey", "componentKey", "paintOverrides"].every((k) => exl.includes("`" + k + "`")) && /[Ss]earch `owner`\/`name`, not file names/.test(exl));
  check("export-layout + SKILL: duplicates is a tolerant compare, not byte-identical", /±0\.01/.test(exl) && !/byte-identical/.test(skill) && /the same artwork under different names/.test(skill));
  check("heavy: embeddedRaster named in export-layout, SKILL and the audit heuristics", /`embeddedRaster`/.test(exl) && /`embeddedRaster`/.test(skill) && /`embeddedRaster`/.test(hv) && /`embeddedRaster`/.test(ck));
  check("audit docs: no spacing finding on icon/asset leaves", /never on an icon\/asset leaf/.test(hv) && /Don't flag spacing on an icon\/asset leaf/.test(ck));
  check("ir-fields + SKILL: an assetSkipped:\"hidden\" graphic is hidden itself or under a hidden ancestor (not \"is `hidden:true`\"); a hidden root warns",
    /`"hidden"`: the graphic is hidden itself or under a hidden ancestor/.test(irf) && !/the graphic is `hidden:true`, so the plugin/.test(irf) && /hidden itself or under a hidden\s+ancestor/.test(skill) && !/a `hidden:true` graphic with `assetSkipped:"hidden"`/.test(skill) && /A pulled ROOT that is hidden itself or under a hidden\s+ancestor gets a pull warning/.test(irf));
  check("export-layout + README: `reusedFrom` marks another screen's file a hidden node reuses", /`reusedFrom`/.test(exl) && /`reusedFrom`/.test(readme));
  check("the raster-shell wording carries the paths rule (export-layout, audit heuristics)", /`embeddedRaster` with under 50 `paths`/.test(exl) && /`embeddedRaster` with under 50 `<path>`s/.test(hv));
  // the counter is every node hidden itself or under a hidden ancestor.
  check("README: the hidden-node pull line says themselves or under a hidden ancestor, not \"kept as hidden:true\"",
    /N node\(s\) hidden \(themselves or under a hidden ancestor\) kept in the tree \(conditional UI\)/.test(readme) && !/kept as hidden:true/.test(readme));
  check("extract manifest table: hiddenNodes is not \"kept as `hidden:true`\"",
    /\| `hiddenNodes` \| nodes hidden themselves or under a hidden ancestor, kept in the tree/.test(ext) && !/nodes kept as `hidden:true`/.test(ext));
  check("README + export-layout: an embedded image's numbers (<use>/<image> transform, <pattern> x/y/width/height) compare relatively",
    [readme, exl].every((d) => /`<use>`\/`<image>`/.test(d) && /`<pattern>`'s\s+x\/y\/width\/height/.test(d) && /relatively, within 1 %/.test(d)));
  check("ir-fields: a hidden graphic's twin has the same variable modes", /same component and parent variants, same variable modes, size/.test(irf));
  check("[known misses] README limits: a stale sibling screen JSON (no component version), the title-cap fallback",
    /however old/.test(readme) && /no\s+component version/.test(readme) && /falls back to the first text/.test(readme) && /differ from the\s+title the pages index/.test(readme));
  check("[known misses] README limits: ancestor rotation/flip, pull-order dependence, one reuseKey per row, old-plugin warning",
    /not an\s+ancestor's/.test(readme) && /depends on pull order/.test(readme) && /one `reuseKey`/.test(readme) && /old plugin still loaded/.test(readme));
  check("list children: childCount + title on colliding rows + per-group warning (README and MCP tool)", /`childCount`/.test(readme) && /`title`/.test(readme) && /once per such group/.test(readme) && /childCount\/hasChildren/.test(mcp) && /share name \+ size also carry a `title`/.test(mcp));
  check("README: the pull summary lines (geometry warn, hidden info) are documented", /fell back to raw geometry/.test(readme) && /hidden graphic\(s\) not exported/.test(readme));
}

console.log("build-screen docs:");
{
  const rd = (rel: string): string => flat(read(rel));
  const docs = [rd("bridge/README.md"), skill, rd("claude-plugin/skills/extract/SKILL.md"), rd("claude-plugin/skills/help/SKILL.md")].join(" ");
  const src = (rel: string): string => read(rel);
  // Each new flag a doc mentions is registered in the script's own OPTIONS.
  const flags: ReadonlyArray<readonly [string, string, string]> = [
    ["--seed-from", "design-to-code/plan-skeleton.ts", '"seed-from"'],
    ["--lookup", "design-to-code/tokens.ts", "lookup:"],
    ["--check", "design-to-code/tokens.ts", "check:"],
    ["--map", "design-to-code/cross-check.ts", "map:"],
  ];
  for (const [flag, file, reg] of flags) check(`${flag} is documented and registered in ${file}`, docs.includes(flag + " ") && src(file).includes(reg));
  check("FIGMA_BRIDGE_PORT + positional outDir + per-verb --help are stated (README, help skill, extract)",
    ["bridge/README.md", "claude-plugin/skills/help/SKILL.md", "claude-plugin/skills/extract/SKILL.md"].every((f) => /FIGMA_BRIDGE_PORT/.test(rd(f)) && /positional/.test(rd(f))));
  check("the `done in` timing line and `dtwin serve` keeping the plugin connected are stated", /done in Xs|done in 12\.4s/.test(docs) && /`dtwin serve`.{0,200}(skip|connected)/.test(docs));
  check("troubleshooting explains `connected but sent nothing` and the fixed abandoned-reply bug", /connected but sent nothing/.test(rd("claude-plugin/skills/help/references/troubleshooting.md")) && /unique per bridge/.test(rd("claude-plugin/skills/help/references/troubleshooting.md")));
  check("variables.json scope sentence + tokens --lookup, in build-screen and extract", [skill, rd("claude-plugin/skills/extract/SKILL.md")].every((d) => /only (the )?variables bound by pulled nodes/.test(d) && /--lookup/.test(d)));
  check("build-screen: catalog by:\"ambiguous\", finding ids code@nodeId (legacy code#i), crossCheckFile", /by:"ambiguous"/.test(skill) && /`code@nodeId`/.test(skill) && /code#i/.test(skill) && /crossCheckFile/.test(skill));
  check("cross-check labels alreadyMapped / sharedWith documented", [skill, rd("claude-plugin/skills/extract/SKILL.md")].every((d) => /alreadyMapped/.test(d) && /sharedWith/.test(d)));
  check("every resolve-screen snippet passes design/plan", ["audit-design", "sync-design", "verify", "build-screen", "extract"].every((n) => {
    const t = rd(`claude-plugin/skills/${n}/SKILL.md`);
    const m = t.match(/resolve-screen\.js" <exportDir> "<[a-z-]+>"[^`]*/g) ?? [];
    return m.length > 0 && m.every((x) => /design\/plan/.test(x));
  }));
  check("MCP surface: 48,000-char inline cap, sourceFile, .prev, lastScreenExport/lastWrite, design_drift_lint `screens`", /48,000/.test(docs) && /sourceFile/.test(docs) && /\.json\.prev/.test(docs) && /lastScreenExport/.test(docs) && /lastWrite/.test(docs) && /design_drift_lint. takes `screens/.test(docs));
  check("visual-verifier: <Screen> is the <Layer>__<id> basename", /`<Screen>` below is always the `<Layer>__<id>` basename/.test(verifier));
  // a bare code is the id of a NODE-LESS finding only (it does not cover `missing-font@1:5`).
  check("build-screen: a bare code is accepted only for a finding with no node (its id), not as a catch-all",
    /for a finding with no node, is its bare\s+code \(which is its id\)/.test(skill) && !/a bare code are still accepted/.test(skill));
  // crossCheckFile is the cross-check report beside the audit (audit runs its own cross-check),
  // and `--lookup #ffbc1c` unquoted is a shell comment — the docs show the bare / quoted form.
  const audit = rd("claude-plugin/skills/audit-design/SKILL.md");
  check("crossCheckFile = the cross-check report beside the audit, when there is one (build-screen + audit-design)",
    [skill, audit].every((d) => /cross-check report beside the audit/.test(d) && /when there is one/.test(d)) &&
    !/the findings were merged from/.test(skill) && !/the cross-file half came from/.test(audit));
  const lookupDocs = [rd("bridge/README.md"), skill, rd("claude-plugin/skills/extract/SKILL.md"), src("design-to-code/tokens.ts")];
  check("no doc shows an unquoted `--lookup <#hex>` / `--lookup #…`, and each says the bare or quoted form",
    lookupDocs.every((d) => !/--lookup <#hex>|--lookup #/.test(d) && /ffbc1c/.test(d) && /'#ffbc1c'/.test(d)));
  // the .prev is kept only when the design differs — the export stamp alone does not count.
  check("README + extract + write-out say `.prev` ignores the exportedAt stamp; no 'bytes differ' wording",
    [rd("bridge/README.md"), rd("claude-plugin/skills/extract/SKILL.md"), src("bridge/src/write-out.ts")].every((d) => /(content differs|DIFFERENT design)[^.]{0,80}exportedAt/.test(d)) &&
    !/whose bytes\s+differ/.test(rd("bridge/README.md")) && !/with DIFFERENT bytes/.test(src("bridge/src/write-out.ts")));
  check("README + extract say usage errors in --check/--lookup are 2 and the parent directory tells two tokens.json apart",
    [rd("bridge/README.md"), rd("claude-plugin/skills/extract/SKILL.md")].every((d) => /usage errors?[^.]{0,40}\b2\b/.test(d) && /parent directory/.test(d)));
}
console.log("build-screen docs (quick keys + export docs):");
{
  const rd = (rel: string): string => flat(read(rel));
  const exists = (rel: string): boolean => fs.existsSync(path.join(root, rel));
  const irRaw = read("claude-plugin/skills/build-screen/references/ir-fields.md");
  const ext = rd("claude-plugin/skills/extract/SKILL.md");
  const help = rd("claude-plugin/skills/help/SKILL.md");
  const readme = rd("bridge/README.md");
  const norm = (t: string): string => t.replace(/\r\n/g, "\n").trim();
  // The mdFiles under claude-plugin/skills and agents, for the "no wrong key anywhere" guards.
  const mdUnder = (rel: string): string[] => {
    const dir = path.join(root, rel);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? mdUnder(path.join(rel, e.name)) : e.name.endsWith(".md") ? [path.join(rel, e.name)] : []);
  };
  const pluginDocs = [...mdUnder("claude-plugin/skills"), ...mdUnder("claude-plugin/agents")];
  // the marked block in ir-fields is the ONE QUICK_KEYS text and sits before the Contents.
  const m = /<!-- quick-keys:start[^>]*-->\r?\n([\s\S]*?)\r?\n<!-- quick-keys:end -->/.exec(irRaw);
  const block = m?.[1] ?? "";
  check("ir-fields.md carries QUICK_KEYS (bridge/src/quick-keys.ts) between the quick-keys markers", block !== "" && norm(block) === norm(QUICK_KEYS));
  check("the block sits before `## Contents`", m !== null && irRaw.indexOf("<!-- quick-keys:start") < irRaw.indexOf("## Contents") && irRaw.indexOf("<!-- quick-keys:end -->") < irRaw.indexOf("## Contents"));
  const qk = flat(block);
  check("the block states `text` not `characters`, box.w/h, index w/h, PAGE coordinates + the nearest-frame x/y rule",
    /`text`, not `characters`/.test(qk) && /`box\.w`\/`box\.h`/.test(qk) && /A single-screen index row repeats the size as `w`\/`h`/.test(qk) && /PAGE \(canvas\) coordinates/.test(qk) && /nearest frame \/ component \/ instance \/ section ancestor/.test(qk) && !/parent-relative/.test(qk));
  check("the block states absolute:true vs layout.mode, bottom → top order, hidden + ANY ANCESTOR + no `visible`, runs FIRST run, three strokes, I<…> ids",
    /`absolute:true`/.test(qk) && /layout\.mode:"absolute"/.test(qk) && /bottom → top/.test(qk) && /OR ANY ANCESTOR/.test(qk) && /no node-level `visible` key/.test(qk) && /FIRST\s+run's/.test(qk) && /Three `strokes`/.test(qk) && /`I<instance id>;<layer id>`/.test(qk));
  // statements the real exports contradicted — renderBox is not an outset (a TEXT's is usually
  // smaller), descendants of a hidden layer may carry their own flag, a SECTION is a position container, an inferred
  // flex frame's children still carry x/y, tokens.strokes may be a list.
  const irBody = flat(irRaw.slice(irRaw.indexOf("## Contents")));
  check("quick keys + ir-fields: renderBox = Figma's render bounds, larger with effects, a TEXT's usually smaller — never 'adds' extent",
    /`renderBox` \(only when it differs from `box`\) = Figma's render bounds: larger than `box` for shadow \/ stroke \/ blur; on a TEXT usually smaller than `box` \(observed\)/.test(qk) &&
    /on a TEXT usually smaller than `box` \(observed\)/.test(irBody) && ![qk, irBody].some((d) => /adds shadow \/ stroke \/ blur extent|`renderBox`\*\* — includes/.test(d)));
  check("hidden: descendants are not flagged on its account (they may carry their own); no node-level `visible` — quick keys and ir-fields",
    [qk, irBody].every((d) => /not flagged on its account \(they may carry their own\)/.test(d) && /no node-level `visible` key/.test(d) && !/descendants (carry no flag|carry none)/.test(d)));
  check("x/y: a section is a position container (quick keys + ir-fields); layout.inferred children still carry x/y; tokens.strokes may be a list",
    /instance \/ section ancestor/.test(irBody) && /`layout\.inferred:true` is a guess on a frame without auto layout — its children still carry `x`\/`y`/.test(qk) &&
    /`tokens\.strokes` is a variable name \(or a list\)/.test(qk));
  // X-01: fixedChildren = the LAST N of children[]; nothing may say first / leading N next to it.
  const x01Files = ["claude-plugin/skills/build-screen/references/ir-fields.md", ...["_template", "web-tailwind", "web-css-modules", "react-native", "swiftui", "flutter", "android-compose"].map((n) => `claude-plugin/skills/build-screen/profiles/${n}.md`), "figma-plugin/src/serialize.ts"];
  const firstN = "(?:first N\\b|first \\d+ children|leading (?:child|children)\\b|leading[^.]{0,30}pinned)";
  const x01Bad = x01Files.filter((f) => { const t = rd(f); return new RegExp(`fixedChildren[\\s\\S]{0,200}?${firstN}|${firstN}[\\s\\S]{0,200}?fixedChildren`).test(t); });
  check("no first-N / leading-children wording within 200 chars of fixedChildren in ir-fields, the 7 profiles, serialize.ts" + (x01Bad.length ? " (" + x01Bad.join(", ") + ")" : ""), x01Bad.length === 0);
  check("ir-fields and every profile say the LAST N of children[] and place each by y", /fixedChildren:N[^.]{0,40}LAST N entries of `children\[\]`/.test(flat(irRaw)) && x01Files.slice(1, 8).every((f) => /LAST N/.test(rd(f)) && /by its `y`/.test(rd(f))));
  // `layout` only on nodes that hold children, the "Older exports" sentence, fixedChildren x/y, collectionKey, distinctTexts.
  check("no doc says every TEXT carries `layout` (ir-fields, quick keys, build-screen SKILL) — only a node that can hold children has it",
    ![irBody, qk, skill].some((d) => /every TEXT carries it/.test(d)) && /only a node that can hold children has it/.test(qk) && /Only a node that can hold children has a `layout`/.test(irBody) && /only on nodes that hold children/.test(skill));
  const olderRe = /\*\*Older exports\.\*\*.*?\(design-diff does\)\./;
  check("the \"Older exports\" sentence (quick keys + ir-fields): gridColumnStart/RowStart:-1 on every node, gridAlignSelf/gridJustifySelf on a node whose parent is not a grid, layout on SLICE/STICKY and other leaf types",
    [qk, flat(block)].every((d) => {
      const s = olderRe.exec(d)?.[0] ?? "";
      return /`gridColumnStart:-1`/.test(s) && /`gridRowStart:-1`/.test(s) && /`gridAlignSelf`/.test(s) && /`gridJustifySelf`/.test(s) && /whose parent is not a grid/.test(s) && /SLICE, STICKY and other leaf type/.test(s);
    }) && !/Noise to ignore/.test(qk));
  check("fixedChildren = the LAST N, fixed only (\"sticky\" is not exposed), each pinned child carries x/y (quick keys + ir-fields)",
    [qk, irBody].every((d) => /`fixedChildren:N`(?:\*\* —| =) the LAST N entries of `children\[\]`/.test(d) && /"sticky" is not exposed/.test(d) && /[Ee]ach pinned child carries `x`\/`y`/.test(d) && /only an `absolute:true` child be fixed/.test(d)));
  check("ir-fields: the token catalog row has `collectionKey` (the collection's key; names repeat)",
    /`variables\[\] \{name, type, collection, collectionKey,/.test(irBody) && /`collectionKey` is the collection's own key \(collection NAMES repeat/.test(irBody));
  const syncSkill = flat(read("claude-plugin/skills/sync-design/SKILL.md"));
  check("sync-design: a \"differ only by the exporter's format\" warning after a plugin update is not a design change; re-run --expect/--compare once",
    /differ only by the exporter's format" after a plugin update is not a design change/.test(syncSkill) && /Re-run `verify-screen --expect` \/ `--compare` once/.test(syncSkill));
  const readme21 = flat(read("bridge/README.md"));
  const extract21 = flat(read("claude-plugin/skills/extract/SKILL.md"));
  const verbs21 = read("bridge/src/verbs.ts");
  const mcp21 = read("bridge/src/figma-mcp.ts");
  const mcpAt = mcp21.indexOf('"figma_list_children",');
  const mcpDesc = mcpAt < 0 ? "" : mcp21.slice(mcpAt, mcp21.indexOf("inputSchema", mcpAt));
  check("list children docs (README, extract, verbs help, the MCP description) name `distinctTexts` — up to 3 texts a row shows and its twins do not",
    [readme21, extract21].every((d) => /`distinctTexts` \(up to 3 texts that row shows and its twins do not\)/.test(d)) &&
    /`distinctTexts` \(up to 3 texts the row shows and its/.test(verbs21) && /`distinctTexts` \(up to 3 texts that row shows and its twins do not;/.test(mcpDesc));
  check("…and the listing's read budget: a very large listing skips it with a warning (README, extract, verbs help, MCP description)",
    /budget of 20000 node reads for the whole listing/.test(readme21) && /node-read budget runs out/.test(extract21) && /skipped, with a warning, past the listing's read budget/.test(verbs21) && /a very large listing skips it with a warning/.test(mcpDesc));
  // X-02: `scroll` is a node field, never `layout.scroll`.
  const x02Bad = pluginDocs.filter((f) => /layout\.scroll/.test(read(f)));
  check("no plugin skill/agent doc says `layout.scroll`" + (x02Bad.length ? " (" + x02Bad.join(", ") + ")" : ""), pluginDocs.length > 20 && x02Bad.length === 0);
  // corrections outside the block
  const ir = flat(irRaw);
  check("ir-fields Text: with runs[] `font` holds the FIRST run's values; \"mixed\" only when Figma could not split into runs",
    /`font\.size`\*\* px\. With `runs\[\]`[^.]{0,60}`font` holds the FIRST run's values/.test(ir) && /`"mixed"` appears only when Figma could not split/.test(ir) && !/\(or `"mixed"` → read `runs`\)/.test(ir));
  check("ir-fields tokens example: a single bound paint is a string, a list only when several paints are bound",
    /fills:"color\/surface"/.test(ir) && !/fills:\["color\/surface"\]/.test(ir) && /a string, a list only when\s+several paints are bound/.test(ir));
  check("[ir-fields] hidden sits on the layer switched off (descendants not flagged on its account); box x/y presence rule + group container rule; children[] order line",
    /sits on the layer that was switched off itself/.test(ir) && /present only where the parent does not lay the node out/.test(ir) && /skips GROUP and boolean-operation parents/.test(ir) && /\*\*`children\[\]`\*\* is Figma's layer order, normally bottom → top/.test(ir));
  // one wording — a consuming file's --design-system is not the library's catalog.
  check("extract theme input 1 is libraries/<slug>/tokens.json (--as-library) for CONSUMING screens; design-system/tokens.json only from the DEFINING file",
    /1\. `design\/export\/libraries\/<slug>\/tokens\.json` \(from `--as-library`\) when the screens CONSUME a library/.test(ext) && /pulled from the file that DEFINES\s+the tokens/.test(ext) && !/it is the library's own definition of every token/.test(ext));
  const mcpSrc = read("bridge/src/figma-mcp.ts");
  check("README, help, extract and the MCP description: --design-system on a consuming file is that file's own tokens + referenced library variables, never the catalog; no 'fewer of them than a full pull would'",
    [readme, help, ext].every((d) => /CONSUMES a library/.test(d) && /--as-library/.test(d) && /never the library's catalog/.test(d)) && ![readme, help, ext, flat(mcpSrc)].some((d) => /fewer of them than a full pull would/.test(d)));
  // use what is set up; the MCP first calls
  check("help: 'use what is already set up' (no unconditional manual default) + the MCP first calls in order with writeToDisk:true",
    /\*\*Use what is already set up\.\*\*/.test(help) && !/Default to manual export for a brand-new user/.test(help) && /`figma_status`[^.]{0,120}→ `figma_list_pages \{depth:1\}` → `figma_list_children[^→]*→[^→]*→ `figma_export_url \{url:"<node id>",\s*writeToDisk:true\}`/.test(help));
  check("extract: the MCP order ends in figma_export_url for one screen, figma_export_full only for a whole page, list_libraries out of the default",
    /`figma_status`[\s\S]{0,300}→[\s\S]{0,300}`figma_export_url \{url:"<node id>",\s*writeToDisk:true\}` for one screen/.test(ext) && /`figma_export_full\(\{page:\[id\]\}\)` is for a whole page only/.test(ext) && /`figma_list_libraries` stays out of the default sequence/.test(ext));
  // list libraries timing (docs; the verbs.ts help and the figma-mcp.ts description are checked in cli-help)
  const timing = [["extract", ext], ["help", help], ["README", readme]] as const;
  const timingBad = timing.filter(([, d]) => /5[-–]15\s?s/.test(d) || !/~15 s[^.]{0,80}about 2 s on a file with no libraries enabled/.test(d)).map(([n]) => n);
  check("extract, help and README say list libraries takes a few seconds up to ~15 s (about 2 s with no libraries enabled), never a bare '5-15s'" + (timingBad.length ? " (" + timingBad.join(", ") + ")" : ""), timingBad.length === 0);
  // list libraries is a side step everywhere (never "before any pull" / "the step before
  // that" / "intended order is listLibraries →"), and its per-collection reads are one call each, not "one at a time".
  const arch = rd("ARCHITECTURE.md"), testing = rd("TESTING.md");
  const libFirst = ([["README", readme], ["ARCHITECTURE", arch], ["TESTING", testing], ["extract", ext], ["help", help]] as const)
    .filter(([, d]) => /is the step \*before\* that|intended order is `listLibraries`|dtwin list libraries\s+# 1\.|then scope by library|Before any pull, run `node bridge\/src\/figma-pull\.ts --list-libraries`|\(do this first\)/.test(d)).map(([n]) => n);
  check("README, ARCHITECTURE, TESTING, extract, help: list libraries is never the default first step" + (libFirst.length ? " (" + libFirst.join(", ") + ")" : ""),
    libFirst.length === 0 && /`figma_list_libraries` \(optional `client`, like every Figma tool\) is a side step/.test(readme) && /`listLibraries` is a side step, never the default first one/.test(arch) && /Not a default first step/.test(testing));
  const oneAtATime = ([["README", readme], ["extract", ext], ["help", help]] as const).filter(([, d]) => /variable collections one at a time|collections one at a time/.test(d)).map(([n]) => n);
  check("README, extract, help: one Figma call per enabled library collection, never \"one at a time\"" + (oneAtATime.length ? " (" + oneAtATime.join(", ") + ")" : ""),
    oneAtATime.length === 0 && [readme, ext, help].every((d) => /one Figma call per enabled library (variable )?collection/.test(d)));
  // the offline counts are carried (not opened with), absent when nothing is in the flagged collections, name-based.
  check("extract: the message carries the Offline check (no 'opens with'); counts absent → nameMap all zero; counts are name-based",
    /The message carries "Offline check/.test(ext) && !/The message opens with "Offline check/.test(ext) && /the counts are absent, and `nameMap` all zero/.test(ext) && /go by collection and variable NAME, not key/.test(ext));
  // SCHEMA.md is listed where files are found; help echoes the registration-prefix caveat.
  const exportLayout = rd("claude-plugin/skills/build-screen/references/export-layout.md");
  check("export-layout.md and ARCHITECTURE.md list SCHEMA.md; help says another registration key changes the prefix",
    /`design\/export\/SCHEMA\.md` holds the scripting quick keys/.test(exportLayout) && /SCHEMA\.md \(scripting quick keys\)/.test(arch) && /under another registration key the prefix differs/.test(help));
  // The extract index paragraph — a page-walk row carries `bytes` and `nodes` (a single-screen row has `nodes` too), no w/h.
  check("extract index paragraph: a page-walk row carries `bytes` (and `nodes`) but no `w`/`h`; no \"paths to all three sibling files\"",
    /a page-walk row \(`--page`, `--all-pages`, a bare `dtwin pull`\) carries `bytes` \(and `nodes`\) but no `w`\/`h`; its `reference` sits in the layer file/.test(ext) &&
    !/paths to all\s+three sibling files/.test(ext) && !/carries `nodes`\/`bytes` instead/.test(ext));
  check("extract names --variant-visuals and variantVisuals (design-system pulls to build from; the library's pull needs it)", /--variant-visuals/.test(ext) && /`variantVisuals: true`/.test(ext) && /`--as-library` pull/.test(ext));
  check("extract: a design-system export takes ~15–40 s and reports progress only to clients that send a progress token", /~15–40 s on a real file/.test(ext) && /progress\s+token/.test(ext));
  check("extract: list children gives childCount + title on rows sharing name+size; no 'returns only name/id/type/size'", /`list children` gives every row a `childCount`/.test(ext) && /share name \+ size a `title`/.test(ext) && !/returns only name\/id\/type\/size/.test(ext));
  check("extract and build-screen: read the foreign-token-library offline counts (nameMap, D = 0 → map by name) before the live list-libraries step",
    [ext, skill].every((d) => /Offline check \(no Figma needed\)/.test(d) && /nameMap/.test(d) && /D = 0/.test(d) && /(only for finding|only to find) the owning file|is only for finding the owning file/.test(d)));
  // which source wins
  const rule = (d: string): boolean => /\*\*Values come from the export JSON/.test(d) && /designer question/.test(d) && /never change the build to match the PNG/i.test(d);
  check("visual-verifier, references/verify.md and the verify skill: values come from the export JSON, a PNG disagreement is a designer question", rule(verifier) && rule(verifyRef) && rule(verifySkill));
  // …placed AFTER the grainy-illustration text, which belongs to the downscale rule: spliced between them, "the usual
  // instance" / "the common case of this" would point at the values rule and the two rules would contradict each other.
  const placed = (d: string): boolean => {
    const dn = d.search(/reference is downscaled/i);
    if (dn < 0) return false;
    const after = d.slice(dn);
    const gr = after.search(/grainy|speckled/i);
    const va = after.search(/\*\*Values come from the export JSON/);
    return gr >= 0 && gr < 900 && va > gr;
  };
  check("visual-verifier and references/verify.md: the grainy-illustration text follows the downscale rule directly; the values rule comes after it", placed(verifier) && placed(verifyRef));
  // Pointers: every script-writing reader is sent to design/export/SCHEMA.md
  const schemaNamed = [["extract", ext], ["build-screen", skill], ["screen-builder", builder], ["visual-verifier", verifier], ["audit-design", rd("claude-plugin/skills/audit-design/SKILL.md")]].filter(([, d]) => !/design\/export\/SCHEMA\.md/.test(d ?? "")).map(([n]) => n);
  check("extract, build-screen, screen-builder, visual-verifier and audit-design name design/export/SCHEMA.md" + (schemaNamed.length ? " (missing: " + schemaNamed.join(", ") + ")" : ""), schemaNamed.length === 0);
  check("SCHEMA.md is listed in help's table, extract 'What lands' and README's layout block, and is 'rewritten only when its text changes'",
    /\| every pull that writes to disk \| `SCHEMA\.md`/.test(help) && /Every pull that writes to disk also leaves \*\*`design\/export\/SCHEMA\.md`\*\*/.test(ext) && /SCHEMA\.md\s+scripting quick keys/.test(readme) && [help, ext, readme].every((d) => /[Rr]ewritten only when its text changes/.test(d)) && exists("bridge/src/quick-keys.ts"));
}

// native-control substitution, tailwind-merge, this screen's assets only,
// body cells set the columns, dev-only tags, the anchors worth filling first
console.log("build-screen docs:");
{
  const date = (d: string): boolean => /`::placeholder` never applies to `<input type="date">`/.test(d) && /`::-webkit-datetime-edit`/.test(d)
    && /Chromium\/WebKit, non-standard — check in the browser/.test(d) && /Firefox:.{0,120}check it in the browser/.test(d)
    && /`color-scheme`.{0,80}usually matches/.test(d) && /`select:invalid`/.test(d)
    // a disabled first option is skipped by the selectedness algorithm, so it must be `selected`
    // (React: defaultValue="" / value=""), else the first enabled option is chosen and the placeholder never shows
    && /`<option value="">` on a `required` select \(the spec's placeholder label option\)/.test(d)
    && /If you make it `disabled hidden`, also mark it `selected`/.test(d) && /`defaultValue=""` or a controlled `value=""`/.test(d)
    && /the first enabled option is selected, the field is valid, and the placeholder never shows/.test(d);
  check("both web profiles: ::placeholder does not apply to a date input; ::-webkit-datetime-edit is labelled Chromium/WebKit non-standard, Firefox hedged, color-scheme `usually`; a select placeholder is `selected` / defaultValue=\"\"", date(tw) && date(cssm));
  check("SKILL: a drawn field that becomes a native control carries the drawn colour onto it, is recorded in the plan and verified on the element's own text",
    /Native control substitution/.test(skill) && /carry the drawn placeholder\/value colour onto it/.test(skill) && /record the\s+substitution in the plan/.test(skill) && /verify it on the element's own text/.test(skill));
  check("web-tailwind: tailwind-merge for a caller's className, the sizes registered with extendTailwindMerge, colour+size drops one of the two, size-vs-size not merged unregistered",
    /`tailwind-merge`/.test(tw) && /extendTailwindMerge\(\{ extend: \{ theme: \{ text: \[/.test(tw) && /colour plus a size drops one of the two/.test(tw) && /not merged/.test(tw));
  check("SKILL: use only files THIS screen's .assets.json lists; another screen's file is never a substitute; a node with no file is a question",
    /Use only files THIS screen's `\.assets\.json` lists/.test(skill) && /never substitute it/.test(skill) && /extract\/designer question, not a reuse/.test(skill));
  check("both web profiles: column x/widths come from the BODY cells; a header/body x disagreement is a designer question",
    [tw, cssm].every((d) => /column x\/widths from the BODY cells/.test(d) && /designer question/.test(d)));
  check("SKILL: tags are dev evidence, stripped at build time; Next.js needs properties: ['^data-dt-node$'] (plain `true` strips only ^data-test), never in the source",
    /\{ properties: \['\^data-dt-node\$'\] \}/.test(skill) && /plain `true` strips only\s+`\^data-test`/.test(skill) && /Never strip them in the source/.test(skill));
  // an unconditional (or NODE_ENV-keyed) strip removes the tags from the preview build verify measures
  check("SKILL: the strip is an explicit opt-in env set only by the deploy build, never NODE_ENV; verify measures a build that keeps the tags",
    /reactRemoveProperties: process\.env\.DT_STRIP_TAGS === '1' \? \{ properties: \['\^data-dt-node\$'\] \} : false/.test(skill)
    && /only on an explicit opt-in env that the deploy build alone sets/.test(skill) && /Babel the same way/.test(skill)
    && /Never key it on `NODE_ENV`/.test(skill) && /verify measures a build that keeps the tags/.test(skill)
    && !/reactRemoveProperties: \{ properties/.test(skill));
  check("SKILL: anchorsSuggested is named in the plan-skeleton paragraph and step 3 says to fill those ids first, the rest covered by the nearest mapped ancestor",
    /`anchorsSuggested\[\]`/.test(skill) && /the `anchorsSuggested` ids first, the rest is covered by its nearest mapped ancestor/.test(skill));
  // the frame has no ancestor to cover it, so the plan suggests it and step 3 names it
  check("SKILL: anchorsSuggested starts with the screen frame (\"screen\"; an instance frame is the whole list) and step 3 fills the frame itself plus the suggested ids",
    /the screen frame itself, first, as `"screen"` — a frame that is an instance is the whole list/.test(skill)
    && /step 3: the frame itself plus the `anchorsSuggested` ids first/.test(skill) && /the dividers between its rows go with it/.test(skill));
  // a named field for the substitution, a native line in every native profile, reusedFrom allowed
  const natives = ["swiftui", "android-compose", "flutter", "react-native"].map((n) => flat(read(`claude-plugin/skills/build-screen/profiles/${n}.md`)));
  check("SKILL + both web profiles: the native-control substitution is a deviations[] row {nodeId, field: \"control\", designed, built, reason}",
    [skill, tw, cssm].every((d) => /`deviations\[\]` row `\{nodeId, field: "control", designed, built, reason\}`/.test(d)));
  check("SwiftUI, Compose, Flutter and React Native profiles: set the picker's text colour explicitly",
    natives.every((d) => /set the picker's text colour explicitly/.test(d)));
  check("SKILL: a `reusedFrom` row is listed in this screen's .assets.json, so the this-screen-only rule allows it",
    /never substitute it \(a row with `reusedFrom` is listed here, so it is fine\)/.test(skill));
  // the tailwind-merge major per Tailwind major, ask before adding it, every figma- namespace registered
  check("web-tailwind: tailwind-merge v3 is for Tailwind v4, v2.6 (classGroups font-size) for Tailwind v3; the project's cn first, ask before adding",
    /tailwind-merge v3 is for Tailwind v4; on Tailwind v3 use v2\.6/.test(tw) && /`classGroups: \{ 'font-size': \[\.\.\.\] \}`/.test(tw)
    && /Use the project's existing `cn` if it has one; ask before adding `tailwind-merge`\/`clsx`/.test(tw));
  check("web-tailwind: text, spacing and radius are all registered for the generated figma- namespaces",
    /theme: \{ text: \['figma-body-1', …\], spacing: \['figma-space-4', …\], radius: \['figma-md', …\] \}/.test(tw) && /`p-figma-space-4` against `p-figma-space-6`/.test(tw));
  check("SKILL: the this-screen-only asset rule is about the EXPORTED files, so reusing a matching project icon still reads as allowed",
    /Reuse a project icon only if the glyph clearly matches/.test(skill) && /Of the exported files, import only those listed in THIS screen's `\.assets\.json`/.test(skill) && !/ Import only files listed in THIS screen's/.test(skill));
  check("web-tailwind: the registered sizes drop the --text- prefix (text: ['figma-body-1', …], like tailwind-merge's text: ['huge'])",
    /theme: \{ text: \['figma-body-1', …\]/.test(tw) && /names without its prefix \(`--text-`/.test(tw) && /`text: \['huge'\]`/.test(tw));
  check("SKILL: a list is a container whose children are MOSTLY one shape; its other children (a search bar) are listed on their own",
    /children are mostly rows of one shape — three or more/.test(skill) && /a search bar above the rows, are listed on their own/.test(skill));
}

// scratch location, hover/press evidence, the report's own delta text, states placement
//, whose hover, inferred rows, --record-plan, illustrative reference,
// line-height vs the text box, the replaced expectation's .prev, --browser-path
console.log("build-screen docs:");
{
  const helpSkill = flat(read("claude-plugin/skills/help/SKILL.md"));
  check("visual-verifier: scratch scripts go in the run cache's scratch dir (project-local), never under src/ or design/",
    /`node_modules\/\.cache\/designtwin-verify\/scratch\/` \(project-local/.test(verifier) && /never under `src\/` or `design\/`/.test(verifier));
  check("visual-verifier: hover/press feedback is read as background, colour, filter, opacity, box-shadow, transform and outline (readable by getComputedStyle, not part of the effective-paint check) before 'no change'",
    /read\s+background, colour, `filter`, `opacity`, `box-shadow`, `transform` and `outline`/.test(verifier) && /readable with `getComputedStyle`/.test(verifier)
    && /effective-paint check \(`paintedBy`\) covers `backgroundColor` only/.test(verifier));
  check("visual-verifier and verify skill: drawnStateFrom = hover the OWNER, not the control; paintedBy = the painting ancestor's colour for a transparent element",
    [verifier, verifySkill].every((d) => /`drawnStateFrom`/.test(d) && /hover(s)? (that )?owner|hover the owner/i.test(d) && /`paintedBy`/.test(d)));
  check("visual-verifier and verify skill: states sit beside styles (nodes[].states), never inside; a state on a spec with no drawnState is listed as inferred, not compared",
    [verifier, verifySkill].every((d) => /beside(\*\*)? `styles`/.test(d) && /never inside it/.test(d) && /unknown key/.test(d)) && /only for a spec with `drawnState`/.test(verifier) && /Inferred, not designed/.test(verifier));
  check("visual-verifier and verify skill: inferred[] rows {nodeId?, state, built, why?} in the evidence file; listed under 'Inferred, not designed', never graded, never the verdict",
    [verifier, verifySkill].every((d) => /`inferred\[\]`/.test(d) && /\{"?nodeId"?\??, "?state"?, "?built"?, "?why"?\??\}/.test(d) && /Inferred, not designed/.test(d)) && /never part of the verdict/.test(verifier) && /never graded and never in the verdict/.test(verifySkill));
  check("visual-verifier and verify skill: quote the report's own delta text (it names the axis/dimension), never restate a bound",
    [verifier, verifySkill].every((d) => /Quote the report's own delta text — it names the axis or dimension — and never restate a bound/.test(d)));
  check("verify skill, build-screen and references/verify.md: --record-plan writes mode/renderer/artifacts/deltas/a11y/recorded; coverage stays hand-written; no 'Record the result by hand'",
    /--record-plan/.test(verifySkill) && /--compare … --record-plan/.test(skill) && /--record-plan/.test(verifyRef) && !/Record the result by hand/.test(verifySkill)
    && /`mode`, `renderer`, `artifacts`, the open high\/medium `deltas`/.test(verifySkill) && /you still write `coverage`/.test(skill) && /\(yours to write\)/.test(verifyRef)
    && /none, or several and no `--plan`, is exit 2 before anything is compared/.test(verifySkill));
  check("build-screen and references/verify.md: record the deviations you already know about at build time, with a reason",
    /record a deviation you already know about when you build it, with its reason/.test(skill) && /Record the differences you already know about as `deviations\[\]` \(with a reason\) when you build them/.test(verifyRef));
  check("verify skill and build-screen: a deviations[] row with field \"reference\" marks the reference illustrative; it never waives a delta",
    /field: "reference"/.test(verifySkill) && /never waives or changes a delta/.test(verifySkill) && /field: "reference"/.test(skill) && /without\s+waiving a delta/.test(skill));
  check("build-screen: a line-height taller than its fixed text box is a deliberate choice (the expectation's 'text box height' row)",
    /line-height taller than its fixed text box.{0,160}choose deliberately/.test(skill) && /line-height taller than its fixed text box is a choice to make deliberately/.test(verifyRef));
  check("verify skill: a replaced expectation keeps <Screen>.expected.prev.json (one generation) and says generator vs export; byte-identical says nothing about the build",
    /<Screen>\.expected\.prev\.json/.test(verifySkill) && /one generation/.test(verifySkill) && /expectation generator changed/.test(verifySkill) && /Byte-identical to the expectation on disk" says nothing about the build/.test(verifySkill));
  check("help, verify skill and visual-verifier: --browser-path <executable> (macOS inner binary, only guaranteed with the bundled Chromium; recorded as custom, never the path)",
    [helpSkill, verifySkill, verifier].every((d) => /--browser-path <executable>/.test(d) && /Contents\/MacOS/.test(d) && /only guaranteed with the bundled Chromium/.test(d)) && /`custom`, never the path/.test(verifySkill));
  const trouble = flat(read("claude-plugin/skills/help/references/troubleshooting.md"));
  check("troubleshooting: the probe's exit 3 (no usable browser) → --browser-path <executable> (also on --check; macOS inner binary; only guaranteed with the bundled Chromium; recorded as custom)",
    /`verify-probe` exits 3/.test(trouble) && /--browser-path <executable>/.test(trouble) && /also on `--check`/.test(trouble) && /Contents\/MacOS/.test(trouble)
    && /Only guaranteed with the bundled Chromium/.test(trouble) && /records `custom`, never the path/.test(trouble));
  check("verify skill: recording never reopens a plan — a hook record from before the hash change is re-stamped in the same write",
    /recording never reopens a plan \(the hook's hash does not cover `verification`; a hook record from before that change is re-stamped in the same write\)/.test(verifySkill));
  check("build-screen: the hook hashes files[] and every mapped module (extensionless resolves like an import; an alias or package is not hashed — --status and the report name it once)",
    /and of every module the plan's anchors\/components map/.test(skill) && /resolves like an import, `\.tsx`\/`\.ts`\/`\.jsx`\/`\.js` then `\/index\.\*`/.test(skill) && /`--status` and the verify report name it once/.test(skill));
  check("verify skill: paintedBy's known miss — a sibling/overlay painting over the element may pass; children painting all of it → no painter",
    /A sibling or overlay painting over the element is not seen \(it may pass\)/.test(verifySkill) && /its own children paint all over gets no painter/.test(verifySkill));
  const readme20 = flat(read("bridge/README.md"));
  const help20 = flat(read("claude-plugin/skills/help/SKILL.md"));
  const extract20 = flat(read("claude-plugin/skills/extract/SKILL.md"));
  const audit20 = flat(read("claude-plugin/skills/audit-design/SKILL.md"));
  check("README + help: an owning MCP server exits when its client goes away, unless its socket was used, then idles out on FIGMA_DAEMON_IDLE_MIN",
    [readme20, help20].every((d) => /exits when its client goes away/.test(d) && /FIGMA_DAEMON_IDLE_MIN/.test(d) && /unless another process has used/.test(d)));
  // Narrowed to what write-out keeps — a screen spill ONLY <screen>.json.prev (its sidecars, the index and
  // variables.json are replaced with no copy), and no MCP tool pulls a library, so there is no "library spill".
  check("extract + README: the implicit page/full/design-system spill keeps a .prev per changed JSON (wrote.prevKept); a screen spill ONLY <screen>.json.prev (wrote.prev) — sidecars replaced with no copy; no library spill",
    [readme20, extract20].every((d) => /page\/full\/design-system spill/.test(d) && !/library spill/.test(d) && /prevKept/.test(d)
      && /screen spill( \([^)]*\))? keeps ONLY `<screen>\.json\.prev` \(`wrote\.prev`/.test(d) && /replaced with no copy/.test(d)));
  // No doc tells you to pull into bare `design` — that is the outDir trap (a second export tree beside
  // design/export/ that doctor, cross-check, audit and build-screen never read). `dtwin pull` defaults to design/export.
  {
    const trapDocs = ["bridge/README.md", "claude-plugin/skills/help/SKILL.md", "claude-plugin/skills/extract/SKILL.md", "ARCHITECTURE.md", "README.md"];
    // A command line or inline-code span: `dtwin design …`, `dtwin pull design …`, `figma-pull.ts design …` — the trap
    // is named only in a sentence that says never to (e.g. "never `dtwin pull design …`").
    const trap = /(?:dtwin|figma-pull\.ts)(?: pull)? \.?\/?design(?:\/)?(?=[\s`"']|$)/;
    const bad = trapDocs.flatMap((f) => read(f).split("\n").map((l, i) => [f + ":" + (i + 1), l] as const))
      .filter(([, l]) => trap.test(l) && !/\bnever\b|\btrap\b|parallel/i.test(l)).map(([w]) => w);
    check("README, help, extract, ARCHITECTURE: no doc tells you to pull into bare `design` (the default is design/export)" + (bad.length ? " (" + bad.join(", ") + ")" : ""),
      bad.length === 0 && /defaults to `design\/export`/.test(help20) && /defaults to `design\/export`/.test(extract20) && /Never pull into bare `design`/.test(readme20));
  }
  // A held port — the CLI exits with EADDRINUSE; an MCP server stays up and only that call errors (retry).
  check("README + help: on a held port an MCP tool call errors and a retry works — the server never exits with EADDRINUSE",
    [readme20, help20].every((d) => /stays up/.test(d) && /retry/.test(d) && !/an MCP server\s+or second pull started while it runs exits/.test(d) && !/anything else that needs the port exits/.test(d)));
  check("README: the MCP tool list names all 15 tools",
    ["figma_status", "figma_list_clients", "figma_whoami", "figma_get_selection", "figma_list_libraries", "figma_list_pages", "figma_list_children", "figma_export_full",
      "figma_export_design_system", "figma_export_selection", "figma_export_url", "figma_screenshot", "figma_write", "design_get_component", "design_drift_lint"]
      .every((t) => readme20.includes("`" + t + "`")) && /Tools \(15\):/.test(readme20));
  check("build-screen + audit-design: the legacy code#i id is accepted with a warning",
    [skill, audit20].every((d) => /`code#i` is still accepted,? \(?with a warning/.test(d)));
  check("README + extract: outDir is checked before the export", [readme20, extract20].every((d) => /before the export/.test(d)));
}

{
  // The verify skill's --steps rule, the verifier's own scripts, a run that ended, the audit refusal.
  console.log("verify / audit-design docs (live-check fixes):");
  const auditSkill = flat(read("claude-plugin/skills/audit-design/SKILL.md"));
  check("verify skill: --steps <plan> only when the plan has a `navigate` list (none is exit 2), never 'whenever it has one'",
    /only when (the plan|it) has a `navigate` list/.test(verifySkill) && /holds no `navigate` list/.test(verifySkill) && !/whenever it has one/.test(verifySkill));
  check("verify skill: allow rules for the verifier's own scratch scripts (Edit on the run cache — never a dead Write(path) rule — Bash node on scratch), written with the Write tool not a heredoc",
    !/`Write\(node_modules/.test(verifySkill) && /Edit\(node_modules\/\.cache\/designtwin-verify\/\*\*\)/.test(verifySkill)
    && /Bash\(node node_modules\/\.cache\/designtwin-verify\/scratch\/\*\)/.test(verifySkill) && /Write tool, never a shell heredoc/.test(verifySkill));
  check("verifier: scratch scripts are written with the Write tool, not a heredoc; the Edit rule (which covers the Write tool) is named in the denial hand-back, never a Write(path) rule",
    /Write tool.{0,40}never a shell heredoc/.test(verifier) && (verifier.match(/Edit\(node_modules\/\.cache\/designtwin-verify\/\*\*\)/g) ?? []).length >= 2 && !/`Write\(node_modules/.test(verifier));
  check("verify skill: a `blocked` hand-back is reported with its detail and never overwritten with `done`; a retry is a new run (--new-run)",
    /hands back `blocked`.{0,600}never write `done` over/.test(verifySkill) && /status detail|prints it/.test(verifySkill) && /start a new run with `--new-run`/.test(verifySkill));
  check("one NEW run id per verifier pass / re-verify round (an ended id is refused; --wait on it returns at once): build-screen, verify skill, verifier",
    /every verifier pass \(each re-verify round\) gets a NEW run/.test(skill) && /each verifier pass and each re-verify round gets its own new run id/.test(verifySkill)
    && /A run id is good for ONE pass/.test(verifier));
  check("verifier: an ended run takes no more writes; blocked stays blocked, the orchestrator reports it, a retry is --new-run",
    /ended .{0,40}takes no more writes/.test(verifier) && /stays `blocked`.{0,200}never overwrites it with `done`/.test(verifier) && /starts a new run with `--new-run`/.test(verifier)
    && !/after `done`\/`failed`\/`blocked` pass `--run <id>` or `--new-run`/.test(verifier));
  check("audit-design: the one-report-per-node refusal is explained — use the existing name (as --out) or --force and retire the old pair",
    /If it refuses.{0,200}already has an audit report/.test(auditSkill) && /pass it as `--out`/.test(auditSkill) && /`--force`.{0,200}retire the old pair/.test(auditSkill));
  check("audit-design: the cross-check command carries --out (a bare run only prints), with the <Screen>__<id>.cross form the plan's crossCheckFile points at",
    /cross-check\.js" --design-system design\/export\/design-system \\? ?--out design\/audit\/<name>\.cross/.test(auditSkill) && /--out design\/audit\/<Screen>__<id>\.cross/.test(auditSkill) && /Without `--out` the cross-check report only prints/.test(auditSkill));
}

report();
