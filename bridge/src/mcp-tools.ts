// mcp-tools.ts — the MCP server's tool list, once. figma-mcp.ts registers exactly these (and refuses to start if a
// registration disagrees on name or plane), `dtwin mcp --help` names them from here, and test/mcp-tools.test.ts holds
// the docs that list them (README, ARCHITECTURE.md, the help skill) to this list and its counts.
//
// Its own module, not a const inside figma-mcp.ts: the CLI's help and the docs test need the list without loading the
// whole server.

export type McpPlane = "read" | "write";
/** Where a tool reads: the live Figma file through the bridge, or the export on disk (no Figma connection). */
export type McpSource = "live" | "disk";

export const MCP_TOOLS = [
  { name: "figma_status", plane: "read", source: "live" },
  { name: "figma_list_clients", plane: "read", source: "live" },
  { name: "figma_whoami", plane: "read", source: "live" },
  { name: "figma_get_selection", plane: "read", source: "live" },
  { name: "figma_list_pages", plane: "read", source: "live" },
  { name: "figma_list_libraries", plane: "read", source: "live" },
  { name: "figma_list_children", plane: "read", source: "live" },
  { name: "figma_export_full", plane: "read", source: "live" },
  { name: "figma_export_design_system", plane: "read", source: "live" },
  { name: "figma_export_selection", plane: "read", source: "live" },
  { name: "figma_export_url", plane: "read", source: "live" },
  { name: "figma_screenshot", plane: "read", source: "live" },
  { name: "figma_write", plane: "write", source: "live" },
  { name: "design_get_component", plane: "read", source: "disk" },
  { name: "design_drift_lint", plane: "read", source: "disk" },
] as const satisfies ReadonlyArray<{ name: string; plane: McpPlane; source: McpSource }>;

export type McpToolName = (typeof MCP_TOOLS)[number]["name"];

/** The plane of the tool `name`, or undefined for a name not in MCP_TOOLS. */
export function planeOf(name: string): McpPlane | undefined {
  return MCP_TOOLS.find((t) => t.name === name)?.plane;
}

const names = (keep: (t: (typeof MCP_TOOLS)[number]) => boolean): string[] => MCP_TOOLS.filter(keep).map((t) => t.name);
/** The live reads (they mirror the CLI), the writes, and the reads of the export on disk. */
export const LIVE_READS = names((t) => t.plane === "read" && t.source === "live");
export const WRITES = names((t) => t.plane === "write");
export const DISK_READS = names((t) => t.source === "disk");
