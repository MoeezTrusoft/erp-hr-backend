// tests/unit/scorecardTemplates.test.js
//
// Phase 7 / decision record §5.5–5.5b — scorecard templates:
//
//   * §5.5a weights are optional but ALL-OR-NONE; equal weighting is the
//     default and computes exactly like the pre-template average
//   * §5.5b required criteria refuse a submission (with the missing keys);
//     invented criteria refuse too
//   * §5.5c is deliberately absent here — locking lives in the Phase 3.4
//     amendment path, and template edits never touch submitted scorecards
//   * resolution is most-specific-first: REQUISITION → STAGE → JOB_FAMILY
//   * the write choke point applies the template's overall, not the caller's

import { describe, it, expect, jest, beforeEach } from "@jest/globals";

import {
    TEMPLATE_SCOPES,
    validateCriteria,
    isWeighted,
    computeOverall,
    checkRequiredCriteria,
    resolveTemplate,
} from "../../src/lib/scorecardTemplates.js";

// ── the pure lib ─────────────────────────────────────────────────────────────

describe("scorecardTemplates.validateCriteria", () => {
    it("accepts an ordered criteria list and defaults required=true", () => {
        const r = validateCriteria([{ key: "technicalSkills", label: "Technical skills" }]);
        expect(r.ok).toBe(true);
        expect(r.criteria[0]).toMatchObject({ key: "technicalSkills", label: "Technical skills", weight: null, required: true });
    });

    it("refuses empty lists, blank keys and duplicate keys", () => {
        expect(validateCriteria([]).ok).toBe(false);
        expect(validateCriteria([{ key: "  " }]).ok).toBe(false);
        expect(validateCriteria([{ key: "a" }, { key: "a" }]).ok).toBe(false);
    });

    it("refuses non-positive or non-numeric weights", () => {
        expect(validateCriteria([{ key: "a", weight: 0 }]).ok).toBe(false);
        expect(validateCriteria([{ key: "a", weight: -1 }]).ok).toBe(false);
        expect(validateCriteria([{ key: "a", weight: "high" }]).ok).toBe(false);
    });

    it("weights are ALL-OR-NONE (§5.5a) — a partial mix refuses", () => {
        expect(validateCriteria([{ key: "a", weight: 2 }, { key: "b" }]).ok).toBe(false);
        expect(validateCriteria([{ key: "a", weight: 2 }, { key: "b", weight: 1 }]).ok).toBe(true);
        expect(validateCriteria([{ key: "a" }, { key: "b" }]).ok).toBe(true);
    });
});

describe("scorecardTemplates.computeOverall (§5.5a)", () => {
    it("equal weighting is the default and matches the plain average", () => {
        const criteria = [{ key: "a" }, { key: "b" }, { key: "c" }];
        expect(isWeighted(criteria)).toBe(false);
        expect(computeOverall(criteria, { a: 3, b: 4, c: 5 })).toEqual({ overall: 4, weighted: false });
    });

    it("weighted overall = sum(v×w)/sum(w)", () => {
        const criteria = [
            { key: "a", weight: 3 },
            { key: "b", weight: 1 },
        ];
        // (5×3 + 2×1) / 4 = 4.25
        expect(computeOverall(criteria, { a: 5, b: 2 })).toEqual({ overall: 4.25, weighted: true });
    });

    it("an unanswered OPTIONAL criterion drops out of numerator AND denominator", () => {
        const criteria = [
            { key: "a", weight: 3, required: true },
            { key: "b", weight: 1, required: false },
        ];
        // Only `a` answered: (5×3)/3 = 5 — not (5×3)/4 = 3.75.
        expect(computeOverall(criteria, { a: 5 })).toEqual({ overall: 5, weighted: true });
    });

    it("no numeric submissions → null overall", () => {
        expect(computeOverall([{ key: "a" }], {}).overall).toBeNull();
        expect(computeOverall([{ key: "a" }], { a: "nonsense" }).overall).toBeNull();
    });
});

describe("scorecardTemplates.checkRequiredCriteria (§5.5b)", () => {
    const criteria = [
        { key: "a", required: true },
        { key: "b", required: false },
    ];

    it("a missing required criterion is reported", () => {
        expect(checkRequiredCriteria(criteria, { b: 4 })).toEqual({ missing: ["a"], unknown: [] });
    });

    it("an empty string counts as missing", () => {
        expect(checkRequiredCriteria(criteria, { a: "", b: 4 }).missing).toEqual(["a"]);
    });

    it("optional criteria may be skipped; unknown keys surface separately", () => {
        expect(checkRequiredCriteria(criteria, { a: 3 })).toEqual({ missing: [], unknown: [] });
        expect(checkRequiredCriteria(criteria, { a: 3, typo: 1 })).toEqual({ missing: [], unknown: ["typo"] });
    });
});

describe("scorecardTemplates.resolveTemplate (§5.5)", () => {
    const mk = (id, scopeType, scopeId = null, scopeKey = null) => ({
        scopeType,
        scopeId,
        scopeKey,
        template: { id, name: `T${id}`, criteria: [{ key: "a" }] },
    });
    const ctx = { jobRequisitionId: 42, positionId: 7, interviewType: "TECHNICAL" };

    it("scopes are the closed vocabulary", () => {
        expect(TEMPLATE_SCOPES).toEqual(["REQUISITION", "STAGE", "JOB_FAMILY"]);
    });

    it("REQUISITION beats STAGE beats JOB_FAMILY", () => {
        const links = [mk(1, "JOB_FAMILY", 7), mk(2, "STAGE", null, "TECHNICAL"), mk(3, "REQUISITION", 42)];
        expect(resolveTemplate(links, ctx).id).toBe(3);
        expect(resolveTemplate(links.slice(0, 2), ctx).id).toBe(2);
        expect(resolveTemplate(links.slice(0, 1), ctx).id).toBe(1);
    });

    it("no match → null (free-form scoring survives)", () => {
        expect(resolveTemplate([mk(1, "REQUISITION", 999)], ctx)).toBeNull();
        expect(resolveTemplate([], ctx)).toBeNull();
    });

    it("same-scope ties resolve deterministically to the lowest template id", () => {
        expect(resolveTemplate([mk(9, "STAGE", null, "TECHNICAL"), mk(4, "STAGE", null, "TECHNICAL")], ctx).id).toBe(4);
    });
});

// ── the service + the write choke point ─────────────────────────────────────

const prisma = {
    scorecardTemplate: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), delete: jest.fn(), findMany: jest.fn() },
    scorecardTemplateLink: { upsert: jest.fn(), findFirst: jest.fn(), deleteMany: jest.fn(), findMany: jest.fn() },
    interview: { findFirst: jest.fn() },
    interviewScorecard: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
};
const logAction = jest.fn(async () => undefined);

jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction }));
jest.unstable_mockModule("../../src/mcp/context.js", () => ({
    mcpCtx: { run: (ctx, fn) => fn(), getStore: () => ({ user: { tenantId: "t-1" } }) },
}));

const service = await import("../../src/services/scorecardTemplate.service.js");
const scorecardWriter = await import("../../src/services/interview-scorecard.service.js");

const tenant = "t-1";

beforeEach(() => {
    jest.clearAllMocks();
    logAction.mockResolvedValue(undefined);
});

describe("scorecardTemplate service (§5.5)", () => {
    it("creates a template with validated criteria and audits it", async () => {
        prisma.scorecardTemplate.create.mockResolvedValue({ id: 1, name: "Engineering", criteria: [{ key: "a" }] });

        const row = await service.createTemplate({ name: "Engineering", criteria: [{ key: "a" }], tenantId: tenant, actorId: 12 });
        expect(row.id).toBe(1);
        expect(prisma.scorecardTemplate.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ criteria: [{ key: "a", label: "a", weight: null, required: true }] }) }),
        );
        expect(logAction).toHaveBeenCalledTimes(1);
    });

    it("refuses mixed weights at creation", async () => {
        await expect(
            service.createTemplate({ name: "X", criteria: [{ key: "a", weight: 2 }, { key: "b" }], tenantId: tenant }),
        ).rejects.toMatchObject({ details: { code: "HR-RECRUITMENT-TEMPLATE-CRITERIA-INVALID" } });
        expect(prisma.scorecardTemplate.create).not.toHaveBeenCalled();
    });

    it("deactivates softly while links exist, hard-deletes when none do", async () => {
        prisma.scorecardTemplate.findFirst
            .mockResolvedValueOnce({ id: 1, name: "T", _count: { links: 2 } })
            .mockResolvedValueOnce({ id: 2, name: "Lone", _count: { links: 0 } });
        prisma.scorecardTemplate.update.mockResolvedValue({ id: 1, isActive: false });
        prisma.scorecardTemplate.delete.mockResolvedValue({ id: 2 });

        const soft = await service.deactivateTemplate({ templateId: 1, tenantId: tenant });
        expect(soft).toEqual({ id: 1, deleted: false, deactivated: true });
        const hard = await service.deactivateTemplate({ templateId: 2, tenantId: tenant });
        expect(hard).toEqual({ id: 2, deleted: true });
    });

    it("links validate the scope/address pairing", async () => {
        prisma.scorecardTemplate.findFirst.mockResolvedValue({ id: 1 });
        await expect(
            service.linkTemplate({ templateId: 1, scopeType: "REQUISITION", tenantId: tenant }),
        ).rejects.toMatchObject({ details: { code: "HR-RECRUITMENT-TEMPLATE-SCOPE-INVALID" } });
        await expect(
            service.linkTemplate({ templateId: 1, scopeType: "STAGE", tenantId: tenant }),
        ).rejects.toMatchObject({ details: { code: "HR-RECRUITMENT-TEMPLATE-SCOPE-INVALID" } });

        prisma.scorecardTemplateLink.upsert.mockResolvedValue({ id: 5 });
        const row = await service.linkTemplate({ templateId: 1, scopeType: "STAGE", scopeKey: "TECHNICAL", tenantId: tenant });
        expect(row.id).toBe(5);
    });

    it("validateSubmission refuses missing required criteria with their keys", () => {
        const template = { criteria: [{ key: "a", required: true }, { key: "b", required: false }] };
        expect(() => service.validateSubmission({ template, scores: { b: 4 } })).toThrow(
            expect.objectContaining({ details: expect.objectContaining({ code: "HR-RECRUITMENT-TEMPLATE-CRITERIA-MISSING", missingCriteria: ["a"] }) }),
        );
    });

    it("validateSubmission refuses criteria the template does not define", () => {
        const template = { criteria: [{ key: "a", required: true }] };
        expect(() => service.validateSubmission({ template, scores: { a: 3, zzz: 1 } })).toThrow(
            expect.objectContaining({ details: expect.objectContaining({ code: "HR-RECRUITMENT-TEMPLATE-CRITERIA-UNKNOWN" }) }),
        );
    });

    it("validateSubmission computes the template's weighted overall", () => {
        const template = { criteria: [{ key: "a", weight: 3 }, { key: "b", weight: 1 }] };
        expect(service.validateSubmission({ template, scores: { a: 5, b: 2 } })).toEqual({ overall: 4.25, weighted: true });
    });
});

describe("upsertInterviewScorecard × template (§5.5b enforcement)", () => {
    it("a governing template overrides the caller's overall with the weighted one", async () => {
        prisma.interview.findFirst.mockResolvedValue({
            interviewType: "TECHNICAL",
            application: { jobRequisition: { id: 42, positionId: 7 } },
        });
        prisma.scorecardTemplateLink.findMany.mockResolvedValue([
            {
                scopeType: "REQUISITION", scopeId: 42, scopeKey: null,
                template: { id: 1, name: "T", isActive: true, criteria: [{ key: "a", weight: 3 }, { key: "b", weight: 1 }] },
            },
        ]);
        prisma.interviewScorecard.findUnique.mockResolvedValue(null);
        prisma.interviewScorecard.create.mockImplementation(async ({ data }) => data);

        await scorecardWriter.upsertInterviewScorecard({
            interviewId: 500, reviewerId: 3,
            data: { scores: { a: 5, b: 2 }, overallScore: 99, submittedAt: new Date() },
            tenantId: tenant,
        });

        const written = prisma.interviewScorecard.create.mock.calls[0][0].data;
        // The caller claimed 99; the template says 4.25.
        expect(written.overallScore).toBeCloseTo(4.25);
    });

    it("a submission missing a required criterion refuses before any write", async () => {
        prisma.interview.findFirst.mockResolvedValue({
            interviewType: "TECHNICAL",
            application: { jobRequisition: { id: 42, positionId: 7 } },
        });
        prisma.scorecardTemplateLink.findMany.mockResolvedValue([
            {
                scopeType: "REQUISITION", scopeId: 42, scopeKey: null,
                template: { id: 1, name: "T", isActive: true, criteria: [{ key: "a", required: true }] },
            },
        ]);

        await expect(
            scorecardWriter.upsertInterviewScorecard({
                interviewId: 500, reviewerId: 3,
                data: { scores: {}, submittedAt: new Date() },
                tenantId: tenant,
            }),
        ).rejects.toMatchObject({ details: expect.objectContaining({ code: "HR-RECRUITMENT-TEMPLATE-CRITERIA-MISSING" }) });
        expect(prisma.interviewScorecard.create).not.toHaveBeenCalled();
        expect(prisma.interviewScorecard.update).not.toHaveBeenCalled();
    });

    it("no template → free-form scoring, untouched", async () => {
        prisma.interview.findFirst.mockResolvedValue({
            interviewType: "PHONE_SCREEN",
            application: { jobRequisition: { id: 43, positionId: null } },
        });
        prisma.scorecardTemplateLink.findMany.mockResolvedValue([]);
        prisma.interviewScorecard.findUnique.mockResolvedValue(null);
        prisma.interviewScorecard.create.mockImplementation(async ({ data }) => data);

        await scorecardWriter.upsertInterviewScorecard({
            interviewId: 501, reviewerId: 3,
            data: { scores: { anything: 2 }, overallScore: 2, submittedAt: new Date() },
            tenantId: tenant,
        });

        const written = prisma.interviewScorecard.create.mock.calls[0][0].data;
        expect(written.overallScore).toBe(2);
    });
});
