// Recruitment Phase 5 (plan 6.2) — the INTERNAL publication channel and the
// pure rules of the internal board and referrals.
import { describe, it, expect } from "@jest/globals";

import {
    CHANNELS_REQUIRING_URL,
    INTERNAL_BOARD_CHANNELS,
    PUBLICATION_CHANNELS,
    PUBLIC_CHANNELS,
    SELF_HOSTED_CHANNELS,
    isInternalBoardPosting,
    isPublicPosting,
    normalizeChannelPublication,
    publicPostings,
    resolveDefaultPublicationChannels,
} from "../../../src/lib/requisitionPublication.js";
import { evaluateRequisitionEligibility } from "../../../src/lib/requisitionEligibility.js";
import {
    BONUS_DECISIONS,
    assertBonusTransition,
    boardRequisitionWhere,
    buildPlainDescription,
    employeeEmails,
    employeeName,
    isStillEmployed,
    normalizeBonusAmount,
    referralStatusForStage,
    toBoardJob,
    toHrReferral,
} from "../../../src/lib/internal-mobility.util.js";

const NOW = new Date("2026-10-20T09:00:00Z");

describe("the INTERNAL channel", () => {
    it("is a self-hosted channel that needs no URL and is never public", () => {
        expect(PUBLICATION_CHANNELS).toContain("INTERNAL");
        expect(SELF_HOSTED_CHANNELS).toEqual(["CAREER_SITE", "INTERNAL"]);
        expect(CHANNELS_REQUIRING_URL).not.toContain("INTERNAL");
        expect(PUBLIC_CHANNELS).not.toContain("INTERNAL");
        expect(PUBLIC_CHANNELS).toEqual(PUBLICATION_CHANNELS.filter((c) => c !== "INTERNAL"));
        expect(INTERNAL_BOARD_CHANNELS).toEqual(["CAREER_SITE", "INTERNAL"]);
        expect(normalizeChannelPublication("internal")).toEqual({ channel: "INTERNAL", externalUrl: null, channelRef: null });
        expect(resolveDefaultPublicationChannels("CAREER_SITE,INTERNAL").channels).toEqual(["CAREER_SITE", "INTERNAL"]);
    });

    it("classifies postings for the public readers and the board", () => {
        expect(isPublicPosting({ channel: "INTERNAL" })).toBe(false);
        expect(isPublicPosting({ channel: "career_site" })).toBe(true);
        expect(isInternalBoardPosting({ channel: "INTERNAL" })).toBe(true);
        expect(isInternalBoardPosting({ channel: "CAREER_SITE" })).toBe(true);
        expect(isInternalBoardPosting({ channel: "LINKEDIN" })).toBe(false);
        expect(publicPostings([{ channel: "INTERNAL" }, { channel: "INDEED" }]).map((p) => p.channel)).toEqual(["INDEED"]);
    });

    it("makes an INTERNAL-only posted requisition read as closed to the public, open internally", () => {
        const requisition = { status: "POSTED", closesAt: null };
        const postings = [{ channel: "INTERNAL", isActive: true, closedAt: null }];
        expect(evaluateRequisitionEligibility(requisition, { postings, now: NOW }).eligible).toBe(true);
        expect(evaluateRequisitionEligibility(requisition, { postings: publicPostings(postings), now: NOW })).toMatchObject({
            eligible: false,
            reasons: ["NO_ACTIVE_POSTING"],
        });
    });
});

describe("referral rules", () => {
    it("maps application stages to referral statuses", () => {
        expect(referralStatusForStage("applied")).toBeNull();
        for (const stage of ["screening", "interview", "offer", "on_hold"]) expect(referralStatusForStage(stage)).toBe("IN_PROCESS");
        expect(referralStatusForStage("HIRED")).toBe("HIRED");
        expect(referralStatusForStage("rejected")).toBe("REJECTED");
        expect(referralStatusForStage("withdrawn")).toBe("WITHDRAWN");
    });

    it("allows bonus decisions only from ELIGIBLE or APPROVED", () => {
        expect(Object.keys(BONUS_DECISIONS).sort()).toEqual(["APPROVED", "FORFEITED", "PAID"]);
        expect(assertBonusTransition("ELIGIBLE", "approved")).toBe("APPROVED");
        expect(assertBonusTransition("APPROVED", "PAID")).toBe("PAID");
        expect(assertBonusTransition("APPROVED", "FORFEITED")).toBe("FORFEITED");
        for (const from of ["NOT_ELIGIBLE", "PENDING", "PAID", "FORFEITED"]) {
            expect(() => assertBonusTransition(from, "FORFEITED")).toThrow(expect.objectContaining({ status: 409 }));
        }
        expect(() => assertBonusTransition("ELIGIBLE", "PAID")).toThrow(expect.objectContaining({ status: 409 }));
        expect(() => assertBonusTransition("ELIGIBLE", "ELIGIBLE")).toThrow(expect.objectContaining({ status: 400 }));
        expect(normalizeBonusAmount(1500)).toBe("1500");
        expect(() => normalizeBonusAmount("1.234")).toThrow();
    });

    it("hides the bonus amount from a scope without compensation", () => {
        const row = { id: 1, requisitionId: 2, referrerEmployeeId: 3, status: "HIRED", bonusStatus: "APPROVED", bonusAmount: "10.00", bonusCurrency: "PKR", version: 1 };
        expect(toHrReferral(row, { canSeeCompensation: true })).toMatchObject({ bonusAmount: "10.00", bonusCurrency: "PKR" });
        expect(toHrReferral(row)).toMatchObject({ bonusAmount: null, bonusCurrency: null, compensationRedacted: true });
    });
});

describe("employees", () => {
    it("knows who still works here", () => {
        expect(isStillEmployed({ status: "Active" }, NOW)).toBe(true);
        expect(isStillEmployed({ employement_status: "Inactive" }, NOW)).toBe(false);
        expect(isStillEmployed({ status: "Resigned" }, NOW)).toBe(false);
        expect(isStillEmployed({ separatedAt: new Date("2026-10-01") }, NOW)).toBe(false);
        expect(isStillEmployed({ separatedAt: new Date("2026-11-30") }, NOW)).toBe(true); // serving notice
        expect(isStillEmployed(null, NOW)).toBe(false);
    });

    it("matches by work email, then personal email, and splits the name", () => {
        expect(employeeEmails({ work_email: " A@X.test ", email: "a@x.test" })).toEqual(["a@x.test"]);
        expect(employeeEmails({ work_email: null, email: "p@mail.test" })).toEqual(["p@mail.test"]);
        expect(employeeName({ first_name: "Sara", last_name: "" })).toEqual({ firstName: "Sara", lastName: null });
        expect(employeeName({ employee_name: "Abdul Rasool Junejo" })).toEqual({ firstName: "Abdul", lastName: "Rasool Junejo" });
    });
});

describe("the board", () => {
    it("excludes the caller's own requisitions and keeps NULL owners", () => {
        const where = boardRequisitionWhere({ tenantId: "t", employeeId: 9, now: NOW });
        expect(where).toMatchObject({ tenantId: "t", status: { in: ["APPROVED", "POSTED"] }, requestedById: { not: 9 } });
        expect(where.AND).toContainEqual({ OR: [{ recruiterId: null }, { recruiterId: { not: 9 } }] });
        expect(where.AND).toContainEqual({ OR: [{ replacementEmployeeId: null }, { replacementEmployeeId: { not: 9 } }] });
        expect(where.postings.some.channel).toEqual({ in: ["CAREER_SITE", "INTERNAL"] });
    });

    it("builds a plain description from the published content only", () => {
        const text = buildPlainDescription({
            jobContent: { summary: "Lead the team.", requirements: ["5 years"], hiringProcess: ["internal: skip test"], faq: [{ q: "x" }] },
            description: "legacy",
        });
        expect(text).toBe("Lead the team.\n\nRequirements:\n- 5 years");
        expect(buildPlainDescription({ jobContent: {}, description: " legacy " })).toBe("legacy");
        expect(buildPlainDescription({})).toBeNull();
        const job = toBoardJob({ id: 1, title: "T", postings: [{ postedAt: new Date("2026-10-02") }, { postedAt: new Date("2026-10-01") }], publishedAt: new Date("2026-09-01") });
        expect(job.postedAt).toBe("2026-10-01T00:00:00.000Z");
    });
});
