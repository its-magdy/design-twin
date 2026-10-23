// [ABANDON] the bridge can cancel the request it gave up on (executing or still queued).
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { PostedMessage } from "../fake-figma.ts";
import { ABANDONED, gate, settle, type Case } from "./helpers.ts";
import { world } from "./scene.ts";

export const cases: Case[] = [{
  // One case: (a)-(e) drive one run chain — queued vs executing runs, a cancel landing on one and not the
  // next — and the overlapping, un-awaited sends go through the raw handler.
  name: "[ABANDON] the bridge can cancel the request it gave up on (executing or still queued)",
  async run() {
    // Live 2026-09-25: when the CLI's stall check/timeout fired or its process exited, the plugin kept
    // walking and every later bridge command queued behind the ghost run. ui.html now forwards a socket
    // `{ type: "cancel", id }` frame as UI->main `{ type: "cancel", id }`, and a socket close as
    // `{ type: "cancel", scope: "bridge" }`. Driven through main.ts's real onmessage. Pre-change, both
    // shapes fell into the designer-button branch (requestCancel + a cancel-ack) — which is what each
    // check's "pre-change:" note refers to.
    const w = world();
    const { api, figma, posted } = w;
    const { scrollFrame } = w.fx;
    const handler = must(figma.ui.onmessage, "figma.ui.onmessage");
    const acks = (): PostedMessage[] => posted.filter((m) => m.type === "cancel-ack");
    const began = (label: string): boolean => posted.some((m) => m.type === "run-begin" && m.label === label);
    const plainPage = (id: string, name: string) => ({ id, name, children: [scrollFrame], loadAsync: async () => {}, findAllWithCriteria: () => [] });
    // A page whose children read sends `msg` to main.ts mid-walk, so the next safe point sees it.
    const trapWith = (msg: unknown) => ({ id: "p:abtrap", name: "Trap", loadAsync: async () => {}, findAllWithCriteria: () => [],
      get children() { void handler(msg); return [scrollFrame]; } });

    // (a) cancel by id of a QUEUED bridge run.
    posted.length = 0;
    const gA = gate();
    const runA = { source: "bridge" as const, label: "ab-A", requestId: "req-A" };
    const runB = { source: "bridge" as const, label: "ab-B", requestId: "req-B" };
    const runC = { source: "bridge" as const, label: "ab-C", requestId: "req-C" };
    let bRan = false;
    // serializeRun starts a run on a later microtask, so each "executing" run signals that it has
    // really begun before the cancel is sent — otherwise it would still be queued.
    const startA = gate();
    const pA = settle(api.serializeRun(async () => { startA.open(); await gA.p; return "A"; }, runA));
    const pB = settle(api.serializeRun(async () => { bRan = true; return "B"; }, runB));
    const pC = settle(api.serializeRun(async () => "C", runC));
    await startA.p;
    await handler({ type: "cancel", id: "req-B" });
    gA.open();
    const [rA, rB, rC] = await Promise.all([pA, pB, pC]);
    // pre-change: fails on `!bRan` — B's collector ran (the id was ignored; the button branch armed A's flag instead).
    ok("[ABANDON] cancel by id of a QUEUED bridge run: its collector never runs", !bRan);
    // pre-change: fails on !began("ab-B") — B executed, so it was bracketed.
    ok("[ABANDON] …and it posts no run-begin/run-end (it never executed)",
      !began("ab-B") && posted.filter((m) => m.type === "run-begin").length === 2 && posted.filter((m) => m.type === "run-end").length === 2);
    // pre-change: fails on rB.err — B resolved "B".
    ok("[ABANDON] …and its promise rejects with ABANDONED_MESSAGE, not the designer's text", rB.v === null && rB.err?.message === ABANDONED);
    // pre-change: fails on acks().length — the button branch posted a cancel-ack.
    ok("[ABANDON] …the run ahead of it and the run after it still execute; no cancel-ack is posted",
      rA.v === "A" && rC.v === "C" && began("ab-C") && acks().length === 0);

    // (b) cancel by id of the EXECUTING bridge run — through the real `bridge` frame, so the id is the
    // one handleBridge threads into the run.
    posted.length = 0;
    figma.root.children = [trapWith({ type: "cancel", id: "req-X" }), plainPage("p:ab2", "Two")];
    await handler({ type: "bridge", id: "req-X", cmd: "exportFull", args: { allPages: true, css: false } });
    const resX = posted.find((m) => m.type === "bridge-result");
    // pre-change: fails on the error text — it was CANCELLED_MESSAGE ("…by the designer in Figma").
    ok("[ABANDON] cancel by id of the EXECUTING bridge run aborts it at its next safe point with ABANDONED_MESSAGE",
      !!resX && resX.ok === false && resX.id === "req-X" && resX.error === ABANDONED && began("exportFull"));
    // pre-change: fails on the run-end shape (it was a bare {"type":"run-end"}) and on the cancel-ack.
    ok("[ABANDON] …its run-end says abandoned (so the window can say why), and no cancel-ack drives the button chrome",
      posted.filter((m) => m.type === "run-end").map((m) => JSON.stringify(m)).join() === '{"type":"run-end","abandoned":true}' && acks().length === 0);

    // (c) scope "bridge": every bridge run, executing and queued — never a UI run, never a later one.
    posted.length = 0;
    figma.root.children = [plainPage("p:ab1", "One"), plainPage("p:ab2", "Two")];
    const gE = gate();
    const ran: string[] = [];
    const startE = gate();
    const pE = settle(api.serializeRun(async () => { ran.push("E"); startE.open(); await gE.p; return api.collectFull({ allPages: true, css: false }); },
      { source: "bridge", label: "ab-E" }));
    await startE.p;
    const q1 = { source: "bridge" as const, label: "ab-Q1", requestId: "req-Q1" };
    const pQ1 = settle(api.serializeRun(async () => { ran.push("Q1"); return "Q1"; }, q1));
    const pU = settle(api.serializeRun(async () => { ran.push("U"); return "U"; }, { source: "ui", label: "ab-U" }));
    const pQ2 = settle(api.serializeRun(async () => { ran.push("Q2"); return "Q2"; }, { source: "bridge", label: "ab-Q2" }));
    await handler({ type: "cancel", scope: "bridge" });
    const late = { source: "bridge" as const, label: "ab-L", requestId: "req-L" };
    const pL = settle(api.serializeRun(async () => { ran.push("L"); return "L"; }, late));
    gE.open();
    const [rE, rQ1, rU, rQ2, rL] = await Promise.all([pE, pQ1, pU, pQ2, pL]);
    // pre-change: fails on rE.err — the button branch armed the designer flag (CANCELLED_MESSAGE).
    ok("[ABANDON] scope \"bridge\" aborts the EXECUTING bridge run with ABANDONED_MESSAGE", rE.v === null && rE.err?.message === ABANDONED);
    // pre-change: fails on ran — Q1 and Q2 ran.
    ok("[ABANDON] …and every QUEUED bridge run (with or without an id) rejects unrun, with no run-begin",
      rQ1.err?.message === ABANDONED && rQ2.err?.message === ABANDONED && !ran.includes("Q1") && !ran.includes("Q2") && !began("ab-Q1") && !began("ab-Q2"));
    // pre-change: fails on the join — "E,Q1,U,Q2,L" (and on acks()).
    ok("[ABANDON] …but a queued UI run executes, a bridge run queued AFTER the cancel executes, and no cancel-ack",
      rU.v === "U" && rL.v === "L" && ran.join() === "E,U,L" && acks().length === 0);

    // (d) an unknown id is a no-op: the executing run finishes normally.
    posted.length = 0;
    figma.root.children = [trapWith({ type: "cancel", id: "nobody" }), plainPage("p:ab2", "Two")];
    const runD = { source: "bridge" as const, label: "ab-D", requestId: "req-D" };
    const rD = await settle(api.serializeRun(() => api.collectFull({ allPages: true, css: false }), runD));
    // pre-change: fails on rD.v — the `id` was ignored, the message hit the button branch and the run rejected.
    ok("[ABANDON] a cancel for an unknown id is a no-op: the executing run completes, plain run-end, no ack",
      !!rD.v && rD.v.layersDoc.layers.length > 0 && rD.err === null && acks().length === 0 &&
      JSON.stringify(posted.filter((m) => m.type === "run-end")) === '[{"type":"run-end"}]');

    // (e) the designer's button (no id, no scope) is unchanged — and wins over an earlier abandonment.
    // The trap sends a bridge id-cancel for the running run first, then the button's cancel.
    posted.length = 0;
    const bothTrap = { id: "p:abtrap2", name: "Trap", loadAsync: async () => {}, findAllWithCriteria: () => [],
      get children() { void handler({ type: "cancel", id: "req-E2" }); void handler({ type: "cancel" }); return [scrollFrame]; } };
    figma.root.children = [bothTrap, plainPage("p:ab2", "Two")];
    const runE2 = { source: "bridge" as const, label: "exportFull", requestId: "req-E2" };
    const rE2 = await settle(api.serializeRun(() => api.collectFull({ allPages: true, css: false }), runE2));
    // pre-change: fails on acks().length — the id-cancel also went down the button branch, so TWO acks were posted.
    ok("[ABANDON] the button path is unchanged: exactly one ack {accepted:true,label}, CANCELLED_MESSAGE, bare run-end — even after a bridge id-cancel",
      rE2.err?.message === "export cancelled by the designer in Figma" &&
      acks().map((m) => JSON.stringify(m)).join("|") === '{"type":"cancel-ack","accepted":true,"label":"exportFull"}' &&
      JSON.stringify(posted.filter((m) => m.type === "run-end")) === '[{"type":"run-end"}]');
    posted.length = 0;
    await handler({ type: "cancel", scope: "bridge" });
    await handler({ type: "cancel" });
    // pre-change: fails on the join — the scope message was a button click too, so there were TWO refusal acks.
    ok("[ABANDON] with nothing running: the button's refusal ack is byte-identical, and a bridge-scope cancel posts nothing",
      acks().map((m) => JSON.stringify(m)).join("|") === '{"type":"cancel-ack","accepted":false,"label":null}' && posted.length === 1);
  },
}];
