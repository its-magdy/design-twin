// The hex colour a figma_write op carries (`fill`, `color`): validated at both ends — the MCP
// schema (figma-mcp.ts) and the plugin's write executor (figma-plugin/src/writes.ts) — so a value that is not a
// colour is refused instead of being painted as a wrong one (a lenient parse turns "red" into #rreedd
// and every unparseable channel into 0). Dependency-free: the plugin bundle imports it too.

/** `#` then 3, 4, 6 or 8 hex digits (#rgb, #rgba, #rrggbb, #rrggbbaa). The `#` is required: "bad" or
 *  "fade" are words as often as colours. */
export const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** What an error says the value should look like. */
export const HEX_COLOR_HINT = "a hex colour like #1A2B3C (#rgb, #rgba, #rrggbb or #rrggbbaa)";

/** Channels 0..1; `a` is present only when the value carried an alpha digit pair. */
export interface HexColor { r: number; g: number; b: number; a?: number }

/** Parse a hex colour (see HEX_COLOR_RE), or null when the value is anything else. Shorthand doubles each digit. */
export function parseHexColor(value: unknown): HexColor | null {
  if (typeof value !== "string" || !HEX_COLOR_RE.test(value)) return null;
  let h = value.slice(1);
  if (h.length <= 4) h = h.split("").map((c) => c + c).join("");
  const chan = (i: number): number => parseInt(h.slice(i, i + 2), 16) / 255;
  const c: HexColor = { r: chan(0), g: chan(2), b: chan(4) };
  if (h.length === 8) c.a = chan(6);
  return c;
}
