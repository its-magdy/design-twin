// hints.ts — the next-step sentences every front-end prints when the plugin is not there, not chosen, or refused,
// and the one way whoami says who holds the bridge.
//
// The CLI, the MCP server, doctor, init and the install step used to word these each their own way ("Open the file
// in Figma and run the plugin.", "run \"Design Twin\" (Plugins → Development)", the full menu path, …), and a fix to
// one wording (or to the menu path) had to be made by hand at every site. Each step is one sentence here; callers
// put it into their own message. A docs suite (test/hints-docs.test.ts) checks that the README, docs/setup.md and the
// help and extract skills quote PLUGIN_MENU, so the docs cannot drift from what the tools say either.
//
// Pure, and a leaf (only a type import): staleness.ts, doctor and init load it without loading the bridge.
import type { RouteConnection } from "./route.ts";

/** Where the plugin is in Figma's menus (a development plugin: imported from its manifest, Figma desktop only). */
export const PLUGIN_MENU = "Plugins → Development → Design Twin";

/** The step when no plugin is connected. Lower case, no full stop: it is put into the caller's sentence. */
export const runPlugin = `in Figma DESKTOP open the file and run ${PLUGIN_MENU}, and keep its window open`;

/** The step when several files are connected and a command did not say which. */
export const pickClient = "pass the connId, the fileKey or part of the file name (CLI: --client <id|name>; MCP: client: \"<id|name>\"); `dtwin list clients` lists them";

/** The step when the plugin's token is not the bridge's. */
export const pasteToken = "run `dtwin --show-token`, paste it into the plugin's \"Bridge token\" field (under \"Connect to Claude Code (optional)\"), and press Save";

/** `s` as a sentence of its own: capitalised, with a full stop. */
export function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

/** Who holds the bridge a whoami's socket half came from — the same words from the CLI and the MCP server. */
export function whoHolds({ connection, owner }: RouteConnection): string {
  if (owner.kind === "own") return "this process";
  const pid = `the daemon (pid ${owner.pid ?? "?"})`;
  return connection ? pid : `${pid}, too old to relay its socket stats`;
}
