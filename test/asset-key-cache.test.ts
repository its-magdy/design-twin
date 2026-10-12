// The parts of bridge/src/asset-compare.ts that keep a pull's asset scan cheap: ContentIndex's deferred
// bucket sort (the same representative order whatever the insertion order, with replaces and reads
// interleaved) and FileKeyCache (a file's ContentKey reused only while the file is provably unchanged).
// Pure functions and temp files only — binds no port.
// Run with:  node test/asset-key-cache.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ok, report } from "./assert.ts";
import * as cmp from "../bridge/src/asset-compare.ts";
import type { ContentKey } from "../bridge/src/asset-compare.ts";

const t = (name: string, cond: () => boolean): void => {
  let v = false;
  try { v = cond(); } catch (e) { console.log("    threw: " + String(e instanceof Error ? e.message : e)); }
  ok(name, v);
};
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-keycache-"));
const later = (): number => Date.now() + 60_000; // every file looks old enough to cache
const svg = (x: number): string => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M${x} 0 L4 4 Z"/></svg>`;

// A small deterministic PRNG so a failure reproduces.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

console.log("asset-compare.ts — ContentIndex order with deferred sorting:");
{
  // Five keys; every member of a key has the same numbers, so each key is one cluster whose files are
  // exactly that key's members in representative order.
  const keyOf = (i: number): ContentKey => ({ key: "b:k" + i, nums: new Float64Array(0), rel: new Float64Array(0) });
  const stems = ["icon", "Icon", "arrow", "a", "chevron_left", "x"];
  const exts = [".svg", ".png"];
  const names: string[] = [];
  for (const s of stems) for (const e of exts) {
    names.push(s + e, s + "-a1b2c3" + e, s + "-a1b2c3_1" + e, s + "-ffffff" + e, s + "_2" + e);
  }
  let allSame = true, findsRight = true;
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed);
    const ix = new cmp.ContentIndex();
    const where = new Map<string, number>();
    for (let step = 0; step < 200; step++) {
      const name = names[Math.floor(r() * names.length)] ?? "x.svg";
      const k = Math.floor(r() * 5);
      ix.addKey(name, keyOf(k));
      where.set(name, k);
      if (r() < 0.3) { // a read in the middle of the adds sorts that bucket early
        const q = Math.floor(r() * 5);
        const expect = [...where].filter(([, v]) => v === q).map(([n]) => n).sort(cmp.representativeOrder)[0];
        if (ix.findKey(keyOf(q)) !== expect) findsRight = false;
      }
    }
    const expected = new Map<string, string>();
    for (let k = 0; k < 5; k++) {
      const files = [...where].filter(([, v]) => v === k).map(([n]) => n).sort(cmp.representativeOrder);
      if (files.length) expected.set("b:k" + k, files.join(","));
    }
    const got = ix.groups().map((g) => g.files.join(","));
    if (got.length !== expected.size || !got.every((f) => [...expected.values()].includes(f))) allSame = false;
  }
  t("[order] groups() lists each key's members in representative order, whatever the add/replace order (40 seeds)", () => allSame);
  t("[order] findKey between adds names the representative of the bucket as it stands", () => findsRight);
  t("[order] a name re-added under another key leaves its old bucket (and an emptied bucket is gone)", () => {
    const ix = new cmp.ContentIndex();
    ix.addKey("a.svg", keyOf(1)); ix.addKey("b.svg", keyOf(1)); ix.addKey("a.svg", keyOf(2)); ix.addKey("b.svg", keyOf(3));
    return ix.findKey(keyOf(1)) === undefined && ix.findKey(keyOf(2)) === "a.svg" && ix.groups().length === 2;
  });
}

console.log("\nasset-compare.ts — FileKeyCache:");
{
  const dir = tmp();
  const f = path.join(dir, "icon.svg");
  fs.writeFileSync(f, svg(1));
  const pin = (): void => fs.utimesSync(f, 1_600_000_000, 1_600_000_000); // a whole-second mtime, restorable exactly

  t("[cache] the key equals contentKey of the bytes", () => {
    const c = new cmp.FileKeyCache({ now: later });
    const k = c.keyOf(f, "icon.svg");
    const direct = cmp.contentKey("icon.svg", fs.readFileSync(f));
    return k !== undefined && k.key === direct.key && k.nums.join() === direct.nums.join();
  });
  t("[cache] an unchanged file is answered from the cache (the same key object)", () => {
    const c = new cmp.FileKeyCache({ now: later });
    const a = c.keyOf(f, "icon.svg"), b = c.keyOf(f, "icon.svg");
    return a !== undefined && a === b && c.size === 1;
  });
  t("[cache] a file changed in the last 2 s is never stored", () => {
    fs.writeFileSync(f, svg(2));
    const c = new cmp.FileKeyCache();
    const a = c.keyOf(f, "icon.svg"), b = c.keyOf(f, "icon.svg");
    return a !== undefined && b !== undefined && a !== b && c.size === 0;
  });
  t("[cache] a rewrite with the same size and the same mtime misses (ctime moved)", () => {
    fs.writeFileSync(f, svg(3)); pin();
    const c = new cmp.FileKeyCache({ now: later });
    const before = c.keyOf(f, "icon.svg");
    const st0 = fs.statSync(f);
    // A file-clock tick apart, as every real rewrite of a cached file is: the cache keeps no file changed in the last
    // recentMs (2 s), and `later` skips that guard — on Windows a file's ctime moves in coarse steps (a CI runner: unmoved
    // on 154 of 200 back-to-back rewrites, steps of 0.3–2 ms), so two writes inside one step would share it.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    fs.writeFileSync(f, svg(5)); pin(); // same length, different number, mtime put back
    const st1 = fs.statSync(f);
    const after = c.keyOf(f, "icon.svg");
    const direct = cmp.contentKey("icon.svg", fs.readFileSync(f));
    return st0.size === st1.size && st0.mtimeMs === st1.mtimeMs && st0.ino === st1.ino && st0.ctimeMs !== st1.ctimeMs
      && before !== undefined && after !== undefined && after.nums.join() === direct.nums.join() && before.nums.join() !== after.nums.join();
  });
  t("[cache] a file replaced by rename (new inode) misses", () => {
    fs.writeFileSync(f, svg(3)); pin();
    const c = new cmp.FileKeyCache({ now: later });
    const before = c.keyOf(f, "icon.svg");
    const g = path.join(dir, "next.tmp");
    fs.writeFileSync(g, svg(6)); fs.utimesSync(g, 1_600_000_000, 1_600_000_000); fs.renameSync(g, f);
    const after = c.keyOf(f, "icon.svg");
    return before !== undefined && after !== undefined && after.nums.join() === cmp.contentKey("icon.svg", svg(6)).nums.join();
  });
  t("[cache] a size change misses", () => {
    const c = new cmp.FileKeyCache({ now: later });
    fs.writeFileSync(f, svg(3)); pin();
    c.keyOf(f, "icon.svg");
    fs.writeFileSync(f, svg(30)); pin();
    return c.keyOf(f, "icon.svg")?.nums.join() === cmp.contentKey("icon.svg", svg(30)).nums.join();
  });
  t("[cache] the name decides SVG vs bytes, as contentKey does", () => {
    const c = new cmp.FileKeyCache({ now: later });
    return c.keyOf(f, "icon.svg")?.key.startsWith("s:") === true && new cmp.FileKeyCache({ now: later }).keyOf(f, "icon.bin")?.key.startsWith("b:") === true;
  });
  t("[cache] a missing file or a directory gives undefined (and nothing is stored)", () => {
    const c = new cmp.FileKeyCache({ now: later });
    fs.mkdirSync(path.join(dir, "sub"));
    return c.keyOf(path.join(dir, "gone.svg"), "gone.svg") === undefined && c.keyOf(path.join(dir, "sub"), "sub") === undefined && c.size === 0;
  });
  t("[cache] the least recently used entry is evicted past maxEntries", () => {
    const c = new cmp.FileKeyCache({ now: later, maxEntries: 2 });
    const files = ["a.svg", "b.svg", "c.svg"].map((n, i) => { const p = path.join(dir, n); fs.writeFileSync(p, svg(i)); return p; });
    const first = files.map((p) => c.keyOf(p, path.basename(p))); // c.svg's add evicts a.svg
    const [pa, pb, pc] = files;
    if (pa === undefined || pb === undefined || pc === undefined) return false;
    const bAgain = c.keyOf(pb, "b.svg"); // a hit, and now the most recently used
    const aAgain = c.keyOf(pa, "a.svg"); // computed afresh; its add evicts c.svg, the least recently used
    const bThird = c.keyOf(pb, "b.svg"); // still cached
    const cAgain = c.keyOf(pc, "c.svg"); // computed afresh
    return c.size === 2 && bAgain === first[1] && bThird === first[1] && aAgain !== first[0] && cAgain !== first[2];
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

report();
