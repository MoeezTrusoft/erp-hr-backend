// tests/unit/documentAccess.test.js
//
// Phase 6 / decision record §4.4 — the DOCUMENT ACCESS MATRIX:
//
//   * the matrix answers audience × class exactly as the decision table spells
//     it out, including the cells that are "no" for the interviewer (screening
//     notes, budget/approval, offer approvals, offer letters)
//   * FAIL CLOSED: an unknown audience or unknown class is a refusal, never a
//     default-allow
//   * packetability: only the packet-conditioned classes plus INTERVIEW_BRIEF
//     can be packeted; screening notes / feedback / budget / offer NEVER
//   * the interviewer packet view refuses an interviewer audience without the
//     assignment row even for classes whose cell is "yes" — fail closed
//   * resolvePacketView returns visible items and distinct denied classes
//     (for audit) without ever naming denied content

import {
    AUDIENCES,
    DOC_CLASSES,
    PACKETABLE_CLASSES,
    canAccess,
    isPacketable,
    requiresPacketRow,
    resolvePacketView,
} from "../../src/lib/documentAccess.js";

const { RECRUITER, HIRING_MANAGER, INTERVIEWER, CANDIDATE } = AUDIENCES;
const {
    RESUME,
    PORTFOLIO,
    GENERAL_APPLICATION_DOC,
    SCREENING_NOTES,
    INTERVIEW_BRIEF,
    INTERVIEW_FEEDBACK,
    BUDGET_APPROVAL,
    OFFER_APPROVAL,
    OFFER_LETTER,
} = DOC_CLASSES;

describe("documentAccess — the §4.4 matrix", () => {
    it("lets recruiter and hiring manager see every candidate-material class", () => {
        for (const cls of [RESUME, PORTFOLIO, GENERAL_APPLICATION_DOC]) {
            expect(canAccess(cls, RECRUITER)).toBe(true);
            expect(canAccess(cls, HIRING_MANAGER)).toBe(true);
        }
    });

    it("lets interviewers see resume/portfolio/general docs — packet-conditioned for the latter two", () => {
        expect(canAccess(RESUME, INTERVIEWER)).toBe(true);
        expect(canAccess(PORTFOLIO, INTERVIEWER)).toBe(true);
        expect(canAccess(GENERAL_APPLICATION_DOC, INTERVIEWER)).toBe(true);
        // The packet conditioning is what requiresPacketRow expresses.
        expect(requiresPacketRow(RESUME)).toBe(false);
        expect(requiresPacketRow(PORTFOLIO)).toBe(true);
        expect(requiresPacketRow(GENERAL_APPLICATION_DOC)).toBe(true);
    });

    it("refuses interviewers for screening notes, budget/approval and offer documents", () => {
        for (const cls of [SCREENING_NOTES, BUDGET_APPROVAL, OFFER_APPROVAL, OFFER_LETTER]) {
            expect(canAccess(cls, INTERVIEWER)).toBe(false);
        }
    });

    it("never shows screening notes or feedback to candidates; offer letter is the candidate's", () => {
        expect(canAccess(SCREENING_NOTES, CANDIDATE)).toBe(false);
        expect(canAccess(INTERVIEW_FEEDBACK, CANDIDATE)).toBe(false);
        expect(canAccess(INTERVIEW_BRIEF, CANDIDATE)).toBe(false);
        expect(canAccess(OFFER_LETTER, CANDIDATE)).toBe(true);
    });

    it("interview briefs are visible to assigned interviewers without a packet row", () => {
        expect(canAccess(INTERVIEW_BRIEF, INTERVIEWER)).toBe(true);
        expect(requiresPacketRow(INTERVIEW_BRIEF)).toBe(false);
    });

    it("FAILS CLOSED on unknown audiences and unknown classes", () => {
        expect(canAccess(RESUME, "SUPERADMIN")).toBe(false);
        expect(canAccess("SOMETHING_ELSE", RECRUITER)).toBe(false);
        expect(canAccess(undefined, undefined)).toBe(false);
        expect(canAccess(null, null)).toBe(false);
    });
});

describe("documentAccess — packetability", () => {
    it("permits exactly the packet-conditioned classes plus the brief", () => {
        expect(PACKETABLE_CLASSES).toEqual([
            PORTFOLIO,
            GENERAL_APPLICATION_DOC,
            INTERVIEW_BRIEF,
        ]);
    });

    it("refuses everything an interviewer may never see — no flag can packet it", () => {
        for (const cls of [SCREENING_NOTES, INTERVIEW_FEEDBACK, BUDGET_APPROVAL, OFFER_APPROVAL, OFFER_LETTER]) {
            expect(isPacketable(cls)).toBe(false);
        }
        expect(isPacketable("MADE_UP")).toBe(false);
    });
});

describe("documentAccess — resolvePacketView (viewer context)", () => {
    const items = [
        { id: 1, docClass: PORTFOLIO, mediaId: 11 },
        { id: 2, docClass: GENERAL_APPLICATION_DOC, mediaId: 12 },
        { id: 3, docClass: INTERVIEW_BRIEF, mediaId: 13 },
    ];

    it("gives a recruiter the full packet", () => {
        const { visible, deniedClasses } = resolvePacketView({ audience: RECRUITER }, items);
        expect(visible).toHaveLength(3);
        expect(deniedClasses).toEqual([]);
    });

    it("gives a hiring manager the full packet", () => {
        const { visible } = resolvePacketView({ audience: HIRING_MANAGER }, items);
        expect(visible).toHaveLength(3);
    });

    it("gives an ASSIGNED interviewer the full packet", () => {
        const { visible, deniedClasses } = resolvePacketView(
            { audience: INTERVIEWER, isAssignedInterviewer: true },
            items,
        );
        expect(visible).toHaveLength(3);
        expect(deniedClasses).toEqual([]);
    });

    it("gives an UNASSIGNED interviewer NOTHING — fail closed even for permitted classes", () => {
        const { visible, deniedClasses } = resolvePacketView(
            { audience: INTERVIEWER, isAssignedInterviewer: false },
            items,
        );
        expect(visible).toEqual([]);
        // Audit names classes only, never content.
        expect(deniedClasses).toEqual([GENERAL_APPLICATION_DOC, INTERVIEW_BRIEF, PORTFOLIO].sort());
    });

    it("shows a candidate nothing — the packet is an internal view", () => {
        const { visible } = resolvePacketView({ audience: CANDIDATE, isAssignedInterviewer: false }, items);
        expect(visible).toEqual([]);
    });

    it("handles empty and missing packet lists without throwing", () => {
        expect(resolvePacketView({ audience: RECRUITER }, []).visible).toEqual([]);
        expect(resolvePacketView({ audience: RECRUITER }, undefined).visible).toEqual([]);
        expect(resolvePacketView(undefined, items).visible).toEqual([]);
    });
});
