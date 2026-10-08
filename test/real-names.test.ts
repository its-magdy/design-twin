// The real-name guard (group 16, H-2 / K-8, D105): no real field-test file, company, layer, person or place name may
// reach a tracked file or path. The field tests ran against a client's real Figma files; their pruned exports became
// fixtures and their screen names leaked into tests, comments and docs (keep-docs-generic). They were replaced with
// invented names of the same shape; this suite keeps them out.
//   node test/real-names.test.ts
//
// The list is NOT in the repo in plain text — only `sha256("dt-banned:" + phrase).slice(0, 16)` of each banned 1-3 word
// phrase (and of its joined form, e.g. a camel/lowercase identifier). That keeps plain names out of the TREE; it is not
// secrecy: the salt is public and sha256 is fast, so a dictionary run recovers short or common phrases in seconds
// (D109), and the branch history already holds the old names. Each file is tokenized (camelCase / PascalCase /
// letter-digit boundaries split, lower-cased, split on anything that is not a letter or digit — so `fooBar`,
// `foo_bar`, `foo-bar`, `foo bar`, a path and a comment wrapped onto the next line all yield "foo bar") and every 1-,
// 2- and 3-gram is hashed; a lockfile's `sha512-…` integrity hashes are dropped first (random base64: ~1 in 1,000
// holds a banned 3-letter run). A hit prints `file:line banned #k (n-gram of n words)`, never the name. Scanned:
// `git ls-files --cached --others --exclude-standard` minus the owner's handoff docs and .claude/ while UNTRACKED
// (committed, they are scanned), binaries and files over 5 MB.
//
// To ban another name: add the phrase to the owner's (out-of-repo) map, regenerate, paste the hashes below. Generic
// words (positions, units, in progress) are deliberately NOT banned.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { check, report } from "./assert.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SALT = "dt-banned:";
const hash = (phrase: string): string => crypto.createHash("sha256").update(SALT + phrase).digest("hex").slice(0, 16);

const BANNED: readonly string[] = [
  "002932151bb79754", "02580a1c1a55324f", "029edf850b86d597", "02f910f15263c0a0", "039aa06378d3f2b3", "08b24bed8a3c5378",
  "093560380002015b", "0a87c8f7f1e66b6a", "0ba931e13304293f", "0d3f1b6021e48540", "10a8c800b89bc1ca", "129ace790265cdc0",
  "12f136ea9f26d359", "1462936550449df5", "1b4114bf2357151b", "1d2b56b0478349ad", "1e0ef8aa2693dc41", "22cc1a974704fb51",
  "237103ae1f2e007c", "253a77e935abc5db", "259e87b48a68ce18", "26446ee06444486f", "2650329427baeb1f", "2716ea57692e57c0",
  "27cf4b2927c630b0", "2812f1b400647ebd", "283aeab6658e2e7b", "2b4dba487491cfab", "2bd88ad13421c793", "2d919c906c6e29e7",
  "2d9e9cbe2951db34", "31509bc377325d4f", "31885aebf2352dbd", "32537815ad4d7ec6", "32ef50b1afe97867", "33ef14d2d199114a",
  "340c86cd1aa20915", "38af90fbaf33cc38", "38cc5f433ca61d72", "3c9cd223e841e753", "3d6328cff3156a50", "3f2c59f928eb4eeb",
  "3fdaec9d8550e56b", "464e17f5a87bf3b0", "4814a88a3c322ade", "49a14826f7cf7add", "4a60a3555171700b", "4b9199edb1e060df",
  "4ca5909a543c9d24", "4d28bcb5e1956acc", "4f9677c149e97d45", "4fce1282e68196c1", "51648d2e31937c3a", "55537a2e67ba1048",
  "579cbe0c33858127", "586026a63d5dfd5e", "5b7541c1ece2acab", "5ca574e54be34d21", "5ea36dca6a821d93", "629544591f5f2b69",
  "63ddaa62dc10e39a", "65c23de3838c7436", "6872e266777b9cd5", "68bb447919c09ca8", "69c3d7347db062ee", "6b86a08c98f71928",
  "6e93cd1cdf4868fc", "6f15c7c478fc6ac7", "715b26cc305fb58e", "71c39d7f7f1e054b", "7200db21d2d1a73d", "73e749fe996b3aee",
  "79a5a187bef2945c", "7a50341df8c61a05", "7b74ba87e5e41cc2", "7bd83f0cb16c33a9", "7e0c8a0e038f3880", "846e806ebb7a0682",
  "84f1a89f0cc39f22", "8ad4510159847d67", "8b9937c2d9a2a3de", "8fda6751c4ed58e1", "917b72e018855136", "9422d4fd1377a20b",
  "960a2e6328ef6a57", "967d3c6fe9bccfb9", "975a6c6780bc3f26", "9981896516c7f380", "9a0a5b953dfa7c29", "a2a2d22c21509f5d",
  "a401e044717b4b83", "a55983b5db2b1b37", "a7830448819d1898", "a8087ce9ed5a3c50", "a809e18406e37df4", "ac42a9f6a995f6eb",
  "aeafb52101ecc898", "b390713e4090acc3", "b49adcfb7aaf7e9a", "b5b180bf6dcd776a", "b717ee6868ab1e82", "b7a4a311aa43db4c",
  "b7a9c6ef9c04c606", "b9a8800fa655de81", "b9b4a6a0c93f8bb5", "ba72baa63299db26", "bf5a4e330c092fd5", "c40620d990718c2f",
  "c446451e41a7e001", "c4db9dbf90b09cef", "c4f6cfb09ba34fc8", "c617841d2587b34b", "c660094e3f327063", "c6a18080c49a995b",
  "c9f9504ec9136cb6", "ca2e48588446420c", "cc4d5870fe75d4be", "cefdbd1f456cce31", "cfef2d684b32d8cc", "d14d1bf3f49a7744",
  "d1d687675fae60b0", "d98ace9f17acbc52", "da9920d37c06d089", "daa5114924b0b1d7", "daf811b47a842909", "db1403a55992dfa8",
  "dcfb0d00e69df6bb", "dd4ab99024e67673", "df83c70049650d90", "e46c74fe048c1e98", "e549d9e68c1520c1", "e59d3b35fe1d40ae",
  "e73fab98833c9497", "eac900c46ae8f25b", "eb9946f0c073b39b", "f1e60a79c7f88943", "f5ace9a34a491783", "fb3c7d3f16582143",
  "fedf671e020e25d9",
];

// ---- tokenizer + scan (shared by the self-test and the real scan)
// A phrase never spans structural punctuation: `"…/activity","type":` is a JSON key after a value, not a phrase.
interface Tok { t: string; line: number; brk: boolean }
const BASE64_RUN = /[A-Za-z0-9+/=]{100,}/g; // embedded data (a data: URI) is not prose — skip it
// a lockfile integrity hash (sha512-<88 base64>) is random data under the 100-char cut: one in ~1,000 holds a banned 3-letter run
// Exact SRI lengths only (base64 of a 20/32/48/64-byte digest), so a longer run is never hidden.
const SRI_HASH = /\b(?:sha1-[A-Za-z0-9+/]{27}=|sha256-[A-Za-z0-9+/]{43}=|sha384-[A-Za-z0-9+/]{64}|sha512-[A-Za-z0-9+/]{86}==)(?![A-Za-z0-9+/=])/g;
const BREAK = /["',:;{}()[\]<>=|]/;
function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let gap = "";
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(SRI_HASH, " ").replace(BASE64_RUN, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Za-z])([0-9])/g, "$1 $2")
      .replace(/([0-9])([A-Za-z])/g, "$1 $2");
    let at = 0;
    for (const m of line.matchAll(/[A-Za-z0-9]+/g)) {
      gap += line.slice(at, m.index);
      out.push({ t: m[0].toLowerCase(), line: i + 1, brk: BREAK.test(gap) });
      gap = ""; at = m.index + m[0].length;
    }
    gap += line.slice(at) + "\n";
  });
  return out;
}
interface Hit { line: number; k: number; n: number }
function scan(text: string, banned: ReadonlyMap<string, number>, memo: Map<string, number>): Hit[] {
  const toks = tokenize(text);
  const hits: Hit[] = [];
  for (let i = 0; i < toks.length; i++) {
    let gram = "";
    for (let n = 1; n <= 3 && i + n <= toks.length; n++) {
      const tok = toks[i + n - 1];
      if (!tok || (n > 1 && tok.brk)) break;
      gram = n === 1 ? tok.t : gram + " " + tok.t;
      let k = memo.get(gram);
      if (k === undefined) { k = banned.get(hash(gram)) ?? -1; memo.set(gram, k); }
      if (k >= 0) hits.push({ line: toks[i]?.line ?? 0, k, n });
    }
  }
  return hits;
}
const indexOf = (list: readonly string[]): Map<string, number> => new Map(list.map((h, i) => [h, i]));
// The owner's handoff docs are exempt only while UNTRACKED: committed, they are exactly the leak this guard is for.
const EXCLUDE = /^(docs\/field-test-handoff\.md|docs\/field-test-triage\.md|docs\/full-ts-handoff\.md|\.claude\/)/;
const keep = (f: string, trackedSet: ReadonlySet<string>): boolean => f !== "" && !(EXCLUDE.test(f) && !trackedSet.has(f));

// ---- self-test: an invented, salted two-word token (never a real name) proves the tokenizer
console.log("real-names — the guard itself:");
check("[H-2] BANNED holds ≥ 50 entries, every one a 16-hex-char salted hash, no duplicates",
  BANNED.length >= 50 && BANNED.every((h) => /^[0-9a-f]{16}$/.test(h)) && new Set(BANNED).size === BANNED.length);
{
  const a = "qx" + hash("probe-a").slice(0, 6).replace(/[0-9]/g, "q"), b = "zv" + hash("probe-b").slice(0, 6).replace(/[0-9]/g, "z");
  const probe = indexOf([hash(`${a} ${b}`), hash(`${a}${b}`)]);
  const found = (s: string): boolean => scan(s, probe, new Map()).length > 0;
  const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);
  check("[H-2] tokenizer: a spaced Title-case phrase is found", found(`see the ${cap(a)} ${cap(b)} screen`));
  check("[H-2] tokenizer: a PascalCase identifier is split (camel boundary)", found(`const x = ${cap(a)}${cap(b)}Screen;`));
  check("[H-2] tokenizer: snake_case, kebab-case and UPPER forms are found",
    found(`${a}_${b}__1_2.json`) && found(`--out ${a}-${b}`) && found(`${a.toUpperCase()}_${b.toUpperCase()}`));
  check("[H-2] tokenizer: a path segment and a comment wrapped onto the next line are found",
    found(`test/fixtures/x/__${cap(a)}_${b}_/index.json`) && found(`// the ${cap(a)}\n  // ${cap(b)} row`));
  check("[H-2] tokenizer: the joined lowercase form is found", found(`components/{ui,${a}${b}}`));
  check("[H-2] a near miss is not flagged (other word, word inside a longer token, a JSON key after a value)",
    !found(`${a} other ${b}`) && !found(`${a}x ${b}`) && !found(`x${a} ${b}`) && !found(`{"name":"x/${a}","${b}":"y"}`));
  // an 88-char sha512 value that happens to hold the phrase (random base64 does, ~1 in 1,000 in a lockfile)
  const sri = ("Q0" + a + "/" + b + "0K").padEnd(86, "A") + "==";
  check("[D109] a lockfile `sha512-…` integrity hash is not scanned (the same run without the prefix is found)",
    !found(`"integrity": "sha512-${sri}",`) && found(`"value": "${sri}",`));
}
check("[D109] the owner's handoff docs and .claude/ are skipped only while untracked — committed, they are scanned",
  !keep("docs/field-test-handoff.md", new Set()) && !keep(".claude/x.ts", new Set())
  && keep("docs/field-test-handoff.md", new Set(["docs/field-test-handoff.md"])) && keep(".claude/x.ts", new Set([".claude/x.ts"]))
  && keep("docs/other.md", new Set()));

// ---- the real scan
let tracked = new Set<string>();
try { tracked = new Set(execFileSync("git", ["-C", ROOT, "ls-files", "-z", "--cached"], { encoding: "utf8" }).split("\0")); } catch { /* reported below */ }
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|otf)$/i;
let files: string[] = [];
try {
  files = execFileSync("git", ["-C", ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split("\0").filter((f) => keep(f, tracked));
} catch (e) { console.log(`  git ls-files failed: ${e instanceof Error ? e.message : String(e)}`); }
const banned = indexOf(BANNED), memo = new Map<string, number>();
const MAX_PRINT = 60;
let printed = 0, scanned = 0;
const say = (s: string): void => { if (printed++ < MAX_PRINT) console.log("    " + s); };

console.log("\nreal-names — tracked paths and contents:");
// A path that carries a banned name is printed with that segment masked (the report never shows a name).
const shown = (f: string): string => {
  if (scan(f, banned, memo).length === 0) return f;
  const segs = f.split("/");
  const masked = segs.map((seg) => { const k = scan(seg, banned, memo)[0]?.k; return k === undefined ? seg : `<hidden #${k}>${path.extname(seg)}`; });
  return masked.some((seg, i) => seg !== segs[i]) ? masked.join("/") : `<hidden path ${segs.length} segments>`;
};
const words = (n: number): string => `n-gram of ${n} word${n > 1 ? "s" : ""}`;
const pathHits: string[] = [];
for (const f of files) for (const h of scan(f, banned, memo)) { pathHits.push(f); say(`${shown(f)} (path) banned #${h.k} (${words(h.n)})`); }
let contentHits = 0;
const hitFiles = new Set<string>();
for (const f of files) {
  if (BINARY.test(f)) continue;
  const p = path.join(ROOT, f);
  let buf: Buffer;
  try { const st = fs.statSync(p); if (!st.isFile() || st.size > 5 * 1024 * 1024) continue; buf = fs.readFileSync(p); } catch { continue; }
  if (buf.includes(0)) continue;
  scanned++;
  for (const h of scan(buf.toString("utf8"), banned, memo)) {
    contentHits++; hitFiles.add(f);
    say(`${shown(f)}:${h.line} banned #${h.k} (${words(h.n)})`);
  }
}
if (printed > MAX_PRINT) console.log(`    … ${printed - MAX_PRINT} more`);
check(`[H-2] the scan saw the repo (${scanned} text files; > 200 expected)`, scanned > 200);
check(`[H-2] no tracked or new file PATH carries a banned name (${new Set(pathHits).size} paths)`, pathHits.length === 0);
check(`[H-2] no tracked or new file's CONTENT carries a banned name (${contentHits} hits in ${hitFiles.size} files)`, contentHits === 0);
report();
