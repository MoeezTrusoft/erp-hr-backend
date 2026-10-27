// tests/unit/services/recruitment-workspace.service.test.js
//
// Recruitment Phase 3a — the interviewer and hiring manager workspaces: an
// interviewer sees only the panels they sit on, other panelists' scorecards
// stay hidden until their own is submitted, a manager sees only their own
// requisitions, and the masks are applied. Runs over the in-memory prisma, so
// the scope predicates are evaluated rather than asserted as call shapes.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { createInterviewFakeDb } from "./helpers/interview-orchestration.fake.js";

const fake = { db: null, store: null };
const prismaProxy = new Proxy({}, { get: (_t, key) => fake.db[key] });
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prismaProxy }));

const { getInterviewerWorkspace, getManagerWorkspace } = await import("../../../src/services/recruitment-workspace.service.js");
const { resolveRecruitmentScope } = await import("../../../src/lib/recruitment-access.util.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

const T = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-20T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (offsetMs) => new Date(NOW.getTime() + offsetMs);
const asTenant = (fn) => mcpCtx.run({ user: { tenantId: T } }, fn);

const scopeOf = (roles, employeeId) => resolveRecruitmentScope({ roles, employeeId });
const INTERVIEWER_7 = scopeOf(["INTERVIEWER"], 7);
const MANAGER_42 = scopeOf(["HIRING_MANAGER"], 42);
const RECRUITER = scopeOf(["RECRUITER"], 1);

const REQS = {
    12: { id: 12, tenantId: T, title: "Engineer", status: "POSTED", openings: 2, priority: "High", requestedById: 42, approvedById: null, recruiterId: 90, createdAt: at(-30 * DAY) },
    13: { id: 13, tenantId: T, title: "Designer", status: "APPROVED", openings: 1, priority: null, requestedById: 43, approvedById: null, recruiterId: 90, createdAt: at(-20 * DAY) },
    14: { id: 14, tenantId: T, title: "Analyst", status: "CLOSED", openings: 1, priority: null, requestedById: 44, approvedById: 42, recruiterId: 90, createdAt: at(-10 * DAY) },
};

const card = (reviewerId, submitted, recommendation = "HIRE") => ({
    id: reviewerId * 1000 + Math.floor(Math.random() * 999),
    reviewerId,
    submittedAt: submitted ? at(-HOUR) : null,
    recommendation,
    notes: "should never appear",
});

function interview(id, over = {}) {
    const reqId = over.reqId ?? 12;
    return {
        id,
        tenantId: T,
        applicationId: 500 + id,
        interviewType: "TECHNICAL",
        status: "SCHEDULED",
        decision: null,
        notes: "recruiter-only note",
        scheduledAt: at(2 * DAY),
        durationMinutes: 45,
        location: "Room 1",
        remindersPausedAt: null,
        decisionPromptedAt: null,
        interviewers: [{ employeeId: 7, status: "accepted" }, { employeeId: 8, status: "accepted" }],
        scorecards: [],
        packetItems: [],
        application: {
            id: 500 + id,
            jobRequisitionId: reqId,
            stage: "interview",
            candidate: { id: 300 + id, firstName: "Cand", lastName: String(id), anonymizedAt: null, resumeMediaId: 77, notes: "secret" },
            jobRequisition: { ...REQS[reqId] },
        },
        ...over,
    };
}

beforeEach(() => {
    Object.assign(fake, createInterviewFakeDb());
});

describe("interviewer workspace", () => {
    beforeEach(() => {
        fake.store.interviews.push(
            interview(1, {
                packetItems: [
                    { id: 11, docClass: "PORTFOLIO" },
                    { id: 12, docClass: "SCREENING_NOTES" }, // refused by the matrix for interviewers
                    { id: 13, docClass: "INTERVIEW_BRIEF" },
                ],
            }),
            interview(2, { scheduledAt: at(-2 * DAY), scorecards: [card(7, true), card(8, true, "NO_HIRE")] }),
            interview(3, { scheduledAt: at(-3 * DAY), scorecards: [card(7, false), card(8, true)] }),
            interview(4, { interviewers: [{ employeeId: 9, status: "accepted" }] }), // not mine
            interview(5, { status: "CANCELLED" }),
            interview(6, { scheduledAt: at(20 * DAY) }), // outside the 14-day window
            interview(7, { scheduledAt: at(-HOUR), application: { ...interview(7).application, candidate: { id: 1, firstName: "Gone", lastName: "Person", anonymizedAt: at(-DAY) } } }),
        );
    });

    it("lists only the caller's own panels, upcoming and recent within 14 days", async () => {
        const ws = await asTenant(async () => await getInterviewerWorkspace({ tenantId: T, scope: INTERVIEWER_7, now: NOW }));
        expect(ws.upcoming.items.map((i) => i.interviewId)).toEqual([1]);
        expect(ws.recent.items.map((i) => i.interviewId)).toEqual([7, 2, 3]);
        expect(ws.upcoming.total).toBe(1);
        expect(ws.recent.total).toBe(3);
        const first = ws.upcoming.items[0];
        expect(first).toMatchObject({
            applicationId: 501,
            requisitionId: 12,
            requisitionTitle: "Engineer",
            candidateName: "Cand 1",
            durationMinutes: 45,
            location: "Room 1",
            myScorecard: { state: "NOT_STARTED", submittedAt: null },
        });
        // Packet: the matrix-permitted rows plus the resume; ids only.
        expect(first.packet).toEqual({ itemCount: 3, itemIds: [11, 13], resumeAvailable: true });
        // Nothing internal leaks: no notes of any kind.
        expect(JSON.stringify(ws)).not.toMatch(/secret|recruiter-only|should never appear/);
    });

    it("other panelists' scorecards are visible only once mine is submitted", async () => {
        const ws = await asTenant(async () => await getInterviewerWorkspace({ tenantId: T, scope: INTERVIEWER_7, now: NOW }));
        const byId = Object.fromEntries([...ws.upcoming.items, ...ws.recent.items].map((i) => [i.interviewId, i]));
        expect(byId[2].myScorecard.state).toBe("SUBMITTED");
        expect(byId[2].panel).toEqual({ size: 2, othersScorecardsVisible: true, submittedCount: 2 });
        expect(byId[3].myScorecard.state).toBe("DRAFT");
        expect(byId[3].panel).toEqual({ size: 2, othersScorecardsVisible: false, submittedCount: null });
        expect(byId[1].panel.othersScorecardsVisible).toBe(false);
    });

    it("an anonymised candidate has no display name", async () => {
        const ws = await asTenant(async () => await getInterviewerWorkspace({ tenantId: T, scope: INTERVIEWER_7, now: NOW }));
        expect(ws.recent.items.find((i) => i.interviewId === 7)).toMatchObject({ candidateName: null, candidateNameRedacted: true });
    });

    it("another interviewer sees only their own panel; finance sees none", async () => {
        const nine = await asTenant(async () => await getInterviewerWorkspace({ tenantId: T, scope: scopeOf(["INTERVIEWER"], 9), now: NOW }));
        expect([...nine.upcoming.items, ...nine.recent.items].map((i) => i.interviewId)).toEqual([4]);
        const finance = await asTenant(async () => await getInterviewerWorkspace({ tenantId: T, scope: scopeOf(["FINANCE"], 7), now: NOW }));
        expect(finance.upcoming.total + finance.recent.total).toBe(0);
    });

    it("needs the caller's employee id", async () => {
        await expect(asTenant(async () => await getInterviewerWorkspace({ tenantId: T, scope: scopeOf(["INTERVIEWER"], null), now: NOW })))
            .rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-WORKSPACE-EMPLOYEE-REQUIRED" });
    });

    it("shows the decision prompts addressed to me as the hiring manager", async () => {
        fake.store.interviews.push(
            interview(20, { status: "COMPLETED", scheduledAt: at(-DAY), decisionPromptedAt: at(-HOUR), scorecards: [card(7, true), card(8, true, "STRONG_HIRE")] }),
            interview(21, { reqId: 13, status: "COMPLETED", scheduledAt: at(-DAY), decisionPromptedAt: at(-HOUR) }), // someone else's requisition
            interview(22, { status: "COMPLETED", scheduledAt: at(-DAY), decisionPromptedAt: at(-HOUR), decision: "HOLD" }), // decided
        );
        const ws = await asTenant(async () => await getInterviewerWorkspace({ tenantId: T, scope: MANAGER_42, now: NOW }));
        expect(ws.decisionPrompts.items).toEqual([expect.objectContaining({
            interviewId: 20,
            requisitionId: 12,
            panelSize: 2,
            submittedCount: 2,
            recommendationCounts: { HIRE: 1, STRONG_HIRE: 1 },
        })]);
        const interviewer = await asTenant(async () => await getInterviewerWorkspace({ tenantId: T, scope: INTERVIEWER_7, now: NOW }));
        expect(interviewer.decisionPrompts.total).toBe(0);
    });
});

describe("hiring manager workspace", () => {
    beforeEach(() => {
        fake.store.requisitions.push(...Object.values(REQS).map((r) => ({ ...r })));
        const app = (id, reqId, stage) => ({ id, tenantId: T, jobRequisitionId: reqId, stage });
        fake.store.applications.push(app(1, 12, "applied"), app(2, 12, "applied"), app(3, 12, "interview"), app(4, 13, "screening"));
        const entry = (id, applicationId, reqId, source, note) => ({
            id, tenantId: T, applicationId, requisitionId: reqId, source, note, addedAt: at(-id * HOUR),
            requisition: { ...REQS[reqId] },
            application: { id: applicationId, stage: "screening", jobRequisition: { ...REQS[reqId] }, candidate: { id: applicationId, firstName: "P", lastName: String(applicationId), anonymizedAt: null } },
        });
        fake.store.shortlist.push(
            entry(1, 1, 12, "SCORING_PROPOSAL", "fit 81"),
            entry(2, 2, 12, "MANUAL", "added by hand"),
            entry(3, 4, 13, "SCORING_PROPOSAL", "fit 77"),
        );
        fake.store.interviews.push(
            interview(30, { status: "COMPLETED", scheduledAt: at(-DAY), scorecards: [card(7, true), card(8, true)] }),
            interview(31, { scheduledAt: at(-DAY), scorecards: [card(7, true)] }), // panel incomplete
            interview(32, { reqId: 13, status: "COMPLETED", scheduledAt: at(-DAY), scorecards: [card(7, true), card(8, true)] }),
        );
        const offer = (id, reqId, approvalRecords) => ({
            id, tenantId: T, applicationId: 600 + id, jobRequisitionId: reqId, status: "DRAFT", approvalStatus: "PENDING",
            salary: "250000", compensation: { baseSalary: 250000 }, created_at: at(-id * HOUR), startDate: null, expiryDate: null,
            approvalRecords, jobRequisition: { ...REQS[reqId] }, application: { jobRequisition: { ...REQS[reqId] } },
        });
        fake.store.offers.push(offer(1, 12, []), offer(2, 12, [{ stage: "hiringManager", decision: "APPROVED" }]), offer(3, 13, []));
    });

    it("a manager sees only their own requisitions, with counts", async () => {
        const ws = await asTenant(async () => await getManagerWorkspace({ tenantId: T, scope: MANAGER_42, now: NOW }));
        expect(ws.managerEmployeeId).toBe(42);
        // 12 is theirs; 14 (approved by them) is CLOSED, so not in the default open view.
        expect(ws.requisitions.items.map((r) => r.requisitionId)).toEqual([12]);
        expect(ws.requisitions.items[0]).toMatchObject({
            stageCounts: { applied: 2, interview: 1 },
            applicationCount: 3,
            pendingShortlistProposals: 1,
            interviewsAwaitingDecision: 1,
        });
        expect(ws.shortlistProposals.items).toEqual([expect.objectContaining({ shortlistEntryId: 1, applicationId: 1, note: "fit 81" })]);
        expect(ws.interviewsAwaitingDecision.items.map((i) => i.interviewId)).toEqual([30]);
        expect(ws.offersAwaitingAction.items.map((o) => o.offerId)).toEqual([1]);
        expect(JSON.stringify(ws)).not.toMatch(/250000|baseSalary|salary/);

        const all = await asTenant(async () => await getManagerWorkspace({ tenantId: T, scope: MANAGER_42, status: "ALL", now: NOW }));
        expect(all.requisitions.items.map((r) => r.requisitionId)).toEqual([14, 12]);
    });

    it("a recruiter sees the tenant, or one manager's with managerEmployeeId, paginated", async () => {
        const tenant = await asTenant(async () => await getManagerWorkspace({ tenantId: T, scope: RECRUITER, now: NOW, pageSize: 1, page: 2 }));
        expect(tenant.requisitions).toMatchObject({ total: 2, page: 2, pageSize: 1 });
        expect(tenant.requisitions.items.map((r) => r.requisitionId)).toEqual([12]);
        expect(tenant.interviewsAwaitingDecision.total).toBe(2);

        const other = await asTenant(async () => await getManagerWorkspace({ tenantId: T, scope: RECRUITER, managerEmployeeId: 43, now: NOW }));
        expect(other.requisitions.items.map((r) => r.requisitionId)).toEqual([13]);
        expect(other.offersAwaitingAction.items.map((o) => o.offerId)).toEqual([3]);
        expect(other.interviewsAwaitingDecision.items.map((i) => i.interviewId)).toEqual([32]);
    });

    it("a manager cannot widen to another manager with managerEmployeeId", async () => {
        const ws = await asTenant(async () => await getManagerWorkspace({ tenantId: T, scope: MANAGER_42, managerEmployeeId: 43, now: NOW }));
        expect(ws.requisitions.items.map((r) => r.requisitionId)).toEqual([12]);
    });

    it("interviewers, finance and agencies read an empty workspace", async () => {
        for (const scope of [INTERVIEWER_7, scopeOf(["FINANCE"], 5), scopeOf(["AGENCY"], 6)]) {
            const ws = await asTenant(async () => await getManagerWorkspace({ tenantId: T, scope, now: NOW }));
            expect(ws.requisitions.total).toBe(0);
            expect(ws.shortlistProposals.total + ws.interviewsAwaitingDecision.total + ws.offersAwaitingAction.total).toBe(0);
        }
    });

    it("shortlist notes follow the internal-notes mask", async () => {
        const noNotes = { ...MANAGER_42, canSeeInternalNotes: false };
        const ws = await asTenant(async () => await getManagerWorkspace({ tenantId: T, scope: noNotes, now: NOW }));
        expect(ws.shortlistProposals.items[0]).toMatchObject({ note: null, noteRedacted: true });
    });

    it("refuses an unknown status filter", async () => {
        await expect(asTenant(async () => await getManagerWorkspace({ tenantId: T, scope: MANAGER_42, status: "BOGUS" })))
            .rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-WORKSPACE-STATUS-INVALID" });
    });
});
