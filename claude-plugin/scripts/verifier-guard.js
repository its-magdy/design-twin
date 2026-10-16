// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.


// design-to-code/verifier-guard.ts
import fs3 from "node:fs";
import os from "node:os";

// design-to-code/hook-input.ts
import fs from "node:fs";

// design-to-code/types.ts
function isJsonObject(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// design-to-code/hook-input.ts
function parseHookPayload(raw) {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return isJsonObject(v) ? v : {};
  } catch {
    return {};
  }
}
function readHookInput(opts) {
  if (process.stdin.isTTY) return Promise.resolve({ payload: {}, source: "tty" });
  let st;
  try {
    st = fs.fstatSync(0);
  } catch {
    return Promise.resolve({ payload: {}, source: "closed" });
  }
  if (st.isFile() || st.isCharacterDevice()) {
    try {
      return Promise.resolve({ payload: parseHookPayload(fs.readFileSync(0, "utf8")), source: "file" });
    } catch {
      return Promise.resolve({ payload: {}, source: "unreadable" });
    }
  }
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0, finished = false;
    const done = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(first);
      clearTimeout(hard);
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      try {
        process.stdin.pause();
        process.stdin.unref && process.stdin.unref();
      } catch {
      }
      resolve(value);
    };
    const first = setTimeout(() => {
      if (!bytes) done({ payload: {}, source: "silent-pipe" });
    }, opts.waitMs);
    const hard = setTimeout(() => done({ error: opts.stalled(bytes) }), opts.hardMs);
    process.stdin.on("data", (c) => {
      bytes += c.length;
      chunks.push(c);
    });
    process.stdin.on("end", () => done({ payload: parseHookPayload(Buffer.concat(chunks).toString("utf8")), source: "pipe" }));
    process.stdin.on("error", () => done({ payload: {}, source: "error" }));
    process.stdin.resume();
  });
}

// design-to-code/shell-words.ts
function simpleCommands(src, opts = {}) {
  const ps = opts.powershell === true;
  const cmds = [];
  const stack = [];
  let words = [], word = "", inWord = false, quote = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCmd = () => {
    endWord();
    if (words.length) cmds.push(words);
    words = [];
  };
  const open = (closer, start) => {
    stack.push({ words, word, inWord, quote, closer, start });
    words = [];
    word = "";
    inWord = false;
    quote = null;
  };
  const close = (end) => {
    endCmd();
    const f = stack.pop();
    if (!f) return;
    ({ words, word, quote } = f);
    word += src.slice(f.start, end + 1);
    inWord = true;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src.charAt(i);
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    const top = stack[stack.length - 1];
    if (c === "`" && ps) {
      if (i + 1 < src.length) {
        word += src.charAt(++i);
        inWord = true;
      }
      continue;
    }
    if (c === "`") {
      if (top?.closer === "`") close(i);
      else open("`", i);
      continue;
    }
    if (c === "$" && src.charAt(i + 1) === "(") {
      open(")", i);
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && !ps && '$`"\\\n'.includes(src.charAt(i + 1)) && i + 1 < src.length) word += src.charAt(++i);
      else word += c;
      continue;
    }
    if (c === ")" && top?.closer === ")") {
      close(i);
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === "\\" && !ps) {
      if (i + 1 < src.length && src.charAt(i + 1) !== "\n") {
        word += src.charAt(i + 1);
        inWord = true;
      }
      i++;
      continue;
    }
    if (c === "#" && !inWord) {
      while (i + 1 < src.length && src.charAt(i + 1) !== "\n") i++;
      continue;
    }
    if (";&|\n()".includes(c)) {
      endCmd();
      continue;
    }
    if (/\s/.test(c)) {
      endWord();
      continue;
    }
    word += c;
    inWord = true;
  }
  while (stack.length) close(src.length - 1);
  endCmd();
  return cmds;
}

// design-to-code/cli-args.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
var SELF = fileURLToPath(import.meta.url);
var shellQuote = (p) => /["$`\\!]/.test(p) ? `'${p.replaceAll("'", `'\\''`)}'` : `"${p}"`;
var scriptCmd = (name) => `node ${shellQuote(path.join(path.dirname(SELF), name + path.extname(SELF)))}`;

// bridge/src/is-main.ts
import fs2 from "node:fs";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function isMainFallback(metaUrl) {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return fs2.realpathSync(argv1) === fs2.realpathSync(fileURLToPath2(metaUrl));
  } catch {
    return false;
  }
}

// design-to-code/verifier-guard.ts
var VERIFIER_AGENT = /^(designtwin:)?visual-verifier$/;
var HOOK_WAIT_MS = 1e3;
var HOOK_HARD_MS = 5e3;
var TOOL_OWNED = /(^\.migrate-.+\.json|\.(expected(\.prev)?\.json|report\.json|report\.md|status\.json|diff\.png))$/i;
var CACHE_RUN = ["node_modules", ".cache", "designtwin-verify"];
var VERIFY_DIR = ["design", "verify"];
function segments(p, cwd) {
  const norm = (s) => s.replaceAll("\\", "/");
  const abs = (s) => s.startsWith("/") || /^[A-Za-z]:\//.test(s);
  const full = abs(norm(p)) ? norm(p) : norm(cwd) + "/" + norm(p);
  const out = [];
  for (const s of full.toLowerCase().split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return out;
}
function after(segs, want) {
  for (let i = 0; i + want.length < segs.length; i++) if (want.every((w, j) => segs[i + j] === w)) return i + want.length;
  return -1;
}
var startsWith = (segs, root) => root.length > 0 && root.length <= segs.length && root.every((r, i) => segs[i] === r);
function writeVerdict(file, ctx) {
  const segs = segments(file, ctx.cwd);
  if (after(segs, CACHE_RUN) >= 0) return null;
  for (const root of ctx.tmpRoots) {
    const r = segments(root, "/");
    if (startsWith(segs, r) && after(segs.slice(r.length), ["designtwin-verify"]) >= 0) return null;
  }
  if (after(segs, VERIFY_DIR) >= 0) {
    if (!TOOL_OWNED.test(segs[segs.length - 1] ?? "")) return null;
    return `${file} is the verify tools' own (the expectation, report, status, diff and migration journal), never written by hand. Report progress with \`${scriptCmd("verify-screen")} --status <Screen> --phase <phase> --run <id>\`; the caller runs --expect and --compare.`;
  }
  return `the visual-verifier measures, it never edits app code: it writes only design/verify/ (its measured file and screenshots) and the run cache node_modules/.cache/designtwin-verify/ (stage/<runId>/ for evidence, scratch/ for throwaway scripts). ${file} is outside both. Put a scratch script in node_modules/.cache/designtwin-verify/scratch/, and report a defect in the build as a measurement or a note \u2014 never fix it.`;
}
var prog = (w) => (w.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
var isAssign = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
function firstArg(words, from, valued = /* @__PURE__ */ new Set()) {
  let i = from;
  while (i < words.length) {
    const w = words[i] ?? "";
    if (w === "--") return i + 1;
    if (!w.startsWith("-") || w === "-") return i;
    i += valued.has(w) ? 2 : 1;
  }
  return i;
}
var WRAPPER_VALUED = {
  sudo: /* @__PURE__ */ new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"]),
  env: /* @__PURE__ */ new Set(["-u", "-C", "-S", "--unset", "--chdir"]),
  nice: /* @__PURE__ */ new Set(["-n"]),
  timeout: /* @__PURE__ */ new Set(["-s", "-k", "--signal", "--kill-after"]),
  xargs: /* @__PURE__ */ new Set(["-n", "-I", "-L", "-P", "-d", "-E", "-s", "-a", "-i", "--max-args", "--max-procs", "--delimiter", "--arg-file", "--replace"]),
  doas: /* @__PURE__ */ new Set(["-u", "-C"]),
  nohup: /* @__PURE__ */ new Set(),
  command: /* @__PURE__ */ new Set(),
  builtin: /* @__PURE__ */ new Set(),
  exec: /* @__PURE__ */ new Set(),
  time: /* @__PURE__ */ new Set(),
  stdbuf: /* @__PURE__ */ new Set(),
  setsid: /* @__PURE__ */ new Set()
};
var SHELLS = /* @__PURE__ */ new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
var NPM_DEPS = /* @__PURE__ */ new Set([
  "install",
  "i",
  "in",
  "ins",
  "inst",
  "insta",
  "instal",
  "isnt",
  "isnta",
  "isntal",
  "isntall",
  "add",
  "ci",
  "clean-install",
  "ic",
  "install-clean",
  "isntall-clean",
  "install-test",
  "it",
  "install-ci-test",
  "cit",
  "clean-install-test",
  "sit",
  "update",
  "up",
  "upgrade",
  "udpate",
  "uninstall",
  "unlink",
  "remove",
  "rm",
  "r",
  "un",
  "dedupe",
  "ddp",
  "prune",
  // `npm init <initializer>` / `npm create …` runs create-<initializer>: `npm init playwright@latest` is Playwright's own installer
  "init",
  "create",
  "innit"
]);
var PNPM_DEPS = /* @__PURE__ */ new Set(["install", "i", "add", "update", "up", "upgrade", "remove", "rm", "un", "uninstall", "prune", "dedupe", "install-test", "it", "ci", "fetch", "import", "create"]);
var YARN_DEPS = /* @__PURE__ */ new Set(["install", "add", "remove", "up", "upgrade", "upgrade-interactive", "dedupe", "create"]);
var BUN_DEPS = /* @__PURE__ */ new Set(["install", "i", "add", "a", "remove", "rm", "update", "create"]);
var NPM_VALUED = /* @__PURE__ */ new Set(["--prefix", "-C", "--workspace", "-w", "--loglevel", "--cache", "--userconfig", "--globalconfig", "--registry", "--tag", "--omit", "--include", "--before", "--otp", "--scope"]);
var PNPM_VALUED = /* @__PURE__ */ new Set(["-C", "--dir", "--filter", "-F", "--loglevel", "--reporter", "--registry", "--store-dir"]);
var YARN_VALUED = /* @__PURE__ */ new Set(["--cwd", "--cache-folder", "--modules-folder", "--global-folder", "--registry", "--network-timeout"]);
var BUN_VALUED = /* @__PURE__ */ new Set(["--cwd", "--config", "-c"]);
var NPX_VALUED = /* @__PURE__ */ new Set(["-p", "--package", "--call", "-c", "--cache", "--registry", "--userconfig"]);
var PLAYWRIGHT_PKG = /^(@playwright\/test|playwright|playwright-core|playwright-chromium)(@.*)?$/;
var PID_LOOKUPS = /* @__PURE__ */ new Set(["pgrep", "pidof", "lsof", "ps", "fuser"]);
var PS_LOOKUPS = /* @__PURE__ */ new Set(["get-process", "gps", "get-nettcpconnection", "get-netudpconnection", "get-ciminstance", "get-wmiobject", "netstat", "tasklist"]);
var POWERSHELLS = /* @__PURE__ */ new Set(["pwsh", "powershell"]);
var PLAYWRIGHT_CLI = /(^|[\\/])(@playwright[\\/][^\\/]+|playwright[^\\/]*)[\\/]cli\.js$/i;
function parentOnly(args) {
  let parent = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    const next = args[i + 1] ?? "";
    if ((a === "-P" || a === "--parent") && /^\d+(,\d+)*$/.test(next)) {
      parent = true;
      i++;
      continue;
    }
    if (/^(-P|--parent=)\d+(,\d+)*$/.test(a)) {
      parent = true;
      continue;
    }
    if (a === "--signal" && next) {
      i++;
      continue;
    }
    if (/^(--signal=\S+|-\d+|-(SIG)?[A-Z]+[0-9]*)$/.test(a)) continue;
    return false;
  }
  return parent;
}
function lookupByPattern(text, ps = false) {
  return simpleCommands(text, { powershell: ps }).some((w) => {
    const p = prog(w[0] ?? "");
    if ((p === "get-process" || p === "gps") && /^-(id|pid)$/i.test(w[1] ?? "") && w.length === 3) return false;
    return PID_LOOKUPS.has(p) || PS_LOOKUPS.has(p) ? !(p === "pgrep" && parentOnly(w.slice(1))) : false;
  });
}
function psStopIsPatternKill(args, line) {
  if (args.some((a) => /^-(na|nam|name|pr|pro|proc|proce|proces|process|processn|processna|processnam|processname)(:.*)?$/i.test(a))) return true;
  const ids = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (/^-(id|pid)$/i.test(a)) {
      if (i + 1 < args.length) ids.push(args[++i] ?? "");
      continue;
    }
    if (/^-(id|pid):/i.test(a)) {
      ids.push(a);
      continue;
    }
    if (!a.startsWith("-")) ids.push(a);
  }
  const fed = ids.length === 0 || ids.some((w) => (w.includes("$(") || w.includes("`")) && lookupByPattern(w, true));
  return fed && lookupByPattern(line, true);
}
function killsEverything(args) {
  if (args.length === 1 && args[0] === "-1") return true;
  const pids = [];
  let signal = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--") {
      pids.push(...args.slice(i + 1));
      break;
    }
    if (a === "-s" || a === "-n") {
      signal = true;
      i++;
      continue;
    }
    if (a.startsWith("-") && !signal) {
      signal = true;
      continue;
    }
    pids.push(a);
  }
  return pids.some((p) => p === "-1" || p === "0" || p === "-0");
}
var REASON = {
  kill: "pattern kills (pkill, killall, fuser -k, taskkill /IM, Stop-Process -Name / Get-Process \u2026 | Stop-Process, a kill fed by pgrep/pidof/lsof/ps, kill -1 / kill 0) take down the user's own servers and editors. Close only what you opened: stop only a PID you started and recorded (`kill <pid>`) \u2014 its whole tree with `kill -- -<pgid>` (the process group you started) or its children with `pkill -P <pid>` \u2014 and reuse a dev server the user already runs (PowerShell: `Stop-Process -Id <pid>`).",
  install: "installing or reinstalling dependencies is the user's call, never the verifier's \u2014 and `npm ci`/`npm install` clear node_modules/.cache, the live status and your staged evidence with it. Write status `blocked` with the command as the detail and hand it back to the caller.",
  playwright: `installing Playwright or its browsers is the user's call (it edits the project's dependencies and downloads ~150 MB). No usable renderer (\`${scriptCmd("verify-probe")} --check\` exit 3): stop and ask the user, with the install line the probe printed and its cost.`,
  sandbox: 'a permission denial is not a sandbox violation: never bypass the sandbox. Retry a transient no-verdict denial unchanged (at most twice); otherwise write status `blocked` and hand back "blocked on permissions: done / remaining" with a narrow allow rule for the owner to add.',
  migrate: "`verify-screen --migrate` renames verify sets and rewrites the plans in design/plan/ \u2014 the caller's call, never the verifier's. Name the legacy-named set (and its node id) in your hand-back instead."
};
var VERIFY_SCREEN = /(^|[\\/])verify-screen\.[cm]?[jt]s$/i;
var SCRIPT_RUNNERS = /* @__PURE__ */ new Set(["node", "bun", "deno", "tsx", "ts-node", "npx", "pnpx", "bunx", "yarn", "pnpm", "npm"]);
function runsMigrate(words, p) {
  const s = words.findIndex((w) => VERIFY_SCREEN.test(w));
  return s >= 0 && (s === 0 || SCRIPT_RUNNERS.has(p)) && words.slice(s + 1).some((w) => w === "--migrate" || w.startsWith("--migrate="));
}
var playwrightInstall = (words, i) => {
  const sub = words[firstArg(words, i)] ?? "";
  return sub === "install" || sub === "install-deps";
};
function commandVerdict(cmd, line, depth, ps) {
  let words = ps ? unbrace(cmd) : cmd;
  let viaXargs = false;
  for (let guard = 0; guard < 8; guard++) {
    let i = 0;
    while (i < words.length && isAssign(words[i] ?? "")) i++;
    words = words.slice(i);
    const p2 = prog(words[0] ?? "");
    const valued = WRAPPER_VALUED[p2];
    if (!valued) break;
    if (p2 === "xargs") viaXargs = true;
    let j = firstArg(words, 1, valued);
    if (p2 === "env") while (j < words.length && isAssign(words[j] ?? "")) j++;
    if (p2 === "timeout") j++;
    words = words.slice(j);
  }
  if (ps) words = unbrace(words);
  const p = prog(words[0] ?? "");
  const args = words.slice(1);
  if (!p) return null;
  if (runsMigrate(words, p)) return REASON.migrate;
  if (SHELLS.has(p)) {
    const c = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a) || a === "--command");
    const body = c >= 0 ? args[c + 1] === "--" ? args[c + 2] : args[c + 1] : void 0;
    return body !== void 0 && depth < 4 ? bashVerdict(body, depth + 1) : null;
  }
  if (p === "eval") return depth < 4 ? bashVerdict(args.join(" "), depth + 1) : null;
  if (p === "iex" || p === "invoke-expression") return depth < 4 ? bashVerdict(args.join(" "), depth + 1, true) : null;
  if (POWERSHELLS.has(p)) {
    const body = psCommandBody(args);
    return body && depth < 4 ? bashVerdict(body, depth + 1, true) : null;
  }
  if (p === "cmd") {
    const c = args.findIndex((a) => /^\/[ck]$/i.test(a));
    return c >= 0 && depth < 4 ? bashVerdict(args.slice(c + 1).join(" "), depth + 1, true) : null;
  }
  if (p === "killall" || p === "pkill" && !parentOnly(args)) return REASON.kill;
  if (p === "fuser" && args.some((a) => /^-[a-z]*k/i.test(a))) return REASON.kill;
  if (p === "taskkill" && args.some((a) => /^(\/\/?|-)(im|fi)$/i.test(a))) return REASON.kill;
  if (p === "stop-process" || p === "spps") return psStopIsPatternKill(args, line) ? REASON.kill : null;
  if (p === "kill") {
    if (ps && psStopIsPatternKill(args, line)) return REASON.kill;
    if (killsEverything(args)) return REASON.kill;
    if (viaXargs && lookupByPattern(line)) return REASON.kill;
    if (args.some((a) => (a.includes("$(") || a.includes("`")) && lookupByPattern(a))) return REASON.kill;
    return null;
  }
  if (p === "npm") {
    const s = firstArg(words, 1, NPM_VALUED);
    const sub = (words[s] ?? "").toLowerCase();
    if (NPM_DEPS.has(sub)) return createsPlaywright(words, s) ? REASON.playwright : REASON.install;
    if (sub === "exec" || sub === "x") return npxVerdict(words, s + 1);
    return null;
  }
  if (p === "npx" || p === "pnpx" || p === "bunx") return npxVerdict(words, 1);
  if (p === "pnpm") {
    const s = firstArg(words, 1, PNPM_VALUED);
    const sub = (words[s] ?? "").toLowerCase();
    if (PNPM_DEPS.has(sub)) return createsPlaywright(words, s) ? REASON.playwright : REASON.install;
    if (sub === "dlx" || sub === "exec" || sub === "x") return npxVerdict(words, s + 1);
    return PLAYWRIGHT_PKG.test(sub) && playwrightInstall(words, s + 1) ? REASON.playwright : null;
  }
  if (p === "yarn") {
    let s = firstArg(words, 1, YARN_VALUED);
    if ((words[s] ?? "").toLowerCase() === "workspace" && s + 2 < words.length) s += 2;
    const sub = (words[s] ?? "").toLowerCase();
    if (s >= words.length && !args.some((a) => /^(-v|--version|-h|--help)$/.test(a))) return REASON.install;
    if (YARN_DEPS.has(sub)) return createsPlaywright(words, s) ? REASON.playwright : REASON.install;
    if (sub === "dlx" || sub === "exec") return npxVerdict(words, s + 1);
    return PLAYWRIGHT_PKG.test(sub) && playwrightInstall(words, s + 1) ? REASON.playwright : null;
  }
  if (p === "bun") {
    const s = firstArg(words, 1, BUN_VALUED);
    const sub = (words[s] ?? "").toLowerCase();
    if (BUN_DEPS.has(sub)) return createsPlaywright(words, s) ? REASON.playwright : REASON.install;
    if (sub === "x") return npxVerdict(words, s + 1);
    return null;
  }
  if (PLAYWRIGHT_PKG.test(p) && playwrightInstall(words, 1)) return REASON.playwright;
  if (p === "node") {
    const s = firstArg(words, 1);
    if (PLAYWRIGHT_CLI.test(words[s] ?? "") && playwrightInstall(words, s + 1)) return REASON.playwright;
  }
  return null;
}
var createsPlaywright = (words, s) => {
  const sub = (words[s] ?? "").toLowerCase();
  return (sub === "init" || sub === "innit" || sub === "create") && /^(create-)?playwright(@.*)?$/i.test(words[firstArg(words, s + 1)] ?? "");
};
function npxVerdict(words, from) {
  const c = words.findIndex((w, k) => k >= from && (w === "-c" || w === "--call"));
  if (c >= 0 && words[c + 1] !== void 0) return bashVerdict(words[c + 1] ?? "", 1);
  const s = firstArg(words, from, NPX_VALUED);
  const pkg = (words[s] ?? "").toLowerCase();
  if (/^create-playwright(@.*)?$/.test(pkg)) return REASON.playwright;
  return PLAYWRIGHT_PKG.test(pkg) && playwrightInstall(words, s + 1) ? REASON.playwright : null;
}
function bashVerdict(command, depth = 0, ps = false) {
  for (const cmd of simpleCommands(command, { powershell: ps })) {
    const v = commandVerdict(cmd, command, depth, ps);
    if (v) return v;
  }
  return null;
}
function psCommandBody(args) {
  const c = args.findIndex((a) => /^-c(o(m(m(a(nd?)?)?)?)?)?$/i.test(a));
  return (c >= 0 ? args.slice(c + 1) : args.filter((a, k) => !a.startsWith("-") && !/^-(f|file)$/i.test(args[k - 1] ?? ""))).join(" ");
}
function unbrace(words) {
  const out = words.filter((w) => w !== "{" && w !== "}");
  if (out.length) {
    out[0] = (out[0] ?? "").replace(/^\{+/, "");
    out[out.length - 1] = (out[out.length - 1] ?? "").replace(/\}+$/, "");
  }
  return out;
}
var FILE_TOOLS = { Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };
function decide(payload, ctx) {
  if (!isJsonObject(payload)) return { malformed: "the payload is not a JSON object" };
  const agent = payload.agent_type;
  if (typeof agent !== "string" || !VERIFIER_AGENT.test(agent)) return null;
  const tool = payload.tool_name;
  const input = payload.tool_input;
  if (typeof tool !== "string" || !isJsonObject(input)) return { malformed: `a ${agent} call with no tool_name/tool_input` };
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : ctx.cwd;
  const here = { cwd, tmpRoots: ctx.tmpRoots };
  if (tool === "Bash" || tool === "PowerShell") {
    if (input.dangerouslyDisableSandbox === true) return { deny: REASON.sandbox };
    if (typeof input.command !== "string") return { malformed: `a ${tool} call with no command` };
    const v = bashVerdict(input.command, 0, tool === "PowerShell");
    return v ? { deny: v } : null;
  }
  const key = FILE_TOOLS[tool];
  if (key) {
    const file = input[key];
    if (typeof file !== "string" || !file) return { malformed: `a ${tool} call with no ${key}` };
    const v = writeVerdict(file, here);
    return v ? { deny: v } : null;
  }
  return null;
}
function tempRoots(env = process.env) {
  const roots = [os.tmpdir(), env.TMPDIR, env.TEMP, env.TMP];
  try {
    roots.push(fs3.realpathSync(os.tmpdir()));
  } catch {
  }
  if (process.platform !== "win32") roots.push("/tmp", "/private/tmp", "/var/folders", "/private/var/folders");
  return [...new Set(roots.filter((r) => typeof r === "string" && r !== ""))];
}
function denyOutput(reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `designtwin visual-verifier guard: ${reason}` } };
}
var USAGE = [
  `usage: ${scriptCmd("verifier-guard")}        (PreToolUse hook: reads the hook JSON from stdin when stdin is not a terminal)`,
  "",
  "Refuses, for the designtwin:visual-verifier subagent only: a file write outside design/verify/ and the run cache",
  "(node_modules/.cache/designtwin-verify/), or to a tool-owned file in design/verify/; a pattern kill (pkill, killall, \u2026);",
  "a dependency install or a Playwright browser install; a Bash or PowerShell call with dangerouslyDisableSandbox;",
  "verify-screen --migrate (it renames verify sets and rewrites plans).",
  "(A PowerShell call is judged like a Bash one; as for Bash, the files a command writes are not read.)",
  'A refusal is {"hookSpecificOutput":{"permissionDecision":"deny",\u2026}} on stdout; every answer exits 0.',
  "A call from any other agent, or a payload it cannot read, is allowed (the latter logged to stderr)."
].join("\n");
async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  if (argv.length) {
    console.error(`verifier-guard: unexpected argument ${argv.join(" ")} \u2014 ignored, allowing the call
${USAGE}`);
    return 0;
  }
  const r = await readHookInput({ waitMs: HOOK_WAIT_MS, hardMs: HOOK_HARD_MS, stalled: (bytes) => `no end-of-file on stdin after ${HOOK_HARD_MS / 1e3} s (${bytes} byte(s) received)` });
  if (r.error || !r.payload) {
    console.error(`verifier-guard: ${r.error ?? "no hook payload"} \u2014 allowing the call`);
    return 0;
  }
  if (!Object.keys(r.payload).length) {
    console.error(`verifier-guard: no hook payload on stdin (${r.source ?? "?"}) \u2014 allowing the call`);
    return 0;
  }
  const d = decide(r.payload, { cwd: process.cwd(), tmpRoots: tempRoots() });
  if (d && "malformed" in d) console.error(`verifier-guard: ${d.malformed} \u2014 allowing the call`);
  else if (d) console.log(JSON.stringify(denyOutput(d.deny)));
  return 0;
}
if (import.meta.main ?? isMainFallback(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (e) => {
    console.error(`verifier-guard: ${e instanceof Error && e.stack || String(e)} \u2014 allowing the call`);
    process.exitCode = 0;
  });
}
export {
  USAGE,
  VERIFIER_AGENT,
  bashVerdict,
  decide,
  denyOutput,
  main,
  tempRoots,
  writeVerdict
};
