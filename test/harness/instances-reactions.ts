// Instances and prototype reactions: the selection's reacting button — main-component join keys, overrides, prop
// bindings, its ON_CLICK reaction's actions and transition — and a remote main with no parent set.
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { Case } from "./helpers.ts";
import { world } from "./scene.ts";
import { selection } from "./screen-read.ts";

export const cases: Case[] = [{
  name: "instance main component name and join keys",
  async run() {
    const { btn } = await selection();
    ok("instance main component name", btn.component === "Button");
    ok("mainComponent join keys captured (id/key)", !!(btn.mainComponent && btn.mainComponent.id === "comp:btn1" && btn.mainComponent.key === "compkey_btn"));
    ok("mainComponent set join keys captured (setId/setKey)", btn.mainComponent?.setId === "set:btn" && btn.mainComponent?.setKey === "setkey_btn");
    ok("mainComponent variant name kept separately from the set name", btn.mainComponent?.setName === "ButtonSet" && btn.mainComponent?.variant === "Button");
  },
}, {
  name: "a remote main whose `.parent` is NULL",
  async run() {
    const { api } = world();
    // A remote main whose `.parent` is NULL (plugin-api.d.ts documented shape) must not throw, and
    // must emit id/key with NO setId/setKey (there is no set to join to).
    const remoteInst = { type: "INSTANCE", name: "RemoteBtn", visible: true, getMainComponentAsync: async () => ({ name: "Icon", id: "rc:1", key: "rk:1", remote: true, parent: null }) };
    const remoteSer = await api.serialize(remoteInst, 0, false);
    ok("remote main with null parent: id/key captured, no setId/setKey", !!(remoteSer.mainComponent && remoteSer.mainComponent.id === "rc:1" && remoteSer.mainComponent.remote === true && remoteSer.mainComponent.setId === undefined));
  },
}, {
  name: "instance bound token, reactions, trigger, navigation, transition easing",
  async run() {
    const { btn } = await selection();
    ok("bound token resolved to name", !!(btn.tokens && btn.tokens.fills === "color/primary"));
    ok("reactions extracted", Array.isArray(btn.reactions) && btn.reactions.length === 1);
    const btnAct0 = must(btn.reactions?.[0]?.actions?.[0], "btn.reactions[0].actions[0]");
    ok("reaction trigger", btn.reactions?.[0]?.trigger === "on_click");
    ok("reaction navigation + destination name", btnAct0.navigation === "navigate" && btnAct0.destination === "Details");
    const btnTr = must(btnAct0.transition, "btn.reactions[0].actions[0].transition");
    ok("reaction transition easing (lowercased)", btnTr.easing === "custom_cubic_bezier");
  },
}, {
  name: "Tier 1 read additions: instance overrides, directional transition fields",
  async run() {
    const { btn } = await selection();
    const btnTr = must(must(btn.reactions?.[0]?.actions?.[0], "btn.reactions[0].actions[0]").transition, "btn.reactions[0].actions[0].transition");
    const btnOverride0 = btn.overrides?.[0];
    ok("instance overrides captured (empty filtered)", Array.isArray(btn.overrides) && btn.overrides.length === 1 && btnOverride0 !== undefined && btnOverride0.fields.indexOf("characters") !== -1);
    // matchLayers lives on DirectionalTransition only (MOVE_IN/OUT, PUSH, SLIDE_IN/OUT); SimpleTransition
    // (DISSOLVE, SMART_ANIMATE, SCROLL_ANIMATE) has no such field — developers.figma.com/docs/plugins/api/Transition/.
    ok("transition matchLayers carried", btnTr.matchLayers === true);
    ok("transition type/direction carried", btnTr.type === "move_in" && btnTr.direction === "left");
    ok("transition custom cubic-bezier carried", btnTr.easing === "custom_cubic_bezier" && must(btnTr.cubicBezier, "btnTr.cubicBezier").x1 === 0.4);
  },
}, {
  name: "READ additions (HIGH tier + MED): reaction actions",
  async run() {
    const { btn } = await selection();
    const acts = must(btn.reactions?.[0]?.actions, "btn.reactions[0].actions");
    ok("NODE action preserveScroll flag", acts[0]?.preserveScroll === true);
    ok("SET_VARIABLE resolves variable name", acts.some((a) => a.type === "set_variable" && a.variable === "color/primary"));
    ok("SET_VARIABLE_MODE resolves collection+mode names", acts.some((a) => a.type === "set_variable_mode" && a.collection === "Semantic" && a.mode === "Dark"));
    ok("UPDATE_MEDIA_RUNTIME keeps destinationId + resolved destination name",
      acts.some((a) => a.type === "update_media_runtime" && a.mediaAction === "play" && a.destinationId === "frame_2" && a.destination === "Details"));
    ok("CONDITIONAL nests actions", acts.some((a) => a.type === "conditional" && Array.isArray(a.conditionalBlocks) && a.conditionalBlocks[0]?.actions?.[0]?.destination === "Details"));
    const urlNewTab = acts.find((a) => a.type === "url" && a.url === "https://newtab.example.com");
    const urlSameTab = acts.find((a) => a.type === "url" && a.url === "https://sametab.example.com");
    ok("URL action emits openInNewTab when true", !!urlNewTab && urlNewTab.openInNewTab === true);
    ok("URL action omits openInNewTab when unset", !!urlSameTab && !("openInNewTab" in urlSameTab));
  },
}, {
  name: "instance component-prop variable binding -> propTokens",
  async run() {
    const { btn } = await selection();
    ok("instance component-prop variable binding -> propTokens", !!(btn.propTokens && btn.propTokens.Label === "color/primary"));
  },
}];
