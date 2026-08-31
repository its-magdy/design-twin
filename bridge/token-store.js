// Where the bridge token LIVES between runs — the one place that knows the path, the precedence,
// and the file's permissions.
//
// Before this file the token was env-var-or-nothing: `server-core.js` read FIGMA_BRIDGE_TOKEN and
// otherwise minted a fresh random one PER RUN and printed it, so the plugin's saved token was wrong
// on the very next `dtwin` and the user re-pasted forever. The fix is not a better banner, it's
// persistence: generate once, store it, reuse it.
//
// Deliberately dependency-free. `env-paths` is the usual answer for per-OS config dirs, but v4 is
// ESM-only and needs Node >= 20 while this package is `"type": "commonjs"` with `engines: >=18`;
// v2 is CJS but stale. The logic is ~15 lines, so it lives here rather than costing a dependency
// (and an ESM/CJS interop problem) to import.
//
// Not a `.env` file, for the same reason plus one more: `--env-file` is Node >= 20.6 and
// `--env-file-if-exists` >= 22.9, both above this package's floor. A project-local `.env` would also
// be the wrong CONVENTION — `.env` is for the secrets of the app you are building, not for a tool's
// own credential, and putting it in the repo makes "did we gitignore it" a permanent live footgun.
// Real CLIs (gh, wrangler, vercel) keep their own auth in a user config dir. So do we.
//
// Not the OS keychain either: keytar is archived, and its live replacements (@napi-rs/keyring,
// keyring-node) are native binaries with per-platform install friction. That is disproportionate for
// a loopback-only token that grants no authority beyond "drive a Figma plugin the same user already
// has open". The honest limit of the 0600 file, stated so it isn't a surprise: it stops OTHER users
// on the machine, not another process running as YOU.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const APP = "design-twin";
const FILE = "bridge-token";

// 24 bytes = 192 bits from the OS CSPRNG, hex-encoded. Matches what server-core minted before.
const generate = () => crypto.randomBytes(24).toString("hex");

// Per-OS config directory.
//
// macOS gets ~/.config, NOT ~/Library/Application Support: `gh` does the same, and the Apple location
// is really for plist-shaped data managed by `defaults`, not a hand-editable secret a user may well
// want to `cat`. Honouring XDG_CONFIG_HOME when it is set also gives the Linux-conventions-on-macOS
// crowd what they expect.
//
// DESIGNTWIN_CONFIG_DIR overrides everything — the tests need a config dir that is not the real
// user's, and a container/CI run may want one explicitly.
function configDir() {
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

const tokenPath = () => path.join(configDir(), FILE);

// A stable, non-secret way to say "the same token?" in logs, `--token-status`, and a 401 hint.
// Truncated SHA-256, never the token itself — the whole point of persisting is to stop printing it.
const fingerprint = (tok) => (tok ? crypto.createHash("sha256").update(String(tok)).digest("hex").slice(0, 8) : null);

// Read one token from a path. Trims: a token written with `echo tok > file` carries a trailing
// newline, which would otherwise fail the handshake with a "bad token" that looks nothing like the
// whitespace bug it is. Returns null for missing/empty/unreadable rather than throwing — every
// caller's next move is "fall through to the next source".
function readFrom(file) {
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
function loosePerms(file) {
  if (process.platform === "win32") return false;
  try {
    return (fs.statSync(file).mode & 0o077) !== 0;
  } catch (e) {
    return false;
  }
}

// Write atomically, owner-only.
//
// tmp + rename because a token half-written by an interrupted run is worse than no token at all: it
// would fail every handshake with a 401 until someone thought to look at the file.
//
// mode is passed to writeFileSync AND re-applied with chmod because the open(2) mode is masked by
// the process umask — a umask of 0 would otherwise leave it 0666. Belt and braces on a one-line cost.
function write(token, file = tokenPath()) {
  const dir = path.dirname(file);
  // 0700: the XDG spec asks for exactly this when creating a config dir that does not exist.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, token + "\n", { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch (e) {}
  fs.renameSync(tmp, file);
  return file;
}

function remove(file = tokenPath()) {
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
function resolve({ tokenFile = null, persist = true } = {}) {
  if (tokenFile) {
    const tok = readFrom(tokenFile);
    if (!tok) {
      const err = new Error(`--token-file ${tokenFile}: not readable, or empty.`);
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
    // the bridge USABLE (the old behaviour) instead of failing to start over a convenience feature —
    // the caller reports why so it isn't a silent downgrade.
    return { token, source: "ephemeral", path: null, created: false, persistError: e };
  }
}

// What --token-status prints: everything about the token except the token.
function status() {
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
    // A stored token that is being SHADOWED by the env var is the confusing case worth naming.
    shadowed: !!stored && !!envTok,
  };
}

module.exports = { configDir, tokenPath, resolve, write, remove, readFrom, generate, fingerprint, status, loosePerms };
