// Where the bridge token LIVES between runs — the one place that knows the path, the precedence,
// and the file's permissions.
//
// The token is not env-var-or-nothing: `server-core.ts` reads FIGMA_BRIDGE_TOKEN, and minting a fresh
// random one PER RUN and printing it would leave the plugin's saved token wrong on the very next `dtwin`,
// so the user would re-paste forever. The fix is not a better banner, it's persistence: generate once,
// store it, reuse it.
//
// Deliberately dependency-free. `env-paths` is the usual answer for per-OS config dirs, but the logic is
// ~15 lines, so it lives here rather than costing a dependency.
//
// Not a `.env` file either: a project-local `.env` would be the wrong CONVENTION — `.env` is for the
// secrets of the app you are building, not for a tool's own credential, and putting it in the repo makes "did we gitignore it" a permanent live footgun.
// Real CLIs (gh, wrangler, vercel) keep their own auth in a user config dir. So do we.
//
// Not the OS keychain either: keytar is archived, and its live replacements (@napi-rs/keyring,
// keyring-node) are native binaries with per-platform install friction. That is disproportionate for
// a loopback-only token that grants no authority beyond "drive a Figma plugin the same user already
// has open". The honest limit of the 0600 file, stated so it isn't a surprise: it stops OTHER users
// on the machine, not another process running as YOU.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { writeFileAtomic } from "./atomic-write.ts";

/** Where the token in play came from. "ephemeral" = minted for this run only, never stored. */
export type TokenSource = "token-file" | "env" | "file" | "ephemeral";

/** What resolve() returns. `path` is the file the token lives in (null for env/ephemeral). */
export interface ResolvedToken {
  token: string;
  source: TokenSource;
  path: string | null;
  /** true only on the run that minted AND stored a new token */
  created: boolean;
  /** why a minted token could not be stored (the result is then "ephemeral") */
  persistError?: unknown;
}

export interface ResolveOptions {
  tokenFile?: string | null;
  persist?: boolean;
}

/** What --token-status prints: everything about the token except the token. */
export interface TokenStatus {
  path: string;
  stored: boolean;
  envSet: boolean;
  activeSource: TokenSource;
  fingerprint: string | null;
  loosePerms: boolean;
  shadowed: boolean;
}

const APP = "design-twin";
const FILE = "bridge-token";

// 24 bytes = 192 bits from the OS CSPRNG, hex-encoded. Matches what server-core minted before.
export const generate = (): string => crypto.randomBytes(24).toString("hex");

// Per-OS config directory.
//
// macOS gets ~/.config, NOT ~/Library/Application Support: `gh` does the same, and the Apple location
// is really for plist-shaped data managed by `defaults`, not a hand-editable secret a user may well
// want to `cat`. Honouring XDG_CONFIG_HOME when it is set also gives the Linux-conventions-on-macOS
// crowd what they expect.
//
// DESIGNTWIN_CONFIG_DIR overrides everything — the tests need a config dir that is not the real
// user's, and a container/CI run may want one explicitly.
export function configDir(): string {
  const override = process.env.DESIGNTWIN_CONFIG_DIR;
  if (override && path.isAbsolute(override)) return override;

  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData && path.isAbsolute(appData)) return path.join(appData, APP);
    return path.join(os.homedir(), "AppData", "Roaming", APP);
  }
  // The XDG spec is explicit that a RELATIVE value here is invalid and must be ignored rather than
  // resolved against cwd — otherwise the token file's location would depend on where you ran dtwin.
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, APP);
  return path.join(os.homedir(), ".config", APP);
}

export const tokenPath = (): string => path.join(configDir(), FILE);

// A stable, non-secret way to say "the same token?" in logs, `--token-status`, and a 401 hint.
// Truncated SHA-256, never the token itself — the whole point of persisting is to stop printing it.
export const fingerprint = (tok: unknown): string | null => (tok ? crypto.createHash("sha256").update(String(tok)).digest("hex").slice(0, 8) : null);

// Read one token from a path. Trims: a token written with `echo tok > file` carries a trailing
// newline, which would otherwise fail the handshake with a "bad token" that looks nothing like the
// whitespace bug it is. Returns null for missing/empty/unreadable rather than throwing — every
// caller's next move is "fall through to the next source".
export function readFrom(file: string): string | null {
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    return raw || null;
  } catch (e) {
    return null;
  }
}

// Is the file readable by anyone but the owner? POSIX only: on Windows the mode bits are not
// meaningful (%APPDATA% is already per-user by ACL), so reporting on them would be a warning the
// user cannot act on.
export function loosePerms(file: string): boolean {
  if (process.platform === "win32") return false;
  try {
    return (fs.statSync(file).mode & 0o077) !== 0;
  } catch (e) {
    return false;
  }
}

// Write atomically, owner-only.
//
// tmp + rename (atomic-write.ts) because a token half-written by an interrupted run is worse than no token
// at all: it would fail every handshake with a 401 until someone thought to look at the file. The 0600 mode
// is set on the tmp file before the rename, so the token is never visible with wider permissions.
export function write(token: string, file: string = tokenPath()): string {
  const dir = path.dirname(file);
  // 0700: the XDG spec asks for exactly this when creating a config dir that does not exist.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(file, token + "\n", { mode: 0o600 });
  return file;
}

export function remove(file: string = tokenPath()): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (e) {
    return false; // already gone — `--forget-token` twice is not an error
  }
}

// THE precedence chain, in one place: explicit flag > environment > stored file > mint a new one.
//
// Order follows the usual CLI layering (flag beats env beats persisted config beats default). Env
// stays ABOVE the file so CI and one-off overrides keep working unchanged, and so anyone who already
// exported FIGMA_BRIDGE_TOKEN is unaffected by this file existing.
//
// Note there is deliberately no `--token <value>` flag anywhere in the CLI, only `--token-file`:
// process arguments are world-readable via `ps` / /proc/<pid>/cmdline, so a value flag would leak the
// secret to every other user on the machine.
//
// `persist: false` lets a caller ask "what WOULD be used" without creating a file as a side effect —
// which is what --token-status needs.
export function resolve({ tokenFile = null, persist = true }: ResolveOptions = {}): ResolvedToken {
  if (tokenFile) {
    const tok = readFrom(tokenFile);
    if (!tok) {
      const err: Error & { code?: string } = new Error(`--token-file ${tokenFile}: not readable, or empty.`);
      err.code = "TOKEN_FILE_UNREADABLE";
      throw err;
    }
    return { token: tok, source: "token-file", path: tokenFile, created: false };
  }

  const fromEnv = (process.env.FIGMA_BRIDGE_TOKEN || "").trim();
  if (fromEnv) return { token: fromEnv, source: "env", path: null, created: false };

  const file = tokenPath();
  const stored = readFrom(file);
  if (stored) return { token: stored, source: "file", path: file, created: false };

  const token = generate();
  if (!persist) return { token, source: "ephemeral", path: null, created: false };
  try {
    write(token, file);
    return { token, source: "file", path: file, created: true };
  } catch (e) {
    // Read-only filesystem, no HOME, a locked-down container. Falling back to a per-run token keeps
    // the bridge USABLE instead of failing to start over a convenience feature —
    // the caller reports why so it isn't a silent downgrade.
    return { token, source: "ephemeral", path: null, created: false, persistError: e };
  }
}

// What --token-status prints: everything about the token except the token.
export function status(): TokenStatus {
  const file = tokenPath();
  const stored = readFrom(file);
  const envTok = (process.env.FIGMA_BRIDGE_TOKEN || "").trim();
  const active = resolve({ persist: false });
  return {
    path: file,
    stored: !!stored,
    envSet: !!envTok,
    // Which source actually wins right now — the point of the whole command is that "there is a file"
    // and "the file is what the bridge uses" are different questions when the env var is also set.
    activeSource: active.source,
    // No fingerprint for an ephemeral token. `status()` resolves with persist:false, so the
    // "ephemeral" branch mints a THROWAWAY that nothing will ever use and that differs on every
    // call — printing its fingerprint invites the user to compare it against the plugin's, which is
    // exactly the wrong thing to do. A fingerprint is only meaningful for a token that persists.
    fingerprint: active.source === "ephemeral" ? null : fingerprint(active.token),
    loosePerms: stored ? loosePerms(file) : false,
    // A stored token that is being SHADOWED by a DIFFERENT env var value is the confusing case worth
    // naming — a project that always exports FIGMA_BRIDGE_TOKEN set to the SAME value as the saved
    // file has nothing to fix, and warning on every run just trains the user to ignore the note.
    shadowed: !!stored && !!envTok && stored !== envTok,
  };
}
