// Doc-guards for the build-screen skill, its web profiles and the screen-builder agent (field-test group 6).
//   node test/build-screen-docs.test.ts
// Each check asserts one rule is STATED in the text a builder reads; the map-status list is also
// compared with the validator's own source so the doc and the code cannot drift apart.
import fs from "node:fs";
import path from "node:path";
import { check, report } from "./assert.ts";
import { PASSING_VERDICTS } from "../design-to-code/plan-waivers.ts";

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
report();
