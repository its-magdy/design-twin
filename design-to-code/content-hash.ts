// content-hash.ts — "is this the same design / the same code?" answered by CONTENT, never by a clock.
//
// Design identity: a re-pull with nothing changed in Figma rewrites only `exportedAt`, so comparing timestamps
// would demote a verified screen on every no-change sync and force a re-measure. The export's
// identity is its content with the pull's own timestamps removed: `exportedAt` at any depth and the
// `at` of each `_slices[]` entry (variables-merge.ts's per-pull provenance).
// Code identity: whether a report measured the code on disk is never decided by mtime, which a `touch` or a fresh
// clone would flip. Code identity is the content hash of each file in the plan's `files[]` and the
// modules its anchors/components map (planCodeFiles) — the same 16-hex sha256 prefix the Stop hook records in
// `verification.hook.files`.
import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "../bridge/src/hash.ts";
import { spawnSync } from "node:child_process";
import { isRecord, isUnknownArray } from "../bridge/src/json-util.ts";

// Deep copy without the pull's timestamps. Key order is kept (the exporter writes it deterministically).
// Takes and returns `unknown`: this walks whatever JSON document it is handed (a screen export, an
// expectation's docs[], a merged variables.json) and only ever drops two keys from it.
function stripPullTimes(v: unknown, parentKey?: string): unknown {
  if (isUnknownArray(v)) return v.map((x) => stripPullTimes(x, parentKey));
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "exportedAt") continue;
    if (k === "at" && parentKey === "_slices") continue;
    out[k] = stripPullTimes(x, k);
  }
  return out;
}

// One export document or several (an expectation built from several frames) -> hex sha256.
function exportContentSha256(docs: unknown): string {
  const list = isUnknownArray(docs) ? docs : [docs];
  return sha256Hex(JSON.stringify(list.map((d) => stripPullTimes(d))));
}

// { "<rel path>": "<sha256 16-hex>" | null } for every file listed — null when it is not on disk.
// `files` is a plan's `files[]` as found on disk (any JSON value is tolerated; only an array counts).
// `cached(rel)`: the file's bytes when the caller already read them this run and nothing has written the file since
// (undefined: read it from disk) — the verify-build hook passes the bytes its project graph read.
function fileHashes(files: unknown, cwd: string, cached?: (rel: string) => Uint8Array | undefined): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const rel of isUnknownArray(files) ? files.map(String) : []) {
    try { out[rel] = sha256Hex(cached?.(rel) ?? fs.readFileSync(path.join(cwd, rel))).slice(0, 16); } catch { out[rel] = null; }
  }
  return out;
}

// `git rev-parse HEAD` in cwd, or null (not a repo, no git, anything else). Informational only: the
// file hashes are what status is decided on — a commit does not say whether the tree was dirty.
function gitHead(cwd: string): string | null {
  try {
    const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    const h = r.status === 0 && String(r.stdout || "").trim();
    return h && /^[0-9a-f]{40}$/.test(h) ? h : null;
  } catch { return null; }
}

// the code files a plan's verification depends on — `files[]` (as written, in order), then
// every anchors{}/components[] `mapModule` path not already listed, sorted. A shared shell (a Sidebar/Header the plan
// maps by anchor but another plan lists in its files[]) is code this screen renders: a change to it must reopen the
// plan. `#Export` suffixes are stripped. Only a project-relative FILE counts — an absolute path, a `..` escape, a
// package specifier ("react", "@scope/ui", an "@/…" or "~/…" alias, "node:…") is skipped: none of them names one file
// under the project root. A path with no file extension (an import specifier, `src/shell/Sidebar`) is resolved the way a
// bundler would, under `cwd`: <path>.tsx/.ts/.jsx/.js, then <path>/index.{tsx,ts,jsx,js} — the first FILE found is
// hashed; none found (or no cwd given) → skipped. planCodeSkipped() names what was skipped (verify-build warns once).
const RESOLVE_EXT = ["tsx", "ts", "jsx", "js"];
const isFile = (abs: string): boolean => { try { return fs.statSync(abs).isFile(); } catch { return false; } };
function mappedModulePath(raw: unknown, cwd?: string): string | null {
  if (typeof raw !== "string") return null;
  const s = (raw.split("#")[0] ?? "").trim().split("\\").join("/");
  if (!s || s.startsWith("/") || /^[A-Za-z]:/.test(s) || /^[@~]/.test(s) || s.includes(":")) return null;
  const rel = path.posix.normalize(s).replace(/\/+$/, "");
  if (rel === ".." || rel.startsWith("../") || rel === "." || !rel) return null;
  const dotted = /\.[A-Za-z0-9]+$/.test(path.posix.basename(rel));
  if (cwd === undefined) return dotted ? rel : null;
  if (dotted && isFile(path.join(cwd, rel))) return rel;
  // an import-style name whose last part has a dot ("app.component", "Button.styles") is not an extension —
  // resolve it too; a dotted path that resolves to nothing stays hashed as written (missing → null) and is NAMED by
  // planCodeSkipped, so a typo or a deleted file is visible rather than silently "unchanged".
  const tries = [...RESOLVE_EXT.map((e) => `${rel}.${e}`), ...RESOLVE_EXT.map((e) => `${rel}/index.${e}`)];
  return tries.find((t) => isFile(path.join(cwd, t))) ?? (dotted ? rel : null);
}
// every mapModule string of a plan (anchors{} values, then components[]), as written
function mapModules(plan: { anchors?: unknown; components?: unknown }): unknown[] {
  const out: unknown[] = [];
  if (isRecord(plan.anchors)) for (const a of Object.values(plan.anchors)) if (isRecord(a)) out.push(a.mapModule);
  if (isUnknownArray(plan.components)) for (const c of plan.components) if (isRecord(c)) out.push(c.mapModule);
  return out;
}
// `cwd`: the project root extensionless mapModules resolve under (absent: they are skipped).
function planCodeFiles(plan: { files?: unknown; anchors?: unknown; components?: unknown }, cwd?: string): string[] {
  const listed = isUnknownArray(plan.files) ? plan.files.map(String) : [];
  const seen = new Set(listed.map((f) => path.posix.normalize(f.trim().split("\\").join("/"))));
  const extra = new Set<string>();
  for (const m of mapModules(plan)) { const rel = mappedModulePath(m, cwd); if (rel !== null && !seen.has(rel)) extra.add(rel); }
  return [...listed, ...[...extra].sort()];
}
// The non-empty mapModule strings planCodeFiles(plan, cwd) could not turn into an existing project file (aliases,
// packages, paths outside the project, paths that resolve to no file) — distinct, as written, sorted.
function planCodeSkipped(plan: { anchors?: unknown; components?: unknown }, cwd: string): string[] {
  const out = new Set<string>();
  for (const m of mapModules(plan)) {
    if (typeof m !== "string" || !m.trim()) continue;
    const rel = mappedModulePath(m, cwd);
    if (rel === null || !isFile(path.join(cwd, rel))) out.add(m.trim());
  }
  return [...out].sort();
}
// The one note naming them — shown by `verify-build --status` (once per plan) and in a --compare
// report's input notes; never by the Stop hook (it would repeat on every stop). null when nothing was skipped.
function planCodeSkippedNote(plan: { anchors?: unknown; components?: unknown }, cwd: string): string | null {
  const s = planCodeSkipped(plan, cwd);
  return s.length ? `mapModule path(s) not hashed with this plan's code: ${s.slice(0, 6).join(", ")}${s.length > 6 ? `, +${s.length - 6} more` : ""} — not a file under the project (an \`@/\`/\`~/\` alias, a package, a path outside the project, or a path that names no file even with .tsx/.ts/.jsx/.js or /index added), so an edit to it does not reopen the plan; for code this project owns write the project-relative file path` : null;
}

// The plan's own content as the Stop hook binds it (verify-build.ts verification.hook.planHash): the plan minus
// `status`, the owner's waivers[]/descopes[] (accepting a delta must not send the hook back to pending; a report
// records their hash instead) and ALL of `verification`: every verification check is a warning, so
// the hook's result never depends on it, and `verify-screen --compare --record-plan` writing it must not reopen a plan.
function planHash(plan: object | null | undefined): string {
  const copy: Record<string, unknown> = { ...(plan || {}) };
  delete copy.status; delete copy.waivers; delete copy.descopes; delete copy.verification;
  return sha256Hex(JSON.stringify(copy)).slice(0, 16);
}
// The older formula: `verification` minus only `verification.hook`. Still ACCEPTED (verify-build isOpen /
// computeStatus) so no plan the hook closed under it reopens on upgrade.
function legacyPlanHash(plan: object | null | undefined): string {
  const copy: Record<string, unknown> = structuredClone({ ...(plan || {}) });
  delete copy.status; delete copy.waivers; delete copy.descopes;
  if (isRecord(copy.verification)) {
    const v: Record<string, unknown> = { ...copy.verification };
    delete v.hook;
    if (Object.keys(v).length) copy.verification = v; else delete copy.verification;
  }
  return sha256Hex(JSON.stringify(copy)).slice(0, 16);
}

export { stripPullTimes, exportContentSha256, fileHashes, gitHead, planCodeFiles, planCodeSkipped, planCodeSkippedNote, planHash, legacyPlanHash };
