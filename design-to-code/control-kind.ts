// control-kind.ts — which kind of control a layer NAME says it is. Pure name rules, shared by audit.ts
// (component states, field checks, non-text-contrast) and cross-check.ts (the token-pair table's stroke
// rows), which cannot import audit.ts (audit.ts imports cross-check.ts).
import type { ComponentPropValues, ControlKind, MainComponentRef } from "./types.ts";

const TOGGLE_WORD = /\b(checkbox|check box|radio|switch|toggle)\b/i;
function controlKind(name: unknown): ControlKind | null {
  const s = String(name || "");
  const toggle = TOGGLE_WORD.test(s);
  // a select is not a text input — its open list is a state of its own. Checked before inputs: "Select Field"
  // is one. A toggle word wins ("Select All Checkbox", "Dropdown Switch"), and "Select All" names an action, not a list.
  if (!toggle && /\b(select|dropdown|drop ?down|combo ?box|multi-?select|picker)\b/i.test(s.replace(/\bselect ?all\b/gi, ""))) return "select";
  if (/\b(input|text ?field|textfield|search|textarea)\b/i.test(s)) return "input";
  if (toggle) return "toggle";
  if (/\b(tab|tabs|segmented|nav ?item|navigation item)\b/i.test(s)) return "tab";
  if (/\blink\b/i.test(s)) return "link";
  if (/\b(button|btn|cta|icon ?button|chip)\b/i.test(s)) return "button";
  return null;
}

/** A layer as the boundary rule reads it: its own name, its main component's set name, its component name. */
export interface NamedLayer { name?: string; type?: string; mainComponent?: MainComponentRef; component?: string }
const isBoundaryKind = (a: NamedLayer): boolean =>
  [a.name, a.mainComponent && a.mainComponent.setName, a.component].some((l) => { const k = controlKind(l); return k === "input" || k === "select" || k === "toggle"; });
/**
 * WCAG 1.4.11: a stroke is a control's visual BOUNDARY when the layer or one of its nearest 3 ancestors
 * is named an input, select or toggle (by name, instance set name or component name). `near` = [the layer,
 * then its ancestors nearest-first], at most 4 entries.
 */
function isBoundaryControl(near: readonly NamedLayer[]): boolean {
  return near.some(isBoundaryKind);
}
/**
 * The control's OUTERMOST layer in `near`, -1 when none is named a control. WCAG 1.4.11 measures the boundary
 * against the colour outside the control: the backdrop ABOVE that layer, never a fill the control paints itself —
 * kits put the fill on the instance and the border on an inner frame. The nearest INSTANCE named a control is the
 * control (a wrapper named "Search Panel" / "Radio Group" around it is not); with no such instance, the farthest
 * layer named one.
 */
function outermostControl(near: readonly NamedLayer[]): number {
  for (let i = 0; i < near.length; i++) { const a = near[i]; if (a && a.type === "INSTANCE" && isBoundaryKind(a)) return i; }
  for (let i = near.length - 1; i >= 0; i--) { const a = near[i]; if (a && isBoundaryKind(a)) return i; }
  return -1;
}

// The disabled-state words (the audit's STATE_SYNONYMS.disabled), and what a property NAMED one of them says when on.
const DISABLED_WORD = /^(disabled|inactive|is ?disabled)$/i;
const ON_VALUE = /^(true|yes|on)$/i;
/**
 * An instance drawn in its disabled variant (exempt: WCAG exempts inactive components). A variant option
 * VALUE that says disabled ("State=Disabled"), or a variant / BOOLEAN property NAMED disabled that is on
 * ("Disabled=True", props `{ Disabled: true }`). With no `mainComponent` to read the variant from, a prop whose
 * string VALUE is exactly "Disabled" counts too; with one, prop values are never read — a TEXT property's value is
 * copy (a radio button labelled "Disabled", a status label "Inactive").
 */
function isDisabledLayer(layer: { mainComponent?: MainComponentRef | undefined; props?: ComponentPropValues | undefined }): boolean {
  for (const part of String((layer.mainComponent && layer.mainComponent.name) || "").split(",")) {
    const [k = "", v = ""] = part.split("=").map((x) => x.trim());
    if (DISABLED_WORD.test(v) || (DISABLED_WORD.test(k) && ON_VALUE.test(v))) return true;
  }
  for (const [k, v] of Object.entries(layer.props || {})) {
    if (DISABLED_WORD.test(k.trim()) && (v === true || (typeof v === "string" && ON_VALUE.test(v.trim())))) return true;
    if (!layer.mainComponent && typeof v === "string" && /^disabled$/i.test(v.trim())) return true;
  }
  return false;
}

export { controlKind, isBoundaryControl, outermostControl, isDisabledLayer, DISABLED_WORD };
