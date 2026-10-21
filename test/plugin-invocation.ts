// How the plugin's hooks and skills run a bundled script (claude-plugin/scripts/<name>.js), as the suites check it.
//
// Under Bun every user-facing invocation is `bun --no-install --no-env-file <script>`: the script runs in the USER's
// project, where a bare `bun` would auto-install a package the project lacks from npm and load the project's .env into
// the tool's environment. A hook says it in exec form ({"command":"bun","args":[…]}: no shell, so Windows needs no sh) or
// as one shell string; a `node "<script>"` hook or doc line is refused — Node is not a supported runtime.
import { isJsonObject } from "../design-to-code/types.ts";

export const BUN_FLAGS: readonly string[] = ["--no-install", "--no-env-file"];
/** A regex source for the runner part of a documented command line. */
export const RUNNER_RE = String.raw`bun --no-install --no-env-file`;

const PLUGIN_SCRIPT = (name: string): RegExp => new RegExp(String.raw`^"?\$\{CLAUDE_PLUGIN_ROOT\}/scripts/${name.replace(/[.-]/g, "\\$&")}\.js"?$`);

/** Does the hook handler `h` run claude-plugin/scripts/<name>.js the way a user-facing invocation must? `form` says how. */
export function hookRunsScript(h: unknown, name: string): { ok: boolean; form: "exec" | "shell" | null } {
  if (!isJsonObject(h) || h.type !== "command" || typeof h.command !== "string") return { ok: false, form: null };
  const script = PLUGIN_SCRIPT(name);
  if (Array.isArray(h.args)) {
    const args = h.args.filter((a): a is string => typeof a === "string");
    const ok = /^bun(\.exe)?$/.test(h.command) && args.length === h.args.length && BUN_FLAGS.every((f) => args.indexOf(f) >= 0 && args.indexOf(f) < args.length - 1)
      && script.test(args[args.length - 1] ?? "");
    return { ok, form: "exec" };
  }
  const m = /^bun --no-install --no-env-file (.+)$/.exec(h.command);
  return m && script.test(m[1] ?? "") ? { ok: true, form: "shell" } : { ok: false, form: null };
}
