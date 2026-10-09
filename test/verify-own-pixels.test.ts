// In-page tests of the pixel check (design-to-code/probe-drive.ts ownMark / ownShot / ownClear / ownPixels / plainKept)
// and the probe's init CSS (verify-probe.ts INIT_SCRIPT), run from SOURCE in a real chromium on small invented pages — the
// mechanics the drive e2e (test/verify-probe-drive-e2e.test.ts, the built bundle) can only see through a whole probe run: the
// specificity lift, the scroll into view and back, the focus kept, the parked pointer, the "rules took" check, everything outside
// the container hidden (a foreign ticker), open shadow roots, the container's own ::marker, the plain-paint test of the kept
// boxes, a control unmounted when the pointer leaves, and a strict style CSP.
//
// needs the repo's devDependency `playwright` + chromium. Locally an unavailable renderer prints SKIPPED; in CI (CI=true)
// that is a failure.  Run with:  node test/verify-own-pixels.test.ts
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser, Page } from "playwright";
import * as PD from "../design-to-code/probe-drive.ts";
import { decodePng } from "../design-to-code/png.ts";
import * as VP from "../design-to-code/verify-probe.ts";
import { check, report } from "./assert.ts";

console.log("verify own pixels — the pixel check in a real chromium, from source:");
let browser: Browser;
try {
  const pw = await import("playwright");
  browser = await pw.chromium.launch({ args: [...VP.LAUNCH_ARGS] });
} catch (e) {
  const reason = String(e instanceof Error ? e.message : e).split("\n")[0] ?? "";
  if (process.env.CI !== "true") { console.log(`SKIPPED (no playwright: ${reason})`); process.exit(0); }
  check(`the renderer is available in CI — ${reason}`, false);
  report();
  process.exit(1);
}

// a strict style CSP server: GET /?p=<n> answers page n with `style-src 'nonce-dtcsp'` (an injected <style> without the nonce,
// and every style="" attribute, is blocked)
const pages = new Map<string, string>();
const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://x");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "style-src 'nonce-dtcsp'" });
  res.end(pages.get(u.searchParams.get("p") ?? "") ?? "");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const addr = server.address();
const port = addr !== null && typeof addr === "object" ? (addr satisfies AddressInfo).port : 0;

const VIEW = { width: 800, height: 600 };
const open = async (html: string, o?: { csp?: boolean; init?: boolean }): Promise<Page> => {
  const page = await browser.newPage({ viewport: VIEW });
  if (o?.init) await page.addInitScript({ content: typeof VP.INIT_SCRIPT === "string" ? VP.INIT_SCRIPT : "" });
  if (o?.csp) { const k = String(pages.size); pages.set(k, html); await page.goto(`http://127.0.0.1:${port}/?p=${k}`); }
  else await page.setContent(html);
  return page;
};
const BASE = "<style nonce=\"dtcsp\">body { margin: 0; font: 14px sans-serif; background: #ffffff; } .row { margin: 20px; }"
  + " .card { display: inline-grid; grid-template-columns: 1fr auto 1fr; align-items: center; width: 240px; height: 40px; padding: 6px; border: 1px solid #999999; background: #ffffff; position: relative; }"
  + " .cell { display: inline-block; position: relative; width: 160px; height: 44px; text-align: center; } .cell button { margin-top: 8px; } button { width: 32px; height: 26px; }";
/** the drive's tipPreMark (what is shown before its first hover), when the tree has it */
const tipPreMarkFn: unknown = Reflect.get(PD, "tipPreMark");
/** the drive's path: tipPreMark, hover the opener, the DOM check (clickPointControl leaves the pair on the sole-control exemption), then
 *  the pixels */
const drive = async (page: Page, sel = "#c", park = true): Promise<{ dom: string | null; why: string | null; paired: boolean }> => {
  if (typeof tipPreMarkFn === "function") await page.evaluate(PD.tipPreMark, null);
  await page.locator(sel).hover({ force: true });
  const dom = await page.locator(sel).evaluate(PD.clickPointControl, { mark: true });
  const paired = (await page.evaluate("!!window.__dtOwn")) === true;
  const px = paired ? await PD.ownPixels(page, { park }) : null;
  return { dom, why: px ? px.why : null, paired };
};
/** a boolean expression evaluated in the page */
const yes = async (page: Page, expr: string): Promise<boolean> => (await page.evaluate(expr)) === true;
/** the pixels alone, on a pair set by hand (container #c, control #d) */
const pixels = async (page: Page, park = false): Promise<string | null> => {
  await page.evaluate("window.__dtOwn = { box: document.getElementById('c'), ctl: document.getElementById('d') }");
  const px = await PD.ownPixels(page, { park });
  return px ? px.why : "no pair";
};
const refused = (r: { dom: string | null; why: string | null }): boolean => r.dom !== null || r.why !== null;
const driven = (r: { dom: string | null; why: string | null; paired: boolean }): boolean => r.dom === null && r.paired && r.why === null;
const one = async (html: string, f: (p: Page) => Promise<boolean>, o?: { csp?: boolean; init?: boolean }): Promise<boolean> => {
  const page = await open(html, o);
  try { return await f(page); } finally { await page.close(); }
};
const DEL = "<button id=\"d\" aria-label=\"Delete row\">x</button>";

// ---- a box kept as decoration is kept only when its pixels are plain; the CSS pre-filter
const cover = (fill: string): string => `${BASE}</style><div class="row"><div class="card" id="c">${fill}<span></span><span style="position:relative">${DEL}</span><span></span></div></div>`;
// the DOM counts a <progress> / <meter> (its media list); the CSS pre-filter never keeps a clipped fill, so the A/B shots differ
const coverCards: Array<[string, string, (r: { dom: string | null; why: string | null }) => boolean]> = [
  ["a <progress> filling the card (the DOM's media rule)", "<progress value=\"60\" max=\"100\" style=\"position:absolute;inset:0;width:100%;height:100%\"></progress>", (r) => r.dom !== null],
  ["a <meter> filling the card (the DOM's media rule)", "<meter value=\"0.6\" style=\"position:absolute;inset:0;width:100%;height:100%\"></meter>", (r) => r.dom !== null],
  ["an inset:0 fill clipped to a corner flag (clip-path polygon: not kept)", "<span style=\"position:absolute;inset:0;background:#22aa77;clip-path:polygon(0 0,28px 0,0 28px)\"></span>", (r) => /paints something of its own/.test(r.why ?? "")],
  ["an inset:0 fill clipped to a band (clip-path inset: not kept)", "<span style=\"position:absolute;inset:0;background:#cceeee;clip-path:inset(0 40% 0 0)\"></span>", (r) => /paints something of its own/.test(r.why ?? "")],
  ["an inset:0 fill painted only in a 4-px content box (background-clip: not kept)", "<span style=\"position:absolute;inset:0;box-sizing:border-box;padding-left:calc(100% - 4px);background:#dd3333;background-clip:content-box\"></span>", (r) => /paints something of its own/.test(r.why ?? "")],
];
for (const [what, fill, how] of coverCards) {
  check(`a card's sole centred Delete over ${what} → refused (was: pressed)`, await one(cover(fill), async (p) => how(await drive(p))));
}
const hug = (wrap: string): string => `${BASE}</style><div class="row"><div class="cell" id="c"><span style="display:inline-block;margin-top:6px;${wrap}">${DEL.replace("id=\"d\"", "id=\"d\" style=\"margin:0\"")}</span></div></div>`;
for (const [what, wrap] of [["a 14-px box-shadow ring", "padding:2px;box-shadow:0 0 0 14px #22aa77"], ["an outline 6 px out", "padding:2px;outline:3px solid #22aa77;outline-offset:3px"],
  ["a 3-px inset shadow in another colour", "padding:4px;background:#eeeeff;box-shadow:inset 0 0 0 3px #dd3333"], ["a 2-px border in another colour", "padding:2px;background:#eeeeff;border:2px solid #dd3333"]] as const) {
  check(`a cell whose sole button sits in a wrapper hugging it with ${what} → refused by the plain-paint test`,
    await one(hug(wrap), async (p) => { const r = await drive(p); return r.dom === null && /alone it must paint one uniform colour/.test(r.why ?? ""); }));
}
check("a cell whose sole button sits in a filled wrapper (one colour), a rounded one (radius 6 px), and a cell under a whole-cell tint inside a rounded clipping cell → driven",
  await one(hug("padding:4px;background:#eeeeff"), async (p) => driven(await drive(p)))
  && await one(hug("padding:4px;background:#eeeeff;border-radius:6px"), async (p) => driven(await drive(p)))
  && await one(`${BASE}</style><div class="row"><div class="cell" id="c" style="border-radius:10px;overflow:hidden;background:#f4f4f4"><span style="position:absolute;inset:0;background:rgba(0,0,0,0.06);border-radius:10px;pointer-events:none"></span>${DEL}</div></div>`, async (p) => driven(await drive(p))));

// ---- the container as a shadow host — its shadow content is hidden in shot B, so it counts
const host = (shadow: string): string => `${BASE}</style><div class="row"><div class="card" id="c">${DEL}</div></div>
  <script>document.getElementById("c").attachShadow({ mode: "open" }).innerHTML = ${JSON.stringify(`<style>:host { display: inline-grid !important; grid-template-columns: 1fr auto 1fr; align-items: center; position: relative; }</style>${shadow}`)};</script>`;
for (const [what, shadow] of [["a <progress>", "<progress value=\"60\" max=\"100\" style=\"width:70px\"></progress><slot></slot><span></span>"],
  ["a status dot drawn by a border", "<span style=\"display:inline-block;width:0;height:0;border:6px solid #22aa77;border-radius:50%\"></span><slot></slot><span></span>"],
  ["a band over the centre", "<span style=\"position:absolute;left:0;top:12px;height:10px;width:60%;background:#22aa77\"></span><span></span><slot></slot><span></span>"],
  ["a status dot forcing visibility:visible in its own sheet", "<style>i { visibility: visible; }</style><i style=\"display:inline-block;width:0;height:0;border:6px solid #22aa77;border-radius:50%\"></i><slot></slot><span></span>"]] as const) {
  check(`a web-component card whose shadow root holds ${what} beside its slotted sole Delete → refused (was: pressed)`, await one(host(shadow), async (p) => refused(await drive(p))));
}
check("the pixels alone: a host's shadow dot (DOM rules aside) → content", await one(host("<span style=\"display:inline-block;width:0;height:0;border:6px solid #22aa77;border-radius:50%\"></span><slot></slot><span></span>"),
  async (p) => /paints something of its own/.test(await pixels(p) ?? "")));
check("a web-component cell whose shadow root holds only the <slot> for its sole button → driven; the probe's sheet leaves the shadow root afterwards",
  await one(host("<span></span><slot></slot><span></span>"), async (p) => driven(await drive(p)) && await yes(p, "document.getElementById('c').shadowRoot.adoptedStyleSheets.length === 0")));

// ---- a control the page mounts on hover and unmounts once the pointer leaves (parked) is hidden by the page
const jsHover = (extra: string): string => `${BASE}</style><div class="row"><div class="card" id="c">${extra}<span id="slot"></span><span></span></div></div>
  <script>const c = document.getElementById("c"), s = document.getElementById("slot");
  c.addEventListener("mouseenter", () => { s.innerHTML = ${JSON.stringify(DEL)}; }); c.addEventListener("mouseleave", () => { s.innerHTML = ""; });</script>`;
check("a cell whose sole button is mounted by JS on hover and unmounted when the pointer is parked → driven (was: refused 'could not hide its control')",
  await one(jsHover("<span></span>"), async (p) => driven(await drive(p))));
check("the same with a <progress> beside the mounted Delete → refused", await one(jsHover("<progress value=\"60\" max=\"100\" style=\"width:70px\"></progress>"), async (p) => refused(await drive(p))));

// ---- a foreign ticker repainting over the cell every 10 ms never decides
const ticker = `${BASE}</style><div class="row"><div class="cell" id="c">${DEL}</div></div>
  <div id="tk" style="position:absolute;left:120px;top:30px;height:6px;width:50px;background:#4477ff"></div>
  <script>let w = 50; setInterval(() => { w = w > 2 ? w - 1 : 50; document.getElementById("tk").style.width = w + "px"; }, 10);</script>`;
check("a cell under a foreign ticker repainting every 10 ms → driven on 6 runs out of 6 (everything outside the cell is hidden in both shots)",
  await one(ticker, async (p) => { let n = 0; for (let i = 0; i < 6; i++) if (driven(await drive(p))) n++; return n === 6; }));
check("the focused field outside the container stays focused and is never blurred by the shots",
  await one(`${BASE}</style><input id="f"><div class="row"><div class="cell" id="c">${DEL}</div></div>`, async (p) => {
    await p.evaluate("document.getElementById('f').focus(); window.blurs = 0; document.getElementById('f').addEventListener('blur', () => { window.blurs++; })");
    const r = await drive(p);
    return driven(r) && await yes(p, "document.activeElement.id === 'f' && window.blurs === 0");
  }));

// ---- the container's own ::marker
const marker = `${BASE}</style><div class="row"><div class="card" id="c" style="display:list-item;list-style:inside decimal;text-align:center">${DEL}</div></div>`;
check("a list-item card with its own '1.' marker beside its sole Delete → refused by the DOM's list-marker rule", await one(marker, async (p) => (await drive(p)).dom !== null));
check("the pixels alone: the container's own ::marker is hidden in shot B → content", await one(marker, async (p) => /paints something of its own/.test(await pixels(p) ?? "")));

// ---- a strict style CSP — the init CSS as a constructed sheet, the probe's hiding rules with transition:none
const trall = `${BASE} #d { transition: all 0.3s; }</style><div class="row"><div class="cell" id="c">${DEL}</div></div>`;
check("under style-src 'nonce-…' the probe's init CSS still takes (a constructed sheet): transition none, scroll-behavior auto",
  await one(trall, async (p) => await yes(p, "getComputedStyle(document.getElementById('d')).transitionDuration === '0s' && getComputedStyle(document.documentElement).scrollBehavior === 'auto'"), { csp: true, init: true }));
check("under the CSP a cell whose button has transition:all → driven, with the init CSS and without it (the probe's own rules carry transition:none)",
  await one(trall, async (p) => driven(await drive(p)), { csp: true, init: true }) && await one(trall, async (p) => driven(await drive(p)), { csp: true }));

// ---- an !important inside a cascade layer beats any unlayered one (and an inline one any sheet) — every element a
// shot hides is checked, so it refuses instead of showing in both shots
const dotCard = (css: string, dotStyle: string): string => `${BASE} ${css}</style><div class="row"><div class="card" id="c"><span class="dot" style="display:inline-block;width:0;height:0;border:6px solid #22aa77;border-radius:50%;${dotStyle}"></span>${DEL}<span></span></div></div>`;
check("a status dot forced visible by `@layer base { .dot { visibility: visible !important } }`, or inline with !important → refused, naming the rule that did not take (was: pressed)",
  await one(dotCard("@layer base { .dot { visibility: visible !important; } }", ""), async (p) => { const r = await drive(p); return r.dom === null && /kept <span> inside the opener showing/.test(r.why ?? ""); })
  && await one(dotCard("", "visibility:visible !important"), async (p) => { const r = await drive(p); return r.dom === null && /kept <span> inside the opener showing/.test(r.why ?? ""); }));

// ---- the specificity lift, the rules-took check, and the scroll, focus and pointer put back
check("a status dot forced visible by a page `#id .dot { visibility: visible !important }` → still hidden in shot B (the specificity lift) → content",
  await one(`${BASE} #c .dot { visibility: visible !important; }</style><div class="row"><div class="card" id="c"><span class="dot" style="display:inline-block;width:0;height:0;border:6px solid #22aa77;border-radius:50%"></span>${DEL}<span></span></div></div>`,
    async (p) => /paints something of its own/.test(await pixels(p) ?? "")));
check("a control forced visible inline with !important → the rules did not take: refused, saying so",
  await one(`${BASE}</style><div class="row"><div class="cell" id="c"><button id="d" aria-label="Delete row" style="visibility:visible !important">x</button></div></div>`,
    async (p) => /kept its control showing/.test(await pixels(p) ?? "")));
const tall = `${BASE}</style><div style="height:520px"></div><div class="row"><div id="c" style="position:relative;width:240px;height:300px;border:1px solid #999999">${DEL}
  <span style="position:absolute;left:10px;top:250px;width:0;height:0;border:6px solid #22aa77;border-radius:50%"></span></div></div><div style="height:900px"></div>`;
check("a card partly below the fold with a status dot drawn by a border in its unseen part → scrolled into view for the shots: content; the page's scroll put back after",
  await one(tall, async (p) => { const why = await pixels(p); return /paints something of its own/.test(why ?? "") && await yes(p, "scrollY === 0"); }));
check("the same card with nothing of its own → nothing; the page's scroll put back after",
  await one(tall.replace(/<span style="position:absolute;left:10px;top:250px[^>]*><\/span>/, ""), async (p) => await pixels(p) === null && await yes(p, "scrollY === 0")));
check("a focused control (hidden in the shots, which blurs it) → focused again after",
  await one(`${BASE}</style><div class="row"><div class="cell" id="c">${DEL}</div></div>`, async (p) => {
    await p.evaluate("document.getElementById('d').focus()");
    return await pixels(p) === null && await yes(p, "document.activeElement === document.getElementById('d')");
  }));
const tint = `${BASE} #c:hover .half { background: #dddddd; }</style><div class="row"><div class="cell" id="c"><span class="half" style="position:absolute;left:0;top:0;width:50%;height:100%"></span>${DEL}</div></div>`;
check("a cell whose child paints a half-cell tint on :hover, the pointer on it → parked away for the shots: nothing of its own (driven)",
  await one(tint, async (p) => driven(await drive(p))));
check("the same without parking → the hover tint counts (so the parking is what decides)",
  await one(tint, async (p) => { const r = await drive(p, "#c", false); return r.dom === null && r.why !== null; }));

// ---- plainKept itself (synthetic pixels): plain, a stripe in the box, paint outside it, an anti-aliased edge
const img = (w: number, h: number, f: (x: number, y: number) => [number, number, number]): { w: number; h: number; data: Uint8Array } => {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = f(x, y); data.set([c[0], c[1], c[2], 255], (y * w + x) * 4); }
  return { w, h, data };
};
const W: [number, number, number] = [255, 255, 255], G: [number, number, number] = [200, 220, 240];
const box = (x0: number, y0: number, x1: number, y1: number, r = 0): PD.KeptRect => ({ x: x0, y: y0, right: x1, bottom: y1, filled: true, shapes: [{ x: x0, y: y0, right: x1, bottom: y1, r: [r, r, r, r, r, r, r, r] }] });
const n = img(40, 20, () => W);
check("[plainKept] one colour over the box, the backdrop outside → plain; a half-blend on its edge → plain; a red stripe inside it, a pixel painted outside it, an off-hue edge → not plain",
  PD.plainKept(img(40, 20, (x, y) => (x >= 10 && x < 30 && y >= 5 && y < 15 ? G : W)), n, { x: 0, y: 0 }, [box(10, 5, 30, 15)]) === null
  && PD.plainKept(img(40, 20, (x, y) => (x >= 10 && x < 30 && y >= 5 && y < 15 ? G : x === 30 && y >= 5 && y < 15 ? [228, 238, 248] : W)), n, { x: 0, y: 0 }, [box(10, 5, 30.5, 15)]) === null
  && PD.plainKept(img(40, 20, (x, y) => (x === 20 && y >= 5 && y < 15 ? [220, 40, 40] : x >= 10 && x < 30 && y >= 5 && y < 15 ? G : W)), n, { x: 0, y: 0 }, [box(10, 5, 30, 15)]) !== null
  && PD.plainKept(img(40, 20, (x, y) => (x >= 10 && x < 30 && y >= 5 && y < 15 ? G : x === 35 && y === 2 ? G : W)), n, { x: 0, y: 0 }, [box(10, 5, 30, 15)]) !== null
  && PD.plainKept(img(40, 20, (x, y) => (x >= 10 && x < 30 && y >= 5 && y < 15 ? G : x === 30 && y === 9 ? [240, 200, 200] : W)), n, { x: 0, y: 0 }, [box(10, 5, 30.5, 15)]) !== null);


// ---- a kept box's REAL rounded outline (its own elliptical radii, the clipping boxes up to the container) —
// a hug wrapper drawn as a progress ring (border-radius 50%, border sides in two colours) has a core
const ringCell = (borders: string): string => `${BASE}</style><div class="row"><div class="cell" id="c"><span style="display:inline-block;margin-top:4px;padding:2px;border-radius:50%;${borders};background:#16a34a;background-clip:padding-box;line-height:0"><button id="d" aria-label="Cancel upload" style="margin:0;width:28px;height:28px;border-radius:50%;border:0;background:#16a34a;color:#ffffff">x</button></span></div></div>`;
check("a round Cancel in a 75 % / 50 % progress RING (a 50 %-radius hug wrapper, border sides in two colours) → refused by the plain-paint test (was: pressed — the corner squares covered the whole box)",
  await one(ringCell("border:4px solid #16a34a;border-left-color:rgba(22,163,74,.25)"), async (p) => { const r = await drive(p); return r.dom === null && /alone it must paint one uniform colour/.test(r.why ?? ""); })
  && await one(ringCell("border:4px solid rgba(22,163,74,.25);border-top-color:#16a34a;border-right-color:#16a34a"), async (p) => { const r = await drive(p); return r.dom === null && /alone it must paint one uniform colour/.test(r.why ?? ""); }));
check("the same ring in ONE colour (its background under the border too), a pill wrapper (9999px), an ELLIPTICAL wrapper (50 % on a 48 × 34 box) and a rounded cover inside a bordered rounded clipping cell → driven",
  await one(ringCell("border:4px solid #16a34a").replace("background-clip:padding-box", "background-clip:border-box"), async (p) => driven(await drive(p)))
  && await one(hug("padding:4px;background:#eeeeff;border-radius:9999px"), async (p) => driven(await drive(p)))
  && await one(hug("padding:4px 8px;background:#eeeeff;border-radius:50%"), async (p) => driven(await drive(p)))
  && await one(`${BASE}</style><div class="row"><div class="cell" id="c" style="border:3px solid #ccccdd;border-radius:12px;overflow:hidden"><span style="position:absolute;inset:0;background:#e8f0ff"></span><span style="position:relative">${DEL}</span></div></div>`, async (p) => driven(await drive(p))));

// ---- an ancestor's or the container's own filter / clip-path / mask never makes a plain wrapper
// "paint outside itself" — they are off in shots K and N
const HUGW = `<span style="display:inline-block;margin-top:6px;padding:4px;background:#eeeeff;border-radius:6px">${DEL.replace("id=\"d\"", "id=\"d\" style=\"margin:0\"")}</span>`;
check("a cell with a plain filled wrapper under a drop-shadow list (ancestor filter), with its own drop-shadow, under its own clip-path inset(0 round 12px) over a cover, under its own mask → driven (was: refused 'paints outside itself' / 'not one plain colour')",
  await one(`${BASE} #row { display: inline-block; filter: drop-shadow(0 2px 4px rgba(0,0,0,.25)); }</style><div class="row" id="row"><div class="cell" id="c">${HUGW}</div></div>`, async (p) => driven(await drive(p)))
  && await one(`${BASE}</style><div class="row"><div class="cell" id="c" style="filter: drop-shadow(0 2px 4px rgba(0,0,0,.25)); background:#ffffff">${HUGW}</div></div>`, async (p) => driven(await drive(p)))
  && await one(`${BASE}</style><div class="row"><div class="cell" id="c" style="clip-path: inset(0 round 12px)"><span style="position:absolute;inset:0;background:#e8f0ff"></span><span style="position:relative">${DEL}</span></div></div>`, async (p) => driven(await drive(p)))
  && await one(`${BASE}</style><div class="row"><div class="cell" id="c" style="mask-image: linear-gradient(90deg,#000 80%,transparent)"><span style="position:absolute;inset:0;background:#e8f0ff"></span><span style="position:relative">${DEL}</span></div></div>`, async (p) => driven(await drive(p))));

// ---- an ancestor repainted by script every 10 ms never decides — the ancestors are hidden in
// every shot (the container shown again)
check("a cell whose PARENT's background is repainted by script every 10 ms → driven on 6 runs out of 6; with a kept wrapper too",
  await one(`${BASE}</style><div class="row" id="row" style="display:inline-block;padding:4px"><div class="cell" id="c">${DEL}</div></div><script>let i = 0; setInterval(() => { document.getElementById("row").style.backgroundColor = (i++ % 2) ? "#ffffff" : "#fffbe6"; }, 10);</script>`,
    async (p) => { let n = 0; for (let i = 0; i < 6; i++) if (driven(await drive(p))) n++; return n === 6; })
  && await one(`${BASE}</style><div class="row" id="row" style="display:inline-block;padding:4px"><div class="cell" id="c">${HUGW}</div></div><script>let i = 0; setInterval(() => { document.getElementById("row").style.backgroundColor = (i++ % 2) ? "#ffffff" : "#fffbe6"; }, 10);</script>`,
    async (p) => { let n = 0; for (let i = 0; i < 6; i++) if (driven(await drive(p))) n++; return n === 6; }));
check("a focused ROW holding the cell (an ancestor that is the active element) stays focused, no blur, and the cell is driven",
  await one(`${BASE} tr:focus { outline: 2px solid #4477ff; } td { width:160px; height:44px; text-align:center; }</style><table style="margin:20px"><tr tabindex="0" id="tr"><td>Name</td><td id="c">${DEL}</td></tr></table>`, async (p) => {
    await p.evaluate("document.getElementById('tr').focus(); window.blurs = 0; document.getElementById('tr').addEventListener('blur', () => { window.blurs++; })");
    return driven(await drive(p)) && await yes(p, "document.activeElement.id === 'tr' && window.blurs === 0");
  }));

// ---- the pseudo-elements beyond ::before / ::after — hidden in shot B, checked to have taken; a
// ::scroll-button is a second control by the DOM rule
const PS: Array<[string, string, string]> = [
  ["::first-letter", "#fl::first-letter { visibility: visible; color: #cc0000; font-size: 20px; }", "<span id=\"fl\" style=\"position:absolute;left:4px;top:10px\">Q</span>"],
  ["::placeholder", "#fl::placeholder { visibility: visible; color: #cc0000; }", "<input id=\"fl\" tabindex=\"-1\" placeholder=\"Paid\" style=\"position:absolute;left:4px;top:10px;width:40px;border:0;background:transparent\">"],
  ["::file-selector-button", "#fl::file-selector-button { visibility: visible; background: #cc0000; }", "<input type=\"file\" id=\"fl\" tabindex=\"-1\" style=\"position:absolute;left:4px;top:10px;width:60px\">"],
  ["::details-content", "#fl::details-content { visibility: visible; color: #cc0000; }", "<details id=\"fl\" open style=\"position:absolute;left:4px;top:4px\"><summary style=\"display:block;list-style:none\" tabindex=\"-1\"></summary>Paid</details>"],
  ["::scroll-button", "#fl::scroll-button(right) { content: '\\25B6'; visibility: visible; color: #cc0000; font-size: 16px; }", "<div id=\"fl\" style=\"position:absolute;left:4px;top:8px;width:40px;height:28px;overflow:auto\"><div style=\"width:300px;height:10px\"></div></div>"],
];
const psCell = (css: string, inner: string): string => `${BASE} ${css}</style><div class="row"><div class="cell" id="c">${inner}${DEL}</div></div>`;
let psOk = true;
for (const [ps, css, inner] of PS) {
  let why: string | null = null;
  await one(psCell(css, inner), async (p) => { why = await pixels(p); return true; });
  // ::first-letter has no hiding rule of the probe's (it would fire mouseout on the parked pointer's element): a page-visible one
  // is caught by the "rules took" check; the others are hidden by the probe's own rule, so the pixels see them
  const want = ps === "::first-letter" ? /kept a ::first-letter inside the opener showing/ : /paints something of its own/;
  if (!want.test(why ?? "")) { psOk = false; console.log(`    ${ps}: ${String(why)}`); }
}
check("the pixels alone: a page-visible ::placeholder / ::file-selector-button / ::details-content / ::scroll-button inside the cell → hidden in shot B by the probe's own rule: content by the pixels; a page-visible ::first-letter → refused by the rules-took check (was: still showing in shot B → nothing)", psOk);
check("the shots fire no pointer event on the element under the parked pointer (no ::first-letter rule: it would rebuild the text boxes → mouseout / mouseleave)",
  await one(`${BASE} #logo { position: fixed; left: 0; top: 0; width: 60px; height: 30px; background: #eeeeee; }</style><a id="logo" href="#">Logo</a><div class="row" style="margin-top:60px"><div class="cell" id="c">${DEL}</div></div>
    <script>window.ev = []; for (const t of ["mouseover", "mouseout", "mouseenter", "mouseleave"]) document.getElementById("logo").addEventListener(t, () => window.ev.push(t));</script>`, async (p) => {
    await p.locator("#c").hover({ force: true });
    await p.locator("#c").evaluate(PD.clickPointControl, { mark: true });
    await p.mouse.move(0, 0);
    await p.evaluate("window.ev.length = 0");
    const px = await PD.ownPixels(p, { park: true });
    await p.waitForTimeout(100);
    return px !== null && px.why === null && await yes(p, "window.ev.length === 0");
  }));
check("a ::first-letter / ::scroll-button kept visible by a LAYERED !important → refused, naming the pseudo-element whose rule did not take",
  await one(psCell("@layer x { #fl::first-letter { visibility: visible !important; } } #fl::first-letter { color: #cc0000; font-size: 20px; }", PS[0]?.[2] ?? ""), async (p) => /kept a ::first-letter inside the opener showing/.test(await pixels(p) ?? ""))
  && await one(psCell("@layer x { #fl::scroll-button(right) { visibility: visible !important; } } #fl::scroll-button(right) { content: '\\25B6'; color: #cc0000; }", PS[4]?.[2] ?? ""), async (p) => /kept a ::scroll-button\(\*\) inside the opener showing/.test(await pixels(p) ?? "")));
check("a card with a small scroller whose ::scroll-button is generated beside its sole centred Delete → refused by the DOM rule (a second control); the same scroller without scroll buttons → its pixels decide",
  await one(psCell(PS[4]?.[1] ?? "", PS[4]?.[2] ?? ""), async (p) => /aria-label="Delete row"/.test((await drive(p)).dom ?? "")));

// ---- a label laid over the cell from OUTSIDE its subtree counts (the DOM rule)
check("a sibling label positioned over the cell (pointer-events none), the parent's absolute ::after label over it, a focused label over it → refused by the DOM rule; a FIXED toast with text over it → driven",
  await one(`${BASE}</style><div class="row" style="position:relative;display:inline-block"><div class="cell" id="c">${DEL}</div><span style="position:absolute;left:8px;top:14px;pointer-events:none">Oak</span></div>`, async (p) => (await drive(p)).dom !== null)
  && await one(`${BASE} #row { position: relative; display: inline-block; } #row::after { content: 'Oak'; position: absolute; left: 8px; top: 14px; pointer-events: none; }</style><div class="row" id="row"><div class="cell" id="c">${DEL}</div></div>`, async (p) => (await drive(p)).dom !== null)
  && await one(`${BASE}</style><div class="row" style="position:relative;display:inline-block"><div class="cell" id="c">${DEL}</div><span id="lab" tabindex="-1" style="position:absolute;left:8px;top:14px;pointer-events:none;outline:none">Oak</span></div><script>document.getElementById("lab").focus()</script>`, async (p) => (await drive(p)).dom !== null)
  && await one(`${BASE}</style><div class="row"><div class="cell" id="c">${DEL}</div></div><div style="position:fixed;left:28px;top:30px;background:#333333;color:#ffffff;padding:2px 6px">Saved</div>`, async (p) => driven(await drive(p))));

// ---- the cost — two frames only before shot A, and only after a park or a scroll into view (the later
// shots change nothing but the probe's sheet; the screenshot paints it first). Counted by the page's own requestAnimationFrame.
const rafCount = `window.rafs = 0; const raf0 = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (cb) => { window.rafs++; return raf0(cb); };`;
check("a kept-wrapper cell judged without a park or a scroll (the battery's path): no frame waited (all four shots); with the park: two frames, before shot A only — and both driven",
  await one(`${BASE}</style><div class="row"><div class="cell" id="c">${HUGW}</div></div><script>${rafCount}</script>`, async (p) => {
    const a = await pixels(p, false);
    const n0 = await p.evaluate("window.rafs");
    await p.evaluate("window.rafs = 0");
    const b = await pixels(p, true);
    const n1 = await p.evaluate("window.rafs");
    return a === null && b === null && n0 === 0 && n1 === 2;
  }));

// ---- the container's and the control's descendants are marked at every shot (cheap selectors) — an icon inside the
// control that sets visibility:visible itself is still hidden with its control; a label the page mounts once the pointer leaves
// (after the marking began) still counts
check("a cell whose button's icon sets visibility:visible itself → hidden with its control in shot A: driven",
  await one(`${BASE} #d i { visibility: visible; display: inline-block; width: 8px; height: 8px; background: #333333; }</style><div class="row"><div class="cell" id="c"><button id="d" aria-label="Delete row"><i></i></button></div></div>`, async (p) => driven(await drive(p))));
check("a card that mounts its label when the pointer leaves (after the probe parked it) → content: refused by the pixels",
  await one(`${BASE}</style><div class="row"><div class="card" id="c"><span id="lab"></span>${DEL}<span></span></div></div>
    <script>const c = document.getElementById("c"); c.addEventListener("mouseleave", () => { document.getElementById("lab").innerHTML = "<b>Oak crate</b>"; }); c.addEventListener("mouseenter", () => { document.getElementById("lab").innerHTML = ""; });</script>`,
    async (p) => { const r = await drive(p); return r.dom === null && /paints something of its own/.test(r.why ?? ""); }));

// ---- the plain-paint test's edges, and the outside's pseudo-elements and root background
check("a kept wrapper whose only other paint is INSIDE it (an outline 6 px inward, touching no edge) → not one plain colour: refused",
  await one(hug("padding:8px;background:#eeeeff;outline:2px solid #dd3333;outline-offset:-5px"), async (p) => { const r = await drive(p); return r.dom === null && /does not paint one plain colour/.test(r.why ?? ""); }));
check("a transparent wrapper around a filled wrapper around the sole button (both kept) → driven (a box with no fill paints nothing: only the filled one sets the colour)",
  await one(`${BASE}</style><div class="row"><div class="cell" id="c"><span style="display:inline-block;margin-top:2px;padding:3px"><span style="display:inline-block;padding:3px;background:#eeeeff">${DEL.replace("id=\"d\"", "id=\"d\" style=\"margin:0\"")}</span></span></div></div>`, async (p) => driven(await drive(p))));
check("a filled wrapper 10 px out from the button on every side (beyond the 8-px hug) → not kept: content, refused",
  await one(hug("padding:10px;background:#eeeeff"), async (p) => { const r = await drive(p); return r.dom === null && /paints something of its own/.test(r.why ?? ""); }));
check("a ::before inside the cell kept visible by a LAYERED !important → refused, naming the ::before whose rule did not take",
  await one(`${BASE} @layer x { .dot::before { visibility: visible !important; } } .dot::before { content: ''; display: inline-block; width: 8px; height: 8px; background: #22aa77; }</style><div class="row"><div class="card" id="c"><span class="dot" style="visibility:hidden"></span>${DEL}<span></span></div></div>`,
    async (p) => /kept a ::before inside the opener showing/.test(await pixels(p) ?? "")));
const sibTick = `${BASE} .sib::after { content: ''; position: absolute; left: 100px; top: 24px; height: 6px; width: var(--w, 50px); background: #4477ff; visibility: visible; }</style><div class="row" style="position:relative;display:inline-block"><div class="cell" id="c">${DEL}</div><span class="sib" id="sib"></span></div>
  <script>let w = 50; setInterval(() => { w = w > 2 ? w - 1 : 50; document.getElementById("sib").style.setProperty("--w", w + "px"); }, 2);</script>`;
check("a FOREIGN ::after bar (visibility:visible on the pseudo itself) repainting over the cell every 2 ms → driven on 6 runs out of 6 (the outside's pseudo-elements are hidden too)",
  await one(sibTick, async (p) => { let n = 0; for (let i = 0; i < 6; i++) if (driven(await drive(p))) n++; return n === 6; }));
// the ancestors' own pseudo-elements and the root's background are hidden too — a parent's ::after bar
// repainting under the transparent cell, a body background repainted by script (it paints the canvas) never decide
const ancAfter = `${BASE} #row::after { content: ''; position: absolute; left: 30px; top: 30px; height: 8px; width: var(--w, 50px); background: #4477ff; z-index: -1; }</style><div class="row" id="row" style="position:relative;display:inline-block;z-index:0"><div class="cell" id="c">${DEL}</div></div>
  <script>let w = 50; setInterval(() => { w = w > 2 ? w - 1 : 50; document.getElementById("row").style.setProperty("--w", w + "px"); }, 2);</script>`;
check("a parent's ::after bar repainting every 2 ms under the transparent cell → driven on 6 runs out of 6",
  await one(ancAfter, async (p) => { let n = 0; for (let i = 0; i < 6; i++) if (driven(await drive(p))) n++; return n === 6; }));
check("a body background repainted by script every 2 ms (it paints the canvas behind the transparent cell) → driven on 6 runs out of 6",
  await one(`${BASE.replace("background: #ffffff;", "")}</style><div class="row"><div class="cell" id="c">${DEL}</div></div><script>let i = 0; setInterval(() => { document.body.style.backgroundColor = (i++ % 2) ? "#ffffff" : "#ffe9e9"; }, 2);</script>`,
    async (p) => { let n = 0; for (let i = 0; i < 6; i++) if (driven(await drive(p))) n++; return n === 6; }));

// a page that replaces document.adoptedStyleSheets (a FAST / Lit-style app) before DOMContentLoaded, or in its own
// DOMContentLoaded listener, under a strict style CSP — the init CSS is adopted again at DOMContentLoaded and at load
const replacer = (when: "inline" | "dcl"): string => `${BASE} #d { transition: all 0.3s; }</style><div class="row"><div class="cell" id="c">${DEL}</div></div>
  <script>${when === "inline" ? "document.adoptedStyleSheets = []; document.addEventListener('DOMContentLoaded', () => { window.atDcl = getComputedStyle(document.getElementById('d')).transitionDuration; });" : "document.addEventListener('DOMContentLoaded', () => { document.adoptedStyleSheets = []; });"}</script>`;
check("under style-src 'nonce-…' a page replacing document.adoptedStyleSheets before DOMContentLoaded (the init CSS back by the page's own DOMContentLoaded listener), or in its own DOMContentLoaded listener → the init CSS still takes after load (transition 0s)",
  await one(replacer("inline"), async (p) => { await p.waitForLoadState("load"); return yes(p, "getComputedStyle(document.getElementById('d')).transitionDuration === '0s' && window.atDcl === '0s'"); }, { csp: true, init: true })
  && await one(replacer("dcl"), async (p) => { await p.waitForLoadState("load"); return yes(p, "getComputedStyle(document.getElementById('d')).transitionDuration === '0s'"); }, { csp: true, init: true }));

// ---- decodePng against PNGs encoded here with every row filter (None, Sub, Up, Average, Paeth), RGB and RGBA, on
// pixels whose neighbours sum odd (the Average filter's floor)
const { deflateSync, crc32 } = await import("node:zlib");
const encode = (w: number, h: number, ch: 3 | 4, px: Uint8Array): Buffer => {
  const stride = w * ch, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const f = y % 5;
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const x = px[y * stride + i] ?? 0, a = i >= ch ? px[y * stride + i - ch] ?? 0 : 0, b = y ? px[(y - 1) * stride + i] ?? 0 : 0, c = y && i >= ch ? px[(y - 1) * stride + i - ch] ?? 0 : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      raw[y * (stride + 1) + 1 + i] = (x - pred) & 255;
    }
  }
  const chunk = (type: string, d: Buffer): Buffer => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(type, "latin1"), d]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ch === 4 ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
};
let seed = 7;
const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed & 255; };
let pngOk = true;
for (const ch of [3, 4] as const) {
  const w = 13, h = 10, px = new Uint8Array(w * h * ch).map(() => rnd());
  const d = decodePng(encode(w, h, ch, px));
  for (let i = 0, j = 0; i < px.length; i += ch, j += 4) if (d.data[j] !== px[i] || d.data[j + 1] !== px[i + 1] || d.data[j + 2] !== px[i + 2] || d.data[j + 3] !== (ch === 4 ? px[i + 3] : 255)) { pngOk = false; break; }
}
check("decodePng: RGB and RGBA PNGs using all five row filters (Average on odd sums) decode to the exact pixels", pngOk);
check("plainKept: an edge pixel ON the line from the backdrop to the box colour but past it (t = 1.5, darker than the fill) → not a blend: not plain",
  PD.plainKept(img(40, 20, (x, y) => (x >= 10 && x < 30 && y >= 5 && y < 15 ? G : x === 30 && y === 9 ? [173, 203, 233] : W)), n, { x: 0, y: 0 }, [box(10, 5, 30.5, 15)]) !== null);
check("plainKept + shapeDistance: a 50 %-radius box (a disc) — one colour inside the disc, the backdrop outside it → plain; a second colour on its rim (a ring) → not plain",
  PD.plainKept(img(40, 40, (x, y) => (Math.hypot(x + 0.5 - 20, y + 0.5 - 20) < 15 ? G : W)), img(40, 40, () => W), { x: 0, y: 0 }, [box(5, 5, 35, 35, 15)]) === null
  && PD.plainKept(img(40, 40, (x, y) => { const d = Math.hypot(x + 0.5 - 20, y + 0.5 - 20); return d < 11 ? G : d < 15 ? (x < 20 ? [140, 200, 160] : G) : W; }), img(40, 40, () => W), { x: 0, y: 0 }, [box(5, 5, 35, 35, 15)]) !== null);

// ---- an element the page mounts in the container while it is screenshotted (a re-render inside the
// screenshot's own frame: Page.captureScreenshot runs rAF callbacks) would be hidden as "outside" in shot A — the shots would compare
// different content; it is refused ("changed while it was compared"); a static cell around its sole Delete is still driven
const DOTSPAN = "<span style=\\\"display:inline-block;width:0;height:0;border:6px solid #22aa77;border-radius:50%\\\"></span>";
const remount = (how: string): string => `${BASE}</style><div class="row"><div class="cell" id="c"><span id="slot"></span>${DEL}</div></div><script>const s = document.getElementById("slot"); const put = () => { s.innerHTML = "${DOTSPAN}"; }; put(); ${how}</script>`;
const changed = (r: { dom: string | null; why: string | null }): boolean => r.dom === null && /the opener's content changed while it was compared/.test(r.why ?? "");
check("a status dot (drawn by a border) re-mounted beside the sole Delete by requestAnimationFrame, or by a 16-ms timer → refused 'the opener's content changed while it was compared' (was: driven — the re-mounted dot hidden as outside in shot A)",
  await one(remount("const f = () => { put(); requestAnimationFrame(f); }; requestAnimationFrame(f);"), async (p) => changed(await drive(p)))
  && await one(remount("setInterval(put, 16);"), async (p) => changed(await drive(p))));
check("the same dot mounted once (never re-mounted) → refused by the pixels as before ('paints something of its own'); a cell holding only its sole Delete → driven",
  await one(remount(""), async (p) => /paints something of its own/.test((await drive(p)).why ?? ""))
  && await one(`${BASE}</style><div class="row"><div class="cell" id="c">${DEL}</div></div>`, async (p) => driven(await drive(p))));
check("a cell whose sole Delete re-mounts its OWN icon every frame (a hover icon swap: inside the control, hidden in every shot) → still driven",
  await one(`${BASE}</style><div class="row"><div class="cell" id="c">${DEL}</div></div><script>const d = document.getElementById("d"); const f = () => { d.innerHTML = "<span>x</span>"; requestAnimationFrame(f); }; requestAnimationFrame(f);</script>`, async (p) => driven(await drive(p))));

// ---- the extra pseudo-element rules (::placeholder, ::scroll-button(*) …) are put on the container's
// subtree only — never on "everything outside it" (that would make every shot resolve those pseudo-elements for the whole page: 4×
// slower per pair on a 75k-element page); the outside still hides ::before / ::after
const sheetSelectors = async (p: Page): Promise<string[]> => {
  await p.evaluate("window.__dtOwn = { box: document.getElementById('c'), ctl: document.getElementById('d') }");
  await p.evaluate(PD.ownMark, null);
  await p.evaluate(PD.ownShot, { shot: "A" as const });
  await p.evaluate(PD.ownShot, { shot: "B" as const });
  const sel: unknown = await p.evaluate("document.adoptedStyleSheets.flatMap((s) => Array.from(s.cssRules).map((r) => r.selectorText || ''))");
  await p.evaluate(PD.ownClear, null);
  return Array.isArray(sel) ? sel.map(String) : [];
};
check("the probe's sheet in a shot: no ::placeholder / ::file-selector-button / ::details-content / ::scroll-button / ::scroll-marker rule on the 'outside' selector; those rules stay on the container's subtree; the outside's ::before / ::after rule stays",
  await one(`${BASE}</style><div class="row"><div class="cell" id="c">${DEL}</div></div>`, async (p) => {
    const sel = await sheetSelectors(p);
    const outside = sel.filter((x) => x.includes(":not([data-dt-own]"));
    const extraPs = /::(placeholder|file-selector-button|details-content|scroll-button|scroll-marker)/;
    return outside.length > 0 && !outside.some((x) => extraPs.test(x)) && outside.some((x) => x.includes("::before"))
      && sel.some((x) => x.includes("[data-dt-own-in]") && x.includes("::placeholder"));
  }));

// ---- the walk for a label laid over the opener is bounded at 500,000 elements — a 6000-row table
// (about 150,000 elements: past a 100,000 cap) drives its actions cell
check("an actions cell in a 6000-row × 8-cell table (about 150,000 elements) → driven (was: refused 'more than 100000 boxes on the page')",
  await one(`<style>body{margin:0;font:13px sans-serif} td{padding:4px 8px;height:36px} td.act{text-align:center;width:60px} button{width:28px;height:24px}</style><table id="t"></table>`, async (p) => {
    await p.evaluate("{ const t = document.getElementById('t'); let h = ''; for (let i = 0; i < 6000; i++) { h += '<tr>'; for (let j = 0; j < 7; j++) h += '<td><span><b>r' + i + '</b> c' + j + '</span></td>'; h += i === 4 ? '<td class=\"act\" id=\"c\"><button id=\"d\" aria-label=\"Delete\">x</button></td>' : '<td class=\"act\"><span><button aria-label=\"Delete\">x</button></span></td>'; h += '</tr>'; } t.innerHTML = h; }");
    return driven(await drive(p));
  }));

// ---- a container inside a shadow root cannot be judged by the document sheet (it would inherit the
// hidden host in every shot, A = B whatever it shows) — refused
check("a pair whose container lies inside an open shadow root (a status dot beside its Delete) → refused 'inside a shadow root' (was: driven — A equal to B)",
  await one(`${BASE}</style><div id="app"></div><script>document.getElementById("app").attachShadow({ mode: "open" }).innerHTML = '<style>.cell{display:inline-block;position:relative;width:160px;height:44px;text-align:center;margin:20px} button{width:32px;height:26px;margin-top:8px}</style><div class="cell" id="c"><span style="position:absolute;left:10px;top:16px;width:0;height:0;border:6px solid #22aa77;border-radius:50%"></span><button id="d" aria-label="Delete row">x</button></div>';</script>`, async (p) => {
    await p.evaluate("{ const r = document.getElementById('app').shadowRoot; window.__dtOwn = { box: r.getElementById('c'), ctl: r.getElementById('d') }; }");
    const px = await PD.ownPixels(p, { park: true });
    return px !== null && /inside a shadow root/.test(px.why ?? "");
  }));

// ---- the DOM rule's refusal says why — ownWhy reads it after clickPointControl({ mark })
const ownWhyFn: unknown = Reflect.get(PD, "ownWhy");
check("a card with its own text around its centred sole Delete: clickPointControl refuses naming the Delete, and ownWhy says 'its own content: text \"Oak crate\"'; a plain cell → ownWhy null",
  typeof ownWhyFn === "function"
  && await one(`${BASE}</style><div class="row"><div class="card" id="c"><span>Oak crate</span>${DEL}<span></span></div></div>`, async (p) => {
    const r = await drive(p);
    return r.dom !== null && (await p.evaluate("window.__dtOwnWhy ?? null")) === "its own content: text \"Oak crate\"";
  })
  && await one(`${BASE}</style><div class="row"><div class="cell" id="c">${DEL}</div></div>`, async (p) => { await drive(p); return (await p.evaluate("window.__dtOwnWhy ?? null")) === null; }));

// ---- the anti-aliasing band is 1.5 px either side of the outline —
// a blend pixel 1.5–2.5 px outside it is paint outside the box; one 1 px outside a fractional edge is anti-aliasing; each corner
// keeps its own radius (only the top-left rounded: the square bottom-right corner is painted, not outside)
const fracBox = (right: number): PD.KeptRect => ({ x: 10, y: 5, right, bottom: 15, filled: true, shapes: [{ x: 10, y: 5, right, bottom: 15, r: [0, 0, 0, 0, 0, 0, 0, 0] }] });
const MIX: [number, number, number] = [228, 238, 248];
check("plainKept: a blend pixel whose centre lies 1.5 px outside the box's edge → paint outside it (not plain); a blend pixel 1 px outside a fractional edge (29.5) → anti-aliasing (plain)",
  PD.plainKept(img(40, 20, (x, y) => (x >= 10 && x < 30 && y >= 5 && y < 15 ? G : x === 31 && y === 9 ? MIX : W)), n, { x: 0, y: 0 }, [fracBox(30)]) !== null
  && PD.plainKept(img(40, 20, (x, y) => (x >= 10 && x < 30 && y >= 5 && y < 15 ? G : x === 30 && y >= 5 && y < 15 ? MIX : W)), n, { x: 0, y: 0 }, [fracBox(29.5)]) === null);
const tlOnly: PD.KeptRect = { x: 5, y: 5, right: 45, bottom: 45, filled: true, shapes: [{ x: 5, y: 5, right: 45, bottom: 45, r: [16, 16, 0, 0, 0, 0, 0, 0] }] };
check("plainKept: a box rounded only at its top-left corner (16 px), painted square elsewhere → plain (each corner keeps its own radius)",
  PD.plainKept(img(50, 50, (x, y) => { const px = x + 0.5, py = y + 0.5; if (px < 5 || py < 5 || px > 45 || py > 45) return W; return px < 21 && py < 21 && Math.hypot(px - 21, py - 21) > 16 ? W : G; }), img(50, 50, () => W), { x: 0, y: 0 }, [tlOnly]) === null);

// ---- the control's tooltip is exempt only when the probe's hover revealed it — a
// [role=tooltip] label or the control's aria-describedby target already on screen before the hover is the card's own label
// (tipPreMark remembers it), a visibility:hidden [role=tooltip] wrapper around a visible label counts as shown; a tooltip mounted
// on mouseenter, or a persistent one hidden (visibility / an opacity-0 wrapper) until :hover, stays exempt
const over = (attrs: string, inner = "Oak crate", css = ""): string => `${BASE} .cell{background:#fff} ${css}</style><div class="row" style="position:relative;display:inline-block"><div class="cell" id="c"><button id="d" aria-label="Delete crate"${attrs.includes("crate-name") ? " aria-describedby=\"crate-name\"" : ""}>x</button></div><span ${attrs} style="position:absolute;left:12px;top:14px;pointer-events:none">${inner}</span></div>`;
check("a sibling label laid over the card with role=\"tooltip\" (named by nothing), and the Delete's aria-describedby target laid over it — both on screen before the hover → refused (was: driven — the Delete pressed)",
  await one(over("role=\"tooltip\""), async (p) => refused(await drive(p)))
  && await one(over("id=\"crate-name\""), async (p) => refused(await drive(p))));
check("a visibility:hidden [role=tooltip] wrapper around a visibility:visible label laid over the card → shown before the hover → refused (was: driven)",
  await one(over("role=\"tooltip\"", "<span style=\"visibility:visible\">Oak crate</span>", ".row > span[role] { visibility: hidden; }"), async (p) => refused(await drive(p))));
check("the Delete's own tooltip revealed by the hover — [role=tooltip] mounted on mouseenter over the cell, a persistent [role=tooltip] hidden until :hover (visibility), an aria-describedby target in an opacity-0 wrapper until :hover → driven",
  await one(`${BASE} .cell{background:#fff}</style><div class="row"><div class="cell" id="c">${DEL}</div></div><script>const d = document.getElementById("d"); let t = null; d.addEventListener("mouseenter", () => { t = document.createElement("div"); t.setAttribute("role", "tooltip"); t.textContent = "Delete row"; const r = d.getBoundingClientRect(); t.style.cssText = "position:absolute;pointer-events:none;background:#111;color:#fff;font-size:11px;left:" + (r.x - 20) + "px;top:" + (r.y - 6) + "px"; document.body.appendChild(t); }); d.addEventListener("mouseleave", () => { if (t) t.remove(); t = null; });</script>`, async (p) => driven(await drive(p)))
  && await one(over("role=\"tooltip\"", "Delete crate", ".row > span[role] { visibility: hidden; } .row:hover > span[role] { visibility: visible; }"), async (p) => driven(await drive(p)))
  && await one(`${BASE} .cell{background:#fff} .tw{position:absolute;left:12px;top:14px;opacity:0;pointer-events:none} .row:hover > .tw{opacity:1}</style><div class="row" style="position:relative;display:inline-block"><div class="cell" id="c"><button id="d" aria-label="Delete crate" aria-describedby="crate-name">x</button></div><span class="tw"><span id="crate-name">Delete crate</span></span></div>`, async (p) => driven(await drive(p))));

// ---- the ring rule counts the container's sharp ring LAYERS' colours only — not its border,
// not a layer in its own background colour (Tailwind ring-offset) — a focus ring beside a border and ring-2 ring-offset-2 are
// decoration; two ring colours stay content
check("a cell with a 1-px border and a 2-px ring in another colour, a cell with a hover ring-offset (white = its background) + ring → driven (was: refused 'box-shadow ring in more than one colour'); a two-colour ring → still refused",
  await one(`${BASE} .cell{background:#fff;border:1px solid #c8c4b8;box-shadow:0 0 0 2px #93c5fd}</style><div class="row"><div class="cell" id="c">${DEL}</div></div>`, async (p) => driven(await drive(p)))
  && await one(`${BASE} .cell{background:#fff;border:1px solid #c8c4b8} #c:hover{box-shadow:0 0 0 2px #fff,0 0 0 4px #3b82f6}</style><div class="row"><div class="cell" id="c">${DEL}</div></div>`, async (p) => driven(await drive(p)))
  && await one(`${BASE} .cell{background:#fff;box-shadow:0 0 0 3px #16a34a,0 0 0 6px #bbf7d0}</style><div class="row"><div class="cell" id="c">${DEL}</div></div>`, async (p) => { const r = await drive(p); return r.dom !== null && /ring in more than one colour/.test(String(await p.evaluate("window.__dtOwnWhy ?? ''"))); }));

// ---- a ring layer in the container's own background colour is ignored only where it cannot
// show — over a semi-transparent background an inset band in that colour stacks alpha (a two-tone own frame, the pixel check
// sees it in both shots), so it counts; over an opaque border-box background it is invisible and does not
check("a cell with a semi-transparent background, an inset ring and an inset layer in its background colour → refused 'ring in more than one colour' (was: driven — the Delete pressed); the same over an opaque white background → driven",
  await one(`${BASE} .cell{background:rgba(22,163,74,.3);box-shadow:inset 0 0 0 3px #16a34a,inset 0 0 0 7px rgba(22,163,74,.3)}</style><div class="row"><div class="cell" id="c">${DEL}</div></div>`, async (p) => { const r = await drive(p); return r.dom !== null && /ring in more than one colour/.test(String(await p.evaluate("window.__dtOwnWhy ?? ''"))); })
  && await one(`${BASE} .cell{background:#fff;box-shadow:inset 0 0 0 3px #16a34a,inset 0 0 0 7px #fff}</style><div class="row"><div class="cell" id="c">${DEL}</div></div>`, async (p) => driven(await drive(p))));

await browser.close();
server.closeAllConnections();
server.close();
report();
