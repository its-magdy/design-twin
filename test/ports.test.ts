// FIGMA_BRIDGE_PORT parsing (bridge/src/ports.ts) as pure functions, and what reads it: settings.ts readSettings
// (portProblem), doctor's resolvePort, and the daemon's socket or pipe name — named from the settings' port.
//   bun test/ports.test.ts
// No bridge, no port, no socket: the daemon address is only computed (no uid, so the directory is the temp dir
// itself and nothing is created).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, report } from "./assert.ts";
import { ALLOWED_PORTS, parsePortEnv } from "../bridge/src/ports.ts";
import { resolvePort } from "../bridge/src/doctor.ts";
import { daemonAddressOf, readSettings } from "../bridge/src/settings.ts";
import { pipeName } from "../bridge/src/daemon-auth.ts";

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

console.log("\nALLOWED_PORTS:");
{
  // The plugin may only open sockets to ports its manifest names, so the bridge's list is that list.
  const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "figma-plugin", "manifest.json"), "utf8")) as { networkAccess: { allowedDomains: string[]; devAllowedDomains: string[] } };
  const ports = (domains: string[]): string => domains.map((d) => /^ws:\/\/localhost:(\d+)$/.exec(d)?.[1]).join(",");
  check("the bridge's ports are exactly the plugin manifest's (allowed and dev-allowed)",
    ALLOWED_PORTS.join(",") === "8787,8788,8789" && ports(manifest.networkAccess.allowedDomains) === ALLOWED_PORTS.join(",")
    && ports(manifest.networkAccess.devAllowedDomains) === ALLOWED_PORTS.join(","));
}

console.log("\nparsePortEnv:");
check("unset selects the first allowed port", same(parsePortEnv(undefined), { port: ALLOWED_PORTS[0] }));
check("empty selects the first allowed port", same(parsePortEnv(""), { port: ALLOWED_PORTS[0] }));
check("each allowed port is kept", ALLOWED_PORTS.every((p) => same(parsePortEnv(String(p)), { port: p })));
check("a port outside the three is invalid, carrying the raw value", same(parsePortEnv("9999"), { invalid: "9999" }) && same(parsePortEnv("8786"), { invalid: "8786" }));
check("0 is invalid", same(parsePortEnv("0"), { invalid: "0" }));
check("a non-numeric value is invalid", same(parsePortEnv("abc"), { invalid: "abc" }) && same(parsePortEnv("8788x"), { invalid: "8788x" }));
check("a whitespace-only value is invalid (Number(\" \") is 0), not the default", same(parsePortEnv(" "), { invalid: " " }));
check("surrounding whitespace is ignored", same(parsePortEnv(" 8788 "), { port: 8788 }) && same(parsePortEnv("8789\n"), { port: 8789 }));

console.log("\ndoctor resolvePort reads the same parse:");
check("a padded allowed value is that port", resolvePort(" 8788").port === 8788);
check("a whitespace-only value is a failure, not the default", resolvePort(" ").problem?.status === "fail");
check("a non-numeric value is a failure naming it", /FIGMA_BRIDGE_PORT=abc is not one of/.test(resolvePort("abc").problem?.detail ?? ""));

console.log("\nthe daemon socket is named after the port the settings carry:");
{
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "dt-ports-"));
  try {
    // platform pinned and no uid: these are the POSIX socket's names on every host, computed — nothing is created.
    const host = { platform: "linux" as const, uid: undefined, tmpdir: t };
    const at = (env: NodeJS.ProcessEnv, port?: number): string | null => {
      const r = readSettings({ env });
      if (!r.ok) return null;
      const a = daemonAddressOf(r.settings, port ?? r.settings.port, host);
      return a.ok ? a.sock : null;
    };
    check("unset: the default port's socket", at({}) === path.join(t, `designtwin-${ALLOWED_PORTS[0]}.sock`));
    check("a padded value names the same socket as the bare one", at({ FIGMA_BRIDGE_PORT: " 8788 " }) === path.join(t, "designtwin-8788.sock"));
    check("an explicit port wins over the settings' (dtwin --rotate-token looks at all three)", at({ FIGMA_BRIDGE_PORT: "8788" }, 8789) === path.join(t, "designtwin-8789.sock"));
    check("an invalid value is the settings' problem: no address is ever named for it", at({ FIGMA_BRIDGE_PORT: "9999" }) === null);
    check("nothing was created in the socket directory", fs.readdirSync(t).length === 0);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
}

console.log("\non win32 the daemon is a pipe named after the same port (and the token):");
{
  const host = { platform: "win32" as const, uid: undefined, tmpdir: os.tmpdir() };
  const pipe = (env: NodeJS.ProcessEnv, port?: number): string | null => {
    const r = readSettings({ env });
    if (!r.ok) return null;
    const a = daemonAddressOf({ ...r.settings, token: { ok: true, resolved: { token: "tok", source: "env", path: null, created: false } } }, port ?? r.settings.port, host);
    return a.ok ? a.sock : null;
  };
  check("unset: the default port's pipe", pipe({}) === pipeName("tok", ALLOWED_PORTS[0]));
  check("a padded value names the same pipe as the bare one", pipe({ FIGMA_BRIDGE_PORT: " 8788 " }) === pipeName("tok", 8788));
  check("an explicit port wins over the settings'", pipe({ FIGMA_BRIDGE_PORT: "8788" }, 8789) === pipeName("tok", 8789));
  check("…and two ports are two pipes", pipeName("tok", 8788) !== pipeName("tok", 8789));
  check("an invalid value names no pipe", pipe({ FIGMA_BRIDGE_PORT: "9999" }) === null);
}

report();
