// Phase 3b — the item bank's pure rules: normalisation per type and every
// refusal, the rich text sanitiser against XSS, the stable item code, the
// lifecycle transitions and the AI draft parser.
import { describe, it, expect } from "@jest/globals";

import {
    assertTransition,
    canTransition,
    decodeAnswerKey,
    itemCodeFor,
    normalizeCompetencyKey,
    normalizeItemInput,
    parseAiDraftItems,
    reviewReadinessErrors,
    richTextToPlain,
    sanitizeRichText,
} from "../../../src/lib/test-item.util.js";

const base = (over = {}) => ({
    type: "SINGLE",
    stem: "<p>What is 2 + 2?</p>",
    options: [{ id: "a", text: "3" }, { id: "b", text: "4" }, { id: "c", text: "5" }],
    answerKey: { optionIds: ["b"] },
    difficulty: "EASY",
    competencyKey: "Numerical Reasoning",
    ...over,
});
const fields = (result) => result.errors.map((e) => e.field);

describe("sanitizeRichText", () => {
    // Every tag left in the output is a bare allowed tag (no attributes).
    const onlySafeTags = (html) =>
        (html.match(/<[^>]*>/g) ?? []).every((tag) => /^<\/?(p|br|strong|em|ul|ol|li|code|pre)>$/.test(tag));

    it.each([
        ["<script>alert(1)</script>Hello", "Hello"],
        ["<SCRIPT SRC=//evil.test/x.js></SCRIPT>ok", "ok"],
        ["<p onclick=\"steal()\">Hi</p>", "<p>Hi</p>"],
        ["<img src=x onerror=alert(1)>text", "text"],
        ["<a href=\"javascript:alert(1)\">link</a>", "link"],
        ["<p style=\"background:url(javascript:alert(1))\">x</p>", "<p>x</p>"],
        ["<scr<script>ipt>alert(1)</script>", "&lt;scr"],
        ["<script><script>alert(1)</script>alert(2)</script>", "alert(2)"],
        ["<svg><script>alert(1)</script></svg>after", "after"],
        ["<iframe src=\"javascript:alert(1)\"></iframe>z", "z"],
        ["<!-- <script>alert(1)</script> -->kept", "kept"],
        ["<p title=\"a>b\">t</p>", "<p>t</p>"],
        ["<p/onclick=alert(1)>z", "&lt;p/onclick=alert(1)&gt;z"],
        ["<math><mi xlink:href=\"javascript:alert(1)\">x</mi></math>y", "y"],
        ["<style>body{display:none}</style>visible", "visible"],
        ["<![CDATA[<script>alert(1)</script>]]>", "alert(1)]]&gt;"],
    ])("neutralises %s", (input, expected) => {
        const out = sanitizeRichText(input);
        expect(out).toBe(expected);
        expect(onlySafeTags(out)).toBe(true);
        // Nothing else can open markup: any other "<" is escaped text.
        expect(out.replace(/<\/?(p|br|strong|em|ul|ol|li|code|pre)>/g, "")).not.toContain("<");
    });

    it("keeps the allowed subset, drops attributes and balances tags", () => {
        expect(sanitizeRichText("<P CLASS=x>One<br/>two <STRONG>bold</STRONG> <em>it</em></P>")).toBe("<p>One<br>two <strong>bold</strong> <em>it</em></p>");
        expect(sanitizeRichText("<ul><li>one<li>two</ul>")).toBe("<ul><li>one</li><li>two</li></ul>");
        expect(sanitizeRichText("<pre><code>x</code></pre><p>open")).toBe("<pre><code>x</code></pre><p>open</p>");
        expect(sanitizeRichText("</em>stray")).toBe("stray");
    });

    it("escapes a bare < and &, keeps character references", () => {
        expect(sanitizeRichText("if a < b && c > d")).toBe("if a &lt; b &amp;&amp; c &gt; d");
        expect(sanitizeRichText("&lt;script&gt; &amp; &#x41;")).toBe("&lt;script&gt; &amp; &#x41;");
    });

    it("is idempotent on its own output and strips control characters", () => {
        const once = sanitizeRichText("<p>a < b <strong>x</strong></p>\u0000");
        expect(sanitizeRichText(once)).toBe(once);
        expect(once).not.toContain("\u0000");
    });

    it("plain text ignores markup", () => {
        expect(richTextToPlain("<p> </p><br>")).toBe("");
        expect(richTextToPlain("<p>Hi</p><p>there</p>")).toBe("Hi there");
    });
});

describe("normalizeItemInput", () => {
    it("normalises a SINGLE item (sanitised text, lower-case competency, defaults)", () => {
        const result = normalizeItemInput(base({ stem: "<p onclick=x>What is 2 + 2?</p><script>x</script>" }));
        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({
            type: "SINGLE",
            stem: "<p>What is 2 + 2?</p>",
            answerKey: { optionIds: ["b"] },
            competencyKey: "numerical-reasoning",
            language: "en",
            scoringRule: null,
            gradeLevelIds: [],
            discussionPrompt: false,
        });
    });

    it("stores the job family the way blueprints do (trimmed, upper case)", () => {
        expect(normalizeItemInput(base({ jobFamily: "  warehouse ops " })).value.jobFamily).toBe("WAREHOUSE OPS");
        expect(normalizeItemInput(base({ jobFamily: " " })).value.jobFamily).toBeNull();
    });

    it("assigns option ids by position when none are given", () => {
        const result = normalizeItemInput(base({ options: ["3", "4"], answerKey: { optionId: "b" } }));
        expect(result.value.options).toEqual([{ id: "a", text: "3" }, { id: "b", text: "4" }]);
        expect(result.value.answerKey).toEqual({ optionIds: ["b"] });
    });

    it.each([
        ["unknown type", { type: "ESSAY" }, "type"],
        ["empty stem", { stem: "<p> </p>" }, "stem"],
        ["one option", { options: [{ id: "a", text: "x" }], answerKey: { optionIds: ["a"] } }, "options"],
        ["seven options", { options: "abcdefg".split("").map((id) => ({ id, text: id })), answerKey: { optionIds: ["a"] } }, "options"],
        ["duplicate option ids", { options: [{ id: "a", text: "1" }, { id: "A", text: "2" }] , answerKey: { optionIds: ["a"] } }, "options[1].id"],
        ["bad option id", { options: [{ id: "a b", text: "1" }, { id: "c", text: "2" }] }, "options[0].id"],
        ["empty option text", { options: [{ id: "a", text: "<p></p>" }, { id: "b", text: "4" }] }, "options[0].text"],
        ["key names a missing option", { answerKey: { optionIds: ["z"] } }, "answerKey"],
        ["two keys on SINGLE", { answerKey: { optionIds: ["a", "b"] } }, "answerKey"],
        ["no key", { answerKey: undefined }, "answerKey"],
        ["bad difficulty", { difficulty: "TRIVIAL" }, "difficulty"],
        ["missing competency", { competencyKey: "  " }, "competencyKey"],
        ["bad competency", { competencyKey: "a/b" }, "competencyKey"],
        ["bad language", { language: "fr" }, "language"],
        ["time too long", { timeEstimateSec: 4000 }, "timeEstimateSec"],
        ["grade ids", { gradeLevelIds: [1, -2] }, "gradeLevelIds"],
        ["discussionPrompt text", { discussionPrompt: "maybe" }, "discussionPrompt"],
        ["exposure cap zero", { exposureCap: 0 }, "exposureCap"],
        ["bad item code", { itemCode: "x" }, "itemCode"],
    ])("refuses %s", (_label, over, field) => {
        const result = normalizeItemInput(base(over));
        expect(result.ok).toBe(false);
        expect(result.value).toBeNull();
        expect(fields(result)).toContain(field);
    });

    it("MULTI: at least one correct option, the scoring rule defaults and is checked", () => {
        const ok = normalizeItemInput(base({ type: "MULTI", answerKey: { optionIds: ["a", "c"] } }));
        expect(ok.value.scoringRule).toEqual({ multi: "ALL_OR_NOTHING" });
        expect(normalizeItemInput(base({ type: "MULTI", answerKey: { optionIds: ["a"] }, scoringRule: { multi: "partial" } })).value.scoringRule).toEqual({ multi: "PARTIAL" });
        expect(fields(normalizeItemInput(base({ type: "MULTI", answerKey: { optionIds: [] } })))).toContain("answerKey");
        expect(fields(normalizeItemInput(base({ type: "MULTI", answerKey: { optionIds: ["a", "a"] } })))).toContain("answerKey");
        expect(fields(normalizeItemInput(base({ type: "MULTI", scoringRule: { multi: "HALF" } })))).toContain("scoringRule.multi");
    });

    it("TRUE_FALSE: exactly the options true and false, defaulting when omitted", () => {
        const ok = normalizeItemInput(base({ type: "TRUE_FALSE", options: undefined, answerKey: { optionIds: ["FALSE"] } }));
        expect(ok.value.options.map((o) => o.id)).toEqual(["true", "false"]);
        expect(ok.value.answerKey).toEqual({ optionIds: ["false"] });
        expect(fields(normalizeItemInput(base({ type: "TRUE_FALSE", options: [{ id: "yes", text: "Yes" }, { id: "no", text: "No" }], answerKey: { optionIds: ["yes"] } })))).toContain("options");
        expect(fields(normalizeItemInput(base({ type: "TRUE_FALSE", options: [{ id: "true", text: "T" }, { id: "false", text: "F" }, { id: "x", text: "?" }], answerKey: { optionIds: ["true"] } })))).toContain("options");
        expect(fields(normalizeItemInput(base({ type: "TRUE_FALSE", options: undefined, answerKey: { optionIds: ["true", "false"] } })))).toContain("answerKey");
    });

    it("NUMERIC: no options, a finite value and a non-negative tolerance", () => {
        const ok = normalizeItemInput(base({ type: "NUMERIC", options: undefined, answerKey: { value: "12.5", tolerance: 0.5 } }));
        expect(ok.value).toMatchObject({ options: null, answerKey: { value: 12.5, tolerance: 0.5 }, scoringRule: null });
        expect(normalizeItemInput(base({ type: "NUMERIC", options: [], answerKey: { value: 3 } })).value.answerKey).toEqual({ value: 3, tolerance: 0 });
        expect(fields(normalizeItemInput(base({ type: "NUMERIC", answerKey: { value: 3 } })))).toContain("options");
        expect(fields(normalizeItemInput(base({ type: "NUMERIC", options: undefined, answerKey: { value: Infinity } })))).toContain("answerKey.value");
        expect(fields(normalizeItemInput(base({ type: "NUMERIC", options: undefined, answerKey: { value: "abc" } })))).toContain("answerKey.value");
        expect(fields(normalizeItemInput(base({ type: "NUMERIC", options: undefined, answerKey: { value: 1, tolerance: -1 } })))).toContain("answerKey.tolerance");
    });

    it("IMAGE_SINGLE needs its DAM image", () => {
        expect(fields(normalizeItemInput(base({ type: "IMAGE_SINGLE" })))).toContain("mediaId");
        expect(normalizeItemInput(base({ type: "IMAGE_SINGLE", mediaId: 55 })).ok).toBe(true);
    });

    it("never throws on garbage", () => {
        expect(normalizeItemInput(null).ok).toBe(false);
        expect(normalizeItemInput("x").ok).toBe(false);
        expect(normalizeItemInput(base({ options: "nope" })).ok).toBe(false);
    });
});

describe("codes, keys and transitions", () => {
    it("itemCodeFor is stable for the same content and differs for other content", () => {
        const a = itemCodeFor({ competencyKey: "numerical-reasoning", type: "SINGLE", stem: "<p>2+2?</p>" });
        expect(a).toMatch(/^TI-NUMERICAL-REASONING-[0-9A-F]{10}$/);
        expect(itemCodeFor({ competencyKey: "Numerical Reasoning", type: "SINGLE", stem: "2+2?" })).toBe(a);
        expect(itemCodeFor({ competencyKey: "numerical-reasoning", type: "SINGLE", stem: "2+3?" })).not.toBe(a);
    });

    it("normalizeCompetencyKey and decodeAnswerKey", () => {
        expect(normalizeCompetencyKey("  Safety  Rules ")).toBe("safety-rules");
        expect(decodeAnswerKey("{\"optionIds\":[\"a\"]}")).toEqual({ optionIds: ["a"] });
        expect(decodeAnswerKey("not json")).toBeNull();
        expect(decodeAnswerKey("[1]")).toBeNull();
    });

    it("allows exactly the lifecycle moves", () => {
        expect(canTransition("DRAFT", "IN_REVIEW")).toBe(true);
        expect(canTransition("IN_REVIEW", "PUBLISHED")).toBe(true);
        expect(canTransition("IN_REVIEW", "DRAFT")).toBe(true);
        expect(canTransition("PUBLISHED", "RETIRED")).toBe(true);
        expect(canTransition("DRAFT", "PUBLISHED")).toBe(false);
        expect(canTransition("PUBLISHED", "DRAFT")).toBe(false);
        expect(canTransition("RETIRED", "DRAFT")).toBe(false);
        expect(() => assertTransition("RETIRED", "PUBLISHED")).toThrow(expect.objectContaining({ status: 409, code: "HR-RECRUITMENT-TEST-ITEM-STATE" }));
    });

    it("review needs a rationale", () => {
        expect(reviewReadinessErrors({ rationale: "<p></p>" })).toHaveLength(1);
        expect(reviewReadinessErrors({ rationale: "Because 2 + 2 = 4" })).toEqual([]);
    });
});

describe("parseAiDraftItems", () => {
    const request = { count: 3, competencies: ["numerical-reasoning"], types: ["SINGLE", "NUMERIC"], difficulty: "MEDIUM", language: "ur" };
    const good = { type: "SINGLE", competencyKey: "numerical-reasoning", stem: "2 + 2?", options: ["3", "4"], correctOptionIds: ["b"], rationale: "Sum" };

    it("refuses an answer that is not JSON or has no list", () => {
        expect(parseAiDraftItems({ result: { raw: "Sorry, I cannot" } }, request)).toMatchObject({ ok: false });
        expect(parseAiDraftItems("not json {", request)).toMatchObject({ ok: false, reason: expect.stringMatching(/not valid JSON/) });
        expect(parseAiDraftItems({ result: { items: "x" } }, request).ok).toBe(false);
    });

    it("keeps valid drafts, drops the rest with a reason, and forces language and difficulty", () => {
        const out = parseAiDraftItems({
            result: {
                items: [
                    good,
                    { ...good, correctOptionIds: ["z"] },
                    { ...good, type: "MULTI" },
                    { ...good, competencyKey: "safety" },
                    "text",
                    { type: "NUMERIC", stem: "5 x 5?", value: 25, tolerance: 0, competencyKey: "numerical-reasoning", difficulty: "HARD", itemCode: "TI-HACK", exposureCap: 1 },
                    { ...good, stem: "<script>alert(1)</script>3 + 3?", correctOptionId: "a", correctOptionIds: undefined },
                    good,
                ],
            },
        }, request);
        expect(out.ok).toBe(true);
        expect(out.drafts).toHaveLength(3);
        expect(out.drafts.every((d) => d.language === "ur" && d.difficulty === "MEDIUM")).toBe(true);
        expect(out.drafts[1]).toMatchObject({ type: "NUMERIC", answerKey: { value: 25, tolerance: 0 }, itemCode: null, exposureCap: null });
        expect(out.drafts[2].stem).toBe("3 + 3?");
        expect(out.dropped.map((d) => d.index)).toEqual([1, 2, 3, 4, 7]);
        expect(out.dropped[0].reason).toMatch(/do not exist/);
        expect(out.dropped[1].reason).toMatch(/not requested/);
        expect(out.dropped[4].reason).toMatch(/More drafts/);
    });

    it("accepts a bare array or a fenced JSON string", () => {
        expect(parseAiDraftItems([good], request).drafts).toHaveLength(1);
        expect(parseAiDraftItems({ result: JSON.stringify({ drafts: [good] }) }, request).drafts).toHaveLength(1);
    });
});
