// content-hash.ts — "is this the same design / the same code?" answered by CONTENT, never by a clock.
// P2b round 2 (livetest-4 findings 314, 317).
//
// 314: a re-pull with nothing changed in Figma rewrites only `exportedAt`, and status used to compare
// timestamps — so every no-change sync demoted a verified screen and forced a re-measure. The export's
// identity is its content with the pull's own timestamps removed: `exportedAt` at any depth and the
// `at` of each `_slices[]` entry (variables-merge.js's per-pull provenance).
// 317: whether a report measured the code on disk was decided by mtime, so a `touch` or a fresh clone
// flipped the status. Code identity is the content hash of each file in the plan's `files[]` — the
// same 16-hex sha256 prefix the Stop hook records in `verification.hook.files`.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { isUnknownArray } from "../bridge/src/json-util.ts";

const sha256 = (s: string | Uint8Array): string => crypto.createHash("sha256").update(s).digest("hex");

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
  return sha256(JSON.stringify(list.map((d) => stripPullTimes(d))));
}

// { "<rel path>": "<sha256 16-hex>" | null } for every file listed — null when it is not on disk.
// `files` is a plan's `files[]` as found on disk (any JSON value is tolerated; only an array counts).
function fileHashes(files: unknown, cwd: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const rel of isUnknownArray(files) ? files.map(String) : []) {
    try { out[rel] = sha256(fs.readFileSync(path.join(cwd, rel))).slice(0, 16); } catch { out[rel] = null; }
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

export { stripPullTimes, exportContentSha256, fileHashes, gitHead };
