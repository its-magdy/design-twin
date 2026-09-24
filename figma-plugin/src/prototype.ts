// Prototype interactions — the UX/navigation layer. FREE via the Plugin API and NOT readable by
// the paid get_motion_context. trigger -> action(s) -> navigation + transition/easing/duration.
// Action/Trigger/Transition are typed exactly per @figma/plugin-typings' discriminated unions;
// each branch below narrows on `.type` (or `.mediaAction`) before reading its fields.
import type { Action as IrAction, Reaction as IrReaction, Transition as IrTransition } from "../../bridge/src/doc-types.ts";
import { easingCurve, xy, isList } from "./util";
import { varName, nodeNameLookup, getCollection } from "./state";

// A prototype Transition -> compact descriptor (type/direction/duration + the exact easing curve).
function simplifyTransition(tr: Transition): IrTransition {
  const t: IrTransition = { type: tr.type ? tr.type.toLowerCase() : undefined };
  if ("direction" in tr) {
    // DirectionalTransition — the only variant carrying direction/matchLayers.
    t.direction = tr.direction.toLowerCase();
    t.matchLayers = tr.matchLayers; // smart-animate layer match
  }
  t.duration = tr.duration; // seconds
  const ez = tr.easing;
  if (ez && ez.type) {
    // The only animation curve the free Plugin API exposes — carry the exact cubic-bezier / spring
    // parameters so codegen can reproduce the timing, not guess.
    t.easing = ez.type.toLowerCase();
    Object.assign(t, easingCurve(ez));
  }
  return t;
}

function isVariableAlias(v: unknown): v is VariableAlias {
  return !!v && typeof v === "object" && "type" in v && (v as VariableAlias).type === "VARIABLE_ALIAS";
}

// A VariableData payload (SET_VARIABLE value / CONDITIONAL condition) -> a readable value. `vd` is
// always a VariableData per the typings, but the defensive "vd IS the value" fallback below is kept
// (unreachable per the declared type, harmless at runtime) in case a caller ever hands in a bare value.
async function simplifyVariableData(vd: VariableData | undefined): Promise<unknown> {
  if (!vd || typeof vd !== "object") return vd;
  const v: unknown = "value" in vd ? vd.value : vd;
  if (isVariableAlias(v)) {
    return { token: (await varName(v.id)) || v.id };
  }
  return v;
}

const isAction = (a: IrAction | null): a is IrAction => !!a;

// One prototype Action -> compact object. Recursive: CONDITIONAL nests actions inside its blocks.
async function serializeAction(a: Action | undefined | null): Promise<IrAction | null> {
  if (!a) return null;
  const ao: IrAction = { type: (a.type || "").toLowerCase() };
  if (a.type === "URL") {
    ao.url = a.url;
  } else if (a.type === "UPDATE_MEDIA_RUNTIME") {
    // destinationId is the media node the action controls (required for PLAY/PAUSE/MUTE…, optional for
    // the SKIP_* variants) — typings 5664-5681; the same name-resolved `destination` as a NODE action.
    if (a.destinationId) {
      ao.destinationId = a.destinationId;
      const dn = await nodeNameLookup(a.destinationId);
      if (dn) ao.destination = dn;
    }
    ao.mediaAction = String(a.mediaAction).toLowerCase();
    if (a.mediaAction === "SKIP_FORWARD" || a.mediaAction === "SKIP_BACKWARD") ao.amountToSkip = a.amountToSkip;
    if (a.mediaAction === "SKIP_TO") ao.newTimestamp = a.newTimestamp;
  } else if (a.type === "SET_VARIABLE") {
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
  } else if (a.type === "CONDITIONAL") {
    ao.conditionalBlocks = await Promise.all(
      a.conditionalBlocks.map(async (blk) => {
        const b: NonNullable<IrAction["conditionalBlocks"]>[number] = {};
        if (blk.condition) b.condition = await simplifyVariableData(blk.condition);
        if (Array.isArray(blk.actions)) b.actions = (await Promise.all(blk.actions.map(serializeAction))).filter(isAction);
        return b;
      })
    );
  } else if (a.type === "NODE") {
    if (a.destinationId) {
      ao.destinationId = a.destinationId;
      const dn = await nodeNameLookup(a.destinationId);
      if (dn) ao.destination = dn;
    }
    if (a.navigation) ao.navigation = a.navigation.toLowerCase();
    // NODE-action carry-over flags (default false — only emit when set).
    if (a.preserveScrollPosition === true) ao.preserveScroll = true;
    if (a.resetScrollPosition === true) ao.resetScroll = true;
    if (a.resetVideoPosition === true) ao.resetVideo = true;
    if (a.resetInteractiveComponents === true) ao.resetInteractive = true;
    if (a.overlayRelativePosition) ao.overlayOffset = xy(a.overlayRelativePosition);
    if (a.transition) ao.transition = simplifyTransition(a.transition);
  }
  // BACK/CLOSE carry no extra fields beyond `type`.
  return ao;
}

export async function simplifyReactions(node: SceneNode): Promise<IrReaction[] | undefined> {
  if (!("reactions" in node)) return undefined;
  const reactions = node.reactions;
  if (!isList(reactions) || !reactions.length) return undefined;
  const out: IrReaction[] = [];
  for (const r of reactions) {
    const o: IrReaction = {};
    if (r.trigger) {
      const tg = r.trigger;
      o.trigger = tg.type ? tg.type.toLowerCase() : "unknown";
      if (tg.type === "AFTER_TIMEOUT") o.timeout = tg.timeout;
      if (tg.type === "MOUSE_UP" || tg.type === "MOUSE_DOWN" || tg.type === "MOUSE_ENTER" || tg.type === "MOUSE_LEAVE") o.delay = tg.delay; // MOUSE_* triggers
      if (tg.type === "ON_KEY_DOWN") {
        if (tg.keyCodes.length) o.keyCodes = [...tg.keyCodes]; // ON_KEY_DOWN
        o.device = String(tg.device).toLowerCase(); // keyboard vs gamepad
      }
      if (tg.type === "ON_MEDIA_HIT") o.mediaHitTime = tg.mediaHitTime; // ON_MEDIA_HIT scrub time
    }
    const actions = isList(r.actions) ? r.actions : r.action ? [r.action] : [];
    const acts = (await Promise.all(actions.map(serializeAction))).filter(isAction);
    if (acts.length) o.actions = acts;
    if (o.trigger || o.actions) out.push(o);
  }
  return out.length ? out : undefined;
}
