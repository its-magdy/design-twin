// `dtwin init` — one command to set a PROJECT up for Design Twin, run from that project's root.
//
// Before this, onboarding was eleven manual steps across four docs: create design/, hand-write
// target.json, find the bridge token, hand-write a .mcp.json with an absolute path, remember the two
// `claude plugin` commands. Each is small; together they are where a new user gives up. init does
// every one that can be done from a terminal and PRINTS the two that cannot (importing the plugin
// into Figma and pasting the token are clicks in Figma's UI — nothing can do them for you).
//
// Rules it keeps:
//   - Never overwrites. Every file it would write is skipped, and said so, if it already exists;
//     .mcp.json is MERGED (an existing "figma" entry is left exactly as it is).
//   - Needs no bridge, no plugin, no port: it only touches the project directory and the per-user
//     token file, so it works while a daemon or the MCP server holds 8787.
//   - The MCP registration is opt-in (--mcp): the MCP server binds the same port as the CLI, so a
//     project that registers it can no longer run one-shot `dtwin` pulls while Claude Code is open —
//     a trade-off the user should choose, not inherit from a setup command.
//
//   dtwin init            # design/, design/target.json (detected stack), bridge token, next steps
//   dtwin init --mcp      # …and register the MCP server in ./.mcp.json
//   dtwin init --dry-run  # say what it would do, write nothing

const fs = require("fs");
const path = require("path");
const tokenStore = require("./token-store.js");

// The key the MCP server is registered under in .mcp.json — matches the server's own name
// (bridge/src/figma-mcp.mts), so its tools surface as mcp__designtwin__figma_status etc.
const MCP_KEY = "designtwin";

// Is this .mcp.json entry Design Twin's server, under ANY key? It points at figma-mcp.mjs, or runs
// `designtwin mcp` (the npx form). One rule for init (don't double-register) and doctor (report it).
const isOurMcpEntry = (e) => !!e && Array.isArray(e.args) && (e.args.some((a) => /(^|[\\/])figma-mcp\.mjs$/.test(String(a))) || (e.args.includes("designtwin") && e.args.includes("mcp")));

// Same detection order build-screen's step 0 documents — first match wins, most specific first.
function detectProfile(cwd) {
  const has = (f) => fs.existsSync(path.join(cwd, f));
  const read = (f) => { try { return fs.readFileSync(path.join(cwd, f), "utf8"); } catch { return ""; } };
  const ls = (() => { try { return fs.readdirSync(cwd); } catch { return []; } })();
  let pkg = null;
  try { pkg = JSON.parse(read("package.json")); } catch { /* no/invalid package.json */ }
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps["react-native"] || deps.expo) return { profile: "react-native", because: "react-native/expo in package.json" };
    if (deps.tailwindcss || deps["@tailwindcss/vite"] || deps["@tailwindcss/postcss"]) return { profile: "web-tailwind", because: "tailwindcss in package.json" };
  }
  if (has("pubspec.yaml") && /^\s*flutter\s*:/m.test(read("pubspec.yaml"))) return { profile: "flutter", because: "flutter in pubspec.yaml" };
  if (has("Package.swift") || ls.some((f) => f.endsWith(".xcodeproj") || f.endsWith(".xcworkspace"))) return { profile: "swiftui", because: "an Xcode project / Package.swift" };
  for (const g of ["build.gradle.kts", "build.gradle", "app/build.gradle.kts", "app/build.gradle"]) {
    if (/compose/i.test(read(g))) return { profile: "android-compose", because: "Compose in " + g };
  }
  if (pkg) return { profile: "web-css-modules", because: "a package.json with no Tailwind/React Native (the generic web profile)" };
  return null;
}

// Pure planner: what init WOULD do in `cwd`. Returns { actions:[{kind, path?, content?, note}], steps:[…] }.
// Split from the writer so the test suite can assert the plan without touching a real HOME.
function plan(cwd, { mcp = false, mcpEntry, token } = {}) {
  const actions = [];
  const rel = (p) => path.relative(cwd, p) || ".";

  const designDir = path.join(cwd, "design");
  actions.push(fs.existsSync(designDir) ? { kind: "skip", path: rel(designDir), note: "exists" } : { kind: "mkdir", path: rel(designDir), note: "where exports land" });

  const targetFile = path.join(designDir, "target.json");
  if (fs.existsSync(targetFile)) actions.push({ kind: "skip", path: rel(targetFile), note: "exists — left as is" });
  else {
    const d = detectProfile(cwd);
    if (d) actions.push({ kind: "write", path: rel(targetFile), content: JSON.stringify({ profile: d.profile }, null, 2) + "\n", note: `stack detected: ${d.profile} (${d.because})` });
    else actions.push({ kind: "skip", path: rel(targetFile), note: "no stack detected here — build-screen will ask on first run" });
  }

  // design/ holds regenerable exports; the hand-authored maps in it are NOT regenerable. Say so where
  // the user will see it, rather than editing their .gitignore for them.
  const gi = path.join(cwd, ".gitignore");
  const ignored = fs.existsSync(gi) && /^\/?design\/?\s*$/m.test(fs.readFileSync(gi, "utf8"));
  if (ignored) actions.push({ kind: "note", note: ".gitignore ignores design/ — target.json and your token/component maps in it are hand-authored; un-ignore them (!design/target.json) or they won't be committed" });

  if (mcp) {
    const file = path.join(cwd, ".mcp.json");
    let doc = {};
    let bad = false;
    if (fs.existsSync(file)) { try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch { bad = true; } }
    if (bad) actions.push({ kind: "skip", path: rel(file), note: "exists but is not valid JSON — fix it, then re-run with --mcp" });
    else {
      // Registered as "designtwin", never "figma": that is the name Figma's own MCP server is usually
      // given, and Claude Code loads only one server per name — sharing it would silently drop one.
      const servers = doc.mcpServers || {};
      // Ours under ANY key (older inits wrote "figma"): a second entry would start a second server
      // and the two would fight over port 8787.
      const mine = Object.keys(servers).find((k) => isOurMcpEntry(servers[k]));
      if (mine) actions.push({ kind: "skip", path: rel(file), note: `Design Twin's MCP server is already registered as "${mine}" — left as is` });
      else if (servers[MCP_KEY]) actions.push({ kind: "skip", path: rel(file), note: `already has a "${MCP_KEY}" server that is not Design Twin's — left as is` });
      else {
        const next = { ...doc, mcpServers: { ...servers, [MCP_KEY]: mcpEntry } };
        // merge:true — the ONE write allowed onto an existing file: it re-serialises the user's own
        // document with one key added. Everything else is written with "wx" and cannot clobber.
        actions.push({ kind: "write", merge: fs.existsSync(file), path: rel(file), content: JSON.stringify(next, null, 2) + "\n", note: `registered the "${MCP_KEY}" MCP server (enable it with /mcp, then restart Claude Code). While it runs it holds port 8787 — use its writeToDisk:true instead of one-shot dtwin pulls` });
      }
    }
  }

  actions.push({ kind: "token", note: token.created ? `bridge token created (${token.path})` : token.source === "env" ? "bridge token: using FIGMA_BRIDGE_TOKEN from the environment" : token.source === "ephemeral" ? "bridge token could NOT be saved (read-only config dir?) — it will change every run" : `bridge token already saved (${token.path})` });
  return actions;
}

function apply(cwd, actions, log) {
  for (const a of actions) {
    if (a.kind === "mkdir") fs.mkdirSync(path.join(cwd, a.path), { recursive: true });
    if (a.kind === "write") { fs.mkdirSync(path.dirname(path.join(cwd, a.path)), { recursive: true }); fs.writeFileSync(path.join(cwd, a.path), a.content, { flag: a.merge ? "w" : "wx" }); }
    const tag = a.kind === "write" ? "wrote " : a.kind === "mkdir" ? "created" : a.kind === "skip" ? "skipped" : a.kind === "note" ? "note   " : "token  ";
    log(`${tag} ${a.path ? a.path + " — " : ""}${a.note}`);
  }
}

function main(argv) {
  const known = ["--mcp", "--dry-run", "--help", "-h"];
  const bad = argv.filter((a) => !known.includes(a));
  if (bad.length) { console.error(`[dtwin init] error: unknown argument${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}. Usage: dtwin init [--mcp] [--dry-run]`); process.exit(1); }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("dtwin init [--mcp] [--dry-run]\n\n  Run in the root of the project you are BUILDING. Creates design/ and design/target.json\n  (detected stack), makes sure a bridge token exists, and prints the remaining steps.\n  --mcp      also register the Design Twin MCP server in ./.mcp.json (merged, never overwritten)\n  --dry-run  print what would happen; write nothing (no token is created either)\n\n  Never overwrites an existing file.");
    process.exit(0);
  }
  const dry = argv.includes("--dry-run");
  const cwd = process.cwd();
  const log = (m) => console.error("[dtwin init] " + (dry ? "(dry run) " : "") + m);

  const token = tokenStore.resolve({ persist: !dry });
  // Absolute path to THIS install's server: works for a repo clone and a global npm install alike,
  // and needs no network at Claude Code start-up (unlike `npx -y designtwin mcp`).
  const mcpEntry = { command: "node", args: [path.join(__dirname, "figma-mcp.mjs")] };
  const actions = plan(cwd, { mcp: argv.includes("--mcp"), mcpEntry, token });
  if (dry) for (const a of actions) log(`${a.kind === "write" ? "would write" : a.kind === "mkdir" ? "would create" : a.kind} ${a.path ? a.path + " — " : ""}${a.note}`);
  else apply(cwd, actions, log);

  const manifest = path.join(__dirname, "..", "figma-plugin", "manifest.json");
  const steps = [
    "In Figma DESKTOP: Plugins → Development → Import plugin from manifest… → " + (fs.existsSync(manifest) ? manifest : "figma-plugin/manifest.json from a clone of the Design Twin repo (the npm package does not include it)"),
    "Run the plugin (Plugins → Development → Design Twin), paste the bridge token into its \"Bridge token\" field, Save:  dtwin --show-token | pbcopy",
    "In Claude Code, once:  claude plugin marketplace add <path-or-repo of Design Twin>  then  claude plugin install designtwin@designtwin-marketplace",
    "Then, with the Figma file open and the plugin running:  dtwin --list   →  /designtwin:extract  →  /designtwin:audit-design <screen>  →  /designtwin:build-screen <screen>",
  ];
  console.log("\nNext — the steps only you can do:\n" + steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n") + "\n");
}

module.exports = { detectProfile, plan, apply, main, isOurMcpEntry };
