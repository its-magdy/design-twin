// Bo, the terminal sprite `dtwin --version` prints on a terminal (bridge/src/mascot.ts), and the brand files it
// mirrors (assets/): the README headers, the plugin window's mark, the social preview.
//   bun test/mascot.test.ts
import fs from "node:fs";
import path from "node:path";
import { check, report } from "./assert.ts";
import { dtwinSync } from "./children.ts";
import { BO_GRID, boLines, colorLevel, spriteAllowed, utf8Locale, versionText, type ColorLevel } from "../bridge/src/mascot.ts";

const ESC = "\u001b";
const visible = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");
const ROOT = path.join(import.meta.dirname, "..");

// ---------------------------------------------------------------- the sprite

check("grid: 12 pixel rows of 13, only a / k / .",
  BO_GRID.length === 12 && BO_GRID.every((r) => r.length === 13 && /^[ak.]+$/.test(r)));
check("grid: left-right symmetric (a selection box with two eyes)",
  BO_GRID.every((r) => r === [...r].reverse().join("")));
check("grid: top-bottom symmetric outside the eyes", BO_GRID[0] === BO_GRID[11] && BO_GRID[1] === BO_GRID[10]);

const byLevel = new Map<ColorLevel, string[]>();
let threw = "";
try { for (const l of [0, 1, 2, 3] as const) byLevel.set(l, boLines(l)); } catch (e) { threw = String(e); }
check("no cell mixes a handle with ink (each cell needs one colour only)", threw === "");
const plain = byLevel.get(0) ?? [];
check("6 lines, each 13 cells wide at every colour depth once the codes are stripped",
  [...byLevel.values()].every((ls) => ls.length === 6 && ls.every((l) => [...visible(l)].length === 13)));
check("every colour depth draws the same picture", [...byLevel.values()].every((ls) => ls.map(visible).join("\n") === plain.join("\n")));
check("colour off: no escape at all", plain.every((l) => !l.includes(ESC)));
const opens = (ls: string[]): string => ls.join("").match(/\u001b\[(?!0m)[0-9;]*m/g)?.[0] ?? "";
check("truecolor / 256 / 16 colours each use their own code (#e05aaf, 169, bright magenta)",
  opens(byLevel.get(3) ?? []) === `${ESC}[38;2;224;90;175m` && opens(byLevel.get(2) ?? []) === `${ESC}[38;5;169m` && opens(byLevel.get(1) ?? []) === `${ESC}[95m`);
check("every colour opened on a line is reset on that line",
  [1, 2, 3].every((l) => (byLevel.get(l as ColorLevel) ?? []).every((s) => (s.match(/\u001b\[(?!0m)[0-9;]*m/g) ?? []).length === (s.match(/\u001b\[0m/g) ?? []).length)));

// ---------------------------------------------------------------- colour and locale rules

const mac = "darwin";
check("depth: COLORTERM=truecolor → 3, TERM=*256color → 2, plain xterm → 1",
  colorLevel({ COLORTERM: "truecolor", TERM: "xterm" }, mac) === 3 && colorLevel({ TERM: "xterm-256color" }, mac) === 2 && colorLevel({ TERM: "xterm" }, mac) === 1);
check("NO_COLOR (any non-empty value) and TERM=dumb → off; an empty NO_COLOR is ignored",
  colorLevel({ NO_COLOR: "1", COLORTERM: "truecolor" }, mac) === 0 && colorLevel({ TERM: "dumb" }, mac) === 0 && colorLevel({ NO_COLOR: "", TERM: "xterm-256color" }, mac) === 2);
check("FORCE_COLOR wins (as Node/chalk): 0/false → off; empty/true/1 → 16 colours; 2/3 → that depth, even over NO_COLOR or TERM=dumb; any other value → off",
  colorLevel({ FORCE_COLOR: "0", COLORTERM: "truecolor" }, mac) === 0 && colorLevel({ FORCE_COLOR: "false" }, mac) === 0
  && colorLevel({ FORCE_COLOR: "1", NO_COLOR: "1" }, mac) === 1 && colorLevel({ FORCE_COLOR: "3", TERM: "dumb" }, mac) === 3
  && colorLevel({ FORCE_COLOR: "", TERM: "xterm-256color", NO_COLOR: "1" }, mac) === 1 && colorLevel({ FORCE_COLOR: "true", COLORTERM: "truecolor" }, mac) === 1
  && colorLevel({ FORCE_COLOR: "yes", TERM: "xterm-256color" }, mac) === 0);
check("Windows console with no TERM → truecolor", colorLevel({}, "win32") === 3);
check("locale: unset or UTF-8 → glyphs; C / POSIX / Latin-1 → no glyphs; LC_ALL wins over LANG",
  utf8Locale({}, mac) && utf8Locale({ LANG: "en_US.UTF-8" }, mac) && utf8Locale({ LC_CTYPE: "UTF-8" }, mac)
  && !utf8Locale({ LANG: "C" }, mac) && !utf8Locale({ LC_ALL: "POSIX", LANG: "en_US.UTF-8" }, mac) && !utf8Locale({ LANG: "de_DE.ISO8859-1" }, mac)
  && utf8Locale({ LANG: "C" }, "win32"));

check("the sprite needs a terminal and no --json", spriteAllowed(true, ["--version"]) && !spriteAllowed(false, ["--version"]) && !spriteAllowed(true, ["--version", "--json"]));
check("not a terminal (piped, redirected, --json): the bare version", versionText("1.2.3", false, {}, mac) === "1.2.3");
check("a terminal in a non-UTF-8 locale: the bare version (no mojibake)", versionText("1.2.3", true, { LANG: "C" }, mac) === "1.2.3");
const tty = versionText("1.2.3", true, { NO_COLOR: "1", LANG: "en_US.UTF-8" }, mac);
check("a terminal: Bo beside the name and version", tty.includes("Design Twin 1.2.3") && tty.split("\n").length === 6 && !tty.includes(ESC));

// The real CLI, piped (this suite's stdout is never a terminal for the child): exactly the version, with or without --json.
const pkgVersion = (JSON.parse(fs.readFileSync(path.join(ROOT, "bridge", "package.json"), "utf8")) as { version: string }).version;
const env = { ...process.env, FORCE_COLOR: "3", COLORTERM: "truecolor" };
const piped = dtwinSync(["--version"], { cwd: ROOT, timeoutMs: 15000, env });
const pipedJson = dtwinSync(["--version", "--json"], { cwd: ROOT, timeoutMs: 15000, env });
check("`dtwin --version` piped, even with FORCE_COLOR=3: just the version", piped.status === 0 && piped.stdout === `${pkgVersion}\n`);
check("`dtwin --version --json` piped: just the version", pipedJson.status === 0 && pipedJson.stdout === `${pkgVersion}\n`);

// ---------------------------------------------------------------- the brand files

const ASSETS = path.join(ROOT, "assets");
const need = ["README.md", "logo.svg", "logo-light.svg", "logo-dark.svg", "logo-16.svg", "wordmark-light.svg", "wordmark-dark.svg", "wordmark-light.png",
  "avatar.svg", "avatar-512.png", "bo.svg", "bo-states.svg", "social-preview.svg", "social-preview.png"];
check("assets/: every brand file is there", need.every((f) => fs.existsSync(path.join(ASSETS, f))));
const svgs = fs.readdirSync(ASSETS).filter((f) => f.endsWith(".svg"));
const read = (f: string): string => fs.readFileSync(path.join(ASSETS, f), "utf8");
check("assets/: every SVG is self-contained — no <text>, fonts, rasters, external refs or editor metadata",
  svgs.length >= 10 && svgs.every((f) => {
    const s = read(f);
    return s.startsWith("<svg") && !/<text|@font-face|<image|<metadata|<foreignObject|inkscape:|sodipodi:|NaN/.test(s) && !/href="(?!#)/.test(s);
  }));
check("assets/: every SVG has a viewBox, role=img and a <title>",
  svgs.every((f) => { const s = read(f); return /viewBox="/.test(s) && /role="img"/.test(s) && /<title>[^<]+<\/title>/.test(s); }));
const rootTag = (f: string): string => /<svg[^>]*>/.exec(read(f))?.[0] ?? "";
check("assets/: the scalable SVGs carry no fixed width/height (the page sizes them)",
  svgs.filter((f) => f !== "logo-16.svg" && f !== "social-preview.svg").every((f) => !/\s(width|height)="/.test(rootTag(f))));
check("assets/: every SVG is small (< 25 KB)", svgs.every((f) => fs.statSync(path.join(ASSETS, f)).size < 25_000));

const pngSize = (f: string): [number, number] => { const b = fs.readFileSync(path.join(ASSETS, f)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
const [sw, sh] = pngSize("social-preview.png");
check("social-preview.png: 1280×640 (GitHub's social preview size), under 1 MB",
  sw === 1280 && sh === 640 && fs.statSync(path.join(ASSETS, "social-preview.png")).size < 1_000_000);
const [aw, ah] = pngSize("avatar-512.png");
check("avatar-512.png: 512×512", aw === 512 && ah === 512);

const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
check("README header: a <picture> with the dark wordmark for dark themes and the light one, with alt text, as the fallback",
  /<source media="\(prefers-color-scheme: dark\)" srcset="assets\/wordmark-dark\.svg">/.test(readme) && /<img alt="Design Twin" src="assets\/wordmark-light\.svg"/.test(readme));
const npmReadme = fs.readFileSync(path.join(ROOT, "bridge", "README.md"), "utf8");
check("npm README (bridge/README.md): the logo by an absolute raw.githubusercontent URL to a committed PNG",
  /<img alt="Design Twin" src="https:\/\/raw\.githubusercontent\.com\/its-magdy\/design-twin\/main\/assets\/wordmark-light\.png"/.test(npmReadme));

const ui = fs.readFileSync(path.join(ROOT, "figma-plugin", "ui.template.html"), "utf8");
// the drawing inside the <svg>, without its <title> (the inline copy is decorative, aria-hidden)
const inner = (s: string): string => (/<svg[^>]*>([\s\S]*?)<\/svg>/.exec(s)?.[1] ?? "").replace(/<title>[^<]*<\/title>/, "").replace(/\s+/g, "");
check("plugin window: the same 16 px mark as assets/logo-16.svg, decorative (aria-hidden), beside #status",
  inner(read("logo-16.svg")) !== "" && ui.replace(/\s+/g, "").includes(inner(read("logo-16.svg")))
  && /<div id="head"><svg[^>]*aria-hidden="true"[\s\S]*?<\/svg><div id="status" role="status"/.test(ui));
const main = fs.readFileSync(path.join(ROOT, "figma-plugin", "src", "main.ts"), "utf8");
check("plugin window: still 360×380 (the mark sits in the status line instead of adding a row)", main.includes("width: 360, height: 380"));

report();
