// human-ms.ts — a duration for a log line. A leaf (no imports), so the daemon's served session can say how long it
// idled without importing settings.ts, which imports the daemon module.

/** An idle window for a log line: whole minutes from one minute up, else whole seconds. */
export function humanMs(ms: number): string {
  return ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)}s`;
}
