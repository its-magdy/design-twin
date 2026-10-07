// test/g14-step0.test.ts — group 14's shared helpers, pure: finding ids (F-44), the one component name
// rule (DT-27), whoami's addressed connection (DT-03) and the source stamp (L-5).
import { check, report } from "./assert.ts";
import { catalog } from "./fixtures.ts";
import { findingIds, legacyBlockerIds } from "../design-to-code/finding-id.ts";
import { matchByNameAndSignature, nameVerdict } from "../design-to-code/component-match.ts";
import type { MatchInstance, MatchRow } from "../design-to-code/types.ts";
import { connectionFor } from "../bridge/src/server-core.ts";
import type { ClientRow, ConnectionInfo } from "../bridge/src/server-core.ts";
import { stampSource } from "../bridge/src/source-stamp.ts";

console.log("finding-id (F-44):");
{
  const two = [
    { severity: "blocker", code: "missing-font", nodeId: "1:1" },
    { severity: "blocker", code: "missing-font", nodeId: "1:2" },
  ];
  const ids = findingIds(two);
  check("code@nodeId per finding", JSON.stringify(ids) === JSON.stringify(["missing-font@1:1", "missing-font@1:2"]));
  const three = [{ severity: "blocker", code: "contrast", nodeId: "9:9" }, ...two];
  const ids3 = findingIds(three);
  check("an earlier insertion leaves the other ids unchanged", ids3[1] === "missing-font@1:1" && ids3[2] === "missing-font@1:2");
  check("no nodeId → the bare code", JSON.stringify(findingIds([{ code: "token-name-collision" }])) === JSON.stringify(["token-name-collision"]));
  const rep = findingIds([{ code: "a", nodeId: "1:1" }, { code: "b" }, { code: "a", nodeId: "1:1" }, { code: "b" }, { code: "a", nodeId: "1:1" }, { code: "a", nodeId: "1:2" }]);
  check("repeats of one (code,node) pair get ~2, ~3 in report order; the first stays bare",
    JSON.stringify(rep) === JSON.stringify(["a@1:1", "b", "a@1:1~2", "b~2", "a@1:1~3", "a@1:2"]));
  const legacy = legacyBlockerIds([{ severity: "warning", code: "w" }, ...three, { severity: "blocker" }]);
  check("legacy ids: <code>#<i> by position among blockers only", JSON.stringify(legacy) === JSON.stringify(["contrast#0", "missing-font#1", "missing-font#2", "blocker#3"]));
}

console.log("nameVerdict (DT-27):");
{
  const inst = (name: string, nodeId: string, variant: Record<string, string> | null, props: Record<string, string | boolean> = {}): MatchInstance =>
    ({ nodeId, layer: name, name, key: "remote-" + nodeId, remote: false, variant, props });
  const cat = catalog([
    // two identical definitions of one icon: a harmless duplicate
    { name: "icon/check-circle", type: "COMPONENT", id: "1:1", key: "k1" },
    { name: "icon/check-circle", type: "COMPONENT", id: "1:2", key: "k2" },
    { name: "Header", type: "COMPONENT", id: "2:1", key: "k3", props: { Title: { type: "TEXT" } } },
    // two Badges both accepting Size=S, with different option lists: a real tie
    { name: "Badge", type: "COMPONENT_SET", id: "3:1", key: "k4", props: { Size: { type: "VARIANT", options: ["S", "M"] } } },
    { name: "Badge", type: "COMPONENT_SET", id: "3:2", key: "k5", props: { Size: { type: "VARIANT", options: ["S", "L"] } } },
    // two Pills, neither has the instance's axis
    { name: "Pill", type: "COMPONENT_SET", id: "4:1", key: "k6", props: { Tone: { type: "VARIANT", options: ["Info"] } } },
    { name: "Pill", type: "COMPONENT_SET", id: "4:2", key: "k7", props: { Tone: { type: "VARIANT", options: ["Warn"] } } },
  ]);
  const res = matchByNameAndSignature([
    inst("icon/check-circle", "9:1", null),
    inst("Header", "9:2", null, { Count: true }),
    inst("Badge", "9:3", { Size: "S" }),
    inst("Pill", "9:4", { Shape: "Round" }),
    inst("Acme Icon", "9:5", null),
  ], cat);
  const row = (n: string): MatchRow | undefined => res.rows.find((r) => r.name === n);
  const v = (n: string): string => { const r = row(n); return r ? nameVerdict(r).status : "(no row)"; };
  check("duplicate definitions → matched", v("icon/check-circle") === "matched");
  check("the one candidate's signature disagrees → unmatched", v("Header") === "unmatched");
  check("a different-signatures tie → ambiguous", v("Badge") === "ambiguous");
  check("2 candidates, none verified → ambiguous", v("Pill") === "ambiguous");
  check("no candidate → unmatched", v("Acme Icon") === "unmatched");
  const pill = row("Pill");
  check("the row lists its same-named candidates (id/key/name)",
    !!pill && JSON.stringify(pill.candidates) === JSON.stringify([{ id: "4:1", key: "k6", name: "Pill" }, { id: "4:2", key: "k7", name: "Pill" }]));
  check("a single-candidate row lists none", row("Header")?.candidates === undefined);
  const hdr = row("Header");
  check("every verdict carries a reason", !!hdr && nameVerdict(hdr).reason.length > 0);
}

console.log("connectionFor (DT-03):");
{
  const client = (connId: string, connectedAt: number): ClientRow => ({
    connId, file: "Sample App " + connId, fileKey: null, page: null, instanceId: null, connectedAt, uptimeMs: 1000 - connectedAt, identified: true, pluginVersion: null, pluginStale: null,
  });
  const info: ConnectionInfo = {
    connId: "c1", connected: true, connectedAt: 10, connectionUptimeMs: 990, connectionsThisRun: 2, clientsConnected: 2,
    clients: [client("c1", 10), client("c2", 400)], takeovers: 0, lastTakeoverAt: null,
  };
  const c2 = connectionFor(info, "c2");
  check("the addressed connection's connId/connectedAt/uptime", c2.connId === "c2" && c2.connectedAt === 400 && c2.connectionUptimeMs === 600);
  check("the rest is kept", c2.clientsConnected === 2 && c2.clients.length === 2 && c2.connectionsThisRun === 2 && c2.connected);
  check("null / unknown connId → unchanged", connectionFor(info, null) === info && connectionFor(info, "c9") === info && connectionFor(info, undefined) === info);
  check("pure: the input is not mutated", info.connId === "c1" && info.connectedAt === 10);
}

console.log("stampSource (L-5):");
{
  const a = stampSource({ reply: { x: 1 }, client: { file: "Sample App", fileKey: "abc" } });
  check("file + fileKey stamped", a.sourceFile === "Sample App" && a.sourceFileKey === "abc" && a.x === 1);
  const b = stampSource({ reply: { x: 1 }, client: { file: "Sample App", fileKey: null } });
  check("no fileKey → only sourceFile", b.sourceFile === "Sample App" && !("sourceFileKey" in b));
  const c = stampSource({ reply: { x: 1 }, client: null });
  check("no client → unstamped (never guessed)", !("sourceFile" in c));
  const d = stampSource({ reply: { x: 1 }, client: { file: null, fileKey: "abc" } });
  check("a client with no file name yet → unstamped", !("sourceFile" in d) && !("sourceFileKey" in d));
}

report();
