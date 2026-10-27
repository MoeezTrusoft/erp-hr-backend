// tests/unit/services/interview-reminder.service.test.js
//
// Recruitment Phase 3a — interview reminders, feedback nudges, the recruiter
// escalation and the no-show prompt. The job runs for real over an in-memory
// prisma (interview-orchestration.fake.js) and the real outbox enqueue, so
// the windows, the one-row-per-send idempotency and the contexts each query
// ran under are asserted on what would be written.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createInterviewFakeDb, eventsNamed } from "./helpers/interview-orchestration.fake.js";

const fake = { db: null, store: null };
const prismaProxy = new Proxy({}, { get: (_t, key) => fake.db[key] });

const blockedCandidates = new Set();
const assertCommunicationsAllowed = jest.fn(async ({ candidateId }) => {
    if (blockedCandidates.has(candidateId)) {
        throw Object.assign(new Error("on DNC"), { status: 409, code: "HR-RECRUITMENT-DNC-BLOCKED" });
    }
    return { allowed: true };
});
const settingsByTenant = {};

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prismaProxy }));
jest.unstable_mockModule("../../../src/services/candidate-privacy.service.js", () => ({ assertCommunicationsAllowed }));
jest.unstable_mockModule("../../../src/services/recruitment-settings.service.js", async () => {
    const DEFAULTS = Object.freeze({ feedbackNudgeHours: 2, feedbackEscalationHours: 24 });
    return {
        RECRUITMENT_SETTINGS_DEFAULTS: DEFAULTS,
        getRecruitmentSettings: jest.fn(async ({ tenantId }) => ({ ...DEFAULTS, ...(settingsByTenant[tenantId] ?? {}) })),
    };
});

const reminders = await import("../../../src/services/interview-reminder.service.js");
const {
    planInterviewReminders,
    runInterviewReminderJob,
    resetInterviewRemindersForReschedule,
    INTERVIEW_REMINDER_EVENT,
    INTERVIEW_NO_SHOW_PROMPT_EVENT,
} = reminders;
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

const T = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-20T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const at = (offsetMs) => new Date(NOW.getTime() + offsetMs);

let seq = 1;
function interview(over = {}) {
    const id = over.id ?? seq++;
    return {
        id,
        tenantId: T,
        applicationId: 500 + id,
        interviewType: "TECHNICAL",
        status: "SCHEDULED",
        decision: null,
        scheduledAt: at(20 * HOUR),
        durationMinutes: 60,
        remindersPausedAt: null,
        decisionPromptedAt: null,
        interviewers: [
            { employeeId: 7, status: "accepted" },
            { employeeId: 8, status: "invited" },
        ],
        scorecards: [],
        application: {
            id: 500 + id,
            candidateId: 300,
            jobRequisitionId: 12,
            jobRequisition: { id: 12, title: "Engineer", recruiterId: 90, requestedById: 42 },
        },
        ...over,
    };
}

const sentRows = () => fake.store.reminders.map((r) => `${r.interviewId}:${r.kind}:${r.recipientKey}`).sort();
const reminderEvents = () => eventsNamed(fake.store, INTERVIEW_REMINDER_EVENT);

beforeEach(() => {
    Object.assign(fake, createInterviewFakeDb());
    blockedCandidates.clear();
    for (const key of Object.keys(settingsByTenant)) delete settingsByTenant[key];
    assertCommunicationsAllowed.mockClear();
    process.env.HR_RECRUITMENT_INTERVIEW_REMINDERS = "true";
    seq = 1;
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_INTERVIEW_REMINDERS;
});

describe("planInterviewReminders (pure windows)", () => {
    it("24 h reminder between 24 h and 1 h before the start, for the panel and the candidate", () => {
        const sends = planInterviewReminders(interview({ scheduledAt: at(20 * HOUR) }), { now: NOW });
        expect(sends.map((s) => `${s.kind}:${s.recipientKey}:${s.recipientType}`)).toEqual([
            "REMINDER_24H:emp:7:INTERVIEWER",
            "REMINDER_24H:emp:8:INTERVIEWER",
            "REMINDER_24H:candidate:CANDIDATE",
        ]);
    });

    it("a reminder run 30 minutes before the start sends only the 1 h reminder (the missed 24 h one stays missed)", () => {
        const kinds = planInterviewReminders(interview({ scheduledAt: at(30 * 60 * 1000) }), { now: NOW }).map((s) => s.kind);
        expect(new Set(kinds)).toEqual(new Set(["REMINDER_1H"]));
    });

    it("nothing more than 24 h ahead, nothing once the interview has started", () => {
        expect(planInterviewReminders(interview({ scheduledAt: at(25 * HOUR) }), { now: NOW })).toEqual([]);
        expect(planInterviewReminders(interview({ scheduledAt: at(-10 * 60 * 1000) }), { now: NOW })).toEqual([]);
    });

    it("the boundaries: exactly 24 h is the 24 h reminder, exactly 1 h the 1 h reminder", () => {
        expect(planInterviewReminders(interview({ scheduledAt: at(24 * HOUR) }), { now: NOW })[0].kind).toBe("REMINDER_24H");
        expect(planInterviewReminders(interview({ scheduledAt: at(HOUR) }), { now: NOW })[0].kind).toBe("REMINDER_1H");
    });

    it("a declined panelist is not reminded", () => {
        const row = interview({ interviewers: [{ employeeId: 7, status: "declined" }, { employeeId: 8, status: "accepted" }] });
        expect(planInterviewReminders(row, { now: NOW }).map((s) => s.recipientKey)).toEqual(["emp:8", "candidate"]);
    });

    it("a paused interview gets nothing", () => {
        expect(planInterviewReminders(interview({ remindersPausedAt: at(-HOUR) }), { now: NOW })).toEqual([]);
        const ended = interview({ scheduledAt: at(-30 * HOUR), remindersPausedAt: at(-HOUR) });
        expect(planInterviewReminders(ended, { now: NOW })).toEqual([]);
    });

    it("feedback nudge per panelist without a submitted scorecard, from end + nudgeHours", () => {
        const row = interview({
            scheduledAt: at(-3 * HOUR), // ended 2 h ago
            scorecards: [
                { reviewerId: 7, submittedAt: at(-HOUR) },
                { reviewerId: 8, submittedAt: null }, // a draft is not evidence
            ],
        });
        const sends = planInterviewReminders(row, { now: NOW });
        expect(sends).toEqual([
            { kind: "FEEDBACK_NUDGE", recipientKey: "emp:8", recipientType: "INTERVIEWER", recipientEmployeeId: 8 },
        ]);
        expect(planInterviewReminders(row, { now: NOW, settings: { feedbackNudgeHours: 4, feedbackEscalationHours: 24 } })).toEqual([]);
    });

    it("escalation to the recruiter from end + escalationHours supersedes the nudge, and closes after a week", () => {
        const row = interview({ scheduledAt: at(-26 * HOUR) }); // ended 25 h ago
        expect(planInterviewReminders(row, { now: NOW })).toEqual([
            { kind: "FEEDBACK_ESCALATION", recipientKey: "recruiter", recipientType: "RECRUITER", recipientEmployeeId: 90 },
        ]);
        const old = interview({ scheduledAt: at(-(1 + 24 + 7 * 24 + 1) * HOUR) });
        expect(planInterviewReminders(old, { now: NOW })).toEqual([]);
    });

    it("the escalation goes to the requisition requester when it names no recruiter", () => {
        const row = interview({ scheduledAt: at(-26 * HOUR) });
        row.application.jobRequisition.recruiterId = null;
        expect(planInterviewReminders(row, { now: NOW })[0].recipientEmployeeId).toBe(42);
    });

    it("no nudge or escalation once every panelist submitted, or once decided", () => {
        const done = interview({
            scheduledAt: at(-26 * HOUR),
            scorecards: [{ reviewerId: 7, submittedAt: at(-20 * HOUR) }, { reviewerId: 8, submittedAt: at(-20 * HOUR) }],
        });
        expect(planInterviewReminders(done, { now: NOW })).toEqual([]);
        expect(planInterviewReminders(interview({ scheduledAt: at(-26 * HOUR), status: "COMPLETED", decision: "HOLD" }), { now: NOW })).toEqual([]);
        expect(planInterviewReminders(interview({ scheduledAt: at(-26 * HOUR), status: "NO_SHOW" }), { now: NOW })).toEqual([]);
    });
});

describe("runInterviewReminderJob", () => {
    it("is off unless the interviewReminders flag is on", async () => {
        delete process.env.HR_RECRUITMENT_INTERVIEW_REMINDERS;
        fake.store.interviews.push(interview());
        expect(await runInterviewReminderJob({ now: NOW })).toEqual({ skipped: "FLAG_OFF" });
        expect(fake.store.reminders).toEqual([]);
    });

    it("records one row and one ids-only event per send, in the tenant's context", async () => {
        fake.store.interviews.push(interview({ id: 1 }));
        const summary = await runInterviewReminderJob({ now: NOW });
        expect(summary).toMatchObject({ sent: 3, duplicate: 0, blocked: 0, failed: 0 });
        expect(sentRows()).toEqual(["1:REMINDER_24H:candidate", "1:REMINDER_24H:emp:7", "1:REMINDER_24H:emp:8"]);
        expect(reminderEvents()).toEqual(expect.arrayContaining([
            { interviewId: "1", applicationId: "501", kind: "REMINDER_24H", recipientType: "INTERVIEWER", recipientEmployeeId: "7" },
            { interviewId: "1", applicationId: "501", kind: "REMINDER_24H", recipientType: "CANDIDATE" },
        ]));
        expect(fake.store.outbox.every((row) => row.tenantId === T && row.aggregateType === "Interview")).toBe(true);
        // The scan ran under SYSTEM, every write under the interview's tenant.
        const writes = fake.db.contextLog.filter((q) => q.model === "interviewReminder" && q.op === "create");
        expect(writes.every((q) => q.tenantId === T && !q.system)).toBe(true);
        expect(fake.db.contextLog.find((q) => q.model === "interview" && q.op === "findMany").system).toBe(true);
    });

    it("re-running sends nothing twice", async () => {
        fake.store.interviews.push(interview({ id: 1 }));
        await runInterviewReminderJob({ now: NOW });
        const second = await runInterviewReminderJob({ now: new Date(NOW.getTime() + 15 * 60 * 1000) });
        expect(second).toMatchObject({ sent: 0, duplicate: 3 });
        expect(fake.store.reminders).toHaveLength(3);
        expect(reminderEvents()).toHaveLength(3);
    });

    it("two overlapping runs send each reminder once (the unique row decides)", async () => {
        fake.store.interviews.push(interview({ id: 1 }), interview({ id: 2, scheduledAt: at(40 * 60 * 1000) }));
        const [a, b] = await Promise.all([runInterviewReminderJob({ now: NOW }), runInterviewReminderJob({ now: NOW })]);
        expect(a.sent + b.sent).toBe(6);
        expect(a.duplicate + b.duplicate).toBe(6);
        expect(fake.store.reminders).toHaveLength(6);
        expect(reminderEvents()).toHaveLength(6);
    });

    it("the 1 h reminder follows the 24 h one as the start approaches", async () => {
        fake.store.interviews.push(interview({ id: 1, scheduledAt: at(2 * HOUR) }));
        await runInterviewReminderJob({ now: NOW });
        await runInterviewReminderJob({ now: at(HOUR + 30 * 60 * 1000) });
        expect(sentRows()).toEqual([
            "1:REMINDER_1H:candidate", "1:REMINDER_1H:emp:7", "1:REMINDER_1H:emp:8",
            "1:REMINDER_24H:candidate", "1:REMINDER_24H:emp:7", "1:REMINDER_24H:emp:8",
        ]);
    });

    it("skips a candidate on the DNC register and records nothing, so a lifted block is reminded later", async () => {
        fake.store.interviews.push(interview({ id: 1 }));
        blockedCandidates.add(300);
        const summary = await runInterviewReminderJob({ now: NOW });
        expect(summary).toMatchObject({ sent: 2, blocked: 1 });
        expect(sentRows()).toEqual(["1:REMINDER_24H:emp:7", "1:REMINDER_24H:emp:8"]);
        expect(assertCommunicationsAllowed).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: T, candidateId: 300, purpose: "PROCESSING" }),
            expect.objectContaining({ db: expect.anything() }),
        );
        blockedCandidates.clear();
        await runInterviewReminderJob({ now: at(15 * 60 * 1000) });
        expect(sentRows()).toContain("1:REMINDER_24H:candidate");
    });

    it("a paused interview is not reminded", async () => {
        fake.store.interviews.push(interview({ id: 1, remindersPausedAt: at(-HOUR) }));
        const summary = await runInterviewReminderJob({ now: NOW });
        expect(summary.sent).toBe(0);
        expect(fake.store.reminders).toEqual([]);
    });

    it("nudges the missing panelist and later escalates to the recruiter, with tenant settings", async () => {
        settingsByTenant[T] = { feedbackNudgeHours: 1, feedbackEscalationHours: 3 };
        fake.store.interviews.push(interview({
            id: 1,
            scheduledAt: at(-3 * HOUR), // ended 2 h ago: past the 1 h nudge, before the 3 h escalation
            scorecards: [{ reviewerId: 7, submittedAt: at(-HOUR) }],
        }));
        await runInterviewReminderJob({ now: NOW });
        expect(sentRows()).toEqual(["1:FEEDBACK_NUDGE:emp:8"]);
        await runInterviewReminderJob({ now: at(2 * HOUR) });
        expect(sentRows()).toEqual(["1:FEEDBACK_ESCALATION:recruiter", "1:FEEDBACK_NUDGE:emp:8"]);
        expect(reminderEvents().find((e) => e.kind === "FEEDBACK_ESCALATION")).toEqual({
            interviewId: "1", applicationId: "501", kind: "FEEDBACK_ESCALATION", recipientType: "RECRUITER", recipientEmployeeId: "90",
        });
        // An escalated interview drops out of the scan.
        const third = await runInterviewReminderJob({ now: at(3 * HOUR) });
        expect(third.scanned).toBe(0);
    });

    it("isolates tenants and a failing interview", async () => {
        fake.store.interviews.push(interview({ id: 1 }), interview({ id: 2, tenantId: T2 }));
        const realCreate = fake.db.interviewReminder.create.getMockImplementation();
        fake.db.interviewReminder.create.mockImplementation((args) => {
            if (args.data.interviewId === 1) return Promise.reject(new Error("boom"));
            return realCreate(args);
        });
        const summary = await runInterviewReminderJob({ now: NOW });
        expect(summary.failed).toBe(1);
        expect(fake.store.reminders.filter((r) => r.interviewId === 2)).toHaveLength(3);
        expect(fake.store.reminders.filter((r) => r.interviewId === 2).every((r) => r.tenantId === T2)).toBe(true);
    });
});

describe("no-show prompt", () => {
    it("prompts the recruiter once per NO_SHOW interview", async () => {
        fake.store.interviews.push(interview({ id: 1, status: "NO_SHOW", scheduledAt: at(-2 * HOUR), noShowAt: at(-HOUR) }));
        const first = await runInterviewReminderJob({ now: NOW });
        expect(first.noShow).toMatchObject({ scanned: 1, prompted: 1 });
        expect(sentRows()).toEqual(["1:NO_SHOW_PROMPT:recruiter"]);
        expect(eventsNamed(fake.store, INTERVIEW_NO_SHOW_PROMPT_EVENT)).toEqual([
            { interviewId: "1", applicationId: "501", requisitionId: "12", recruiterEmployeeId: "90" },
        ]);
        const second = await runInterviewReminderJob({ now: at(15 * 60 * 1000) });
        expect(second.noShow).toMatchObject({ scanned: 0, prompted: 0 });
        expect(eventsNamed(fake.store, INTERVIEW_NO_SHOW_PROMPT_EVENT)).toHaveLength(1);
    });

    it("is recent by when the no-show was marked, and off with the flag", async () => {
        fake.store.interviews.push(
            interview({ id: 1, status: "NO_SHOW", scheduledAt: at(-20 * 24 * HOUR), noShowAt: at(-HOUR) }),
            interview({ id: 2, status: "NO_SHOW", scheduledAt: at(-21 * 24 * HOUR), noShowAt: at(-20 * 24 * HOUR) }),
        );
        const { noShow } = await runInterviewReminderJob({ now: NOW });
        expect(noShow).toMatchObject({ scanned: 1, prompted: 1 });
        expect(sentRows()).toEqual(["1:NO_SHOW_PROMPT:recruiter"]);
        delete process.env.HR_RECRUITMENT_INTERVIEW_REMINDERS;
        expect(await reminders.runInterviewNoShowPromptJob({ now: NOW })).toEqual({ skipped: "FLAG_OFF" });
    });
});

describe("resetInterviewRemindersForReschedule", () => {
    it("clears the time-bound rows of the old slot and keeps the prompts", async () => {
        fake.store.interviews.push(interview({ id: 1 }));
        fake.store.reminders.push(
            { id: 1, tenantId: T, interviewId: 1, kind: "REMINDER_24H", recipientKey: "emp:7" },
            { id: 2, tenantId: T, interviewId: 1, kind: "FEEDBACK_NUDGE", recipientKey: "emp:8" },
            { id: 3, tenantId: T, interviewId: 1, kind: "DECISION_PROMPT", recipientKey: "emp:42" },
        );
        const cleared = await mcpCtx.run({ user: { tenantId: T } }, async () =>
            await resetInterviewRemindersForReschedule(fake.db, { tenantId: T, interviewId: 1 }),
        );
        expect(cleared).toBe(2);
        expect(sentRows()).toEqual(["1:DECISION_PROMPT:emp:42"]);
    });
});
