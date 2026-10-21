#!/bin/sh
# SessionStart: is Bun >= 1.4.2 on the PATH Claude Code runs hooks with? The plugin's other hooks, its scripts, `dtwin`
# and the MCP server all run on Bun, so a session without it gets a notice now instead of an unexplained hook error at
# the first build or verify. It cannot itself be a Bun script — it is the check that Bun is there — so it is POSIX sh,
# which Claude Code runs through Git Bash on Windows (without Git Bash it runs in PowerShell, has no sh, and fails as a
# hook error: hooks.json says why there is no PowerShell twin). Silent (exit 0, nothing printed) when Bun is fine;
# otherwise one JSON object: systemMessage for the user, additionalContext so Claude knows why the designtwin tools will
# fail — and that the visual-verifier's PreToolUse guard, which needs Bun, cannot run (hooks.json: a guard that cannot
# run lets the call through rather than block every Bash/Write call of the session). It never exits non-zero: a
# SessionStart hook cannot block a session, and an error would hide the guidance.
# Matched on startup, resume, fork, clear and compact (hooks.json): after a clear or a compaction Claude has lost the
# earlier note, so it is said again.
MIN=1.4.2

# `bun --version` prints e.g. 1.4.3 or 1.4.3-canary.20261019.1; keep only characters that are safe inside a JSON string.
v=$(bun --version 2>/dev/null | head -n 1 | tr -cd '0-9A-Za-z.+-')

# 0 when version $1 >= $2, comparing major.minor.patch numerically. A pre-release ($1 with a -suffix, e.g. a canary) is
# OLDER than its own release (semver: 1.4.2-canary.5 < 1.4.2), so a canary of exactly the floor is below it; a
# pre-release of a later version (1.4.3-canary.1) is above it. Build metadata (+…) is ignored.
at_least() {
  a=${1%%[-+]*}
  pre=
  case ${1%%+*} in *-*) pre=1 ;; esac
  b=$2
  for _ in 1 2 3; do
    x=${a%%.*}; y=${b%%.*}
    case $x in '' | *[!0-9]*) x=0 ;; esac
    case $y in '' | *[!0-9]*) y=0 ;; esac
    [ "$x" -gt "$y" ] && return 0
    [ "$x" -lt "$y" ] && return 1
    case $a in *.*) a=${a#*.} ;; *) a=0 ;; esac
    case $b in *.*) b=${b#*.} ;; *) b=0 ;; esac
  done
  [ -z "$pre" ]
}

# How to upgrade the bun on PATH: each install method has its own (`bun upgrade` replaces only an official-installer
# binary — on a Homebrew or npm install it fights the package manager). Told by where the binary lives, or what its
# symlink points at (Homebrew's /usr/local/bin/bun → ../Cellar/…, npm's → ../lib/node_modules/bun/…).
upgrade_cmd() {
  p=$(command -v bun 2>/dev/null)
  t=$(readlink "$p" 2>/dev/null)
  case "$p $t" in
    */Cellar/* | */homebrew/* | */linuxbrew/*) echo "brew upgrade bun" ;;
    */node_modules/*) echo "npm install -g bun@latest" ;;
    */scoop/*) echo "scoop update bun" ;;
    *) echo "bun upgrade" ;;
  esac
}
ALL_WAYS="the official installer: bun upgrade; Homebrew: brew upgrade bun; npm: npm install -g bun@latest; Scoop: scoop update bun"

if [ -n "$v" ]; then
  at_least "$v" "$MIN" && exit 0
  why="Bun $v is older than $MIN — run: $(upgrade_cmd) (upgrade it the way it was installed — $ALL_WAYS)"
elif [ -x "$HOME/.bun/bin/bun" ] || [ -f "$HOME/.bun/bin/bun.exe" ]; then
  why="Bun is installed in ~/.bun/bin but is not on the PATH Claude Code was started with — start Claude Code from a new terminal, or add ~/.bun/bin to the system PATH"
else
  why="bun is not on PATH — install it: curl -fsSL https://bun.sh/install | bash (macOS, Linux) or powershell -c \\\"irm bun.sh/install.ps1 | iex\\\" (Windows), or brew install oven-sh/bun/bun, npm install -g bun, scoop install bun; see https://bun.sh/install"
fi

cat <<EOF
{"systemMessage": "Design Twin needs Bun >= $MIN: $why. Then restart Claude Code. Until then the designtwin skills' scripts, hooks and figma MCP server cannot run (Node is not supported) — and the visual-verifier's safety guard cannot run either, so its Bash/Write calls would go unchecked: do not run /designtwin:verify until Bun is in place.", "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "The designtwin plugin's scripts, hooks, dtwin CLI and figma MCP server run on Bun >= $MIN, which this machine lacks ($why). Before running any designtwin skill step that calls bun, tell the user to install or upgrade Bun from https://bun.sh/install and restart Claude Code; do not try to run the plugin scripts with node, and do not install Bun yourself. The visual-verifier's PreToolUse guard (verifier-guard.js) needs Bun too, so without it the verifier's calls are NOT guarded: do not start the designtwin:visual-verifier agent (or /designtwin:verify) until Bun works."}}
EOF
exit 0
