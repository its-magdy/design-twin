// The review card's lines (docs/write-plane-spec.md decision 18): what a write batch is about to do, in the words a
// designer reads — "30 layers: radius 6 → 20, opacity 100% → 80%", "Variable 'color/accent': #3b82f6 → #16a34a — 40
// layers follow", "New frame 'Settings card', 320 wide, height hugs content — lands right of the existing frames". No
// node ids, no rollback or check details: those stay in the dry run's sentences (commands.ts reviewLines), which the
// card keeps behind its collapsed "Details".
//
// Pure, like the dry run's preview it sits beside: the ops say what changes to what; what only the file knows — a
// layer's name and the value it holds now, how many layers follow a source edit, where a new frame lands — comes in
// as one OpRead per op, read by the plugin (figma-plugin/src/review-reads.ts) once the batch has resolved. A field the
// plugin could not read just shows its new value.
//
// Ops that set the same fields to the same values become one line ("30 layers: …"); old values that differ between
// the layers read "mixed".
import type { WriteOp } from "./commands.ts";
import { checkPatch, isPatchSet } from "./patch-spec.ts";
import { checkStyleSet, isStyleSet } from "./source-spec.ts";
import { checkCreateStyles, checkCreateVariables } from "./create-spec.ts";
import { checkTree } from "./tree-check.ts";
import { componentRootOf } from "./component-spec.ts";
import { sizePhrase, type TreeNodeSpec } from "./tree-spec.ts";

/** What the file says about one op, for its line. Every field is optional: a read that failed leaves it out. */
export interface OpRead {
  /** the layer, variable or style it changes, by name */
  name?: string;
  /** a patch of a layer inside a main component, a component re-send: the component's name */
  component?: string;
  /** the value each field it sets holds now, in the spec's own vocabulary (a colour as "#rrggbb", fills as the spec's
   *  paints, an opacity as 0–1); a setVariable's by mode name */
  old?: Record<string, unknown>;
  /** how many existing layers and instances follow a source edit */
  follows?: number;
  /** a new tree: where it lands ("right of the existing frames", "at 40, 120"), and on which page when not the current */
  lands?: string;
  /** a keyed createTree re-send or a component re-send: what it updates in place, by name */
  updates?: string;
  /** move / createFrame / createText: the parent, by name */
  parent?: string;
}

/** One value change on a line: `from` absent when the old value could not be read. */
export interface CardRow { field: string; from?: string; to: string }

/** One line of the card: `head`, then its rows ("radius 6 → 20, …"), then `tail` ("— 40 layers follow"). `ops`: the
 *  indexes of the ops it stands for. */
export interface CardLine { head: string; rows: CardRow[]; tail?: string; ops: number[] }

/** A line as one plain sentence (the window draws the same parts with colour swatches). */
export function lineText(l: CardLine): string {
  return l.head + (l.rows.length ? ": " + l.rows.map(rowText).join(", ") : "") + (l.tail ? " — " + l.tail : "");
}
export function rowText(r: CardRow): string {
  return (r.field ? r.field + " " : "") + (r.from !== undefined ? r.from + " → " : "→ ") + r.to;
}

const plural = (n: number, one: string, many: string = one + "s"): string => n + " " + (n === 1 ? one : many);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const cut = (s: string, n = 40): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** A paint list in a few words: its first solid colour, "image", "none" (later paints are said as "+N"). */
function paintsText(v: unknown[]): string {
  if (!v.length) return "none";
  const first = v[0];
  const one = isObj(first)
    ? typeof first.color === "string" ? first.color
      : first.type === "image" ? "image"
      : isObj(first.tokens) && typeof first.tokens.color === "string" ? "variable '" + first.tokens.color + "'"
      : typeof first.type === "string" ? first.type : "paint"
    : "paint";
  return one + (v.length > 1 ? " +" + (v.length - 1) : "");
}

/** A value in a few words, the way the card shows it. `field` says how to read a number (opacity as a percentage). */
export function valueText(field: string, v: unknown): string {
  if (v === undefined) return "—";
  if (v === null) return "none";
  if (typeof v === "number") return field === "opacity" ? Math.round(v * 100) + "%" : String(Math.round(v * 100) / 100);
  if (typeof v === "boolean") return field === "hidden" ? (v ? "hidden" : "shown") : v ? "on" : "off";
  if (typeof v === "string") return field === "text" || field === "characters" ? "“" + cut(v) + "”" : cut(v);
  if (Array.isArray(v)) return field === "fills" || field === "strokes" || field === "paints" || field === "fill" ? paintsText(v) : cut(v.map((x) => valueText("", x)).join(", "));
  if (isObj(v)) {
    if (typeof v.aliasOf === "string") return "alias of '" + v.aliasOf + "'";
    if (field === "box" && (typeof v.w === "number" || typeof v.h === "number")) return (typeof v.w === "number" ? v.w : "…") + "×" + (typeof v.h === "number" ? v.h : "…");
    if (field === "strokes" && Array.isArray(v.paints)) return paintsText(v.paints) + (typeof v.weight === "number" ? ", " + v.weight + " px" : "");
    return cut(Object.keys(v).map((k) => k + " " + valueText(k, v[k])).join(", "));
  }
  return cut(String(v));
}

/** The old values of a group of layers, as one text: the shared one, or "mixed". */
function oldText(field: string, reads: ReadonlyArray<OpRead | undefined>): string | undefined {
  const seen = new Set<string>();
  for (const r of reads) {
    if (!r || !r.old || !(field in r.old)) return undefined; // one layer unread: no "from" at all, never a wrong one
    seen.add(valueText(field, r.old[field]));
  }
  if (!seen.size) return undefined;
  return seen.size === 1 ? [...seen][0] : "mixed";
}

/** The rows of a set of fields: old (across the group) → new. */
function fieldRows(set: Record<string, unknown>, fields: readonly string[], reads: ReadonlyArray<OpRead | undefined>): CardRow[] {
  return fields.map((f) => {
    const from = oldText(f, reads);
    return { field: f, to: valueText(f, set[f]), ...(from !== undefined ? { from } : {}) };
  });
}

/** "Layer 'Title'", or "A layer" when the plugin could not read its name (never its id: the card has none). */
const named = (kind: string, r: OpRead | undefined): string => (r && r.name ? kind + " '" + r.name + "'" : "A " + kind.toLowerCase());

/** A follow count in words, for a source edit's tail. */
const followTail = (r: OpRead | undefined): string | undefined =>
  r && typeof r.follows === "number" ? (r.follows === 1 ? "1 layer follows" : r.follows ? r.follows + " layers follow" : "nothing uses it yet") : undefined;

/** The card's lines for `ops`, `reads[i]` being what the file said about op i (absent: nothing read). */
export function cardLines(ops: readonly WriteOp[], reads: ReadonlyArray<OpRead | undefined> = []): CardLine[] {
  const lines: CardLine[] = [];
  // Ops of one kind that set the same thing (a patch's `set`, a fill's colour, a text): one line, by this key.
  const groups = new Map<string, CardLine & { reads: Array<OpRead | undefined>; build: (ls: CardLine & { reads: Array<OpRead | undefined> }) => void }>();
  const group = (key: string, i: number, build: (g: CardLine & { reads: Array<OpRead | undefined> }) => void): void => {
    const g = groups.get(key);
    if (g) { g.ops.push(i); g.reads.push(reads[i]); return; }
    const fresh = { head: "", rows: [], ops: [i], reads: [reads[i]], build };
    groups.set(key, fresh);
    lines.push(fresh);
  };
  ops.forEach((o, i) => {
    const r = reads[i];
    switch (o.op) {
      case "patch": {
        if (!isPatchSet(o.set)) { lines.push({ head: "Layer change", rows: [], ops: [i] }); return; }
        const set = o.set as unknown as Record<string, unknown>;
        // In the order the agent wrote them (the checked list says which count).
        const checked = checkPatch(o.set).summary.fields as string[];
        const fields = Object.keys(set).filter((k) => checked.indexOf(k) >= 0);
        // A layer inside a main component is a source edit: its own line, with what follows it.
        if (r && r.component !== undefined) {
          const tail = followTail(r);
          lines.push({ head: "Main component '" + r.component + "'" + (r.name && r.name !== r.component ? ", layer '" + r.name + "'" : ""), rows: fieldRows(set, fields, [r]), ...(tail ? { tail } : {}), ops: [i] });
          return;
        }
        group("patch " + JSON.stringify(o.set), i, (g) => {
          g.head = g.ops.length === 1 ? named("Layer", g.reads[0]) : plural(g.ops.length, "layer");
          g.rows = fieldRows(set, fields, g.reads);
        });
        return;
      }
      case "setFill":
        group("fill " + String(o.color), i, (g) => {
          g.head = g.ops.length === 1 ? named("Layer", g.reads[0]) : plural(g.ops.length, "layer");
          const from = oldText("fill", g.reads);
          g.rows = [{ field: "fill", to: String(o.color), ...(from !== undefined ? { from } : {}) }];
        });
        return;
      case "setText":
        group("text " + JSON.stringify(o.text), i, (g) => {
          g.head = g.ops.length === 1 ? named("Text", g.reads[0]) : plural(g.ops.length, "text");
          const from = oldText("text", g.reads);
          g.rows = [{ field: "text", to: valueText("text", o.text || ""), ...(from !== undefined ? { from } : {}) }];
        });
        return;
      case "setVariableMode":
      case "clearVariableMode": {
        const to = o.op === "clearVariableMode" ? "inherited" : "'" + String(o.mode) + "'";
        group("mode " + String(o.collection) + " " + to, i, (g) => {
          g.head = g.ops.length === 1 ? named("Layer", g.reads[0]) : plural(g.ops.length, "layer");
          g.rows = [{ field: "'" + String(o.collection) + "' mode", to }];
        });
        return;
      }
      case "setVariable": {
        const vals: Array<[string, unknown]> = o.value !== undefined ? [["", o.value]] : isObj(o.values) ? Object.entries(o.values) : [];
        const rows = vals.map(([mode, v]): CardRow => {
          const was = r && r.old ? (mode === "" ? Object.values(r.old)[0] : r.old[mode]) : undefined;
          return { field: mode, to: valueText("", v), ...(was !== undefined ? { from: valueText("", was) } : {}) };
        });
        const tail = followTail(r);
        lines.push({ head: "Variable '" + String(o.variable) + "'", rows, ...(tail ? { tail } : {}), ops: [i] });
        return;
      }
      case "setStyle": {
        const set = isStyleSet(o.set) ? (o.set as unknown as Record<string, unknown>) : {};
        const fields = isStyleSet(o.set) ? (checkStyleSet(o.set).summary.fields as string[]) : [];
        const tail = followTail(r);
        lines.push({ head: "Style '" + String(o.style) + "'", rows: fieldRows(set, fields, [r]), ...(tail ? { tail } : {}), ops: [i] });
        return;
      }
      case "createTree": {
        const spec = o.tree as TreeNodeSpec | undefined;
        const { summary } = checkTree(o.tree);
        if (r && r.updates !== undefined) {
          const comp = componentRootOf(o.tree);
          const tail = comp ? followTail(r) : undefined;
          lines.push({ head: (comp ? "Updates component '" : "Updates '") + r.updates + "' in place", rows: [], ...(tail ? { tail } : {}), ops: [i] });
          return;
        }
        const c = summary.component;
        const what = spec && spec.clone !== undefined ? "New copy of a layer" + (spec.name !== undefined ? " named '" + spec.name + "'" : "")
          : c ? (c.type === "COMPONENT_SET" ? "New component set '" + c.name + "' (" + plural(c.variants, "variant") + ")" : "New component '" + c.name + "'")
          : "New frame '" + (spec && spec.name ? spec.name : "Frame") + "'";
        const size = spec ? sizePhrase(spec) : "";
        const inside = summary.frames + summary.texts + summary.instances + summary.clones - (c ? 0 : 1);
        const head = what + (size ? ", " + size : "") + (inside > 0 ? ", " + plural(inside, "layer") + " inside" : "");
        const lands = r && r.lands ? "lands " + r.lands : undefined;
        lines.push({ head, rows: [], ...(lands ? { tail: lands } : {}), ops: [i] });
        return;
      }
      case "createFrame": {
        const size = o.width && o.height ? ", " + o.width + "×" + o.height : "";
        lines.push({ head: "New frame" + (o.name ? " '" + o.name + "'" : "") + size + (o.fill ? ", fill " + o.fill : ""), rows: [], tail: r && r.parent ? "inside '" + r.parent + "'" : "on the current page", ops: [i] });
        return;
      }
      case "createText":
        lines.push({ head: "New text " + valueText("text", o.text || "") + (o.fontSize ? ", size " + o.fontSize : ""), rows: [], tail: r && r.parent ? "inside '" + r.parent + "'" : "on the current page", ops: [i] });
        return;
      case "move":
        lines.push({ head: "Moves " + (r && r.name ? "'" + r.name + "'" : "a layer") + (r && r.parent ? " into '" + r.parent + "'" : ""), rows: [], ops: [i] });
        return;
      case "delete":
        lines.push({ head: "Deletes " + (r && r.name ? "'" + r.name + "'" : "a layer") + " and everything inside it", rows: [], tail: "cannot be put back from here", ops: [i] });
        return;
      case "createVariables": {
        const { summary } = checkCreateVariables(o);
        lines.push({ head: "Variables in collection '" + summary.collection + "': " + plural(summary.rows.length, "row"), rows: [], tail: "new names are created, names the file has are updated", ops: [i] });
        return;
      }
      case "createStyles": {
        const { rows } = checkCreateStyles(o);
        lines.push({ head: "Styles: " + plural(rows.length, "row") + (rows.length ? " (" + rows.slice(0, 3).map((s) => "'" + s.name + "'").join(", ") + (rows.length > 3 ? ", …" : "") + ")" : ""), rows: [], tail: "new names are created, names the file has are updated", ops: [i] });
        return;
      }
      default: {
        const never: never = o.op;
        lines.push({ head: String(never), rows: [], ops: [i] });
      }
    }
  });
  for (const g of groups.values()) g.build(g);
  // The grouping state is not part of a line.
  return lines.map((l) => ({ head: l.head, rows: l.rows, ...(l.tail !== undefined ? { tail: l.tail } : {}), ops: l.ops }));
}
