// test/tokens-cli.test.ts — the tokens.js CLI's provenance line + --check and --lookup <#hex>.
// Fixture: invented catalogs (Acme Kit); every run is a real subprocess so the exit codes are the ones a user sees.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { check as ok, report } from "./assert.ts";

const SCRIPT = path.join(import.meta.dirname, "..", "design-to-code", "tokens.ts");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokens-cli-"));
const run = (cwd: string, ...args: string[]): { status: number | null; out: string; err: string } => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
const readOr = (f: string): string => { try { return fs.readFileSync(f, "utf8"); } catch (e) { return `<unreadable: ${e instanceof Error ? e.message : String(e)}>`; } };

type V = { name: string; type: "COLOR" | "FLOAT"; collection: string; tier: "primitive" | "semantic"; values: Record<string, string | number | { aliasOf: string }>; key: string };
const prim = (name: string, hex: string, key: string): V => ({ name, type: "COLOR", collection: "Primitives", tier: "primitive", values: { "Mode 1": hex }, key });
const catalog = (variables: V[], extra: Record<string, unknown> = {}): string => JSON.stringify({
  exportedAt: "2026-10-01T00:00:00.000Z",
  collections: [{ name: "Primitives", modes: ["Mode 1"], default: "Mode 1", theming: false }, { name: "Theme", modes: ["Light", "Dark"], default: "Light", theming: true }],
  variables, ...extra,
}, null, 2);
const BASE: V[] = [prim("Y/500", "#ffbc1c", "k1"), prim("Y/600", "#e0a000", "k2")];

// ---------- provenance line + --check ----------
console.log("tokens CLI — provenance line in every generated file, --check:");
{
  const dir = path.join(tmp, "a"); fs.mkdirSync(dir);
  const vars = path.join(dir, "variables.json");
  fs.writeFileSync(vars, catalog(BASE));
  const g = run(dir, vars, "out", "--web", "tailwind", "--also-generic");
  const theme = readOr(path.join(dir, "out", "theme.css")), css = readOr(path.join(dir, "out", "tokens.css"));
  const LINE = /^\/\* designtwin-source: [^/ ]+\/variables\.json · 2 variables · sha256 [0-9a-f]{12} \*\/\n/;
  ok("theme.css starts with the source line (input, count, 12-hex hash)", g.status === 0 && LINE.test(theme) && /@import "tailwindcss"/.test(theme));
  ok("tokens.css starts with the same line", LINE.test(css) && css.includes(":root {"));
  const lineOf = (t: string): string => (LINE.exec(t) ?? [""])[0];
  ok("both files carry the SAME line", lineOf(theme) !== "" && lineOf(theme) === lineOf(css));
  const nat = run(dir, vars, "outn", "--native", "swiftui");
  const swiftFile = fs.existsSync(path.join(dir, "outn")) ? fs.readdirSync(path.join(dir, "outn")).find((f) => f.endsWith(".swift")) : undefined;
  const swiftText = swiftFile ? readOr(path.join(dir, "outn", swiftFile)) : "<no .swift file written>";
  ok("a native file starts with a // source line", nat.status === 0 && /^\/\/ designtwin-source: [^/ ]+\/variables\.json · 2 variables · sha256 [0-9a-f]{12}\n/.test(swiftText));

  const theme1 = path.join(dir, "out", "theme.css");
  const fresh = run(dir, vars, "--check", theme1);
  ok("--check on a fresh theme.css exits 0 and writes nothing", fresh.status === 0 && /current/.test(fresh.out) && readOr(theme1) === theme);

  // a pull merges a third variable into variables.json
  fs.writeFileSync(vars, catalog([...BASE, prim("Y/700", "#a07000", "k3")]));
  const stale = run(dir, vars, "--check", theme1);
  ok("after a variable is added --check exits 1 and names 2 -> 3", stale.status === 1 && /2 variables/.test(stale.err) && /now has 3/.test(stale.err) && /re-run/.test(stale.err));
  ok("the stale message prints a real command (this script's path), not a placeholder",
    stale.err.includes(SCRIPT) || stale.err.includes(path.basename(SCRIPT)));

  // same content, reordered + new exportedAt + a hygiene/_slices note -> still current
  fs.writeFileSync(vars, JSON.stringify({
    exportedAt: "2027-01-01T00:00:00.000Z", hygiene: ["something new"], _slices: [{ screen: "S", at: "2027-01-01", variables: 2, collections: 2 }],
    variables: [{ ...BASE[1], values: { "Mode 1": "#e0a000" } }, BASE[0]],
    collections: [{ theming: true, default: "Light", modes: ["Light", "Dark"], name: "Theme" }, { default: "Mode 1", name: "Primitives", theming: false, modes: ["Mode 1"] }],
  }));
  const same = run(dir, vars, "--check", theme1);
  ok("reordered variables / collections, a new exportedAt and _slices keep the hash: --check exits 0", same.status === 0);
  // a changed VALUE changes it, count unchanged
  fs.writeFileSync(vars, catalog([prim("Y/500", "#ffbc1d", "k1"), BASE[1] as V]));
  const val = run(dir, vars, "--check", theme1);
  ok("one changed value (same count) is stale", val.status === 1 && /2 variables/.test(val.err));

  const bare = path.join(dir, "bare.css");
  fs.writeFileSync(bare, '@import "tailwindcss";\n@theme {\n  --color-figma-y-500: #ffbc1c;\n}\n');
  const none = run(dir, vars, "--check", bare);
  ok("a theme.css without the line: exit 2, 'regenerate once'", none.status === 2 && /regenerate once/.test(none.err));
  const missing = run(dir, vars, "--check", path.join(dir, "nope.css"));
  ok("a missing generated file: exit 2, a sentence not a stack", missing.status === 2 && /could not be read/.test(missing.err) && !/at .*\.ts:\d+/.test(missing.err));
  ok("--check is a registered flag (usage lists it)", /--check/.test(run(dir, "--help").out));
}
{
  // a theme generated from the library tokens.json, checked against the narrower per-screen
  // variables.json, is not "stale" — --check names the recorded source and never says to regenerate from this one.
  const dir = path.join(tmp, "l6"); fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  const lib = path.join(dir, "lib", "tokens.json"), vars = path.join(dir, "variables.json");
  fs.writeFileSync(lib, catalog([...BASE, prim("Y/700", "#a07000", "k3")]));
  fs.writeFileSync(vars, catalog(BASE));
  const g = run(dir, lib, "out", "--web", "tailwind");
  const theme = path.join(dir, "out", "theme.css");
  const other = run(dir, vars, "--check", theme);
  ok(`--check against a different source names the recorded one and exits 2, not "stale" (got ${other.status}: ${other.err.trim()})`,
    g.status === 0 && other.status === 2 && /generated from lib\/tokens\.json, not l6\/variables\.json/.test(other.err) && !/^stale/m.test(other.err) && !/re-run/.test(other.err));
  const right = run(dir, lib, "--check", theme);
  ok("control: the recorded source itself is current", right.status === 0);
  fs.copyFileSync(lib, path.join(dir, "copy.json"));
  ok("control: another name with the SAME content is still current (the hash decides first)", run(dir, path.join(dir, "copy.json"), "--check", theme).status === 0);
}

{
  // two files named tokens.json (the design-system's and a library's) are told apart by the recorded
  // parent directory, so a library theme checked against the design-system one is "other source", never "stale".
  const dir = path.join(tmp, "l2"); fs.mkdirSync(path.join(dir, "design-system"), { recursive: true }); fs.mkdirSync(path.join(dir, "libraries", "acme-kit"), { recursive: true });
  const ds = path.join(dir, "design-system", "tokens.json"), lib = path.join(dir, "libraries", "acme-kit", "tokens.json");
  fs.writeFileSync(lib, catalog([...BASE, prim("Y/700", "#a07000", "k3")]));
  fs.writeFileSync(ds, catalog([prim("Local/1", "#123456", "l1")]));
  const g = run(dir, lib, "out", "--web", "tailwind");
  const theme = path.join(dir, "out", "theme.css");
  ok("the provenance line records <parent dir>/<basename>", g.status === 0 && /^\/\* designtwin-source: acme-kit\/tokens\.json · 3 variables/.test(readOr(theme)));
  const other = run(dir, ds, "--check", theme);
  ok(`a library theme checked against the design-system tokens.json: exit 2 "other source", not "stale" (got ${other.status}: ${other.err.trim()})`,
    other.status === 2 && /^other source/m.test(other.err) && /acme-kit\/tokens\.json, not design-system\/tokens\.json/.test(other.err) && !/^stale/m.test(other.err) && !/re-run/.test(other.err));
  ok("control: the library's own tokens.json is current (also by a relative path)", run(dir, lib, "--check", theme).status === 0 && run(path.dirname(lib), "tokens.json", "--check", theme).status === 0);
  fs.writeFileSync(lib, catalog([...BASE, prim("Y/700", "#a07000", "k3"), prim("Y/800", "#805000", "k4")]));
  const stale = run(dir, lib, "--check", theme);
  ok("control: the same file after a change is still stale (exit 1)", stale.status === 1 && /^stale/m.test(stale.err));
  // A line written before the parent dir was recorded (basename only) keeps the basename rule.
  fs.writeFileSync(theme, readOr(theme).replace("acme-kit/tokens.json", "tokens.json"));
  ok("a basename-only line from an earlier run: same basename is compared as before (stale, exit 1)", run(dir, lib, "--check", theme).status === 1);
  ok("…and a different basename is still 'other source' (exit 2)", run(dir, path.join(dir, "variables.json"), "--check", theme).status === 2);
}
{
  // exit 1 is "stale" (--check) / "no match" (--lookup); a usage error in those runs is 2.
  const dir = path.join(tmp, "l1"); fs.mkdirSync(dir);
  const lib = path.join(dir, "tokens.json");
  fs.writeFileSync(lib, catalog(BASE));
  const noValue = run(dir, lib, "--check");
  ok(`--check with no value exits 2 (got ${noValue.status})`, noValue.status === 2 && /usage/.test(noValue.err));
  const unknown = run(dir, lib, "--check", "x.css", "--bogus");
  ok(`an unknown flag next to --check exits 2 (got ${unknown.status})`, unknown.status === 2);
  const both = run(dir, lib, "--check", "x.css", "--lookup", "ffbc1c");
  ok(`--check + --lookup ("separate runs") exits 2 (got ${both.status})`, both.status === 2 && /separate runs/.test(both.err));
  const lookNoValue = run(dir, lib, "--lookup");
  ok(`--lookup with no value exits 2 (got ${lookNoValue.status})`, lookNoValue.status === 2);
  const noInput = run(dir, "--check", "x.css");
  ok(`--check with no catalog exits 2 (got ${noInput.status})`, noInput.status === 2);
  ok("generation mode keeps exit 1 for a usage error", run(dir, lib, "out", "--bogus").status === 1 && run(dir, lib, "out", "--native", "nope").status === 1);
  ok("control: --lookup with no match is still exit 1", run(dir, lib, "--lookup", "#123456").status === 1);
}

// ---------- --lookup ----------
console.log("\ntokens CLI — --lookup <#hex>:");
{
  const dir = path.join(tmp, "b"); fs.mkdirSync(dir);
  const lib = path.join(dir, "tokens.json");
  const warning: V = {
    name: "Warning/Warning", type: "COLOR", collection: "Theme", tier: "semantic", key: "k9",
    values: { Light: { aliasOf: "Y/600" }, Dark: { aliasOf: "Y/500" } },
  };
  const info: V = { name: "Info/Info", type: "COLOR", collection: "Theme", tier: "semantic", key: "k8", values: { Light: { aliasOf: "Y/600" }, Dark: "#18a1ff" } };
  const chain: V = { name: "Alert/Banner", type: "COLOR", collection: "Theme", tier: "semantic", key: "k7", values: { Light: { aliasOf: "Warning/Warning" }, Dark: { aliasOf: "Warning/Warning" } } };
  const spacing: V = { name: "Space/4", type: "FLOAT", collection: "Primitives", tier: "primitive", key: "k6", values: { "Mode 1": 16 } };
  const translucent = prim("Y/500 half", "#ffbc1c80", "k5");
  fs.writeFileSync(lib, catalog([...BASE, warning, info, chain, spacing, translucent]));
  const r = run(dir, lib, "--lookup", "#FFBC1C");
  const lines = r.out.split("\n").filter(Boolean);
  ok("exit 0 on a hit; the primitive is listed as direct", r.status === 0 && lines.some((l) => /^Y\/500  \[Primitives \/ Mode 1\]  #ffbc1c  \(direct\)$/.test(l)));
  ok("the semantic token is listed for Dark, via the primitive it aliases", lines.some((l) => /^Warning\/Warning  \[Theme \/ Dark\]  #ffbc1c  \(via Y\/500\)$/.test(l)));
  ok("... and NOT for Light (that mode aliases Y/600)", !lines.some((l) => /Warning\/Warning  \[Theme \/ Light\]/.test(l)));
  ok("an alias of an alias lists the whole chain", lines.some((l) => /^Alert\/Banner  \[Theme \/ Dark\]  #ffbc1c  \(via Warning\/Warning -> Y\/500\)$/.test(l)));
  ok("a 6-digit query ignores alpha: the 50% variant is a hit, printed with its alpha", lines.some((l) => /^Y\/500 half .* #ffbc1c80 /.test(l)));
  const r8 = run(dir, lib, "--lookup", "#ffbc1cff");
  ok("an 8-digit query is exact on alpha: opaque hits stay, the 50% one drops", r8.status === 0 && /^Y\/500 /m.test(r8.out) && !/half/.test(r8.out));
  const r3 = run(dir, lib, "--lookup", "#fb1");
  ok("#rgb shorthand is expanded (#ffbb11 matches nothing here -> exit 1)", r3.status === 1);
  const miss = run(dir, lib, "--lookup", "#123456");
  ok("no hit: exit 1, a sentence naming the library catalog", miss.status === 1 && miss.out === "" && /no variable in .* resolves to #123456 in any mode/.test(miss.err) && /libraries/.test(miss.err));
  const two = run(dir, lib, "--lookup", "#18a1ff", "--lookup", "#123456");
  ok("repeatable: hits for one, exit 1 when another misses", two.status === 1 && /^Info\/Info  \[Theme \/ Dark\]  #18a1ff  \(direct\)$/m.test(two.out));
  ok("FLOAT variables are never listed", !/Space\/4/.test(r.out));
  const bad = run(dir, lib, "--lookup", "banana");
  ok("a non-hex query is an error (exit 2), not a miss", bad.status === 2 && /not a hex colour/.test(bad.err));
  ok("--lookup writes nothing", fs.readdirSync(dir).join() === "tokens.json");
  ok("--lookup is a registered flag (usage lists it)", /--lookup/.test(run(dir, "--help").out));
}

// ---------- an all-remote catalog is a consuming file's pull, not the library's ----------
console.log("\ntokens CLI — all-remote catalog warns:");
{
  const dir = path.join(tmp, "d8"); fs.mkdirSync(dir);
  const remote = (v: V): V & { remote: true } => ({ ...v, remote: true });
  const allRemote = path.join(dir, "all.json"), mixed = path.join(dir, "mixed.json"), local = path.join(dir, "local.json");
  fs.writeFileSync(allRemote, catalog(BASE.map(remote)));
  fs.writeFileSync(mixed, catalog([remote(BASE[0] as V), BASE[1] as V]));
  fs.writeFileSync(local, catalog(BASE));
  const a = run(dir, allRemote, "outa");
  const warns = a.err.split("\n").filter((l) => /^warn /.test(l) && /--as-library/.test(l));
  ok(`every variable remote:true -> exactly one stderr warn naming --as-library (got ${warns.length}; exit ${a.status})`,
    a.status === 0 && warns.length === 1 && /all 2 variable\(s\)/.test(warns[0] ?? "") && /CONSUMES a library/.test(warns[0] ?? ""));
  ok("the files are still written (a warning, not a refusal)", fs.existsSync(path.join(dir, "outa", "tokens.css")));
  ok("a MIXED local/remote catalog prints no such warn", !/--as-library/.test(run(dir, mixed, "outm").err));
  ok("a catalog with no remote variable prints none", !/--as-library/.test(run(dir, local, "outl").err));
  ok("--lookup / --check stay silent (they write nothing)", !/--as-library/.test(run(dir, allRemote, "--lookup", "#ffbc1c").err));
  const slice = path.join(dir, "Home__1_2.vars.json");
  fs.writeFileSync(slice, catalog(BASE.map(remote)));
  ok("a screen's own all-remote .vars.json (the documented theme input on a consuming file) prints no such warn", !/--as-library/.test(run(dir, slice, "outs").err));
}

// ---------- :root takes each collection's DEFAULT mode — warn when those disagree ----------
console.log("\ntokens CLI — :root mixes modes:");
{
  const dir = path.join(tmp, "f126"); fs.mkdirSync(dir);
  type C = { name: string; modes: string[]; default?: string };
  const doc = (collections: C[], type: "COLOR" | "FLOAT" = "COLOR"): string => JSON.stringify({
    collections: collections.map((c) => ({ ...c, theming: true })),
    variables: collections.map((c, i) => ({ name: `${c.name}/Surface`, type, collection: c.name, tier: "semantic", key: `m${i}`,
      values: Object.fromEntries(c.modes.map((m, j) => [m, type === "COLOR" ? (j ? "#ffffff" : "#121319") : 8 * (j + 1)])) })),
  });
  const warnOf = (name: string, collections: C[], type?: "COLOR" | "FLOAT"): string[] => {
    const f = path.join(dir, name + ".json");
    fs.writeFileSync(f, doc(collections, type));
    const r = run(dir, f, "out-" + name, "--web", "tailwind");
    return r.status === 0 ? r.err.split("\n").filter((l) => /^warn {2}:root mixes modes/.test(l)) : [`<exit ${r.status}: ${r.err}>`];
  };
  const mixed = warnOf("mixed", [{ name: "Theme", modes: ["Dark", "Light"], default: "Dark" }, { name: "Kit", modes: ["Light", "Dark"], default: "Light" }]);
  ok(`two COLOR collections sharing Dark/Light with different defaults -> one ':root mixes modes' warn naming both defaults (got ${mixed.length})`,
    mixed.length === 1 && /'Theme' defaults to 'Dark'; 'Kit' to 'Light'|'Kit' defaults to 'Light'; 'Theme' to 'Dark'/.test(mixed[0] ?? ""));
  ok("the same two collections with the same default -> silent",
    warnOf("same", [{ name: "Theme", modes: ["Dark", "Light"], default: "Dark" }, { name: "Kit", modes: ["Dark", "Light"], default: "Dark" }]).length === 0);
  ok("the default is the export's `default`, not modes[0]: [Dark, Light] and [Light, Dark] both defaulting to Dark -> silent",
    warnOf("order", [{ name: "Theme", modes: ["Dark", "Light"], default: "Dark" }, { name: "Kit", modes: ["Light", "Dark"], default: "Dark" }]).length === 0);
  const assumed = warnOf("nodefault", [{ name: "Theme", modes: ["Dark", "Light"], default: "Dark" }, { name: "Kit", modes: ["Light", "Dark"] }]);
  ok("no `default` in the export -> the first mode, and the warn says it was assumed",
    assumed.length === 1 && /'Kit' \(the export names no default mode — its first mode assumed\)/.test(assumed[0] ?? ""));
  ok("FLOAT-only collections (breakpoints, not a theme) -> silent",
    warnOf("float", [{ name: "Spacing", modes: ["Desktop", "Mobile"], default: "Desktop" }, { name: "Sizes", modes: ["Mobile", "Desktop"], default: "Mobile" }], "FLOAT").length === 0);
  ok("no shared mode name (Dark/Light vs Brand 1/Brand 2) -> silent",
    warnOf("vocab", [{ name: "Theme", modes: ["Dark", "Light"], default: "Dark" }, { name: "Brand", modes: ["Brand 1", "Brand 2"], default: "Brand 1" }]).length === 0);
}

fs.rmSync(tmp, { recursive: true, force: true });
report();
