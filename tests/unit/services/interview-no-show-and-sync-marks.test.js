// Recruitment Phase 3a — the schedule paths' share of the calendar sync and
// reminders: every create, move, cancel and no-show queues the calendar in
// the same write; a reschedule request pauses reminders and its confirm (or a
// cancel) ends the pause; a moved slot drops its time-bound reminder rows
// (stream B's hook); a NEXT_ROUND decision on hr_interview_update runs the
// auto-advance (stream B's hook); and the no-show rules.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { createSchedulingDb, createEventRecorder } from "./helpers/interview-scheduling.fake.js";

const { db, state } = createSchedulingDb();
const { events, enqueueHrDomainEvent } = createEventRecorder();
const assertCommunicationsAllowed = jest.fn(async () => ({ allowed: true }));

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));
jest.unstable_mockModule("../../../src/services/candidate-privacy.service.js", () => ({ assertCommunicationsAllowed }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
const transitionApplicationStage = jest.fn(async () => ({}));
jest.unstable_mockModule("../../../src/services/application-workflow.service.js", () => ({
    transitionApplicationStageInTransaction: jest.fn(async () => ({})),
    transitionApplicationStage,
}));
jest.unstable_mockModule("../../../src/services/interview-scorecard.service.js", () => ({ upsertInterviewScorecard: jest.fn(), default: jest.fn() }));

const schedule = await import("../../../src/services/interview-schedule.service.js");
const interviews = await import("../../../src/services/interview.service.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-22T08:00:00.000Z");
const ORG = { level: "ORG", unrestricted: true, employeeId: 1 };
const asTenant = (fn) => mcpCtx.run({ user: { tenantId: TENANT } }, async () => await fn());
const row = (id = 40) => state.interviews.find((i) => i.id === id);

function seed() {
    for (const key of Object.keys(state)) state[key] = [];
    state.employees.push({ id: 3, tenant_id: TENANT, first_name: "Sara" }, { id: 4, tenant_id: TENANT, first_name: "Ali" });
    state.requisitions.push({ id: 21, tenantId: TENANT, title: "Backend Engineer", requestedById: 7, approvedById: null });
    state.candidates.push({ id: 5, tenantId: TENANT, firstName: "Ayesha", email: "a@example.com" });
    state.applications.push({ id: 9, tenantId: TENANT, candidateId: 5, jobRequisitionId: 21, stage: "interview" });
}

function addInterview(over = {}) {
    const r = {
        id: 40,
        tenantId: TENANT,
        applicationId: 9,
        interviewType: "TECHNICAL",
        scheduledAt: new Date("2026-10-22T05:00:00Z"),
        durationMinutes: 60,
        location: "Room 1",
        status: "SCHEDULED",
        decision: null,
        notes: null,
        calendarProvider: null,
        calendarEventId: null,
        calendarSyncStatus: "SYNCED",
        calendarSyncAction: "CREATE",
        calendarSyncAttempts: 0,
        calendarNextAttemptAt: null,
        calendarLastError: null,
        calendarClaimedBy: null,
        calendarClaimExpiresAt: null,
        remindersPausedAt: null,
        noShowAt: null,
        created_at: new Date("2026-10-15T00:00:00Z"),
        ...over,
    };
    state.interviews.push(r);
    state.interviewers.push({ interviewId: r.id, employeeId: 3, tenantId: TENANT }, { interviewId: r.id, employeeId: 4, tenantId: TENANT });
    return r;
}

const expectMarked = (r, action) => {
    expect(r).toMatchObject({ calendarSyncStatus: "PENDING", calendarSyncAction: action, calendarSyncAttempts: 0, calendarLastError: null });
    expect(r.calendarNextAttemptAt).toBeInstanceOf(Object);
};

beforeEach(() => {
    seed();
    events.length = 0;
    jest.clearAllMocks();
});

describe("markNoShow", () => {
    const mark = (over = {}) => asTenant(() => schedule.markNoShow({ interviewId: 40, tenantId: TENANT, actorId: 12, scope: ORG, now: NOW, ...over }));

    it("records NO_SHOW, its lifecycle row, the calendar cancel and the event", async () => {
        addInterview({ calendarEventId: "evt-1", calendarProvider: "GOOGLE_WORKSPACE" });
        const res = await mark({ notes: "  Called twice, no answer " });
        expect(res).toEqual({ interviewId: 40, status: "NO_SHOW", noShowAt: NOW });
        expect(row()).toMatchObject({ status: "NO_SHOW", noShowAt: NOW });
        expectMarked(row(), "CANCEL");
        expect(row().calendarNextAttemptAt).toEqual(NOW);
        expect(state.lifecycle).toEqual([
            expect.objectContaining({ interviewId: 40, tenantId: TENANT, eventType: "NO_SHOW", reasonCode: "CANDIDATE_NO_SHOW", notes: "Called twice, no answer", actorId: 12 }),
        ]);
        expect(state.lifecycle[0].previousScheduledAt).toEqual(new Date("2026-10-22T05:00:00Z"));
        expect(events).toEqual([
            expect.objectContaining({
                eventName: "hr.recruitment.interview_no_show.v1",
                tenantId: TENANT,
                aggregateType: "Interview",
                actorId: 12,
                payload: {
                    interviewId: "40",
                    applicationId: "9",
                    candidateId: "5",
                    requisitionId: "21",
                    recruiterId: "7",
                    scheduledAt: "2026-10-22T05:00:00.000Z",
                    noShowAt: NOW.toISOString(),
                    interviewerIds: ["3", "4"],
                },
            }),
        ]);
    });

    it("the vocabulary names NO_SHOW", () => {
        expect(schedule.INTERVIEW_LIFECYCLE_EVENTS).toEqual(["CANCELLED", "RESCHEDULED", "RESCHEDULE_REQUESTED", "NO_SHOW"]);
        expect(schedule.NO_SHOW_REASON_CODE).toBe("CANDIDATE_NO_SHOW");
    });

    it("an interview that has not started cannot be missed", async () => {
        addInterview({ scheduledAt: new Date("2026-10-22T09:00:00Z") });
        await expect(mark()).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-SCHEDULE-NOT-STARTED" });
        expect(row().status).toBe("SCHEDULED");
        expect(state.lifecycle).toHaveLength(0);
    });

    it.each(["COMPLETED", "CANCELLED", "NO_SHOW"])("a %s interview is refused", async (status) => {
        addInterview({ status });
        await expect(mark()).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-SCHEDULE-NOT-SCHEDULED" });
        expect(events).toHaveLength(0);
    });

    it("two marks at once record one fact", async () => {
        addInterview();
        const results = await Promise.allSettled([mark(), mark()]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(results.find((r) => r.status === "rejected").reason).toMatchObject({ status: 409 });
        expect(state.lifecycle).toHaveLength(1);
        expect(events).toHaveLength(1);
    });

    it("follows the interview scope: a panelist may, a stranger or another manager may not", async () => {
        addInterview();
        await expect(mark({ scope: { level: "ASSIGNED", unrestricted: false, employeeId: 99 } })).rejects.toMatchObject({ status: 404 });
        await expect(mark({ scope: { level: "MANAGED", unrestricted: false, employeeId: 8 } })).rejects.toMatchObject({ status: 404 });
        await expect(mark({ scope: { level: "FINANCE", unrestricted: false, employeeId: 2 } })).rejects.toMatchObject({ status: 404 });
        await expect(mark({ scope: { level: "ASSIGNED", unrestricted: false, employeeId: 3 } })).resolves.toMatchObject({ status: "NO_SHOW" });
    });

    it("refuses an over-long note before reading anything", async () => {
        addInterview();
        await expect(mark({ notes: "x".repeat(1001) })).rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-SCHEDULE-NOTES-TOO-LONG" });
    });
});

describe("calendar marks and the reminder pause on the lifecycle paths", () => {
    it("cancel queues a CANCEL and ends any pause", async () => {
        addInterview({ calendarEventId: "evt-1", remindersPausedAt: new Date("2026-10-21T00:00:00Z") });
        await asTenant(() => schedule.cancelInterview({ interviewId: 40, reasonCode: "BUSINESS_REQUEST", tenantId: TENANT, actorId: 12 }));
        expect(row()).toMatchObject({ status: "CANCELLED", remindersPausedAt: null });
        expectMarked(row(), "CANCEL");
    });

    it("a reschedule request pauses reminders without touching the calendar", async () => {
        addInterview();
        await asTenant(() => schedule.requestReschedule({ interviewId: 40, reasonCode: "CANDIDATE_REQUEST", tenantId: TENANT, actorId: 5 }));
        expect(row().remindersPausedAt).toBeInstanceOf(Object);
        expect(row().calendarSyncStatus).toBe("SYNCED");
    });

    it("the confirm moves the time, queues an UPDATE (event exists) and ends the pause", async () => {
        addInterview({ calendarEventId: "evt-1", remindersPausedAt: new Date("2026-10-21T00:00:00Z") });
        await asTenant(() => schedule.confirmReschedule({ interviewId: 40, scheduledAt: "2026-10-27T05:00:00Z", reasonCode: "CANDIDATE_REQUEST", tenantId: TENANT, actorId: 12 }));
        expect(row().scheduledAt).toEqual(new Date("2026-10-27T05:00:00Z"));
        expect(row().remindersPausedAt).toBeNull();
        expectMarked(row(), "UPDATE");
    });

    it("the confirm queues a CREATE when no event was ever written", async () => {
        addInterview({ calendarSyncStatus: "PENDING" });
        await asTenant(() => schedule.confirmReschedule({ interviewId: 40, scheduledAt: "2026-10-27T05:00:00Z", reasonCode: "CANDIDATE_REQUEST", tenantId: TENANT }));
        expectMarked(row(), "CREATE");
    });

    it("a mark leaves a worker's live claim alone (the worker sees the new revision)", async () => {
        addInterview({ calendarEventId: "evt-1", calendarClaimedBy: "worker-a", calendarClaimExpiresAt: new Date("2026-10-22T08:05:00Z"), calendarNextAttemptAt: new Date("2026-10-22T07:59:00Z") });
        await asTenant(() => schedule.confirmReschedule({ interviewId: 40, scheduledAt: "2026-10-27T05:00:00Z", reasonCode: "CANDIDATE_REQUEST", tenantId: TENANT }));
        expect(row().calendarClaimedBy).toBe("worker-a");
        expect(row().calendarNextAttemptAt).not.toEqual(new Date("2026-10-22T07:59:00Z"));
    });
});

describe("interview.service marks", () => {
    it("scheduleInterview queues a CREATE in the create itself", async () => {
        const created = await asTenant(() => interviews.scheduleInterview({ applicationId: 9, interviewType: "TECHNICAL", scheduledAt: "2026-10-28T05:00:00Z", interviewerIds: [3, 4], tenantId: TENANT, now: NOW }));
        const r = row(created.id);
        expect(r).toMatchObject({ calendarSyncStatus: "PENDING", calendarSyncAction: "CREATE", calendarSyncAttempts: 0, slotOfferId: null });
        expect(r.calendarNextAttemptAt).toEqual(NOW);
    });

    it("updateInterview: a new place queues an UPDATE; the event still names only the edited columns", async () => {
        addInterview({ calendarEventId: "evt-1" });
        await asTenant(() => interviews.updateInterview(40, { location: "Room 4" }, TENANT));
        expectMarked(row(), "UPDATE");
        const updated = events.find((e) => e.eventName === "hr.recruitment.interview_updated.v1");
        expect(updated.payload.changedFields).toEqual(["location"]);
    });

    it("updateInterview: notes alone do not touch the calendar", async () => {
        addInterview();
        await asTenant(() => interviews.updateInterview(40, { notes: "bring laptop" }, TENANT));
        expect(row().calendarSyncStatus).toBe("SYNCED");
    });

    it("updateInterview: a cancel queues a CANCEL; a new time ends the pause", async () => {
        addInterview({ remindersPausedAt: new Date("2026-10-21T00:00:00Z") });
        await asTenant(() => interviews.updateInterview(40, { scheduledAt: "2026-10-29T05:00:00Z" }, TENANT));
        expectMarked(row(), "CREATE");
        expect(row().remindersPausedAt).toBeNull();
        await asTenant(() => interviews.updateInterview(40, { status: "CANCELLED" }, TENANT));
        expectMarked(row(), "CANCEL");
    });

    it("Phase 3b: updateInterview refuses a decision until the on-site assessment lets it proceed", async () => {
        addInterview({ assessmentRequired: true, assessmentStatus: "FAILED" });
        await expect(
            asTenant(() => interviews.updateInterview(40, { decision: "HOLD" }, TENANT)),
        ).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-ASSESSMENT-REQUIRED" });
        expect(row().decision).toBeNull();

        row().assessmentStatus = "WAIVED";
        await asTenant(() => interviews.updateInterview(40, { decision: "HOLD" }, TENANT));
        expect(row().decision).toBe("HOLD");
    });
});

describe("stream B hooks", () => {
    const reminders = () => state.reminders.map((r) => r.kind).sort();
    const seedReminders = () => {
        state.reminders.push(
            { id: 1, tenantId: TENANT, interviewId: 40, kind: "REMINDER_24H", recipientKey: "candidate" },
            { id: 2, tenantId: TENANT, interviewId: 40, kind: "REMINDER_1H", recipientKey: "emp:3" },
            { id: 3, tenantId: TENANT, interviewId: 40, kind: "DECISION_PROMPT", recipientKey: "recruiter" },
            { id: 4, tenantId: TENANT, interviewId: 41, kind: "REMINDER_24H", recipientKey: "candidate" },
        );
    };

    it("confirmReschedule drops the moved slot's time-bound reminders in the same transaction", async () => {
        addInterview();
        seedReminders();
        await asTenant(() => schedule.confirmReschedule({ interviewId: 40, scheduledAt: "2026-10-27T05:00:00Z", reasonCode: "CANDIDATE_REQUEST", tenantId: TENANT }));
        expect(reminders()).toEqual(["DECISION_PROMPT", "REMINDER_24H"]);
        expect(state.reminders.find((r) => r.kind === "REMINDER_24H").interviewId).toBe(41);
    });

    it("a refused confirm leaves the reminders alone", async () => {
        addInterview();
        seedReminders();
        state.leave.push({ id: 9, tenantId: TENANT, employeeId: 3, status: "APPROVED", startDate: new Date("2026-10-27T00:00:00Z"), endDate: new Date("2026-10-27T00:00:00Z") });
        await expect(asTenant(() => schedule.confirmReschedule({ interviewId: 40, scheduledAt: "2026-10-27T05:00:00Z", reasonCode: "CANDIDATE_REQUEST", tenantId: TENANT }))).rejects.toMatchObject({ status: 409 });
        expect(state.reminders).toHaveLength(4);
    });

    it("updateInterview resets reminders only when the slot moves", async () => {
        addInterview();
        seedReminders();
        await asTenant(() => interviews.updateInterview(40, { location: "Room 9" }, TENANT));
        expect(state.reminders).toHaveLength(4);
        await asTenant(() => interviews.updateInterview(40, { scheduledAt: "2026-10-29T05:00:00Z" }, TENANT));
        expect(reminders()).toEqual(["DECISION_PROMPT", "REMINDER_24H"]);
    });

    it("updateInterview runs the auto-advance for a changed NEXT_ROUND decision when decisionPrompts is on", async () => {
        process.env.HR_RECRUITMENT_DECISION_PROMPTS = "true";
        try {
            addInterview({ interviewType: "FINAL", status: "COMPLETED" });
            await asTenant(() => interviews.updateInterview(40, { decision: "NEXT_ROUND", overrideReason: "panel agreed verbally" }, TENANT, { actorId: 12 }));
            expect(transitionApplicationStage).toHaveBeenCalledTimes(1);
            expect(transitionApplicationStage).toHaveBeenCalledWith(expect.objectContaining({
                id: 9, tenantId: TENANT, targetStage: "offer", source: "system.decision_auto_advance", db,
            }));

            // The same decision again is not a change: nothing more moves.
            await asTenant(() => interviews.updateInterview(40, { decision: "NEXT_ROUND", overrideReason: "again" }, TENANT));
            expect(transitionApplicationStage).toHaveBeenCalledTimes(1);

            // A REJECTED decision never auto-rejects.
            await asTenant(() => interviews.updateInterview(40, { decision: "REJECTED", overrideReason: "changed mind" }, TENANT));
            expect(transitionApplicationStage).toHaveBeenCalledTimes(1);
        } finally {
            delete process.env.HR_RECRUITMENT_DECISION_PROMPTS;
        }
    });

    it("the auto-advance is a no-op while decisionPrompts is off", async () => {
        addInterview({ interviewType: "FINAL", status: "COMPLETED" });
        await asTenant(() => interviews.updateInterview(40, { decision: "NEXT_ROUND", overrideReason: "verbal" }, TENANT));
        expect(transitionApplicationStage).not.toHaveBeenCalled();
        expect(row().decision).toBe("NEXT_ROUND");
    });
});
