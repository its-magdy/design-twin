// The "Allow edits" opt-in: the plugin changes the open file ONLY while the designer has ticked it in the
// plugin window. The main thread is the authority — writes.ts applyWrites asks editsAllowed() before any op
// runs, so a write reaching it by any path (a bridge command, the __designExport test surface) is refused
// the same way while it is off. Nothing on the bridge side can turn it on: only the window's checkbox posts
// `set-allow-edits` (main.ts), and relay.ts turns every socket frame into a `bridge`/`cancel` message, never
// that one.
//
// Off by default, and persisted per user in figma.clientStorage. GLOBAL, not per file: clientStorage is
// already scoped to this user and this plugin, and a per-file key would need an identity the plugin cannot
// read reliably (figma.fileKey is gated to private plugins; the file name is editable and duplicated files
// share it) — or document-scoped storage, which would itself be a write to the file.

const KEY = "allowEdits";

let allowed = false;

// Read once, when the bundle is evaluated. Until it settles the setting reads as OFF — a write that races
// the plugin's start-up is refused, never applied — and applyWrites awaits it, so an "on" saved last
// session is honoured from the first write rather than refused by the race.
const loaded: Promise<void> = (async () => {
  try {
    allowed = (await figma.clientStorage.getAsync(KEY)) === true;
  } catch (e) {
    console.error("[export] could not read the Allow edits setting; edits stay off:", e);
    allowed = false;
  }
})();

/** Whether a write may change the file right now (after the saved setting has been read). */
export async function editsAllowed(): Promise<boolean> {
  await loaded;
  return allowed;
}

/** The current value, without waiting: for the re-check right before each mutation (writes.ts consent), which
 *  runs only after editsAllowed() has already awaited the saved setting. */
export function editsAllowedNow(): boolean {
  return allowed;
}

/** The designer ticked or cleared the checkbox. Takes effect at once, then is saved; a failed save is
 *  logged and the session keeps the choice the designer just made. */
export async function setEditsAllowed(on: boolean): Promise<boolean> {
  await loaded;
  allowed = on;
  try {
    await figma.clientStorage.setAsync(KEY, on);
  } catch (e) {
    console.error("[export] could not save the Allow edits setting:", e);
  }
  return allowed;
}
