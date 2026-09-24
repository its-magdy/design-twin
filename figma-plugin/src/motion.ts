// Motion / animation reads (Plugin API Update 130, 2026-06). Keyframe/timeline VALUES are now
// readable FREE via the Plugin API — this is a new plane the paid get_motion_context used to own.
// Opt-in (runOpts.motion) because it's niche and can be verbose.
import { Obj, round, rgbaToHex, easingCurve, xy, nonEmpty, putNonEmpty } from "./util";

// A KeyframeValue (discriminated on `type`) -> a compact readable value.
// TEXT_DATA / BOOL need no transformation, so they fall through to `default` rather than restating it.
function keyframeValue(kv: KeyframeValue | undefined | null): unknown {
  if (!kv || typeof kv !== "object") return kv;
  switch (kv.type) {
    case "FLOAT": return round(kv.value);
    case "COLOR": return kv.value ? rgbaToHex(kv.value) : undefined;
    case "VECTOR": return kv.value ? xy(kv.value) : undefined;
    case "CIRCLE": return kv.value ? { ...xy(kv.value), radius: round(kv.value.radius) } : undefined;
    case "LINE": return kv.value ? { ...xy(kv.value), x2: round(kv.value.x2), y2: round(kv.value.y2) } : undefined;
    default: return kv.value; // TEXT_DATA / BOOL / CIRCLE_POINT / COLOR_POINT / newer union members — carry the raw value defensively
  }
}

// MotionEasing -> compact (mirrors the prototype-transition easing surface: named curve + exact params).
// `easing` on a keyframe is `MotionEasing | VariableAlias` (Motion supports binding easing to an EASING
// variable) — a VariableAlias has only {type:'VARIABLE_ALIAS', id}, so it falls through with no curve
// params, same as an unrecognised MotionEasing would.
function motionEasing(ez: MotionEasing | VariableAlias | undefined): Obj | undefined {
  if (!ez || !ez.type) return undefined;
  const curve = ez.type === "VARIABLE_ALIAS" ? {} : easingCurve(ez);
  return { type: String(ez.type).toLowerCase(), ...curve };
}

// The flat keyframe-track shape actually read below — kept as one small structural type, as before
// this port, rather than fighting the two real nested shapes. Confirmed against
// https://developers.figma.com/docs/plugins/api/Motion/ (fetched during this port), which agrees with
// the typings: manualKeyframeTracks values are {baseValue, keyframes} directly (no keyframeOperation),
// while animations values are {baseValue, timelineDuration, tracks: ManualKeyframeTrack[]} — the
// keyframes/keyframeOperation live one level deeper, inside each track. So trackMap's `keyframeOperation`
// read is dead for BOTH maps, and its `keyframes` read is dead for `animations` specifically (pre-existing,
// not introduced by this port — kept byte-for-byte per the no-behaviour-change rule).
interface FlatKeyframe {
  timelinePosition: number;
  value: KeyframeValue;
  easing?: MotionEasing | VariableAlias;
}
interface FlatKeyframeBinding {
  baseValue?: KeyframeValue;
  keyframeOperation?: "SET" | "OFFSET" | "SCALE";
  keyframes?: ReadonlyArray<FlatKeyframe>;
}

function keyframes(list: ReadonlyArray<FlatKeyframe> | undefined): Obj[] | undefined {
  if (!Array.isArray(list) || !list.length) return undefined;
  return list.map((k) => {
    const o: Obj = { t: round(k.timelinePosition), value: keyframeValue(k.value) }; // t = timeline position (s)
    const ez = motionEasing(k.easing);
    if (ez) o.easing = ez;
    return o;
  });
}

// A field->binding map (manualKeyframeTracks or animations) -> { field: {base?, op?, keyframes[]} }.
function trackMap(map: Record<string, FlatKeyframeBinding | undefined> | undefined): Obj | undefined {
  if (!map || typeof map !== "object") return undefined;
  const out: Obj = {};
  for (const field of Object.keys(map)) {
    const binding = map[field];
    if (!binding || typeof binding !== "object") continue;
    const o: Obj = {};
    if (binding.baseValue !== undefined) o.base = keyframeValue(binding.baseValue);
    if (typeof binding.keyframeOperation === "string" && binding.keyframeOperation !== "SET") o.op = binding.keyframeOperation.toLowerCase();
    const kf = keyframes(binding.keyframes);
    if (kf) o.keyframes = kf;
    putNonEmpty(out, field, o);
  }
  return nonEmpty(out);
}

// The whole motion surface on a node -> compact { timelines?, manualTracks?, animations?, styles? }.
// timelines/manualKeyframeTracks/animations/animationStyles live on MotionNodeMixin, which not every
// SceneNode variant carries — hence the `in` guards.
export function collectMotion(node: SceneNode): Obj | undefined {
  const out: Obj = {};
  if ("timelines" in node && Array.isArray(node.timelines) && node.timelines.length) {
    out.timelines = node.timelines.map((t) => ({ id: t.id, duration: round(t.duration) }));
  }
  if ("manualKeyframeTracks" in node) {
    const tracks = trackMap(node.manualKeyframeTracks as Record<string, FlatKeyframeBinding | undefined>);
    if (tracks) out.manualTracks = tracks;
  }
  if ("animations" in node) {
    const anims = trackMap(node.animations as Record<string, FlatKeyframeBinding | undefined>);
    if (anims) out.animations = anims;
  }
  if ("animationStyles" in node && Array.isArray(node.animationStyles) && node.animationStyles.length) {
    out.styles = node.animationStyles.map((s) => {
      const o: Obj = { name: s.name, styleId: s.styleId };
      if (typeof s.duration === "number") o.duration = round(s.duration);
      if (typeof s.timelineOffset === "number" && s.timelineOffset) o.timelineOffset = round(s.timelineOffset);
      return o;
    });
  }
  return nonEmpty(out);
}
