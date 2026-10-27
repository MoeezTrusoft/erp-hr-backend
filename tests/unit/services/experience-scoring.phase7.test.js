// tests/unit/services/experience-scoring.phase7.test.js
//
// Recruitment Phase 7 (D18c) — the fit score's experience component, end to
// end through the code that feeds it:
//   * a resume parse derives yearsOfExperience from the plane's dated work
//     history and stores it on the ledger row and on Candidate.parsedResume;
//   * a requisition's jobContent accepts minYearsExperience (0..50);
//   * with both, buildFitInputs hands them to computeFitScore and the
//     experience component is assessed; with either missing it stays
//     "not assessed" and its weight is renormalised away.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const TENANT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-27T00:00:00.000Z");

const prisma = {
    resumeParseAttempt: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        updateMany: jest.fn(async () => ({ count: 1 })),
        delete: jest.fn(),
    },
    candidate: { findFirst: jest.fn(), updateMany: jest.fn(async () => ({ count: 1 })) },
    candidateSkill: { upsert: jest.fn(async () => ({})) },
    aiInferenceRecord: { create: jest.fn(async () => ({})) },
};
const downloadDamAssetBuffer = jest.fn();
const runAiTask = jest.fn();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/lib/logger.js", () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
}));
jest.unstable_mockModule("../../../src/lib/rlsTenant.js", () => ({ tenantTransaction: (client, fn) => fn(client) }));
jest.unstable_mockModule("../../../src/services/dam.media.service.js", () => ({ downloadDamAssetBuffer }));
jest.unstable_mockModule("../../../src/lib/aiPlaneClient.js", () => ({ runAiTask, collectAiResult: jest.fn() }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent: jest.fn() }));
jest.unstable_mockModule("../../../src/services/recruitment-settings.service.js", () => ({ getRecruitmentSettings: jest.fn() }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn() }));

const resume = await import("../../../src/services/resumeParsing.service.js");
const { buildFitInputs } = await import("../../../src/services/application-scoring.service.js");
const { computeFitScore } = await import("../../../src/lib/fit-score.util.js");
const { normalizeJobContent, pickRequisitionFields } = await import("../../../src/lib/requisitionFields.js");

const CV = "Backend engineer: Node.js, SQL and PostgreSQL across two companies since 2016.";
const PLANE_RESULT = {
    skills: [{ name: "Node.js", score: 80 }, { name: "SQL", score: 70 }],
    competencies: [],
    certifications: [],
    experience: [
        { title: "Engineer", startDate: "2016-10", endDate: "2021-10" },
        { title: "Consultant", startDate: "2020-10", endDate: "2022-10" }, // overlaps the first
        { title: "Lead", startDate: "2024-10-27", endDate: "Present" },
    ],
};

const experienceOf = (score) => score.components.find((c) => c.key === "experience");

beforeEach(() => {
    jest.clearAllMocks();
    process.env.HR_RECRUITMENT_AI = "true";
    downloadDamAssetBuffer.mockResolvedValue({ buffer: Buffer.from(CV), mimeType: "text/plain", fileName: "cv.txt" });
    prisma.resumeParseAttempt.findUnique.mockResolvedValue(null);
    prisma.resumeParseAttempt.upsert.mockImplementation(async ({ create }) => ({ id: 5, ...create }));
    prisma.candidate.findFirst.mockResolvedValue({ id: 77, tenantId: TENANT, resumeMediaId: 9 });
    runAiTask.mockResolvedValue({ taskId: "t1", status: "ok", output: { model: "m", result: PLANE_RESULT } });
});

afterEach(() => {
    delete process.env.HR_RECRUITMENT_AI;
});

describe("resume parsing derives yearsOfExperience", () => {
    it("merges the overlapping jobs, runs 'Present' to the parse time and stores the years only", async () => {
        const parsed = await resume.parseResumeWithRetry(9, { tenantId: TENANT, candidateId: 77, now: NOW });
        // 2016-10 .. 2022-10 merged (6 years) + 2024-10-27 .. parse time (2 years).
        expect(parsed.yearsOfExperience).toBe(8);

        // The ledger row caches it (a later cache hit returns the same number) ...
        const completed = prisma.resumeParseAttempt.updateMany.mock.calls.map(([a]) => a.data).find((d) => d.status === "COMPLETED");
        expect(completed.parsedJson.yearsOfExperience).toBe(8);
        // ... and no work-history entry (employer, title) is kept.
        expect(completed.parsedJson.experience).toBeUndefined();
    });

    it("projects it onto Candidate.parsedResume", async () => {
        const out = await resume.ingestCandidateResume({ candidateId: 77, tenantId: TENANT });
        const write = prisma.candidate.updateMany.mock.calls.map(([a]) => a.data).find((d) => d.parsedResume);
        expect(Number.isFinite(write.parsedResume.yearsOfExperience)).toBe(true);
        expect(write.parsedResume.yearsOfExperience).toBeGreaterThanOrEqual(8);
        expect(out.yearsOfExperience).toBe(write.parsedResume.yearsOfExperience);
    });

    it("stores null when the parse has no dated entry", async () => {
        runAiTask.mockResolvedValue({
            taskId: "t2",
            status: "ok",
            output: { result: { ...PLANE_RESULT, experience: [{ title: "Engineer", startDate: "2016" }] } },
        });
        await resume.ingestCandidateResume({ candidateId: 77, tenantId: TENANT });
        const write = prisma.candidate.updateMany.mock.calls.map(([a]) => a.data).find((d) => d.parsedResume);
        expect(write.parsedResume.yearsOfExperience).toBeNull();
    });
});

describe("jobContent.minYearsExperience", () => {
    it("accepts a number or numeric string from 0 to 50 and leaves it out when blank", () => {
        expect(normalizeJobContent({ minYearsExperience: 5 }).minYearsExperience).toBe(5);
        expect(normalizeJobContent({ minYearsExperience: "2.5" }).minYearsExperience).toBe(2.5);
        expect(normalizeJobContent({ minYearsExperience: 0 }).minYearsExperience).toBe(0);
        expect(normalizeJobContent({ minYearsExperience: null })).not.toHaveProperty("minYearsExperience");
        expect(normalizeJobContent({ minYearsExperience: "" })).not.toHaveProperty("minYearsExperience");
        expect(normalizeJobContent({ summary: "x" })).not.toHaveProperty("minYearsExperience");
        expect(pickRequisitionFields({ jobContent: { minYearsExperience: 3 } }).jobContent.minYearsExperience).toBe(3);
    });

    it("refuses a value outside 0..50 or not a number (422)", () => {
        for (const bad of [-1, 51, "five", true, [3], { n: 3 }]) {
            expect(() => normalizeJobContent({ minYearsExperience: bad })).toThrow(
                expect.objectContaining({ status: 422, code: "HR-RECRUITMENT-JOB-CONTENT-INVALID" }),
            );
        }
    });
});

describe("the experience component", () => {
    const application = ({ years, jobContent }) => ({
        id: 900,
        knockedOut: false,
        answerScore: null,
        answerMaxScore: null,
        candidate: { id: 77, parsedResume: years === undefined ? {} : { yearsOfExperience: years }, candidateSkills: [{ name: "SQL" }] },
        jobRequisition: { id: 12, jobContent, requirements: null },
    });

    it("turns on when the resume has years and the requisition a minimum", () => {
        const jobContent = normalizeJobContent({ skills: ["SQL"], minYearsExperience: 10 });
        const score = computeFitScore(buildFitInputs(application({ years: 8, jobContent })));
        expect(experienceOf(score)).toMatchObject({ assessed: true, value: 0.8, weight: 15 });
        expect(experienceOf(score).explanation).toBe("8 years of experience against a 10-year minimum");
        // required 1/1 (weight 50) and experience 0.8 (weight 15): 100 * (50 + 12) / 65.
        expect(score.score).toBe(95.4);
    });

    it("stays not assessed without a minimum, and without parsed years", () => {
        const noMinimum = computeFitScore(buildFitInputs(application({ years: 8, jobContent: normalizeJobContent({ skills: ["SQL"] }) })));
        expect(experienceOf(noMinimum)).toMatchObject({ assessed: false, value: null });
        expect(experienceOf(noMinimum).explanation).toMatch(/no minimum experience/);
        expect(noMinimum.score).toBe(100);

        const jobContent = normalizeJobContent({ skills: ["SQL"], minYearsExperience: 10 });
        const noYears = computeFitScore(buildFitInputs(application({ years: null, jobContent })));
        expect(experienceOf(noYears)).toMatchObject({ assessed: false, value: null });
        expect(experienceOf(noYears).explanation).toMatch(/no years of experience/);
        expect(noYears.score).toBe(100);
    });

    it("a changed minimum changes the inputs hash, so the scoring job rescores", () => {
        const a = computeFitScore(buildFitInputs(application({ years: 8, jobContent: normalizeJobContent({ skills: ["SQL"], minYearsExperience: 10 }) })));
        const b = computeFitScore(buildFitInputs(application({ years: 8, jobContent: normalizeJobContent({ skills: ["SQL"], minYearsExperience: 5 }) })));
        expect(a.inputsHash).not.toBe(b.inputsHash);
    });
});
