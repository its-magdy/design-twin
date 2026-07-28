// Motion / animation reads (Plugin API Update 130, 2026-06). Keyframe/timeline VALUES are now
// readable FREE via the Plugin API — this is a new plane the paid get_motion_context used to own.
// Opt-in (runOpts.motion) because it's niche and can be verbose. Reads are defensive/`any`: the
// KeyframeValue / MotionEasing / Timeline / *KeyframeBinding types are wide unions.
import { Obj, round, rgbaToHex, easingCurve, xy } from "./util";

// A KeyframeValue (discriminated on `type`) -> a compact readable value.
// TEXT_DATA / BOOL need no transformation, so they fall through to `default` rather than restating it.
function keyframeValue(kv: any): any {
  if (!kv || typeof kv !== "object") return kv;
  switch (kv.type) {
    case "FLOAT": return round(kv.value);
    case "COLOR": return kv.value ? rgbaToHex(kv.value) : undefined;
    case "VECTOR": return kv.value ? xy(kv.value) : undefined;
    case "CIRCLE": return kv.value ? { ...xy(kv.value), radius: round(kv.value.radius) } : undefined;
    case "LINE": return kv.value ? { ...xy(kv.value), x2: round(kv.value.x2), y2: round(kv.value.y2) } : undefined;
    default: return kv.value; // newer union member — carry the raw value defensively
  }
}

// MotionEasing -> compact (mirrors the prototype-transition easing surface: named curve + exact params).
function motionEasing(ez: any): Obj | undefined {
  if (!ez || !ez.type) return undefined;
  return { type: String(ez.type).toLowerCase(), ...easingCurve(ez) };
}

function keyframes(list: any): Obj[] | undefined {
  if (!Array.isArray(list) || !list.length) return undefined;
  return list.map((k) => {
    const o: Obj = { t: round(k.timelinePosition), value: keyframeValue(k.value) }; // t = timeline position (s)
    const ez = motionEasing(k.easing);
    if (ez) o.easing = ez;
    return o;
  });
}

// A field->binding map (manualKeyframeTracks or animations) -> { field: {base?, op?, keyframes[]} }.
function trackMap(map: any): Obj | undefined {
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
    if (Object.keys(o).length) out[field] = o;
  }
  return Object.keys(out).length ? out : undefined;
}

// The whole motion surface on a node -> compact { timelines?, manualTracks?, animations?, styles? }.
export function collectMotion(node: SceneNode): Obj | undefined {
  const n = node as any;
  const out: Obj = {};
  if (Array.isArray(n.timelines) && n.timelines.length) out.timelines = n.timelines.map((t: any) => ({ id: t.id, duration: round(t.duration) }));
  const tracks = trackMap(n.manualKeyframeTracks);
  if (tracks) out.manualTracks = tracks;
  const anims = trackMap(n.animations);
  if (anims) out.animations = anims;
  if (Array.isArray(n.animationStyles) && n.animationStyles.length) {
    out.styles = n.animationStyles.map((s: any) => {
      const o: Obj = { name: s.name, styleId: s.styleId };
      if (typeof s.duration === "number") o.duration = round(s.duration);
      if (typeof s.timelineOffset === "number" && s.timelineOffset) o.timelineOffset = round(s.timelineOffset);
      return o;
    });
  }
  return Object.keys(out).length ? out : undefined;
}
