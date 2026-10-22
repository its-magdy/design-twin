// Motion (Plugin API Update 130), opt-in via {motion:true}: timelines, manual keyframe tracks, animations, and
// applied animation styles of every kind (FIGMA, CUSTOM expanded from the style its styleId resolves to, kinds newer
// than the typings).
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { Case } from "./helpers.ts";
import { CAS1_ENTRIES } from "./scene.ts";
import { selection } from "./screen-read.ts";

export const cases: Case[] = [{
  name: "motion: off by default, then the opt-in read",
  async run() {
    const { w, tree } = await selection();
    ok("motion off by default", tree.motion === undefined);
    // The fetch counter counts the motion run's cas1 lookups alone.
    w.fx.counts.customStyleFetches = 0;
    const sel3 = await w.api.collectSelection({ motion: true });
    const m3 = must(sel3.screen.nodes[0], "sel3.screen.nodes[0]").motion;
    ok("motion timelines captured (opt-in)", !!(m3 && Array.isArray(m3.timelines) && m3.timelines[0]?.duration === 0.5));
    const tx = m3?.manualTracks?.TRANSLATION_X;
    ok("motion keyframe track: base + keyframes + values", !!(tx && tx.base === 0 && tx.keyframes?.[1]?.value === 100));
    const tx1Easing = tx?.keyframes?.[1]?.easing;
    ok("motion keyframe custom cubic-bezier easing carried", !!(tx1Easing && "cubicBezier" in tx1Easing && tx1Easing.cubicBezier.x1 === 0.4));
    const style0 = m3?.styles?.[0];
    ok("motion applied animation style captured", !!(style0 && style0.name === "Fade In" && style0.duration === 0.3));
    ok("motion applied animation style carries the applied instance id", !!(style0 && style0.id === "applied1"));
    ok("motion applied animation style props: number value carried verbatim", !!(style0 && style0.props && style0.props.distance === 24));
    ok("motion applied animation style props: MotionEasing value converted like a keyframe easing",
      JSON.stringify(style0 && style0.props && style0.props.easing) === '{"type":"ease_out"}');
    ok("motion applied animation style props: VariableAlias value resolves to {aliasOf: <variable name>} (unified with variables.ts)",
      JSON.stringify(style0 && style0.props && style0.props.color) === '{"aliasOf":"easing/emphasized"}');
    ok("motion applied animation style without a `type` reads as FIGMA (byte-identical, no custom marker)", JSON.stringify(style0) ===
      '{"id":"applied1","name":"Fade In","styleId":"as1","duration":0.3,"props":{"distance":24,"easing":{"type":"ease_out"},"color":{"aliasOf":"easing/emphasized"}}}');
    ok("motion applied animation style type FIGMA: duration, timelineOffset, props (no custom marker)", JSON.stringify(m3?.styles?.[1]) ===
      '{"id":"applied2","name":"Slide Up","styleId":"as2","duration":0.45,"timelineOffset":0.1,"props":{"distance":16}}');
    ok("motion applied animation style type CUSTOM: ids, name, custom marker, timelineOffset, then the resolved style's description + entries", JSON.stringify(m3?.styles?.[2]) ===
      '{"id":"applied3","name":"Brand Entrance","styleId":"cas1","custom":true,"timelineOffset":0.25,"description":"Hero entrance sequence","entries":[' + CAS1_ENTRIES + ']}');
    ok("motion CUSTOM style whose styleId resolves to nothing: the applied row only", JSON.stringify(m3?.styles?.[3]) ===
      '{"id":"applied4","name":"Gone","styleId":"cas_missing","custom":true}');
    ok("motion CUSTOM style whose styleId resolves to a non-animation style: the applied row only", JSON.stringify(m3?.styles?.[4]) ===
      '{"id":"applied5","name":"Wrong Kind","styleId":"s_accent","custom":true}');
    ok("motion CUSTOM style whose lookup throws: the applied row only (timelineOffset kept)", JSON.stringify(m3?.styles?.[5]) ===
      '{"id":"applied6","name":"Lookup Throws","styleId":"cas_throw","custom":true,"timelineOffset":0.5}');
    ok("motion CUSTOM style whose animationEntries read throws: no entries, empty description dropped", JSON.stringify(m3?.styles?.[6]) ===
      '{"id":"applied7","name":"Broken","styleId":"cas_broken","custom":true}');
    ok("motion CUSTOM style applied twice: both rows expanded, the style fetched once per run", JSON.stringify(m3?.styles?.[7]) ===
      '{"id":"applied8","name":"Brand Entrance","styleId":"cas1","custom":true,"description":"Hero entrance sequence","entries":[' + CAS1_ENTRIES + ']}' &&
      w.fx.counts.customStyleFetches === 1);
    ok("motion CUSTOM style whose animationEntries list is empty: entries: [] (read and empty, distinct from the unreadable row above)", JSON.stringify(m3?.styles?.[8]) ===
      '{"id":"applied9","name":"Empty","styleId":"cas_empty","custom":true,"entries":[]}');
    ok("motion applied animation style of an unknown kind: ids, name, the lower-cased kind, timelineOffset; no duration/props", JSON.stringify(m3?.styles?.[9]) ===
      '{"id":"applied10","name":"Bounce","styleId":"as3","kind":"spring","timelineOffset":0.5}');
    ok("motion unknown-kind style: an id, name or styleId that is not a string is not exported, a zero offset is omitted", JSON.stringify(m3?.styles?.[10]) ===
      '{"kind":"morph"}');
    ok("motion applied FIGMA animation style: description exported after styleId", JSON.stringify(m3?.styles?.[11]) ===
      '{"id":"applied12","name":"Pop","styleId":"as4","description":"Scales in with a bounce","duration":0.2}');
    ok("motion applied FIGMA animation style: an empty description is dropped", JSON.stringify(m3?.styles?.[12]) ===
      '{"id":"applied13","name":"Plain","styleId":"as5","duration":0.1}');
    ok("motion applied animation style with an empty type: exported as a FIGMA row, no kind", JSON.stringify(m3?.styles?.[13]) ===
      '{"id":"applied14","name":"Blank","styleId":"as6","duration":0.1}');
    const rotTrack = m3?.animations?.ROTATION;
    ok("motion animations: base + duration + per-track op/keyframes surface (not dead)",!!(
      rotTrack && rotTrack.base === 0 && rotTrack.duration === 1.2 &&
      rotTrack.tracks?.[0]?.op === "offset" && rotTrack.tracks?.[0]?.keyframes?.[1]?.value === 90));
    // Indexed collections (fills/strokes keyed by paint index, effects by effect index) come out
    // whole, not empty — each value is read as its own binding, not as one — and are not dropped. Pin each shape.
    const mt = must(m3?.manualTracks, "m3.manualTracks");
    ok("motion scalar track output unchanged (TRANSLATION_X, byte-identical)", JSON.stringify(mt.TRANSLATION_X) ===
      '{"base":0,"keyframes":[{"t":0,"value":0,"easing":{"type":"ease_out"}},{"t":0.5,"value":100,"easing":{"type":"custom_cubic_bezier","cubicBezier":{"x1":0.4,"y1":0,"x2":0.2,"y2":1}}}]}');
    const f0 = mt.fills?.["0"];
    ok("motion manualTracks.fills[\"0\"]: base + 2 keyframes", !!(f0 && !("properties" in f0) && f0.base === "#ff0000" &&
      f0.keyframes?.length === 2 && f0.keyframes?.[1]?.value === "#0000ff" && f0.keyframes?.[1]?.t === 1));
    ok("motion keyframe easing bound to an unresolvable variable id falls back to {aliasOf: <id>} (VariableID:1 is not in VARS)",
      JSON.stringify(f0 && !("properties" in f0) && f0.keyframes?.[1]?.easing) === '{"aliasOf":"VariableID:1"}');
    const f1 = mt.fills?.["1"];
    const f1Speed = f1 && "properties" in f1 ? f1.properties["shader:speed"] : undefined;
    ok("motion manualTracks.fills shader track under properties", !!(f1Speed && f1Speed.base === 1 && f1Speed.keyframes?.[1]?.value === 3));
    const s0 = mt.strokes?.["0"];
    const s0Easing = s0 && !("properties" in s0) && s0.keyframes?.[0]?.easing;
    ok("motion manualTracks.strokes[\"0\"] track", !!(s0 && !("properties" in s0) && s0.base === 0 &&
      s0.keyframes?.length === 1 && s0.keyframes?.[0]?.value === 0.5 && s0Easing && "type" in s0Easing && s0Easing.type === "ease_in"));
    const e0 = mt.effects?.["0"];
    const e0Radius = e0?.RADIUS;
    ok("motion manualTracks.effects[\"0\"].RADIUS track", !!(e0Radius && e0Radius.base === 4 && e0Radius.keyframes?.length === 2 && e0Radius.keyframes?.[1]?.value === 12));
    const e0GlowShader = e0?.properties?.["shader:glow"];
    ok("motion manualTracks.effects[\"0\"].properties shader track", !!(e0GlowShader && e0GlowShader.keyframes?.[0]?.value === 0.8));
    const an = must(m3?.animations, "m3.animations");
    ok("motion animations scalar output unchanged (ROTATION, byte-identical)", JSON.stringify(an.ROTATION) ===
      '{"base":0,"duration":1.2,"tracks":[{"op":"offset","keyframes":[{"t":0,"value":0},{"t":1,"value":90}]}]}');
    const af0 = an.fills?.["0"];
    ok("motion animations.fills[\"0\"]: base + duration + op track", !!(af0 && !("properties" in af0) && af0.base === 1 && af0.duration === 0.8 &&
      af0.tracks?.[0]?.op === "scale" && af0.tracks?.[0]?.keyframes?.[1]?.value === 0.5));
    const af2 = an.fills?.["2"];
    const af2Phase = af2 && "properties" in af2 ? af2.properties["shader:phase"] : undefined;
    // must() only once duration matched — an && chain would never reach `tracks` otherwise
    const af2PhaseTrack0 = af2Phase && af2Phase.duration === 3 ? must(af2Phase.tracks, "af2 shader:phase tracks")[0] : undefined;
    ok("motion animations.fills shader track under properties (SET op omitted)", !!(af2Phase && af2Phase.duration === 3 &&
      af2PhaseTrack0 && af2PhaseTrack0.op === undefined && af2PhaseTrack0.keyframes?.[0]?.value === 6));
    const as1 = an.strokes?.["1"];
    ok("motion animations.strokes[\"1\"] track", !!(as1 && !("properties" in as1) && as1.tracks?.[0]?.op === "offset" && as1.tracks?.[0]?.keyframes?.[0]?.value === 3));
    const ae0 = an.effects?.["0"];
    const ae0OffsetY = ae0?.OFFSET_Y;
    ok("motion animations.effects[\"0\"].OFFSET_Y track", !!(ae0OffsetY && ae0OffsetY.duration === 0.6 && ae0OffsetY.tracks?.[0]?.keyframes?.[1]?.value === 8));
    ok("motion indexed collections follow the scalar fields", JSON.stringify(Object.keys(mt)) === '["TRANSLATION_X","fills","strokes","effects"]' &&
      JSON.stringify(Object.keys(an)) === '["ROTATION","fills","strokes","effects"]');
  },
}];
