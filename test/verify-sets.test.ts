// test/verify-sets.test.ts — a verify set's files (design-to-code/verify-sets.ts): the path of each file of a set, the
// --migrate journal's, which files only the verify tools write, and the run cache's place — what verify-screen, the probe,
// verify-run, --migrate and the verifier's guard all spell from here. The name grammar is screen-key.test.ts's.
// Run with:  bun test/verify-sets.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VERIFY_DIR } from "../bridge/src/project-layout.ts";
import { CACHE_NAME, RUN_CACHE_SEGMENTS, runCacheOf } from "../design-to-code/run-cache.ts";
import { SET_FILE, allSets, isJournalFile, isToolOwned, journalFile, setBaseOf, setFile, setNameOfFile, siblingFile } from "../design-to-code/verify-sets.ts";
import { check, report } from "./assert.ts";

console.log("setFile / journalFile — each file of a set, by kind:");
{
  const base = path.join("design", "verify", "Plots__1_1.w320");
  check("[setFile] the base and the kind's suffix", setFile(base, "expected") === base + ".expected.json" && setFile(base, "report") === base + ".report.json"
    && setFile(base, "reportMd") === base + ".report.md" && setFile(base, "measured") === base + ".measured.json" && setFile(base, "status") === base + ".status.json"
    && setFile(base, "evidence") === base + ".evidence.json" && setFile(base, "expectedPrev") === base + ".expected.prev.json"
    && setFile(base, "diff") === base + ".diff.png" && setFile(base, "forcedColors") === base + ".forced-colors.png" && setFile(base, "retired") === base + ".expected.json.retired");
  check("[setFile] the expectation's suffix is the one its set name is read from", setNameOfFile(setFile(base, "expected")) === "Plots__1_1.w320");
  check("[setBaseOf] a file of a kind → its set's base; any other file → null",
    setBaseOf(setFile(base, "report"), "report") === base && setBaseOf("Plots__1_1.report.json", "report") === "Plots__1_1" && setBaseOf(setFile(base, "reportMd"), "report") === null);
  check("[siblingFile] a report → its markdown or its expectation; a file of another kind is left as it is",
    siblingFile(setFile(base, "report"), "report", "reportMd") === setFile(base, "reportMd") && siblingFile(setFile(base, "report"), "report", "expected") === setFile(base, "expected")
    && siblingFile("design/verify/x.png", "report", "reportMd") === "design/verify/x.png");
  check("[journal] a --migrate journal: <verifyDir>/.migrate-<set>.json, and only that is one",
    journalFile("design/verify", "Plots__1_1") === path.join("design/verify", ".migrate-Plots__1_1.json")
    && isJournalFile(".migrate-Plots__1_1.json") && !isJournalFile("Plots__1_1.migrate.json") && !isJournalFile(".migrate-.json"));
}

console.log("isToolOwned — the files only the verify tools write (never by hand, never copied in by --publish):");
{
  const owned = ["expected", "expectedPrev", "report", "reportMd", "status"] as const;
  check("[owned] the expectation, the previous one, the report and its markdown, the status — base and variant sets alike",
    owned.every((k) => isToolOwned(path.basename(setFile("Plots__1_1", k))) && isToolOwned(path.basename(setFile("Plots__1_1.w320-dialog", k)))));
  check("[owned] a --migrate journal", isToolOwned(".migrate-Plots__1_1.json"));
  check("[owned] case is not a way around it (macOS and Windows file names ignore case)", isToolOwned("Plots__1_1.REPORT.JSON") && isToolOwned("Plots__1_1.Expected.Json"));
  const free = ["measured", "evidence", "diff", "forcedColors"] as const;
  check("[not owned] the measured file, the evidence, the probe's diff and forced-colors shots — a verifier writes or stages them",
    free.every((k) => !isToolOwned(path.basename(setFile("Plots__1_1", k)))));
  check("[not owned] a screenshot, a state's shot, any other *.prev.json, a file merely mentioning a suffix",
    !isToolOwned("Plots__1_1.png") && !isToolOwned("Plots__1_1-dialog.png") && !isToolOwned("Plots__1_1.measured.prev.json") && !isToolOwned("report.json.bak"));
  check("[owned] the list is the table's: every owned kind is in SET_FILE", owned.every((k) => typeof SET_FILE[k] === "string"));
}

console.log("the run cache — its place under a project:");
{
  check("[cache] node_modules/.cache/<CACHE_NAME> are its segments", RUN_CACHE_SEGMENTS.join("/") === `node_modules/.cache/${CACHE_NAME}` && CACHE_NAME === "designtwin-verify");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dt-verify-sets-"));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  // (relative to the root the run cache reports: it canonicalises the path, which a temp dir's spelling may not be — an
  // 8.3 short name on Windows, /var → /private/var on macOS)
  const cache = runCacheOf(path.join(root, VERIFY_DIR));
  check("[cache] a project's design/verify run cache sits at those segments", path.relative(cache.root, cache.dir).split(path.sep).join("/") === RUN_CACHE_SEGMENTS.join("/"));

  // the set names a verify dir gives, through the table's suffixes
  const vd = path.join(root, VERIFY_DIR);
  fs.mkdirSync(vd, { recursive: true });
  for (const k of ["expected", "report"] as const) fs.writeFileSync(setFile(path.join(vd, "Plots__1_1"), k), "{}");
  fs.writeFileSync(setFile(path.join(vd, "Old__2_2"), "retired"), "{}");
  fs.writeFileSync(setFile(path.join(vd, "Plots__1_1"), "diff"), "png");
  check("[sets] a set is named by its expectation/report/measured files; a retired one is history", JSON.stringify(allSets(vd)) === JSON.stringify([{ name: "Old__2_2", retired: true }, { name: "Plots__1_1", retired: false }]));
  fs.rmSync(root, { recursive: true, force: true });
}

report();
