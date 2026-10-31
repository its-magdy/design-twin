// Install a packed @design-twin/dtwin tarball the way the Homebrew formula does, and check the result: the release
// workflow runs this on the tarball it is about to publish (release.yml preflight).
//
//   1. the tarball carries bun.lock, and it is the root bun.lock's pins (pack.ts lockProblems) — the formula refuses a
//      tarball without one, and `bun install --frozen-lockfile` with NO lockfile resolves everything fresh, exit 0;
//   2. `bun install --production --frozen-lockfile --ignore-scripts` into an empty cache (every tarball downloaded and
//      checked against its sha512) succeeds;
//   3. what landed is what the lock says: each direct dependency at its locked version, no devDependency;
//   4. the code loads against it: figma-pull.ts and figma-mcp.ts import (their main guards keep them from running).
//      `dtwin --version` alone proves nothing here — it prints the version with no dependency installed at all;
//   5. the MCP server answers initialize and tools/list over stdio, as Claude Code starts it.
//
// Run from the repo:  bun --no-install --no-env-file bridge/verify-pack.ts <dtwin-x.y.z.tgz>
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { ROOT_LOCK, lockProblems } from "./pack.ts";
import { errMsg } from "./src/errmsg.ts";

const BUN_FLAGS = ["--no-install", "--no-env-file"] as const;
const MCP_TIMEOUT_MS = 30_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const stringMap = (v: unknown): Record<string, string> => isRecord(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
const readJson = (p: string): unknown => JSON.parse(fs.readFileSync(p, "utf8")) as unknown;

function run(cmd: string[], cwd: string, env: Record<string, string | undefined> = process.env): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** The locked version of each name in `deps`, from the lock's `packages` ("name@version" first field). */
function lockedVersions(lock: unknown, deps: readonly string[]): Map<string, string | undefined> {
  const packages = isRecord(lock) && isRecord(lock.packages) ? lock.packages : {};
  return new Map(deps.map((d) => {
    const entry = packages[d];
    const ident = Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : "";
    return [d, ident.startsWith(d + "@") ? ident.slice(d.length + 1) : undefined];
  }));
}

/** initialize + tools/list against `bun figma-pull.ts mcp` in `pkg`; the tool count, or a reason it failed. */
async function mcpHandshake(pkg: string): Promise<{ tools: number } | { error: string }> {
  const proc = Bun.spawn([process.execPath, ...BUN_FLAGS, "src/figma-pull.ts", "mcp"], { cwd: pkg, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const send = (m: object): void => { void proc.stdin.write(JSON.stringify(m) + "\n"); };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify-pack", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const timer = setTimeout(() => proc.kill(), MCP_TIMEOUT_MS);
  let buf = "";
  let result: { tools: number } | { error: string } = { error: "the server closed stdout before answering tools/list" };
  const decoder = new TextDecoder();
  try {
    for await (const chunk of proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      const reply = buf.split("\n").map((l) => { try { return JSON.parse(l) as unknown; } catch { return undefined; } })
        .find((m) => isRecord(m) && m.id === 2);
      if (reply === undefined) continue;
      const tools = isRecord(reply) && isRecord(reply.result) && Array.isArray(reply.result.tools) ? reply.result.tools.length : 0;
      result = tools > 0 ? { tools } : { error: "tools/list answered with no tools: " + JSON.stringify(reply).slice(0, 300) };
      break;
    }
  } finally {
    clearTimeout(timer);
    await proc.stdin.end();
  }
  const code = await proc.exited;
  if ("error" in result) result = { error: `${result.error} (exit ${code}): ${(await new Response(proc.stderr).text()).trim().slice(-600)}` };
  return result;
}

export async function verifyPack(tarball: string): Promise<string[]> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-verify-"));
  const problems: string[] = [];
  const say = (m: string): void => { console.log("[verify-pack] " + m); };
  try {
    const x = run(["tar", "-xzf", path.resolve(tarball), "-C", work], work);
    if (x.code !== 0) return [`could not unpack ${tarball}: ${x.err.trim()}`];
    const pkg = path.join(work, "package");
    const lockPath = path.join(pkg, "bun.lock");
    if (!fs.existsSync(lockPath)) return ["the tarball has no bun.lock — a frozen install would resolve every dependency fresh (bridge/pack.ts writes it at prepack)"];
    const lock = Bun.JSONC.parse(fs.readFileSync(lockPath, "utf8"));
    const wrong = lockProblems(Bun.JSONC.parse(fs.readFileSync(ROOT_LOCK, "utf8")), lock);
    if (wrong.length) return ["the tarball's bun.lock is not the root bun.lock's pins: " + wrong.join("; ")];
    say("bun.lock present, every entry the root lock's pin with a sha512");

    const manifest = readJson(path.join(pkg, "package.json"));
    const m = isRecord(manifest) ? manifest : {};
    const deps = Object.keys(stringMap(m.dependencies));
    const devDeps = Object.keys(stringMap(m.devDependencies));
    const cache = path.join(work, "bun-cache");
    const inst = run([process.execPath, "install", "--production", "--frozen-lockfile", "--ignore-scripts", "--no-progress"], pkg, { ...process.env, BUN_INSTALL_CACHE_DIR: cache });
    if (inst.code !== 0) return [`bun install --production --frozen-lockfile failed (exit ${inst.code}): ${(inst.err + inst.out).trim().slice(-800)}`];
    say("frozen production install into an empty cache: ok");

    for (const [dep, want] of lockedVersions(lock, deps)) {
      const p = path.join(pkg, "node_modules", dep, "package.json");
      const installed = fs.existsSync(p) ? readJson(p) : undefined;
      const got = isRecord(installed) ? installed.version : undefined;
      if (want === undefined || got !== want) problems.push(`${dep}: installed ${String(got)}, the lock pins ${String(want)}`);
    }
    for (const dep of devDeps) if (fs.existsSync(path.join(pkg, "node_modules", dep))) problems.push(`devDependency ${dep} was installed by a --production install`);
    if (!problems.length) say(`installed exactly the lock's ${deps.join(", ")}, no devDependencies`);

    const load = run([process.execPath, ...BUN_FLAGS, "-e", 'await import("./src/figma-mcp.ts"); await import("./src/figma-pull.ts"); console.log("loaded")'], pkg);
    if (load.code !== 0 || !load.out.includes("loaded")) problems.push(`figma-mcp.ts / figma-pull.ts do not load against the installed dependencies (exit ${load.code}): ${load.err.trim().slice(-600)}`);
    else say("figma-pull.ts and figma-mcp.ts load against them");

    const ver = run([process.execPath, ...BUN_FLAGS, "src/figma-pull.ts", "--version"], pkg);
    if (ver.out.trim() !== m.version) problems.push(`dtwin --version printed ${JSON.stringify(ver.out.trim())}, package.json says ${String(m.version)}`);

    const mcp = await mcpHandshake(pkg);
    if ("error" in mcp) problems.push("MCP server: " + mcp.error);
    else say(`MCP server answers initialize and tools/list (${mcp.tools} tools)`);
  } catch (e) {
    problems.push(errMsg(e));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return problems;
}

if (import.meta.main) {
  const tarball = process.argv[2];
  if (!tarball || !fs.existsSync(tarball)) {
    console.error("usage: bun --no-install --no-env-file bridge/verify-pack.ts <dtwin-x.y.z.tgz>");
    process.exit(2);
  }
  const problems = await verifyPack(tarball);
  if (problems.length) {
    for (const p of problems) console.error("[verify-pack] FAIL " + p);
    process.exit(1);
  }
  console.log("[verify-pack] ok: " + path.basename(tarball));
}
