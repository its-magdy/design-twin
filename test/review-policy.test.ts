// PROTOTYPE (#174): when a write waits for the designer (bridge/src/review-policy.ts), pure.
//   bun test/review-policy.test.ts
import { check, report } from "./assert.ts";
import { layersChanged, REVIEW_PROTO_DEFAULT, reviewDecision, reviewProtoOf, type OpFact } from "../bridge/src/review-policy.ts";

const create: OpFact = { effect: "creates" };
const patch = (id: string): OpFact => ({ effect: "overwrites", nodes: [id] });
const source = (follows: number): OpFact => ({ effect: "overwrites", source: true, follows });

console.log("\nthe setting:");
check("defaults are today's behaviour", JSON.stringify(reviewProtoOf(undefined)) === JSON.stringify(REVIEW_PROTO_DEFAULT) && REVIEW_PROTO_DEFAULT.when === "today" && REVIEW_PROTO_DEFAULT.display === "list");
check("a stored setting is read field by field; a bad field keeps its default",
  JSON.stringify(reviewProtoOf({ display: "draft", when: "nope", threshold: -3 })) === JSON.stringify({ display: "draft", when: "today", threshold: 25 }));

console.log("\ncounting layers:");
check("creates count nothing; a node patched twice counts once; followers add up",
  layersChanged([create, patch("1:1"), patch("1:1"), patch("1:2"), source(10)]) === 12);

console.log("\ntoday:");
check("waits only with the checkbox ticked", reviewDecision("today", true, 25, [create]).wait && !reviewDecision("today", undefined, 25, [source(500)]).wait && !reviewDecision("today", false, 25, [source(500)]).wait);

console.log("\ncheckbox-forced:");
check("never set reads as ON", reviewDecision("checkbox-forced", undefined, 25, [create]).wait);
check("off: a plain create goes straight through", !reviewDecision("checkbox-forced", false, 25, [create, patch("1:1")]).wait);
const s = reviewDecision("checkbox-forced", false, 25, [source(10)]);
check("off: a source edit still waits, saying how many layers follow", s.wait && s.reason === "source edit: 10 layers follow");
const many = Array.from({ length: 142 }, (_, i) => patch("1:" + i));
const big = reviewDecision("checkbox-forced", false, 25, many);
check("off: over the threshold waits, saying by how much", big.wait && big.reason === "142 layers change — over 25");
check("…and exactly the threshold does not", !reviewDecision("checkbox-forced", false, 25, many.slice(0, 25)).wait);
check("on: the reason leads with the checkbox", /^'Review each change first' is on; source edit/.test(reviewDecision("checkbox-forced", true, 25, [source(2)]).reason));

console.log("\noverwrites:");
check("creates never wait, whatever the checkbox", !reviewDecision("overwrites", true, 25, [create, create]).wait);
check("an overwrite, move, delete or source edit waits", reviewDecision("overwrites", false, 25, [create, { effect: "deletes", nodes: ["1:1"] }]).wait && reviewDecision("overwrites", false, 25, [{ effect: "creates", source: true }]).wait);

report();
