// Where a new screen lands (#184), the pure halves: a createTree's `page`, `section`, `createPage` and `createSection`
// checked by the wire check (bridge/src/place-spec.ts through commands.ts writeOpError), said by the dry run's preview
// (commands.ts writeOpPreview, tree-spec.ts describeTree) and by the review card's line (review-card.ts).
//   bun test/write-places.test.ts
import { check, report } from "./assert.ts";
import { MAX_NEW_PAGES, MAX_NEW_SECTIONS, placeError, SECTION_PAD } from "../bridge/src/place-spec.ts";
import { writeOpError, writeOpPreview } from "../bridge/src/commands.ts";
import { cardLines, lineText } from "../bridge/src/review-card.ts";
import { PLACE_REFUSED, PLACE_TAKEN } from "./place-refusals.ts";

const tree = { name: "Pay", box: { w: 390, h: 844 } };
const op = (o: Record<string, unknown>): Record<string, unknown> => ({ op: "createTree", tree, ...o });
const err = (o: Record<string, unknown>): string => String(writeOpError(o, 0));

console.log("\nthe wire check:");
check("a page and a section, to use or to make, pass", [
  {}, { page: "Checkout" }, { page: "Checkout", createPage: true }, { section: "Pay" }, { section: "Pay", createSection: true },
  { page: "Checkout", createPage: true, section: "Pay", createSection: true }, { page: "0:2", section: "12:4" }, { createPage: false, createSection: false },
].every((o) => writeOpError(op(o), 0) === null));
check("createPage and createSection are booleans, section a string",
  /ops\[0\]\.createPage.*a boolean/.test(err(op({ page: "A", createPage: "yes" }))) && /ops\[0\]\.createSection.*a boolean/.test(err(op({ section: "A", createSection: 1 })))
  && /ops\[0\]\.section.*a string/.test(err(op({ section: 3 }))));
check("createPage needs the page's name", /`ops\[0\]\.createPage` needs `page`: the name of the page to make/.test(err(op({ createPage: true }))));
check("createSection needs the section's name", /`ops\[0\]\.createSection` needs `section`: the name of the section to make/.test(err(op({ createSection: true }))));
check("a blank section is refused", /`ops\[0\]\.section` must be a non-empty name or id/.test(err(op({ section: "  " }))));
check("a page or section to make needs a real name: not blank", /`ops\[0\]\.page`: a page to make needs a name/.test(err(op({ page: " ", createPage: true }))));
check("…no spaces at its ends (a name is matched exactly)", /`ops\[0\]\.page`: 'Checkout ' has spaces at its start or end/.test(err(op({ page: "Checkout ", createPage: true })))
  && /`ops\[0\]\.section`: ' Pay' has spaces/.test(err(op({ section: " Pay", createSection: true }))));
check("…and not one that reads as a node id (it would name a node, not make one)",
  /`ops\[0\]\.page`: '12:4' reads as a node id/.test(err(op({ page: "12:4", createPage: true }))) && /`ops\[0\]\.section`: 'I1:2;3:4' reads as a node id/.test(err(op({ section: "I1:2;3:4", createSection: true }))));
check("an id-like page without createPage is just a lookup (an id)", writeOpError(op({ page: "12:4" }), 0) === null);
check("only a createTree lands in a section or makes a page", ["section", "createPage", "createSection"].every((k) =>
  new RegExp("`ops\\[0\\]\\." + k + "`: only a createTree").test(err({ op: "createFrame", name: "F", [k]: k === "section" ? "S" : true }))));
check("the pure check itself, by its path", placeError({ op: "createTree", createPage: true }, "ops[3]") === "`ops[3].createPage` needs `page`: the name of the page to make (it is made when the file has no page of that name)");
check("the limits: 10 new pages and 25 new sections a batch; an 80 px margin in a section", MAX_NEW_PAGES === 10 && MAX_NEW_SECTIONS === 25 && SECTION_PAD === 80);

console.log("\nthe dry run:");
const pv = (o: Record<string, unknown>) => writeOpPreview({ op: "createTree", tree, ...o }, 0);
check(`a section on the current page (got ${JSON.stringify(pv({ section: "Pay" }).target)})`, pv({ section: "Pay" }).target === "new frame in section 'Pay' on the current page");
check("a new page is said as made when the file has none", pv({ page: "Checkout", createPage: true }).target === "new frame on page 'Checkout' (made when the file has none)");
check("a new section on a new page", pv({ page: "Checkout", createPage: true, section: "Pay", createSection: true }).target
  === "new frame in section 'Pay' (made when the page has none) on page 'Checkout' (made when the file has none)");
const ch = String(pv({ page: "Checkout", section: "Pay" }).change);
check(`the change sentence: inside the section, beside its frames, the section grows (got ${JSON.stringify(ch)})`,
  /^creates frame 'Pay' 390×844 with 1 node \(1 frame, 0 texts\) in section 'Pay' on page 'Checkout', placed beside the frames already in it \(the section grows to fit\) — /.test(ch)
  && /the page, its section and fonts are checked against the file when applied/.test(ch));
const at = String(writeOpPreview({ op: "createTree", tree: { ...tree, x: 40, y: 60 }, section: "Pay" }, 0).change);
check(`explicit coordinates in a section are the section's own (got ${JSON.stringify(at)})`, /in section 'Pay' on the current page at 40,60 inside it \(the section grows to fit\)/.test(at));
check("without a section the sentence is as before", /on page 'Screens' at 0,0/.test(String(writeOpPreview({ op: "createTree", page: "Screens", tree: { name: "A", x: 0, y: 0 } }, 0).change))
  && /on the current page, placed beside the existing frames — /.test(String(pv({}).change)) && /the page and fonts are checked/.test(String(pv({}).change)));
// The dry run refuses what the write refuses (the real write's half of this table: test/harness/places.ts).
for (const { op: o, why } of PLACE_REFUSED) {
  const real = writeOpError(o, 0);
  const dry = writeOpPreview(o as never, 0).invalid;
  check(`the dry run and the write both refuse ${JSON.stringify(o)} (dry run: ${JSON.stringify(dry)})`, real !== null && why.test(real) && dry !== undefined && why.test(dry));
}
check("…and both take the ops the check takes", PLACE_TAKEN.every((o) => writeOpError(o, 0) === null && writeOpPreview(o, 0).invalid === undefined));
check("an op the check refuses previews as invalid", writeOpPreview({ op: "createTree", tree, createPage: true }, 0).invalid === "`ops[0].createPage` needs `page`: the name of the page to make (it is made when the file has no page of that name)");

console.log("\nthe review card:");
const line = (o: Record<string, unknown>, lands: string): string => {
  const [l] = cardLines([{ op: "createTree", tree, ...o }], [{ lands }]);
  return l ? lineText(l) : "";
};
check(`a new page and section are said on the line (got ${JSON.stringify(line({ page: "Checkout", createPage: true, section: "Pay", createSection: true }, "in a new section 'Pay' on a new page 'Checkout'"))})`,
  line({ page: "Checkout", createPage: true, section: "Pay", createSection: true }, "in a new section 'Pay' on a new page 'Checkout'") === "New frame 'Pay', 390×844 — lands in a new section 'Pay' on a new page 'Checkout'");

report();
