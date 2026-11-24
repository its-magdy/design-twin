// place-spec.ts — where a createTree lands (docs/write-plane-spec.md decision 13): a page (the current one by default),
// optionally a section on it, either of which the op may ask to make when the file has none of that name.
//
//   {op: "createTree", page: "Checkout", createPage: true, section: "Pay", createSection: true, tree: {…}}
//
// Making is asked for, never inferred (decision 15: a name that matches nothing is refused, not taken as a new one). A
// name the file has exactly once is used as it is, so the same batch sent again lands on the page it made the first
// time. This is the pure half, run by the wire check (commands.ts writeOpError), the dry run and the plugin alike; the
// file's half (which pages and sections exist, making them, placing inside a section) is figma-plugin/src/places.ts.
// Pure and dependency-free: the plugin bundle imports it.

/** The most pages and sections one batch may make (each is a page or section the file did not have). */
export const MAX_NEW_PAGES = 10;
export const MAX_NEW_SECTIONS = 25;
/** The margin between a section's edge and the frames the plugin places in it (px). */
export const SECTION_PAD = 80;

/** A createTree's placement fields, as the wire carries them (checked by placeError before anything reads them). */
export interface Place {
  page?: string | undefined;
  section?: string | undefined;
  createPage?: boolean | undefined;
  createSection?: boolean | undefined;
}

/** The fields only a createTree takes. (`page` is older and any op may carry it; only createTree reads it.) */
const CREATE_TREE_ONLY = ["section", "createPage", "createSection"] as const;

/** A node id as Figma writes one (an instance's layer: `I1:2;3:4`), in its colon or URL dash form. */
const ID_LIKE = /^I?\d+[:-]\d+(;\d+[:-]\d+)*$/;

/** The problem with a name the op asks to make, or null. */
function newNameError(name: string, what: "page" | "section", at: string): string | null {
  if (!name.trim()) return "`" + at + "." + what + "`: a " + what + " to make needs a name";
  if (name !== name.trim()) return "`" + at + "." + what + "`: '" + name + "' has spaces at its start or end; a " + what + " is matched by its exact name, so make it without them";
  if (ID_LIKE.test(name)) return "`" + at + "." + what + "`: '" + name + "' looks like a node id, not a name; a " + what + " to make needs a name";
  return null;
}

/** The first problem with op `o`'s placement fields (their types are the wire check's), or null. `at` is its path. */
export function placeError(o: Readonly<Record<string, unknown>>, at: string): string | null {
  for (const k of CREATE_TREE_ONLY) {
    if (o[k] !== undefined && o.op !== "createTree") return "`" + at + "." + k + "`: only a createTree lands in a section or makes a page or section (`section`, `createPage`, `createSection`)";
  }
  if (o.op !== "createTree") return null;
  const page = typeof o.page === "string" ? o.page : undefined;
  const section = typeof o.section === "string" ? o.section : undefined;
  if (o.createPage === true && page === undefined) return "`" + at + ".createPage` needs `page`: the name of the page to make (it is made when the file has no page of that name)";
  if (o.createSection === true && section === undefined) return "`" + at + ".createSection` needs `section`: the name of the section to make (it is made when the page has no section of that name)";
  if (section !== undefined && !section.trim()) return "`" + at + ".section` must be a non-empty name or id";
  if (o.createPage === true && page !== undefined) { const e = newNameError(page, "page", at); if (e) return e; }
  if (o.createSection === true && section !== undefined) { const e = newNameError(section, "section", at); if (e) return e; }
  return null;
}

/** Whether `ref` reads as a Figma node id ("12:34"): a section given so, with no page, is the one of that id on any page
 *  (the plugin looks it up across the file; places.ts resolveDests). */
export const nodeIdLike = (ref: string): boolean => /^\d+:\d+$/.test(ref);
/** Whether `ref` reads as any node id, a link's dash form (`6-2`) and an instance layer's (`I1:2;3:4`) included: never a
 *  name to make (the wire check refuses one), so a lookup that misses one says what it is instead. */
export const idLike = (ref: string): boolean => ID_LIKE.test(ref);

/** Where the op lands, in words: "in section 'Pay' (made when the page has none) on page 'Checkout'", "on the current page",
 *  "in section '6:2' on the page that holds it" (a section id with no page). */
export function describePlace(p: Place): string {
  const page = p.page !== undefined ? "on page '" + p.page + "'" + (p.createPage === true ? " (made when the file has none)" : "")
    : p.section !== undefined && nodeIdLike(p.section) ? "on the page that holds it" : "on the current page";
  return p.section !== undefined ? "in section '" + p.section + "'" + (p.createSection === true ? " (made when the page has none)" : "") + " " + page : page;
}
