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

module.exports = { assertNotManifest, isManifest };
