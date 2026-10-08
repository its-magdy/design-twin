// plan-waivers.ts — the pieces of the deviation registry (D5/D20/D21) both verify-screen and verify-build
// need: which verdicts pass, and the hash of a plan's waivers/descopes a report records. verify-build
// imports this file, never verify-screen.
import crypto from "node:crypto";
import type { Plan, PlanWaiver, PlanDescope } from "./types.ts";

export type { PlanWaiver, PlanDescope };

/** The verdicts a screen passes with. `pass-with-deviations`: nothing open, ≥1 accepted delta or descoped interaction. */
export const PASSING_VERDICTS = ["pass", "pass-with-deviations"] as const;
export type PassingVerdict = (typeof PASSING_VERDICTS)[number];

export function isPassingVerdict(v: unknown): v is PassingVerdict {
  return typeof v === "string" && (PASSING_VERDICTS as readonly string[]).includes(v);
}

/** JSON with object keys sorted at every depth (array order kept) — the canonical form hashed below (and by
 *  probe-steps.ts stepsSha256). */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** sha256 (hex) of the canonical JSON of {waivers, descopes}; `[]`, absent or non-array hash as the empty set. */
export function waiversHash(plan: Plan | null | undefined): string {
  const waivers = Array.isArray(plan?.waivers) ? plan.waivers : [];
  const descopes = Array.isArray(plan?.descopes) ? plan.descopes : [];
  return crypto.createHash("sha256").update(canonical({ descopes, waivers })).digest("hex");
}

/** F-95 (D40(7)): sha256 (hex) of the canonical JSON of plan.interactions — the only part of a plan that binds an
 *  expectation; absent or non-array hashes as `[]`. */
export function planInteractionsSha256(plan: Plan | null | undefined): string {
  const rows = Array.isArray(plan?.interactions) ? plan.interactions : [];
  return crypto.createHash("sha256").update(canonical(rows)).digest("hex");
}
