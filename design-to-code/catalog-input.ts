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
// The decision is a value (manifestProblem): a CLI prints it and exits (readSplitFile), an in-process caller gets it back (loadSplitFile).
import fs from "node:fs";
import type { DesignSystemManifest } from "./types.ts";
import { isJsonObject } from "./types.ts";
import { anyJson, readJson } from "../bridge/src/read-json.ts";
import type { DocGuard } from "../bridge/src/read-json.ts";
// exitCli, not process.exit: under runCli the one-line error is never dropped at exit (proc.ts)
import { exitCli } from "./proc.ts";

function isManifest(doc: unknown, payloadKey: string): doc is DesignSystemManifest {
  return isJsonObject(doc) && isJsonObject(doc.files) && !Array.isArray(doc[payloadKey]);
}

// The manifest refusal as a value: the explanation (no "error  " prefix), or null when `doc` is not the manifest.
function manifestProblem(doc: unknown, givenPath: string, payloadKey: string, wantFile: string): string | null {
  if (!isManifest(doc, payloadKey)) return null;
  return (
    `'${givenPath}' is the design-system MANIFEST (a pointer map), not the '${payloadKey}' catalog.\n` +
    `       Since the design-system split it carries only a stamp, a \`files\` map and \`counts\`.\n` +
    `       Pass the split file instead — e.g. ${doc.files[payloadKey === "variables" ? "tokens" : "componentsLocal"] || wantFile}` +
    ` (relative to the export dir that holds ${givenPath}).`
  );
}

// The second half of the same "never hand back a confusing failure" job: a raw
// `fs.readFileSync` on a path the user typed dies with an ENOENT stack trace whose top frame is a
// line number inside THIS repo, which reads like the tool crashed rather than like the file is
// simply not there. A `--node`/single-screen pull legitimately produces no `design/design-system/`
// at all, so "that file does not exist" is a NORMAL outcome of a normal workflow and deserves a
// sentence, not a stack. `hint` says what to do about it.
// Returns the parsed JSON as `unknown`: callers narrow (isManifest/manifestProblem, a type guard)
// before reading fields — or use readDocFile, which checks a doc-guards.ts guard as it reads.
function readJsonFile(file: string, what: string, hint?: string): unknown {
  return readDocFile(file, what, anyJson, hint);
}

// readJsonFile plus the document's shape: a file that is not the kind of document `guard` describes
// is the same one-line, exit-2 error as a missing file — never a TypeError three calls later.
function readDocFile<T>(file: string, what: string, guard: DocGuard<T>, hint?: string): T {
  return docOrExit(loadDocFile(file, what, guard, hint));
}

/** A named input read as a value: the document, or the line(s) a CLI prints after `error  ` before it exits 2. */
export type DocLoad<T> = { doc: T } | { error: string };
// readDocFile's decision without the exit — for a caller that must not end the process (a run the MCP server
// makes in-process) or that reports its own way. `readAt`: where `file` is read (a caller resolving it under its own
// project root); the error still names `file` as it was spelt.
function loadDocFile<T>(file: string, what: string, guard: DocGuard<T>, hint?: string, readAt = file): DocLoad<T> {
  const r = readJson(readAt, guard);
  if ("doc" in r) return r;
  // A read failure ends in a period (and may carry the caller's hint); a parse/shape failure is a phrase.
  const ioFailure = r.missing || /^(is a directory|is not readable|could not be read)/.test(r.error);
  return { error: `${what}: '${file}' ${r.error}${ioFailure ? "." : ""}` + (ioFailure && hint ? `\n       ${hint}` : "") };
}
function docOrExit<T>(r: DocLoad<T>): T {
  if ("doc" in r) return r.doc;
  console.error(`error  ${r.error}`);
  exitCli(2);
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
  return docOrExit(loadSplitFile(file, what, guard, payloadKey, wantFile, hint));
}
function loadSplitFile<T>(file: string, what: string, guard: DocGuard<T>, payloadKey: string, wantFile: string, hint?: string): DocLoad<T> {
  const r = loadDocFile(file, what, anyJson, hint);
  if ("error" in r) return r;
  const manifest = manifestProblem(r.doc, file, payloadKey, wantFile);
  if (manifest !== null) return { error: manifest };
  if (guard(r.doc)) return { doc: r.doc };
  return { error: `${what}: '${file}' is not ${guard.expected || "the expected kind of document"}` };
}

// The one reason design/design-system/ is usually missing, stated once: a --node/single-screen pull
// exports that screen and nothing else. Callers append their own "…and here is what to do instead",
// which differs per tool (the map tools can proceed without a map; tokens.ts has variables.json).
const NO_DESIGN_SYSTEM_HINT =
  "A single-screen pull (`dtwin pull --node <id>`) exports only that screen — it does not\n" +
  "       write design/export/design-system/. Run `dtwin pull --design-system` to create it.";

export { manifestProblem, isManifest, readJsonFile, readDocFile, loadDocFile, readOptionalDoc, readSplitFile, loadSplitFile, NO_DESIGN_SYSTEM_HINT };
