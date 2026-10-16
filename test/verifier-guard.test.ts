// Offline tests for design-to-code/verifier-guard.ts — the visual-verifier's PreToolUse guard — and its
// registration in claude-plugin/hooks/hooks.json. Table-driven allow/deny cases over decide(), then the
// shipped bundle run as the hook runs it (payload on stdin, answer on stdout, exit 0). Binds no port.
//   node test/verifier-guard.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { VERIFIER_AGENT, bashVerdict, decide, tempRoots, writeVerdict } from "../design-to-code/verifier-guard.ts";
import { simpleCommands } from "../design-to-code/shell-words.ts";
import type { GuardCtx } from "../design-to-code/verifier-guard.ts";
import { isJsonObject } from "../design-to-code/types.ts";
import { check, report } from "./assert.ts";
import { must } from "./fixtures.ts";

const ROOT = path.join(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "claude-plugin", "scripts", "verifier-guard.js");
const CTX: GuardCtx = { cwd: "/proj", tmpRoots: ["/tmp", "/var/folders/xy/abc/T", "C:\\Users\\me\\AppData\\Local\\Temp"] };
const AGENT = "designtwin:visual-verifier";
const bash = (command: string, extra: Record<string, unknown> = {}, agent: string | null = AGENT): unknown =>
  ({ hook_event_name: "PreToolUse", cwd: "/proj", ...(agent === null ? {} : { agent_type: agent, agent_id: "a1" }), tool_name: "Bash", tool_input: { command, ...extra } });
const write = (file: string, tool = "Write", key = "file_path"): unknown =>
  ({ hook_event_name: "PreToolUse", cwd: "/proj", agent_type: AGENT, agent_id: "a1", tool_name: tool, tool_input: { [key]: file, content: "x" } });
const mal = (x: unknown): boolean => { const d = decide(x, CTX); return d !== null && "malformed" in d; };
const denied = (payload: unknown): boolean => { const d = decide(payload, CTX); return d !== null && "deny" in d; };
const allowed = (payload: unknown): boolean => decide(payload, CTX) === null;

// ---------------------------------------------------------------- who it applies to
console.log("scoped to the visual-verifier:");
for (const [agent, applies] of [
  [AGENT, true], ["visual-verifier", true],
  [null, false], ["Explore", false], ["general-purpose", false], ["designtwin:screen-builder", false],
  ["designtwin:visual-verifier-2", false], ["other-plugin:visual-verifier", false], ["designtwin:visual", false],
] as const) {
  check(`agent_type ${agent ?? "(absent: the main conversation)"} → ${applies ? "guarded" : "not this hook's business"}`,
    applies ? denied(bash("pkill -f vite", {}, agent)) : allowed(bash("pkill -f vite", {}, agent)));
}

// ---------------------------------------------------------------- file writes: an allow-list
console.log("\nwrites — allowed (its own outputs):");
const WRITE_OK: readonly string[] = [
  "/proj/design/verify/Home__1_2.measured.json",
  "/proj/design/verify/Home__1_2.png",
  "/proj/design/verify/Home__1_2-dark.png",
  "/proj/node_modules/.cache/designtwin-verify/scratch/drive.cjs",
  "/proj/node_modules/.cache/designtwin-verify/stage/r1/Home__1_2.evidence.json",
  "/repo/node_modules/.cache/designtwin-verify/scratch/x.cjs", // a hoisted monorepo's root run cache
  "/proj/apps/web/design/verify/Home__1_2.measured.json",
  "/tmp/designtwin-verify/ab12cd/scratch/drive.cjs", // no package.json: the run cache under the temp dir
  "/tmp/claude/designtwin-verify/ab12cd/stage/r1/Home.evidence.json", // a sandbox's nested TMPDIR
  "/var/folders/xy/abc/T/designtwin-verify/ab12cd/scratch/a.cjs",
  "design/verify/Home__1_2.measured.json", // relative: from the payload's cwd
  "C:\\proj\\design\\verify\\Home__1_2.measured.json",
  "C:\\proj\\node_modules\\.cache\\designtwin-verify\\scratch\\drive.cjs",
  "C:\\Users\\me\\AppData\\Local\\Temp\\designtwin-verify\\ab12cd\\scratch\\a.cjs",
  "/proj/Design/Verify/Home__1_2.measured.json", // case-insensitive file systems
];
for (const f of WRITE_OK) check(`Write ${f}`, allowed(write(f)) && writeVerdict(f, CTX) === null);

console.log("\nwrites — refused:");
const WRITE_NO: readonly string[] = [
  "/proj/src/App.tsx", "/proj/src/components/Button.tsx", "/proj/vite.config.ts", "/proj/package.json", "/proj/tailwind.config.js",
  "/proj/.claude/settings.json", "/proj/design/plan/home.json", "/proj/design/export/Home__1_2.json", "/proj/design/tokens.json",
  "/proj/design/verify/Home__1_2.expected.json", "/proj/design/verify/Home__1_2.expected.prev.json", "/proj/design/verify/Home__1_2.report.json",
  "/proj/design/verify/Home__1_2.report.md", "/proj/design/verify/Home__1_2.status.json", "/proj/design/verify/Home__1_2.diff.png",
  "/proj/design/verify/.migrate-Home.json", // a --migrate journal: the next --migrate --apply acts on it
  "/proj/design/verify/../../src/App.tsx", "/proj/node_modules/.cache/designtwin-verify/../../../src/App.tsx",
  "/proj/node_modules/.cache/other-tool/x.js", "/proj/node_modules/designtwin-verify/x.js", "/proj/node_modules/.cache/designtwin-verify",
  "/tmp/drive.cjs", "/proj/designtwin-verify/x.ts", "/proj/src/designtwin-verify/x.ts", "/proj/design/verify",
  "src/App.tsx", "C:\\proj\\src\\App.tsx", "C:\\proj\\design\\verify\\..\\..\\src\\App.tsx",
];
for (const f of WRITE_NO) check(`Write ${f}`, denied(write(f)));
check("Edit / MultiEdit / NotebookEdit go through the same allow-list (if the agent is ever given them)",
  denied(write("/proj/src/App.tsx", "Edit")) && denied(write("/proj/src/App.tsx", "MultiEdit")) && denied(write("/proj/a.ipynb", "NotebookEdit", "notebook_path"))
  && allowed(write("/proj/design/verify/X.measured.json", "Edit")));
{
  const d = decide(write("/proj/src/App.tsx"), CTX);
  check("the refusal names the path and where the verifier does write", d !== null && "deny" in d && d.deny.includes("/proj/src/App.tsx") && /design\/verify\//.test(d.deny) && /designtwin-verify\/.*scratch/.test(d.deny));
  const t = decide(write("/proj/design/verify/H.status.json"), CTX);
  check("a tool-owned file is refused with the tool to use instead", t !== null && "deny" in t && /--status/.test(t.deny));
}

// ---------------------------------------------------------------- Bash
// the commands the verify skill and the agent are told to run, and other everyday ones: never refused
console.log("\nBash — allowed:");
const BASH_OK: readonly string[] = [
  "node \"/plugins/designtwin/scripts/verify-probe.js\" --check",
  "node \"/plugins/designtwin/scripts/verify-probe.js\" --check --project apps/web --browser-path \"/Applications/Chromium.app/Contents/MacOS/Chromium\"",
  "node \"/plugins/designtwin/scripts/verify-screen.js\" --status Home__1_2 --phase renderer-found --run r1 --detail \"no npm install, no pkill\"",
  "node \"/plugins/designtwin/scripts/verify-screen.js\" --status Home__1_2 --phase blocked --run r1 --detail 'denied: npx playwright install'",
  "node \"/plugins/designtwin/scripts/verify-probe.js\" --expected design/verify/Home__1_2.expected.json --url http://localhost:5173/ --out design/verify/Home__1_2 --run r1 --ready '[data-dt-node=\"1:2\"]' --steps design/plan/home.json",
  "node \"/plugins/designtwin/scripts/verify-screen.js\" --status Home__1_2 --phase done --run r1 --publish node_modules/.cache/designtwin-verify/stage/r1",
  "yarn node \"/plugins/designtwin/scripts/verify-probe.js\" --check --project .",
  "node node_modules/.cache/designtwin-verify/scratch/drive.cjs",
  "npm run dev > node_modules/.cache/designtwin-verify/scratch/dev.log 2>&1 & echo $!",
  "npx vite --port 5174", "pnpm dev", "yarn dev", "bun run dev", "npm ls playwright", "npm view playwright version",
  "npx playwright --version", "yarn --version", "pnpm --version",
  "kill 4242", "kill -TERM 4242", "kill $DEV_PID", "kill -TERM \"$(cat node_modules/.cache/designtwin-verify/scratch/dev.pid)\"",
  "cat node_modules/.cache/designtwin-verify/scratch/dev.pid | xargs kill",
  "pgrep -fl vite", "lsof -nP -iTCP:5173 -sTCP:LISTEN", "ps -p 4242 -o pid,command",
  "echo \"pkill is not allowed\"", "grep -rn \"npm install\" design/", "echo 'killall' # pkill",
  "shasum -a 256 design/verify/Home__1_2.expected.json", "date -u +%Y-%m-%dT%H:%M:%SZ", "stat -f %m src/App.tsx",
  "curl -s http://localhost:5173/ | head -5", "git status --short", "ls node_modules/.bin | grep playwright",
  // its own server tree: the children of a recorded PID, or the process group it started — no name, no pattern
  "pkill -P 4242", "pkill -TERM -P 4242", "pkill -P4242", "pkill --parent=4242", "pkill --signal KILL -P 4242,4243",
  "kill $(pgrep -P 4242)", "kill -TERM \"$(pgrep -P 4242)\"", "pgrep -P 4242 | xargs kill", "kill -- -4242", "kill -TERM -- -4242", "kill -1 4242",
  "npm --loglevel silent run dev", "npm -w web run dev", "yarn workspace web dev", "yarn --cwd web dev",
];
for (const c of BASH_OK) check(c, allowed(bash(c)));

console.log("\nBash — refused (pattern kills):");
const KILLS: readonly string[] = [
  "pkill -f vite", "pkill node", "killall node", "/usr/bin/pkill -f 'next dev'", "sudo pkill node", "sudo -u me killall Safari",
  "env FOO=1 pkill x", "FOO=1 pkill x", "timeout 5 pkill x", "nohup killall node &",
  "pgrep -f vite | xargs kill", "pgrep -f vite | xargs -n1 kill -9", "ps aux | grep vite | awk '{print $2}' | xargs kill -9",
  "kill -9 $(lsof -ti:5173)", "kill $(pgrep -f vite)", "kill `pgrep node`", "kill -9 \"$(pidof node)\"",
  "fuser -k 5173/tcp", "taskkill /IM node.exe /F", "taskkill /F /FI \"IMAGENAME eq node.exe\"",
  "bash -c \"pkill -f vite\"", "sh -lc 'killall node'", "eval pkill node",
  "npm run build; pkill node", "echo ok && killall node", "true || pkill vite", "(pkill vite)", "echo \"$(pkill vite)\"",
  "pkill -P 4242 node", "pkill -f -P 4242", "pkill -P", "kill $(pgrep -P 4242 node)", "kill $(pgrep -f vite -P 4242)", "pgrep -P 4242 vite | xargs kill",
  "taskkill //F //IM node.exe", "taskkill -im node.exe", "taskkill /f /im node.exe",
  "kill -1", "kill -- -1", "kill -9 -1", "kill 0", "kill -s TERM 0", "kill -TERM -- 0",
  "doas pkill node", "setsid pkill node", "bash -c -- 'pkill node'", "fish -c 'killall node'",
];
for (const c of KILLS) check(c, denied(bash(c)));

console.log("\nBash — refused (dependency installs):");
const INSTALLS: readonly string[] = [
  "npm install", "npm i", "npm ci", "npm i -D playwright", "npm install --save-dev @playwright/test", "npm --prefix apps/web install",
  "npm -D i playwright", "npm add axe-core", "npm uninstall vite", "npm update", "npm clean-install", "npm install-ci-test",
  "pnpm install", "pnpm i", "pnpm add -D playwright", "pnpm -C apps/web install", "pnpm remove vite",
  "yarn", "yarn install", "yarn --frozen-lockfile", "yarn add playwright", "yarn remove vite", "yarn up",
  "bun install", "bun add axe-core", "bun i",
  "NODE_ENV=development npm ci", "cd apps/web && npm install", "sh -c 'npm ci'", "npm exec -c 'npm install'",
  "npm --loglevel silent install", "npm --cache /tmp/npm-cache ci", "npm -w web install", "npm --prefix=web i",
  "yarn workspace web add vite", "yarn workspace web remove vite", "yarn --cwd web add axe-core", "pnpm --filter web add axe-core",
  "npm init vite@latest", "npm create vite",
];
for (const c of INSTALLS) check(c, denied(bash(c)));

console.log("\nBash — refused (Playwright browser installs):");
const PW: readonly string[] = [
  "npx playwright install", "npx playwright install chromium", "npx --yes playwright@1.48.0 install --with-deps chromium",
  "npx -p @playwright/test playwright install", "npx @playwright/test install", "npm exec -- playwright install", "npm x playwright install chromium",
  "pnpm exec playwright install chromium", "pnpm dlx playwright install", "yarn playwright install", "yarn dlx playwright install",
  "bunx playwright install", "bun x playwright install", "node_modules/.bin/playwright install chromium",
  "node node_modules/playwright/cli.js install", "npx playwright install-deps", "./node_modules/.bin/playwright.cmd install",
  "node node_modules/@playwright/test/cli.js install", "node node_modules/playwright-core/cli.js install chromium", "node \"C:\\app\\node_modules\\playwright\\cli.js\" install",
  // Playwright's own installer
  "npm init playwright@latest", "npm init playwright", "npm create playwright", "npm innit playwright", "yarn create playwright",
  "pnpm create playwright", "bun create playwright", "npx create-playwright", "npx create-playwright@latest",
];
for (const c of PW) check(c, denied(bash(c)));
{
  const k = decide(bash("pkill -f vite"), CTX), i = decide(bash("npm ci"), CTX), p = decide(bash("npx playwright install"), CTX);
  check("each refusal says what to do instead (kill the recorded PID or its tree / status blocked / ask the user with the install line)",
    k !== null && "deny" in k && /kill <pid>/.test(k.deny) && /kill -- -<pgid>/.test(k.deny) && /pkill -P <pid>/.test(k.deny) && i !== null && "deny" in i && /blocked/.test(i.deny) && /node_modules\/\.cache/.test(i.deny)
    && p !== null && "deny" in p && /ask the user/.test(p.deny));
}

{
  const reason = (c: string): string => { const d = decide(bash(c), CTX); return d !== null && "deny" in d ? d.deny : ""; };
  check("`<pm> init|create playwright` and create-playwright get the Playwright reason; another initializer the install one",
    ["npm init playwright@latest", "yarn create playwright", "pnpm create playwright", "npx create-playwright"].every((c) => /installing Playwright/.test(reason(c)))
    && /reinstalling dependencies/.test(reason("npm init vite@latest")));
}

console.log("\nBash — refused (verify-screen --migrate: it renames verify sets and rewrites plans):");
const MIGRATE: readonly string[] = [
  "node \"/plugins/designtwin/scripts/verify-screen.js\" --migrate", "node \"/plugins/designtwin/scripts/verify-screen.js\" --migrate --apply",
  "node /plugins/designtwin/scripts/verify-screen.js --dir design/verify --migrate --apply", "./verify-screen.js --migrate", "npx tsx design-to-code/verify-screen.ts --migrate",
  "yarn node \"/plugins/designtwin/scripts/verify-screen.js\" --migrate", "sh -c 'node /p/verify-screen.js --migrate --apply'", "node \"C:\\p\\scripts\\verify-screen.js\" --migrate=1",
];
for (const c of MIGRATE) check(c, denied(bash(c)));
{
  const d = decide(bash(MIGRATE[0] ?? ""), CTX);
  check("the refusal says it is the caller's call and what to hand back", d !== null && "deny" in d && /caller's call/.test(d.deny) && /hand-back/.test(d.deny));
  check("PowerShell: refused too", denied({ hook_event_name: "PreToolUse", cwd: "/proj", agent_type: AGENT, agent_id: "a1", tool_name: "PowerShell",
    tool_input: { command: "node \"C:\\plugins\\designtwin\\scripts\\verify-screen.js\" --migrate --apply" } }));
  check("not refused: another verify-screen mode, a mention of --migrate, another agent",
    allowed(bash("node \"/plugins/designtwin/scripts/verify-screen.js\" --status Home__1_2 --phase done --run r1")) && allowed(bash("echo node verify-screen.js --migrate"))
    && allowed(bash("grep -rn -- --migrate design/")) && allowed(bash("node /p/verify-screen.js --migrate", {}, "general-purpose")));
}

console.log("\nBash — dangerouslyDisableSandbox:");
check("refused, whatever the command", denied(bash("node x.js", { dangerouslyDisableSandbox: true })) && denied(bash("ls", { dangerouslyDisableSandbox: true })));
check("false, or absent, is a normal call", allowed(bash("node x.js", { dangerouslyDisableSandbox: false })) && allowed(bash("node x.js")));
check("not refused for another agent", allowed(bash("node x.js", { dangerouslyDisableSandbox: true }, "general-purpose")));

// ---------------------------------------------------------------- PowerShell
const ps = (command: string, extra: Record<string, unknown> = {}, agent: string | null = AGENT): unknown => {
  const p = bash(command, extra, agent);
  return isJsonObject(p) ? { ...p, tool_name: "PowerShell" } : p;
};
console.log("\nPowerShell — allowed:");
const PS_OK: readonly string[] = [
  "node \"C:\\plugins\\designtwin\\scripts\\verify-probe.js\" --check",
  "Get-Content design\\verify\\Home__1_2.expected.json",
  "Get-Process -Id 4242", "Get-Process node", "Get-NetTCPConnection -LocalPort 5173",
  "Stop-Process -Id 4242", "Stop-Process -Id 4242 -Force", "Stop-Process $devPid", "kill 4242", "kill $devPid",
  "Get-Content node_modules\\.cache\\designtwin-verify\\scratch\\dev.pid | ForEach-Object { Stop-Process -Id $_ }",
  "node x.js 2>&1", "node x.js > $null", "node x.js 2> $null",
  "Set-Content src/App.tsx x", "Copy-Item a.json design/verify/a.json", "echo 'Stop-Process -Name node'", "npm ls playwright", "npx vite --port 5174",
  "pwsh -NoProfile -Command \"Get-Process -Id 4242\"", "if ($ok) { Stop-Process -Id 4242 }",
];
for (const c of PS_OK) check(c, allowed(ps(c)));

console.log("\nPowerShell — refused (pattern kills):");
const PS_KILLS: readonly string[] = [
  "Stop-Process -Name node", "Stop-Process -Name node -Force", "stop-process -processname vite", "Stop-Process -ProcessName:node", "spps -Name node",
  "kill -Name node", "kill -ProcessName node", "Get-Process node | Stop-Process", "Get-Process -Name vite | Stop-Process -Force", "gps node | kill", "ps node | spps",
  "Get-Process node | ForEach-Object { Stop-Process -Id $_.Id } ; Get-Process vite | Stop-Process",
  "Stop-Process -Id (Get-Process node).Id", "Stop-Process -Id $(Get-Process node).Id",
  "Stop-Process -Id (Get-NetTCPConnection -LocalPort 5173).OwningProcess", "Get-NetTCPConnection -LocalPort 5173 | Select -Expand OwningProcess | Stop-Process",
  "if ($x) { Stop-Process -Name node }", "{ Stop-Process -Name node }",
  "taskkill /IM node.exe /F", "taskkill /F /FI \"IMAGENAME eq node.exe\"", "cmd /c taskkill /im node.exe /f", "cmd.exe /c \"taskkill /F /IM node.exe\"",
  "pwsh -Command \"Stop-Process -Name node\"", "powershell.exe -NoProfile -c 'Get-Process node | Stop-Process'", "pwsh -c Stop-Process -Name node",
  "iex 'Stop-Process -Name node'", "Invoke-Expression \"Stop-Process -Name node\"", "bash -c 'pkill node'", "pkill node",
];
for (const c of PS_KILLS) check(c, denied(ps(c)));

console.log("\nPowerShell — refused (installs, Playwright):");
const PS_INSTALLS: readonly string[] = [
  "npm install", "npm.cmd ci", "pnpm add -D playwright", "yarn", "bun add axe-core", "npx playwright install chromium", "npx.cmd playwright install",
  "npm init playwright@latest", "& npm install", "pwsh -c 'npm ci'", "cd apps/web; npm install",
];
for (const c of PS_INSTALLS) check(c, denied(ps(c)));

{
  const k = decide(ps("Stop-Process -Name node"), CTX);
  check("a PowerShell kill refusal names Stop-Process -Id", k !== null && "deny" in k && /Stop-Process -Id <pid>/.test(k.deny));
}
check("a cmd /c body is read with PowerShell quoting (backslashes kept): a quoted Windows path to npm install is refused",
  denied(ps("cmd /c \"C:\\tools\\npm.cmd install\"")) && denied(ps("cmd.exe /c \"C:\\tools\\npm.cmd ci\"")));
check("Bash: a cmd.exe /c taskkill /IM is refused; netstat -ano (a plain listing) is allowed",
  denied(bash("cmd.exe /c \"taskkill /IM node.exe\"")) && allowed(bash("netstat -ano")));
check("dangerouslyDisableSandbox is refused on a PowerShell call too, and only for the verifier",
  denied(ps("Get-Date", { dangerouslyDisableSandbox: true })) && allowed(ps("Get-Date", { dangerouslyDisableSandbox: false })) && allowed(ps("Get-Date", { dangerouslyDisableSandbox: true }, "general-purpose")));
check("a PowerShell call from another agent, or the main session, is never judged", allowed(ps("Stop-Process -Name node", {}, "general-purpose")) && allowed(ps("Stop-Process -Name node", {}, null)));
check("a PowerShell call with no command is malformed (allowed, reported)", mal({ agent_type: AGENT, tool_name: "PowerShell", tool_input: {} }));

// ---------------------------------------------------------------- the lexer
console.log("\nsimpleCommands:");
const sc = (s: string): string => JSON.stringify(simpleCommands(s));
check("splits at ; && || | & and newlines", sc("a 1; b && c || d | e & f\ng") === JSON.stringify([["a", "1"], ["b"], ["c"], ["d"], ["e"], ["f"], ["g"]]));
check("a backslash inside double quotes stays unless it escapes $ ` \" \\ (bash)", sc("echo \"C:\\a\\b \\$x \\\"q\\\"\"") === JSON.stringify([["echo", "C:\\a\\b $x \"q\""]]));
check("quotes stay one word, without the quotes", sc("echo \"a b\" 'c d' e\\ f") === JSON.stringify([["echo", "a b", "c d", "e f"]]));
check("a $( ) / backtick substitution is a command of its own, and stays (raw) in its word — inside double quotes too",
  sc("kill \"$(pgrep x)\" `pidof y`") === JSON.stringify([["pgrep", "x"], ["pidof", "y"], ["kill", "$(pgrep x)", "`pidof y`"]]));
check("a separator inside quotes does not split", sc("echo 'a; pkill b' \"c | d\"") === JSON.stringify([["echo", "a; pkill b", "c | d"]]));
check("a comment is dropped", sc("ls # pkill node") === JSON.stringify([["ls"]]));
check("an unclosed quote or substitution still yields its words", bashVerdict("echo \"$(pkill x") !== null && bashVerdict("echo 'unterminated") === null);

// ---------------------------------------------------------------- malformed input: allowed, reported
console.log("\nmalformed input (allowed — never brick the session):");
check("not an object", mal("pkill") && mal(null) && mal([1]));
check("the verifier with no tool_name / tool_input", mal({ agent_type: AGENT }) && mal({ agent_type: AGENT, tool_name: "Bash", tool_input: "pkill x" }));
check("Bash with no command, Write with no file_path", mal({ agent_type: AGENT, tool_name: "Bash", tool_input: {} }) && mal({ agent_type: AGENT, tool_name: "Write", tool_input: { content: "x" } }));
check("a tool the guard does not judge (Read, Grep) is allowed", allowed({ agent_type: AGENT, tool_name: "Read", tool_input: { file_path: "/proj/src/App.tsx" } }));
check("a non-verifier payload is never inspected (a malformed one from another agent is simply not ours)", decide({ agent_type: "Explore", tool_name: 3 }, CTX) === null);
check("tempRoots() includes os.tmpdir()", tempRoots().includes(os.tmpdir()));

// ---------------------------------------------------------------- the shipped bundle, as the hook runs it
console.log("\nclaude-plugin/scripts/verifier-guard.js (stdin → stdout, exit 0):");
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-guard-"));
const run = (input: string): { code: number | null; stdout: string; stderr: string } => {
  const r = spawnSync(process.execPath, [BUNDLE], { input, cwd, encoding: "utf8", timeout: 15000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};
const outOf = (s: string): unknown => { try { const v: unknown = JSON.parse(s); return v; } catch { return null; } };
{
  const r = run(JSON.stringify(bash("pkill -f vite")));
  const o = outOf(r.stdout);
  const h = isJsonObject(o) && isJsonObject(o.hookSpecificOutput) ? o.hookSpecificOutput : null;
  check("a refused call: exit 0 and only the PreToolUse deny JSON on stdout (hookEventName, permissionDecision deny, a reason)",
    r.code === 0 && h !== null && h.hookEventName === "PreToolUse" && h.permissionDecision === "deny" && typeof h.permissionDecisionReason === "string" && /PID/.test(h.permissionDecisionReason)
    // the prefix the help skill's troubleshooting entry quotes
    && h.permissionDecisionReason.startsWith("designtwin visual-verifier guard: "));
}
{
  const r = run(JSON.stringify(write(path.join(cwd, "src", "App.tsx"))));
  const o = outOf(r.stdout);
  check("a write to app code from the verifier is refused by the bundle too", r.code === 0 && isJsonObject(o) && isJsonObject(o.hookSpecificOutput) && o.hookSpecificOutput.permissionDecision === "deny");
}
for (const [what, input] of [
  ["an allowed verifier call", JSON.stringify(write(path.join(cwd, "design", "verify", "X.measured.json")))],
  ["the same refused command from the main conversation", JSON.stringify(bash("pkill -f vite", {}, null))],
  ["another subagent's npm install", JSON.stringify(bash("npm install", {}, "general-purpose"))],
] as const) {
  const r = run(input);
  check(`${what}: exit 0, nothing on stdout, nothing on stderr`, r.code === 0 && r.stdout === "" && r.stderr === "");
}
for (const [what, input] of [["unparsable JSON", "{\"agent_type\": "], ["empty stdin", ""], ["a JSON array", "[1,2]"],
  ["a verifier payload with no tool_input", JSON.stringify({ agent_type: AGENT, tool_name: "Bash" })]] as const) {
  const r = run(input);
  check(`${what}: allowed (exit 0, empty stdout) and logged to stderr`, r.code === 0 && r.stdout === "" && /verifier-guard: .*allowing the call/.test(r.stderr));
}
{
  const r = spawnSync(process.execPath, [BUNDLE, "--help"], { encoding: "utf8" });
  check("--help prints the usage, exit 0", r.status === 0 && /usage: node .*verifier-guard\.js/.test(r.stdout));
  const stray = spawnSync(process.execPath, [BUNDLE, "--stray"], { input: JSON.stringify(bash("pkill -f vite")), encoding: "utf8" });
  check("a stray argument fails open: exit 0 (never 2, which blocks a PreToolUse call), nothing on stdout, logged to stderr",
    stray.status === 0 && stray.stdout === "" && /unexpected argument --stray .*allowing the call/.test(stray.stderr));
}
await new Promise<void>((resolve) => {
  const t0 = Date.now();
  const c = spawn(process.execPath, [BUNDLE], { cwd, stdio: ["pipe", "pipe", "pipe"] }); // a pipe that never writes and never closes
  let out = "";
  c.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  const kill = setTimeout(() => c.kill("SIGKILL"), 10000);
  c.on("exit", (code) => {
    clearTimeout(kill);
    const ms = Date.now() - t0;
    check(`a silent stdin pipe does not hang the hook: exit ${code} in ${ms} ms (< 4000), nothing on stdout`, code === 0 && ms < 4000 && out === "");
    resolve();
  });
});

// ---------------------------------------------------------------- registration
console.log("\nregistration (hooks.json, the agent's name and tools):");
{
  const hooksDoc: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, "claude-plugin", "hooks", "hooks.json"), "utf8"));
  const pre = isJsonObject(hooksDoc) && isJsonObject(hooksDoc.hooks) && Array.isArray(hooksDoc.hooks.PreToolUse) ? hooksDoc.hooks.PreToolUse : [];
  const entry = pre.find((e) => isJsonObject(e) && Array.isArray(e.hooks) && e.hooks.some((h) => isJsonObject(h) && typeof h.command === "string" && /scripts\/verifier-guard\.js"?$/.test(h.command)));
  const matcher = isJsonObject(entry) && typeof entry.matcher === "string" ? entry.matcher : "";
  const handler = isJsonObject(entry) && Array.isArray(entry.hooks) ? entry.hooks.find((h) => isJsonObject(h) && typeof h.command === "string" && h.command.includes("verifier-guard")) : undefined;
  check("hooks.json runs the bundled verifier-guard.js on PreToolUse, with a timeout above its own 5 s stdin cut-off",
    entry !== undefined && isJsonObject(handler) && handler.type === "command" && typeof handler.timeout === "number" && handler.timeout > 5);
  // Claude Code's matcher rule: only letters, digits, _, -, spaces, `,` and `|` → a list of exact names; anything else → an unanchored regex.
  const matches = (tool: string): boolean => /^[A-Za-z0-9_\- ,|]*$/.test(matcher)
    ? matcher === "" || matcher === "*" || matcher.split(/[|,]/).map((s) => s.trim()).includes(tool)
    : new RegExp(matcher).test(tool);
  const agentMd = fs.readFileSync(path.join(ROOT, "claude-plugin", "agents", "visual-verifier.md"), "utf8");
  const fm = must(/^---\n([\s\S]*?)\n---/.exec(agentMd.replaceAll("\r\n", "\n"))?.[1], "visual-verifier.md frontmatter");
  const tools = must(/^tools:\s*(.+)$/m.exec(fm)?.[1], "tools:").split(",").map((s) => s.trim());
  const name = must(/^name:\s*(\S+)$/m.exec(fm)?.[1], "name:");
  const CHANGES = new Set(["Bash", "PowerShell", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
  const uncovered = tools.filter((t) => CHANGES.has(t) && !matches(t));
  check(`the matcher covers every tool the verifier can change things with (its tools: ${tools.join(", ")})` + (uncovered.length ? ` — NOT: ${uncovered.join(", ")}` : ""), uncovered.length === 0 && tools.includes("Bash") && tools.includes("Write") && matches("PowerShell"));
  check("the matcher does not spawn the hook for read-only tools (Read, Glob, Grep)", !["Read", "Glob", "Grep"].some(matches));
  const pluginDoc: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, "claude-plugin", ".claude-plugin", "plugin.json"), "utf8"));
  const plugin = isJsonObject(pluginDoc) && typeof pluginDoc.name === "string" ? pluginDoc.name : "";
  check(`the guard's agent pattern matches the agent's plugin-scoped name (${plugin}:${name}) and its bare name`, VERIFIER_AGENT.test(`${plugin}:${name}`) && VERIFIER_AGENT.test(name));
}

fs.rmSync(cwd, { recursive: true, force: true });
report();
