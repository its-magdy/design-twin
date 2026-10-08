// Group 15 (D7, DT-08): the generated scripting quick keys, `design/export/SCHEMA.md`, that write-out.ts
// writes next to the data on every pull that writes to disk (writeScreen + writeExport), and the pull-time
// DT-08 line (a design-system export of a file that consumes a library says it is not the catalog).
// Run with:  node test/quick-keys.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, report } from "./assert.ts";
import { manifest, screenReply, variable } from "./fixtures.ts";
import * as writeOut from "../bridge/src/write-out.ts";
import { buildPageLayout } from "../bridge/src/pages-layout.ts";
import { QUICK_KEYS, SCHEMA_DOC_NAME, SCHEMA_MARKER } from "../bridge/src/quick-keys.ts";
import type { DesignSystemDoc, Variable } from "../bridge/src/doc-types.ts";

const tmp = (tag: string): string => fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-qk-" + tag + "-"));
const t = (name: string, cond: () => boolean): void => {
  let v = false;
  try { v = cond(); } catch (e) { console.log("    threw: " + String(e instanceof Error ? e.message : e)); }
  check(name, v);
};
const read = (f: string): string | null => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const mtime = (f: string): number => { try { return fs.statSync(f).mtimeMs; } catch { return -1; } };

const reply = (name = "Home") => screenReply({
  screenName: name, nodeId: "1:2", page: "Page", pageId: "0:1",
  screen: { screen: name, exportedAt: "2026-10-07T00:00:00.000Z", nodes: [{ id: "1:2", type: "FRAME", box: { x: 0, y: 0, w: 10, h: 10 } }] },
});
const pull = (dir: string): string[] => {
  const log: string[] = [];
  writeOut.writeScreen(dir, reply(), (m) => log.push(m));
  return log;
};
const ds = (variables: Variable[], extra: Partial<DesignSystemDoc> = {}): DesignSystemDoc => ({
  exportedAt: "2026-10-07T00:00:00.000Z", file: "Sample App", colorProfile: "srgb",
  collections: [], variables, styles: { paint: [], text: [], effect: [], grid: [] }, components: [], hygiene: [], ...extra,
});
const v = (name: string, remote?: true): Variable => variable({ name, type: "COLOR", collection: "Colors", values: { Light: "#ffffff" }, ...(remote ? { remote } : {}) });

console.log("\nquick keys — SCHEMA.md (QK-4):");
{
  const dir = tmp("screen");
  const file = path.join(dir, SCHEMA_DOC_NAME);
  const log1 = pull(dir);
  const text = read(file) ?? "";
  t("[QK-4] a --node pull writes SCHEMA.md: the marker first, the generated note, then QUICK_KEYS verbatim", () =>
    text.startsWith(SCHEMA_MARKER + "\n") && text.endsWith("\n\n" + QUICK_KEYS) && text.split("\n")[1]?.startsWith("<!--") === true);
  t("[QK-4] the note names ir-fields.md by name and carries no filesystem path", () => {
    const note = text.split("\n")[1] ?? "";
    return /ir-fields\.md/.test(note) && /rewritten only when its text changes/.test(note) && !note.includes(dir) && !/\/Users\/|[A-Za-z]:\\/.test(note);
  });
  t("[QK-4] a first write logs nothing about SCHEMA.md", () => !log1.some((m) => /SCHEMA\.md/.test(m)));

  // identical bytes → untouched. Age the file first so an (unwanted) rewrite shows as a new mtime.
  const old = new Date(Date.now() - 3600_000);
  try { fs.utimesSync(file, old, old); } catch { /* absent: the checks below fail */ }
  const m0 = mtime(file);
  const log2 = pull(dir);
  t("[QK-4] a second pull leaves SCHEMA.md alone (mtime unchanged) and says nothing", () => mtime(file) === m0 && !log2.some((m) => /SCHEMA\.md/.test(m)));
  t("[QK-4] …and no temp file is left beside it", () => !fs.readdirSync(dir).some((f) => f.includes(".tmp-")));

  // marked + stale → rewritten, with an info line.
  fs.writeFileSync(file, SCHEMA_MARKER + "\nold generated text\n");
  const log3 = pull(dir);
  t("[QK-4] a marked SCHEMA.md with different text is rewritten", () => read(file) === text);
  t("[QK-4] …with the info line `updated SCHEMA.md (scripting quick keys)`", () => log3.some((m) => m === "info  updated SCHEMA.md (scripting quick keys)"));

  // no marker → the user's file, never touched, one warn.
  const mine = "# My own schema notes\n";
  fs.writeFileSync(file, mine);
  const log4 = pull(dir);
  t("[QK-4] a SCHEMA.md without the marker is never touched", () => read(file) === mine);
  t("[QK-4] …and is warned about exactly once", () => log4.filter((m) => /^warn  SCHEMA\.md is not dtwin's/.test(m)).length === 1);
  t("[QK-4] …while the pull itself still succeeded", () => fs.existsSync(path.join(dir, "pages", "Page", "Home__1_2.json")));
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // A SCHEMA.md that cannot be written is a warning, not a failed pull.
  const dir = tmp("dir");
  fs.mkdirSync(path.join(dir, SCHEMA_DOC_NAME));
  let log: string[] = [];
  let threw = false;
  try { log = pull(dir); } catch { threw = true; }
  t("[QK-4] an unwritable SCHEMA.md (a directory) warns and the pull still lands", () => !threw && log.some((m) => /^warn  could not write SCHEMA\.md/.test(m)) && fs.existsSync(path.join(dir, "pages", "Page", "Home__1_2.json")));
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // writeExport (design-system-only, CLI --design-system and MCP writeToDisk) writes it; a library export too;
  // writeScreenshot does not.
  const dir = tmp("export");
  writeOut.writeExport(dir, { designSystem: ds([v("color/bg")]) }, () => {});
  t("[QK-4] a design-system export writes SCHEMA.md", () => read(path.join(dir, SCHEMA_DOC_NAME)) !== null && (read(path.join(dir, SCHEMA_DOC_NAME)) ?? "").endsWith(QUICK_KEYS));
  const lib = tmp("lib");
  writeOut.writeExport(lib, { designSystem: ds([v("color/bg")], { source: { role: "library", libraryName: "Acme Kit", fileKey: "abcd1234efgh" } }) }, () => {});
  t("[QK-4] a library export (--as-library) writes it too", () => read(path.join(lib, SCHEMA_DOC_NAME)) !== null);
  const shot = tmp("shot");
  writeOut.writeScreenshot(shot, { id: "9:1", name: "Screen A", type: "FRAME", reference: "assets/9_1_ref.png", manifest: manifest({ nodes: 1 }), assets: [] });
  t("[QK-4] a screenshot does not write SCHEMA.md", () => !fs.existsSync(path.join(shot, SCHEMA_DOC_NAME)));
  for (const d of [dir, lib, shot]) fs.rmSync(d, { recursive: true, force: true });
}

console.log("\nquick keys — index rows per layout (M2):");
{
  // The text promises some index fields on every row and others only on a single-screen row; pin both halves to
  // what the writers really emit: writeScreen's row (a --node / selection pull) and buildPageLayout's row (a page walk).
  const dir = tmp("rows");
  writeOut.writeScreen(dir, screenReply({
    screenName: "Home", nodeId: "1:2", page: "Page", pageId: "0:1",
    screen: { screen: "Home", exportedAt: "2026-10-07T00:00:00.000Z", nodes: [{ id: "1:2", type: "FRAME", box: { x: 0, y: 0, w: 375, h: 800 },
      reference: "assets/1_2_ref.png", children: [{ id: "1:3", name: "T", type: "TEXT", text: "Welcome" }] }] },
  }), () => {});
  const rootRows = (f: string): unknown[] => {
    try {
      const d: unknown = JSON.parse(fs.readFileSync(f, "utf8"));
      const layers = d && typeof d === "object" && "layers" in d ? d.layers : null;
      return Array.isArray(layers) ? layers : [];
    } catch { return []; }
  };
  const single: unknown = rootRows(path.join(dir, "pages", "index.json"))[0];
  fs.rmSync(dir, { recursive: true, force: true });
  const tree = { id: "1:2", name: "Home", type: "FRAME", box: { x: 0, y: 0, w: 375, h: 800 }, children: [{ id: "1:3", name: "T", type: "TEXT", text: "Welcome" }] };
  const walk = buildPageLayout({ layers: [{ name: "Home", id: "1:2", page: "Page", pageId: "0:1", tree, reference: "assets/1_2_ref.png" }],
    index: [{ name: "Home", id: "1:2", type: "FRAME", page: "Page", pageId: "0:1", nodes: 2, bytes: 100 }] }, "/");
  const walkRow: unknown = walk.meta.layers?.[0];
  const layerFile = walk.layerFiles[0]?.data;
  const has = (r: unknown, k: string): boolean => !!r && typeof r === "object" && Object.entries(r).some(([key, val]) => key === k && val !== undefined);
  t("[QK-5] every row has file/texts, and title when the frame shows text (single-screen and page-walk)", () => ["file", "title", "texts"].every((k) => has(single, k) && has(walkRow, k)));
  t("[QK-5] a single-screen row has reference + w/h; a page-walk row has none of them but nodes/bytes, its reference in the layer file", () =>
    ["reference", "w", "h"].every((k) => has(single, k)) && ["reference", "w", "h", "variables", "assets"].every((k) => !has(walkRow, k)) &&
    has(walkRow, "nodes") && has(walkRow, "bytes") && layerFile?.reference === "assets/1_2_ref.png");
  const qk = QUICK_KEYS.replace(/\s+/g, " ");
  t("[QK-5] QUICK_KEYS says so: file/texts (+ title) on every row, w/h + variables/assets/reference on a --node/selection row only", () =>
    /`file` and `texts` on every row \(`title` when the frame shows text\); a `--node`\/selection row also has `w`\/`h` and, when written, `variables`, `assets`, `reference`/.test(qk) &&
    /a page-walk row has `nodes`\/`bytes`; its `reference` is in the layer file/.test(qk) &&
    /A single-screen index row repeats the size as `w`\/`h`/.test(qk) && /`<Screen>\.assets\.json` \(single-screen pulls\)/.test(qk) &&
    !/lists every screen \(`file`, `variables`/.test(qk) && !/Index rows call the same size/.test(qk));
}

// [QK-7] frame-relative x/y is `box.x − <root>.box.x`: the root is nodes[0] in a screen file, `tree` in a page-walk layer file.
t("[QK-7] QUICK_KEYS: frame-relative = box.x − <root>.box.x, root = nodes[0] (screen file) or tree (page-walk layer file); never bare nodes[0].box.x", () => {
  const qk = QUICK_KEYS.replace(/\s+/g, " ");
  return /frame-relative = `box\.x − <root>\.box\.x` \(root = `nodes\[0\]` in a screen file, `tree` in a page-walk layer file\)/.test(qk) && !/box\.x − nodes\[0\]\.box\.x/.test(qk);
});

console.log("\nquick keys — DT-08 pull-time line:");
{
  const logOf = (doc: DesignSystemDoc): string[] => {
    const dir = tmp("dt08");
    const log: string[] = [];
    writeOut.writeExport(dir, { designSystem: doc }, (m) => log.push(m));
    fs.rmSync(dir, { recursive: true, force: true });
    return log;
  };
  const mixed = logOf(ds([v("color/own"), v("color/lib-a", true), v("color/lib-b", true)]));
  const line = mixed.find((m) => /come from a library this file consumes/.test(m)) ?? "";
  t("[DT08-1] remote variables → ONE info line `N of M variables come from a library this file consumes`", () =>
    mixed.filter((m) => /come from a library this file consumes/.test(m)).length === 1 && /^info  2 of 3 variables come from a library/.test(line));
  t("[DT08-1] …saying it is not that library's catalog and naming `dtwin pull --as-library`", () => /not that library's catalog/.test(line) && /dtwin pull --as-library "<name>"/.test(line));
  t("[DT08-1] no remote variable → no such line", () => !logOf(ds([v("color/own")])).some((m) => /library this file consumes/.test(m)));
  t("[DT08-1] a library export (its variables are its own) → no such line", () =>
    !logOf(ds([v("color/lib", true)], { source: { role: "library", libraryName: "Acme Kit", fileKey: "abcd1234efgh" } })).some((m) => /library this file consumes/.test(m)));
}

report();
