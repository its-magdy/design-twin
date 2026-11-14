# Security policy

## Supported versions

Only the latest release is supported: `@design-twin/dtwin` on npm (published from a `v*` tag with npm provenance) and
the Homebrew formula (`its-magdy/tap/dtwin`), which follows it. Security fixes land on `main` and ship in the next
release; upgrade with `bun add -g @design-twin/dtwin@latest` or `brew upgrade dtwin`.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub:
**Security → Report a vulnerability** on this repository
([private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).

Include what you found, the steps or a proof of concept, the affected piece (Figma plugin, `dtwin` CLI, MCP
server, daemon, or the Claude Code plugin) and the version (`dtwin --version`) or commit you tested. This is a one-maintainer project: reports are
handled on a best-effort basis, and you will be credited in the advisory unless you ask not to be.

## What is in scope

The security model is described in [ARCHITECTURE.md](ARCHITECTURE.md#security-posture). Reports that break one of
its guarantees are especially welcome, for example:

- the Figma plugin reaching anything other than `ws://localhost` (its manifest allows only ports 8787–8789);
- a connection to the bridge succeeding without the bridge token, or from a foreign origin;
- the daemon socket being reachable by another user;
- design content (layer names, text, annotations) being followed as instructions by the skills or tools;
- a write to the Figma file through any path other than the MCP server's opt-in `figma_write`, or any write applied
  while the plugin's **Allow edits** checkbox is off, or with **Review each write** on but without the designer's
  Apply;
- the plugin running anything a write sent as code (every write is a row of a fixed, typed op table);
- a `move` or `delete` of a node the plugin session did not create (other than a keyed re-send removing nodes of its
  own earlier result), or a source edit (`setVariable`, `setStyle`, a `patch` of a main component) changing a
  variable, style or component that lives in another library file (a `createVariables` / `createStyles` table matches
  only this file's own collections and styles by name, and makes a local one beside a library's);
- a `treeFile` spec read from outside the directory the MCP server runs in.

Out of scope: a malicious process already running as your user (it can read the token file), and issues in Figma,
Claude Code or other third-party tools themselves — report those to their vendors.
