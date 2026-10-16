// Motion / animation reads (Plugin API Update 130, 2026-06). Keyframe/timeline VALUES are
// readable FREE via the Plugin API — a plane the paid get_motion_context tool otherwise covers.
// Opt-in (runOpts.motion) because it's niche and can be verbose.
import type {
  JsonValue, MotionKeyframe, MotionTrack, MotionAnimation, MotionIndexedTracks, MotionPaintTrack, MotionEffectTracks, NodeMotion,
  MotionStylePropValue, VariableAlias as IrVariableAlias,
} from "../../bridge/src/doc-types.ts";
import { round, rgbaToHex, easingCurve, xy, nonEmpty, putNonEmpty, asJson, isList } from "./util";
import { varName } from "./state";
import { ifDefined } from "../../bridge/src/json-util.ts";

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

// An alias id -> {aliasOf: target name}, falling back to the raw id when the target cannot be resolved —
// the same shape and resolution variables.ts's own (unexported) aliasValue uses for a top-level
// VARIABLE_ALIAS, via state.ts's `varName` memo (figma.variables.getVariableByIdAsync; typings 1.139
// VariablesAPI.getVariableByIdAsync(id): Promise<Variable | null> — the sync getVariableById is
// @deprecated and throws under dynamic-page).
async function aliasValue(id: string): Promise<IrVariableAlias> {
  return { aliasOf: (await varName(id)) || id };
}

// MotionEasing -> compact (mirrors the prototype-transition easing surface: named curve + exact params).
// `easing` on a keyframe is `MotionEasing | VariableAlias` (ManualKeyframe.easing — Motion supports binding
// easing to an EASING variable). Unified with variables.ts's alias form: a bound easing resolves the
// variable's NAME through the same `varName` memo and emits {aliasOf: name}, falling back to {aliasOf: id}.
async function motionEasing(ez: MotionEasing | VariableAlias | undefined): Promise<MotionKeyframe["easing"]> {
  if (!ez || !ez.type) return undefined;
  if (ez.type === "VARIABLE_ALIAS") return aliasValue(ez.id);
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
async function keyframes(list: ReadonlyArray<ManualKeyframe> | undefined): Promise<MotionKeyframe[] | undefined> {
  if (!isList(list) || !list.length) return undefined;
  return Promise.all(list.map(async (k) => {
    const o: MotionKeyframe = { t: round(k.timelinePosition), ...ifDefined("value", keyframeValue(k.value)) }; // t = timeline position (s)
    const ez = await motionEasing(k.easing);
    if (ez) o.easing = ez;
    return o;
  }));
}

// ManualKeyframeBinding -> {base?, keyframes[]}.
async function manualTrack(binding: ManualKeyframeBinding | undefined): Promise<MotionTrack | undefined> {
  if (!binding || typeof binding !== "object") return undefined;
  const o: MotionTrack = {};
  const base = keyframeValue(binding.baseValue); // undefined in, undefined out
  if (base !== undefined) o.base = base;
  const kf = await keyframes(binding.keyframes);
  if (kf) o.keyframes = kf;
  return o;
}

// KeyframeBinding -> {base?, duration?, tracks:[{op?, keyframes[]}]}.
async function animationTrack(binding: KeyframeBinding | undefined): Promise<MotionAnimation | undefined> {
  if (!binding || typeof binding !== "object") return undefined;
  const o: MotionAnimation = {};
  const base = keyframeValue(binding.baseValue); // undefined in, undefined out
  if (base !== undefined) o.base = base;
  if (typeof binding.timelineDuration === "number") o.duration = round(binding.timelineDuration);
  if (isList(binding.tracks) && binding.tracks.length) {
    o.tracks = await Promise.all(binding.tracks.map(async (t) => {
      const to: NonNullable<MotionAnimation["tracks"]>[number] = {};
      if (t.keyframeOperation === "OFFSET" || t.keyframeOperation === "SCALE") to.op = t.keyframeOperation === "OFFSET" ? "offset" : "scale";
      const kf = await keyframes(t.keyframes);
      if (kf) to.keyframes = kf;
      return to;
    }));
  }
  return o;
}

// AnimationStyleConfiguration.props value -> its compact form: a string/number/boolean value passes
// through verbatim; a MotionEasing / VariableAlias value goes through the same conversion as a
// keyframe's easing (motionEasing above).
async function stylePropValue(v: AnimationStylePropValue | undefined): Promise<MotionStylePropValue | undefined> {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "object") return motionEasing(v);
  return v;
}

// One binding -> its compact form (manualTrack / animationTrack).
type Convert<B, O> = (binding: B | undefined) => Promise<O | undefined>;
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
// Every entry is resolved in parallel (Promise.all), then written back in source order — same output
// order as the synchronous version, just with an async `conv`.
async function bindingMap<B, O extends object>(map: Partial<Record<string, B>> | undefined, conv: Convert<B, O>): Promise<Record<string, O> | undefined> {
  if (!map || typeof map !== "object") return undefined;
  const entries = Object.entries(map);
  const converted = await Promise.all(entries.map(([, binding]) => conv(binding)));
  const out: Record<string, O> = {};
  entries.forEach(([key], i) => putNonEmpty(out, key, converted[i]));
  return nonEmpty(out);
}

// fills / strokes: { index: binding | {properties: {propId: binding}} } -> { "index": track | {properties} }.
async function paintMap<B extends object, O extends object>(
  map: Partial<Record<number, B | PropertyBindings<B>>> | undefined, conv: Convert<B, O>,
): Promise<Record<string, MotionPaintTrack<O>> | undefined> {
  if (!map || typeof map !== "object") return undefined;
  const out: Record<string, MotionPaintTrack<O>> = {};
  for (const [index, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== "object") continue;
    if (isPropertyBindings(entry)) {
      const properties = await bindingMap(entry.properties, conv);
      if (properties) out[index] = { properties };
    } else {
      putNonEmpty(out, index, await conv(entry));
    }
  }
  return nonEmpty(out);
}

// effects: { index: {EffectKeyframeFieldName: binding, properties?: {propId: binding}} } -> the same, converted.
async function effectMap<B, O extends object>(
  map: Partial<Record<number, EffectBindings<B>>> | undefined, conv: Convert<B, O>,
): Promise<Record<string, MotionEffectTracks<O>> | undefined> {
  if (!map || typeof map !== "object") return undefined;
  const out: Record<string, MotionEffectTracks<O>> = {};
  for (const [index, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== "object") continue;
    const { properties, ...fields } = entry;
    const extra: { properties?: Record<string, O> } = {};
    putNonEmpty(extra, "properties", await bindingMap(properties, conv));
    putNonEmpty(out, index, Object.assign((await bindingMap(fields, conv)) ?? {}, extra));
  }
  return nonEmpty(out);
}

// A whole ManualKeyframeTracks / Animations map -> scalar fields (source order), then fills/strokes/effects.
async function motionMap<B extends object, O extends object>(
  map: MotionBindings<B> | undefined, conv: Convert<B, O>,
): Promise<(Record<string, O> & MotionIndexedTracks<O>) | undefined> {
  if (!map || typeof map !== "object") return undefined;
  const { fills, strokes, effects, ...scalars } = map;
  const indexed: MotionIndexedTracks<O> = {};
  putNonEmpty(indexed, "fills", await paintMap(fills, conv));
  putNonEmpty(indexed, "strokes", await paintMap(strokes, conv));
  putNonEmpty(indexed, "effects", await effectMap(effects, conv));
  return nonEmpty(Object.assign((await bindingMap(scalars, conv)) ?? {}, indexed));
}

// The whole motion surface on a node -> compact { timelines?, manualTracks?, animations?, styles? }.
// timelines/manualKeyframeTracks/animations/animationStyles live on MotionNodeMixin, which not every
// SceneNode variant carries — hence the `in` guards.
export async function collectMotion(node: SceneNode): Promise<NodeMotion | undefined> {
  const out: NodeMotion = {};
  if ("timelines" in node && isList(node.timelines) && node.timelines.length) {
    out.timelines = node.timelines.map((t) => ({ id: t.id, duration: round(t.duration) }));
  }
  if ("manualKeyframeTracks" in node) {
    const tracks = await motionMap(node.manualKeyframeTracks, manualTrack);
    if (tracks) out.manualTracks = tracks;
  }
  if ("animations" in node) {
    const anims = await motionMap(node.animations, animationTrack);
    if (anims) out.animations = anims;
  }
  if ("animationStyles" in node && isList(node.animationStyles) && node.animationStyles.length) {
    out.styles = await Promise.all(node.animationStyles.map(async (s) => {
      const o: NonNullable<NodeMotion["styles"]>[number] = { id: s.id, name: s.name, styleId: s.styleId };
      if (typeof s.duration === "number") o.duration = round(s.duration);
      if (typeof s.timelineOffset === "number" && s.timelineOffset) o.timelineOffset = round(s.timelineOffset);
      if (s.props) {
        const entries = Object.entries(s.props);
        const converted = await Promise.all(entries.map(([, v]) => stylePropValue(v)));
        const props: Record<string, MotionStylePropValue> = {};
        entries.forEach(([key], i) => {
          const c = converted[i];
          if (c !== undefined) props[key] = c;
        });
        if (Object.keys(props).length) o.props = props;
      }
      return o;
    }));
  }
  return nonEmpty(out);
}
