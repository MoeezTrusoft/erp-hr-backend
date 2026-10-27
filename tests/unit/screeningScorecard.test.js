// tests/unit/screeningScorecard.test.js
//
// FR-07 residue — the two gaps this closes:
//   1. NUMERIC SCREENING SCORECARDS: when a scorecard template resolves for the
//      application's requisition, required criteria must be present and a
//      criterion the template marks numeric must carry a number; the overall is
//      computed with the same math the interview scorecard uses. No template →
//      free-form, byte-identical to before.
//   2. SHORTLIST ROW-LEVEL ACL: the requisition must be visible under the
//      caller's scope (404 otherwise, never a partial list) and candidate PII is
//      masked for scopes that may not see it.
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const prisma = {
    employee: { findMany: jest.fn(async () => [{ id: 5, userId: 15, employee_code: "REC-5", status: "Active" }]) },
    $queryRawUnsafe: jest.fn(async () => []),
    application: { findFirst: jest.fn() },
    applicationScreening: { create: jest.fn() },
    jobRequisition: { findFirst: jest.fn() },
    shortlistEntry: { findMany: jest.fn() },
    scorecardTemplateLink: { findMany: jest.fn(async () => []) },
    dispositionReasonCode: { findMany: jest.fn(), createMany: jest.fn(), create: jest.fn() },
};
const logAction = jest.fn(async () => undefined);

jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction }));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({ tenantTransaction: (c, fn) => fn(c) }));

const actualService = await import("../../src/services/applicationScreening.service.js");
const { mcpCtx } = await import("../../src/mcp/context.js");
const asRole = (role, fn) => mcpCtx.run({ actorVerified: true, user: { tenantId: "t-1", userId: 15, roles: [role] }, permissions: ["hr.recruitment.read", "hr.recruitment.update"] }, fn);
const service = {
    recordScreening: (args) => asRole("RECRUITER", () => actualService.recordScreening(args)),
    listShortlist: (id, tenant, scope) => asRole(scope === MANAGED_SCOPE ? "HIRING_MANAGER" : "RECRUITER", () => actualService.listShortlist(id, tenant, scope)),
};
const { validateScreeningAgainstTemplate } = await import("../../src/lib/scorecardTemplates.js");
const { validateCriteria } = await import("../../src/lib/dispositionReasons.js");

// A RESOLVED scope object (the shape services receive), not the level enum:
// `unrestricted` drives the where-clause and `canSeeInternalNotes` the masking.
const ORG_SCOPE = { level: "ORG", employeeId: 5, unrestricted: true, canSeeInternalNotes: true, canSeeCompensation: true };
const MANAGED_SCOPE = { level: "MANAGED", employeeId: 5, unrestricted: false, canSeeInternalNotes: false, canSeeCompensation: false };

const numericTemplate = {
    id: 7,
    criteria: [
        { key: "years_experience", label: "Years", weight: null, required: true, numeric: true },
        { key: "communication", label: "Comms", weight: null, required: true, numeric: false },
        { key: "portfolio", label: "Portfolio", weight: null, required: false, numeric: false },
    ],
};

beforeEach(() => {
    jest.clearAllMocks();
    prisma.scorecardTemplateLink.findMany.mockResolvedValue([]);
    prisma.application.findFirst.mockResolvedValue({ id: 900, stage: "screening" });
    prisma.dispositionReasonCode.findMany.mockResolvedValue([{ code: "OTHER", requiresNotes: true, version: 1 }]);
    prisma.dispositionReasonCode.createMany.mockResolvedValue({ count: 1 });
});

describe("FR-07 — numeric screening scorecards (pure)", () => {
    it("validateCriteria normalizes a numeric score and refuses garbage", () => {
        const ok = validateCriteria([{ criterion: "years_experience", result: "PASS", score: "5" }]);
        expect(ok.ok).toBe(true);
        expect(ok.normalized[0].score).toBe(5);

        const bad = validateCriteria([{ criterion: "years_experience", result: "PASS", score: "many" }]);
        expect(bad.ok).toBe(false);
        expect(bad.errors.join(" ")).toMatch(/score must be a finite number/);
    });

    it("a template-required numeric criterion with no score fails; with a score it computes the overall", () => {
        // The criterion is BOTH required and numeric: absent entirely.
        const absent = validateScreeningAgainstTemplate({
            criteria: [{ criterion: "communication", result: "PASS" }],
            templateCriteria: numericTemplate.criteria,
        });
        expect(absent.ok).toBe(false);
        expect(absent.missing).toContain("years_experience");

        // Present as a verdict but with NO number — the numeric half of the rule.
        const noNumber = validateScreeningAgainstTemplate({
            criteria: [
                { criterion: "years_experience", result: "PASS" },
                { criterion: "communication", result: "PASS" },
            ],
            templateCriteria: numericTemplate.criteria,
        });
        expect(noNumber.ok).toBe(false);
        expect(noNumber.errors.join(" ")).toMatch(/years_experience.*requires a numeric score/);

        const ok = validateScreeningAgainstTemplate({
            criteria: [
                { criterion: "years_experience", result: "PASS", score: 5 },
                { criterion: "communication", result: "PASS" },
            ],
            templateCriteria: numericTemplate.criteria,
        });
        expect(ok.ok).toBe(true);
        expect(ok.overall).toBe(5); // equal weighting: the one scored criterion
        expect(ok.missing).toEqual([]);
    });

    it("reports missing required criteria and unknown keys without dropping them", () => {
        const verdict = validateScreeningAgainstTemplate({
            criteria: [
                { criterion: "communication", result: "PASS" },
                { criterion: "typo_key", result: "PASS" },
            ],
            templateCriteria: numericTemplate.criteria,
        });
        expect(verdict.missing).toEqual(["years_experience"]);
        expect(verdict.unknown).toEqual(["typo_key"]);
        expect(verdict.ok).toBe(false);
    });

    it("a weight-differing template produces a weighted overall", () => {
        const verdict = validateScreeningAgainstTemplate({
            criteria: [
                { criterion: "a", result: "PASS", score: 10 },
                { criterion: "b", result: "PASS", score: 0 },
            ],
            templateCriteria: [
                { key: "a", weight: 3, required: true, numeric: true },
                { key: "b", weight: 1, required: true, numeric: true },
            ],
        });
        expect(verdict.weighted).toBe(true);
        expect(verdict.overall).toBe(7.5); // (10*3 + 0*1) / 4
    });
});

describe("FR-07 — the service halves", () => {
    it("no linked template keeps criteria free-form (no overall, no templateId)", async () => {
        prisma.applicationScreening.create.mockResolvedValue({ id: 1 });
        await service.recordScreening({ applicationId: 900, tenantId: "t-1", outcome: "ADVANCE", criteria: [{ criterion: "x", result: "PASS" }] });
        const data = prisma.applicationScreening.create.mock.calls[0][0].data;
        expect(data.scoreOverall).toBeNull();
        expect(data.templateId).toBeNull();
    });

    it("a linked template is enforced and its overall stored", async () => {
        prisma.scorecardTemplateLink.findMany.mockResolvedValue([
            { scopeType: "REQUISITION", scopeId: 42, scopeKey: null, template: { id: 7, name: "Screen", criteria: numericTemplate.criteria, isActive: true } },
        ]);
        prisma.application.findFirst.mockResolvedValue({ id: 900, stage: "screening", jobRequisition: { id: 42, positionId: null } });
        prisma.applicationScreening.create.mockResolvedValue({ id: 2 });

        await service.recordScreening({
            applicationId: 900,
            tenantId: "t-1",
            outcome: "ADVANCE",
            criteria: [
                { criterion: "years_experience", result: "PASS", score: 6 },
                { criterion: "communication", result: "PASS" },
            ],
        });
        const data = prisma.applicationScreening.create.mock.calls[0][0].data;
        expect(data.templateId).toBe(7);
        expect(data.scoreOverall).toBe(6);
    });

    it("a linked template REFUSES a submission with a missing required numeric score", async () => {
        prisma.scorecardTemplateLink.findMany.mockResolvedValue([
            { scopeType: "REQUISITION", scopeId: 42, scopeKey: null, template: { id: 7, name: "Screen", criteria: numericTemplate.criteria, isActive: true } },
        ]);
        prisma.application.findFirst.mockResolvedValue({ id: 900, stage: "screening", jobRequisition: { id: 42, positionId: null } });

        await expect(
            service.recordScreening({ applicationId: 900, tenantId: "t-1", outcome: "ADVANCE", criteria: [{ criterion: "communication", result: "PASS" }] })
        ).rejects.toMatchObject({ status: 400 });
        expect(prisma.applicationScreening.create).not.toHaveBeenCalled();
    });

    it("the shortlist refuses an unscopable requisition with 404 (never a partial list)", async () => {
        prisma.jobRequisition.findFirst.mockResolvedValue(null);
        await expect(service.listShortlist(42, "t-1", MANAGED_SCOPE)).rejects.toMatchObject({ status: 404 });
        expect(prisma.shortlistEntry.findMany).not.toHaveBeenCalled();
    });

    it("the shortlist applies the scope's candidate masking (internal notes) and leaves ORG untouched", async () => {
        prisma.jobRequisition.findFirst.mockResolvedValue({ id: 42 });
        const row = {
            id: 1,
            application: {
                id: 900,
                stage: "screening",
                status: "ACTIVE",
                candidate: { id: 5, firstName: "Ada", lastName: "L", notes: "recruiter-only observation" },
            },
        };
        prisma.shortlistEntry.findMany.mockResolvedValue([row]);

        const managed = await service.listShortlist(42, "t-1", MANAGED_SCOPE);
        expect(managed[0].application.candidate.notes).toBeNull();
        expect(managed[0].application.candidate.notesRedacted).toBe(true);

        const org = await service.listShortlist(42, "t-1", ORG_SCOPE);
        expect(org[0].application.candidate.notes).toBe("recruiter-only observation");
    });
});
