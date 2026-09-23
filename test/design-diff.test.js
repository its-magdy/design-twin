// Offline tests for design-to-code/design-diff.js (the sync-design skill's change list).
//   node test/design-diff.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { diffScreens, diffTokens, diffCatalog, diffDocs, markdown, snapshotPath } = require("../design-to-code/design-diff");
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
  // Refusing to overwrite is reported the same way "nothing to snapshot yet" is (a warning on stderr,
  // exit 0) — --snapshot never hard-fails a whole `--snapshot a b c` batch because ONE of several files
  // needed --force; it just leaves that one alone and says so.
  return first.status === 0 && second.status === 0 && /refusing to overwrite/.test(second.stderr) && stillFirst && forced.status === 0 && nowChanged && prevKept;
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
  const { DESIGN_SYSTEM_FILES } = require("../bridge/design-system-layout.js");
  const names = Object.values(DESIGN_SYSTEM_FILES).filter((v) => typeof v === "string" && /\.json$/.test(v));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-diff-ds-siblings-"));
  const dsDir = path.join(root, "design", "export", "design-system");
  fs.mkdirSync(dsDir, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(dsDir, n), JSON.stringify({ file: n }));
  const rel = path.join("design", "export", "design-system", "tokens.json");
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: root, encoding: "utf8" });
  const r = run("--snapshot", rel);
  const syncDir = path.join(root, "design", ".sync");
  const gotAll = names.every((n) => fs.existsSync(path.join(syncDir, "export__design-system__" + n)));
  return r.status === 0 && gotAll;
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
check("the REAL catalog: dropping 3 components is 3 removals", (() => { const real = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "design", "design-system-teamsmart", "components.local.json"), "utf8")); const b = clone(real); b.components = b.components.slice(3); return diffCatalog(real, b).removed.length === 3; })());
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

report();
