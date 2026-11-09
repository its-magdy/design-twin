// Offline tests for design-to-code/code-usage.ts — an instance's props, translated through its map entry, nothing guessed.
//   bun test/code-usage.test.ts
import { codeUsageOf } from "../design-to-code/code-usage.ts";
import { check, report } from "./assert.ts";
import type { CodeUsageWarningCode, MapEntry } from "../design-to-code/types.ts";

const entry = (over: Partial<MapEntry> = {}): MapEntry => ({ figma: { name: "Button", key: "K" }, code: { module: "@/ui/Button", export: "Button" }, status: "active", ...over });
const codes = (r: { warnings: Array<{ code: CodeUsageWarningCode }> }): string[] => r.warnings.map((w) => w.code);

console.log("the translation:");
{
  const r = codeUsageOf(entry({
    props: {
      Variant: { kind: "enum", codeProp: "variant", values: { Primary: "primary", Ghost: "ghost" } },
      Disabled: { kind: "boolean", codeProp: "disabled" },
      Label: { kind: "string", codeProp: "children" },
      Icon: { kind: "instance", slot: "icon" },
    },
  }), { props: { Variant: "Primary", Disabled: true, Label: "Save", Icon: "12:34" } });
  check("module, export, status, translated props and slots",
    r.usage?.module === "@/ui/Button" && r.usage.export === "Button" && r.usage.status === "active"
    && JSON.stringify(r.usage.props) === JSON.stringify({ variant: "primary", disabled: true, children: "Save" })
    && JSON.stringify(r.usage.slots) === JSON.stringify({ icon: "12:34" }) && r.warnings.length === 0);
}
{
  const p: MapEntry["props"] = { "Size#1:2": { kind: "enum", codeProp: "size", values: { Large: "lg" } } };
  check("a map key with Figma's #id suffix matches the export's stripped name", codeUsageOf(entry({ props: p }), { props: { Size: "Large" } }).usage?.props.size === "lg");
  check("a variant axis is read when the instance exported no props", codeUsageOf(entry({ props: p }), { variant: { Size: "Large" } }).usage?.props.size === "lg");
}
{
  const r = codeUsageOf(entry({ props: { Size: { kind: "enum", codeProp: "size", values: { Medium: "md", Large: "lg" }, default: "Medium", omitDefault: true }, On: { kind: "boolean", codeProp: "on", default: false, omitDefault: true } } }), { props: { Size: "Medium", On: false } });
  check("omitDefault compares the Figma value and leaves the default out", Object.keys(r.usage?.props ?? { x: 1 }).length === 0 && r.warnings.length === 0);
  const s = codeUsageOf(entry({ props: { Size: { kind: "enum", codeProp: "size", values: { Medium: "md" }, default: "Medium" } } }), { props: { Size: "Medium" } });
  check("a default without omitDefault is written", s.usage?.props.size === "md");
  const n = codeUsageOf(entry({ props: { Tone: { kind: "enum", codeProp: "tone", values: { None: null } } } }), { props: { Tone: "None" } });
  check("a null value table entry means no code prop, without a warning", n.usage?.props.tone === undefined && n.warnings.length === 0);
}

console.log("nothing guessed:");
{
  const r = codeUsageOf(entry({ props: { Variant: { kind: "enum", codeProp: "variant", values: { Primary: "primary" } } } }), { props: { Variant: "Ghost" } });
  check("an enum option with no mapping is left out and warned about", r.usage?.props.variant === undefined && codes(r).join() === "unmapped-variant-value" && r.warnings[0]?.prop === "Variant");
  const none = codeUsageOf(entry({ props: { Variant: { kind: "enum", codeProp: "variant" } } }), { props: { Variant: "Ghost" } });
  check("an enum with no values table is not an identity mapping", none.usage?.props.variant === undefined && codes(none).join() === "unmapped-variant-value");
  const proto = codeUsageOf(entry({ props: { Variant: { kind: "enum", codeProp: "variant", values: { Primary: "primary" } } } }), { props: { Variant: "constructor" } });
  check("an option named like an Object.prototype member is unmapped too", proto.usage?.props.variant === undefined && codes(proto).join() === "unmapped-variant-value");
}
check("a Figma prop the entry does not map is warned about", codes(codeUsageOf(entry(), { props: { Extra: "x" } })).join() === "uncovered-prop");
check("a value of the wrong type is warned about", codes(codeUsageOf(entry({ props: { D: { kind: "boolean", codeProp: "d" } } }), { props: { D: "yes" } })).join() === "prop-value-mismatch");
{
  const p: MapEntry["props"] = { Title: { kind: "string", codeProp: "children" }, Label: { kind: "string", codeProp: "children" } };
  const r = codeUsageOf(entry({ props: p }), { props: { Title: "A", Label: "B" } });
  check("two Figma props with different values for one code prop: neither is picked", r.usage?.props.children === undefined && codes(r).join() === "conflicting-code-prop");
  check("the same value through both is not a conflict", codeUsageOf(entry({ props: p }), { props: { Title: "A", Label: "A" } }).usage?.props.children === "A");
}
{
  const r = codeUsageOf(entry({ props: { "S#1:1": { kind: "string", codeProp: "a" }, "S#2:2": { kind: "string", codeProp: "b" } } }), { props: { S: "x" } });
  check("two map keys with one base name are not translated", Object.keys(r.usage?.props ?? { x: 1 }).length === 0 && codes(r).join() === "ambiguous-prop");
}
check("an instance prop with no slot and no codeProp is warned about", codes(codeUsageOf(entry({ props: { I: { kind: "instance" } } }), { props: { I: "1:1" } })).join() === "no-slot-name");

console.log("the code target:");
{
  const stub = codeUsageOf(entry({ code: { module: "TODO: import path", export: "Button" }, status: "needs-review" }), { props: {} });
  check("a TODO module gives no usage and says so", stub.usage === null && codes(stub).join() === "no-code-target");
  check("needs-review is carried, so the row shows nobody confirmed it", codeUsageOf(entry({ status: "needs-review" }), {}).usage?.status === "needs-review");
  check("per-platform targets are carried", codeUsageOf(entry({ code: { module: "m", export: "E", targets: { web: { module: "w" } } } }), {}).usage?.targets?.web?.module === "w");
}
{
  const over: MapEntry["variantOverrides"] = [{ when: { Type: "Danger" }, code: { module: "@/ui/Danger", export: "Danger" } }];
  const hit = codeUsageOf(entry({ variantOverrides: over, props: { Type: { kind: "enum", codeProp: "type", values: { Danger: "danger" } } } }), { props: { Type: "Danger" } });
  check("a variantOverride whose when holds names the target", hit.usage?.module === "@/ui/Danger" && hit.usage.export === "Danger");
  check("one that does not hold leaves the entry's target", codeUsageOf(entry({ variantOverrides: over, props: { Type: { kind: "enum", codeProp: "type", values: { Plain: "plain" } } } }), { props: { Type: "Plain" } }).usage?.module === "@/ui/Button");
  check("an empty when holds for nobody", codeUsageOf(entry({ variantOverrides: [{ when: {}, code: { module: "x", export: "X" } }] }), {}).usage?.module === "@/ui/Button");
  const tie: MapEntry["variantOverrides"] = [{ when: { A: "1" }, code: { module: "a", export: "A" } }, { when: { B: "2" }, code: { module: "b", export: "B" } }];
  const r = codeUsageOf(entry({ variantOverrides: tie, props: { A: { kind: "enum", codeProp: "a", values: { 1: "one" } }, B: { kind: "enum", codeProp: "b", values: { 2: "two" } } } }), { props: { A: "1", B: "2" } });
  check("overrides that hold with different targets are a tie, not a pick", r.usage === null && codes(r).join() === "ambiguous-variant-override");
}

report();
