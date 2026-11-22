// A bulk patch by rule (#171), the pure halves: the rule's check and words (bridge/src/rule-spec.ts), the token its dry
// run returns, the op's row in the wire check and the dry run's preview (commands.ts), and the review card's line for it
// (review-card.ts).
//   bun test/write-rules.test.ts
import { check, report } from "./assert.ts";
import { checkRule, describeScope, describeWhere, globMatch, MAX_RULE_MATCHES, RULE_TOKEN_MIN, ruleToken, solidMatches, tokenCount } from "../bridge/src/rule-spec.ts";
import { writeOpError, writeOpPreview, WRITE_OPS, type WriteOp } from "../bridge/src/commands.ts";
import { cardLines, lineText } from "../bridge/src/review-card.ts";

console.log("\nthe rule's check:");
const rule = (o: Record<string, unknown>) => checkRule(o, "ops[0]");
check("a rule of one kind passes", rule({ where: { text: "Terms v1" } }).problems.length === 0);
check("every kind together passes (they all must hold)", rule({ where: { text: "a", fill: "#ff0000", variable: "color/brand", instanceOf: "Button", name: "Foot*" }, scope: "file" }).problems.length === 0);
check("`where` must be an object", /ops\[0\]\.where: must be an object/.test(rule({ where: "x" }).problems.join()));
check("an empty `where` is refused, naming the kinds", /at least one of text, fill, variable, instanceOf, name/.test(rule({ where: {} }).problems.join()));
check("an unknown key is refused by name, never dropped", /ops\[0\]\.where\.colour: not a rule/.test(rule({ where: { colour: "#fff" } }).problems.join()));
check("each value is a non-empty string", /ops\[0\]\.where\.text: must be a non-empty string/.test(rule({ where: { text: "" } }).problems.join()) && /where\.name: must be a non-empty string/.test(rule({ where: { name: 3 } }).problems.join()));
check("`fill` must be a hex colour", /where\.fill: .*hex colour/.test(rule({ where: { fill: "red" } }).problems.join()));
check("the scopes: selection, page, file, or a list of pages", ["selection", "page", "file", ["Home"], ["Home", "Settings"]].every((s) => rule({ where: { text: "a" }, scope: s }).problems.length === 0));
check("any other scope is refused", /ops\[0\]\.scope: /.test(rule({ where: { text: "a" }, scope: "document" }).problems.join()) && /ops\[0\]\.scope: /.test(rule({ where: { text: "a" }, scope: [] }).problems.join()) && /scope\[1\]/.test(rule({ where: { text: "a" }, scope: ["A", ""] }).problems.join()));
check("a nodeId is refused: the rule picks the layers", /ops\[0\]\.nodeId: .*rule picks/.test(rule({ where: { text: "a" }, nodeId: "1:2" }).problems.join()));
check("a token must be a non-empty string", /ops\[0\]\.token/.test(rule({ where: { text: "a" }, token: 5 }).problems.join()));

console.log("\nthe rule in words:");
check("each kind in plain words, joined by and", describeWhere({ text: "Terms v1", fill: "#FF0000", instanceOf: "Button" }) === "text “Terms v1” and fill #ff0000 and an instance of 'Button'");
check("variable and name", describeWhere({ variable: "color/brand", name: "Foot*" }) === "variable 'color/brand' and name 'Foot*'");
check("the scopes in words", describeScope(undefined) === "the current page" && describeScope("selection") === "the selection" && describeScope("file") === "every page" && describeScope(["A"]) === "page 'A'" && describeScope(["A", "B"]) === "pages 'A', 'B'");

console.log("\nname patterns:");
check("no star: the exact name, case and all", globMatch("Footer", "Footer") && !globMatch("Footer", "footer") && !globMatch("Footer", "Footer 2"));
check("a star is any run of characters, an empty one too", globMatch("Foot*", "Footer") && globMatch("Foot*", "Foot") && globMatch("*er", "Footer") && globMatch("F*t*r", "Footer") && !globMatch("F*x", "Footer"));
check("only the star is special", globMatch("a.b?", "a.b?") && !globMatch("a.b?", "axbc"));
check("a long pattern of stars does not blow up", globMatch("*a*a*a*a*a*a*a*a*b", "a".repeat(60) + "b") && !globMatch("*a*a*a*a*a*a*a*a*b", "a".repeat(60)));

console.log("\nfill equality:");
check("a solid equals a hex by its 8-bit channels", solidMatches({ r: 1, g: 0, b: 0 }, 1, "#ff0000") && solidMatches({ r: 1, g: 0, b: 0 }, 1, "#F00") && !solidMatches({ r: 1, g: 0.01, b: 0 }, 1, "#ff0000"));
check("opacity is part of it: #ff000080 is a half-opaque red", solidMatches({ r: 1, g: 0, b: 0 }, 128 / 255, "#ff000080") && !solidMatches({ r: 1, g: 0, b: 0 }, 1, "#ff000080") && !solidMatches({ r: 1, g: 0, b: 0 }, 0.5, "#ff0000"));

console.log("\nthe dry run's token:");
const op = { where: { text: "Terms v1" }, scope: "file", set: { text: "Terms v2" } };
const t1 = ruleToken(op, ["1:2", "1:3"]);
check("it carries the count, then a hash", tokenCount(t1) === 2 && /^2\.[0-9a-f]{16}$/.test(t1));
check("the same matches give the same token, in any order", ruleToken(op, ["1:3", "1:2"]) === t1);
check("…and key order in the op does not matter", ruleToken({ set: { text: "Terms v2" }, scope: "file", where: { text: "Terms v1" } }, ["1:2", "1:3"]) === t1);
check("another match, another token", ruleToken(op, ["1:2", "1:4"]) !== t1 && ruleToken(op, ["1:2"]) !== t1);
check("another change, another token (it stands for this change on these layers)", ruleToken({ ...op, set: { text: "Terms v3" } }, ["1:2", "1:3"]) !== t1);
const withToken = { ...op, token: "x" };
check("the token itself is not part of it", ruleToken(withToken, ["1:2", "1:3"]) === t1);
check("a string that is not a token has no count", tokenCount("abc") === null && tokenCount("") === null);
check("the threshold is 25 matches; at most 2000 per op", RULE_TOKEN_MIN === 25 && MAX_RULE_MATCHES === 2000);

console.log("\nthe op on the wire and in the dry run:");
const pw: WriteOp = { op: "patchWhere", where: { text: "Terms v1" }, scope: "file", set: { text: "Terms v2" } };
check("patchWhere is an overwrite that needs where and set", WRITE_OPS.patchWhere.effect === "overwrites" && WRITE_OPS.patchWhere.required.join() === "where,set");
check("a good op passes the wire check", writeOpError(pw, 0) === null);
check("a bad rule is refused by the wire check, by path", /ops\[0\]\.where\.colour/.test(String(writeOpError({ op: "patchWhere", where: { colour: "#fff" }, set: { text: "x" } }, 0))));
check("a bad set is refused too", /ops\[0\]\.set/.test(String(writeOpError({ op: "patchWhere", where: { text: "a" }, set: { nope: 1 } }, 0))));
check("`where` on another op is refused, pointing at patchWhere", /only patchWhere/.test(String(writeOpError({ op: "patch", nodeId: "1:2", where: { text: "a" }, set: { text: "b" } }, 0))));
const pv = writeOpPreview(pw, 0);
check(`the preview says what changes where, and that the plugin counts (got ${JSON.stringify(pv.change)})`,
  pv.effect === "overwrites" && pv.target === "every page" && /every layer matching text “Terms v1” on every page: sets text/.test(String(pv.change)) && /over 25/.test(String(pv.change)) && Array.isArray(pv.fields));
check("an invalid op previews as invalid", writeOpPreview({ op: "patchWhere", where: {}, set: { text: "x" } }, 0).invalid !== undefined);

console.log("\nthe review card's line:");
const [line] = cardLines([pw], [{ matched: 40, pages: [{ page: "Flow A", count: 30 }, { page: "Flow B", count: 10 }], old: { text: "Terms v1" } }]);
check(`one line: the count, the rule, the change and the pages (got ${line ? JSON.stringify(lineText(line)) : "none"})`,
  !!line && lineText(line) === "40 layers matching text “Terms v1”: text “Terms v1” → “Terms v2” — on 'Flow A' (30), 'Flow B' (10)");
const [mixed] = cardLines([{ op: "patchWhere", where: { name: "Card" }, set: { radius: 12 } }], [{ matched: 3, pages: [{ page: "P", count: 3 }], old: {}, mixed: ["radius"] }]);
check(`old values that differ read "mixed" (got ${mixed ? JSON.stringify(lineText(mixed)) : "none"})`, !!mixed && lineText(mixed) === "3 layers matching name 'Card': radius mixed → 12 — on 'P' (3)");
const [many] = cardLines([pw], [{ matched: 9, pages: ["A", "B", "C", "D", "E"].map((p) => ({ page: p, count: 1 })) }]);
check(`past three pages the rest is counted (got ${many ? JSON.stringify(lineText(many)) : "none"})`, !!many && /on 'A' \(1\), 'B' \(1\), 'C' \(1\) and 2 more pages$/.test(lineText(many)));
const [one] = cardLines([pw], [{ matched: 1, pages: [{ page: "A", count: 1 }] }]);
check("one match reads as one layer", !!one && /^1 layer matching/.test(lineText(one)));
const [unread] = cardLines([pw], []);
check("unread by the plugin: the rule and the change, no count", !!unread && lineText(unread) === "Layers matching text “Terms v1”: text → “Terms v2”");

report();
