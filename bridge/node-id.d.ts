// Types for node-id.js — the module is plain CJS so the Node CLI/MCP can require it AND esbuild can
// inline it into the plugin bundle; this declaration is what lets collect.ts import it under `strict`.
// (Same arrangement as pages-layout.d.ts.)
export const ID: string;
/** A Figma URL, a `…node-id=…` fragment, or a bare id -> colon form, or undefined when there's none. */
export function parseNodeId(input: unknown): string | undefined;
/** Lenient twin of parseNodeId: colon form when recognisable, else the raw token verbatim ("" if absent). */
export function toNodeId(raw: unknown): string;
