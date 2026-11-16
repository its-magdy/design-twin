// Figma's toast (figma.notify) for what a write did, with one rule: a red one (a refusal, a failure) is taken down
// when the next review card goes up, so a stale "rejected" never sits over a new request (review.ts).

let lastError: NotificationHandler | null = null;

/** Show `text` in Figma's toast; `error` makes it red and keeps its handle until the next card clears it. */
export function toast(text: string, error?: boolean): void {
  try {
    const h = figma.notify(text, error ? { error: true } : undefined);
    if (error) lastError = h && typeof h.cancel === "function" ? h : null;
  } catch (e) {
    console.error("[export] figma.notify failed:", e);
  }
}

/** Take down the last red toast, if it is still up. */
export function clearErrorToast(): void {
  const h = lastError;
  lastError = null;
  if (!h) return;
  try { h.cancel(); } catch (e) { console.error("[export] could not take the toast down:", e); }
}
