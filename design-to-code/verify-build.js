// verify-build.js — the Stop-hook gate for the build-screen skill.
//
// Registered in two places. build-screen/SKILL.md's frontmatter (Stop): active only for a session
// that actually invoked build-screen. claude-plugin/hooks/hooks.json (SubagentStop, matched to the
// screen-builder agent): Claude Code ignores `hooks` in a plugin-shipped agent's frontmatter, so the
// fan-out builder can only be gated from the plugin level.
//
// Fast path (must stay cheap — this can fire on every turn-end for the rest of the session):
//   no design/plan/<screen>.json with status "pending" → exit 0 immediately.
//
// What this gate IS: a static consistency check between the plan and the code on disk, plus a check
// that the agent RECORDED how it verified the render. What it is NOT: a visual check. It never
// renders anything, so it never writes "verified" on its own authority — that status is only granted
// when the plan carries a `verification` block naming render artifacts that exist on disk.
//
// When there IS pending plan work, it checks:
//   - tokens: a value the plan resolved to a code token, found as a raw literal in the built files.
//     Every platform's spelling is matched — `#5B5FC7`, `0xFF5B5FC7` (Compose/Flutter), `rgb(91, 95,
//     199)`, and for dimensions Tailwind's `[14px]`/`[0.875rem]`. Literals the plan did NOT resolve to
//     a token are left alone: the profiles legitimately prescribe arbitrary values where no token
//     exists (a one-off shadow's rgba(), `text-[15px]`), and a gate that fails on those makes a
//     correctly-followed build unfinishable. `allowedLiterals` exempts a resolved value on purpose
//     (e.g. the theme file that DEFINES the token is in files[]).
//   - components: a plan row marked "reused" whose module is never imported; and the reverse hole —
//     a row marked "new" whose Figma key IS mapped in codeconnect.local.json, i.e. a component that
//     exists in code was regenerated and the plan simply called it new.
//   - unresolved MISSING rows the agent never surfaced a decision for.
//   - files: `files[]` must list at least one built file and every entry must exist. The literal and
//     import checks only read the files listed there, so an empty or stale list would pass them
//     vacuously — the gate would approve code it never looked at.
//   - verification: the plan must say how the build was checked (see shape below).
//
// On any failure: print a specific, itemized list to stderr and exit 2. Claude Code's Stop hook
// protocol blocks the turn from ending on exit 2 and feeds stderr back to the agent as the reason
// to fix before it's allowed to report done.
//
// Plan file shape (written by build-screen step 2, see SKILL.md):
//   {
//     "screen": "login",
//     "status": "pending" | "awaiting-user" | "verified" | "static-only" | "abandoned",
//     "files": ["src/screens/Login.tsx", ...],
//     "tokens": [{ "value": "#5B5FC7", "kind": "color", "codeToken": "brand-600"|null, "verdict": "exact"|"missing"|"decided", "decision": "..."?}],
//     "components": [{ "name": "Button", "key": "...", "mapModule": "@/ui/Button"|null, "verdict": "reused"|"new"|"missing" }],
//     "allowedLiterals": [{ "value": "#5B5FC7", "reason": "theme.ts defines brand-600" }],
//     "verification": { "mode": "rendered", "renderer": "playwright", "artifacts": ["design/verify/login.png"], "deltas": ["title 1px low"] }
//                   | { "mode": "static-only", "reason": "no dev server or simulator available (checked package.json)" }
//   }
// The hook sets status itself: "verified" only for mode "rendered" with an artifact on disk,
// "static-only" otherwise — so a report can never claim a rendered match the plan does not evidence.
// Set status "abandoned" by hand to retire a plan that will not be finished (otherwise it nags on
// every stop for the rest of the session).
//
// "awaiting-user" is a build PAUSED on a question only the user can answer (an unresolved MISSING
// token, an audit blocker). The skill tells the agent to end the turn and ask at exactly those
// points; a half-written plan (files: []) would otherwise fail here and push the agent to keep
// building instead of asking. The hook skips such a plan and never closes it: the agent sets it back
// to "pending" when it resumes, and only a pending plan that passes every check becomes
// "verified"/"static-only" — so pausing cannot be used to get a build approved.
//
// A pending plan nobody has touched for STALE_HOURS is left alone: it is a leftover from an earlier
// session, not this turn's work, and blocking today's unrelated stops on it helps no one. The plan
// file's mtime is the clock — every step of a live build rewrites it (files[], verification).
// DTWIN_PLAN_STALE_HOURS overrides the window; 0 disables the cutoff.

const fs = require("fs");
const path = require("path");

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const STALE_HOURS = 12;

function staleCutoffMs() {
  const raw = process.env.DTWIN_PLAN_STALE_HOURS;
  const h = raw === undefined || raw === "" ? STALE_HOURS : Number(raw);
  return Number.isFinite(h) && h > 0 ? h * 3600 * 1000 : 0;
}

function isStale(file, now = Date.now()) {
  const cutoff = staleCutoffMs();
  if (!cutoff) return false;
  try { return now - fs.statSync(file).mtimeMs > cutoff; } catch { return false; }
}

function findPlans(cwd) {
  const dir = path.join(cwd, "design", "plan");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return { file: path.join(dir, f), plan: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// "#abc" / "#aabbcc" / "#aabbccdd" -> "aabbcc" (alpha dropped: the literal forms below spell it
// differently per platform, and the RGB part is what identifies the token).
function hex6(value) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(value).trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  return h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
}

// Every raw color literal in the source, normalised to rrggbb -> the spelling found (for the message).
function colorLiterals(source) {
  const found = new Map();
  const add = (h, lit) => { if (h && !found.has(h)) found.set(h, lit); };
  for (const m of source.matchAll(/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) add(hex6(m[1]), m[0]);
  // Compose `Color(0xFF5B5FC7)` / Flutter `Color(0xFF5B5FC7)` — AARRGGBB, or bare 0xRRGGBB.
  for (const m of source.matchAll(/\b0x([0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/g)) add(m[1].slice(-6).toLowerCase(), m[0]);
  for (const m of source.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})[^)]*\)/g)) {
    add([m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join(""), m[0]);
  }
  return found;
}

// Tailwind arbitrary dimensions: `gap-[14px]`, `p-[0.875rem]` -> px number -> the spelling found.
function arbitraryPx(source) {
  const found = new Map();
  for (const m of source.matchAll(/\[(-?\d+(?:\.\d+)?)(px|rem)\]/g)) {
    const px = Number(m[1]) * (m[2] === "rem" ? 16 : 1);
    if (!found.has(px)) found.set(px, m[0]);
  }
  return found;
}

function loadMapKeys(cwd) {
  try {
    const map = JSON.parse(fs.readFileSync(path.join(cwd, "codeconnect.local.json"), "utf8"));
    const keys = new Map();
    for (const [name, e] of Object.entries(map.components || {})) {
      if (e && e.figma && e.figma.key && e.code && e.code.module && e.status !== "deprecated") keys.set(e.figma.key, { name, module: e.code.module });
    }
    return keys;
  } catch {
    return new Map(); // no map / unreadable map: build-screen's own gate handles that, not this hook
  }
}

function checkVerification(plan, cwd) {
  const v = plan.verification;
  if (!v || typeof v !== "object") {
    return ["no `verification` block in the plan — record how the build was checked: {mode:\"rendered\", renderer, artifacts:[…], deltas:[…]} after rendering and comparing (references/verify.md), or {mode:\"static-only\", reason} if the project genuinely has no way to render"];
  }
  if (v.mode === "rendered") {
    const artifacts = Array.isArray(v.artifacts) ? v.artifacts : [];
    if (!artifacts.length) return ["verification.mode is \"rendered\" but `artifacts` is empty — list the screenshot(s)/report the render produced"];
    const missing = artifacts.filter((a) => !fs.existsSync(path.join(cwd, String(a))));
    if (missing.length) return [`verification artifact(s) not found on disk: ${missing.join(", ")} — render the screen, or record mode "static-only" with the reason`];
    if (!Array.isArray(v.deltas)) return ["verification.deltas is missing — list the residual differences against the reference ([] if none were found)"];
    return [];
  }
  if (v.mode === "static-only") {
    return v.reason ? [] : ["verification.mode is \"static-only\" with no `reason` — say what was checked for and not found (dev server, Playwright, simulator…)"];
  }
  return [`verification.mode must be "rendered" or "static-only", got ${JSON.stringify(v.mode)}`];
}

function checkPlan({ plan }, cwd) {
  const problems = [];
  const listed = Array.isArray(plan.files) ? plan.files.map(String) : [];
  const absent = listed.filter((f) => !fs.existsSync(path.join(cwd, f)));
  if (!listed.length) problems.push("`files` is empty — list every file this build created or changed; the token and component checks only read the files named there");
  if (absent.length) problems.push(`file(s) listed in \`files\` not found on disk: ${absent.join(", ")} — fix the path(s) (relative to the project root) or remove entries for files that were not written`);
  const files = listed.map((f) => path.join(cwd, f)).filter((f) => fs.existsSync(f));
  const sources = files.map((f) => fs.readFileSync(f, "utf8"));
  const source = sources.join("\n");
  const allowed = new Set((plan.allowedLiterals || []).filter((a) => a && a.reason).map((a) => String(a.value).toLowerCase()));
  const isAllowed = (row, literal) => allowed.has(String(row.value).toLowerCase()) || allowed.has(String(literal).toLowerCase());

  for (const row of plan.tokens || []) {
    if (row.verdict === "missing" && !row.decision) {
      problems.push(`token ${row.value} (${row.kind}) is MISSING with no recorded decision — resolve or defer explicitly before finishing`);
    }
  }

  const colors = colorLiterals(source);
  const dims = arbitraryPx(source);
  for (const row of plan.tokens || []) {
    if (!row.codeToken) continue;
    if (row.kind === "color") {
      const h = hex6(row.value);
      const lit = h && colors.get(h);
      if (lit && !isAllowed(row, lit)) problems.push(`raw literal ${lit} found in built code, but the plan resolved ${row.value} to token '${row.codeToken}' — use the token, not the literal (or add it to allowedLiterals with a reason)`);
    } else {
      const n = parseFloat(row.value);
      const lit = Number.isFinite(n) && dims.get(n);
      if (lit && !isAllowed(row, lit)) problems.push(`arbitrary value ${lit} found in built code, but the plan resolved ${row.value} (${row.kind}) to token '${row.codeToken}' — use the token (or add it to allowedLiterals with a reason)`);
    }
  }

  const mapped = loadMapKeys(cwd);
  for (const row of plan.components || []) {
    if (row.verdict === "reused" && row.mapModule) {
      if (!sources.some((s) => s.includes(row.mapModule))) problems.push(`component '${row.name}' was mapped to ${row.mapModule} in the plan, but no built file imports it — was it regenerated instead of reused?`);
    }
    if (row.verdict === "new" && row.key && mapped.has(row.key)) {
      const m = mapped.get(row.key);
      problems.push(`component '${row.name}' is marked "new" in the plan, but its Figma key is mapped to ${m.module} in codeconnect.local.json — reuse the existing component`);
    }
    if (row.verdict === "missing") {
      problems.push(`component '${row.name}' has no recorded reuse/new decision — resolve before finishing`);
    }
  }

  problems.push(...checkVerification(plan, cwd));
  return problems;
}

// status the hook grants once every check passes — never "verified" without render evidence.
function passedStatus(plan) {
  return plan.verification && plan.verification.mode === "rendered" ? "verified" : "static-only";
}

// Several screens build in parallel (one screen-builder agent each), and every one of them lands
// here when it stops. Judging ALL pending plans then blocks agent A on agent B's half-written plan —
// problems A was never given and cannot fix. So narrow to the plans the stopping agent itself worked
// on: the ones whose path appears in ITS transcript (a subagent's own transcript when the payload
// names one, else the session's). Narrowing only ever happens on positive evidence — no readable
// transcript, or none of the pending plans mentioned, keeps every plan, exactly as before. A plan
// left out is not approved: it stays "pending" for its own agent's stop.
function ownPlans(pending, input) {
  if (pending.length < 2) return pending;
  const file = input.agent_transcript_path || (input.agent_id ? null : input.transcript_path);
  if (!file) return pending;
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return pending; }
  const mine = pending.filter((p) => {
    const base = path.basename(p.file);
    return text.includes("plan/" + base) || text.includes("plan\\\\" + base);
  });
  return mine.length ? mine : pending;
}

function main() {
  const input = readStdinJson();
  if (input.stop_hook_active) process.exit(0); // avoid re-entrant loops on the same turn

  const cwd = input.cwd || process.cwd();
  // Only "pending" is open work. A plan with no status at all is treated as pending (older plans).
  const pending = findPlans(cwd).filter((p) => (p.plan.status || "pending") === "pending" && !isStale(p.file));
  if (!pending.length) process.exit(0); // fast path: no pending build-screen work this session
  const plans = ownPlans(pending, input);

  const allProblems = [];
  for (const p of plans) {
    const problems = checkPlan(p, cwd);
    if (problems.length) allProblems.push(`# ${path.basename(p.file)}`, ...problems.map((m) => `  - ${m}`));
  }

  if (allProblems.length) {
    console.error("verify-build: build-screen check failed — do not report this screen as done until these are resolved");
    console.error("(a plan that will not be finished: set its status to \"abandoned\"; a build paused on a question for the user: \"awaiting-user\", then ask):\n");
    console.error(allProblems.join("\n"));
    process.exit(2);
  }

  // All plans check out — close them so re-runs later this session stay on the fast path.
  for (const { file, plan } of plans) {
    plan.status = passedStatus(plan);
    fs.writeFileSync(file, JSON.stringify(plan, null, 2) + "\n");
  }
  process.exit(0);
}

module.exports = { ownPlans, checkPlan, checkVerification, passedStatus, colorLiterals, arbitraryPx, hex6, isStale };

if (require.main === module) main();
