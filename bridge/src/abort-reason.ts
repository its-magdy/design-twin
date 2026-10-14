// abort-reason.ts — Node-side only (AbortSignal, DOMException): json-util.ts is also type-checked by the
// plugin, which has no DOM lib.

/**
 * Why a request the caller gave up on is rejected: the signal's reason when that is an Error of the
 * caller's own, else `fallback`. A bare abort() carries a DOMException "AbortError" (itself an Error in
 * Node), which names nothing, so it gets the fixed text. The one rule for the bridge and the daemon client.
 */
export function abortReason(signal: AbortSignal, fallback: string): Error {
  const r: unknown = signal.reason;
  return r instanceof Error && !(r instanceof DOMException) ? r : new Error(fallback);
}
