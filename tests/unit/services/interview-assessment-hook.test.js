// Recruitment Phase 3b — the scheduling hook: an on-site interview whose
// requisition resolves a published test blueprint is marked
// assessment-required in the schedule's own transaction; a still-valid result
// is reused; a failure inside the retake cooldown is flagged; video and phone
// interviews, a flag that is off, and a requisition with no blueprint change
// nothing.
import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";
import { createBlueprintDb, createEventRecorder } from "./helpers/test-blueprint.fake.js";

const { db, state, reset } = createBlueprintDb();
const { events, enqueueHrDomainEvent } = createEventRecorder();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));
jest.unstable_mockModule("../../../src/services/candidatePrivacy.service.js", () => ({ assertCommunicationsAllowed: jest.fn(async () => ({ allowed: true })) }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../../src/services/applicationWorkflow.service.js", () => ({
    transitionApplicationStageInTransaction: jest.fn(async () => ({})),
    transitionApplicationStage: jest.fn(async () => ({})),
}));
jest.unstable_mockModule("../../../src/services/interview-scorecard.service.js", () => ({ upsertInterviewScorecard: jest.fn(), default: jest.fn() }));

const { scheduleInterview, scheduleInterviewInTransaction } = await import("../../../src/services/interview.service.js");
const { tenantTransaction } = await import("../../../src/lib/rlsTenant.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-20T09:00:00.000Z");
const days = (n) => new Date(NOW.getTime() + n * 86400000);
const inTenant = (fn) => mcpCtx.run({ user: { tenantId: TENANT } }, async () => await fn());
const ASSESSMENT_EVENT = "hr.recruitment.interview_assessment_required.v1";

function seed() {
    reset();
    events.length = 0;
    state.requisitions.push({ id: 21, tenantId: TENANT, title: "Finance officer", requestedById: 42, gradeLevelId: 4, jobContent: null, position: { jobCode: "FINANCE" } });
    state.applications.push({ id: 9, tenantId: TENANT, candidateId: 5, jobRequisitionId: 21, stage: "screening" });
    state.blueprints.push({ id: 300, tenantId: TENANT, blueprintKey: "fin", version: 2, status: "PUBLISHED", jobFamily: "FINANCE", retakeCooldownDays: 180, sections: [] });
    state.links.push({ id: 400, tenantId: TENANT, blueprintId: 300, scopeType: "JOB_FAMILY", scopeId: null, scopeKey: "FINANCE", isActive: true });
}

const schedule = (over = {}) =>
    inTenant(() => scheduleInterview({ applicationId: 9, interviewType: "ONSITE", scheduledAt: days(3).toISOString(), location: "Head office", tenantId: TENANT, now: NOW, ...over }));
const stored = (id) => state.interviews.find((i) => i.id === id);
const assessmentEvents = () => events.filter((e) => e.eventName === ASSESSMENT_EVENT);

beforeEach(() => {
    process.env.HR_RECRUITMENT_ONSITE_TEST = "true";
    seed();
    jest.clearAllMocks();
});
afterAll(() => {
    delete process.env.HR_RECRUITMENT_ONSITE_TEST;
});

describe("flag off and remote interviews", () => {
    it("with the flag off the interview is untouched and no blueprint is read", async () => {
        delete process.env.HR_RECRUITMENT_ONSITE_TEST;
        const interview = await schedule();
        expect(stored(interview.id)).toMatchObject({ assessmentRequired: false, assessmentStatus: "NOT_REQUIRED", assessmentBlueprintId: null });
        expect(assessmentEvents()).toHaveLength(0);
        expect(db.contextLog.some((c) => c.model.startsWith("candidateTest"))).toBe(false);
    });

    it.each([
        ["VIDEO", "Room 4"],
        ["PHONE_SCREEN", "Head office"],
        ["TECHNICAL", "https://zoom.us/j/123"],
        ["PANEL", null],
    ])("a %s interview at %j never requires the test", async (interviewType, location) => {
        const interview = await schedule({ interviewType, location });
        expect(stored(interview.id).assessmentStatus).toBe("NOT_REQUIRED");
        expect(assessmentEvents()).toHaveLength(0);
    });

    it("no published blueprint for the requisition: nothing changes", async () => {
        state.blueprints[0].status = "RETIRED";
        const interview = await schedule();
        expect(stored(interview.id).assessmentStatus).toBe("NOT_REQUIRED");
        expect(assessmentEvents()).toHaveLength(0);
    });
});

describe("on-site interviews", () => {
    it("ONSITE (or a physical room) is marked REQUIRED with the blueprint, and announced", async () => {
        const interview = await schedule();
        expect(interview).toMatchObject({ assessmentRequired: true, assessmentStatus: "REQUIRED", assessmentBlueprintId: 300 });
        expect(stored(interview.id)).toMatchObject({ assessmentRequired: true, assessmentStatus: "REQUIRED", assessmentBlueprintId: 300 });
        expect(assessmentEvents()).toEqual([expect.objectContaining({
            tenantId: TENANT,
            aggregateType: "Interview",
            aggregateId: interview.id,
            payload: {
                interviewId: String(interview.id), applicationId: "9", candidateId: "5", requisitionId: "21",
                blueprintId: "300", blueprintVersion: 2, matchedScope: "JOB_FAMILY", assessmentStatus: "REQUIRED",
                reused: false, reusedResultId: null, cooldownActive: false, cooldownResultId: null,
            },
        })]);
        // The invitation event comes first.
        expect(events.map((e) => e.eventName).indexOf(ASSESSMENT_EVENT)).toBeGreaterThan(0);
        const physical = await schedule({ interviewType: "TECHNICAL", location: "Head office, floor 3" });
        expect(stored(physical.id).assessmentStatus).toBe("REQUIRED");
        expect(db.contextLog.every((c) => c.tenantId === TENANT && !c.system)).toBe(true);
    });

    it("a valid result for the same job family is reused: PASSED, nothing to sit", async () => {
        state.results.push({ id: 77, tenantId: TENANT, candidateId: 5, jobFamily: "finance", blueprintId: 299, band: "PASSED", decision: "PROCEED", validUntil: days(30), createdAt: days(-60) });
        const interview = await schedule();
        expect(stored(interview.id)).toMatchObject({ assessmentRequired: true, assessmentStatus: "PASSED", assessmentBlueprintId: 300 });
        expect(assessmentEvents()[0].payload).toMatchObject({ reused: true, reusedResultId: "77", assessmentStatus: "PASSED" });
    });

    it("an expired result, another family's or another candidate's is not reused", async () => {
        state.results.push(
            { id: 78, tenantId: TENANT, candidateId: 5, jobFamily: "FINANCE", blueprintId: 300, band: "PASSED", validUntil: days(-1), createdAt: days(-91) },
            { id: 79, tenantId: TENANT, candidateId: 5, jobFamily: "SALES", blueprintId: 1, band: "PASSED", validUntil: days(30), createdAt: days(-10) },
            { id: 80, tenantId: TENANT, candidateId: 6, jobFamily: "FINANCE", blueprintId: 300, band: "PASSED", validUntil: days(30), createdAt: days(-10) },
        );
        const interview = await schedule();
        expect(stored(interview.id).assessmentStatus).toBe("REQUIRED");
        expect(assessmentEvents()[0].payload.reused).toBe(false);
    });

    it("a failure inside the retake cooldown still requires the test and says so", async () => {
        state.results.push({ id: 81, tenantId: TENANT, candidateId: 5, jobFamily: "FINANCE", blueprintId: 300, band: "FAILED", decision: "RELEASE", validUntil: days(10), createdAt: days(-80) });
        const interview = await schedule();
        expect(stored(interview.id).assessmentStatus).toBe("REQUIRED");
        expect(assessmentEvents()[0].payload).toMatchObject({ cooldownActive: true, cooldownResultId: "81", reused: false });
    });

    it("runs in the schedule's transaction: a failed enqueue leaves no interview behind", async () => {
        enqueueHrDomainEvent.mockImplementation(async (_tx, args) => {
            if (args?.eventName === ASSESSMENT_EVENT) throw new Error("outbox down");
            events.push(structuredClone(args));
            return { id: events.length };
        });
        await expect(schedule()).rejects.toThrow("outbox down");
        expect(state.interviews).toHaveLength(0);
        enqueueHrDomainEvent.mockImplementation(async (_tx, args) => {
            if (!args?.tenantId) return null;
            events.push(structuredClone(args));
            return { id: events.length };
        });
    });

    it("the slot-confirm path (scheduleInterviewInTransaction on the caller's tx) gets the same marking", async () => {
        const interview = await inTenant(() => tenantTransaction(db, async (tx) => await scheduleInterviewInTransaction(tx, {
            applicationId: 9, interviewType: "ONSITE", scheduledAt: days(4).toISOString(), location: "Lahore office",
            tenantId: TENANT, source: "candidate.self_schedule", slotOfferId: 12, now: NOW,
        }), { tenantId: TENANT }));
        expect(stored(interview.id)).toMatchObject({ assessmentStatus: "REQUIRED", assessmentBlueprintId: 300, slotOfferId: 12 });
    });
});
