// What a bridge process is configured with (bridge/src/settings.ts), read once at its entry: the port, the effective
// token and its source, the payload cap and the idle window — as values, never an exit. And server-core, which used
// to resolve the token and read the port at load, can now be loaded under any environment.
//   bun test/settings.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { check, report } from "./assert.ts";
import { bunSync } from "./children.ts";
import {
  commitToken, daemonAddressOf, daemonTokenOf, humanMs, idleMsFromEnv, readSettings, tokenOverridden, tokenSetting,
} from "../bridge/src/settings.ts";
import { fingerprint } from "../bridge/src/token-store.ts";
import { pipeName } from "../bridge/src/daemon-auth.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-settings-"));
// token-store reads FIGMA_BRIDGE_TOKEN and the saved file's place from process.env: an empty config dir, no env token.
process.env.DESIGNTWIN_CONFIG_DIR = dir;
delete process.env.FIGMA_BRIDGE_TOKEN;
delete process.env.FIGMA_BRIDGE_TOKEN_FILE;

console.log("\nport:");
{
  const bad = readSettings({ env: { FIGMA_BRIDGE_PORT: "9999" } });
  check("a port no plugin can reach is a problem to report, not an exit", !bad.ok && bad.problem.includes("9999"));
  const r = readSettings({ env: { FIGMA_BRIDGE_PORT: " 8788" } });
  check("one of the three is taken as parsed", r.ok && r.settings.port === 8788);
  const d = readSettings({ env: {} });
  check("unset is the first", d.ok && d.settings.port === 8787);
}

console.log("\ntoken:");
{
  const minted = tokenSetting({ env: {} });
  check("nothing saved → a token that would be minted, reported as ephemeral; nothing written (no persist)",
    minted.ok && minted.resolved.source === "ephemeral" && !fs.existsSync(path.join(dir, "bridge-token")));
  check("…which keys no daemon (nobody can have started one under it)", daemonTokenOf(minted) === null);

  const envFile = path.join(dir, "env-token");
  const flagFile = path.join(dir, "flag-token");
  fs.writeFileSync(envFile, "from-env-file\n");
  fs.writeFileSync(flagFile, "from-flag\n");
  const viaEnv = tokenSetting({ env: { FIGMA_BRIDGE_TOKEN_FILE: envFile } });
  check("FIGMA_BRIDGE_TOKEN_FILE is read", viaEnv.ok && viaEnv.resolved.token === "from-env-file" && viaEnv.resolved.source === "token-file");
  const viaFlag = tokenSetting({ env: { FIGMA_BRIDGE_TOKEN_FILE: envFile }, tokenFile: flagFile });
  check("--token-file wins over FIGMA_BRIDGE_TOKEN_FILE", viaFlag.ok && viaFlag.resolved.token === "from-flag");
  check("a token file overrides the saved one; so does FIGMA_BRIDGE_TOKEN", tokenOverridden(viaFlag));

  const missing = tokenSetting({ tokenFile: path.join(dir, "nope") });
  check("an unreadable --token-file is kept as a failure, not thrown", !missing.ok && String(missing.error).includes("not readable"));
  check("…keys no daemon, and counts as overridden", daemonTokenOf(missing) === null && tokenOverridden(missing));
  const s = readSettings({ env: {}, tokenFile: path.join(dir, "nope") });
  check("…and readSettings still answers (commands that never open a bridge run on)", s.ok && !s.settings.token.ok);

  process.env.FIGMA_BRIDGE_TOKEN = "env-tok";
  const env = readSettings({ env: { FIGMA_BRIDGE_PORT: "8789" } });
  check("FIGMA_BRIDGE_TOKEN is the effective token; the daemon is looked up at this port, keyed on it",
    env.ok && env.settings.token.ok && env.settings.token.resolved.source === "env" &&
    ((a) => a.ok && a.port === 8789 && a.sock === pipeName("env-tok", 8789))(daemonAddressOf(env.settings, undefined, { platform: "win32", uid: undefined, tmpdir: dir })));
  delete process.env.FIGMA_BRIDGE_TOKEN;
}

console.log("\ncommitting the token on first use:");
{
  const saved = path.join(dir, "bridge-token");
  const first = readSettings({ env: {} });
  if (!first.ok) throw new Error("readSettings");
  const minted = first.settings.token.ok ? first.settings.token.resolved.token : "";
  const c = commitToken(first.settings);
  check("nothing saved → the commit mints it and SAVES it, reporting minted (and not save-failed)",
    c.minted && !c.saveFailed && fs.existsSync(saved) && fs.readFileSync(saved, "utf8").trim() === minted && minted.length === 48);
  check("…the committed settings carry it as the saved file's, so it keys the daemon from here on",
    c.settings.token.ok && c.settings.token.resolved.source === "file" && c.settings.token.resolved.path === saved && daemonTokenOf(c.settings.token) === minted);
  check("…and the notice prints it once, to paste into the plugin, and says it was saved",
    c.notice.filter((l) => l.includes(minted)).length === 1 && c.notice.some((l) => /saved to .*won't be asked to paste it again/.test(l)));
  const again = commitToken(c.settings);
  check("committing what a commit returned saves nothing new and never reprints the secret",
    !again.minted && !again.saveFailed && fs.readFileSync(saved, "utf8").trim() === minted && !again.notice.some((l) => l.includes(minted)));
  const next = readSettings({ env: {} });
  const second = next.ok ? commitToken(next.settings) : null;
  check("a SECOND run reuses the saved token instead of minting, and names it by fingerprint, not the secret",
    second !== null && !second.minted && second.settings.token.ok && second.settings.token.resolved.token === minted &&
    !second.notice.some((l) => l.includes(minted)) && second.notice.some((l) => l.includes(String(fingerprint(minted)))));
  fs.chmodSync(saved, 0o644);
  const loose = next.ok ? commitToken(next.settings) : null;
  check("a saved token readable by other users gets the chmod warning",
    process.platform === "win32" || (loose !== null && loose.notice.some((l) => /readable by other users — chmod 600/.test(l))));
  fs.rmSync(saved);

  // An unwritable config dir (no HOME, a read-only FS): the place a directory should be is a file.
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "");
  process.env.DESIGNTWIN_CONFIG_DIR = path.join(blocker, "config");
  const ro = readSettings({ env: {} });
  const failed = ro.ok ? commitToken(ro.settings) : null;
  check("an unwritable config dir: the minted token is still used — save-failed, kept ephemeral, keying no daemon",
    failed !== null && failed.minted && failed.saveFailed && failed.settings.token.ok &&
    failed.settings.token.resolved.source === "ephemeral" && daemonTokenOf(failed.settings.token) === null);
  const failedTok = failed?.settings.token.ok ? failed.settings.token.resolved.token : "?";
  check("…printed once to paste, with why it could not be saved and the stable alternative",
    failed !== null && failed.notice.filter((l) => l.includes(failedTok)).length === 1 &&
    failed.notice.some((l) => /could not save it \(.+\) — it changes every run\. Set FIGMA_BRIDGE_TOKEN/.test(l)));
  const retried = failed ? commitToken(failed.settings) : null;
  check("…and committing it again neither retries the save nor reprints it",
    retried !== null && !retried.minted && !retried.saveFailed && !retried.notice.some((l) => l.includes(failedTok)));
  process.env.DESIGNTWIN_CONFIG_DIR = dir;

  process.env.FIGMA_BRIDGE_TOKEN = "env-tok";
  const env = readSettings({ env: {} });
  const viaEnv = env.ok ? commitToken(env.settings) : null;
  check("FIGMA_BRIDGE_TOKEN: nothing saved, the notice names the variable and its fingerprint",
    viaEnv !== null && !viaEnv.minted && !fs.existsSync(saved) && viaEnv.notice.length === 1 &&
    viaEnv.notice[0] === `auth: using FIGMA_BRIDGE_TOKEN from the environment (${fingerprint("env-tok")}).`);
  delete process.env.FIGMA_BRIDGE_TOKEN;

  const bad = readSettings({ env: {}, tokenFile: path.join(dir, "nope") });
  const badCommit = bad.ok ? commitToken(bad.settings) : null;
  check("a resolution that failed commits nothing: no file, no notice, the failure kept for the bridge to report",
    badCommit !== null && !badCommit.minted && badCommit.notice.length === 0 && !badCommit.settings.token.ok && !fs.existsSync(saved));
}

console.log("\nlimits:");
{
  check("idleMsFromEnv: default 120 min, 0 and an unparsable value disable it, 0.5 → 30 s",
    idleMsFromEnv({}) === 7200000 && idleMsFromEnv({ FIGMA_DAEMON_IDLE_MIN: "0" }) === 0 &&
    idleMsFromEnv({ FIGMA_DAEMON_IDLE_MIN: "soon" }) === 0 && idleMsFromEnv({ FIGMA_DAEMON_IDLE_MIN: "0.5" }) === 30000);
  check("humanMs: 2 h → \"120 min\", 1.2 s → \"1s\"", humanMs(7200000) === "120 min" && humanMs(1200) === "1s");
  const r = readSettings({ env: { FIGMA_DAEMON_IDLE_MIN: "soon", FIGMA_BRIDGE_MAX_PAYLOAD_MB: "64", DT_TEST_EPHEMERAL_PORT: "1" } });
  check("readSettings carries the idle window (and its raw value), the payload cap and the test seam",
    r.ok && r.settings.idleMs === 0 && r.settings.idleRaw === "soon" && r.settings.maxPayload.mb === 64 && r.settings.ephemeralPort);
  const x = readSettings({ env: { XDG_RUNTIME_DIR: "/run/user/1000" } });
  check("readSettings carries XDG_RUNTIME_DIR, the one place the daemon's socket directory is read from the environment",
    x.ok && x.settings.runtimeDir === "/run/user/1000");
}

console.log("\nno load-time effects:");
{
  const core = pathToFileURL(path.resolve(import.meta.dirname, "../bridge/src/server-core.ts")).href;
  const env: Record<string, string | undefined> = { ...process.env, FIGMA_BRIDGE_PORT: "9999", DESIGNTWIN_CONFIG_DIR: dir };
  delete env.FIGMA_BRIDGE_TOKEN;
  const r = bunSync(["-e", `await import(${JSON.stringify(core)}); console.log("loaded");`], { env, timeoutMs: 10000 });
  check("server-core loads under a bad FIGMA_BRIDGE_PORT and with no token saved: no exit, no token minted",
    r.status === 0 && r.stdout.trim() === "loaded" && !fs.existsSync(path.join(dir, "bridge-token")));
}

fs.rmSync(dir, { recursive: true, force: true });
report();
