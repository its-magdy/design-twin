// The plugin's SessionStart Bun check (claude-plugin/hooks/check-bun.sh) and the failure policy of its hooks
// (claude-plugin/hooks/hooks.json): what a session without a usable Bun is told, and that no hook a missing Bun breaks
// can block the whole session. Binds no port.
//   bun test/plugin-hooks.test.ts
//
// Why fail-open: Claude Code ignores `hooks` in a plugin agent's frontmatter, so the visual-verifier's PreToolUse guard is
// a session-wide entry (Bash|Write|PowerShell for EVERY agent; the guard itself answers only the verifier). With
// onFailure "block", a missing or slow `bun` would refuse every one of those calls in the session. So it fails open, and
// SessionStart says up front that without Bun the verifier is unguarded.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSync } from "../design-to-code/proc.ts";
import { isJsonObject } from "../design-to-code/types.ts";
import { check, report } from "./assert.ts";
import { must } from "./fixtures.ts";
import { SESSION_SOURCES, hookRunsScript, hookRunsShellScript, matcherSelects } from "./plugin-invocation.ts";

const ROOT = path.join(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "claude-plugin", "hooks", "check-bun.sh");
const MIN = "1.4.2";

// ---------------------------------------------------------------- hooks.json: who checks Bun, and what may block
console.log("hooks.json — the Bun check and the failure policy:");
{
  const doc: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, "claude-plugin", "hooks", "hooks.json"), "utf8"));
  const events = isJsonObject(doc) && isJsonObject(doc.hooks) ? doc.hooks : {};
  const entries = (ev: string): unknown[] => { const l = events[ev]; return Array.isArray(l) ? l : []; };
  const handlers = (e: unknown): unknown[] => (isJsonObject(e) && Array.isArray(e.hooks) ? e.hooks : []);
  const start = entries("SessionStart").find((e) => handlers(e).some((h) => hookRunsShellScript(h, "check-bun")));
  const matcher = isJsonObject(start) && typeof start.matcher === "string" ? start.matcher : "";
  check("SessionStart runs the bundled check-bun.sh through sh (it is the check that Bun exists, so it cannot need Bun), quoted",
    start !== undefined);
  const missed = SESSION_SOURCES.filter((s) => !matcherSelects(matcher, s));
  check(`…on every source after which Claude needs the note — ${SESSION_SOURCES.join(", ")} (matcher "${matcher}")` + (missed.length ? ` — NOT: ${missed.join(", ")}` : ""), start !== undefined && missed.length === 0);
  const startHandler = handlers(start).find((h) => hookRunsShellScript(h, "check-bun"));
  check("…with a timeout (a slow `bun --version` must not hold the session start)", isJsonObject(startHandler) && typeof startHandler.timeout === "number" && startHandler.timeout <= 15);
  // No PowerShell twin: a "shell": "powershell" handler fails at every session start on a machine without PowerShell
  // (macOS, Linux) — Claude Code 2.1.306: `has shell: 'powershell' but no PowerShell executable (pwsh or powershell) was
  // found on PATH`. Windows without Git Bash is documented instead.
  check("no SessionStart handler is a PowerShell-only twin (it would error at every macOS/Linux session start)",
    !entries("SessionStart").flatMap(handlers).some((h) => isJsonObject(h) && h.shell === "powershell"));
  // The session-wide entries: whatever matches every agent's tool calls must not block them when the hook cannot run.
  const pre = entries("PreToolUse");
  const blocking = pre.flatMap(handlers).filter((h) => isJsonObject(h) && h.onFailure === "block");
  check(`no PreToolUse handler fails closed (onFailure "block" on a session-wide matcher blocks every call when bun is missing) — ${blocking.length} do`, blocking.length === 0);
  check("…and the verifier guard is still registered there (bun, exec form)", pre.flatMap(handlers).some((h) => hookRunsScript(h, "verifier-guard").ok));
  const desc = isJsonObject(doc) && typeof doc.description === "string" ? doc.description : "";
  check("the description numbers the three hooks (1) SessionStart, (2) SubagentStop, (3) PreToolUse, and says why the guard fails open",
    /\(1\) SessionStart/.test(desc) && /\(2\) SubagentStop/.test(desc) && /\(3\) PreToolUse/.test(desc) && !/\(0\)/.test(desc)
    && /Claude Code ignores `?hooks`? in a plugin agent's frontmatter/.test(desc) && /every Bash, Write and PowerShell call of the whole session/.test(desc)
    && !/onFailure block: when it cannot run/.test(desc));
  // A plugin agent's frontmatter `hooks:` is silently ignored — one there would read as a guard that is not.
  const agentsDir = path.join(ROOT, "claude-plugin", "agents");
  const withHooks = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md")
    && /^hooks:/m.test(must(/^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(path.join(agentsDir, f), "utf8"))?.[1], `${f} frontmatter`)));
  check(`no plugin agent declares frontmatter hooks (Claude Code ignores them for plugin agents)${withHooks.length ? " — " + withHooks.join(", ") : ""}`, withHooks.length === 0);
}

// ---------------------------------------------------------------- check-bun.sh, run as the hook runs it
// A PATH of exactly the tools the script uses, plus a fake `bun` that prints a given version — so the machine's own Bun
// never answers. POSIX only: on Windows the script runs under Git Bash, whose PATH and symlinks this does not model.
if (process.platform === "win32") console.log("\n  (skipped: check-bun.sh behaviour — a POSIX sh script driven through a symlinked PATH)");
else {
  console.log("\ncheck-bun.sh — silent when Bun is new enough, guidance otherwise:");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-checkbun-"));
  const tools = path.join(base, "tools");
  fs.mkdirSync(tools);
  for (const t of ["sh", "head", "tr", "cat", "readlink"]) {
    const where = runSync("sh", ["-c", `command -v ${t}`], { expect: "stdout" }).stdout.trim();
    if (where) fs.symlinkSync(where, path.join(tools, t));
  }
  const home = path.join(base, "home");
  fs.mkdirSync(home);
  // A fake bun printing `version`, in `dir` (relative to base): `dir` is where an install method puts it.
  let n = 0;
  const fakeBun = (version: string, dir = "bin"): string => {
    const d = path.join(base, `f${n++}`, dir);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "bun"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
    return d;
  };
  const run = (binDir: string | null, h = home) => {
    const r = runSync(path.join(tools, "sh"), [SCRIPT], { env: { PATH: (binDir ? binDir + path.delimiter : "") + tools, HOME: h }, timeoutMs: 10_000 });
    let json: unknown = null;
    try { json = r.stdout.trim() ? JSON.parse(r.stdout) as unknown : null; } catch { json = "unparsable"; }
    const sys = isJsonObject(json) && typeof json.systemMessage === "string" ? json.systemMessage : "";
    const hso = isJsonObject(json) && isJsonObject(json.hookSpecificOutput) ? json.hookSpecificOutput : null;
    const ctx = hso && typeof hso.additionalContext === "string" ? hso.additionalContext : "";
    return { r, json, sys, ctx, event: hso?.hookEventName };
  };
  for (const v of [MIN, "1.4.3", "1.5.0", "2.0.0", "1.4.3-canary.20261019.1", "1.4.2+build.7"]) {
    const o = run(fakeBun(v));
    check(`bun ${v}: silent — exit 0, nothing printed`, o.r.status === 0 && o.r.stdout === "" && !o.r.lost);
  }
  for (const v of ["1.4.1", "1.3.9", "0.9.0", "1.4.2-canary.20261019.1", "1.4.2-canary.1+abc"]) {
    const o = run(fakeBun(v));
    check(`bun ${v}: below ${MIN} (a canary of ${MIN} is a pre-release of it) — one JSON object naming the version and \`bun upgrade\`, exit 0`,
      o.r.status === 0 && isJsonObject(o.json) && o.sys.includes(`Bun ${v} is older than ${MIN} — run: bun upgrade`) && o.event === "SessionStart");
  }
  {
    const o = run(fakeBun("1.4.1"));
    check("the upgrade advice also names every other install method (Homebrew, npm, Scoop, the official installer)",
      /brew upgrade bun/.test(o.sys) && /npm install -g bun@latest/.test(o.sys) && /scoop update bun/.test(o.sys) && /official installer: bun upgrade/.test(o.sys));
    check("…and both messages say the visual-verifier's guard cannot run without Bun (its calls would go unchecked)",
      /visual-verifier's safety guard cannot run/.test(o.sys) && /PreToolUse guard \(verifier-guard\.js\) needs Bun too/.test(o.ctx) && /NOT guarded/.test(o.ctx));
  }
  for (const [dir, cmd] of [["opt/homebrew/Cellar/bun/1.4.1/bin", "brew upgrade bun"], ["usr/lib/node_modules/bun/bin", "npm install -g bun@latest"], ["Users/me/scoop/shims", "scoop update bun"]] as const) {
    const o = run(fakeBun("1.4.1", dir));
    check(`a bun under …/${dir}: the advice leads with \`${cmd}\``, o.sys.includes(`older than ${MIN} — run: ${cmd} (`));
  }
  {
    // Homebrew's /usr/local/bin/bun is a symlink into ../Cellar: told by where it points.
    const cellar = fakeBun("1.4.1", "usr/local/Cellar/bun/1.4.1/bin");
    const bin = path.join(base, "linked", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync(path.join(cellar, "bun"), path.join(bin, "bun"));
    check("a bun that is a symlink into a Homebrew Cellar: `brew upgrade bun`", run(bin).sys.includes("run: brew upgrade bun ("));
  }
  {
    const o = run(null);
    check("no bun at all: install guidance (https://bun.sh/install, the curl and PowerShell one-liners, brew/npm/Scoop), as valid JSON, exit 0",
      o.r.status === 0 && isJsonObject(o.json) && /bun is not on PATH/.test(o.sys) && /https:\/\/bun\.sh\/install/.test(o.sys)
      && /curl -fsSL https:\/\/bun\.sh\/install \| bash/.test(o.sys) && /irm bun\.sh\/install\.ps1 \| iex/.test(o.sys) && /brew install/.test(o.sys) && /verify/.test(o.ctx));
    const h2 = path.join(base, "home2");
    fs.mkdirSync(path.join(h2, ".bun", "bin"), { recursive: true });
    fs.writeFileSync(path.join(h2, ".bun", "bin", "bun"), "#!/bin/sh\necho 1.4.3\n", { mode: 0o755 });
    const o2 = run(null, h2);
    check("bun in ~/.bun/bin but not on Claude Code's PATH: says so (start Claude Code from a new terminal)", /installed in ~\/\.bun\/bin but is not on the PATH/.test(o2.sys) && isJsonObject(o2.json));
  }
  fs.rmSync(base, { recursive: true, force: true });
}

report();
