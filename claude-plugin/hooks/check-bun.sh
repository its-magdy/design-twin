#!/bin/sh
# SessionStart: is Bun >= 1.4.2 on the PATH Claude Code runs hooks with? The plugin's other hooks, its scripts, `dtwin`
# and the MCP server all run on Bun, so a session without it gets a notice now instead of an unexplained hook error at
# the first build or verify. It cannot itself be a Bun script — it is the check that Bun is there — so it is POSIX sh,
# which Claude Code runs through Git Bash on Windows. Silent (exit 0, nothing printed) when Bun is fine; otherwise one
# JSON object: systemMessage for the user, additionalContext so Claude knows why the designtwin tools will fail. It never
# exits non-zero: a SessionStart hook cannot block a session, and an error would hide the guidance.
MIN=1.4.2

# `bun --version` prints e.g. 1.4.3 or 1.4.3-canary.20261019.1; keep only characters that are safe inside a JSON string.
v=$(bun --version 2>/dev/null | head -n 1 | tr -cd '0-9A-Za-z.+-')

# 0 when version $1 >= $2, comparing major.minor.patch numerically (a pre-release suffix is ignored).
at_least() {
  a=${1%%[-+]*}
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
  return 0
}

if [ -n "$v" ]; then
  at_least "$v" "$MIN" && exit 0
  why="Bun $v is older than $MIN — run: bun upgrade"
elif [ -x "$HOME/.bun/bin/bun" ] || [ -f "$HOME/.bun/bin/bun.exe" ]; then
  why="Bun is installed in ~/.bun/bin but is not on the PATH Claude Code was started with — start Claude Code from a new terminal, or add ~/.bun/bin to the system PATH"
else
  why="bun is not on PATH — install it: curl -fsSL https://bun.sh/install | bash (macOS, Linux) or powershell -c \\\"irm bun.sh/install.ps1 | iex\\\" (Windows), see https://bun.sh/install"
fi

cat <<EOF
{"systemMessage": "Design Twin needs Bun >= $MIN: $why. Then restart Claude Code. Until then the designtwin skills' scripts, hooks and figma MCP server cannot run (Node is not supported).", "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "The designtwin plugin's scripts, hooks, dtwin CLI and figma MCP server run on Bun >= $MIN, which this machine lacks ($why). Before running any designtwin skill step that calls bun, tell the user to install or upgrade Bun from https://bun.sh/install and restart Claude Code; do not try to run the plugin scripts with node, and do not install Bun yourself."}}
EOF
exit 0
