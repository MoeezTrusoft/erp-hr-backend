// tests/unit/services/interview-decision-prompt.service.test.js
//
// Recruitment Phase 3a — the hiring manager's decision prompt (job and the
// scorecard submit hook, idempotent with each other) and the auto-advance on a
// NEXT_ROUND decision. Runs the real decision-prompt, interviewMgmt and
// scorecard writer over the in-memory prisma; the application workflow is the
// collaborator whose calls are asserted.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createInterviewFakeDb, eventsNamed } from "./helpers/interview-orchestration.fake.js";

const fake = { db: null, store: null };
const prismaProxy = new Proxy({}, { get: (_t, key) => fake.db[key] });

const transitionApplicationStage = jest.fn(async () => ({ success: true, changed: true }));

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prismaProxy }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../../src/services/scorecardTemplate.service.js", () => ({
    resolveForInterview: jest.fn(async () => null),
    validateSubmission: jest.fn(() => ({ overall: null })),
}));
jest.unstable_mockModule("../../../src/services/applicationWorkflow.service.js", () => ({ transitionApplicationStage }));

const prompts = await import("../../../src/services/interview-decision-prompt.service.js");
const {
    runDecisionPromptJob,
    promptInterviewDecision,
    applyDecisionAutoAdvance,
    isReadyForDecisionPrompt,
    DECISION_PROMPT_EVENT,
    APPLICATION_NEXT_ROUND_EVENT,
    AUTO_ADVANCE_SOURCE,
} = prompts;
const { setInterviewOutcome } = await import("../../../src/services/interviewMgmt.service.js");
const { upsertInterviewScorecard } = await import("../../../src/services/interview-scorecard.service.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

const T = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-20T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const at = (offsetMs) => new Date(NOW.getTime() + offsetMs);
const asTenant = (fn) => mcpCtx.run({ user: { tenantId: T, employeeId: 42 } }, fn);

const card = (reviewerId, recommendation, submitted = true) => ({
    id: reviewerId * 100,
    tenantId: T,
    reviewerId,
    scores: { technicalSkills: 4 },
    overallScore: 4,
    recommendation,
    notes: "internal",
    submittedAt: submitted ? at(-HOUR) : null,
});

function interview(over = {}) {
    const id = over.id ?? 1;
    return {
        id,
        tenantId: T,
        applicationId: 50,
        interviewType: "TECHNICAL",
        status: "COMPLETED",
        decision: null,
        notes: null,
        scheduledAt: at(-3 * HOUR),
        durationMinutes: 60,
        location: "Room 1",
        decisionPromptedAt: null,
        remindersPausedAt: null,
        interviewers: [
            { employeeId: 7, status: "accepted", employee: { id: 7, employee_name: "Seven" } },
            { employeeId: 8, status: "accepted", employee: { id: 8, employee_name: "Eight" } },
        ],
        scorecards: [card(7, "HIRE"), card(8, "STRONG_HIRE")],
        packetItems: [],
        application: {
            id: 50,
            candidateId: 300,
            jobRequisitionId: 12,
            stage: "interview",
            candidate: { id: 300, firstName: "Ada", lastName: "L" },
            jobRequisition: { id: 12, title: "Engineer", recruiterId: 90, requestedById: 42 },
        },
        ...over,
    };
}

const promptEvents = () => eventsNamed(fake.store, DECISION_PROMPT_EVENT);
const nextRoundEvents = () => eventsNamed(fake.store, APPLICATION_NEXT_ROUND_EVENT);

beforeEach(() => {
    Object.assign(fake, createInterviewFakeDb());
    transitionApplicationStage.mockReset();
    transitionApplicationStage.mockResolvedValue({ success: true, changed: true });
    process.env.HR_RECRUITMENT_DECISION_PROMPTS = "true";
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_DECISION_PROMPTS;
});

describe("isReadyForDecisionPrompt", () => {
    it("needs the slot over, no decision, no earlier prompt and every active panelist submitted", () => {
        expect(isReadyForDecisionPrompt(interview(), NOW)).toBe(true);
        expect(isReadyForDecisionPrompt(interview({ status: "SCHEDULED" }), NOW)).toBe(true); // ended 2 h ago
        expect(isReadyForDecisionPrompt(interview({ status: "SCHEDULED", scheduledAt: at(-30 * 60 * 1000) }), NOW)).toBe(false);
        expect(isReadyForDecisionPrompt(interview({ decision: "HOLD" }), NOW)).toBe(false);
        expect(isReadyForDecisionPrompt(interview({ decisionPromptedAt: at(-HOUR) }), NOW)).toBe(false);
        expect(isReadyForDecisionPrompt(interview({ scorecards: [card(7, "HIRE"), card(8, "HIRE", false)] }), NOW)).toBe(false);
        expect(isReadyForDecisionPrompt(interview({ interviewers: [] }), NOW)).toBe(false);
        expect(isReadyForDecisionPrompt(interview({ status: "CANCELLED" }), NOW)).toBe(false);
    });

    it("a declined panelist is not waited for", () => {
        const row = interview({
            interviewers: [{ employeeId: 7, status: "accepted" }, { employeeId: 9, status: "declined" }],
            scorecards: [card(7, "HIRE")],
        });
        expect(isReadyForDecisionPrompt(row, NOW)).toBe(true);
    });
});

describe("runDecisionPromptJob", () => {
    it("is off unless the decisionPrompts flag is on", async () => {
        delete process.env.HR_RECRUITMENT_DECISION_PROMPTS;
        fake.store.interviews.push(interview());
        expect(await runDecisionPromptJob({ now: NOW })).toEqual({ skipped: "FLAG_OFF" });
    });

    it("prompts the hiring manager with ids and recommendation counts, once", async () => {
        fake.store.interviews.push(interview());
        const summary = await runDecisionPromptJob({ now: NOW });
        expect(summary).toMatchObject({ scanned: 1, prompted: 1 });
        expect(fake.store.interviews[0].decisionPromptedAt).toEqual(NOW);
        expect(fake.store.reminders.map((r) => `${r.kind}:${r.recipientKey}`)).toEqual(["DECISION_PROMPT:emp:42"]);
        expect(promptEvents()).toEqual([{
            interviewId: "1",
            applicationId: "50",
            requisitionId: "12",
            hiringManagerEmployeeId: "42",
            recommendationCounts: { HIRE: 1, STRONG_HIRE: 1 },
        }]);
        // No notes, scores or names travel on the event.
        expect(JSON.stringify(promptEvents())).not.toMatch(/internal|Ada|technicalSkills/);

        const again = await runDecisionPromptJob({ now: at(15 * 60 * 1000) });
        expect(again.prompted).toBe(0);
        expect(promptEvents()).toHaveLength(1);
    });

    it("waits for a missing scorecard and for the slot to end", async () => {
        fake.store.interviews.push(
            interview({ id: 1, scorecards: [card(7, "HIRE")] }),
            interview({ id: 2, status: "SCHEDULED", scheduledAt: at(-20 * 60 * 1000) }),
        );
        const summary = await runDecisionPromptJob({ now: NOW });
        expect(summary).toMatchObject({ prompted: 0, notReady: 2 });
        expect(promptEvents()).toEqual([]);
    });

    it("a direct prompt and the job never prompt twice", async () => {
        fake.store.interviews.push(interview());
        const first = await asTenant(async () => await promptInterviewDecision({ tenantId: T, interviewId: 1, now: NOW }));
        expect(first).toMatchObject({ prompted: true, recommendationCounts: { HIRE: 1, STRONG_HIRE: 1 } });
        const second = await asTenant(async () => await promptInterviewDecision({ tenantId: T, interviewId: 1, now: NOW }));
        expect(second).toMatchObject({ prompted: false, reason: "NOT_READY" });
        await runDecisionPromptJob({ now: NOW });
        expect(promptEvents()).toHaveLength(1);
    });

    it("the claim decides a race between two prompts", async () => {
        fake.store.interviews.push(interview());
        const results = await Promise.all([
            asTenant(async () => await promptInterviewDecision({ tenantId: T, interviewId: 1, now: NOW })),
            asTenant(async () => await promptInterviewDecision({ tenantId: T, interviewId: 1, now: NOW })),
        ]);
        expect(results.filter((r) => r.prompted)).toHaveLength(1);
        expect(results.find((r) => !r.prompted).reason).toBe("ALREADY_PROMPTED");
        expect(promptEvents()).toHaveLength(1);
        expect(fake.store.reminders).toHaveLength(1);
    });
});

describe("prompt on the last scorecard submit", () => {
    const submit = (reviewerId, submitted = true) =>
        asTenant(async () => await upsertInterviewScorecard({
            interviewId: 1,
            reviewerId,
            tenantId: T,
            data: { scores: { technicalSkills: 5 }, overallScore: 5, recommendation: "HIRE", notes: null, ...(submitted ? { submittedAt: new Date() } : {}) },
        }));

    it("prompts as soon as the last panelist submits", async () => {
        fake.store.interviews.push(interview({ status: "SCHEDULED", scorecards: [card(7, "HIRE")] }));
        await submit(8);
        expect(promptEvents()).toEqual([expect.objectContaining({ interviewId: "1", recommendationCounts: { HIRE: 2 } })]);
        expect(fake.store.interviews[0].decisionPromptedAt).not.toBeNull();
        // The job then finds nothing to do.
        expect((await runDecisionPromptJob({ now: new Date() })).prompted).toBe(0);
        expect(promptEvents()).toHaveLength(1);
    });

    it("does not prompt on a draft, on an incomplete panel, or with the flag off", async () => {
        fake.store.interviews.push(interview({ status: "SCHEDULED", scorecards: [] }));
        await submit(7);
        await submit(8, false);
        expect(promptEvents()).toEqual([]);
        delete process.env.HR_RECRUITMENT_DECISION_PROMPTS;
        await submit(8);
        expect(promptEvents()).toEqual([]);
    });

    it("a failing prompt never fails the scorecard write", async () => {
        fake.store.interviews.push(interview({ status: "SCHEDULED", scorecards: [card(7, "HIRE")] }));
        fake.db.interview.updateMany.mockImplementationOnce(() => Promise.reject(new Error("db down")));
        const row = await submit(8);
        expect(row).toMatchObject({ reviewerId: 8, recommendation: "HIRE" });
        expect(promptEvents()).toEqual([]);
        // The job is the backstop.
        expect((await runDecisionPromptJob({ now: new Date() })).prompted).toBe(1);
    });
});

describe("auto-advance on a NEXT_ROUND decision (setInterviewOutcome)", () => {
    const decide = (decision, extra = {}) =>
        asTenant(async () => await setInterviewOutcome({ interviewId: 1, decision, tenantId: T, actorId: 42, ...extra }));

    it("a FINAL interview moves the application to offer through the workflow, in the decision's transaction", async () => {
        fake.store.interviews.push(interview({ interviewType: "FINAL" }));
        await decide("NEXT_ROUND");
        expect(transitionApplicationStage).toHaveBeenCalledTimes(1);
        const args = transitionApplicationStage.mock.calls[0][0];
        expect(args).toMatchObject({ id: 50, tenantId: T, targetStage: "offer", source: AUTO_ADVANCE_SOURCE, actorId: null });
        expect(args.db).toBe(fake.db); // the caller's tx client
        expect(fake.store.interviews[0]).toMatchObject({ decision: "NEXT_ROUND", status: "COMPLETED" });
    });

    it("a FINAL interview with another round still scheduled does not move", async () => {
        fake.store.interviews.push(interview({ interviewType: "FINAL" }), interview({ id: 2, status: "SCHEDULED", scheduledAt: at(48 * HOUR) }));
        await decide("NEXT_ROUND");
        expect(transitionApplicationStage).not.toHaveBeenCalled();
    });

    it("a workflow refusal keeps the decision and moves nothing", async () => {
        fake.store.interviews.push(interview({ interviewType: "FINAL" }));
        transitionApplicationStage.mockRejectedValueOnce(
            Object.assign(new Error("nope"), { status: 409, code: "HR-RECRUITMENT-TRANSITION-INVALID" }),
        );
        await expect(decide("NEXT_ROUND")).resolves.toMatchObject({ decision: "NEXT_ROUND" });
        expect(fake.store.interviews[0].decision).toBe("NEXT_ROUND");
    });

    it("an earlier round keeps the application in interview and asks for the next round", async () => {
        fake.store.interviews.push(interview({ interviewType: "TECHNICAL" }));
        await decide("NEXT_ROUND");
        expect(transitionApplicationStage).not.toHaveBeenCalled();
        expect(nextRoundEvents()).toEqual([{ applicationId: "50", requisitionId: "12", interviewId: "1", interviewType: "TECHNICAL" }]);
    });

    it("no next-round request when the next round is already scheduled", async () => {
        fake.store.interviews.push(interview(), interview({ id: 2, status: "SCHEDULED", scheduledAt: at(48 * HOUR) }));
        await decide("NEXT_ROUND");
        expect(nextRoundEvents()).toEqual([]);
    });

    it("REJECTED never auto-rejects and HOLD does nothing", async () => {
        fake.store.interviews.push(interview({ interviewType: "FINAL" }));
        await decide("REJECTED", { reason: "Did not meet the bar" });
        fake.store.interviews[0].decision = null;
        await decide("HOLD");
        expect(transitionApplicationStage).not.toHaveBeenCalled();
        expect(nextRoundEvents()).toEqual([]);
    });

    it("with the flag off the decision is recorded and nothing moves", async () => {
        delete process.env.HR_RECRUITMENT_DECISION_PROMPTS;
        fake.store.interviews.push(interview({ interviewType: "FINAL" }));
        await decide("NEXT_ROUND");
        expect(transitionApplicationStage).not.toHaveBeenCalled();
        expect(nextRoundEvents()).toEqual([]);
        expect(fake.store.interviews[0].decision).toBe("NEXT_ROUND");
    });
});

describe("applyDecisionAutoAdvance (the hook interview.service.js calls)", () => {
    const run = (args) => asTenant(async () => await applyDecisionAutoAdvance(fake.db, { tenantId: T, interviewId: 1, ...args }));

    it("acts on a change to NEXT_ROUND only", async () => {
        fake.store.interviews.push(interview());
        expect(await run({ decision: "NEXT_ROUND", previousDecision: "NEXT_ROUND" })).toEqual({ action: "NONE", reason: "UNCHANGED" });
        expect(await run({ decision: "REJECTED" })).toEqual({ action: "NONE", reason: "REJECTION_NEEDS_HUMAN_DISPOSITION" });
        expect(await run({ decision: "NEXT_ROUND", previousDecision: "HOLD" })).toEqual({ action: "NEXT_ROUND_REQUESTED" });
    });

    it("leaves an application a human already moved", async () => {
        fake.store.interviews.push(interview({ interviewType: "FINAL" }));
        fake.store.interviews[0].application.stage = "on_hold";
        expect(await run({ decision: "NEXT_ROUND" })).toEqual({ action: "NONE", reason: "STAGE_NOT_INTERVIEW" });
        expect(transitionApplicationStage).not.toHaveBeenCalled();
    });
});
