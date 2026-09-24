// Motion / animation reads (Plugin API Update 130, 2026-06). Keyframe/timeline VALUES are now
// readable FREE via the Plugin API — this is a new plane the paid get_motion_context used to own.
// Opt-in (runOpts.motion) because it's niche and can be verbose.
import type {
  JsonValue, MotionKeyframe, MotionTrack, MotionAnimation, MotionIndexedTracks, MotionPaintTrack, MotionEffectTracks, NodeMotion,
  MotionStylePropValue,
} from "../../bridge/src/doc-types.ts";
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
// `easing` on a keyframe is `MotionEasing | VariableAlias` (ManualKeyframe.easing — Motion supports binding
// easing to an EASING variable). A VariableAlias carries only {type:'VARIABLE_ALIAS', id}, so the id is
// what identifies the easing: emit it. The variable's NAME would need the async varName memo and this
// collector is synchronous, so a consumer resolves the id against the variables dump.
function motionEasing(ez: MotionEasing | VariableAlias | undefined): MotionKeyframe["easing"] {
  if (!ez || !ez.type) return undefined;
  if (ez.type === "VARIABLE_ALIAS") return { type: "variable_alias", id: ez.id };
  return { type: String(ez.type).toLowerCase(), ...easingCurve(ez) };
}

// Confirmed against https://developers.figma.com/docs/plugins/api/Motion/ and
// node_modules/@figma/plugin-typings/plugin-api.d.ts (ManualKeyframeTracks / Animations, ~L6084-6134):
// - a scalar field (KeyframePropertyFieldName: TRANSLATION_X, OPACITY, …) maps to ONE binding;
// - `fills` / `strokes` map a paint INDEX to a PaintManualKeyframeTrack / PaintKeyframeBinding — either one
//   binding for the whole paint, or `{properties: {shaderPropId: binding}}` for a shader paint;
// - `effects` maps an effect INDEX to `{EffectKeyframeFieldName: binding, properties?: {shaderPropId: binding}}`.
// manualKeyframeTracks bindings are ManualKeyframeBinding = {id, baseValue, keyframes: ManualKeyframe[]}
// (no keyframeOperation at this level); animations bindings are KeyframeBinding = {baseValue,
// timelineDuration, tracks: ManualKeyframeTrack[]} where EACH track carries {id, keyframeOperation,
// keyframes} one level deeper. manualTracks emits `{base, keyframes}`; animations emits `{base, duration,
// tracks: [{op?, keyframes}]}`. The pre-fix read treated fills/strokes/effects as one binding each, so
// their index-keyed tracks came out empty and were dropped.
function keyframes(list: ReadonlyArray<ManualKeyframe> | undefined): MotionKeyframe[] | undefined {
  if (!isList(list) || !list.length) return undefined;
  return list.map((k) => {
    const o: MotionKeyframe = { t: round(k.timelinePosition), value: keyframeValue(k.value) }; // t = timeline position (s)
    const ez = motionEasing(k.easing);
    if (ez) o.easing = ez;
    return o;
  });
}

// ManualKeyframeBinding -> {base?, keyframes[]}.
function manualTrack(binding: ManualKeyframeBinding | undefined): MotionTrack | undefined {
  if (!binding || typeof binding !== "object") return undefined;
  const o: MotionTrack = {};
  if (binding.baseValue !== undefined) o.base = keyframeValue(binding.baseValue);
  const kf = keyframes(binding.keyframes);
  if (kf) o.keyframes = kf;
  return o;
}

// KeyframeBinding -> {base?, duration?, tracks:[{op?, keyframes[]}]}.
function animationTrack(binding: KeyframeBinding | undefined): MotionAnimation | undefined {
  if (!binding || typeof binding !== "object") return undefined;
  const o: MotionAnimation = {};
  if (binding.baseValue !== undefined) o.base = keyframeValue(binding.baseValue);
  if (typeof binding.timelineDuration === "number") o.duration = round(binding.timelineDuration);
  if (isList(binding.tracks) && binding.tracks.length) {
    o.tracks = binding.tracks.map((t) => {
      const to: NonNullable<MotionAnimation["tracks"]>[number] = {};
      if (t.keyframeOperation === "OFFSET" || t.keyframeOperation === "SCALE") to.op = t.keyframeOperation === "OFFSET" ? "offset" : "scale";
      const kf = keyframes(t.keyframes);
      if (kf) to.keyframes = kf;
      return to;
    });
  }
  return o;
}

// AnimationStyleConfiguration.props value -> its compact form: a string/number/boolean value passes
// through verbatim; a MotionEasing / VariableAlias value goes through the same conversion as a
// keyframe's easing (motionEasing above).
function stylePropValue(v: AnimationStylePropValue | undefined): MotionStylePropValue | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "object") return motionEasing(v);
  return v;
}

// One binding -> its compact form (manualTrack / animationTrack).
type Convert<B, O> = (binding: B | undefined) => O | undefined;
// The typings' input shapes, generic over the binding type so ManualKeyframeTracks (ManualKeyframeBinding)
// and Animations (KeyframeBinding) share one reader.
// - PaintManualKeyframeTrack / PaintKeyframeBinding's shader-property member:
interface PropertyBindings<B> { readonly properties: Partial<Record<string, B>> }
// - EffectManualKeyframeTracks / EffectKeyframeBindings:
type EffectBindings<B> = Partial<Record<EffectKeyframeFieldName, B>> & { readonly properties?: Partial<Record<string, B>> };
// - ManualKeyframeTracks / Animations:
type MotionBindings<B> = Partial<Record<KeyframePropertyFieldName, B>> & {
  readonly fills?: Partial<Record<number, B | PropertyBindings<B>>>;
  readonly strokes?: Partial<Record<number, B | PropertyBindings<B>>>;
  readonly effects?: Partial<Record<number, EffectBindings<B>>>;
};

// A plain binding (ManualKeyframeBinding / KeyframeBinding) never has a `properties` member, so its
// presence is the discriminant between the two PaintManualKeyframeTrack / PaintKeyframeBinding members.
function isPropertyBindings<B extends object>(t: B | PropertyBindings<B>): t is PropertyBindings<B> {
  return "properties" in t;
}

// { key: binding } -> { key: converted }, empty entries dropped (scalar fields, shader properties, effect fields).
function bindingMap<B, O extends object>(map: Partial<Record<string, B>> | undefined, conv: Convert<B, O>): Record<string, O> | undefined {
  if (!map || typeof map !== "object") return undefined;
  const out: Record<string, O> = {};
  for (const [key, binding] of Object.entries(map)) putNonEmpty(out, key, conv(binding));
  return nonEmpty(out);
}

// fills / strokes: { index: binding | {properties: {propId: binding}} } -> { "index": track | {properties} }.
function paintMap<B extends object, O extends object>(
  map: Partial<Record<number, B | PropertyBindings<B>>> | undefined, conv: Convert<B, O>,
): Record<string, MotionPaintTrack<O>> | undefined {
  if (!map || typeof map !== "object") return undefined;
  const out: Record<string, MotionPaintTrack<O>> = {};
  for (const [index, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== "object") continue;
    if (isPropertyBindings(entry)) {
      const properties = bindingMap(entry.properties, conv);
      if (properties) out[index] = { properties };
    } else {
      putNonEmpty(out, index, conv(entry));
    }
  }
  return nonEmpty(out);
}

// effects: { index: {EffectKeyframeFieldName: binding, properties?: {propId: binding}} } -> the same, converted.
function effectMap<B, O extends object>(
  map: Partial<Record<number, EffectBindings<B>>> | undefined, conv: Convert<B, O>,
): Record<string, MotionEffectTracks<O>> | undefined {
  if (!map || typeof map !== "object") return undefined;
  const out: Record<string, MotionEffectTracks<O>> = {};
  for (const [index, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== "object") continue;
    const { properties, ...fields } = entry;
    const extra: { properties?: Record<string, O> } = {};
    putNonEmpty(extra, "properties", bindingMap(properties, conv));
    putNonEmpty(out, index, Object.assign(bindingMap(fields, conv) ?? {}, extra));
  }
  return nonEmpty(out);
}

// A whole ManualKeyframeTracks / Animations map -> scalar fields (source order), then fills/strokes/effects.
function motionMap<B extends object, O extends object>(
  map: MotionBindings<B> | undefined, conv: Convert<B, O>,
): (Record<string, O> & MotionIndexedTracks<O>) | undefined {
  if (!map || typeof map !== "object") return undefined;
  const { fills, strokes, effects, ...scalars } = map;
  const indexed: MotionIndexedTracks<O> = {};
  putNonEmpty(indexed, "fills", paintMap(fills, conv));
  putNonEmpty(indexed, "strokes", paintMap(strokes, conv));
  putNonEmpty(indexed, "effects", effectMap(effects, conv));
  return nonEmpty(Object.assign(bindingMap(scalars, conv) ?? {}, indexed));
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
    const tracks = motionMap(node.manualKeyframeTracks, manualTrack);
    if (tracks) out.manualTracks = tracks;
  }
  if ("animations" in node) {
    const anims = motionMap(node.animations, animationTrack);
    if (anims) out.animations = anims;
  }
  if ("animationStyles" in node && isList(node.animationStyles) && node.animationStyles.length) {
    out.styles = node.animationStyles.map((s) => {
      const o: NonNullable<NodeMotion["styles"]>[number] = { id: s.id, name: s.name, styleId: s.styleId };
      if (typeof s.duration === "number") o.duration = round(s.duration);
      if (typeof s.timelineOffset === "number" && s.timelineOffset) o.timelineOffset = round(s.timelineOffset);
      if (s.props) {
        const props: Record<string, MotionStylePropValue> = {};
        for (const [key, v] of Object.entries(s.props)) {
          const converted = stylePropValue(v);
          if (converted !== undefined) props[key] = converted;
        }
        if (Object.keys(props).length) o.props = props;
      }
      return o;
    });
  }
  return nonEmpty(out);
}
