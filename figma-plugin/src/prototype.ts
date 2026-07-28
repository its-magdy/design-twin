// Prototype interactions — the UX/navigation layer. FREE via the Plugin API and NOT readable by
// the paid get_motion_context. trigger -> action(s) -> navigation + transition/easing/duration.
// Action/Trigger/Transition are wide unions, so these stay `any` and read defensively.
import { Obj, easingCurve, xy } from "./util";
import { varName, nodeNameLookup, getCollection } from "./state";

// A prototype Transition -> compact descriptor (type/direction/duration + the exact easing curve).
function simplifyTransition(tr: any): Obj {
  const t: Obj = { type: tr.type ? tr.type.toLowerCase() : undefined };
  if (tr.direction) t.direction = tr.direction.toLowerCase();
  if (typeof tr.duration === "number") t.duration = tr.duration; // seconds
  if (typeof tr.matchLayers === "boolean") t.matchLayers = tr.matchLayers; // smart-animate layer match
  const ez = tr.easing;
  if (ez && ez.type) {
    // The only animation curve the free Plugin API exposes — carry the exact cubic-bezier / spring
    // parameters so codegen can reproduce the timing, not guess.
    t.easing = ez.type.toLowerCase();
    Object.assign(t, easingCurve(ez));
  }
  return t;
}

// A VariableData payload (SET_VARIABLE value / CONDITIONAL condition) -> a readable value.
async function simplifyVariableData(vd: any): Promise<any> {
  if (!vd || typeof vd !== "object") return vd;
  const v = "value" in vd ? vd.value : vd;
  if (v && v.type === "VARIABLE_ALIAS") return { token: (await varName(v.id)) || v.id };
  return v;
}

// One prototype Action -> compact object. Recursive: CONDITIONAL nests actions inside its blocks.
async function serializeAction(a: any): Promise<Obj | null> {
  if (!a) return null;
  const ao: Obj = { type: (a.type || "").toLowerCase() };
  if (a.navigation) ao.navigation = a.navigation.toLowerCase();
  if (a.url) ao.url = a.url;
  if (a.destinationId) {
    ao.destinationId = a.destinationId;
    const dn = await nodeNameLookup(a.destinationId);
    if (dn) ao.destination = dn;
  }
  // NODE-action carry-over flags (default false — only emit when set).
  if (a.preserveScrollPosition === true) ao.preserveScroll = true;
  if (a.resetScrollPosition === true) ao.resetScroll = true;
  if (a.resetVideoPosition === true) ao.resetVideo = true;
  if (a.resetInteractiveComponents === true) ao.resetInteractive = true;
  if (a.overlayRelativePosition) ao.overlayOffset = xy(a.overlayRelativePosition);
  if (a.transition) ao.transition = simplifyTransition(a.transition);
  // Variable-driven prototypes.
  if (a.type === "SET_VARIABLE") {
    if (a.variableId) ao.variable = (await varName(a.variableId)) || a.variableId;
    if (a.variableValue != null) ao.value = await simplifyVariableData(a.variableValue);
  } else if (a.type === "SET_VARIABLE_MODE") {
    if (a.variableCollectionId) {
      const c = await getCollection(a.variableCollectionId);
      ao.collection = c ? c.name : a.variableCollectionId;
      if (a.variableModeId) {
        const m = c && Array.isArray(c.modes) ? c.modes.find((x) => x.modeId === a.variableModeId) : null;
        ao.mode = m ? m.name : a.variableModeId;
      }
    }
  } else if (a.type === "UPDATE_MEDIA_RUNTIME") {
    if (a.mediaAction) ao.mediaAction = String(a.mediaAction).toLowerCase();
    if (typeof a.amountToSkip === "number") ao.amountToSkip = a.amountToSkip;
    if (typeof a.newTimestamp === "number") ao.newTimestamp = a.newTimestamp;
  } else if (a.type === "CONDITIONAL" && Array.isArray(a.conditionalBlocks)) {
    ao.conditionalBlocks = await Promise.all(
      a.conditionalBlocks.map(async (blk: any) => {
        const b: Obj = {};
        if (blk.condition) b.condition = await simplifyVariableData(blk.condition);
        if (Array.isArray(blk.actions)) b.actions = (await Promise.all(blk.actions.map(serializeAction))).filter(Boolean);
        return b;
      })
    );
  }
  return ao;
}

export async function simplifyReactions(node: SceneNode): Promise<Obj[] | undefined> {
  const reactions = (node as any).reactions;
  if (!("reactions" in node) || !Array.isArray(reactions) || !reactions.length) return undefined;
  const out: Obj[] = [];
  for (const r of reactions) {
    const o: Obj = {};
    if (r.trigger) {
      o.trigger = r.trigger.type ? r.trigger.type.toLowerCase() : "unknown";
      if (typeof r.trigger.timeout === "number") o.timeout = r.trigger.timeout; // AFTER_TIMEOUT
      if (typeof r.trigger.delay === "number") o.delay = r.trigger.delay; // MOUSE_* triggers
      if (Array.isArray(r.trigger.keyCodes) && r.trigger.keyCodes.length) o.keyCodes = r.trigger.keyCodes; // ON_KEY_DOWN
      if (r.trigger.device) o.device = String(r.trigger.device).toLowerCase(); // keyboard vs gamepad
      if (typeof r.trigger.mediaHitTime === "number") o.mediaHitTime = r.trigger.mediaHitTime; // ON_MEDIA_HIT scrub time
    }
    const actions = Array.isArray(r.actions) ? r.actions : r.action ? [r.action] : [];
    const acts = (await Promise.all(actions.map(serializeAction))).filter(Boolean);
    if (acts.length) o.actions = acts;
    if (o.trigger || o.actions) out.push(o);
  }
  return out.length ? out : undefined;
}
