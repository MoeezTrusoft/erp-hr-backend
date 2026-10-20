// Recruitment Phase 3b — scheduling pins the evaluation form in force, in the
// schedule's own transaction, so a later template change never alters the
// form a panel is filling.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { createSchedulingDb, createEventRecorder } from "./helpers/interview-scheduling.fake.js";

const { db, state } = createSchedulingDb();
const { enqueueHrDomainEvent } = createEventRecorder();
const pinEvaluationFormForInterview = jest.fn(async () => null);

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
jest.unstable_mockModule("../../../src/services/test-blueprint.service.js", () => ({
    markInterviewAssessmentInTransaction: jest.fn(async () => null),
}));
jest.unstable_mockModule("../../../src/services/scorecardTemplate.service.js", () => ({ pinEvaluationFormForInterview }));

const { scheduleInterviewInTransaction } = await import("../../../src/services/interview.service.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const TENANT = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
    for (const key of Object.keys(state)) state[key] = [];
    state.requisitions.push({ id: 21, tenantId: TENANT, title: "Backend Engineer", requestedById: 7 });
    state.applications.push({ id: 9, tenantId: TENANT, candidateId: 5, jobRequisitionId: 21, stage: "interview" });
    jest.clearAllMocks();
});

describe("scheduleInterviewInTransaction × evaluation form", () => {
    it("pins the form for the new interview inside the same transaction", async () => {
        const interview = await mcpCtx.run({ user: { tenantId: TENANT } }, async () =>
            await scheduleInterviewInTransaction(db, {
                applicationId: 9,
                interviewType: "TECHNICAL",
                scheduledAt: "2026-11-02T05:00:00Z",
                tenantId: TENANT,
                now: new Date("2026-10-20T09:00:00Z"),
            }));
        expect(pinEvaluationFormForInterview).toHaveBeenCalledTimes(1);
        expect(pinEvaluationFormForInterview).toHaveBeenCalledWith(db, { tenantId: TENANT, interviewId: interview.id });
    });
});
