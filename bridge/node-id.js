// Figma node-id parsing — the ONE place that knows what a node id looks like and how it hides in a
// Figma URL. Both Node-side consumers (the MCP write/read server and the seed-components CLI) require
// this instead of carrying their own regex pair, which had already drifted into disagreeing about
// which ids are valid.
//
// A link may carry the id in any of four forms:
//   dash "1-2" · colon "1:2" · percent-encoded "1%3A2" · nested-instance path "I1-2;3-4"
// The Plugin API wants the COLON form, so that's the canonical form everything here returns.

// The node-id token inside a URL, captured loosely and validated by normalizeNodeId. Matching loosely
// matters: a regex that only accepted `[0-9]+-[0-9]+` silently skipped the other three forms.
const ID = "[A-Za-z0-9%:;_-]+";
const NODE_ID_RE = new RegExp("node-id=(" + ID + ")");

function decode(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; } // malformed escape — use it verbatim
}

// A raw node-id token -> the Plugin API's colon form ("1:2"), or undefined when it isn't an id.
function normalizeNodeId(raw) {
  if (!raw) return undefined;
  const s = decode(String(raw).trim()).replace(/-/g, ":");
  // "1:2", "I1:2;3:4" (nested instance path), or a bare numeric id.
  return /^I?\d+:\d+(?:[;:]\d+:\d+)*$/.test(s) || /^\d+$/.test(s) ? s : undefined;
}

// A full Figma URL, a `…node-id=…` fragment, or a bare id -> colon form, or undefined when there's
// no id to be found (callers surface their own friendly hint).
function parseNodeId(input) {
  if (!input) return undefined;
  const s = String(input).trim();
  try {
    // searchParams already percent-decodes, so this branch hands normalizeNodeId a decoded token.
    const nid = new URL(s).searchParams.get("node-id");
    if (nid) return normalizeNodeId(nid);
  } catch (e) { /* not a full URL — fall through to the loose match */ }
  const m = s.match(NODE_ID_RE);
  if (m) return normalizeNodeId(m[1]);
  return normalizeNodeId(s); // bare id
}

module.exports = { ID, NODE_ID_RE, normalizeNodeId, parseNodeId };
