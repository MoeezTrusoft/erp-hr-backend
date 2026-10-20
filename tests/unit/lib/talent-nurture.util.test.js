// tests/unit/lib/talent-nurture.util.test.js
//
// Recruitment Phase 5 — the pure talent pool nurture decisions: the criteria a
// requisition implies (skills required, a placed role narrows by its city), who
// falls out of a proposal and in what order, the one-way run lifecycle, and the
// recruiter's drop list.
import { describe, it, expect } from "@jest/globals";
import {
    MAX_NURTURE_MEMBERS,
    NURTURE_RUN_STATUSES,
    approvedMembers,
    buildNurtureCriteria,
    checkNurtureRunTransition,
    normalizeDismissReason,
    nurtureExclusionReason,
    nurtureLocationNeedle,
    nurtureRunShouldExpire,
    nurtureSourceDetail,
    parseCandidateIds,
    resolveValidityDays,
    segmentFiltersFor,
} from "../../../src/lib/talent-nurture.util.js";

describe("criteria", () => {
    it("cuts a requisition location to its first part and ignores a remote role", () => {
        expect(nurtureLocationNeedle("Lahore, Pakistan")).toBe("Lahore");
        expect(nurtureLocationNeedle("Karachi / Hybrid")).toBe("Karachi");
        expect(nurtureLocationNeedle("Remote (PK hours)")).toBeNull();
        expect(nurtureLocationNeedle("  ")).toBeNull();
        expect(nurtureLocationNeedle(null)).toBeNull();
    });

    it("merges required and preferred skills case-insensitively", () => {
        const criteria = buildNurtureCriteria(
            { location: "Lahore, PK" },
            { required: ["Node.js", "PostgreSQL"], preferred: ["node.js", "Redis"] },
        );
        expect(criteria).toEqual({ skills: ["Node.js", "PostgreSQL", "Redis"], locations: ["Lahore"], remote: false });
    });

    it("marks a remote role and segments it on skills only", () => {
        const criteria = buildNurtureCriteria({ location: "Remote" }, { required: ["Go"], preferred: [] });
        expect(criteria.remote).toBe(true);
        expect(segmentFiltersFor(criteria)).toEqual({ skills: ["Go"] });
    });

    it("has no segment without skills: a location alone is not a match", () => {
        expect(segmentFiltersFor(buildNurtureCriteria({ location: "Lahore" }, null))).toBeNull();
        expect(segmentFiltersFor(buildNurtureCriteria({ location: "Lahore" }, { required: ["Java"] })))
            .toEqual({ skills: ["Java"], locations: ["Lahore"] });
    });
});

describe("exclusions", () => {
    it("reports privacy reasons ahead of the pipeline ones", () => {
        expect(nurtureExclusionReason({ anonymized: true, dnc: true })).toBe("anonymized");
        expect(nurtureExclusionReason({ dnc: true, applied: true })).toBe("dnc");
        expect(nurtureExclusionReason({ consentWithdrawn: true, invited: true })).toBe("consent_withdrawn");
        expect(nurtureExclusionReason({ applied: true, invited: true })).toBe("applied");
        expect(nurtureExclusionReason({ invited: true })).toBe("invited");
        expect(nurtureExclusionReason({})).toBeNull();
    });

    it("caps a proposal so one send stays one bounded transaction", () => {
        expect(MAX_NURTURE_MEMBERS).toBe(200);
    });
});

describe("run lifecycle", () => {
    it("only a PROPOSED run is decided", () => {
        expect(NURTURE_RUN_STATUSES).toEqual(["PROPOSED", "SENT", "DISMISSED", "EXPIRED"]);
        expect(checkNurtureRunTransition("PROPOSED", "SENT").ok).toBe(true);
        expect(checkNurtureRunTransition("PROPOSED", "DISMISSED").ok).toBe(true);
        expect(checkNurtureRunTransition("PROPOSED", "EXPIRED").ok).toBe(true);
        for (const from of ["SENT", "DISMISSED", "EXPIRED"]) {
            expect(checkNurtureRunTransition(from, "SENT")).toMatchObject({ ok: false, code: "HR-RECRUITMENT-NURTURE-TRANSITION-INVALID" });
        }
        expect(checkNurtureRunTransition("NOPE", "SENT")).toMatchObject({ ok: false, code: "HR-RECRUITMENT-NURTURE-STATUS-INVALID" });
    });

    it("expires a proposal once the requisition left the accepting states or its window passed", () => {
        const now = new Date("2026-10-20T00:00:00Z");
        expect(nurtureRunShouldExpire({ status: "CLOSED" }, now)).toBe(true);
        expect(nurtureRunShouldExpire({ status: "WITHDRAWN" }, now)).toBe(true);
        expect(nurtureRunShouldExpire(null, now)).toBe(true);
        expect(nurtureRunShouldExpire({ status: "POSTED", closesAt: new Date("2026-10-19T00:00:00Z") }, now)).toBe(true);
        // Between channels is not closed: the proposal waits.
        expect(nurtureRunShouldExpire({ status: "POSTED", closesAt: null }, now)).toBe(false);
        expect(nurtureRunShouldExpire({ status: "APPROVED", closesAt: new Date("2026-11-01T00:00:00Z") }, now)).toBe(false);
    });
});

describe("the recruiter's decision", () => {
    it("drops members and reports a drop id that was never proposed", () => {
        expect(approvedMembers([3, 1, 2, 2, "x"], ["2", 9])).toEqual({ approved: [3, 1], dropped: [2], ignoredDropIds: [9] });
        expect(parseCandidateIds(null)).toEqual([]);
    });

    it("validates the validity and the dismissal reason", () => {
        expect(resolveValidityDays(undefined)).toBe(30);
        expect(resolveValidityDays(undefined, 14)).toBe(14);
        expect(resolveValidityDays("45")).toBe(45);
        expect(() => resolveValidityDays(0)).toThrow(expect.objectContaining({ code: "HR-RECRUITMENT-NURTURE-VALIDITY-INVALID" }));
        expect(() => resolveValidityDays(400)).toThrow(expect.objectContaining({ status: 422 }));
        expect(normalizeDismissReason("  not this quarter ")).toBe("not this quarter");
        expect(() => normalizeDismissReason(" ")).toThrow(expect.objectContaining({ code: "HR-RECRUITMENT-NURTURE-REASON-REQUIRED" }));
        expect(() => normalizeDismissReason("x".repeat(501))).toThrow(expect.objectContaining({ status: 400 }));
    });

    it("names the run in the application source detail", () => {
        expect(nurtureSourceDetail(12)).toBe("nurture:12");
    });
});
