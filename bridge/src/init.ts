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
//     project that registers it cannot run one-shot `dtwin` pulls while Claude Code is open —
//     a trade-off the user should choose, not inherit from a setup command.
//
//   dtwin init            # design/, design/target.json (detected stack), bridge token, next steps
//   dtwin init --mcp      # …and register the MCP server in ./.mcp.json
//   dtwin init --dry-run  # say what it would do, write nothing

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import * as tokenStore from "./token-store.ts";
import type { ResolvedToken } from "./token-store.ts";
import * as LAYOUT from "./project-layout.ts";

/** One .mcp.json server entry, as init writes it. */
export interface McpEntry {
  command: string;
  args: string[];
}

/** The part of .mcp.json init (and doctor) reads: `mcpServers`, when present, must be an object. A
 *  `null`, array or string there would crash init or be spread character-by-character into the
 *  rewritten file. Loose: every other key passes the check and is carried through untouched. */
// A JSON value's kind, for a message a person reads ("not a string", not zod's "received string").
const jsonKind = (x: unknown): string => (x === null ? "null" : Array.isArray(x) ? "an array" : typeof x === "object" ? "an object" : "a " + typeof x);
const McpJsonSchema = z.looseObject(
  { mcpServers: z.record(z.string(), z.unknown(), { error: (iss) => `\`mcpServers\` must be an object of server entries, not ${jsonKind(iss.input)}` }).optional() },
  { error: (iss) => `must be a JSON object, not ${jsonKind(iss.input)}` },
);
const isPlainObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Check a parsed .mcp.json. On success, `doc` and `servers` are the user's OWN objects, not zod's
 *  copies: zod moves the keys it knows to the front and drops a key named "__proto__", and init
 *  rewrites this file — it must keep its key order and every entry. `error` is one line. */
function readMcpJson(raw: unknown): { doc: Record<string, unknown>; servers: Record<string, unknown> } | { error: string } {
  const r = McpJsonSchema.safeParse(raw);
  if (!r.success || !isPlainObject(raw)) return { error: r.success ? "must be a JSON object" : r.error.issues.map((i) => i.message).join("; ") };
  return { doc: raw, servers: isPlainObject(raw.mcpServers) ? raw.mcpServers : {} };
}

/** One step of init's plan (see `plan`), discriminated on `kind`: the file-touching kinds carry their
 *  `path`, "write" its `content` (and `merge` for the one write allowed onto an existing file). */
export type InitAction =
  | { kind: "skip"; path: string; note: string }
  | { kind: "mkdir"; path: string; note: string }
  | { kind: "write"; path: string; content: string; merge?: boolean; note: string }
  | { kind: "note"; note: string }
  | { kind: "token"; note: string };

export interface PlanOptions {
  mcp?: boolean;
  mcpEntry?: McpEntry;
  /** The resolved bridge token (token-store resolve()) — only its source/path/created are read. */
  token: Pick<ResolvedToken, "source" | "path" | "created">;
}

// The profiles build-screen ships. Named in target.json when detection finds nothing, so the user can
// fill it in without going to look for the list.
const PROFILES = ["web-tailwind", "web-css-modules", "react-native", "swiftui", "android-compose", "flutter"];

// The key the MCP server is registered under in .mcp.json — matches the server's own name
// (bridge/src/figma-mcp.ts), so its tools surface as mcp__designtwin__figma_status etc.
const MCP_KEY = "designtwin";

// Is this .mcp.json entry Design Twin's server, under ANY key? It points at figma-mcp.{ts,js} (a
// checkout's bridge/src/figma-mcp.ts, an install's bridge/dist/figma-mcp.js — or the .mjs/.mts an
// older init wrote), or runs `designtwin mcp` (the npx form). One rule for init (don't double-register)
// and doctor (report it).
const isOurMcpEntry = (e: unknown): boolean => {
  // Untyped JSON from the user's .mcp.json: only an object can carry `args` (JSON has no other shape that does).
  const args: unknown = e && typeof e === "object" ? (e as { args?: unknown }).args : undefined;
  return !!e && Array.isArray(args) && (args.some((a) => /(^|[\\/])figma-mcp\.(mjs|mts|ts|js)$/.test(String(a))) || (args.includes("designtwin") && args.includes("mcp")));
};

// Does package.json list vite in dependencies or devDependencies?
function usesVite(cwd: string): boolean {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")) as unknown; } catch { return false; }
  return isPlainObject(raw) && [raw.dependencies, raw.devDependencies].filter(isPlainObject).some((d) => "vite" in d);
}

// Does package.json list Tailwind v4 (tailwindcss not pinned to v3, or its v4-only Vite/PostCSS plugin) in dependencies or devDependencies?
function usesTailwind(cwd: string): boolean {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")) as unknown; } catch { return false; }
  if (!isPlainObject(raw)) return false;
  const deps = [raw.dependencies, raw.devDependencies].filter(isPlainObject);
  // @tailwindcss/vite and @tailwindcss/postcss exist only for v4. `tailwindcss` itself counts unless its
  // range is clearly v3 (^3 / ~3 / 3.x / >=3 <4): v3 scans only its `content` globs, so the note would be wrong.
  if (deps.some((d) => "@tailwindcss/vite" in d || "@tailwindcss/postcss" in d)) return true;
  const range = deps.map((d) => d.tailwindcss).find((v) => v !== undefined);
  if (range === undefined) return false;
  // Each `||` alternative on its own: "^3.0.0 || ^4.0.0" allows v4, so it still gets the note.
  const isV3 = (r: string): boolean => /^\s*(?:[\^~]|>=?\s*)?v?3(?:$|[.\s<x*])/.test(r) && (!/^\s*>/.test(r) || /<\s*v?4/.test(r)); // ">=3" alone may be v4
  return !(typeof range === "string" && range.split("||").every(isV3));
}

// Same detection order build-screen's step 0 documents — first match wins, most specific first.
function detectProfile(cwd: string): { profile: string; because: string } | null {
  const has = (f: string) => fs.existsSync(path.join(cwd, f));
  const read = (f: string): string => { try { return fs.readFileSync(path.join(cwd, f), "utf8"); } catch { return ""; } };
  const ls: string[] = (() => { try { return fs.readdirSync(cwd); } catch { return []; } })();
  type PackageJson = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  let pkg: PackageJson | null = null;
  try { pkg = JSON.parse(read("package.json")) as PackageJson; } catch { /* no/invalid package.json */ }
  if (pkg) {
    const deps: Record<string, string | undefined> = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
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
function plan(cwd: string, { mcp = false, mcpEntry, token }: PlanOptions): InitAction[] {
  const actions: InitAction[] = [];
  const rel = (p: string) => path.relative(cwd, p) || ".";

  const designDir = path.join(cwd, LAYOUT.DESIGN_DIR);
  actions.push(fs.existsSync(designDir) ? { kind: "skip", path: rel(designDir), note: "exists" } : { kind: "mkdir", path: rel(designDir), note: "your decisions live here" });

  // design/export/ is created up front, empty, precisely so the split is visible BEFORE the first
  // pull rather than discovered after one. dtwin writes only here.
  const exportDir = path.join(cwd, LAYOUT.EXPORT_DIR);
  actions.push(fs.existsSync(exportDir) ? { kind: "skip", path: rel(exportDir), note: "exists" } : { kind: "mkdir", path: rel(exportDir), note: "where every pull lands — safe to delete and re-pull" });

  // The README is the only thing that can tell a future reader which half of design/ a re-pull is
  // allowed to destroy. A comment in our source cannot; a directory name alone only hints.
  const readme = path.join(designDir, "README.md");
  if (fs.existsSync(readme)) actions.push({ kind: "skip", path: rel(readme), note: "exists — left as is" });
  else actions.push({ kind: "write", path: rel(readme), content: LAYOUT.README, note: "what dtwin owns vs what you own" });

  // target.json is written ALWAYS, even when no stack could be detected.
  //
  // Skipping it in that case would make `dtwin init --help`'s own promise ("Creates design/
  // and design/target.json") false, and leave every later step reading a file that is simply not there
  // — the verify skill's step 1 `cat`s it and would move on in silence. A file that
  // says "nobody has decided yet" is a far better artifact than an absent one: build-screen can fill
  // it in, and everything downstream has one place to look.
  const targetFile = path.join(cwd, LAYOUT.TARGET_FILE);
  if (fs.existsSync(targetFile)) actions.push({ kind: "skip", path: rel(targetFile), note: "exists — left as is" });
  else {
    const d = detectProfile(cwd);
    const doc = d
      ? { profile: d.profile, detectedFrom: d.because }
      : { profile: null, note: "No stack was detected in this directory. build-screen asks on its first run and writes the answer here; audit-design reads it to pick touch-target minimums. Set it by hand if you already know: one of " + PROFILES.join(", ") + "." };
    actions.push({
      kind: "write",
      path: rel(targetFile),
      content: JSON.stringify(doc, null, 2) + "\n",
      note: d ? `stack detected: ${d.profile} (${d.because})` : "no stack detected here — written with profile:null so build-screen has somewhere to record the answer",
    });
  }

  // design/ holds regenerable exports AND hand-owned decisions; only the second kind is lost forever.
  // Say so where the user will see it, rather than editing their .gitignore for them.
  const gi = path.join(cwd, ".gitignore");
  const ignored = fs.existsSync(gi) && /^\/?design\/?\s*$/m.test(fs.readFileSync(gi, "utf8"));
  if (ignored) actions.push({ kind: "note", note: ".gitignore ignores design/ — target.json, codeconnect.local.json, plan/ and audit/ under it are hand-authored and are NOT regenerable. Ignore only the export: replace `design/` with `design/export/`" });

  // Suggest only: a Tailwind project would otherwise compile class names quoted in design/.
  const tailwind = usesTailwind(cwd);
  if (tailwind) actions.push({ kind: "note", note: LAYOUT.TAILWIND_SOURCE_NOT_NOTE });

  // Suggest only: with Tailwind v4 scanning design/, a rewrite there makes Vite reload the open page
  // (proven only for vite + Tailwind v4 — see VITE_WATCH_IGNORED_NOTE for why vite alone gets no note).
  if (tailwind && usesVite(cwd)) actions.push({ kind: "note", note: LAYOUT.VITE_WATCH_IGNORED_NOTE });
  // design/verify/ already ignored — any spelling: design/verify, /design/verify/, design/verify/**, design/verify/*
  // (or the whole design/ tree, which the note above already warns about)
  const verifyIgnored = /^\/?design(?:\/verify)?(?:\/(?:\*\*?)?)?\s*$/m.test(fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "");
  if (!verifyIgnored) actions.push({ kind: "note", note: LAYOUT.VERIFY_GITIGNORE_NOTE });

  if (mcp) {
    const file = path.join(cwd, ".mcp.json");
    let doc: object = {};
    let servers: Record<string, unknown> = {};
    let bad: string | null = null;
    if (fs.existsSync(file)) {
      let raw: unknown;
      try { raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown; } catch { bad = "exists but is not valid JSON"; }
      if (bad === null) {
        const r = readMcpJson(raw);
        if ("error" in r) bad = r.error;
        else { doc = r.doc; servers = r.servers; }
      }
    }
    if (bad !== null) actions.push({ kind: "skip", path: rel(file), note: bad + " — fix it, then re-run with --mcp" });
    else {
      // Registered as "designtwin", never "figma": that is the name Figma's own MCP server is usually
      // given, and Claude Code loads only one server per name — sharing it would silently drop one.
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

function apply(cwd: string, actions: InitAction[], log: (m: string) => void): void {
  for (const a of actions) {
    if (a.kind === "mkdir") fs.mkdirSync(path.join(cwd, a.path), { recursive: true });
    if (a.kind === "write") { fs.mkdirSync(path.dirname(path.join(cwd, a.path)), { recursive: true }); fs.writeFileSync(path.join(cwd, a.path), a.content, { flag: a.merge ? "w" : "wx" }); }
    const tag = a.kind === "write" ? "wrote " : a.kind === "mkdir" ? "created" : a.kind === "skip" ? "skipped" : a.kind === "note" ? "note   " : "token  ";
    log(`${tag} ${"path" in a ? a.path + " — " : ""}${a.note}`);
  }
}

function main(argv: string[]): void {
  const known = ["--mcp", "--dry-run", "--help", "-h"];
  const bad = argv.filter((a) => !known.includes(a));
  if (bad.length) { console.error(`[dtwin init] error: unknown argument${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}. Usage: dtwin init [--mcp] [--dry-run]`); process.exit(1); }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "dtwin init [--mcp] [--dry-run]\n\n" +
      "  Run in the root of the project you are BUILDING. Creates exactly these four things:\n" +
      "    design/                  the directory your decisions live under\n" +
      "    design/export/           where every dtwin pull lands, empty at first — safe to delete and re-pull\n" +
      "    design/README.md         which half of design/ a re-pull is allowed to destroy\n" +
      "    design/target.json       the detected stack, or profile:null for build-screen to fill in\n" +
      "  It does NOT create codeconnect.local.json, plan/, audit/ or verify/ — those are written later,\n" +
      "  on demand, by map-bootstrap.ts, build-screen, audit-design and verify respectively.\n" +
      "  …makes sure a bridge token exists, and prints the remaining steps.\n\n" +
      "  --mcp      also register the Design Twin MCP server in ./.mcp.json (merged, never overwritten)\n" +
      "  --dry-run  print what would happen; write nothing (no token is created either)\n\n" +
      "  Never overwrites an existing file."
    );
    process.exit(0);
  }
  const dry = argv.includes("--dry-run");
  const cwd = process.cwd();
  const log = (m: string) => console.error("[dtwin init] " + (dry ? "(dry run) " : "") + m);

  const token = tokenStore.resolve({ persist: !dry });
  // Absolute path to THIS install's server: works for a repo clone and a global npm install alike,
  // and needs no network at Claude Code start-up (unlike `npx -y designtwin mcp`). The entry is the MCP
  // server that sits beside THIS file, in the same form: bridge/src/figma-mcp.ts when init runs from a
  // checkout's source, bridge/dist/figma-mcp.js when it runs from the built (npm-installed) package.
  const mcpEntry: McpEntry = { command: "node", args: [path.join(import.meta.dirname, "figma-mcp" + path.extname(import.meta.filename))] };
  const actions = plan(cwd, { mcp: argv.includes("--mcp"), mcpEntry, token });
  if (dry) for (const a of actions) log(`${a.kind === "write" ? "would write" : a.kind === "mkdir" ? "would create" : a.kind} ${"path" in a ? a.path + " — " : ""}${a.note}`);
  else apply(cwd, actions, log);

  // The plugin manifest of a repo checkout: bridge/src/ (or bridge/dist/) -> ../../figma-plugin/. An npm
  // install has no figma-plugin/ beside it, so the step below falls back to naming the repo instead.
  const manifest = path.join(import.meta.dirname, "..", "..", "figma-plugin", "manifest.json");
  // Step 3 is already done for anyone who reached init THROUGH the installed plugin's help skill —
  // which is the documented path. Claude Code records installed plugins under ~/.claude; when the
  // marker is there, saying "install the plugin" is noise at best and confusing at worst.
  const pluginInstalled = (() => {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) return false;
    const root = path.join(home, ".claude", "plugins");
    // installed_plugins.json is the authoritative record; the per-plugin directories under data/ and
    // repos/ are the fallback for older layouts. Any of them naming designtwin means step 3 is done.
    try {
      if (/designtwin/i.test(fs.readFileSync(path.join(root, "installed_plugins.json"), "utf8"))) return true;
    } catch { /* absent — try the directories */ }
    for (const p of ["data", "repos", "marketplaces", "."]) {
      try {
        if (fs.readdirSync(path.join(root, p)).some((d) => /designtwin/i.test(d))) return true;
      } catch { /* not there — fall through */ }
    }
    return false;
  })();

  const steps = [
    "In Figma DESKTOP: Plugins → Development → Import plugin from manifest… → " + (fs.existsSync(manifest) ? manifest : "figma-plugin/manifest.json from a clone of the Design Twin repo (the npm package does not include it)"),
    "Run the plugin (Plugins → Development → Design Twin), paste the bridge token into its \"Bridge token\" field, Save:  dtwin --show-token | pbcopy",
  ];
  if (!pluginInstalled) {
    steps.push("In Claude Code, once:  claude plugin marketplace add <path-or-repo of Design Twin>  then  claude plugin install designtwin@designtwin-marketplace");
  }
  steps.push(
    "Then, with the Figma file open and the plugin running:  dtwin list   →  /designtwin:extract  →  /designtwin:audit-design <screen>  →  /designtwin:build-screen <screen>"
  );
  console.log("\nNext — the steps only you can do:\n" + steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n"));
  // The one refusal a first command reliably hits. doctor names it after the fact; saying it here, in
  // the output whose whole job is "the steps left", is what stops `dtwin list` failing on step 4
  // for anyone with two Figma files open.
  console.log(
    "\n  If more than one Figma file is connected, every command needs to say which:\n" +
    "    dtwin list clients                 # the address book\n" +
    "    dtwin list --client <part of the file name>\n" +
    "  `dtwin doctor` tells you how many are connected and lists them.\n"
  );
}

export { detectProfile, plan, apply, main, isOurMcpEntry, readMcpJson, usesTailwind, usesVite };
