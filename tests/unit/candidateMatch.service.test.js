// tests/unit/candidateMatch.service.test.js
//
// Phase 13 / §7.2a–7.4 — the advisory match service:
//   * the deterministic taxonomy report runs with or without the AI plane
//   * a plane outage DEGRADES (unavailable marker + degraded-unavailable
//     provenance row), it never fails the read (§7.1b)
//   * a successful AI call records ok-provenance with provider/model (§7.4)
//   * the service performs NO application-state mutation (§7.3)

import { describe, it, expect, beforeEach, jest } from "@jest/globals";

jest.setTimeout(15000);

const prisma = {
    skillAlias: { findMany: jest.fn(async () => []) },
    skill: { findMany: jest.fn(async () => [] ) },
    candidate: { findFirst: jest.fn() },
    jobRequisition: { findFirst: jest.fn() },
    aiInferenceRecord: { create: jest.fn(async (args) => ({ id: 1, ...args.data ?? args })) },
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const runAiTask = jest.fn();
jest.unstable_mockModule("../../src/lib/aiPlaneClient.js", () => ({ runAiTask }));

const { matchCandidateToRequisitionAdvisory, loadAliasIndex, requisitionSkillRequirements } = await import("../../src/services/candidate-match.service.js");

const CAND = {
    id: 11,
    firstName: "Ada",
    lastName: "Lovelace",
    tenantId: null,
    parsedResume: { skills: [{ name: "JS", score: 90, level: "Expert" }] },
    candidateSkills: [{ name: "Writing", score: null, level: null, category: "competency" }],
};
const REQ = {
    id: 7,
    title: "Backend Engineer",
    tenantId: null,
    jobContent: { skills: { required: ["JavaScript"], preferred: ["React"] } },
    requirements: null,
};

beforeEach(() => {
    jest.clearAllMocks();
    // These suites exercise the AI path — enable the flag explicitly (the
    // default is OFF per §7.1b; flag-disabled behaviour has its own tests in
    // recruitmentFlags.test.js).
    process.env.HR_RECRUITMENT_AI = "true";
    prisma.candidate.findFirst.mockResolvedValue(CAND);
    prisma.jobRequisition.findFirst.mockResolvedValue(REQ);
    prisma.skillAlias.findMany.mockResolvedValue([
        { alias: "JS", skillId: 1, scope: "PLATFORM", status: "ACTIVE", tenantId: null },
    ]);
    prisma.skill.findMany.mockResolvedValue([
        { id: 1, name: "JavaScript", tenantId: null },
        { id: 2, name: "React", tenantId: null },
    ]);
});

describe("candidateMatch.service — advisory matching", () => {
    test("returns a deterministic taxonomy report with ai=null when no AI requested", async () => {
        const report = await matchCandidateToRequisitionAdvisory({ tenantId: "t-1", candidateId: 11, requisitionId: 7 });
        expect(report.advisory).toBe(true);
        expect(report.ai).toBeNull();
        expect(report.taxonomy.matched[0].skillId).toBe(1); // JS → JavaScript via alias
        expect(report.taxonomy.coverage).toEqual({ requiredTotal: 1, requiredMatched: 1, preferredTotal: 1, preferredMatched: 0 });
        // "Writing" resolved nowhere — visible for curation.
        expect(report.taxonomy.unmappedCandidateSkills).toEqual(["Writing"]);
        expect(runAiTask).not.toHaveBeenCalled();
    });

    test("legacy free-text requirements are used when jobContent has no skills", async () => {
        prisma.jobRequisition.findFirst.mockResolvedValue({ ...REQ, jobContent: null, requirements: "JavaScript, React" });
        const report = await matchCandidateToRequisitionAdvisory({ tenantId: "t-1", candidateId: 11, requisitionId: 7 });
        expect(report.taxonomy.coverage.requiredTotal).toBe(2);
    });

    test("404s surface for unknown candidate/requisition", async () => {
        prisma.candidate.findFirst.mockResolvedValue(null);
        await expect(matchCandidateToRequisitionAdvisory({ tenantId: "t-1", candidateId: 999, requisitionId: 7 })).rejects.toMatchObject({ status: 404 });
    });

    describe("with the AI plane", () => {
        test("a plane outage degrades instead of failing the read, and records degraded-unavailable provenance", async () => {
            runAiTask.mockRejectedValue(Object.assign(new Error("no REDIS_URL"), { code: "HR-AI-PLANE-UNAVAILABLE", status: 503 }));
            const report = await matchCandidateToRequisitionAdvisory({ tenantId: "t-1", candidateId: 11, requisitionId: 7, withAiSummary: true });
            expect(report.taxonomy.matched).toHaveLength(1); // deterministic layer intact
            expect(report.ai.unavailable).toBe(true);
            const row = prisma.aiInferenceRecord.create.mock.calls[0][0].data;
            expect(row.status).toBe("degraded-unavailable");
            expect(row.kind).toBe("candidate-match");
        });

        test("a successful AI call records ok-provenance and resolves its skills through the same taxonomy", async () => {
            runAiTask.mockResolvedValue({
                taskId: "t-1",
                status: "ok",
                tokensUsed: 42,
                output: {
                    provider: "openai",
                    model: "gpt-4.1-mini",
                    redactionCounts: { NAME: 2 },
                    // runAiTask already unwraps the model text via extractModelJson,
                    // so the service receives an OBJECT here, not a JSON string.
                    result: {
                        matchedSkills: [{ name: "JS" }], // alias → canonical id 1
                        missingSkills: [{ name: "React", importance: "preferred" }],
                        confidence: 0.7,
                        summary: "Solid JS foundation.",
                    },
                },
            });
            const report = await matchCandidateToRequisitionAdvisory({ tenantId: "t-1", candidateId: 11, requisitionId: 7, withAiSummary: true });
            expect(report.ai.summary).toBe("Solid JS foundation.");
            expect(report.ai.matchedSkills[0].skillId).toBe(1);
            expect(report.ai.missingSkills[0].skillId).toBe(2);
            expect(report.ai.confidence).toBe(0.7);
            const row = prisma.aiInferenceRecord.create.mock.calls[0][0].data;
            expect(row.status).toBe("ok");
            expect(row.provider).toBe("openai");
            expect(row.model).toBe("gpt-4.1-mini");
            expect(row.confidence).toBe(0.7);
            expect(row.traceId).toBe("t-1");
            expect(row.candidateId).toBe(11);
            expect(row.requisitionId).toBe(7);
            expect(row.promptKey).toBe("hr.match.score.v1");
        });

        test("a plane error status records error provenance and marks ai unavailable", async () => {
            runAiTask.mockResolvedValue({ taskId: "t-2", status: "error", error: "llm call failed" });
            const report = await matchCandidateToRequisitionAdvisory({ tenantId: "t-1", candidateId: 11, requisitionId: 7, withAiSummary: true });
            expect(report.ai.unavailable).toBe(true);
            const row = prisma.aiInferenceRecord.create.mock.calls[0][0].data;
            expect(row.status).toBe("error");
        });
    });

    test("§7.3 — the service mutates no application state (no write calls beyond provenance)", async () => {
        await matchCandidateToRequisitionAdvisory({ tenantId: "t-1", candidateId: 11, requisitionId: 7, withAiSummary: true });
        // The only prisma writes the service knows are aiInferenceRecord rows.
        const calledModels = Object.keys(prisma).filter((m) => typeof prisma[m]?.create === "function" && prisma[m].create.mock.calls.length);
        expect(calledModels).toEqual(["aiInferenceRecord"]);
        expect(prisma.candidate.findFirst).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.anything() }));
    });

    test("loadAliasIndex resolves tenant extensions alongside the platform core", async () => {
        prisma.skillAlias.findMany.mockResolvedValue([
            { alias: "JS", skillId: 1, scope: "PLATFORM", status: "ACTIVE", tenantId: null },
            { alias: "JS", skillId: 9, scope: "TENANT", status: "ACTIVE", tenantId: "t-1" },
        ]);
        const index = await loadAliasIndex("t-1");
        const { matchCandidateToRequisition } = await import("../../src/lib/skill-normalization.util.js");
        const report = matchCandidateToRequisition(index, [{ name: "JS" }], { required: ["JS"] });
        expect(report.matched[0].skillId).toBe(9); // tenant shadow wins
    });
});

describe("D-13 — match reads are tenant-scoped", () => {
    it("reads the candidate and requisition inside the caller's tenant", async () => {
        prisma.candidate.findFirst.mockResolvedValue(CAND);
        prisma.jobRequisition.findFirst.mockResolvedValue(REQ);
        await matchCandidateToRequisitionAdvisory({ tenantId: "t-1", candidateId: 11, requisitionId: 7 });
        expect(prisma.candidate.findFirst.mock.calls.at(-1)[0].where).toEqual({ id: 11, tenantId: "t-1" });
        expect(prisma.jobRequisition.findFirst.mock.calls.at(-1)[0].where).toEqual({ id: 7, tenantId: "t-1" });
    });

    it("refuses to match without a tenant", async () => {
        await expect(matchCandidateToRequisitionAdvisory({ candidateId: 11, requisitionId: 7 }))
            .rejects.toMatchObject({ status: 400, code: "HR-TENANT-REQUIRED" });
    });
});

// Recruitment Phase 2 — the importance of a requisition skill. jobContent.skills
// is stored as a flat string[] (normalizeJobContent), so "preferred" travels as
// a marker in the string; older rows may carry {name, importance} objects. The
// extraction used to compute the importance and then put every skill in
// required.
describe("requisitionSkillRequirements — preferred skills land in preferred", () => {
    const req = (skills) => ({ jobContent: { skills }, requirements: null });

    it("reads preferred / nice-to-have markers off flat strings", () => {
        expect(requisitionSkillRequirements(req([
            "JavaScript",
            "React (preferred)",
            "Nice to have: GraphQL",
            "Docker (nice-to-have)",
            "Preferred - Terraform",
            "AWS [optional]",
            "SQL",
        ]))).toEqual({
            required: ["JavaScript", "SQL"],
            preferred: ["React", "GraphQL", "Docker", "Terraform", "AWS"],
        });
    });

    it("honours {name, importance} objects", () => {
        expect(requisitionSkillRequirements(req([
            { name: "JavaScript", importance: "required" },
            { name: "React", importance: "preferred" },
            { name: "GraphQL", importance: "nice_to_have" },
            { name: "Go", required: false },
            { name: "SQL" },
        ]))).toEqual({ required: ["JavaScript", "SQL"], preferred: ["React", "GraphQL", "Go"] });
    });

    it("keeps the {required, preferred} block and the legacy text fallback as they were", () => {
        expect(requisitionSkillRequirements(req({ required: ["JavaScript"], preferred: ["React"] })))
            .toEqual({ required: ["JavaScript"], preferred: ["React"] });
        expect(requisitionSkillRequirements({ jobContent: null, requirements: "JavaScript, React" }))
            .toEqual({ required: ["JavaScript", "React"], preferred: [] });
        expect(requisitionSkillRequirements({ jobContent: { skills: [] }, requirements: null })).toBeNull();
    });

    it("feeds the advisory report's preferred coverage", async () => {
        prisma.jobRequisition.findFirst.mockResolvedValue({ ...REQ, jobContent: { skills: ["JavaScript", "React (preferred)"] } });
        const report = await matchCandidateToRequisitionAdvisory({ tenantId: "t-1", candidateId: 11, requisitionId: 7 });
        expect(report.taxonomy.coverage).toEqual({ requiredTotal: 1, requiredMatched: 1, preferredTotal: 1, preferredMatched: 0 });
    });
});
