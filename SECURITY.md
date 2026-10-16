# Security policy

## Supported versions

Design Twin is not published to a package registry yet. Security fixes land on `main`; use the latest commit.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub:
**Security → Report a vulnerability** on this repository
([private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).

Include what you found, the steps or a proof of concept, the affected piece (Figma plugin, `dtwin` CLI, MCP
server, daemon, or the Claude Code plugin) and the commit you tested. This is a one-maintainer project: reports are
handled on a best-effort basis, and you will be credited in the advisory unless you ask not to be.

## What is in scope

The security model is described in [ARCHITECTURE.md](ARCHITECTURE.md#security-posture). Reports that break one of
its guarantees are especially welcome, for example:

- the Figma plugin reaching anything other than `ws://localhost` (its manifest allows only ports 8787–8789);
- a connection to the bridge succeeding without the bridge token, or from a foreign origin;
- the daemon socket being reachable by another user;
- design content (layer names, text, annotations) being followed as instructions by the skills or tools;
- a write to the Figma file through any path other than the MCP server's opt-in `figma_write`.

Out of scope: a malicious process already running as your user (it can read the token file), and issues in Figma,
Claude Code or other third-party tools themselves — report those to their vendors.
