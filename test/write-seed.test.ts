// seedTokens end to end (#182): the REAL MCP server (bridge/src/figma-mcp.ts) as a subprocess, spoken to by the MCP SDK's
// client, and a fake plugin on its bridge socket whose write and writeImpact run the plugin's REAL code (built into
// fake-figma's VM) on a fake file. The token files sit in the directory the server runs in, as a project's do: the
// agent names the file, and no token value crosses the tool boundary.
//   bun test/write-seed.test.ts
//
// Port rule: nothing here binds 8787–8789 (server-core's DT_TEST_EPHEMERAL_PORT seam; HOME and TMPDIR are a temp dir).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { check, report } from "./assert.ts";
import { fakePlugin } from "./fake-plugin.ts";
import { tokens } from "./fixtures.ts";
import { treeWorld } from "./harness/writes.ts";
import type { FakeCollection, FakeNode, FakeVariable } from "./fake-figma.ts";
import { toResolver } from "../design-to-code/tokens.ts";
import type { WhoamiReply, WriteImpactReply, WriteOp } from "../bridge/src/commands.ts";
import { isUnknownArray } from "../bridge/src/json-util.ts";
import { MAX_SPEC_FILE_BYTES } from "../bridge/src/spec-file.ts";

const TOKEN = "write-seed-token";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtseed-"));
const project = path.join(dir, "project");
fs.mkdirSync(project, { recursive: true });
const put = (name: string, content: unknown): void => {
  const p = path.join(project, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content, null, 2));
};
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
for (const k of ["FIGMA_DAEMON_IDLE_MIN", "FIGMA_EXPORT_DIR", "FIGMA_BRIDGE_TOKEN_FILE", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR"]) delete env[k];
Object.assign(env, {
  HOME: dir, USERPROFILE: dir, APPDATA: path.join(dir, "AppData"), TMPDIR: dir, TEMP: dir, TMP: dir,
  FIGMA_BRIDGE_PORT: "8789", FIGMA_BRIDGE_TOKEN: TOKEN, MAX_MCP_OUTPUT_TOKENS: "", DT_TEST_EPHEMERAL_PORT: "1",
});

// ---- the project's tokens: a theme emitted by design-to-code's toResolver (Primitives, and Theme in Light and Dark),
// and a hand-written tokens.dtcg.json with a text style and a shadow bound to its variables.
const THEME = tokens({
  collections: [{ name: "Primitives", modes: ["Value"], default: "Value" }, { name: "Theme", modes: ["Light", "Dark"], default: "Light" }],
  variables: [
    { name: "color/gray/0", type: "COLOR", collection: "Primitives", values: { Value: "#ffffff" } },
    { name: "color/gray/900", type: "COLOR", collection: "Primitives", values: { Value: "#111827" } },
    { name: "color/indigo/600", type: "COLOR", collection: "Primitives", values: { Value: "#4f46e5" } },
    { name: "space/sm", type: "FLOAT", collection: "Primitives", values: { Value: 8 }, scopes: ["GAP"] },
    { name: "color/bg", type: "COLOR", collection: "Theme", values: { Light: { aliasOf: "color/gray/0" }, Dark: { aliasOf: "color/gray/900" } } },
    { name: "color/text", type: "COLOR", collection: "Theme", values: { Light: { aliasOf: "color/gray/900" }, Dark: { aliasOf: "color/gray/0" } } },
    { name: "color/brand/primary", type: "COLOR", collection: "Theme", values: { Light: { aliasOf: "color/indigo/600" }, Dark: "#818cf8" } },
    { name: "flag/dense", type: "BOOLEAN", collection: "Theme", values: { Light: false, Dark: true } },
  ],
});
const { resolver, files } = toResolver(THEME, []);
function writeTheme(edit?: (f: Record<string, unknown>) => void): void {
  put("tokens.resolver.json", resolver);
  for (const [name, tree] of Object.entries(files)) {
    const copy = JSON.parse(JSON.stringify(tree)) as Record<string, unknown>;
    if (edit && name.endsWith("theme.dark.json")) edit(copy);
    put(name, copy);
  }
}
writeTheme();
const STYLED = {
  font: { family: { $type: "fontFamily", $value: "Inter" }, size: { $type: "dimension", md: { $value: { value: 16, unit: "px" } } } },
  shadow: { color: { $type: "color", $value: "#00000040" } },
  text: { body: { $type: "typography", $value: { fontFamily: "{font.family}", fontSize: "{font.size.md}", fontWeight: 700, lineHeight: 1.5 } } },
  elevation: { card: { $type: "shadow", $value: { color: "{shadow.color}", offsetX: "0px", offsetY: "2px", blur: "8px", spread: "0px" } } },
  motion: { fast: { $type: "duration", $value: { value: 100, unit: "ms" } } },
};
put("styled/tokens.dtcg.json", STYLED);

interface Reply { text: string; isError: boolean }
function replyText(r: unknown): Reply {
  const content: unknown = typeof r === "object" && r !== null && "content" in r ? r.content : undefined;
  const parts = isUnknownArray(content) ? content : [];
  const text = parts.map((c) => (typeof c === "object" && c !== null && "text" in c && typeof c.text === "string" ? c.text : "")).join("\n");
  return { text, isError: typeof r === "object" && r !== null && "isError" in r && r.isError === true };
}
const json = (r: Reply): Record<string, unknown> => { try { const v: unknown = JSON.parse(r.text); return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {}; } catch { return {}; } };
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter(isObj) : []);
const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
const isImpact = (v: unknown): v is WriteImpactReply => isObj(v) && Array.isArray(v.steps);

void (async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(import.meta.dirname, "..", "bridge", "src", "figma-mcp.ts")], env, cwd: project, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => { stderr += String(d); });
  const client = new Client({ name: "write-seed", version: "0.0.0" });
  try {
    await client.connect(transport);
    let port = 0;
    for (let i = 0; i < 400 && !port; i++) {
      const m = /\[bridge\] DT_TEST_EPHEMERAL_PORT: 8789 -> (\d+)/.exec(stderr);
      if (m) port = Number(m[1]); else await sleep(25);
    }
    check("the MCP server is up and its bridge is listening", port > 0);
    if (!port) { console.log(stderr); report(); return; }

    let w = await treeWorld();
    await w.allowEdits();
    const writes: WriteOp[][] = [];
    const plugin = fakePlugin(port, {
      token: TOKEN, hello: { instanceId: "fig-seed", file: "Sample App", page: "Page 1" },
      on: {
        whoami: (): WhoamiReply => ({ instanceId: "fig-seed", startedAt: 0, uptimeMs: 1, file: "Sample App", page: "Page 1", pageId: "", editorType: "figma", pluginVersion: "0.0.0", fileKey: null, fileKeyAvailable: false, editsAllowed: true }),
        write: async (a) => { writes.push(a.ops); return await w.api.applyWrites(a.ops.map((o) => ({ ...o }))); },
        writeImpact: async (a): Promise<WriteImpactReply> => {
          const posted = await w.send({ type: "bridge", id: "imp", cmd: "writeImpact", args: { ops: a.ops } });
          const r = posted.find((m) => m.type === "bridge-result" && m.id === "imp");
          const result: unknown = r && r.ok ? r.result : null;
          return isImpact(result) ? result : { steps: [] };
        },
      },
    });
    await plugin.opened;
    const call = async (args: Record<string, unknown>): Promise<Reply> => replyText(await client.callTool({ name: "figma_write", arguments: args }));
    const collNamed = (name: string): FakeCollection | undefined => Object.values(w.scene.collections).find((c) => c.name === name);
    const varNamed = (name: string): FakeVariable | undefined => Object.values(w.scene.variables).find((v) => v.name === name);
    const valueIn = (name: string, mode: string): unknown => {
      const v = varNamed(name), c = v ? w.scene.collections[v.variableCollectionId] : undefined;
      const m = c?.modes.find((x) => x.name === mode);
      return v && m ? v.valuesByMode[m.modeId] : undefined;
    };
    const aliasTo = (name: string): { type: "VARIABLE_ALIAS"; id: string } => ({ type: "VARIABLE_ALIAS", id: varNamed(name)?.id ?? "?" });

    // ---- the dry run: the plan the plugin reads, and what is not seeded
    const dry = json(await call({ dryRun: true, ops: [{ op: "seedTokens", file: "styled/tokens.dtcg.json", collection: "Kit" }] }));
    const dstep = list(dry.steps)[0];
    const dtables = list(dstep?.tables);
    check("the dry run: one seedTokens step, its tables under it with the plugin's plan, the unmapped token listed, nothing written",
      dstep?.op === "seedTokens" && dstep.index === 0 && dtables.length === 2 && same(dtables[0]?.plan, { create: ["collection 'Kit'", "font/family", "font/size/md", "shadow/color"], update: [] })
      && same(dtables[1]?.plan, { create: ["text/body", "elevation/card"], update: [] }) && same(dstep.unmapped, [{ token: "motion/fast", reason: "a duration token has no Figma variable or style" }])
      && dry.creates === 1 && dry.invalid === 0 && writes.length === 0 && collNamed("Kit") === undefined);

    // ---- the resolver lands: two collections, modes, aliases across them
    const first = await call({ ops: [{ op: "seedTokens", file: "tokens.resolver.json" }] });
    const r1 = json(first);
    const seeded = list(r1.applied)[0];
    const t1 = list(seeded?.tables);
    const prim = collNamed("Primitives"), theme = collNamed("Theme");
    // The file has a one-mode Primitives collection already (found by name, its new rows created in it); Theme is new.
    check(`the resolver lands: Primitives (one mode) then Theme (Light, Dark), each row created${first.isError ? " (" + first.text.slice(0, 300) + ")" : ""}`, !first.isError && r1.ok === true
      && seeded?.seeded === "tokens.resolver.json" && same(t1.map((t) => [t.collection, t.result, count(t.created), t.unchanged]), [["Primitives", "unchanged", 4, 0], ["Theme", "created", 4, 0]])
      && prim?.modes.length === 1 && same(theme?.modes.map((m) => m.name), ["Light", "Dark"]));
    check("the reply names each created row with its id", same(t1[1]?.created, ["color/bg", "color/text", "color/brand/primary", "flag/dense"].map((n) => [n, varNamed(n)?.id])));
    check("values per mode, aliases into the other collection, a boolean as a boolean", same(valueIn("color/bg", "Light"), aliasTo("color/gray/0")) && same(valueIn("color/bg", "Dark"), aliasTo("color/gray/900"))
      && same(valueIn("color/brand/primary", "Light"), aliasTo("color/indigo/600")) && same(valueIn("color/brand/primary", "Dark"), { r: 0x81 / 255, g: 0x8c / 255, b: 0xf8 / 255, a: 1 })
      && valueIn("flag/dense", "Dark") === true && varNamed("flag/dense")?.resolvedType === "BOOLEAN" && valueIn("space/sm", prim?.modes[0]?.name ?? "") === 8);
    const sent = writes.at(-1) ?? [];
    check("the plugin got the tables, never a path or a seedTokens op", same(sent.map((o) => o.op), ["createVariables", "createVariables"]) && !JSON.stringify(sent).includes("tokens.resolver.json") && !JSON.stringify(sent).includes("seedTokens"));

    // ---- again, unchanged: nothing to report but the counts
    const again = json(await call({ ops: [{ op: "seedTokens", file: "tokens.resolver.json" }] }));
    const t2 = list(list(again.applied)[0]?.tables);
    check("seeded again as it is: no row created or updated, every one counted unchanged", again.ok === true && same(t2, [
      { collection: "Primitives", id: prim?.id, result: "unchanged", unchanged: 4 }, { collection: "Theme", id: theme?.id, result: "unchanged", unchanged: 4 }]));

    // ---- a token changed in the code: updated in place, and only it reported
    const bgId = varNamed("color/bg")?.id;
    writeTheme((f) => { const color = f.color as Record<string, unknown>; color.bg = { $type: "color", $value: "{color.indigo.600}" }; });
    const changed = json(await call({ ops: [{ op: "seedTokens", file: "tokens.resolver.json" }] }));
    const t3 = list(list(changed.applied)[0]?.tables);
    check("a token changed in a context file: that row updated in place (same id), the rest unchanged", changed.ok === true
      && same(t3.map((t) => [t.collection, t.updated, t.created, t.unchanged]), [["Primitives", undefined, undefined, 4], ["Theme", [["color/bg", bgId]], undefined, 3]])
      && varNamed("color/bg")?.id === bgId && same(valueIn("color/bg", "Dark"), aliasTo("color/indigo/600")) && same(valueIn("color/bg", "Light"), aliasTo("color/gray/0")));

    // ---- styles, bound to the seeded variables; a spec after them in the same batch, at its own index
    w = await treeWorld();
    await w.allowEdits();
    const styled = json(await call({ ops: [{ op: "seedTokens", file: "styled/tokens.dtcg.json", collection: "Kit" }, { op: "createTree", tree: { name: "Card", fills: [{ type: "solid", tokens: { color: "shadow/color" } }] } }] }));
    const ap = list(styled.applied);
    const st = list(ap[0]?.tables);
    const styleNamed = (name: string): FakeNode | undefined => [...w.scene.localStyles.text, ...w.scene.localStyles.effect].find((s) => s.name === name);
    const body = styleNamed("text/body"), card = styleNamed("elevation/card");
    const fx = Array.isArray(card?.effects) ? (card.effects as FakeNode[]) : [];
    check("a DTCG file with styles: the variables, then the text and effect styles, the tree after them at index 1", styled.ok === true && ap.length === 2 && st.length === 2
      && same(st[1], { styles: true, created: [["text/body", body?.id], ["elevation/card", card?.id]], unchanged: 0 }) && typeof ap[1]?.id === "string" && same(list(ap[0]?.unmapped).map((u) => u.token), ["motion/fast"]));
    check("the text style's family and size bound to the seeded variables; the shadow's colour too", same(body?.boundVariables, { fontFamily: aliasTo("font/family"), fontSize: aliasTo("font/size/md") })
      && same(body?.fontName, { family: "Inter", style: "Bold" }) && same(body?.lineHeight, { unit: "PERCENT", value: 150 }) && same(fx[0]?.boundVariables, { color: aliasTo("shadow/color") }));
    const restyled = json(await call({ ops: [{ op: "seedTokens", file: "styled/tokens.dtcg.json", collection: "Kit" }] }));
    check("seeded again: the styles unchanged too", same(list(list(restyled.applied)[0]?.tables).map((t) => t.unchanged), [3, 2]) && !JSON.stringify(restyled.applied).includes("\"created\"") && !JSON.stringify(restyled.applied).includes("\"updated\""));

    // ---- names that are Object.prototype's
    put("proto.dtcg.json", '{ "__proto__": { "$type": "color", "$value": "#000000" }, "constructor": { "$value": "{__proto__}" }, "toString": { "hasOwnProperty": { "$type": "number", "$value": 1 } } }');
    const proto = await call({ ops: [{ op: "seedTokens", file: "proto.dtcg.json", collection: "__proto__" }] });
    check(`__proto__, constructor, toString/hasOwnProperty land as names, in a collection named __proto__${proto.isError ? " (" + proto.text.slice(0, 200) + ")" : ""}`, !proto.isError && collNamed("__proto__") !== undefined
      && varNamed("__proto__")?.resolvedType === "COLOR" && same(Object.values(varNamed("constructor")?.valuesByMode ?? {}), [aliasTo("__proto__")]) && varNamed("toString/hasOwnProperty")?.resolvedType === "FLOAT"
      && same(list(list(json(proto).applied)[0]?.tables)[0]?.created, [["__proto__", varNamed("__proto__")?.id], ["constructor", varNamed("constructor")?.id], ["toString/hasOwnProperty", varNamed("toString/hasOwnProperty")?.id]]));

    // ---- refusals: each before the plugin is asked
    const before = writes.length;
    put("tokens.css", ":root { --color-bg: #fff; }");
    put("broken.json", "{");
    put("huge.json", " ".repeat(MAX_SPEC_FILE_BYTES + 1));
    put("url.resolver.json", { version: "2025.10", sets: { A: { sources: [{ $ref: "https://example.com/t.json" }] } }, resolutionOrder: [{ $ref: "#/sets/A" }] });
    put("out.resolver.json", { version: "2025.10", sets: { A: { sources: [{ $ref: "../../elsewhere.json" }] } }, resolutionOrder: [{ $ref: "#/sets/A" }] });
    const refusals: Array<[string, Record<string, unknown>, RegExp]> = [
      ["outside the directory", { ops: [{ op: "seedTokens", file: "../elsewhere.json" }] }, /ops\[0\]\.file must stay inside the directory this server was started in/],
      ["a URL $ref", { ops: [{ op: "seedTokens", file: "url.resolver.json" }] }, /set 'A': 'https:\/\/example\.com\/t\.json' is a URL/],
      ["a $ref out of the directory", { ops: [{ op: "seedTokens", file: "out.resolver.json" }] }, /\$ref '\.\.\/\.\.\/elsewhere\.json' must stay inside the directory/],
      ["a CSS file", { ops: [{ op: "seedTokens", file: "tokens.css" }] }, /'tokens\.css' is not read .*tokens\.dtcg\.json/],
      ["a file too big", { ops: [{ op: "seedTokens", file: "huge.json" }] }, /huge\.json is \d+ bytes; a token file is at most/],
      ["a file that is not JSON", { dryRun: true, ops: [{ op: "seedTokens", file: "broken.json" }] }, /broken\.json is not valid JSON/],
      ["after another op", { ops: [{ op: "createFrame", name: "F" }, { op: "seedTokens", file: "tokens.resolver.json" }] }, /ops\[1\]: seedTokens goes before every other op of a batch/],
    ];
    for (const [what, args, want] of refusals) {
      const r = await call(args);
      check(`refused, nothing changed: ${what} (got ${JSON.stringify(r.text.slice(0, 160))})`, r.isError && want.test(r.text) && /Nothing was changed\.$/.test(r.text));
    }
    check("none of the refusals reached the plugin", writes.length === before);
    plugin.stop();
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  report();
})().catch((e: unknown) => {
  check(`the suite ran to the end (${e instanceof Error ? e.stack ?? e.message : String(e)})`, false);
  report();
});
