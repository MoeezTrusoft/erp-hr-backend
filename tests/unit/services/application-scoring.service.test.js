// tests/unit/services/application-scoring.service.test.js
//
// Recruitment Phase 2 (§6.4) — the scoring service: the feature columns it
// may read, the score upsert and skip-on-same-hash, the job's flag and
// per-row isolation, the shortlist proposal rules (threshold, top share,
// exclusions, idempotency), confirm/dismiss and the scope on every read.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const db = {
    application: { findFirst: jest.fn(), findMany: jest.fn() },
    applicationScore: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        upsert: jest.fn(),
        updateMany: jest.fn(),
        count: jest.fn(),
    },
    shortlistEntry: { findMany: jest.fn(), createMany: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() },
    jobRequisition: { findFirst: jest.fn() },
    skillAlias: { findMany: jest.fn() },
    skill: { findMany: jest.fn() },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(async () => 1),
};
const enqueueHrDomainEvent = jest.fn(async () => ({ id: "evt-1" }));
const getRecruitmentSettings = jest.fn();
const logAction = jest.fn(async () => undefined);

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/lib/rlsTenant.js", () => ({ tenantTransaction: (client, fn) => fn(client) }));
jest.unstable_mockModule("../../../src/lib/aiPlaneClient.js", () => ({ runAiTask: jest.fn() }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));
jest.unstable_mockModule("../../../src/services/recruitment-settings.service.js", () => ({ getRecruitmentSettings }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction }));

const service = await import("../../../src/services/application-scoring.service.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

// Prisma queries are lazy: they run when awaited. This thenable records the
// context active at AWAIT time, so a query returned unawaited from an
// mcpCtx.run callback (and so run outside it) shows up as the wrong context.
const lazy = (value, seen) => ({
    then(resolve, reject) {
        seen.push(mcpCtx.getStore() ?? null);
        return Promise.resolve(typeof value === "function" ? value() : value).then(resolve, reject);
    },
});
const { resolveRecruitmentScope } = await import("../../../src/lib/recruitmentAccess.js");
const { computeFitScore } = await import("../../../src/lib/fit-score.util.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-20T08:00:00Z");
const ORG = resolveRecruitmentScope({ roles: ["RECRUITER"], employeeId: 5 });
const MANAGER = resolveRecruitmentScope({ roles: ["HIRING_MANAGER"], employeeId: 42 });
const INTERVIEWER = resolveRecruitmentScope({ roles: ["INTERVIEWER"], employeeId: 9 });

const APPLICATION = {
    id: 900,
    tenantId: TENANT,
    candidateId: 77,
    jobRequisitionId: 12,
    stage: "screening",
    knockedOut: false,
    answerScore: 8,
    answerMaxScore: 10,
    candidate: {
        id: 77,
        parsedResume: { yearsOfExperience: 6, skills: [{ name: "JS" }] },
        candidateSkills: [{ name: "JS" }, { name: "SQL" }],
    },
    jobRequisition: {
        id: 12,
        jobContent: { skills: ["JavaScript", "SQL", "React (preferred)"], minYearsExperience: 5 },
        requirements: null,
    },
};

const assessed = [{ key: "requiredSkills", weight: 50, value: 1, assessed: true }];
const scoreRow = (applicationId, score, extra = {}) => ({
    applicationId,
    score,
    components: assessed,
    shortlistProposedAt: null,
    application: { stage: "screening", knockedOut: false },
    ...extra,
});

beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.HR_RECRUITMENT_SCORING;
    db.skillAlias.findMany.mockResolvedValue([{ alias: "JS", skillId: 1, scope: "PLATFORM", status: "ACTIVE", tenantId: null }]);
    db.skill.findMany.mockResolvedValue([
        { id: 1, name: "JavaScript", tenantId: null },
        { id: 2, name: "SQL", tenantId: null },
        { id: 3, name: "React", tenantId: null },
    ]);
    db.application.findFirst.mockResolvedValue(APPLICATION);
    db.applicationScore.findFirst.mockResolvedValue(null);
    db.applicationScore.upsert.mockResolvedValue({ id: 1 });
    db.applicationScore.updateMany.mockResolvedValue({ count: 1 });
    db.jobRequisition.findFirst.mockResolvedValue({ id: 12, status: "POSTED" });
    db.shortlistEntry.findMany.mockResolvedValue([]);
    db.shortlistEntry.createMany.mockResolvedValue({ count: 0 });
    getRecruitmentSettings.mockResolvedValue({ shortlistThreshold: 70, shortlistTopPercent: 10 });
});

// ── Features ─────────────────────────────────────────────────────────────────
describe("feature columns (no protected attribute or free text is selectable)", () => {
    const PROTECTED = [
        "firstName", "lastName", "email", "phone", "gender", "age", "dateOfBirth", "dob",
        "nationality", "photo", "photoUrl", "address", "location", "notes", "source",
    ];

    it("selects only skills, years, answers and the knockout flag", () => {
        expect(Object.keys(service.SCORING_CANDIDATE_SELECT).sort()).toEqual(["candidateSkills", "id", "parsedResume"]);
        expect(service.SCORING_CANDIDATE_SELECT.candidateSkills).toEqual({ select: { name: true } });
        expect(Object.keys(service.SCORING_REQUISITION_SELECT).sort()).toEqual(["id", "jobContent", "requirements"]);
        expect(Object.keys(service.SCORING_APPLICATION_SELECT).sort()).toEqual([
            "answerMaxScore", "answerScore", "candidate", "candidateId", "id", "jobRequisition",
            "jobRequisitionId", "knockedOut", "stage", "tenantId",
        ]);
        const all = JSON.stringify(service.SCORING_APPLICATION_SELECT);
        for (const field of PROTECTED) expect(all).not.toContain(`"${field}"`);
    });

    it("buildFitInputs hands the formula exactly its eight inputs", () => {
        const inputs = service.buildFitInputs({
            ...APPLICATION,
            candidate: { ...APPLICATION.candidate, firstName: "Ada", email: "a@x.test", parsedResume: { ...APPLICATION.candidate.parsedResume, name: "Ada" } },
        });
        expect(Object.keys(inputs).sort()).toEqual([
            "answerMaxScore", "answerScore", "candidateSkills", "candidateYears", "knockedOut",
            "minYears", "preferredSkills", "requiredSkills",
        ]);
        expect(inputs).toEqual({
            requiredSkills: ["JavaScript", "SQL"],
            preferredSkills: ["React"],
            candidateSkills: ["JS", "SQL"],
            candidateYears: 6,
            minYears: 5,
            knockedOut: false,
            answerScore: 8,
            answerMaxScore: 10,
        });
    });

    it("reads missing years as null (not assessed), never 0", () => {
        const inputs = service.buildFitInputs({
            ...APPLICATION,
            candidate: { ...APPLICATION.candidate, parsedResume: { skills: [] } },
            jobRequisition: { ...APPLICATION.jobRequisition, jobContent: { skills: ["SQL"] } },
        });
        expect(inputs.candidateYears).toBeNull();
        expect(inputs.minYears).toBeNull();
    });
});

// ── scoreApplication ─────────────────────────────────────────────────────────
describe("scoreApplication", () => {
    it("upserts the score with its model version, components and hash", async () => {
        const result = await service.scoreApplication({ tenantId: TENANT, applicationId: 900, now: NOW });
        expect(result).toMatchObject({ applicationId: 900, requisitionId: 12, status: "SCORED" });
        expect(db.application.findFirst).toHaveBeenCalledWith({
            where: { id: 900, tenantId: TENANT },
            select: service.SCORING_APPLICATION_SELECT,
        });
        const call = db.applicationScore.upsert.mock.calls[0][0];
        expect(call.where).toEqual({ applicationId: 900 });
        expect(call.create).toMatchObject({
            tenantId: TENANT,
            applicationId: 900,
            requisitionId: 12,
            candidateId: 77,
            modelVersion: "fit-v1",
            computedAt: NOW,
            updatedAt: NOW,
        });
        expect(call.create.score).toBe(result.score);
        expect(call.create.inputsHash).toMatch(/^[0-9a-f]{64}$/);
        expect(call.create.components.map((c) => c.key)).toEqual([
            "requiredSkills", "preferredSkills", "experience", "screeningAnswers", "knockout",
        ]);
        expect(call.update).not.toHaveProperty("shortlistProposedAt");
    });

    it("skips the score write when the inputs hash is unchanged", async () => {
        await service.scoreApplication({ tenantId: TENANT, applicationId: 900, now: NOW });
        const hash = db.applicationScore.upsert.mock.calls[0][0].create.inputsHash;
        jest.clearAllMocks();
        db.application.findFirst.mockResolvedValue(APPLICATION);
        db.applicationScore.findFirst.mockResolvedValue({ id: 1, inputsHash: hash, score: 90, band: "STRONG" });
        db.applicationScore.updateMany.mockResolvedValue({ count: 1 });

        const result = await service.scoreApplication({ tenantId: TENANT, applicationId: 900, now: NOW });
        expect(result.status).toBe("UNCHANGED");
        expect(db.applicationScore.upsert).not.toHaveBeenCalled();
        // Only the last-check stamp, guarded on the same hash.
        expect(db.applicationScore.updateMany).toHaveBeenCalledWith({
            where: { tenantId: TENANT, applicationId: 900, inputsHash: hash },
            data: { updatedAt: NOW },
        });
    });

    it("rescores when the inputs changed", async () => {
        db.applicationScore.findFirst.mockResolvedValue({ id: 1, inputsHash: "old", score: 10, band: "WEAK" });
        const result = await service.scoreApplication({ tenantId: TENANT, applicationId: 900, now: NOW });
        expect(result.status).toBe("RESCORED");
        expect(db.applicationScore.upsert).toHaveBeenCalled();
    });

    it("404s an application outside the tenant", async () => {
        db.application.findFirst.mockResolvedValue(null);
        await expect(service.scoreApplication({ tenantId: TENANT, applicationId: 1 })).rejects.toMatchObject({ status: 404 });
    });
});

// ── The job ──────────────────────────────────────────────────────────────────
describe("runApplicationScoringJob", () => {
    it("does nothing with the scoring flag off", async () => {
        expect(await service.runApplicationScoringJob({ now: NOW })).toEqual({ skipped: "FLAG_OFF" });
        expect(db.application.findMany).not.toHaveBeenCalled();
    });

    it("scores each tenant's changed applications and proposes for the touched requisitions", async () => {
        process.env.HR_RECRUITMENT_SCORING = "true";
        db.application.findMany.mockResolvedValue([{ tenantId: TENANT }]);
        db.$queryRaw.mockResolvedValue([{ id: 900 }, { id: 901 }]);
        db.application.findFirst
            .mockResolvedValueOnce(APPLICATION)
            .mockRejectedValueOnce(new Error("boom")); // one bad row never stops the run
        db.applicationScore.findMany.mockResolvedValue([scoreRow(900, 90)]);

        const summary = await service.runApplicationScoringJob({ now: NOW, limit: 50 });
        expect(summary).toMatchObject({ tenants: 1, scored: 1, failed: 1, proposed: 1 });
        expect(db.shortlistEntry.createMany).toHaveBeenCalledTimes(1);
        // The change scan is bounded by the limit.
        expect(db.$queryRaw.mock.calls[0]).toContain(50);
    });

    it("runs the tenant scan in the system context and each tenant's work in that tenant's context", async () => {
        process.env.HR_RECRUITMENT_SCORING = "true";
        const scanSeen = [];
        const tenantSeen = [];
        db.application.findMany.mockImplementation(() => lazy([{ tenantId: TENANT }], scanSeen));
        db.$queryRaw.mockImplementation(() => lazy([{ id: 900 }], tenantSeen));
        db.application.findFirst.mockImplementation(() => lazy(APPLICATION, tenantSeen));
        db.applicationScore.findFirst.mockImplementation(() => lazy(null, tenantSeen));
        db.applicationScore.upsert.mockImplementation(() => lazy({ id: 1 }, tenantSeen));
        db.applicationScore.findMany.mockImplementation(() => lazy([], tenantSeen));

        const summary = await service.runApplicationScoringJob({ now: NOW });
        expect(summary).toMatchObject({ tenants: 1, scored: 1 });
        expect(scanSeen).toEqual([expect.objectContaining({ system: true })]);
        expect(tenantSeen.length).toBeGreaterThan(0);
        for (const store of tenantSeen) expect(store?.user?.tenantId).toBe(TENANT);
    });

    it("isolates a failing tenant from the others", async () => {
        process.env.HR_RECRUITMENT_SCORING = "true";
        db.application.findMany.mockResolvedValue([{ tenantId: TENANT }, { tenantId: "22222222-2222-4222-8222-222222222222" }]);
        db.$queryRaw.mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce([]);
        const summary = await service.runApplicationScoringJob({ now: NOW });
        expect(summary.tenants).toBe(2);
        expect(summary.perTenant[0]).toMatchObject({ tenantId: TENANT, error: "db down" });
        expect(summary.perTenant[1]).toMatchObject({ scored: 0 });
    });
});

// ── Proposal rules ───────────────────────────────────────────────────────────
describe("selectShortlistProposals", () => {
    const ranked = (scores) => scores.map((score, i) => scoreRow(100 + i, score));

    it("proposes at or above the threshold", () => {
        expect(service.selectShortlistProposals(ranked([90, 70, 69.9, 40]), { threshold: 70, topPercent: 0 })).toEqual([100, 101]);
    });

    it("proposes the top ceil(n * topPercent / 100) places below the threshold", () => {
        // n = 20, 10% → 2 places
        const rows = ranked(Array.from({ length: 20 }, (_, i) => 60 - i));
        expect(service.selectShortlistProposals(rows, { threshold: 70, topPercent: 10 })).toEqual([100, 101]);
        // n = 3, 10% → ceil(0.3) = 1 place (minimum one when n > 0)
        expect(service.selectShortlistProposals(ranked([60, 50, 40]), { threshold: 70, topPercent: 10 })).toEqual([100]);
    });

    it("excludes knocked-out, inactive, shortlisted, already proposed and unassessed rows", () => {
        const rows = [
            scoreRow(1, 95, { application: { stage: "screening", knockedOut: true } }),
            scoreRow(2, 94, { application: { stage: "rejected", knockedOut: false } }),
            scoreRow(3, 93),
            scoreRow(4, 92, { shortlistProposedAt: NOW }),
            scoreRow(5, 91, { components: [{ key: "requiredSkills", weight: 50, value: null, assessed: false }] }),
            scoreRow(6, 90, { components: [...assessed, { key: "knockout", weight: 0, value: 0, assessed: true }] }),
            scoreRow(7, 89),
        ];
        expect(service.selectShortlistProposals(rows, { threshold: 70, topPercent: 10, shortlisted: new Set([3]) })).toEqual([7]);
    });

    it("proposes nothing from an empty ranking", () => {
        expect(service.selectShortlistProposals([], { threshold: 0, topPercent: 100 })).toEqual([]);
    });
});

describe("proposeShortlist", () => {
    it("creates SCORING_PROPOSAL entries, stamps shortlistProposedAt and emits ids only", async () => {
        db.applicationScore.findMany.mockResolvedValue([scoreRow(900, 88), scoreRow(901, 75), scoreRow(902, 30)]);
        const result = await service.proposeShortlist({ tenantId: TENANT, requisitionId: 12, now: NOW });

        expect(result.proposed).toEqual([900, 901]);
        expect(db.$executeRaw).toHaveBeenCalled(); // per-requisition advisory lock
        expect(db.applicationScore.findMany.mock.calls[0][0]).toMatchObject({
            where: { tenantId: TENANT, requisitionId: 12, application: { stage: { notIn: ["hired", "rejected", "withdrawn"] } } },
            orderBy: [{ score: "desc" }, { application: { appliedAt: "asc" } }, { applicationId: "asc" }],
        });
        expect(db.shortlistEntry.createMany).toHaveBeenCalledWith({
            data: [
                { applicationId: 900, requisitionId: 12, tenantId: TENANT, source: "SCORING_PROPOSAL", addedById: null },
                { applicationId: 901, requisitionId: 12, tenantId: TENANT, source: "SCORING_PROPOSAL", addedById: null },
            ],
            skipDuplicates: true,
        });
        expect(db.applicationScore.updateMany).toHaveBeenCalledWith({
            where: { tenantId: TENANT, applicationId: { in: [900, 901] }, shortlistProposedAt: null },
            data: { shortlistProposedAt: NOW },
        });
        const event = enqueueHrDomainEvent.mock.calls[0][1];
        expect(event).toMatchObject({
            eventName: "hr.recruitment.shortlist_proposed.v1",
            tenantId: TENANT,
            aggregateType: "JobRequisition",
            aggregateId: 12,
            payload: { requisitionId: "12", applicationIds: ["900", "901"], modelVersion: "fit-v1" },
        });
        expect(Object.keys(event.payload).sort()).toEqual(["applicationIds", "modelVersion", "requisitionId"]);
    });

    it("is idempotent: proposed or shortlisted applications are not proposed again, and nothing is removed", async () => {
        db.applicationScore.findMany.mockResolvedValue([scoreRow(900, 88, { shortlistProposedAt: NOW }), scoreRow(901, 75)]);
        db.shortlistEntry.findMany.mockResolvedValue([{ applicationId: 901 }]); // a recruiter's MANUAL entry
        const result = await service.proposeShortlist({ tenantId: TENANT, requisitionId: 12, now: NOW });
        expect(result.proposed).toEqual([]);
        expect(db.shortlistEntry.createMany).not.toHaveBeenCalled();
        expect(db.shortlistEntry.deleteMany).not.toHaveBeenCalled();
        expect(db.shortlistEntry.updateMany).not.toHaveBeenCalled();
        expect(enqueueHrDomainEvent).not.toHaveBeenCalled();
    });

    it("uses the tenant's threshold and top share", async () => {
        getRecruitmentSettings.mockResolvedValue({ shortlistThreshold: 95, shortlistTopPercent: 0 });
        db.applicationScore.findMany.mockResolvedValue([scoreRow(900, 88)]);
        const result = await service.proposeShortlist({ tenantId: TENANT, requisitionId: 12, now: NOW });
        expect(result).toMatchObject({ threshold: 95, topPercent: 0, proposed: [] });
    });

    it("skips a requisition that is no longer hiring", async () => {
        db.jobRequisition.findFirst.mockResolvedValue({ id: 12, status: "CLOSED" });
        const result = await service.proposeShortlist({ tenantId: TENANT, requisitionId: 12 });
        expect(result).toMatchObject({ proposed: [], skipped: "REQUISITION_NOT_OPEN" });
        expect(db.applicationScore.findMany).not.toHaveBeenCalled();
    });

    it("scopes a manager to their own requisitions and refuses an interviewer", async () => {
        db.applicationScore.findMany.mockResolvedValue([]);
        await service.proposeShortlist({ tenantId: TENANT, requisitionId: 12, scope: MANAGER });
        expect(db.jobRequisition.findFirst.mock.calls[0][0].where).toEqual({
            id: 12,
            tenantId: TENANT,
            AND: [{ OR: [{ requestedById: 42 }, { approvedById: 42 }] }],
        });

        db.jobRequisition.findFirst.mockResolvedValue(null);
        await expect(service.proposeShortlist({ tenantId: TENANT, requisitionId: 13, scope: MANAGER })).rejects.toMatchObject({ status: 404 });
        await expect(service.proposeShortlist({ tenantId: TENANT, requisitionId: 12, scope: INTERVIEWER })).rejects.toMatchObject({ status: 404 });
    });
});

describe("confirm / dismiss a proposal", () => {
    it("confirming turns the proposal into a MANUAL entry with the actor", async () => {
        db.shortlistEntry.updateMany.mockResolvedValue({ count: 1 });
        const result = await service.confirmShortlistProposal({ tenantId: TENANT, applicationId: 900, actorId: 5, scope: ORG, now: NOW });
        expect(result).toEqual({ applicationId: 900, confirmed: true, source: "MANUAL", addedById: 5 });
        expect(db.shortlistEntry.updateMany).toHaveBeenCalledWith({
            where: { tenantId: TENANT, applicationId: 900, source: "SCORING_PROPOSAL" },
            data: { source: "MANUAL", addedById: 5, addedAt: NOW },
        });
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ employeeId: 5, tenantId: TENANT }));
    });

    it("a manager confirms only on their own requisition; a missing proposal is 404", async () => {
        db.shortlistEntry.updateMany.mockResolvedValue({ count: 0 });
        await expect(
            service.confirmShortlistProposal({ tenantId: TENANT, applicationId: 900, actorId: 42, scope: MANAGER }),
        ).rejects.toMatchObject({ status: 404, code: "HR-RECRUITMENT-SHORTLIST-PROPOSAL-NOT-FOUND" });
        expect(db.shortlistEntry.updateMany.mock.calls[0][0].where).toEqual({
            tenantId: TENANT,
            applicationId: 900,
            source: "SCORING_PROPOSAL",
            application: { jobRequisition: { OR: [{ requestedById: 42 }, { approvedById: 42 }] } },
        });
        await expect(
            service.confirmShortlistProposal({ tenantId: TENANT, applicationId: 900, scope: INTERVIEWER }),
        ).rejects.toMatchObject({ status: 404 });
    });

    it("dismissing deletes only a proposal, never a MANUAL entry", async () => {
        db.shortlistEntry.deleteMany.mockResolvedValue({ count: 1 });
        const result = await service.dismissShortlistProposal({ tenantId: TENANT, applicationId: 900, actorId: 5, scope: ORG });
        expect(result).toEqual({ applicationId: 900, dismissed: true });
        expect(db.shortlistEntry.deleteMany).toHaveBeenCalledWith({
            where: { tenantId: TENANT, applicationId: 900, source: "SCORING_PROPOSAL" },
        });
        // The score's shortlistProposedAt is left alone, so it is not proposed again.
        expect(db.applicationScore.updateMany).not.toHaveBeenCalled();
    });
});

// ── Reads ────────────────────────────────────────────────────────────────────
describe("getApplicationScore", () => {
    it("returns the score and its explained components under the caller's scope", async () => {
        const stored = { applicationId: 900, requisitionId: 12, candidateId: 77, score: 81, band: "STRONG", modelVersion: "fit-v1", components: assessed, computedAt: NOW, shortlistProposedAt: null };
        db.application.findFirst.mockResolvedValue({ id: 900, score: stored });
        const result = await service.getApplicationScore({ tenantId: TENANT, applicationId: 900, scope: MANAGER });
        expect(result).toEqual(stored);
        expect(db.application.findFirst.mock.calls[0][0].where).toEqual({
            id: 900,
            tenantId: TENANT,
            AND: [{ jobRequisition: { OR: [{ requestedById: 42 }, { approvedById: 42 }] } }],
        });
    });

    it("an unscored or out-of-scope application is 404, and interviewers never see a score", async () => {
        db.application.findFirst.mockResolvedValue({ id: 900, score: null });
        await expect(service.getApplicationScore({ tenantId: TENANT, applicationId: 900, scope: ORG })).rejects.toMatchObject({ status: 404 });
        db.application.findFirst.mockClear();
        await expect(service.getApplicationScore({ tenantId: TENANT, applicationId: 900, scope: INTERVIEWER })).rejects.toMatchObject({ status: 404 });
        expect(db.application.findFirst).not.toHaveBeenCalled();
    });
});

describe("listRequisitionRanking", () => {
    const row = (applicationId, score, appliedAt, extra = {}) => ({
        applicationId,
        score,
        band: score >= 80 ? "STRONG" : "FAIR",
        modelVersion: "fit-v1",
        computedAt: NOW,
        shortlistProposedAt: null,
        application: {
            stage: "screening",
            appliedAt,
            knockedOut: false,
            candidate: { id: applicationId + 1000, firstName: "Ayesha", lastName: "Malik" },
            shortlist: [],
        },
        ...extra,
    });

    it("ranks by score desc then appliedAt asc, paginated, with the candidate's display name", async () => {
        db.applicationScore.count.mockResolvedValue(3);
        db.applicationScore.findMany.mockResolvedValue([
            row(903, 60, NOW, { application: { ...row(903, 60, NOW).application, shortlist: [{ source: "SCORING_PROPOSAL" }] } }),
        ]);
        const result = await service.listRequisitionRanking({ tenantId: TENANT, requisitionId: 12, scope: MANAGER, page: 2, pageSize: 2 });

        const query = db.applicationScore.findMany.mock.calls[0][0];
        expect(query.orderBy).toEqual([{ score: "desc" }, { application: { appliedAt: "asc" } }, { applicationId: "asc" }]);
        expect(query.skip).toBe(2);
        expect(query.take).toBe(2);
        expect(query.where).toEqual({
            requisitionId: 12,
            tenantId: TENANT,
            application: {
                stage: { notIn: ["hired", "rejected", "withdrawn"] },
                jobRequisition: { OR: [{ requestedById: 42 }, { approvedById: 42 }] },
            },
        });
        expect(result).toMatchObject({ total: 3, page: 2, pageSize: 2 });
        expect(result.items[0]).toMatchObject({
            rank: 3,
            applicationId: 903,
            candidateId: 1903,
            candidateName: "Ayesha Malik",
            band: "FAIR",
            shortlist: { source: "SCORING_PROPOSAL" },
        });
        expect(result.items[0]).not.toHaveProperty("email");
    });

    it("a requisition outside the manager's scope is 404; interviewers get 404 without a query", async () => {
        db.jobRequisition.findFirst.mockResolvedValue(null);
        await expect(service.listRequisitionRanking({ tenantId: TENANT, requisitionId: 99, scope: MANAGER })).rejects.toMatchObject({ status: 404 });
        expect(db.applicationScore.findMany).not.toHaveBeenCalled();
        db.jobRequisition.findFirst.mockClear();
        await expect(service.listRequisitionRanking({ tenantId: TENANT, requisitionId: 12, scope: INTERVIEWER })).rejects.toMatchObject({ status: 404 });
        expect(db.jobRequisition.findFirst).not.toHaveBeenCalled();
    });
});

describe("assertScoringEnabled", () => {
    it("is a 503 HR-RECRUITMENT-SCORING-DISABLED while the flag is off", () => {
        expect(() => service.assertScoringEnabled()).toThrow(expect.objectContaining({ status: 503, code: "HR-RECRUITMENT-SCORING-DISABLED" }));
        process.env.HR_RECRUITMENT_SCORING = "true";
        expect(() => service.assertScoringEnabled()).not.toThrow();
    });
});

it("scores the sample application deterministically (sanity on the shared formula)", () => {
    const inputs = service.buildFitInputs(APPLICATION);
    expect(computeFitScore(inputs).inputsHash).toBe(computeFitScore(inputs).inputsHash);
});
