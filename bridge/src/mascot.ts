// Bo, the Design Twin mark, as a terminal sprite: the same drawing as assets/logo.svg (a hollow selection box,
// four magenta handles, two eyes), drawn in half-blocks so one text cell holds two pixels stacked.
//
// Shown only by `dtwin --version` / `dtwin version` when stdout is a terminal and no --json was asked for. Piped,
// redirected or with --json, --version prints the bare version string and nothing else, so a script reading it is
// unaffected. A locale that is set and is not UTF-8 (LANG=C, a Latin-1 locale) also gets the bare version: the
// half-blocks would print as mojibake there.
//
// The grid is drawn so no cell mixes a handle pixel with an ink pixel. The ink is the terminal's own foreground
// colour (right on light and dark themes), and only the handles get a colour, so a cell never needs two colours.
// Colour follows the usual conventions: FORCE_COLOR (1/true/empty = 16 colours, 2 = 256, 3 = truecolor, anything else = off) wins, then
// NO_COLOR (https://no-color.org) and TERM=dumb turn it off; otherwise the depth is read from COLORTERM / TERM. With
// colour off the handles print in the foreground colour too: just the outline.

// "a" handle (magenta), "k" ink (the terminal's foreground), "." empty. 13 × 12 pixels → 13 × 6 cells.
export const BO_GRID: readonly string[] = [
  "aaa.......aaa",
  "aaakkkkkkkaaa",
  ".k.........k.",
  ".k.kk...kk.k.",
  ".k.kk...kk.k.",
  ".k.kk...kk.k.",
  ".k.........k.",
  ".k.........k.",
  ".k.........k.",
  ".k.........k.",
  "aaakkkkkkkaaa",
  "aaa.......aaa",
];

// Brand magenta per colour depth: truecolor #e05aaf (a touch lighter than #d6409f, so it holds up on dark terminals
// as well as light ones), xterm-256 colour 169 (#d75faf), and bright magenta on a 16-colour terminal.
export type ColorLevel = 0 | 1 | 2 | 3;
const HANDLE: Record<Exclude<ColorLevel, 0>, string> = { 3: "\u001b[38;2;224;90;175m", 2: "\u001b[38;5;169m", 1: "\u001b[95m" };
const RESET = "\u001b[0m";
type Env = Record<string, string | undefined>;

/** The sprite as lines of text, every line 13 cells wide: ▀ / ▄ / █ per cell, handles coloured at `level` (0 = none).
 *  Throws on a cell that mixes a handle with ink (it cannot be drawn without picking a background colour). */
export function boLines(level: ColorLevel): string[] {
  const handle = level === 0 ? "" : HANDLE[level];
  const lines: string[] = [];
  for (let y = 0; y < BO_GRID.length; y += 2) {
    const top = BO_GRID[y] ?? "";
    const bottom = BO_GRID[y + 1] ?? "";
    let line = "";
    let open = false;
    for (let x = 0; x < Math.max(top.length, bottom.length); x++) {
      const t = top[x] ?? ".";
      const b = bottom[x] ?? ".";
      const kinds = new Set([t, b].filter((p) => p !== "."));
      if (kinds.size > 1) throw new Error(`mascot: cell ${x},${y / 2} mixes a handle with ink`);
      const ch = t !== "." && b !== "." ? "█" : t !== "." ? "▀" : b !== "." ? "▄" : " ";
      const wantColor = handle !== "" && kinds.has("a");
      if (wantColor && !open) { line += handle; open = true; }
      if (!wantColor && open) { line += RESET; open = false; }
      line += ch;
    }
    if (open) line += RESET;
    lines.push(line);
  }
  return lines;
}

// The depth the terminal says it has, ignoring the on/off switches.
function detectedLevel(env: Env, platform: string): Exclude<ColorLevel, 0> {
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return 3;
  if (platform === "win32" && env.TERM === undefined) return 3; // Windows Terminal and the Windows 10+ console
  if (/256/.test(env.TERM ?? "") || colorterm !== "") return 2;
  return 1;
}

/** How to colour the handles: FORCE_COLOR first, then NO_COLOR / TERM=dumb, then what the terminal reports. */
export function colorLevel(env: Env, platform: string = process.platform): ColorLevel {
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === "0" || force.toLowerCase() === "false") return 0;
    if (force === "" || force === "1" || force.toLowerCase() === "true") return 1; // as Node and chalk read it
    if (force === "2") return 2;
    if (force === "3") return 3;
    return 0; // any other value: off, as Node reads it
  }
  if (env.NO_COLOR) return 0;
  if (env.TERM === "dumb") return 0;
  return detectedLevel(env, platform);
}

/** Whether the half-block glyphs can be printed: false only when a locale is set and is not UTF-8. */
export function utf8Locale(env: Env, platform: string = process.platform): boolean {
  if (platform === "win32") return true; // the console decodes Bun's UTF-8 output itself
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  return !locale || /utf-?8/i.test(locale);
}

/** Whether --version may draw Bo at all: only on an interactive terminal, and never when --json was asked for. */
export function spriteAllowed(stdoutIsTTY: boolean, argv: readonly string[]): boolean {
  return stdoutIsTTY && !argv.includes("--json");
}

/** What `dtwin --version` prints. `tty` false (piped, redirected, or --json) → the bare version; true → Bo beside it. */
export function versionText(version: string, tty: boolean, env: Env, platform: string = process.platform): string {
  if (!tty || !utf8Locale(env, platform)) return version;
  const art = boLines(colorLevel(env, platform));
  const text = ["", "", `Design Twin ${version}`, "the Figma ↔ code companion", "", ""];
  return art.map((row, i) => `${row}   ${text[i] ?? ""}`.trimEnd()).join("\n");
}
