// catalog-input.ts — the ONE guard that stops these CLIs from being handed the wrong catalog file.
//
// `design/design-system.json` (bridge/src/design-system-layout.ts) is a slim pointer manifest:
// stamp + `files` map + `counts`, and NO `variables`/`components` payload.
// These tools once took that file, so the muscle memory (and every older README, blog
// note or shell history line) still points at it. Handing it over would not crash — the tools would
// happily emit an empty token file or report "0/0 components mapped", which reads like a clean run.
// That is the exact silent-wrong-answer failure this repo refuses to ship, so we fail loud instead.
//
// The tell is unambiguous and needs no filename sniffing: a manifest has a `files` pointer map and
// lacks the payload key the caller needs.
// Split out from the exiting wrapper so the decision itself is testable without a subprocess.
import fs from "node:fs";
import type { DesignSystemManifest } from "./types.ts";
import { isJsonObject } from "./types.ts";
import { anyJson, readJson } from "./read-json.ts";
import type { DocGuard } from "./doc-guards.ts";

function isManifest(doc: unknown, payloadKey: string): doc is DesignSystemManifest {
  return isJsonObject(doc) && isJsonObject(doc.files) && !Array.isArray(doc[payloadKey]);
}

function assertNotManifest(doc: unknown, givenPath: string, payloadKey: string, wantFile: string): void {
  if (isManifest(doc, payloadKey)) {
    console.error(
      `error  '${givenPath}' is the design-system MANIFEST (a pointer map), not the '${payloadKey}' catalog.\n` +
      `       Since the design-system split it carries only a stamp, a \`files\` map and \`counts\`.\n` +
      `       Pass the split file instead — e.g. ${doc.files[payloadKey === "variables" ? "tokens" : "componentsLocal"] || wantFile}` +
      ` (relative to the export dir that holds ${givenPath}).`
    );
    process.exit(2);
  }
}

// The second half of the same "never hand back a confusing failure" job: a raw
// `fs.readFileSync` on a path the user typed dies with an ENOENT stack trace whose top frame is a
// line number inside THIS repo, which reads like the tool crashed rather than like the file is
// simply not there. A `--node`/single-screen pull legitimately produces no `design/design-system/`
// at all, so "that file does not exist" is a NORMAL outcome of a normal workflow and deserves a
// sentence, not a stack. `hint` says what to do about it.
// Returns the parsed JSON as `unknown`: callers narrow (isManifest/assertNotManifest, a type guard)
// before reading fields — or use readDocFile, which checks a doc-guards.ts guard as it reads.
function readJsonFile(file: string, what: string, hint?: string): unknown {
  return readDocFile(file, what, anyJson, hint);
}

// readJsonFile plus the document's shape: a file that is not the kind of document `guard` describes
// is the same one-line, exit-2 error as a missing file — never a TypeError three calls later.
function readDocFile<T>(file: string, what: string, guard: DocGuard<T>, hint?: string): T {
  const r = readJson(file, guard);
  if ("doc" in r) return r.doc;
  // A read failure ends in a period (and may carry the caller's hint); a parse/shape failure is a phrase.
  const ioFailure = r.missing || /^(is a directory|is not readable|could not be read)/.test(r.error);
  console.error(`error  ${what}: '${file}' ${r.error}${ioFailure ? "." : ""}` + (ioFailure && hint ? `\n       ${hint}` : ""));
  process.exit(2);
}

// An OPTIONAL input (a design-system split file a single-screen pull does not have): absent is null,
// present-but-broken is the same fail-loud exit as readDocFile — a malformed tokens.json must not read as
// "there is no design system".
function readOptionalDoc<T>(file: string, what: string, guard: DocGuard<T>): T | null {
  return fs.existsSync(file) ? readDocFile(file, what, guard) : null;
}

// A design-system SPLIT file the user named (a catalog, a token file): refuse the manifest with its own
// explanation first (the one wrong file people actually pass), then check the payload's shape.
function readSplitFile<T>(file: string, what: string, guard: DocGuard<T>, payloadKey: string, wantFile: string, hint?: string): T {
  const doc = readJsonFile(file, what, hint);
  assertNotManifest(doc, file, payloadKey, wantFile);
  if (guard(doc)) return doc;
  console.error(`error  ${what}: '${file}' is not ${guard.expected || "the expected kind of document"}`);
  process.exit(2);
}

// The one reason design/design-system/ is usually missing, stated once: a --node/single-screen pull
// exports that screen and nothing else. Callers append their own "…and here is what to do instead",
// which differs per tool (the map tools can proceed without a map; tokens.ts has variables.json).
const NO_DESIGN_SYSTEM_HINT =
  "A single-screen pull (`dtwin pull --node <id>`) exports only that screen — it does not\n" +
  "       write design/export/design-system/. Run `dtwin pull --design-system` to create it.";

export { assertNotManifest, isManifest, readJsonFile, readDocFile, readOptionalDoc, readSplitFile, NO_DESIGN_SYSTEM_HINT };
