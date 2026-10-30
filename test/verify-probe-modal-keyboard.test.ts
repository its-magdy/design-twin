// Real-browser regression for a Tab-walk starting point inside an already-open modal.
import { chromium } from "playwright";
import { sentinelInsert } from "../design-to-code/probe-behaviour.ts";
import { check, report } from "./assert.ts";

let browser;
try { browser = await chromium.launch({headless:true}); }
catch (error) {
  if (process.env.CI !== "true") { console.log(`SKIPPED (renderer unavailable: ${String(error).split("\n")[0]})`); process.exit(0); }
  check("Chromium is available in CI", false); report();
}
if (!browser) throw new Error("Chromium did not launch");
const page = await browser.newPage();
await page.setContent('<button id="first">First</button><button id="last">Last</button>');
check("ordinary page establishes its starting point in body", await page.evaluate(sentinelInsert,null) && await page.evaluate('document.querySelector("[data-dt-sentinel]")?.parentElement?.tagName')==="BODY");
await page.keyboard.press("Tab");
check("ordinary page starts before its first control", await page.evaluate('document.activeElement?.id') === "first");

for (const reachable of [true,false]) {
  await page.setContent(`<button>Background</button><dialog id="modal"><button id="close" ${reachable?"":"tabindex=-1"}>Close</button><input aria-label="Name"><button id="cancel">Cancel</button></dialog>`);
  await page.evaluate('document.querySelector("dialog").showModal()');
  check(`native modal (${reachable?"reachable":"removed-from-tab-order"} Close) accepts the sentinel inside its active scope`, await page.evaluate(sentinelInsert,null) && await page.locator("#modal > [data-dt-sentinel]").count()===1);
  const stops:string[]=[];
  for(let i=0;i<12;i++){await page.keyboard.press("Tab");const state=await page.evaluate<{id:string;end:boolean}>('({id:document.activeElement?.id??"",end:document.activeElement?.hasAttribute("data-dt-sentinel")??false})');if(state.end)break;stops.push(state.id);}
  check(`real Tab walk ${reachable?"includes":"does not invent reachability for"} the first Close control`, stops.includes("close")===reachable);
}

await page.setContent('<dialog id="inner"><button>Inner control</button></dialog><dialog id="outer"><button>Outer control</button></dialog>');
await page.evaluate('document.querySelector("#outer").showModal();document.querySelector("#inner").showModal()');
check("nested native modals use the active top modal rather than DOM order", await page.evaluate(sentinelInsert,null) && await page.locator("#inner > [data-dt-sentinel]").count()===1);

await page.setContent('<div role="dialog" aria-modal="true" id="custom"><button id="custom-close">Close</button></div>');
await page.locator("#custom-close").focus();
check("an active ARIA modal also scopes its starting point", await page.evaluate(sentinelInsert,null) && await page.locator("#custom > [data-dt-sentinel]").count()===1);

await page.setContent('<button>Inert page</button>');
await page.evaluate('document.body.inert=true');
check("a rejected starting focus is reported and its marker removed", !(await page.evaluate(sentinelInsert,null)) && await page.locator("[data-dt-sentinel]").count()===0);
await browser.close();
report();
