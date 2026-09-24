// Motion / animation reads (Plugin API Update 130, 2026-06). Keyframe/timeline VALUES are now
// readable FREE via the Plugin API — this is a new plane the paid get_motion_context used to own.
// Opt-in (runOpts.motion) because it's niche and can be verbose.
import type { JsonValue, MotionKeyframe, MotionTrack, MotionAnimation, NodeMotion } from "../../bridge/src/doc-types.ts";
import { round, rgbaToHex, easingCurve, xy, nonEmpty, putNonEmpty, asJson, isList } from "./util";

// A KeyframeValue (discriminated on `type`) -> a compact readable value. The switch is exhaustive over
// the typings' union (lint: switch-exhaustiveness-check) so a new member is a compile-time prompt; the
// `default` still carries the raw value of a runtime-only newer member rather than dropping it.
function keyframeValue(kv: KeyframeValue | undefined | null): JsonValue | undefined {
  if (!kv || typeof kv !== "object") return kv;
  switch (kv.type) {
    case "FLOAT": return round(kv.value);
    case "COLOR": return kv.value ? rgbaToHex(kv.value) : undefined;
    case "VECTOR": return kv.value ? { ...xy(kv.value) } : undefined;
    case "CIRCLE": return kv.value ? { ...xy(kv.value), radius: round(kv.value.radius) } : undefined;
    case "LINE": return kv.value ? { ...xy(kv.value), x2: round(kv.value.x2), y2: round(kv.value.y2) } : undefined;
    case "BOOL":
    case "TEXT_DATA":
    case "CIRCLE_POINT":
      return kv.value; // no transformation needed
    // RGBA is an interface (no index signature), so the colour is re-spread into a plain object literal —
    // same keys, same order, same JSON.
    case "COLOR_POINT": {
      const cp = kv.value;
      return cp ? { ...cp, color: { ...cp.color } } : asJson(cp);
    }
    default: {
      const unknownMember: { value?: unknown } = kv; // `never` here; a newer runtime-only member at run time
      return asJson(unknownMember.value);
    }
  }
}

// MotionEasing -> compact (mirrors the prototype-transition easing surface: named curve + exact params).
// `easing` on a keyframe is `MotionEasing | VariableAlias` (Motion supports binding easing to an EASING
// variable) — a VariableAlias has only {type:'VARIABLE_ALIAS', id}, so it falls through with no curve
// params, same as an unrecognised MotionEasing would.
function motionEasing(ez: MotionEasing | VariableAlias | undefined): MotionKeyframe["easing"] {
  if (!ez || !ez.type) return undefined;
  const curve = ez.type === "VARIABLE_ALIAS" ? {} : easingCurve(ez);
  return { type: String(ez.type).toLowerCase(), ...curve };
}

// Confirmed against https://developers.figma.com/docs/plugins/api/Motion/ (fetched during this port)
// and node_modules/@figma/plugin-typings/plugin-api.d.ts ~L5959-6000: manualKeyframeTracks values are
// ManualKeyframeBinding = {id, baseValue, keyframes: ManualKeyframe[]} directly (no keyframeOperation
// at this level), while animations values are KeyframeBinding = {baseValue, timelineDuration,
// tracks: ManualKeyframeTrack[]} where EACH ManualKeyframeTrack carries {id, keyframeOperation,
// keyframes: ManualKeyframe[]} one level deeper. The old flat read's `keyframeOperation` was dead for
// BOTH maps and its `keyframes` was dead for `animations` specifically — fixed below (behaviour change,
// not a rename): manualTracks keeps `{base, keyframes}`; animations now emits `{base, duration, tracks:
// [{op?, keyframes}]}` so its per-track keyframes/keyframeOperation actually surface.
interface FlatKeyframe {
  timelinePosition: number;
  value: KeyframeValue;
  easing?: MotionEasing | VariableAlias;
}
interface ManualBinding {
  baseValue?: KeyframeValue;
  keyframes?: ReadonlyArray<FlatKeyframe>;
}
interface KeyframeTrack {
  keyframeOperation?: "SET" | "OFFSET" | "SCALE";
  keyframes?: ReadonlyArray<FlatKeyframe>;
}
interface AnimationBinding {
  baseValue?: KeyframeValue;
  timelineDuration?: number;
  tracks?: ReadonlyArray<KeyframeTrack>;
}

function keyframes(list: ReadonlyArray<FlatKeyframe> | undefined): MotionKeyframe[] | undefined {
  if (!isList(list) || !list.length) return undefined;
  return list.map((k) => {
    const o: MotionKeyframe = { t: round(k.timelinePosition), value: keyframeValue(k.value) }; // t = timeline position (s)
    const ez = motionEasing(k.easing);
    if (ez) o.easing = ez;
    return o;
  });
}

// manualKeyframeTracks -> { field: {base?, keyframes[]} }.
function manualTrackMap(map: Record<string, ManualBinding | undefined> | undefined): Record<string, MotionTrack> | undefined {
  if (!map || typeof map !== "object") return undefined;
  const out: Record<string, MotionTrack> = {};
  for (const field of Object.keys(map)) {
    const binding = map[field];
    if (!binding || typeof binding !== "object") continue;
    const o: MotionTrack = {};
    if (binding.baseValue !== undefined) o.base = keyframeValue(binding.baseValue);
    const kf = keyframes(binding.keyframes);
    if (kf) o.keyframes = kf;
    putNonEmpty(out, field, o);
  }
  return nonEmpty(out);
}

// animations -> { field: {base?, duration?, tracks:[{op?, keyframes[]}]} }.
function animationsMap(map: Record<string, AnimationBinding | undefined> | undefined): Record<string, MotionAnimation> | undefined {
  if (!map || typeof map !== "object") return undefined;
  const out: Record<string, MotionAnimation> = {};
  for (const field of Object.keys(map)) {
    const binding = map[field];
    if (!binding || typeof binding !== "object") continue;
    const o: MotionAnimation = {};
    if (binding.baseValue !== undefined) o.base = keyframeValue(binding.baseValue);
    if (typeof binding.timelineDuration === "number") o.duration = round(binding.timelineDuration);
    if (isList(binding.tracks) && binding.tracks.length) {
      const tracks = binding.tracks.map((t) => {
        const to: NonNullable<MotionAnimation["tracks"]>[number] = {};
        if (typeof t.keyframeOperation === "string" && t.keyframeOperation !== "SET") to.op = t.keyframeOperation.toLowerCase();
        const kf = keyframes(t.keyframes);
        if (kf) to.keyframes = kf;
        return to;
      });
      if (tracks.length) o.tracks = tracks;
    }
    putNonEmpty(out, field, o);
  }
  return nonEmpty(out);
}

// The whole motion surface on a node -> compact { timelines?, manualTracks?, animations?, styles? }.
// timelines/manualKeyframeTracks/animations/animationStyles live on MotionNodeMixin, which not every
// SceneNode variant carries — hence the `in` guards.
export function collectMotion(node: SceneNode): NodeMotion | undefined {
  const out: NodeMotion = {};
  if ("timelines" in node && isList(node.timelines) && node.timelines.length) {
    out.timelines = node.timelines.map((t) => ({ id: t.id, duration: round(t.duration) }));
  }
  if ("manualKeyframeTracks" in node) {
    const tracks = manualTrackMap(node.manualKeyframeTracks);
    if (tracks) out.manualTracks = tracks;
  }
  if ("animations" in node) {
    const anims = animationsMap(node.animations);
    if (anims) out.animations = anims;
  }
  if ("animationStyles" in node && isList(node.animationStyles) && node.animationStyles.length) {
    out.styles = node.animationStyles.map((s) => {
      const o: NonNullable<NodeMotion["styles"]>[number] = { name: s.name, styleId: s.styleId };
      if (typeof s.duration === "number") o.duration = round(s.duration);
      if (typeof s.timelineOffset === "number" && s.timelineOffset) o.timelineOffset = round(s.timelineOffset);
      return o;
    });
  }
  return nonEmpty(out);
}
