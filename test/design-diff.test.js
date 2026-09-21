// Offline tests for design-to-code/design-diff.js (the sync-design skill's change list).
//   node test/design-diff.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { diffScreens, diffTokens, markdown, snapshotPath } = require("../design-to-code/design-diff");
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

report();
