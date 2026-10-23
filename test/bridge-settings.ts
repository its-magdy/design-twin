// The settings a suite's in-process bridge is created with: this process's own (its FIGMA_BRIDGE_TOKEN, payload cap,
// idle window — read when called, so a suite that sets the token first gets it), at the port the test binds.
import { readSettings } from "../bridge/src/settings.ts";
import type { BridgeSettings } from "../bridge/src/settings.ts";

export function settingsAt(port: number, over: Partial<BridgeSettings> = {}): BridgeSettings {
  const read = readSettings({ env: { ...process.env, FIGMA_BRIDGE_PORT: undefined } });
  if (!read.ok) throw new Error(read.problem);
  return { ...read.settings, port, ...over };
}
