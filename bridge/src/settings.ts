// settings.ts — what a bridge process is configured with, resolved ONCE at its entry (the dtwin CLI, the MCP
// server, doctor) and passed down: into the bridge holder (bridge-holder.ts), the bridge itself (server-core.ts
// createBridge), the daemon socket it serves or looks up (daemon.ts), and nothing else reads the environment for
// these again. No load-time effects, and nothing here exits: a bad value is a result the entry decides about.
//
//   port         FIGMA_BRIDGE_PORT — one of the three the plugin can reach (ports.ts), else a problem.
//   token        the effective bridge token and its source, by token-store.ts's precedence (--token-file >
//                FIGMA_BRIDGE_TOKEN > the saved file > mint). Resolved without persisting: the bridge holder commits
//                it (commitToken) once, before it first binds — a minted one is saved then, and the notice printed.
//                A resolution that FAILS (an unreadable --token-file) is kept as that failure, not thrown: commands
//                that never open a bridge (--token-status) still run, which is exactly when you want to diagnose
//                it; the bridge or daemon that needs the token reports it.
//   maxPayload   FIGMA_BRIDGE_MAX_PAYLOAD_MB — the per-frame cap (maxPayloadFromEnv).
//   idleMs       FIGMA_DAEMON_IDLE_MIN — how long a shared bridge stays up with nothing using it (idleMsFromEnv).
//   ephemeralPort  DT_TEST_EPHEMERAL_PORT=1 — the TEST SEAM: bind an ephemeral port instead of `port` (server-core).
//
// --token-file used to reach server-core by being written into process.env before a dynamic import, because the
// token was resolved at that module's load. It is now an argument here.
import * as tokenStore from "./token-store.ts";
import type { ResolvedToken } from "./token-store.ts";
import { parsePortEnv, portProblem } from "./ports.ts";
import type { SockPlace } from "./daemon.ts";

/** The effective token, or why none could be resolved. */
export type TokenSetting = { ok: true; resolved: ResolvedToken } | { ok: false; error: unknown };

export interface MaxPayload { mb: number; bytes: number; warning?: string }

export interface BridgeSettings {
  readonly port: number;
  readonly token: TokenSetting;
  readonly maxPayload: MaxPayload;
  readonly idleMs: number;
  /** FIGMA_DAEMON_IDLE_MIN as given (undefined when unset), for a message that says why the window is off */
  readonly idleRaw: string | undefined;
  readonly ephemeralPort: boolean;
}

export interface SettingsInput {
  /** the environment to read (defaults to process.env). token-store itself reads FIGMA_BRIDGE_TOKEN and the saved
   *  file's location from process.env, so only FIGMA_BRIDGE_TOKEN_FILE of the token's inputs comes from here. */
  env?: NodeJS.ProcessEnv;
  /** `--token-file` (wins over FIGMA_BRIDGE_TOKEN_FILE in `env`) */
  tokenFile?: string | null;
}

export type SettingsResult = { ok: true; settings: BridgeSettings } | { ok: false; problem: string };

/** Every setting, or the one problem that leaves a bridge here nothing to do (a port no plugin can reach). */
export function readSettings({ env = process.env, tokenFile }: SettingsInput = {}): SettingsResult {
  const p = parsePortEnv(env.FIGMA_BRIDGE_PORT);
  if (p.port === undefined) return { ok: false, problem: portProblem(p.invalid) };
  return {
    ok: true,
    settings: {
      port: p.port,
      token: tokenSetting({ env, ...(tokenFile !== undefined ? { tokenFile } : {}) }),
      maxPayload: maxPayloadFromEnv(env.FIGMA_BRIDGE_MAX_PAYLOAD_MB),
      idleMs: idleMsFromEnv(env),
      idleRaw: env.FIGMA_DAEMON_IDLE_MIN,
      ephemeralPort: env.DT_TEST_EPHEMERAL_PORT === "1",
    },
  };
}

/** THE token resolution every caller goes through: `tokenFile` (the flag) or FIGMA_BRIDGE_TOKEN_FILE, then
 *  token-store's precedence. Never persists, never throws. */
export function tokenSetting({ env = process.env, tokenFile }: SettingsInput = {}): TokenSetting {
  const file = tokenFile ?? (env.FIGMA_BRIDGE_TOKEN_FILE || null);
  try {
    return { ok: true, resolved: tokenStore.resolve({ tokenFile: file, persist: false }) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/** What committing the settings' token on first use did (token-store.ts commit): the settings as every later bridge
 *  and daemon lookup of this process should see them, and the lines to tell the user. */
export interface TokenCommit {
  readonly settings: BridgeSettings;
  readonly minted: boolean;
  readonly saveFailed: boolean;
  readonly notice: readonly string[];
}

/** Commit the token before a bridge first uses it: save a minted one, and say which token is in play (printing it
 *  only on the commit that mints it). A resolution that failed commits nothing — the bridge reports it. */
export function commitToken(s: BridgeSettings): TokenCommit {
  if (!s.token.ok) return { settings: s, minted: false, saveFailed: false, notice: [] };
  const c = tokenStore.commit(s.token.resolved);
  return { settings: { ...s, token: { ok: true, resolved: c.resolved } }, minted: c.minted, saveFailed: c.saveFailed, notice: c.notice };
}

/** The token a daemon's pipe is named from and its handshake keys on: the effective one — except a token nothing
 *  saved yet (no daemon anyone could have started under it: a bridge commits the token it mints before it serves) and
 *  a resolution that failed, both null. */
export function daemonTokenOf(t: TokenSetting): string | null {
  return t.ok && t.resolved.source !== "ephemeral" ? t.resolved.token : null;
}

/** Where this process's daemon socket is looked up or served: the port and the token it is keyed on. */
export function daemonPlace(s: BridgeSettings): { port: number; place: SockPlace } {
  return { port: s.port, place: { token: daemonTokenOf(s.token) } };
}

/** Does something other than the saved token file decide the token (FIGMA_BRIDGE_TOKEN or a token file)? Then
 *  replacing or deleting the saved file changes nothing for a running bridge. */
export function tokenOverridden(t: TokenSetting): boolean {
  return t.ok ? t.resolved.source === "env" || t.resolved.source === "token-file" : true;
}

const DEFAULT_MAX_PAYLOAD_MB = 128;
const MiB = 1024 * 1024;
/** The bridge's per-frame cap from FIGMA_BRIDGE_MAX_PAYLOAD_MB. It bounds a single frame so a malformed/huge payload can't
 *  OOM the process; 128 MB is ~2x a realistic asset-heavy full export, and an unusually large file can raise it. Bun.serve
 *  takes it as `maxPayloadLength`, an unsigned 32-bit byte count, so a value past 4096 MB is clamped to just under 4 GiB
 *  and `mb` says so (the too-big diagnosis quotes it — the cap in force, not the number typed).
 *  A value that is not a finite number above 0 falls back to the default, with a `warning`: `ws` read 0 (and below) as
 *  "unlimited", but Bun.serve has no unlimited — 0 there refuses every non-empty frame — and a typo must not become either one. */
export function maxPayloadFromEnv(raw: string | undefined): MaxPayload {
  const v = (raw ?? "").trim();
  if (v === "") return { mb: DEFAULT_MAX_PAYLOAD_MB, bytes: DEFAULT_MAX_PAYLOAD_MB * MiB };
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    return { mb: DEFAULT_MAX_PAYLOAD_MB, bytes: DEFAULT_MAX_PAYLOAD_MB * MiB, warning: `FIGMA_BRIDGE_MAX_PAYLOAD_MB=${JSON.stringify(raw)} is not a number of megabytes above 0 — using the default ${DEFAULT_MAX_PAYLOAD_MB} MB (there is no "unlimited")` };
  }
  const bytes = Math.max(1, Math.min(Math.floor(n * MiB), 0xffffffff));
  return { mb: Math.round((bytes / MiB) * 100) / 100, bytes };
}

/** The idle window a shared bridge uses: FIGMA_DAEMON_IDLE_MIN minutes (default 120), in ms. 0 — and an unparsable
 *  value, as it always was — disables the idle shutdown. */
export function idleMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return minutesToMs(env.FIGMA_DAEMON_IDLE_MIN ?? 120);
}
export const minutesToMs = (min: unknown): number => Math.max(0, Number(min)) * 60000 || 0;

/** An idle window for a log line: whole minutes from one minute up, else whole seconds. */
export function humanMs(ms: number): string {
  return ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)}s`;
}
