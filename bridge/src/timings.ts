// timings.ts — the opt-in stage record of one dtwin command, for profiling rather than for a user: set
// DTWIN_TIMINGS=1 (one JSON line on stderr) or DTWIN_TIMINGS=<file> (appended to that file as JSON Lines).
//
// The closing `done in …` line already splits a command into connect / export / write, but "export" is one number for
// everything between the request leaving and the reply landing: a run queued behind another export in that file, the
// plugin's page walk, its catalogue build, its render pass and the transfer all fall in it. The plugin's progress
// ticks (server-core.ts ProgressTick) already arrive per phase, so their arrival times split that span without a
// protocol change: `phases[]` says when each phase was first and last heard, measured on this side (transport latency
// included). `queueMs` is the time to the first tick of any phase other than `queued`, when the run was queued.
//
// What is recorded is counts, sizes and times only — phase names, page index/of, node and asset counters, payload
// bytes, peak RSS. Never a page or layer name, a file name or key, a token, or document content.
//
// Measured with performance.now() (monotonic); peak RSS from process.resourceUsage().maxRSS (kilobytes on every
// platform Bun supports, per Node's documentation of the field — converted to bytes here).
import fs from "node:fs";
import { errMsg } from "./errmsg.ts";

export const TIMINGS_ENV = "DTWIN_TIMINGS";
export const TIMINGS_SCHEMA = "designtwin/timings@1";

/** Where a record goes: stderr ("1"/"true"), a file path (anything else non-empty), or nowhere (unset, "", "0"). */
export function timingsTarget(env: Record<string, string | undefined> = process.env): "stderr" | { file: string } | null {
  const v = (env[TIMINGS_ENV] ?? "").trim();
  if (!v || v === "0" || v.toLowerCase() === "false") return null;
  return v === "1" || v.toLowerCase() === "true" ? "stderr" : { file: v };
}

export interface PhaseSpan { phase: string; firstMs: number; lastMs: number; ticks: number }
/** The asset payload of a reply: how many assets and their decoded bytes (base64 counted as the bytes it decodes to). */
export interface PayloadStats { assets: number; assetBytes: number; nodes: number | null }
export interface StageRecord {
  schema: typeof TIMINGS_SCHEMA;
  command: string;
  viaDaemon: boolean;
  totalMs: number; connectMs: number; exportMs: number; writeMs: number;
  /** request sent → first tick of a phase other than `queued`; null when the run was never queued */
  queueMs: number | null;
  phases: PhaseSpan[];
  requests: number;
  payload: PayloadStats | null;
  peakRssBytes: number | null;
}

const round1 = (ms: number): number => Math.round(ms * 10) / 10;

/** Decoded byte length of a base64 string without decoding it. */
export function base64Bytes(b64: string): number {
  const n = b64.length;
  if (!n) return 0;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((n * 3) / 4) - pad;
}

/** PayloadStats of one reply (read defensively: it is the plugin's JSON). null when it carries no `assets` array. */
export function payloadStats(result: unknown): PayloadStats | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { assets?: unknown; manifest?: { nodes?: unknown }; screen?: { manifest?: { nodes?: unknown } } };
  if (!Array.isArray(r.assets)) return null;
  let assetBytes = 0;
  for (const a of r.assets as Array<{ base64?: unknown; text?: unknown } | null>) {
    if (!a) continue;
    if (typeof a.text === "string") assetBytes += Buffer.byteLength(a.text, "utf8");
    else if (typeof a.base64 === "string") assetBytes += base64Bytes(a.base64);
  }
  const nodes = r.screen?.manifest?.nodes ?? r.manifest?.nodes;
  return { assets: r.assets.length, assetBytes, nodes: typeof nodes === "number" ? nodes : null };
}

/** The clock of one command: started at creation; fed every request, reply and progress tick. */
export interface StageClock {
  sent(): void;
  replied(result: unknown): void;
  tick(phase: string | null): void;
  record(o: { command: string; viaDaemon: boolean; connectMs: number; exportMs: number; writeMs: number }): StageRecord;
}

export function stageClock(now: () => number = () => performance.now(), rss: () => number | null = peakRss): StageClock {
  const t0 = now();
  const phases = new Map<string, PhaseSpan>();
  let firstSent: number | null = null, queued = false, queueMs: number | null = null, requests = 0;
  let payload: PayloadStats | null = null;
  return {
    sent() { requests++; if (firstSent === null) firstSent = now() - t0; },
    replied(result) {
      const p = payloadStats(result);
      if (!p) return;
      payload = payload ? { assets: payload.assets + p.assets, assetBytes: payload.assetBytes + p.assetBytes, nodes: p.nodes ?? payload.nodes } : p;
    },
    tick(phase) {
      const at = now() - t0;
      const name = phase || "unnamed";
      if (name === "queued") queued = true;
      else if (queued && queueMs === null && firstSent !== null) queueMs = round1(at - firstSent);
      const s = phases.get(name);
      if (s) { s.lastMs = round1(at); s.ticks++; } else phases.set(name, { phase: name, firstMs: round1(at), lastMs: round1(at), ticks: 1 });
    },
    record(o) {
      return {
        schema: TIMINGS_SCHEMA, command: o.command, viaDaemon: o.viaDaemon,
        totalMs: round1(now() - t0), connectMs: round1(o.connectMs), exportMs: round1(o.exportMs), writeMs: round1(o.writeMs),
        queueMs, phases: [...phases.values()], requests, payload, peakRssBytes: rss(),
      };
    },
  };
}

function peakRss(): number | null {
  try { return process.resourceUsage().maxRSS * 1024; } catch { return null; }
}

/** Write one record to its target. A file that cannot be appended to is said on stderr, never thrown: a profiling
 *  aid must not fail the command it measures. */
export function emitTimings(rec: StageRecord, target: "stderr" | { file: string }, err: (s: string) => void = (s) => console.error(s)): void {
  const line = JSON.stringify(rec);
  if (target === "stderr") { err("[dtwin] timings " + line); return; }
  try { fs.appendFileSync(target.file, line + "\n"); } catch (e) { err(`[dtwin] ${TIMINGS_ENV}: could not append to ${target.file} (${errMsg(e)})`); }
}
