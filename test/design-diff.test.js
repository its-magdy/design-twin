// Offline tests for design-to-code/design-diff.js (the sync-design skill's change list).
//   node test/design-diff.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { diffScreens, diffTokens, diffCatalog, diffStyles, diffHygiene, diffDocs, markdown, snapshotPath } = require("../design-to-code/design-diff");
const { check, report } = require("./assert");

const CLI = require.resolve("../design-to-code/design-diff.js");
const clone = (o) => JSON.parse(JSON.stringify(o));
const screen = () => ({ exportedAt: "2026-01-01", manifest: { nodes: 5 }, tree: { id: "1:1", name: "Login", type: "FRAME", box: { w: 390, h: 844, x: 0, y: 0 }, layout: { display: "flex", gap: 16 }, children: [
  { id: "1:2", name: "Title", type: "TEXT", text: "Welcome", font: { size: 24 }, widthMode: "hug", heightMode: "hug", box: { w: 120, h: 32, x: 24, y: 80 } },
  { id: "1:3", name: "Card", type: "FRAME", box: { w: 342, h: 200, x: 24, y: 128 }, fills: [{ type: "solid", color: "#ffffff" }], children: [
    { id: "1:4", name: "Label", type: "TEXT", text: "Email", widthMode: "hug", heightMode: "hug", box: { w: 40, h: 16, x: 40, y: 144 } }] },
  { id: "1:5", name: "Button", type: "INSTANCE", props: { Variant: "primary" }, box: { w: 342, h: 48, x: 24, y: 344 } },
] } });

console.log("screen diff:");
check("identical exports → nothing, even with a new exportedAt/manifest", (() => { const b = screen(); b.exportedAt = "2026-09-21"; b.manifest.nodes = 9; const s = diffScreens(screen(), b).summary; return s.added + s.removed + s.changed + s.reordered + s.positionOnly === 0; })());
check("a text edit is ONE change, categorised, with before → after", (() => {
  const b = screen(); b.tree.children[0].text = "Welcome back";
  const d = diffScreens(screen(), b);
  return d.changed.length === 1 && d.changed[0].id === "1:2" && d.changed[0].categories[0] === "text" && d.changed[0].fields[0].before === "Welcome" && d.changed[0].fields[0].after === "Welcome back" && d.changed[0].path === "Login > Title";
})());
check("inserting a row reports the row, NOT every node that moved down because of it", (() => {
  const b = screen();
  b.tree.children.splice(1, 0, { id: "9:9", name: "Banner", type: "FRAME", box: { w: 342, h: 40, x: 24, y: 128 }, children: [{ id: "9:10", name: "Banner text", type: "TEXT", text: "New", box: { w: 30, h: 16, x: 30, y: 140 } }] });
  for (const n of [b.tree.children[2], b.tree.children[2].children[0], b.tree.children[3]]) n.box.y += 56;
  const d = diffScreens(screen(), b);
  return d.added.length === 1 && d.added[0].id === "9:9" && d.changed.length === 0 && d.summary.positionOnly === 3 && d.reordered.length === 0;
})());
check("removing a subtree reports its top-most node only", (() => { const b = screen(); b.tree.children.splice(1, 1); const d = diffScreens(screen(), b); return d.removed.length === 1 && d.removed[0].id === "1:3"; })());
check("a rename is a change on the same id, not delete + add", (() => { const b = screen(); b.tree.children[2].name = "Submit"; const d = diffScreens(screen(), b); return d.added.length === 0 && d.removed.length === 0 && d.changed[0].fields[0].field === "name"; })());
check("size counts on a FIXED node, not on a hug node (whose size only echoes its text)", (() => {
  const b = screen(); b.tree.children[2].box.h = 56; b.tree.children[0].box.w = 180;
  const d = diffScreens(screen(), b);
  return d.changed.length === 1 && d.changed[0].id === "1:5" && d.changed[0].fields[0].field === "size" && d.changed[0].fields[0].after === "342×56";
})());
check("reordered children and a variant swap are both caught", (() => {
  const b = screen(); b.tree.children.reverse(); b.tree.children[0].props.Variant = "secondary";
  const d = diffScreens(screen(), b);
  return d.reordered.length === 1 && d.reordered[0].after[0] === "Button" && d.changed.some((c) => c.id === "1:5" && c.categories.includes("component"));
})());
check("a {nodes:[…]} multi-root document is walked too", diffScreens({ nodes: [screen().tree] }, { nodes: [Object.assign(screen().tree, { opacity: 0.5 })] }).changed[0].fields[0].field === "opacity");
check("markdown: says so when nothing changed; lists fields when something did", /Nothing changed/.test(markdown(diffScreens(screen(), screen()), "x")) && (() => { const b = screen(); b.tree.children[0].text = "Hi"; return /`text`: Welcome → Hi/.test(markdown(diffScreens(screen(), b), "x")); })());

console.log("token diff:");
const tok = () => ({ variables: [{ name: "color/primary", collection: "Theme", values: { Light: "#111111", Dark: { aliasOf: "blue/200" } } }, { name: "space/md", collection: "Space", values: { M: 16 } }] });
check("a value change names the token and the MODE that changed", (() => {
  const b = tok(); b.variables[0].values.Dark = { aliasOf: "blue/300" }; b.variables.push({ name: "space/lg", values: { M: 24 } }); b.variables.splice(1, 1);
  const d = diffTokens(tok(), b);
  return d.changed.length === 1 && d.changed[0].name === "color/primary" && d.changed[0].modes.length === 1 && d.changed[0].modes[0].mode === "Dark" && d.added[0] === "space/lg" && d.removed[0] === "space/md";
})());

console.log("CLI — snapshot, then diff after an in-place re-pull:");
check("snapshot → overwrite → diff finds the change; no snapshot and no git → exit 2 with the remedy", (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-diff-"));
  const rel = path.join("design", "pages", "home", "login.json");
  fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), JSON.stringify(screen()));
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: root, encoding: "utf8" });
  const none = run(rel);
  const snap = run("--snapshot", rel);
  const b = screen(); b.tree.children[0].text = "Welcome back";
  fs.writeFileSync(path.join(root, rel), JSON.stringify(b));
  const d = run(rel, "--json");
  return none.status === 2 && /--snapshot/.test(none.stderr) && snap.status === 0 && fs.existsSync(path.join(root, "design", ".sync", "pages__home__login.json"))
    && snapshotPath(rel, root).endsWith("pages__home__login.json") && d.status === 0 && JSON.parse(d.stdout).summary.changed === 1;
})());

// Finding 205: `--snapshot` used to be an unconditional fs.copyFileSync — running step 2 of the
// sync-design skill twice (once before each of two later re-pulls) silently replaced the FIRST
// baseline with whatever was on disk by the second call, which by then could already be a post-re-pull
// export. Non-destructive by default; --force is required to replace a baseline that would actually change.
console.log("CLI — --snapshot is non-destructive (finding 205):");
check("a second --snapshot of DIFFERENT content is refused without --force, and the first baseline survives", (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-diff-force-"));
  const rel = path.join("design", "export", "design-system", "tokens.json");
  fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: root, encoding: "utf8" });
  fs.writeFileSync(path.join(root, rel), JSON.stringify({ variables: [{ name: "a", values: { M: 1 } }] }));
  const first = run("--snapshot", rel);
  const snapFile = snapshotPath(rel, root);
  const firstBytes = fs.readFileSync(snapFile, "utf8");
  // Simulate a re-pull that changed the export, then a MISTAKEN second `--snapshot` call (should have
  // been run BEFORE this re-pull, not after).
  fs.writeFileSync(path.join(root, rel), JSON.stringify({ variables: [{ name: "a", values: { M: 2 } }] }));
  const second = run("--snapshot", rel);
  const stillFirst = fs.readFileSync(snapFile, "utf8") === firstBytes;
  const forced = run("--snapshot", rel, "--force");
  const nowChanged = fs.readFileSync(snapFile, "utf8") !== firstBytes;
  const prevKept = fs.existsSync(snapFile + ".prev") && fs.readFileSync(snapFile + ".prev", "utf8") === firstBytes;
  // Finding 322: a refusal exits 1 — a script driving `--snapshot` (sync-design step 2) must be able
  // to see that it didn't get the baseline it asked for, not just a human reading stderr. It still
  // does not hard-fail the WHOLE `--snapshot a b c` batch just because one of several files needed
  // --force — every file is still attempted, and this is a single-file batch either way.
  return first.status === 0 && second.status === 1 && /refusing to overwrite/.test(second.stderr) && stillFirst && forced.status === 0 && nowChanged && prevKept;
})());
check("re-running --snapshot with UNCHANGED content is a silent no-op, not an error", (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-diff-force-noop-"));
  const rel = path.join("design", "export", "design-system", "tokens.json");
  fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), JSON.stringify({ variables: [] }));
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: root, encoding: "utf8" });
  const first = run("--snapshot", rel);
  const second = run("--snapshot", rel); // same bytes, no --force needed
  return first.status === 0 && second.status === 0 && /unchanged/.test(second.stdout);
})());

// Finding 206: a snapshot of ONE file is not a copy of the export it belongs to. --snapshot now also
// copies the sibling set: a design-system file's other 8 siblings (bridge/design-system-layout.js is
// the one definition of that 9-file set), and a screen's .vars.json/.assets.json plus the shared
// pages/index.json it is indexed under.
console.log("CLI — --snapshot copies the sibling set (finding 206):");
check("snapshotting ONE design-system file also snapshots its 8 siblings", (() => {
  // Finding 320: the MANIFEST (design-system.json) lives at the export ROOT, one level ABOVE the
  // design-system/ subdirectory that holds the other 8 files (bridge/design-system-layout.js's own
  // header comment) — not flat alongside them, which is what this fixture used to (wrongly) assume.
  const { DESIGN_SYSTEM_FILES } = require("../bridge/design-system-layout.js");
  const names = Object.values(DESIGN_SYSTEM_FILES).filter((v) => typeof v === "string" && /\.json$/.test(v));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-diff-ds-siblings-"));
  const dsDir = path.join(root, "design", "export", "design-system");
  fs.mkdirSync(dsDir, { recursive: true });
  for (const n of names) {
    const at = n === DESIGN_SYSTEM_FILES.MANIFEST ? path.join(root, "design", "export", n) : path.join(dsDir, n);
    fs.writeFileSync(at, JSON.stringify({ file: n }));
  }
  const rel = path.join("design", "export", "design-system", "tokens.json");
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: root, encoding: "utf8" });
  const r = run("--snapshot", rel);
  const syncDir = path.join(root, "design", ".sync");
  const gotAll = names.every((n) => {
    const flat = n === DESIGN_SYSTEM_FILES.MANIFEST ? "export__" + n : "export__design-system__" + n;
    return fs.existsSync(path.join(syncDir, flat));
  });
  return r.status === 0 && !/not found/.test(r.stderr) && gotAll;
})());
check("snapshotting a screen file also snapshots its .vars.json/.assets.json and pages/index.json", (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-diff-screen-siblings-"));
  const pageDir = path.join(root, "design", "export", "pages", "home");
  fs.mkdirSync(pageDir, { recursive: true });
  const stem = "Login__1_23";
  fs.writeFileSync(path.join(pageDir, stem + ".json"), JSON.stringify(screen()));
  fs.writeFileSync(path.join(pageDir, stem + ".vars.json"), JSON.stringify({ variables: [] }));
  fs.writeFileSync(path.join(pageDir, stem + ".assets.json"), JSON.stringify({ files: [] }));
  fs.writeFileSync(path.join(root, "design", "export", "pages", "index.json"), JSON.stringify({ pageDirs: [] }));
  const rel = path.join("design", "export", "pages", "home", stem + ".json");
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: root, encoding: "utf8" });
  const r = run("--snapshot", rel);
  const syncDir = path.join(root, "design", ".sync");
  return r.status === 0
    && fs.existsSync(path.join(syncDir, "export__pages__home__" + stem + ".vars.json"))
    && fs.existsSync(path.join(syncDir, "export__pages__home__" + stem + ".assets.json"))
    && fs.existsSync(path.join(syncDir, "export__pages__index.json"));
})());

console.log("regressions from the 2026-09-21 execution audit:");
check("a change deep inside a long nested value names the LEAF — never two identical truncated blobs", (() => {
  const grad = (c) => [{ type: "gradient", gradientType: "linear", angle: 90, opacity: 1, blendMode: "normal", visible: true, transform: [[1, 0, 0], [0, 1, 0]], stops: [{ pos: 0, color: "#112233ff" }, { pos: 0.25, color: "#223344ff" }, { pos: 0.5, color: "#445566ff" }, { pos: 0.75, color: "#556677ff" }, { pos: 1, color: c }] }];
  const a = screen(), b = screen(); a.tree.children[1].fills = grad("#778899ff"); b.tree.children[1].fills = grad("#ff0000ff");
  const f = diffScreens(a, b).changed[0].fields;
  return f.length === 1 && f[0].field === "fills[0].stops[4].color" && f[0].before === "#778899ff" && f[0].after === "#ff0000ff" && f[0].category === "paint";
})());
check("a variant swap is ONE change — the regenerated I…;… sublayers are counted on it, not listed as added/removed", (() => {
  const inst = (v, p) => { const s = screen(); Object.assign(s.tree.children[2], { mainComponent: { key: "k-" + v }, props: { Variant: v }, children: [{ id: `I1:5;${p}:1`, name: "Label", type: "TEXT", text: "Go" }, { id: `I1:5;${p}:2`, name: "Icon", type: "VECTOR" }] }); return s; };
  const d = diffScreens(inst("primary", 10), inst("secondary", 11));
  return d.added.length === 0 && d.removed.length === 0 && d.changed.length === 1 && d.changed[0].fields.some((f) => f.field === "sublayers" && /^2 /.test(f.before) && /^2 /.test(f.after));
})());
check("a truncated NEW export warns that removals may be false", (() => { const b = screen(); b.manifest.truncated = 2; b.tree.children.pop(); const d = diffScreens(screen(), b); return d.removed.length === 1 && d.warnings.length === 1 && /truncated/.test(markdown(d, "x")); })());
check("root-level facts beside the tree (a new prototype flow) are a change", (() => { const b = screen(); b.flows = [{ name: "Onboarding", startNodeId: "1:1" }]; const d = diffScreens(screen(), b); return d.summary.changed === 1 && d.document[0].field === "flows" && /Beside the tree/.test(markdown(d, "x")); })());
check("children without ids don't crash the reorder report", (() => { const a = screen(), b = screen(); a.tree.children.push({ name: "anon" }); b.tree.children.unshift({ name: "anon" }); try { diffScreens(a, b); return true; } catch { return false; } })());
check("tokens: the same NAME in two collections is two tokens", (() => {
  const t = (v) => ({ variables: [{ name: "size/md", collection: "Space", values: { M: v } }, { name: "size/md", collection: "Type", values: { M: 14 } }] });
  const d = diffTokens(t(16), t(20));
  return d.changed.length === 1 && d.changed[0].name === "Space / size/md" && d.changed[0].modes[0].after === "20";
})());
check("tokens: a new MODE on a collection is reported", (() => {
  const t = (modes) => ({ collections: [{ name: "Theme", modes, default: "Light" }], variables: [] });
  const d = diffTokens(t(["Light", "Dark"]), t(["Light", "Dark", "High contrast"]));
  return d.summary.changed === 1 && d.collections[0].field === "Theme.modes[2]" && /Collections \/ modes/.test(markdown(d, "x"));
})());
check("catalog: removed / added components and a new variant option are all seen (it used to say 'Nothing changed')", (() => {
  const cat = () => ({ components: [{ key: "k1", id: "1:1", name: "Button", type: "COMPONENT_SET", page: "DS", variantProps: { State: ["default", "pressed"] } }, { key: "k2", id: "1:2", name: "Chip", type: "COMPONENT" }] });
  const b = cat(); b.components[0].variantProps.State.push("loading"); b.components[0].page = "Moved"; b.components.splice(1, 1); b.components.push({ key: "k3", id: "1:3", name: "Badge", type: "COMPONENT" });
  const d = diffDocs(cat(), b);
  return d.kind === "catalog" && d.removed[0].name === "Chip" && d.added[0].name === "Badge" && d.changed.length === 1 && d.changed[0].fields.length === 1 && d.changed[0].fields[0].field === "variantProps.State[2]" && /every built screen/.test(markdown(d, "x"));
})());
check("a catalog-sized catalog: dropping 3 components is 3 removals", (() => { const real = { components: Array.from({ length: 40 }, (_, i) => ({ key: "k" + i, id: "1:" + i, name: "Component " + i, type: i % 3 ? "COMPONENT" : "COMPONENT_SET", page: "DS", ...(i % 3 ? {} : { variantProps: { State: ["default", "pressed"] } }) })) }; const b = clone(real); b.components = b.components.slice(3); return diffCatalog(real, b).removed.length === 3; })());
check("a file that is none of the three kinds is refused, not reported as unchanged", (() => { try { diffDocs({ a: 1 }, { a: 2 }); return false; } catch (e) { return /nothing here can be diffed/.test(e.message); } })());

console.log("CLI — baseline choice, asset bytes, flags:");
const git = (root, ...a) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root, encoding: "utf8" });
const project = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-diff-")); fs.mkdirSync(path.join(root, "design", "assets"), { recursive: true }); return root; };
const put = (root, text, at, extra) => { const s = screen(); s.exportedAt = at; s.tree.children[0].text = text; Object.assign(s.tree.children[2], extra || {}); fs.writeFileSync(path.join(root, "design", "login.json"), JSON.stringify(s)); };
const cli = (root, ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: root, encoding: "utf8" });
check("a snapshot taken AFTER the re-pull is recognised as the same export; git HEAD is used instead", (() => {
  const root = project(); git(root, "init", "-q"); put(root, "v1", "2026-01-01T00:00:00Z"); git(root, "add", "-A"); git(root, "commit", "-qm", "v1");
  put(root, "v2", "2026-02-01T00:00:00Z"); cli(root, "--snapshot", "design/login.json");
  const d = JSON.parse(cli(root, "design/login.json", "--json").stdout);
  return d.against === "git HEAD" && d.summary.changed === 1 && d.warnings.some((w) => /SAME export/.test(w));
})());
check("…and with no older copy anywhere it says so instead of a bare 'Nothing changed'", (() => {
  const root = project(); put(root, "v2", "2026-02-01T00:00:00Z"); cli(root, "--snapshot", "design/login.json");
  const r = cli(root, "design/login.json");
  return r.status === 0 && /no OLDER export/.test(r.stdout);
})());
check("a stale snapshot does not shadow a newer committed export (v1 snapshot, v2 HEAD, v3 on disk → v2 → v3)", (() => {
  const root = project(); git(root, "init", "-q"); put(root, "v1", "2026-01-01T00:00:00Z"); cli(root, "--snapshot", "design/login.json");
  put(root, "v2", "2026-02-01T00:00:00Z"); git(root, "add", "-A"); git(root, "commit", "-qm", "v2"); put(root, "v3", "2026-03-01T00:00:00Z");
  const d = JSON.parse(cli(root, "design/login.json", "--json").stdout);
  return d.against === "git HEAD" && d.changed[0].fields[0].before === "v2" && d.changed[0].fields[0].after === "v3";
})());
check("a re-drawn icon (same node id, same path, different bytes) is a change", (() => {
  const root = project(); const icon = path.join(root, "design", "assets", "1_5.svg");
  fs.writeFileSync(icon, "<svg>old</svg>"); put(root, "v1", "2026-01-01T00:00:00Z", { asset: "assets/1_5.svg" });
  const snap = cli(root, "--snapshot", "design/login.json");
  fs.writeFileSync(icon, "<svg>new</svg>"); put(root, "v1", "2026-02-01T00:00:00Z", { asset: "assets/1_5.svg" });
  const d = JSON.parse(cli(root, "design/login.json", "--json").stdout);
  return /1 asset hash/.test(snap.stdout) && d.summary.changed === 1 && d.changed[0].fields[0].field === "asset bytes" && d.changed[0].categories[0] === "asset";
})());
check("an unknown flag is an error, not a silently different command", (() => { const root = project(); put(root, "v1", "2026-01-01T00:00:00Z"); const r = cli(root, "design/login.json", "--agains", "x.json"); return r.status === 2 && /unknown flag --agains/.test(r.stderr); })());
check("a file of an unknown kind exits 2 with the reason", (() => { const root = project(); fs.writeFileSync(path.join(root, "a.json"), "{}"); fs.writeFileSync(path.join(root, "b.json"), "{}"); const r = cli(root, "a.json", "--against", "b.json"); return r.status === 2 && /nothing here can be diffed/.test(r.stderr); })());

// ---------------------------------------------------------------- P5 round 4: style + hygiene diffs (finding 312)
// sync-design step 4 lists a diff command for EVERY design-system file a --design-system pull writes,
// including the four styles.*.json and hygiene.json — and all five used to exit 2 with "nothing here
// can be diffed", so a typography-only or effect-only design-system change (or a new/resolved hygiene
// warning) was exactly as undetectable as the skill warns it would be without them. Fixtures are the
// REAL design-system files from the livetest-4 export (test/fixtures/livetest4/design-system/).
console.log("style + hygiene diffs (finding 312, real design-system fixtures):");
const FIX_DS = path.join(__dirname, "fixtures", "livetest4", "design-system");
const readFix = (n) => JSON.parse(fs.readFileSync(path.join(FIX_DS, n), "utf8"));
check("styles.text.json: a real design-system file is recognised and diffs cleanly (isStyles)", (() => {
  const a = readFix("styles.text.json"), b = clone(a);
  const d = diffDocs(a, b);
  return d.kind === "styles" && d.summary.added === 0 && d.summary.removed === 0 && d.summary.changed === 0;
})());
check("styles.text.json: a changed field on an existing style is reported, keyed by style key", (() => {
  const a = readFix("styles.text.json"), b = clone(a);
  b.styles[0].size = b.styles[0].size + 8;
  const d = diffStyles(a, b);
  return d.summary.changed === 1 && d.changed[0].key === a.styles[0].key && d.changed[0].fields.some((f) => f.field === "size");
})());
check("styles.text.json: a removed style and an added one are both seen", (() => {
  const a = readFix("styles.text.json"), b = clone(a);
  const removedName = b.styles.pop().name;
  b.styles.push({ name: "Brand New Style", size: 12, font: "Poppins", weight: "Regular", key: "brandnewkey123", id: "S:brandnewkey123," });
  const d = diffStyles(a, b);
  return d.removed.length === 1 && d.removed[0].name === removedName && d.added.length === 1 && d.added[0].name === "Brand New Style";
})());
check("styles.effect.json: an effect array change is a field diff, not a blob", (() => {
  const a = readFix("styles.effect.json"), b = clone(a);
  b.styles[0].effects[0].radius = 999;
  const d = diffStyles(a, b);
  return d.summary.changed === 1 && d.changed[0].fields.some((f) => /effects/.test(f.field));
})());
check("styles.paint.json / styles.grid.json (empty `styles: []` in this real export): recognised, 'Nothing changed'", (() => {
  const paint = readFix("styles.paint.json"), grid = readFix("styles.grid.json");
  const dp = diffDocs(paint, clone(paint)), dg = diffDocs(grid, clone(grid));
  return dp.kind === "styles" && /Nothing changed/.test(markdown(dp, "x")) && dg.kind === "styles" && /Nothing changed/.test(markdown(dg, "x"));
})());
check("hygiene.json: a real hygiene file is recognised (isHygiene) and 'nothing changed' when identical", (() => {
  const a = readFix("hygiene.json");
  const d = diffDocs(a, clone(a));
  return d.kind === "hygiene" && d.summary.added === 0 && d.summary.removed === 0;
})());
check("hygiene.json: a new warning line is 'added', a resolved one is 'removed' — order doesn't matter", (() => {
  const a = readFix("hygiene.json"), b = clone(a);
  const resolved = b.hygiene.shift(); // the first line is no longer a problem
  b.hygiene.push("ALL_SCOPES on 'Brand New Variable' (pollutes every picker)"); // a new one appeared
  b.hygiene.reverse(); // order is not meaningful — must not read as N changes
  const d = diffHygiene(a, b);
  return d.added.length === 1 && d.added[0].includes("Brand New Variable") && d.removed.length === 1 && d.removed[0] === resolved;
})());
check("markdown renders styles/hygiene kinds without throwing, and names the right sections", (() => {
  const a = readFix("styles.text.json"), b = clone(a); b.styles[0].size += 1;
  const md1 = markdown(diffStyles(a, b), "styles.text.json");
  const h = readFix("hygiene.json"), hb = clone(h); hb.hygiene.push("new line");
  const md2 = markdown(diffHygiene(h, hb), "hygiene.json");
  return /Styles changed/.test(md1) && /New warning/.test(md2);
})());
check("CLI end to end: ALL NINE of sync-design step 4's design-system diff commands succeed on the real fixtures (finding 312, incl. the manifest addendum)", (() => {
  const root = project();
  const dsDir = path.join(root, "design", "export", "design-system");
  fs.mkdirSync(dsDir, { recursive: true });
  // The 8 files that live INSIDE design-system/ (bridge/design-system-layout.js's DESIGN_SYSTEM_FILES,
  // minus the manifest, which lives one level up — finding 320). tokens.json/components.*.json aren't
  // in the trimmed real-fixture set (tokens.json is already covered by the tokens tests above,
  // components.*.json by the catalog tests) — minimal stand-ins are enough here, since this check is
  // about ALL NINE names resolving and diffing, not re-proving each format's own logic again.
  const inDsDir = ["tokens.json", "styles.text.json", "styles.paint.json", "styles.effect.json", "styles.grid.json", "components.local.json", "components.library.json", "hygiene.json"];
  fs.writeFileSync(path.join(dsDir, "tokens.json"), JSON.stringify({ variables: [] }));
  fs.writeFileSync(path.join(dsDir, "components.local.json"), JSON.stringify({ components: [] }));
  fs.writeFileSync(path.join(dsDir, "components.library.json"), JSON.stringify({ components: [] }));
  for (const f of ["styles.text.json", "styles.paint.json", "styles.effect.json", "styles.grid.json", "hygiene.json"]) {
    fs.writeFileSync(path.join(dsDir, f), fs.readFileSync(path.join(FIX_DS, f)));
  }
  // The manifest (design-system.json) at the export ROOT — real fixture, from the same livetest-4 export.
  fs.writeFileSync(path.join(root, "design", "export", "design-system.json"), fs.readFileSync(path.join(__dirname, "fixtures", "livetest4", "design-system.json")));
  const allNine = [...inDsDir.map((f) => path.join("design", "export", "design-system", f)), path.join("design", "export", "design-system.json")];

  let allOk = true;
  for (const rel of allNine) {
    const r = cli(root, rel);
    if (r.status !== 0 && !(r.status === 2 && /no snapshot/.test(r.stderr))) allOk = false; // first run has no baseline yet — that's a separate, already-tested exit 2
  }
  // Snapshot ONLY the manifest (mirrors the addendum's own repro: "on a copy of the livetest-4 export,
  // after --snapshot of all nine files") — siblingFilesOf() must pull in the other 8 on its own, and
  // (finding 320) must never print a spurious "not found" for any of them, since every one of them is
  // right there on disk.
  const snap = cli(root, "--snapshot", path.join("design", "export", "design-system.json"));
  const spuriousNotFound = /not found — nothing to snapshot/.test(snap.stderr);

  let allDiffOk = true;
  for (const rel of allNine) {
    const r = cli(root, rel);
    if (r.status !== 0) allDiffOk = false;
  }
  return allOk && snap.status === 0 && !spuriousNotFound && allDiffOk;
})());
check("diffManifest: a counts/files change is a keyed field diff, exportedAt is ignored", (() => {
  const a = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "livetest4", "design-system.json"), "utf8"));
  const b = clone(a);
  b.exportedAt = "2099-01-01T00:00:00Z"; // must NOT show up as a change on its own
  b.counts.hygiene = a.counts.hygiene + 3;
  const d = diffDocs(a, b);
  return d.kind === "manifest" && d.summary.changed === 1 && d.fields.length === 1 && d.fields[0].field === "counts.hygiene";
})());

report();
