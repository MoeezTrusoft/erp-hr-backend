// tests/unit/lib/prohibited-topics.util.test.js
//
// Recruitment Phase 3b — the prohibited-topic check on interview notes:
// English and romanised Urdu true positives, whole-word matching, and no false
// positive on ordinary words, names or the benign phrases masked first.
import { describe, it, expect } from "@jest/globals";

import { PROHIBITED_TOPIC_CATEGORIES, scanProhibitedTopics } from "../../../src/lib/prohibited-topics.util.js";

describe("scanProhibitedTopics", () => {
    it.each([
        ["What is your age?", "AGE"],
        ["She is 52 years old, might be slow", "AGE"],
        ["Kitni umar hai inki?", "AGE"],
        ["Is he married?", "MARITAL_STATUS"],
        ["Shadi shuda hain, travel nahi karengi", "MARITAL_STATUS"],
        ["Asked about her husband's job", "MARITAL_STATUS"],
        ["She mentioned she is pregnant", "PREGNANCY_FAMILY"],
        ["Planning a family soon?", "PREGNANCY_FAMILY"],
        ["Bachay kitne hain?", "PREGNANCY_FAMILY"],
        ["Seems very religious, prays often", "RELIGION"],
        ["Namaz break needed", "RELIGION"],
        ["He is Ahmadi", "RELIGION"],
        ["Uses a wheelchair", "DISABILITY"],
        ["Biradari connections", "ETHNICITY_CASTE"],
        ["Which political party does he support", "POLITICAL"],
    ])("flags %j as %s", (note, category) => {
        const out = scanProhibitedTopics(note);
        expect(out.flagged).toBe(true);
        expect(out.categories).toContain(category);
        expect(out.terms.every((t) => PROHIBITED_TOPIC_CATEGORIES.includes(t.split(":")[0]))).toBe(true);
    });

    it.each([
        "Walked through the agenda and the project stage",
        "Average response time was good; managed the team well",
        "Umar answered the SQL questions clearly",
        "Has run a marriage counselling practice for five years",
        "Explained the HTTP max-age header and cache age",
        "Found a race condition in the worker",
        "Strong engagement with stakeholders",
        "Image processing and message queues",
        "Template rendering is fast",
    ])("does not flag %j", (note) => {
        expect(scanProhibitedTopics(note)).toEqual({ flagged: false, categories: [], terms: [] });
    });

    it("scans several notes at once and is case-insensitive", () => {
        const out = scanProhibitedTopics(["fine"], null, "MARRIED last year", ["", "what AGE"]);
        expect(out.terms).toEqual(["AGE:age", "MARITAL_STATUS:married"]);
    });

    it("answers clean for empty input", () => {
        expect(scanProhibitedTopics()).toEqual({ flagged: false, categories: [], terms: [] });
        expect(scanProhibitedTopics(null, undefined, "  ")).toEqual({ flagged: false, categories: [], terms: [] });
    });
});
