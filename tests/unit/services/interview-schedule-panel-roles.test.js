// Recruitment Phase 7 (B5) — scheduling an interview stores each panelist's
// panel role (validated before any write); a panelist without one keeps the
// pre-roles behaviour (every form section).
import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";
import { createSchedulingDb, createEventRecorder } from "./helpers/interview-scheduling.fake.js";

const { db, state } = createSchedulingDb();
const { enqueueHrDomainEvent } = createEventRecorder();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));
jest.unstable_mockModule("../../../src/services/candidate-privacy.service.js", () => ({ assertCommunicationsAllowed: jest.fn(async () => ({ allowed: true })) }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../../src/services/application-workflow.service.js", () => ({
    transitionApplicationStageInTransaction: jest.fn(async () => ({})),
    transitionApplicationStage: jest.fn(async () => ({})),
}));
jest.unstable_mockModule("../../../src/services/interview-scorecard.service.js", () => ({ upsertInterviewScorecard: jest.fn(), default: jest.fn() }));
jest.unstable_mockModule("../../../src/services/test-blueprint.service.js", () => ({
    markInterviewAssessmentInTransaction: jest.fn(async () => null),
}));
jest.unstable_mockModule("../../../src/services/scorecard-template.service.js", () => ({ pinEvaluationFormForInterview: jest.fn(async () => null) }));

const { scheduleInterviewInTransaction } = await import("../../../src/services/interview.service.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const FLAG = "HR_RECRUITMENT_EVALUATION_FORMS";
const saved = process.env[FLAG];

const schedule = (extra = {}) => mcpCtx.run({ user: { tenantId: TENANT } }, async () =>
    await scheduleInterviewInTransaction(db, {
        applicationId: 9,
        interviewType: "PANEL",
        scheduledAt: "2026-11-02T05:00:00Z",
        interviewerIds: ["3", "4"],
        tenantId: TENANT,
        now: new Date("2026-10-20T09:00:00Z"),
        ...extra,
    }));

beforeEach(() => {
    for (const key of Object.keys(state)) state[key] = [];
    state.requisitions.push({ id: 21, tenantId: TENANT, title: "Backend Engineer", requestedById: 7 });
    state.applications.push({ id: 9, tenantId: TENANT, candidateId: 5, jobRequisitionId: 21, stage: "interview" });
    process.env[FLAG] = "true";
    jest.clearAllMocks();
});

afterAll(() => {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
});

describe("scheduleInterviewInTransaction × panel roles", () => {
    it("stores the given role per panelist and none for the others", async () => {
        const interview = await schedule({ panelRoles: [{ employeeId: 3, panelRole: "technical" }] });
        const links = state.interviewers.filter((l) => l.interviewId === interview.id);
        expect(links).toEqual([
            { interviewId: interview.id, employeeId: 3, panelRole: "TECHNICAL", tenantId: TENANT },
            { interviewId: interview.id, employeeId: 4, tenantId: TENANT },
        ]);
    });

    it("without roles the panel is written exactly as before", async () => {
        process.env[FLAG] = "false";
        const interview = await schedule();
        expect(state.interviewers.filter((l) => l.interviewId === interview.id)).toEqual([
            { interviewId: interview.id, employeeId: 3, tenantId: TENANT },
            { interviewId: interview.id, employeeId: 4, tenantId: TENANT },
        ]);
    });

    it("refuses a role for someone not on the panel, or an unknown role, before any write", async () => {
        await expect(schedule({ panelRoles: [{ employeeId: 8, panelRole: "HR" }] }))
            .rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-PANEL-ROLE-NOT-PANELIST" });
        await expect(schedule({ panelRoles: { 3: "JUDGE" } }))
            .rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-PANEL-ROLE-INVALID" });
        expect(state.interviews).toHaveLength(0);
    });

    it("roles with evaluation forms off are refused (503 -DISABLED)", async () => {
        process.env[FLAG] = "false";
        await expect(schedule({ panelRoles: [{ employeeId: 3, panelRole: "HR" }] }))
            .rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-EVALUATION-FORMS-DISABLED" });
        expect(state.interviews).toHaveLength(0);
    });
});
