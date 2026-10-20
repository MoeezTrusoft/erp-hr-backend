// tests/unit/lib/candidate-duplicate-match.util.test.js
//
// Recruitment Phase 2 — the pure half of duplicate detection: normalisers,
// score thresholds, boolean-only signals, conflicts and the stored pair order.
import { describe, it, expect } from "@jest/globals";

import {
    DUPLICATE_SUGGESTION_THRESHOLD,
    normalizeEmailKey,
    normalizeName,
    normalizePhoneKey,
    normalizeProfileUrl,
    orderedPair,
    pairConflicts,
    profileKeysOf,
    scorePair,
    scoreSignals,
} from "../../../src/lib/candidate-duplicate-match.util.js";

const base = (over = {}) => ({
    id: 1,
    firstName: "Ayesha",
    lastName: "Malik",
    email: "ayesha@example.com",
    phone: null,
    status: "active",
    consentStatus: "GRANTED",
    anonymizedAt: null,
    parsedResume: null,
    ...over,
});

describe("normalizeEmailKey", () => {
    it("lowercases, trims and strips a +tag", () => {
        expect(normalizeEmailKey("  John.Doe+Jobs@Example.COM ").key).toBe("john.doe@example.com");
    });

    it("folds gmail and googlemail together and ignores dots there", () => {
        const a = normalizeEmailKey("J.o.h.n.Doe+x@gmail.com");
        const b = normalizeEmailKey("johndoe@googlemail.com");
        expect(a.key).toBe("johndoe@gmail.com");
        expect(b.key).toBe(a.key);
    });

    it("keeps dots for non-gmail domains", () => {
        expect(normalizeEmailKey("john.doe@outlook.com").key).not.toBe(normalizeEmailKey("johndoe@outlook.com").key);
    });

    it("rejects malformed addresses", () => {
        for (const bad of [null, "", "no-at-sign", "@example.com", "user@", "+tag@example.com"]) {
            expect(normalizeEmailKey(bad)).toBeNull();
        }
    });
});

describe("normalizePhoneKey", () => {
    it("matches +92 international and 0-prefixed local forms on the last 10 digits", () => {
        const intl = normalizePhoneKey("+92 300 1234567");
        expect(intl).toBe("3001234567");
        expect(normalizePhoneKey("0300-1234567")).toBe(intl);
        expect(normalizePhoneKey("(0300) 123 45 67")).toBe(intl);
        expect(normalizePhoneKey("0092 300 1234567")).toBe(intl);
    });

    it("keeps 7-9 digit numbers whole and ignores anything shorter than 7 digits", () => {
        expect(normalizePhoneKey("123-4567")).toBe("1234567");
        expect(normalizePhoneKey("12345")).toBeNull();
        expect(normalizePhoneKey("ext 12")).toBeNull();
        expect(normalizePhoneKey(null)).toBeNull();
    });
});

describe("normalizeName", () => {
    it("strips diacritics and punctuation, lowercases and collapses spaces", () => {
        expect(normalizeName("  José ", "Ñúñez-O'Brien")).toBe("jose nunezobrien");
        expect(normalizeName("Zoë", "  van   der  Berg ")).toBe("zoe van der berg");
    });
});

describe("profile URLs", () => {
    it("normalises LinkedIn and GitHub profile URLs and ignores other hosts", () => {
        expect(normalizeProfileUrl("https://www.LinkedIn.com/in/ayesha-malik/?trk=x")).toBe("linkedin.com/in/ayesha-malik");
        expect(normalizeProfileUrl("http://m.linkedin.com/in/ayesha-malik")).toBe("linkedin.com/in/ayesha-malik");
        expect(normalizeProfileUrl("github.com/ayesha/")).toBe("github.com/ayesha");
        expect(normalizeProfileUrl("https://example.com/in/ayesha")).toBeNull();
        expect(normalizeProfileUrl("https://linkedin.com/company/acme")).toBeNull();
    });

    it("reads profile URLs from the parsed resume defensively", () => {
        const keys = profileKeysOf({ linkedinUrl: "linkedin.com/in/a", links: ["https://github.com/a", { url: "x" }] });
        expect([...keys].sort()).toEqual(["github.com/a", "linkedin.com/in/a"]);
        expect(profileKeysOf(null).size).toBe(0);
    });
});

describe("scorePair thresholds", () => {
    const other = (over) => base({ id: 2, firstName: "Bilal", lastName: "Ahmed", email: "bilal@example.org", ...over });

    it("email alone scores 90", () => {
        const r = scorePair(base({ email: "Ayesha+cv@Example.com" }), other({ email: "ayesha@example.com" }));
        expect(r.score).toBe(90);
        expect(r.suggest).toBe(true);
    });

    it("phone alone scores 70 and suggests", () => {
        const r = scorePair(base({ phone: "+92 300 1234567" }), other({ phone: "03001234567" }));
        expect(r.score).toBe(70);
        expect(r.suggest).toBe(true);
    });

    it("name alone never suggests", () => {
        const r = scorePair(base(), base({ id: 2, firstName: "AYÉSHA", email: "other@example.org" }));
        expect(r.signals.nameMatch).toBe(true);
        expect(r.score).toBeLessThan(DUPLICATE_SUGGESTION_THRESHOLD);
        expect(r.suggest).toBe(false);
    });

    it("name + phone scores 85", () => {
        const r = scorePair(base({ phone: "0300 1234567" }), base({ id: 2, email: "x@y.com", phone: "+923001234567" }));
        expect(r.score).toBe(85);
    });

    it("profile URL alone scores 80; resume hash alone scores 80", () => {
        expect(scorePair(base({ parsedResume: { linkedinUrl: "linkedin.com/in/a" } }), other({ parsedResume: { profileUrl: "https://www.linkedin.com/in/a/" } })).score).toBe(80);
        expect(scorePair(base({ parsedResume: { contentHash: "abc" } }), other({ parsedResume: { contentHash: "abc" } })).score).toBe(80);
    });

    it("nothing in common scores 0 and the score is capped at 100", () => {
        expect(scorePair(base(), other()).score).toBe(0);
        expect(scoreSignals({ emailMatch: true, phoneMatch: true, nameMatch: true, profileUrlMatch: true, resumeHashMatch: true })).toBe(100);
    });

    it("never suggests an anonymized or legally held candidate", () => {
        expect(scorePair(base(), base({ id: 2, anonymizedAt: new Date() })).suggest).toBe(false);
        expect(scorePair(base({ legalHold: true }), base({ id: 2 })).suggest).toBe(false);
    });

    it("signals are booleans only, never the matched values", () => {
        const r = scorePair(
            base({ phone: "+92 300 1234567", parsedResume: { contentHash: "abc", linkedinUrl: "linkedin.com/in/a" } }),
            base({ id: 2, phone: "03001234567", parsedResume: { contentHash: "abc", linkedinUrl: "linkedin.com/in/a" } }),
        );
        expect(Object.keys(r.signals).sort()).toEqual(["emailMatch", "nameMatch", "phoneMatch", "profileUrlMatch", "resumeHashMatch"]);
        for (const value of Object.values(r.signals)) expect(typeof value).toBe("boolean");
        const serialised = JSON.stringify(r.signals);
        for (const leaked of ["ayesha", "3001234567", "abc", "linkedin"]) expect(serialised).not.toContain(leaked);
    });
});

describe("pairConflicts", () => {
    it("flags blocking (anonymized, legal hold) and decision conflicts with ids only", () => {
        const a = base({ legalHold: true, applications: [{ jobRequisitionId: 9, stage: "interview" }, { jobRequisitionId: 4, stage: "hired" }] });
        const b = base({
            id: 2,
            consentStatus: "WITHDRAWN",
            status: "archived",
            anonymizedAt: new Date(),
            applications: [{ jobRequisitionId: 9, stage: "screening" }, { jobRequisitionId: 4, stage: "applied" }],
        });
        const byCode = Object.fromEntries(pairConflicts(a, b).map((c) => [c.code, c]));
        expect(byCode.ANONYMIZED).toEqual({ code: "ANONYMIZED", blocksMerge: true, candidateIds: [2] });
        expect(byCode.LEGAL_HOLD).toEqual({ code: "LEGAL_HOLD", blocksMerge: true, candidateIds: [1] });
        // Requisition 4 is terminal on one side, so only 9 is a live overlap.
        expect(byCode.SHARED_ACTIVE_REQUISITION).toEqual({ code: "SHARED_ACTIVE_REQUISITION", blocksMerge: false, requisitionIds: [9] });
        expect(byCode.CONSENT_MISMATCH.blocksMerge).toBe(false);
        expect(byCode.INACTIVE_CANDIDATE.candidateIds).toEqual([2]);
    });

    it("is empty for two clean active rows", () => {
        expect(pairConflicts(base(), base({ id: 2 }))).toEqual([]);
    });
});

describe("orderedPair", () => {
    it("always stores the lower id as candidateAId", () => {
        expect(orderedPair(9, 3)).toEqual({ candidateAId: 3, candidateBId: 9 });
        expect(orderedPair("3", "9")).toEqual({ candidateAId: 3, candidateBId: 9 });
    });
});
