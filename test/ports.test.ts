// FIGMA_BRIDGE_PORT parsing (bridge/src/ports.ts) as pure functions, and the three readers that share
// it: server-core's load-time exit (bridgePortOrExit), doctor's resolvePort and the daemon's socket name.
//   node test/ports.test.ts
// No bridge, no port, no socket: process.exit and console.error are stubbed, and the daemon socket
// path is only computed (no uid, so the directory is the temp dir itself and nothing is created).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, report } from "./assert.ts";
import { ALLOWED_PORTS, parsePortEnv, bridgePortOrExit } from "../bridge/src/ports.ts";
import { resolvePort } from "../bridge/src/doctor.ts";
import * as daemon from "../bridge/src/daemon.ts";

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

console.log("\nparsePortEnv:");
check("unset selects the first allowed port", same(parsePortEnv(undefined), { port: ALLOWED_PORTS[0] }));
check("empty selects the first allowed port", same(parsePortEnv(""), { port: ALLOWED_PORTS[0] }));
check("each allowed port is kept", ALLOWED_PORTS.every((p) => same(parsePortEnv(String(p)), { port: p })));
check("a port outside the three is invalid, carrying the raw value", same(parsePortEnv("9999"), { invalid: "9999" }) && same(parsePortEnv("8786"), { invalid: "8786" }));
check("0 is invalid", same(parsePortEnv("0"), { invalid: "0" }));
check("a non-numeric value is invalid", same(parsePortEnv("abc"), { invalid: "abc" }) && same(parsePortEnv("8788x"), { invalid: "8788x" }));
check("a whitespace-only value is invalid (Number(\" \") is 0), not the default", same(parsePortEnv(" "), { invalid: " " }));
check("surrounding whitespace is ignored", same(parsePortEnv(" 8788 "), { port: 8788 }) && same(parsePortEnv("8789\n"), { port: 8789 }));

// bridgePortOrExit with process.exit and console.error stubbed: what it returns, prints and exits with.
function runOrExit(raw: string | undefined): { port?: number; code?: number; printed: string[] } {
  const realExit = process.exit;
  const realError = console.error;
  const printed: string[] = [];
  let code: number | undefined;
  const exited = new Error("exited");
  process.exit = (c?: number) => { code = c; throw exited; };
  console.error = (...a: unknown[]) => { printed.push(a.map(String).join(" ")); };
  try {
    return { port: bridgePortOrExit(raw), printed };
  } catch (e) {
    if (e !== exited) throw e;
    return { ...(code === undefined ? {} : { code }), printed };
  } finally {
    process.exit = realExit;
    console.error = realError;
  }
}

console.log("\nbridgePortOrExit (server-core's and the daemon's reader):");
{
  const good = runOrExit("8789");
  check("a valid value is returned, nothing printed, no exit", good.port === 8789 && good.code === undefined && good.printed.length === 0);
  const dflt = runOrExit(undefined);
  check("unset returns the default", dflt.port === ALLOWED_PORTS[0] && dflt.printed.length === 0);
  const bad = runOrExit("9999");
  check("an invalid value exits 1", bad.port === undefined && bad.code === 1);
  check("…after naming the value and the allowed ports on stderr",
    bad.printed.length === 1 && (bad.printed[0] ?? "").startsWith(`[bridge] FIGMA_BRIDGE_PORT=9999 is not one of ${ALLOWED_PORTS.join(", ")}. The Figma plugin may only open sockets`));
}

console.log("\ndoctor resolvePort reads the same parse:");
check("a padded allowed value is that port", resolvePort(" 8788").port === 8788);
check("a whitespace-only value is a failure, not the default", resolvePort(" ").problem?.status === "fail");
check("a non-numeric value is a failure naming it", /FIGMA_BRIDGE_PORT=abc is not one of/.test(resolvePort("abc").problem?.detail ?? ""));

console.log("\nthe daemon socket is named after the port server-core binds:");
{
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "dt-ports-"));
  try {
    const at = (env: NodeJS.ProcessEnv) => daemon.sockPath(undefined, { env, tmpdir: t, uid: undefined });
    check("unset: the default port's socket", at({}) === path.join(t, `designtwin-${ALLOWED_PORTS[0]}.sock`));
    check("a padded value names the same socket as the bare one", at({ FIGMA_BRIDGE_PORT: " 8788 " }) === path.join(t, "designtwin-8788.sock"));
    check("an explicit port wins over the env", daemon.sockPath(8789, { env: { FIGMA_BRIDGE_PORT: "8788" }, tmpdir: t, uid: undefined }) === path.join(t, "designtwin-8789.sock"));
    const realExit = process.exit;
    const realError = console.error;
    let code: number | undefined;
    const printed: string[] = [];
    const exited = new Error("exited");
    process.exit = (c?: number) => { code = c; throw exited; };
    console.error = (...a: unknown[]) => { printed.push(a.map(String).join(" ")); };
    let named: string | null = null;
    try { named = at({ FIGMA_BRIDGE_PORT: "9999" }); } catch (e) { if (e !== exited) throw e; } finally {
      process.exit = realExit;
      console.error = realError;
    }
    check("an invalid value exits 1 with server-core's message instead of naming designtwin-9999.sock",
      named === null && code === 1 && /^\[bridge\] FIGMA_BRIDGE_PORT=9999 is not one of/.test(printed[0] ?? ""));
    check("nothing was created in the socket directory", fs.readdirSync(t).length === 0);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
}

report();
