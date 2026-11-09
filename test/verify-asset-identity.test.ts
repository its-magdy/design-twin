// Asset identity: the hash an exported file and a rendered asset are compared by, the probe's step from page value to
// recorded identity, the expectation's accepted identities, and the three --compare outcomes (verified / wrong /
// unverified). The real render is in verify-probe-e2e.test.ts.
import fs from "node:fs";
import path from "node:path";
import { assetIdentity, svgIdentity } from "../design-to-code/content-hash.ts";
import { identifyAssets } from "../design-to-code/probe-match.ts";
import { buildExpectation } from "../design-to-code/verify-expect.ts";
import { compare } from "../design-to-code/verify-compare.ts";
import { ASSET_IDENTITY } from "../design-to-code/verify-shared.ts";
import type { MeasuredAsset, MeasuredNode, ScreenDoc, VerifySpec } from "../design-to-code/types.ts";
import { check, report } from "./assert.ts";

const shell = (d: string): string => `<svg width="24" height="24" fill="none"><g clip-path="url(#a)"><path d="${d}" fill="#123456"/></g><defs><clipPath id="a"><rect width="24" height="24"/></clipPath></defs></svg>`;
const enc = (s: string): Uint8Array => Buffer.from(s, "utf8");

console.log("the identity:");
{
  const file = assetIdentity(enc(shell("M4.123 12L20 12")));
  check("an inline <svg> without defs, recoloured and resized, is the exported file", file !== null && svgIdentity('<svg class="i" width="16" fill="currentColor"><path d="M4.123 12L20 12"/></svg>') === file);
  const ring = (w: string): string => `<svg><circle cx="5" cy="5" r="4" stroke-width="${w}" stroke="#000"/></svg>`;
  check("a stroke width is part of the drawing", svgIdentity(ring("1.5")) !== svgIdentity(ring("1.2")));
  check("a transform is part of the drawing", svgIdentity('<svg><path d="M0 0L9 1" transform="rotate(180 5 5)"/></svg>') !== svgIdentity('<svg><path d="M0 0L9 1"/></svg>')
    && svgIdentity('<svg><g transform="rotate(90)"><path d="M0 0L9 1"/></g></svg>') !== svgIdentity('<svg><path d="M0 0L9 1"/></svg>'));
  check("another drawing is another identity", assetIdentity(enc(shell("M4 12L21 12"))) !== file);
  const photo = (b: string): string => `<svg><rect width="9" height="9" fill="url(#p)"/><defs><pattern id="p"><use href="#i"/></pattern><image id="i" href="data:image/png;base64,${b}"/></defs></svg>`;
  check("two photos in the same SVG shell are told apart by their embedded image", svgIdentity(photo("AAAA")) !== svgIdentity(photo("BBBB")) && svgIdentity(photo("AAAA")) !== null);
  check("a <use> sprite and an SVG that draws nothing have no identity", svgIdentity('<svg><use href="#x"/></svg>') === null && svgIdentity("<svg></svg>") === null);
  check("a raster is its bytes", assetIdentity(new Uint8Array([1, 2, 3])) === assetIdentity(new Uint8Array([1, 2, 3])) && assetIdentity(new Uint8Array([1, 2, 4])) !== assetIdentity(new Uint8Array([1, 2, 3])));
}

console.log("the probe's record:");
{
  const node = (v: MeasuredAsset | null): MeasuredNode => ({ nodeId: "1", styles: { assetIdentity: v } });
  const nodes = [node({ from: "img", src: "http://x/a.png" }), node({ from: "img", src: "http://x/a.png" }), node({ from: "img", src: "http://x/gone.png" }), node({ from: "img", src: "blob:http://x/1" }),
    node({ from: "img", src: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}` }), node({ from: "svg", markup: '<svg><path d="M0 0L1 1"/></svg>' }), node({ from: "svg", markup: '<svg><use href="#a"/></svg>' }), node({ from: "css", why: "a CSS background" }), node(null)];
  let reads = 0;
  await identifyAssets(nodes, async (url) => { reads++; if (url.includes("gone")) throw new Error("HTTP 404"); return new Uint8Array([1, 2, 3]); });
  const at = (i: number): Record<string, unknown> => ({ ...nodes[i]?.styles?.assetIdentity });
  const bytesId = assetIdentity(new Uint8Array([1, 2, 3]));
  check("each URL is read once and identified", reads === 2 && at(0).id === bytesId && at(1).id === bytesId);
  check("a read that fails says why, naming no identity", at(2).id === undefined && /HTTP 404/.test(String(at(2).why)));
  check("a blob: URL is not read: it says so", at(3).id === undefined && /blob/.test(String(at(3).why)));
  check("a data: URL is decoded and its payload not kept", at(4).id === bytesId && at(4).src === "data:image/png;base64,…");
  check("inline markup becomes its identity and is dropped", typeof at(5).id === "string" && !("markup" in at(5)));
  check("a sprite says why", at(6).id === undefined && /sprite/.test(String(at(6).why)));
  check("a CSS background keeps its reason, a null stays null", at(7).why === "a CSS background" && nodes[8]?.styles?.assetIdentity === null);
}

console.log("the expectation:");
{
  const doc = { exportedAt: "2026-11-09T00:00:00Z", screen: "S", page: "P", pageId: "9:0", nodeId: "1:1", sourceFile: "F", nodes: [{ type: "FRAME", name: "S", id: "1:1", box: { w: 10, h: 10 }, children: [
    { type: "RECTANGLE", name: "Pic", id: "1:2", box: { w: 5, h: 5 }, asset: "assets/pic.png", fills: [{ type: "image", hash: "h" }] },
    { type: "VECTOR", name: "NoRow", id: "1:3", box: { w: 5, h: 5 }, asset: "assets/unlisted.svg" },
  ] }] } as unknown;
  const bytes: Record<string, Uint8Array> = { "assets/pic.png": new Uint8Array([1]), "assets/src.png": new Uint8Array([2]), "assets/unlisted.svg": enc(shell("M0 0L1 1")), "assets/x.png": new Uint8Array([3]) };
  const exp = buildExpectation([{ doc: doc as ScreenDoc }], { assets: { rows: [{ file: "assets/pic.png", node: "1:2" }, { file: "assets/src.png", node: "img:h" }], others: ["assets/x.png"], read: (p) => bytes[p] ?? null } });
  const pic = exp.nodes.find((n) => n.nodeId === "1:2"), noRow = exp.nodes.find((n) => n.nodeId === "1:3");
  check("the node's file and its image fill's source are both accepted", JSON.stringify(pic?.assetIdentity?.files) === JSON.stringify(["assets/pic.png", "assets/src.png"]) && pic?.assetIdentity?.ids.length === 2);
  check("a node the manifest does not list expects no identity", noRow?.assetIdentity === undefined);
  check("every exported file is known by identity, the assets/ ones too", Object.values(exp.assetIds ?? {}).includes("assets/x.png"));
  const g13 = (n: string): Uint8Array => fs.readFileSync(path.join(import.meta.dirname, "fixtures", "g13", "svg", n));
  const pair = (a: string, b: string): { self?: string[] | undefined; other: string | null } => {
    const iconDoc = { exportedAt: "x", screen: "S", page: "P", pageId: "9:0", nodeId: "2:1", sourceFile: "F", nodes: [{ type: "FRAME", name: "S", id: "2:1", box: { w: 9, h: 9 }, children: [{ type: "VECTOR", name: "I", id: "2:2", box: { w: 9, h: 9 }, asset: `assets/${a}` }] }] } as unknown;
    const made = buildExpectation([{ doc: iconDoc as ScreenDoc }], { assets: { rows: [{ file: `assets/${a}` }], others: [`assets/${b}`], read: (p) => g13(p.slice(7)) } });
    return { self: made.nodes.find((n) => n.nodeId === "2:2")?.assetIdentity?.ids, other: assetIdentity(g13(b)) };
  };
  for (const [a, b] of [["cross-a.svg", "cross-b.svg"], ["badge-a.svg", "badge-b.svg"]] as const) { const r = pair(a, b); check(`${a}'s re-exported twin ${b} is accepted as the same asset`, r.other !== null && !!r.self?.includes(r.other)); }
  { const r = pair("ring-a.svg", "ring-b.svg"); check("ring-a's stroke-width sibling ring-b stays another asset", r.other !== null && r.self !== undefined && !r.self.includes(r.other)); }
  check("an image row states only its identity (no size to grade)", pic?.assetOnly === true && pic.width === undefined && pic.height === undefined && pic.opacity === undefined);
  check("no manifest: no identity is expected at all", buildExpectation([{ doc: doc as ScreenDoc }], null).nodes.every((n) => n.assetIdentity === undefined));
}

console.log("the comparison:");
{
  const spec: VerifySpec = { nodeId: "1:2", name: "Pic", type: "RECTANGLE", assetIdentity: { files: ["assets/pic.png"], ids: ["b:right"] } };
  const expectation = { frame: {}, nodes: [spec], assetIds: { "b:right": "assets/pic.png", "b:other": "assets/x.png" } };
  const run = (styles: Record<string, unknown>) => compare(expectation, { nodes: [{ nodeId: "1:2", styles, matchedBy: "tag" }] });
  const fields = (r: ReturnType<typeof run>) => r.deltas.filter((d) => d.field === ASSET_IDENTITY);
  const un = (r: ReturnType<typeof run>) => r.unverifiable.filter((d) => d.field === ASSET_IDENTITY);
  const right = run({ assetIdentity: { from: "img", src: "/a.png", id: "b:right" } });
  check("the expected file: verified and counted", fields(right).length === 0 && un(right).length === 0 && JSON.stringify(right.coverage.assetIdentity) === JSON.stringify({ verified: 1, wrong: 0, unverified: 0 }));
  const other = run({ assetIdentity: { from: "img", src: "/b.png", id: "b:other" } });
  const d = fields(other)[0];
  check("another exported file: one high delta naming both", fields(other).length === 1 && d?.severity === "high" && d.expected === "assets/pic.png" && d.actual === "assets/x.png" && other.coverage.assetIdentity?.wrong === 1);
  const unknown = run({ assetIdentity: { from: "img", src: "/c.webp", id: "b:elsewhere" } });
  check("content the export does not hold: unverified, never a delta", fields(unknown).length === 0 && un(unknown).length === 1 && unknown.coverage.assetIdentity?.unverified === 1);
  const css = run({ assetIdentity: { from: "css", why: "a CSS background" } });
  check("a source that cannot be read: unverified with its reason", un(css)[0]?.why === "a CSS background" && fields(css).length === 0);
  const only: VerifySpec = { nodeId: "1:5", name: "Lonely", type: "RECTANGLE", assetOnly: true, assetIdentity: { files: ["assets/pic.png"], ids: ["b:right"] } };
  const lone = compare({ frame: {}, nodes: [spec, only], assetIds: expectation.assetIds }, { nodes: [{ nodeId: "1:2", styles: { assetIdentity: { from: "img", id: "b:right" } }, matchedBy: "tag" }] });
  check("an image row with nothing else to check and no element: unverified, not 'not measured', not expected", lone.notMeasured.length === 0 && lone.unverifiable.some((u) => u.nodeId === "1:5") && lone.coverage.nodesExpected === 1);
  const state = { ...spec, drawnState: "hover", drawnStateWhy: "Status=Hover" } satisfies VerifySpec;
  const rest = compare({ frame: {}, nodes: [state], assetIds: expectation.assetIds }, { nodes: [{ nodeId: "1:2", styles: { assetIdentity: { from: "img", id: "b:other" } }, matchedBy: "tag" }] });
  check("a node drawn in a state, measured at rest: unverified, never the resting file's delta", rest.deltas.every((x) => x.field !== ASSET_IDENTITY) && rest.unverifiable.some((u) => u.field === ASSET_IDENTITY) && !rest.fieldsNotMeasured.some((g) => g.field === ASSET_IDENTITY));
  const zero = compare({ frame: {}, nodes: [state], assetIds: expectation.assetIds }, { nodes: [{ nodeId: "1:2", styles: { width: 0, height: 0 }, matchedBy: "tag" }] });
  check("hover-only and 0×0 at rest: unverified, not 'not measured'", zero.unverifiable.some((u) => u.field === ASSET_IDENTITY) && !zero.fieldsNotMeasured.some((g) => g.field === ASSET_IDENTITY));
  const native = run({ width: 5 });
  check("a measurement that does not say (native, hand-written): unverified, not 'not measured'", un(native).length === 1 && !native.fieldsNotMeasured.some((g) => g.field === ASSET_IDENTITY));
}

report();
