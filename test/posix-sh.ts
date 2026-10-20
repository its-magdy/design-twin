// The POSIX shell a printed command is run through, as the user's shell would run it: /bin/sh, or on Windows the `sh`
// on PATH — Git for Windows', whose Git Bash is where Claude Code's Bash tool runs commands there. null when Windows has
// no sh (Claude Code then runs PowerShell, which these POSIX-quoted round-trips do not model).
import { spawnSync } from "node:child_process";

export const POSIX_SH: string | null = process.platform !== "win32" ? "/bin/sh"
  : spawnSync("sh", ["-c", "exit 0"]).status === 0 ? "sh" : null;
