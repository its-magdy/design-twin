// Text: the selection's mixed-style heading — styled runs, fonts, decorations, links, run-level styles and tokens,
// alignment/auto-resize/truncation, prop-driven characters.
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { Case } from "./helpers.ts";
import { selection } from "./screen-read.ts";

export const cases: Case[] = [{
  name: "text mixed -> styled runs, fonts, decoration, href; [RUN-FIELDS] byte-identical",
  async run() {
    const { txt } = await selection();
    ok("text mixed -> runs[] with 2", Array.isArray(txt.runs) && txt.runs.length === 2);
    ok("text run weight verbatim (Bold)", txt.runs?.[1]?.font.weight === "Bold");
    ok("text run numeric weight from segment fontWeight", txt.runs?.[1]?.font.weightValue === 700);
    // FontName.variationSettings (Update 138): a segment's variable font axis values are carried on
    // its run's font; a segment/node without them must not have the key at all.
    ok("text run variationSettings carried when the segment's fontName has them", JSON.stringify(txt.runs?.[1]?.font.variationSettings) === '{"wght":600}');
    ok("text run without variationSettings has no such key", !("variationSettings" in must(txt.runs?.[0], "txt.runs[0]").font));
    ok("node-level font has no variationSettings (fontName carries none)", !("variationSettings" in must(txt.font, "txt.font")));
    ok("text run underline decoration", txt.runs?.[1]?.font.decoration === "underline");
    ok("text run href", txt.runs?.[1]?.href === "https://x.com");
    ok("lineHeight unit carried (percent)", !!(txt.font?.lineHeight && txt.font?.lineHeight.unit === "percent"));
    ok("letterSpacing unit carried (px)", !!(txt.font?.letterSpacing && txt.font?.letterSpacing.unit === "px"));
    ok("paragraphSpacing", txt.font?.paragraphSpacing === 8);
    // [RUN-FIELDS] the segments above now also carry fontStyle REGULAR, a uniform paragraphSpacing/Indent
    // and an empty textStyleOverrides — every run must be byte-identical to the output before those four
    // fields were requested (the exact JSON the extractor produced at d9d8e71).
    ok("[RUN-FIELDS] REGULAR fontStyle / uniform paragraph spacing / empty overrides on segments: runs byte-identical to before",
      JSON.stringify(txt.runs) === '[{"text":"Hello ","font":{"size":24,"family":"Inter","weight":"Regular","lineHeight":{"value":120,"unit":"percent"},"letterSpacing":{"value":0.5,"unit":"px"},"color":"#000000"}},' +
        '{"text":"World","font":{"size":24,"family":"Inter","weight":"Bold","variationSettings":{"wght":600},"weightValue":700,"lineHeight":{"value":120,"unit":"percent"},"letterSpacing":{"value":0.5,"unit":"px"},' +
        '"decoration":"underline","decorationThickness":{"value":2,"unit":"px"},"decorationOffset":{"value":1,"unit":"px"},"decorationSkipInk":false,"openType":["SMCP"],"color":"#1a4de6"},' +
        '"href":"https://x.com","indent":1,"textStyle":"Heading/H1","fillStyle":"Brand/Primary","tokens":{"fills":"color/primary"}}]' &&
      JSON.stringify(txt.font) === '{"size":24,"family":"Inter","weight":"Regular","lineHeight":{"value":120,"unit":"percent"},"letterSpacing":{"value":0.5,"unit":"px"},"color":"#000000","align":"left","paragraphSpacing":8,"valign":"center"}' &&
      !("textStyleOverrides" in txt));
  },
}, {
  name: "new READ additions (Batch: close the read gap): id, valign, autoResize, truncate, maxLines",
  async run() {
    const { txt } = await selection();
    ok("node id captured", txt.id === "1:1");
    ok("text vertical align", txt.font?.valign === "center");
    ok("text autoResize", txt.autoResize === "height");
    ok("text truncate -> ellipsis", txt.truncate === true);
    ok("text maxLines (line-clamp)", txt.maxLines === 2);
  },
}, {
  name: "Tier 1 read additions: prop-driven text, run token binding",
  async run() {
    const { txt } = await selection();
    ok("componentPropertyReferences -> propRefs (stripped)", !!(txt.propRefs && txt.propRefs.characters === "Label"));
    ok("text run bound variable -> token name", !!(txt.runs?.[1]?.tokens && txt.runs?.[1]?.tokens.fills === "color/primary"));
  },
}, {
  name: "READ additions (HIGH tier + MED): per-run styles, openType, list indentation",
  async run() {
    const { txt } = await selection();
    ok("per-run textStyle resolved", txt.runs?.[1]?.textStyle === "Heading/H1");
    ok("per-run fillStyle resolved", txt.runs?.[1]?.fillStyle === "Brand/Primary");
    ok("per-run openType features (enabled only)", Array.isArray(txt.runs?.[1]?.font.openType) && txt.runs?.[1]?.font.openType?.indexOf("SMCP") !== -1 && txt.runs?.[1]?.font.openType?.indexOf("LIGA") === -1);
    ok("per-run list indentation level", txt.runs?.[1]?.indent === 1);
  },
}, {
  name: "READ additions (2026-07-23 doc audit): text decoration thickness / offset / skip-ink",
  async run() {
    const { txt } = await selection();
    // textDecorationThickness/Offset are { value:number, unit } — .value IS the number (not .value.value, which would always drop it).
    ok("text decoration thickness (value+unit)", !!(txt.runs?.[1]?.font.decorationThickness && txt.runs?.[1]?.font.decorationThickness.value === 2 && txt.runs?.[1]?.font.decorationThickness.unit === "px"));
    ok("text decoration offset (value+unit)", !!(txt.runs?.[1]?.font.decorationOffset && txt.runs?.[1]?.font.decorationOffset.value === 1));
    ok("text decoration skip-ink (only when false)", txt.runs?.[1]?.font.decorationSkipInk === false);
  },
}];
