// test/session-claim.test.ts — which plans the stopping agent claimed (design-to-code/session-claim.ts): the verdict
// sessionClaim() returns for a hook payload over a synthetic transcript (JSONL, one entry per line as Claude Code writes
// it) and the open / closed / unreadable plans under design/plan/ — unscoped, claimed (+ the unreadable plans it wrote),
// or none (+ whether a screen-builder is sent back). How verify-build renders each verdict is test/verify-build.test.ts's.
// Run with:  bun test/session-claim.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NO_CLAIM_MARK, sessionClaim } from "../design-to-code/session-claim.ts";
import type { HookPayload } from "../design-to-code/hook-input.ts";
import type { BadPlan, PlanFile } from "../design-to-code/node-artefacts.ts";
import { check, report } from "./assert.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-claim-"));
let cases = 0;

// A transcript line as Claude Code writes it: tool calls are message.content[] tool_use items; `cwd` is the entry's own.
const toolUse = (name: string, input: object, o: { sidechain?: boolean; cwd?: string } = {}): string =>
  JSON.stringify({ type: "assistant", isSidechain: o.sidechain ?? false, ...(o.cwd ? { cwd: o.cwd } : {}), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_x", name, input }] } });
const toolResult = (text: string): string => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content: text }] } });
const text = (role: "user" | "assistant", body: string, sidechain = false): string =>
  JSON.stringify({ type: role, isSidechain: sidechain, message: { role, content: role === "user" ? body : [{ type: "text", text: body }] } });
const write = (file: string): string => toolUse("Write", { file_path: file, content: "{}" });
const edit = (file: string): string => toolUse("Edit", { file_path: file, old_string: "a", new_string: "b" });
const bash = (command: string): string => toolUse("Bash", { command });

type Payload = (transcript: string, root: string) => HookPayload;
/** the main session's Stop (the skill-scoped hook) */
const STOP: Payload = (t, root) => ({ hook_event_name: "Stop", cwd: root, transcript_path: t });
/** a screen-builder's SubagentStop: its own transcript, beside the session's */
const builder = (agent_type = "designtwin:screen-builder"): Payload => (t, root) =>
  ({ hook_event_name: "SubagentStop", cwd: root, agent_id: "b1", agent_type, agent_transcript_path: t, transcript_path: path.join(root, "main.jsonl") });

interface Setup {
  /** open plans: path (project-relative, or absolute) → files[] */
  open?: Record<string, string[]>;
  /** readable plans the hook has no work on (closed) */
  closed?: Record<string, string[]>;
  /** unreadable plans: path → the raw text on disk */
  bad?: Record<string, string>;
  payload?: Payload;
}
/** Two open plans: login alone lists src/OnlyX.tsx; both list src/Shared.tsx. */
const TWO = { "design/plan/login.json": ["a.tsx", "src/OnlyX.tsx", "src/Shared.tsx"], "design/plan/settings.json": ["b.tsx", "src/Shared.tsx"] };

/** The verdict for a transcript of `lines` (null: no transcript file at all), spelled
 *  `unscoped[…]` · `claimed[…]` (+ ` unreadable[…]`) · `none` · `none+sendBack`; plans by the key they were given. */
function claimOf(lines: string[] | ((root: string) => string[]) | Buffer | null, s: Setup = {}): string {
  const root = path.join(ROOT, `c${cases++}`);
  fs.mkdirSync(path.join(root, "design", "plan"), { recursive: true });
  const keyOf = new Map<string, string>();
  const at = (k: string): string => { const f = path.isAbsolute(k) ? k : path.join(root, k); keyOf.set(f, k); return f; };
  const planFiles = (o: Record<string, string[]> | undefined): PlanFile[] => Object.entries(o ?? TWO).map(([k, files]) => ({ file: at(k), plan: { status: "pending", files } }));
  const open = planFiles(s.open);
  const closed = Object.entries(s.closed ?? {}).map(([k, files]): PlanFile => ({ file: at(k), plan: { status: "abandoned", files } }));
  const bad = Object.entries(s.bad ?? {}).map(([k, raw]): BadPlan => { const file = at(k); fs.writeFileSync(file, raw); return { file, error: "is not a valid plan" }; });
  const t = path.join(root, "t.jsonl");
  if (lines !== null) fs.writeFileSync(t, Buffer.isBuffer(lines) ? lines : (typeof lines === "function" ? lines(root) : lines).join("\n"));
  const v = sessionClaim({ payload: (s.payload ?? STOP)(t, root), cwd: root, open, all: [...open, ...closed], bad });
  const names = (xs: ReadonlyArray<{ file: string }>): string => `[${xs.map((x) => keyOf.get(x.file) ?? x.file).join(",")}]`;
  if (v.kind === "none") return v.sendBack ? "none+sendBack" : "none";
  if (v.kind === "unscoped") return `unscoped${names(v.plans)}`;
  return `claimed${names(v.plans)}${v.unreadable.length ? ` unreadable${names(v.unreadable)}` : ""}`;
}
const is = (name: string, got: string, want: string): boolean => check(`${name} → ${want}${got === want ? "" : ` (got ${got})`}`, got === want);

const LOGIN = "design/plan/login.json", SETTINGS = "design/plan/settings.json";
const BOTH = "[design/plan/login.json,design/plan/settings.json]";

// ---------------------------------------------------------------- scope: which transcript, if any
console.log("scope — the transcript the claim is read from:");
is("a hand-piped payload with no transcript: every open plan", claimOf([], { payload: (_t, root) => ({ cwd: root }) }), `unscoped${BOTH}`);
is("a transcript path that cannot be read: every open plan", claimOf(null), `unscoped${BOTH}`);
is("a subagent's stop with no agent_transcript_path: every open plan — the session transcript never scopes a subagent, even when it claims one",
  claimOf([edit(LOGIN)], { payload: (t, root) => ({ hook_event_name: "SubagentStop", cwd: root, agent_id: "b1", agent_type: "designtwin:screen-builder", transcript_path: t }) }), `unscoped${BOTH}`);
is("…while the same session transcript scopes the main session's Stop", claimOf([edit(LOGIN)]), "claimed[design/plan/login.json]");
is("nothing open and nothing unreadable: claimed nothing, the transcript not even read (an unreadable path is not unscoped here)",
  claimOf(null, { open: {} }), "claimed[]");
is("a transcript that names no plan: none (an orchestrator's Stop is not blocked on another agent's plan)", claimOf([text("assistant", "spawned two builders")]), "none");

// ---------------------------------------------------------------- ownership (a): the plan itself written
console.log("ownership (a) — a structured write of the plan:");
is("a Write of the plan by absolute path", claimOf((root) => [write(path.join(root, LOGIN))]), "claimed[design/plan/login.json]");
is("an Edit by project-relative path", claimOf([edit(LOGIN)]), "claimed[design/plan/login.json]");
is("a MultiEdit", claimOf([toolUse("MultiEdit", { file_path: LOGIN, edits: [] })]), "claimed[design/plan/login.json]");
is("a relative path resolves against the transcript entry's own cwd", claimOf((root) => [toolUse("Write", { file_path: "plan/login.json", content: "{}" }, { cwd: path.join(root, "design") })]), "claimed[design/plan/login.json]");
if (process.platform !== "win32") is("a Windows drive path from another machine matches by its project-relative tail", claimOf([write("C:\\work\\app\\design\\plan\\login.json")]), "claimed[design/plan/login.json]");
is("two plans written: both", claimOf([edit(LOGIN), write(SETTINGS)]), `claimed${BOTH}`);
// another JSON writer may spell "tool_use" with \uXXXX escapes: the line filter must still let it through
const escape = (line: string, letters: number[]): string => line.replace('"tool_use"', '"' + [..."tool_use"].map((c, i) => (letters.includes(i) ? "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0") : c)).join("") + '"');
for (const letters of [[0, 1, 2, 3, 4, 5, 6, 7], [4], [0, 7]])
  is(`a Write with "tool_use" spelled with \\u escapes (letters ${letters.join(",")})`, claimOf([escape(write(LOGIN), letters), toolResult("ok")]), "claimed[design/plan/login.json]");
is("…and in upper-case hex", claimOf([escape(write(LOGIN), [0, 1, 2, 3, 4, 5, 6, 7]).replace(/\\u00([0-9a-f]{2})/g, (_m, h: string) => "\\u00" + h.toUpperCase())]), "claimed[design/plan/login.json]");

console.log("ownership — what is NOT a claim:");
is("an Agent prompt naming the plan, a subagent's tool_result and assistant prose naming it",
  claimOf([toolUse("Agent", { subagent_type: "screen-builder", prompt: `Build Screen A; its plan is ${LOGIN}` }), toolResult(`done — wrote ${LOGIN}`), text("assistant", `${LOGIN} is next`)]), "none");
is("a subagent's sidechain Write inside the SESSION transcript", claimOf([toolUse("Write", { file_path: LOGIN }, { sidechain: true })]), "none");
is("…while the builder's own transcript counts its (sidechain) entries", claimOf([toolUse("Write", { file_path: LOGIN }, { sidechain: true })], { payload: builder() }), "claimed[design/plan/login.json]");
is("a Write of a plan of another tree (/elsewhere)", claimOf([write("/elsewhere/design/plan/login.json")]), "none");
is("`cd /elsewhere && plan-skeleton … --out design/plan/<x>.json` is another tree's plan", claimOf([bash(`cd /elsewhere && node plan-skeleton.js a.json a.vars.json ds --out ${LOGIN}`)]), "none");
for (const command of [
  `jq '.route = "/a"' ${LOGIN} > /tmp/t && mv /tmp/t ${LOGIN}`, `cp a.json ${LOGIN}`, `sed -i '' 's/a/b/' ${LOGIN}`,
  `python3 -c "import json; json.dump({}, open('${LOGIN}','w'))"`, `echo {} > ${LOGIN}`, `cat a.json | tee ${LOGIN}`,
  `node -e "require('fs').writeFileSync('${LOGIN}','{}')"`, `perl -pi -e 's/a/b/' ${LOGIN}`, `curl -s -o ${LOGIN} https://example.test/plan`,
  `node scripts/other.js --out ${LOGIN}`, "cat > src/OnlyX.tsx <<E\nexport const X = 1;\nE", "sed -i '' 's/a/b/' src/OnlyX.tsx",
  `node plan-skeleton.js a.json a.vars.json ds > ${LOGIN}`, `cat > notes.md <<'EOF'\nnode plan-skeleton.js a.json a.vars.json ds --out ${LOGIN}\nEOF`,
  `echo ${LOGIN} && ls design/plan`, `cat > notes/handoff.md <<'EOF'\nScreen A: ${LOGIN} is still being filled\nEOF`,
]) is(`a shell write is not read: \`${command.split("\n")[0]}\``, claimOf([bash(command)]), "none");
is("a PowerShell redirect is not read either", claimOf([toolUse("PowerShell", { command: `'{}' | Out-File ${LOGIN}` })]), "none");

// ---------------------------------------------------------------- ownership (b): a file only one open plan lists
console.log("ownership (b) — a written file that exactly one open plan lists:");
is("an Edit of a file only login lists", claimOf([edit("src/OnlyX.tsx")]), "claimed[design/plan/login.json]");
is("a NotebookEdit of it", claimOf([toolUse("NotebookEdit", { notebook_path: "src/OnlyX.tsx", new_source: "x" })]), "claimed[design/plan/login.json]");
is("an Edit of a file both plans list claims neither", claimOf([edit("src/Shared.tsx")]), "none");
is("a file only a CLOSED plan and one open plan list is the open plan's alone (only open plans count as listers)",
  claimOf([edit("src/Shared.tsx")], { open: { [LOGIN]: ["src/Shared.tsx"] }, closed: { "design/plan/done.json": ["src/Shared.tsx"] } }), "claimed[design/plan/login.json]");
is("a closed plan is not claimed through a file it lists (rule (b) is for open plans)",
  claimOf([edit("src/Old.tsx")], { closed: { "design/plan/done.json": ["src/Old.tsx"] } }), "none");

// ---------------------------------------------------------------- plan-skeleton --out
console.log("plan-skeleton --out — the call that creates a plan:");
const SKEL = 'node "/opt/plugin/scripts/plan-skeleton.js" a.json a.vars.json design/export/design-system';
is("`--out <plan>`", claimOf([bash(`${SKEL} --out ${LOGIN}`)]), "claimed[design/plan/login.json]");
is("`--out=<plan>`", claimOf([bash(`${SKEL} --out=${LOGIN}`)]), "claimed[design/plan/login.json]");
is("through `npx tsx …/plan-skeleton.ts`", claimOf([bash(`npx tsx design-to-code/plan-skeleton.ts a.json a.vars.json ds --out ${LOGIN}`)]), "claimed[design/plan/login.json]");
is("`--seed-from <sibling>` claims only the --out plan", claimOf([bash(`${SKEL} --out ${LOGIN} --seed-from ${SETTINGS}`)]), "claimed[design/plan/login.json]");
is("parallel builders: B seeding from A's plan and sed-ing it claims B's plan alone",
  claimOf([bash(`${SKEL} --out ${SETTINGS} --seed-from ${LOGIN}`), bash(`sed -i '' 's/x/y/' ${LOGIN}`), write("b.tsx")], { payload: builder() }), "claimed[design/plan/settings.json]");
is("after a cd it cannot follow, an absolute --out still claims", claimOf((root) => [bash(`cd ~ && ${SKEL} --out "${path.join(root, LOGIN)}"`)]), "claimed[design/plan/login.json]");
// Every location a command's --out may resolve to is an open plan; the verdict names the ones it claims.
const PLACES = ["design/plan/a.json", "design/plan/b.json", "design/plan/c.json", "app/design/plan/a.json", "/x/plan/a.json", "b.json", "design/sub/plan/a.json", "plan/my a.json", "plan/a.json"];
const outs = (command: string, tool = "Bash"): string => claimOf([toolUse(tool, { command })], { open: Object.fromEntries(PLACES.map((p) => [p, []])) });
const claims = (...xs: string[]): string => `claimed[${PLACES.filter((p) => xs.includes(p)).join(",")}]`;
for (const [command, want, tool] of [
  ["node plan-skeleton.js s.json v.json ds --out design/plan/a.json --seed-from design/plan/b.json", claims("design/plan/a.json")],
  ['node "C:\\p\\scripts\\plan-skeleton.js" s v ds --out="design\\plan\\a.json"', claims("design/plan/a.json")],
  ["cd app/ && cd design; node plan-skeleton.mjs s v ds --out plan/a.json", claims("app/design/plan/a.json")],
  ["cd /x && node plan-skeleton.js s v ds --out plan/a.json && cd && node plan-skeleton.js s v ds --out b.json", claims("/x/plan/a.json", "b.json")],
  // a cd inside a subshell or a substitution does not move the commands after it: on such a line a cd only makes the dir unknown
  ["(cd sub && make); node plan-skeleton.js s v ds --out design/plan/a.json", claims("design/plan/a.json")],
  ["x=$(cd sub && pwd); node plan-skeleton.js s v ds --out design/plan/a.json", claims("design/plan/a.json")],
  ["x=`cd sub; pwd`; node plan-skeleton.js s v ds --out design/plan/a.json", claims("design/plan/a.json")],
  // a cd it cannot follow (`cd -`, `cd "$ROOT"`, `cd ~/proj`, a substitution): a relative --out is tried against the entry's cwd
  ...["cd -", 'cd "$ROOT"', "cd ~/proj", "cd $(git rev-parse --show-toplevel)"].map((cd) => [`${cd} && node plan-skeleton.js s v ds --out design/plan/a.json`, claims("design/plan/a.json")]),
  // pushd, chdir, `builtin cd` and PowerShell's Set-Location move like cd; popd leaves the dir unknown
  ["pushd design && node plan-skeleton.js s v ds --out plan/a.json", claims("design/plan/a.json")],
  ["builtin cd design && node plan-skeleton.js s v ds --out plan/a.json", claims("design/plan/a.json")],
  ["Set-Location -Path design; node plan-skeleton.js s v ds --out plan/a.json", claims("design/plan/a.json")],
  ["pushd sub && popd && node plan-skeleton.js s v ds --out design/plan/a.json", claims("design/plan/a.json")],
  ["pushd sub && popd +1 && node plan-skeleton.js s v ds --out design/plan/a.json", claims("design/plan/a.json")],
  // PowerShell quoting: unquoted backslash paths stay whole, a backtick escapes (here a space in a path)
  ["Set-Location design\\sub; & node C:\\My` Plugin\\plan-skeleton.js s v ds --out plan\\a.json", claims("design/sub/plan/a.json"), "PowerShell"],
  ["& node C:\\p\\plan-skeleton.js s v ds --out plan\\my` a.json", claims("plan/my a.json"), "PowerShell"],
  ["Set-Location design; & node \"C:\\work\\plugin\\scripts\\plan-skeleton.js\" a.json a.vars.json ds --out plan\\a.json", claims("design/plan/a.json"), "PowerShell"],
  // …while Bash reads the same unquoted backslashes as escapes: no plan-skeleton word
  ["node C:\\p\\plan-skeleton.js s v ds --out plan\\a.json", "none"],
  // a `<<<word` here-string is not a heredoc: the next line is a command
  ["grep x <<<bar\nnode plan-skeleton.js s v ds --out design/plan/a.json", claims("design/plan/a.json")],
  ["node plan-skeleton.js s v ds > design/plan/a.json", "none"],
  ["node other.js --out design/plan/a.json", "none"],
  ["cat > run.sh <<'EOF'\nnode plan-skeleton.js s v ds --out design/plan/a.json\nEOF\nnode plan-skeleton.js s v ds --out design/plan/c.json", claims("design/plan/c.json")],
] as Array<[string, string, string?]>) is(`${tool ?? "Bash"} \`${command.split("\n").join("⏎")}\``, outs(command, tool), want);

// ---------------------------------------------------------------- closed and unreadable plans
console.log("closed and unreadable plans:");
is("claiming only a CLOSED plan claims nothing to check — and is a claim, so not none (a builder is not sent back)",
  claimOf([edit("design/plan/done.json")], { closed: { "design/plan/done.json": ["c.tsx"] }, payload: builder() }), "claimed[]");
const BROKEN = JSON.stringify({ status: "pending", tokens: "none" });
const BAD = "design/plan/broken.json";
is("an unreadable plan the session wrote blocks — even with the open plans unclaimed", claimOf([write(BAD)], { bad: { [BAD]: BROKEN } }), "claimed[] unreadable[design/plan/broken.json]");
is("…beside a plan it claimed: both", claimOf([edit(LOGIN), write(BAD)], { bad: { [BAD]: BROKEN } }), "claimed[design/plan/login.json] unreadable[design/plan/broken.json]");
is("…with no plan open at all", claimOf([edit(BAD)], { open: {}, bad: { [BAD]: BROKEN } }), "claimed[] unreadable[design/plan/broken.json]");
is("…and a builder that wrote it is blocked on it, not sent back", claimOf([write(BAD)], { bad: { [BAD]: BROKEN }, payload: builder() }), "claimed[] unreadable[design/plan/broken.json]");
is("an unreadable plan nobody wrote is not the session's (a warning, rendered by verify-build)", claimOf([edit(LOGIN)], { bad: { [BAD]: BROKEN } }), "claimed[design/plan/login.json]");
for (const status of ["abandoned", " Awaiting-User "])
  is(`an unreadable plan it wrote whose raw JSON says status ${JSON.stringify(status)} is given up on`, claimOf([write(BAD)], { open: {}, bad: { [BAD]: JSON.stringify({ status, tokens: "none" }) } }), "claimed[]");
is("…and with open plans unclaimed that is none", claimOf([write(BAD)], { bad: { [BAD]: JSON.stringify({ status: "abandoned", tokens: "none" }) } }), "none");
for (const raw of ["{not json", JSON.stringify({ status: "done", tokens: "none" }), JSON.stringify(["abandoned"])])
  is(`…but raw text ${raw} (no closed status) still blocks`, claimOf([write(BAD)], { open: {}, bad: { [BAD]: raw } }), "claimed[] unreadable[design/plan/broken.json]");
is("an unreadable plan written through plan-skeleton --out is claimed too", claimOf([bash(`${SKEL} --out ${BAD}`)], { bad: { [BAD]: BROKEN } }), "claimed[] unreadable[design/plan/broken.json]");

// ---------------------------------------------------------------- send back
console.log("send back — a screen-builder that claims no plan:");
const SED = bash(`sed -i '' 's/a/b/' ${LOGIN}`);
is("a screen-builder's SubagentStop that claims none is sent back", claimOf([SED], { payload: builder() }), "none+sendBack");
is("…the bare agent name (copied into a project's .claude/agents/) too", claimOf([SED], { payload: builder("screen-builder") }), "none+sendBack");
is("another agent type is not", claimOf([SED], { payload: builder("Explore") }), "none");
is("the skill's Stop in an orchestrator session is not", claimOf([SED]), "none");
const feedback = text("user", `Stop hook feedback:\nverify-build: you (designtwin:screen-builder) ${NO_CLAIM_MARK}. Open plan(s): ${LOGIN}.`, true);
is("a transcript already holding the request (a user-role entry) is not asked again", claimOf([SED, feedback, SED], { payload: builder() }), "none");
is("…the request's text inside a tool_result (the builder reading the hook's source) does not count as asked",
  claimOf([SED, JSON.stringify({ type: "user", isSidechain: true, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: NO_CLAIM_MARK }] } })], { payload: builder() }), "none+sendBack");
is("…nor inside the builder's own tool_use input or its assistant text",
  claimOf([SED, toolUse("Bash", { command: `grep -rn "${NO_CLAIM_MARK}" .`, description: NO_CLAIM_MARK }, { sidechain: true }), text("assistant", NO_CLAIM_MARK, true)], { payload: builder() }), "none+sendBack");
is("an agent transcript with no tool call at all (an internal agent under `claude --agent`) is not sent back", claimOf([text("assistant", "a suggestion", true)], { payload: builder() }), "none");
is("…while one tool call of any kind (a Read) makes it a build", claimOf([toolUse("Read", { file_path: "a.tsx" })], { payload: builder() }), "none+sendBack");
is("a builder that claims its plan is checked, not sent back", claimOf([edit(LOGIN)], { payload: builder() }), "claimed[design/plan/login.json]");

// ---------------------------------------------------------------- the transcript is read line by line
// A transcript is tens of MB, read in 1 MiB chunks: a claim must survive a line across a chunk boundary, multi-byte
// characters split by one, a BOM, CRLF line ends, a line longer than a chunk and a last line with no newline.
console.log("reading a large transcript:");
is("claims on a line across the 1 MiB boundary, on a 1.5 MiB line of multi-byte text and on an unterminated last line all count", claimOf(() => {
  const CHUNK = 1 << 20;
  const head = ["\uFEFF" + text("user", "build the screens"), ...Array.from({ length: 200 }, (_v, i) => text("assistant", `é中😀 ${i} `.repeat(40)))];
  const pad = (bytes: number): string => { const base = text("user", ""); return text("user", "x".repeat(bytes - Buffer.byteLength(base))); };
  const sofar = Buffer.byteLength(head.join("\n") + "\n");
  const across = write("design/plan/a.json"); // starts 50 bytes before the boundary, so it straddles it
  return [...head, pad(CHUNK - 50 - sofar - 1), across + "\r", toolUse("Write", { file_path: "design/plan/b.json", content: "é".repeat(800_000) }) + "\r", write("design/plan/c.json")];
}, { open: { "design/plan/a.json": [], "design/plan/b.json": [], "design/plan/c.json": [], "design/plan/d.json": [] } }), "claimed[design/plan/a.json,design/plan/b.json,design/plan/c.json]");
is("malformed UTF-8 bytes (a split sequence, a stray continuation byte, a truncated last character) do not swallow the claim after them",
  claimOf(Buffer.concat([Buffer.from(text("user", "ok") + "\n"), Buffer.from([0xe4, 0xb8, 0x0a, 0x80, 0x41, 0x0a]), Buffer.from(write(LOGIN) + "\n"), Buffer.from([0xf0, 0x9f])])), "claimed[design/plan/login.json]");
// Only a line that can hold a tool_use item is parsed: a tool_result (even one with \u escapes in its text), a prompt, an
// attachment, a system entry, a blank or non-JSON line is skipped unparsed — the bulk of a transcript is tool_result text.
{
  const claimLine = write(LOGIN);
  const skipped = [toolResult(`wrote ${LOGIN} \u001b[32mok\u001b[0m`), text("user", "build the login screen"), JSON.stringify({ type: "attachment", attachment: { kind: "file", text: "x" } }),
    JSON.stringify({ type: "system", subtype: "info", content: "compacted" }), "", "not json"];
  const parse = JSON.parse;
  const parsed: string[] = [];
  JSON.parse = (s: string): unknown => { parsed.push(s); return parse(s); };
  let got: string;
  try { got = claimOf([...skipped, claimLine, ...skipped]); } finally { JSON.parse = parse; }
  check(`the line filter parses only the line holding a tool_use item (parsed ${parsed.length} line(s); verdict ${got})`,
    got === "claimed[design/plan/login.json]" && parsed.length === 1 && parsed[0] === claimLine);
}

report();
