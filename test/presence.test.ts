// presence.ts and hints.ts: the one 0 / 1 / many decision every front-end asks, and the next-step sentences they
// all print — as a table, plus the docs that must quote the same plugin step.
//   bun test/presence.test.ts
import fs from "node:fs";
import path from "node:path";
import { check, report } from "./assert.ts";
import { clientRow } from "./fixtures.ts";
import { matchTarget, presence } from "../bridge/src/presence.ts";
import type { Presence } from "../bridge/src/presence.ts";
import { PLUGIN_MENU, pasteToken, pickClient, runPlugin, sentence, whoHolds } from "../bridge/src/hints.ts";
import type { ClientRow } from "../bridge/src/server-core.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

console.log("\npresence — none | one | ambiguous, for every kind of target:");
{
  const a = clientRow({ connId: "c1", file: "App — Base", fileKey: "KEYA" });
  const b = clientRow({ connId: "c2", file: "App — Library", fileKey: "KEYB" });
  const c = clientRow({ connId: "c3", file: null, fileKey: null }); // not identified yet
  const said = (p: Presence<ClientRow>): string => p.kind === "one" ? "one:" + p.row.connId : p.kind === "ambiguous" ? "ambiguous:" + p.rows.map((r) => r.connId).join(",") : "none";
  const rows: Array<[string, ClientRow[], string | null | undefined, string]> = [
    ["nothing connected, no target", [], undefined, "none"],
    ["nothing connected, a target", [], "App", "none"],
    ["one connected, no target", [a], undefined, "one:c1"],
    ["one connected, empty target (no target)", [a], "", "one:c1"],
    ["one connected, null target", [a], null, "one:c1"],
    ["several, no target", [a, b], undefined, "ambiguous:c1,c2"],
    ["an unidentified row still counts", [a, c], undefined, "ambiguous:c1,c3"],
    ["a connId", [a, b], "c2", "one:c2"],
    ["a fileKey", [a, b], "KEYA", "one:c1"],
    ["a substring, case-insensitive", [a, b], "library", "one:c2"],
    ["a substring matching both", [a, b], "app", "ambiguous:c1,c2"],
    ["a target matching nothing", [a, b], "Nobody", "none"],
    ["a connId wins over a file name that contains it", [clientRow({ connId: "c1", file: "x c2 y" }), clientRow({ connId: "c2", file: "Other" })], "c2", "one:c2"],
  ];
  for (const [what, list, target, want] of rows) {
    const got = said(presence(list, target));
    check(`presence: ${what} → ${want} (got ${got})`, got === want);
  }
  check("matchTarget: no target names every row, in order", matchTarget([a, b], undefined).map((r) => r.connId).join() === "c1,c2");
}

console.log("\nhints — one sentence per step, and every front-end prints it:");
{
  check("runPlugin names the menu path and Figma desktop", runPlugin.includes(PLUGIN_MENU) && /DESKTOP/.test(runPlugin));
  check("pickClient names --client, the MCP argument and the listing", /--client/.test(pickClient) && /client: /.test(pickClient) && /dtwin list clients/.test(pickClient));
  check("pasteToken names --show-token and the plugin's field", /dtwin --show-token/.test(pasteToken) && /Bridge token/.test(pasteToken));
  check("sentence capitalises and ends with a full stop", sentence("in Figma do x") === "In Figma do x.");
  check("whoHolds: this process / the daemon (pid) / an old daemon",
    whoHolds({ connection: null, owner: { kind: "own" } }) === "this process"
    && whoHolds({ connection: { connected: true, connId: "c1", connectedAt: 1, connectionUptimeMs: 1, clientsConnected: 1, clients: [], connectionsThisRun: 1, takeovers: 0, lastTakeoverAt: null }, owner: { kind: "daemon", pid: 42, port: 8787, pluginConnected: true } }) === "the daemon (pid 42)"
    && whoHolds({ connection: null, owner: { kind: "daemon", pid: null, port: null, pluginConnected: null } }) === "the daemon (pid ?), too old to relay its socket stats");
  // No front-end words the step its own way any more: every source file that tells the user to run the plugin goes
  // through hints.ts (the menu path is written out nowhere else under bridge/src).
  const src = path.join(ROOT, "bridge", "src");
  const spelled = fs.readdirSync(src).filter((f) => f.endsWith(".ts") && f !== "hints.ts")
    .filter((f) => fs.readFileSync(path.join(src, f), "utf8").includes(PLUGIN_MENU));
  check(`the menu path is spelled out only in hints.ts (also in: ${spelled.join(", ") || "none"})`, spelled.length === 0);
}

console.log("\ndocs — the README, setup guide and the help/extract skills quote the plugin step:");
{
  for (const rel of ["README.md", "docs/setup.md", "claude-plugin/skills/help/SKILL.md", "claude-plugin/skills/extract/SKILL.md"]) {
    // Markdown wraps lines and bolds words: compare with both undone.
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\*\*/g, "").replace(/\s+/g, " ");
    check(`${rel} quotes "${PLUGIN_MENU}"`, text.includes(PLUGIN_MENU));
  }
}

report();
