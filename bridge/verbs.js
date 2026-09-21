// verbs.js — `dtwin <verb>` front door. A PURE argv → argv translation onto the flags figma-pull.js
// already parses, so there is one parser and one set of guards, and every existing `--flag`
// invocation keeps working unchanged (clig.dev: subcommands to tame a large surface; never break the
// old spelling silently).
//
//   dtwin pull [outDir] [flags]      = dtwin [outDir] [flags]
//   dtwin list [pages|libraries|clients]   = --list | --list-pages | --list-libraries | --list-clients
//   dtwin list children <id|url>     = --children <id|url>
//   dtwin whoami                     = --whoami
//   dtwin screenshot <id|url>        = --screenshot <id|url>
//   dtwin serve | stop | status      = --serve | --stop | --daemon-status
//   dtwin token [status|show|rotate|forget]  = --token-status | --show-token | --rotate-token | --forget-token
//   dtwin help                       = --help
//   dtwin doctor | init | mcp        → their own entry points (routed in figma-pull.js)
//
// A verb is only recognised as the FIRST argument. `dtwin design` still means "pull into ./design":
// an outDir that happens to be spelled like a verb is written `dtwin pull list` or `dtwin ./list`.

class VerbError extends Error {}

const LIST = { "": "--list", frames: "--list", pages: "--list-pages", libraries: "--list-libraries", libs: "--list-libraries", clients: "--list-clients" };
const TOKEN = { "": "--token-status", status: "--token-status", show: "--show-token", rotate: "--rotate-token", forget: "--forget-token" };
const SIMPLE = { whoami: "--whoami", serve: "--serve", stop: "--stop", status: "--daemon-status", help: "--help" };
const VERBS = ["pull", "list", "whoami", "screenshot", "serve", "stop", "status", "token", "doctor", "init", "mcp", "help"];

const isFlag = (a) => typeof a === "string" && a.startsWith("-");

function translate(argv) {
  const [verb, ...rest] = argv;
  if (!verb || isFlag(verb)) return argv;
  if (verb === "pull") return rest;
  if (SIMPLE[verb]) return [SIMPLE[verb], ...rest];
  if (verb === "list") {
    const sub = rest[0] && !isFlag(rest[0]) ? rest[0] : "";
    if (sub === "children") {
      if (!rest[1] || isFlag(rest[1])) throw new VerbError("dtwin list children needs a node id or a Figma URL (ids come from `dtwin list`)");
      return ["--children", rest[1], ...rest.slice(2)];
    }
    if (!(sub in LIST)) throw new VerbError(`unknown \`dtwin list ${sub}\` — use: dtwin list [pages|libraries|clients], or dtwin list children <id>`);
    return [LIST[sub], ...rest.slice(sub ? 1 : 0)];
  }
  if (verb === "token") {
    const sub = rest[0] && !isFlag(rest[0]) ? rest[0] : "";
    if (!(sub in TOKEN)) throw new VerbError(`unknown \`dtwin token ${sub}\` — use: dtwin token [status|show|rotate|forget]`);
    return [TOKEN[sub], ...rest.slice(sub ? 1 : 0)];
  }
  if (verb === "screenshot") {
    if (!rest[0] || isFlag(rest[0])) throw new VerbError("dtwin screenshot needs a node id or a Figma URL");
    // `dtwin screenshot <id> [outDir] [flags]` — the id is the flag's value, the rest passes through.
    return ["--screenshot", rest[0], ...rest.slice(1)];
  }
  return argv; // not a verb: a positional outDir, exactly as before
}

module.exports = { translate, VerbError, VERBS };
