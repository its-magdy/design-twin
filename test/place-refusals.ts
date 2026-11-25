// The placement fields' table (#184, bridge/src/place-spec.ts): ops the write refuses for their `page`, `section`,
// `createPage` or `createSection`, and ops it takes. One table for the dry run (test/write-places.test.ts, against the
// wire check) and for the real write (test/harness/places.ts, through the plugin), so the two cannot drift.
import type { WriteOp } from "../bridge/src/commands.ts";

const tree = { name: "Pay", box: { w: 390, h: 844 } };

/** Refused before anything runs, whatever the file holds. `why` is in the refusal. */
export const PLACE_REFUSED: ReadonlyArray<{ op: Record<string, unknown>; why: RegExp }> = [
  { op: { op: "createFrame", name: "F", section: "S" }, why: /`ops\[0\]\.section`: only a createTree/ },
  { op: { op: "createFrame", name: "F", createPage: true }, why: /`ops\[0\]\.createPage`: only a createTree/ },
  { op: { op: "createFrame", name: "F", createPage: false }, why: /`ops\[0\]\.createPage`: only a createTree/ },
  { op: { op: "createFrame", name: "F", createSection: false }, why: /`ops\[0\]\.createSection`: only a createTree/ },
  { op: { op: "createText", text: "Hi", section: "S" }, why: /`ops\[0\]\.section`: only a createTree/ },
  { op: { op: "setFill", nodeId: "1:2", color: "#fff", createSection: true }, why: /`ops\[0\]\.createSection`: only a createTree/ },
  { op: { op: "createTree", tree, createPage: true }, why: /`ops\[0\]\.createPage` needs `page`/ },
  { op: { op: "createTree", tree, createSection: true }, why: /`ops\[0\]\.createSection` needs `section`/ },
  { op: { op: "createTree", tree, section: "  " }, why: /`ops\[0\]\.section` must be a non-empty name or id/ },
  { op: { op: "createTree", tree, page: " ", createPage: true }, why: /a page to make needs a name/ },
  { op: { op: "createTree", tree, page: "Checkout ", createPage: true }, why: /has spaces at its start or end/ },
  { op: { op: "createTree", tree, section: "12:4", createSection: true }, why: /looks like a node id/ },
  { op: { op: "createTree", tree, page: "A", createPage: "yes" }, why: /`ops\[0\]\.createPage`.*a boolean/ },
  { op: { op: "createTree", tree, section: 3 }, why: /`ops\[0\]\.section`.*a string/ },
];

/** Taken by the check (what the file then says is the plugin's: these name only what the test file has). */
export const PLACE_TAKEN: readonly WriteOp[] = [
  { op: "createTree", tree },
  { op: "createTree", tree, page: "Screens" },
  { op: "createTree", tree, page: "Checkout", createPage: true, section: "Pay", createSection: true },
  { op: "createTree", tree, createPage: false, createSection: false },
  { op: "createFrame", name: "F" },
];
