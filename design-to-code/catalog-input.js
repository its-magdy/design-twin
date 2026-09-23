// catalog-input.js — the ONE guard that stops these CLIs from being handed the wrong catalog file.
//
// Since the design-system split (bridge/design-system-layout.js), `design/design-system.json` is a
// slim pointer manifest: stamp + `files` map + `counts`, and NO `variables`/`components` payload.
// Every one of these tools used to take that file, so the muscle memory (and every older README, blog
// note or shell history line) points at it. Handing it over now would not crash — the tools would
// happily emit an empty token file or report "0/0 components mapped", which reads like a clean run.
// That is the exact silent-wrong-answer failure this repo refuses to ship, so we fail loud instead.
//
// The tell is unambiguous and needs no filename sniffing: a manifest has a `files` pointer map and
// lacks the payload key the caller needs.
// Split out from the exiting wrapper so the decision itself is testable without a subprocess.
function isManifest(doc, payloadKey) {
  return !!(doc && doc.files && typeof doc.files === "object" && !Array.isArray(doc.files) &&
    !Array.isArray(doc[payloadKey]));
}

function assertNotManifest(doc, givenPath, payloadKey, wantFile) {
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
function readJsonFile(file, what, hint) {
  const fs = require("fs");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    const why = e && e.code === "ENOENT" ? "does not exist"
      : e && e.code === "EISDIR" ? "is a directory, not a file"
      : e && e.code === "EACCES" ? "is not readable (permission denied)"
      : `could not be read (${(e && e.code) || e})`;
    console.error(`error  ${what}: '${file}' ${why}.` + (hint ? `\n       ${hint}` : ""));
    process.exit(2);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`error  ${what}: '${file}' is not valid JSON — ${(e && e.message) || e}`);
    process.exit(2);
  }
}

// The one reason design/design-system/ is usually missing, stated once: a --node/single-screen pull
// exports that screen and nothing else. Callers append their own "…and here is what to do instead",
// which differs per tool (the map tools can proceed without a map; tokens.js has variables.json).
const NO_DESIGN_SYSTEM_HINT =
  "A single-screen pull (`dtwin pull --node <id>`) exports only that screen — it does not\n" +
  "       write design/design-system/. Run `dtwin pull --design-system` to create it.";

module.exports = { assertNotManifest, isManifest, readJsonFile, NO_DESIGN_SYSTEM_HINT };
