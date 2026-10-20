// Phase 2 — the request path of resume parsing: one attempt per call, no
// in-request sleep, the retry left to nextAttemptAt; ingestEmployeeResume
// parses under the resolved tenant (it used to call the preview without one and
// always failed HR-TENANT-REQUIRED).
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const TENANT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-20T10:00:00.000Z");

const prisma = {
    resumeParseAttempt: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        updateMany: jest.fn(async () => ({ count: 1 })),
        delete: jest.fn(),
    },
    employee: { findFirst: jest.fn() },
    skill: { upsert: jest.fn(async ({ create }) => ({ id: 70, ...create })) },
    employeeSkill: { upsert: jest.fn(async () => ({})) },
    certification: { findFirst: jest.fn(async () => null), create: jest.fn(async ({ data }) => ({ id: 80, name: data.name })) },
    aiInferenceRecord: { create: jest.fn(async () => ({})) },
};
const downloadDamAssetBuffer = jest.fn();
const runAiTask = jest.fn();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/lib/logger.js", () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule("../../../src/services/dam.media.service.js", () => ({ downloadDamAssetBuffer }));
jest.unstable_mockModule("../../../src/lib/aiPlaneClient.js", () => ({ runAiTask, collectAiResult: jest.fn() }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent: jest.fn() }));

const resume = await import("../../../src/services/resumeParsing.service.js");

const CV = "Payroll specialist, SAP HCM, statutory reporting, team lead for five years.";

beforeEach(() => {
    jest.clearAllMocks();
    process.env.HR_RECRUITMENT_AI = "true";
    downloadDamAssetBuffer.mockResolvedValue({ buffer: Buffer.from(CV), mimeType: "text/plain", fileName: "cv.txt" });
    prisma.resumeParseAttempt.findUnique.mockResolvedValue(null);
    prisma.resumeParseAttempt.upsert.mockImplementation(async ({ create }) => ({ id: 5, ...create }));
});

afterEach(() => {
    delete process.env.HR_RECRUITMENT_AI;
    jest.useRealTimers();
});

describe("one attempt per request", () => {
    it("fails fast on a retryable plane error, schedules the retry and never waits", async () => {
        jest.useFakeTimers({ now: NOW });
        const setTimeoutSpy = jest.spyOn(globalThis, "setTimeout");
        runAiTask.mockResolvedValue({ taskId: "t1", status: "error", error: "provider down" });

        // With fake timers a sleep between attempts would never resolve; the
        // call must settle on its own.
        await expect(resume.parseResumeWithRetry(9, { kind: "CANDIDATE", tenantId: TENANT, candidateId: 3 }))
            .rejects.toMatchObject({ code: "HR-RESUME-PLANE-FAILED", parseOutcome: "RETRY_SCHEDULED" });

        expect(runAiTask).toHaveBeenCalledTimes(1);
        expect(setTimeoutSpy.mock.calls.filter(([, ms]) => Number(ms) >= 1000)).toHaveLength(0);

        // The row was claimed for this request and the retry put on the ledger.
        expect(prisma.resumeParseAttempt.upsert.mock.calls[0][0].create).toMatchObject({
            status: "RUNNING", attemptCount: 0, candidateId: 3, tenantId: TENANT,
        });
        const writes = prisma.resumeParseAttempt.updateMany.mock.calls.map(([args]) => args.data);
        expect(writes[0]).toMatchObject({ status: "RUNNING", attemptCount: 1 });
        expect(writes[1]).toMatchObject({ status: "FAILED", nextAttemptAt: new Date(NOW.getTime() + 1000), claimedBy: null });
        setTimeoutSpy.mockRestore();
    });

    it("refuses a second request while the first one's lease is live", async () => {
        // The ledger row for this very content, claimed a moment ago.
        const { hashResumeContent } = await import("../../../src/lib/parseRetry.js");
        prisma.resumeParseAttempt.findUnique.mockResolvedValue({
            id: 5, contentHash: hashResumeContent(Buffer.from(CV)), status: "RUNNING", attemptCount: 1,
            claimExpiresAt: new Date(Date.now() + 60_000), updatedAt: new Date(),
        });
        await expect(resume.parseResumeWithRetry(9, { tenantId: TENANT }))
            .rejects.toMatchObject({ status: 429, code: "HR-RESUME-BACKOFF", details: expect.objectContaining({ reason: "IN_PROGRESS" }) });
        expect(runAiTask).not.toHaveBeenCalled();
    });

    it("reports a missed wait window as pending and stores the task for later collection", async () => {
        runAiTask.mockResolvedValue({ taskId: "t-late", status: "pending", pending: true, sinceId: "42-0" });
        await expect(resume.parseResumeWithRetry(9, { tenantId: TENANT, candidateId: 3 }))
            .rejects.toMatchObject({ code: "HR-RESUME-PLANE-PENDING", parseOutcome: "PENDING" });
        const failed = prisma.resumeParseAttempt.updateMany.mock.calls.at(-1)[0].data;
        expect(failed.parsedJson.pendingAiTask).toMatchObject({ taskId: "t-late", sinceId: "42-0" });
        expect(failed.nextAttemptAt).toBeInstanceOf(Date);
    });
});

describe("ingestEmployeeResume", () => {
    it("reads the employee inside the tenant and parses with that tenant (EMPLOYEE ledger kind)", async () => {
        prisma.employee.findFirst.mockResolvedValue({ id: 12, tenant_id: TENANT });
        runAiTask.mockResolvedValue({
            taskId: "t2",
            status: "ok",
            output: { result: { skills: [{ name: "SAP HCM", score: 75 }], competencies: [], certifications: [{ name: "CPP" }] } },
        });

        const out = await resume.ingestEmployeeResume({ employeeId: 12, mediaId: 9, tenantId: TENANT });

        expect(prisma.employee.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 12, tenant_id: TENANT } }));
        expect(prisma.resumeParseAttempt.findUnique.mock.calls[0][0].where.tenantId_kind_contentHash)
            .toMatchObject({ tenantId: TENANT, kind: "EMPLOYEE" });
        expect(runAiTask.mock.calls[0][0].tenantId).toBe(TENANT);
        expect(out.counts).toMatchObject({ skills: 1, skillsWritten: 1, certificationsWritten: 1 });
        expect(prisma.skill.upsert.mock.calls[0][0].where).toEqual({ tenantId_name: { tenantId: TENANT, name: "SAP HCM" } });
    });

    it("falls back to the employee's own tenant on a legacy call without one", async () => {
        prisma.employee.findFirst.mockResolvedValue({ id: 12, tenant_id: TENANT });
        runAiTask.mockResolvedValue({ taskId: "t3", status: "ok", output: { result: { skills: [], competencies: [], certifications: [] } } });
        await expect(resume.ingestEmployeeResume({ employeeId: 12, mediaId: 9 })).resolves.toMatchObject({ employeeId: 12 });
        expect(prisma.employee.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 12 } }));
        expect(runAiTask.mock.calls[0][0].tenantId).toBe(TENANT);
    });

    it("is not found for another tenant's employee", async () => {
        prisma.employee.findFirst.mockResolvedValue(null);
        await expect(resume.ingestEmployeeResume({ employeeId: 12, mediaId: 9, tenantId: TENANT })).rejects.toMatchObject({ status: 404 });
        expect(downloadDamAssetBuffer).not.toHaveBeenCalled();
    });
});

describe("candidateResumeParsedEvent", () => {
    it("builds an ids-only payload and nothing without a tenant", () => {
        expect(resume.candidateResumeParsedEvent({ candidateId: 1, status: "COMPLETED" })).toBeNull();
        const event = resume.candidateResumeParsedEvent(
            { tenantId: TENANT, candidateId: 7, mediaId: 9, parseAttemptId: 5, status: "COMPLETED", skillCount: 2, competencyCount: 1, certificationCount: 0, fromCache: true, attempts: 1 },
            { actorType: "automation" },
        );
        expect(event).toMatchObject({ eventName: "hr.recruitment.candidate_resume_parsed.v1", aggregateType: "Candidate", aggregateId: 7, actorType: "automation" });
        expect(Object.keys(event.payload).sort()).toEqual(
            ["attempts", "candidateId", "certificationCount", "competencyCount", "fromCache", "mediaId", "parseAttemptId", "skillCount", "status"],
        );
    });
});
