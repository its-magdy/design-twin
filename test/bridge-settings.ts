// The settings a suite's in-process bridge is created with: this process's own (its FIGMA_BRIDGE_TOKEN, payload cap,
// idle window — read when called, so a suite that sets the token first gets it), at the port the test binds.
import { daemonAddressOf, readSettings } from "../bridge/src/settings.ts";
import type { BridgeSettings } from "../bridge/src/settings.ts";
import type { DaemonAddress } from "../bridge/src/daemon.ts";

export function settingsAt(port: number, over: Partial<BridgeSettings> = {}): BridgeSettings {
  const read = readSettings({ env: { ...process.env, FIGMA_BRIDGE_PORT: undefined } });
  if (!read.ok) throw new Error(read.problem);
  return { ...read.settings, port, ...over };
}

/** The daemon address a suite's in-process daemon serves or looks up at `port`: this process's settings' (its token,
 *  XDG_RUNTIME_DIR) on this host, as every entry resolves it (settings.ts daemonAddressOf) — keyed on `token` when
 *  given, so on Windows the pipe is named from the suite's token and never the user's saved one. */
export function addressAt(port: number, token?: string): DaemonAddress {
  const over: Partial<BridgeSettings> = token === undefined ? {} : { token: { ok: true, resolved: { token, source: "env", path: null, created: false } } };
  return daemonAddressOf(settingsAt(port, over));
}
