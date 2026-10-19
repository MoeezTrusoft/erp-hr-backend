// tests/unit/candidateMerge.service.test.js
//
// Phase 5 / FR-04.10 — the recruiter's duplicate-candidate MERGE. The rules
// pinned here are the ones a typo-recovery must never get wrong:
//
//   * fill-only-blanks: the SURVIVOR's identity wins, only empty fields are
//     filled from the duplicate;
//   * applications transfer except where the survivor already has one to the
//     same requisition — and a LIVE overlap refuses unless the caller
//     explicitly confirmed keep-target;
//   * consents / talent pool / skills / AI records / tokens re-point;
//   * the source is ARCHIVED (never deleted, never anonymized — the audit
//     chain survives) with a note naming the survivor;
//   * HARD refusals: self-merge, anonymized rows, unreleased legal holds,
//     and a foreign-tenant id reads as not-found (fail-closed).
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const TENANT = "11111111-1111-1111-1111-111111111111";

const rows = new Map();
const updateCalls = [];
const prisma = {
    candidate: {
        findFirst: jest.fn(async ({ where }) => rows.get(where.id) ?? null),
        update: jest.fn(async ({ where, data }) => {
            updateCalls.push({ id: where.id, data });
            const row = rows.get(where.id);
            Object.assign(row, { ...data, version: (row.version ?? 0) + 1 });
            return row;
        }),
    },
    candidateLegalHold: { findMany: jest.fn(async () => []) },
    application: {
        findMany: jest.fn(async () => []),
        updateMany: jest.fn(async () => ({ count: 0 })),
    },
    candidateConsent: { updateMany: jest.fn(async () => ({ count: 0 })) },
    talentPool: { updateMany: jest.fn(async () => ({ count: 0 })) },
    candidateSkill: { updateMany: jest.fn(async () => ({ count: 0 })) },
    aiInferenceRecord: { updateMany: jest.fn(async () => ({ count: 0 })) },
    candidateEmailVerification: { updateMany: jest.fn(async () => ({ count: 0 })) },
    candidateTag: {
        findMany: jest.fn(async () => []),
        createMany: jest.fn(async () => ({ count: 0 })),
    },
    $transaction: jest.fn(async (arg) => (typeof arg === "function" ? arg(prisma) : Promise.all(arg))),
};

jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
    tenantTransaction: jest.fn((client, fn) => fn(client)),
    rlsTenantExtension: jest.fn((client) => client),
}));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));

const { mergeCandidates } = await import("../../src/services/candidateMerge.service.js");

const seedPair = (sourceOverrides = {}, targetOverrides = {}) => {
    rows.clear();
    updateCalls.length = 0;
    rows.set(1, {
        id: 1, email: "typo@example.com", firstName: "Ayesha", lastName: "Malik",
        phone: "+923001111111", resumeMediaId: null, source: "PORTAL", notes: null,
        status: "active", anonymizedAt: null, tenantId: TENANT, version: 0,
        ...sourceOverrides,
    });
    rows.set(2, {
        id: 2, email: "ayesha@example.com", firstName: "Ayesha", lastName: "Malik",
        phone: null, resumeMediaId: 55, source: null, notes: "existing profile",
        status: "active", anonymizedAt: null, tenantId: TENANT, version: 3,
        ...targetOverrides,
    });
};

beforeEach(() => {
    jest.clearAllMocks();
    seedPair();
});

describe("Phase 5 / FR-04.10 — the candidate merge", () => {
    it("fills only blanks on the survivor and archives the source with a survivor note", async () => {
        const result = await mergeCandidates({ tenantId: TENANT, sourceId: 1, targetId: 2, actorId: 9 });

        expect(result.merged).toBe(true);
        const survivorUpdate = updateCalls.find((u) => u.id === 2);
        // phone was blank on the survivor → filled from the source;
        // resumeMediaId was set on the survivor → keeps ITS value (55), never
        // overwritten by the duplicate's.
        expect(survivorUpdate.data.phone).toBe("+923001111111");
        expect(survivorUpdate.data.resumeMediaId).toBe(55);
        // The source keeps its identity trail: archived, not deleted.
        const sourceUpdate = updateCalls.find((u) => u.id === 1);
        expect(sourceUpdate.data.status).toBe("archived");
        expect(sourceUpdate.data.archivedAt).toBeTruthy();
        expect(sourceUpdate.data.notes).toContain("#2");
    });

    it("transfers non-conflicting applications and keeps the ones the survivor already has", async () => {
        prisma.application.findMany
            .mockResolvedValueOnce([
                { id: 11, jobRequisitionId: 500, stage: "screening" },  // source: transferable
                { id: 12, jobRequisitionId: 600, stage: "rejected" },   // source: conflict (terminal)
            ])
            .mockResolvedValueOnce([{ id: 21, jobRequisitionId: 600, stage: "offer" }]); // survivor has 600

        const result = await mergeCandidates({ tenantId: TENANT, sourceId: 1, targetId: 2, actorId: 9 });

        expect(result.transferredApplicationIds).toEqual([11]);
        expect(result.keptOnSourceApplicationIds).toEqual([12]);
        expect(prisma.application.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: { candidateId: 2 } }),
        );
    });

    it("refuses a LIVE application overlap unless keep-target was explicitly confirmed", async () => {
        prisma.application.findMany
            .mockResolvedValueOnce([{ id: 12, jobRequisitionId: 600, stage: "screening" }])
            .mockResolvedValueOnce([{ id: 21, jobRequisitionId: 600, stage: "interview" }]);

        await expect(
            mergeCandidates({ tenantId: TENANT, sourceId: 1, targetId: 2, keepTargetOnConflict: false }),
        ).rejects.toMatchObject({ code: "HR-RECRUITMENT-MERGE-APPLICATION-CONFLICT" });

        // Confirmed: proceeds, the shared requisition's application stays on the source.
        prisma.application.findMany
            .mockResolvedValueOnce([{ id: 12, jobRequisitionId: 600, stage: "screening" }])
            .mockResolvedValueOnce([{ id: 21, jobRequisitionId: 600, stage: "interview" }]);
        const result = await mergeCandidates({ tenantId: TENANT, sourceId: 1, targetId: 2, keepTargetOnConflict: true });
        expect(result.keptOnSourceApplicationIds).toEqual([12]);
    });

    it("re-points consents, pool, skills, AI records and tokens; consumes the source's live status link", async () => {
        prisma.candidateTag.findMany.mockResolvedValueOnce([{ tagId: 7 }, { tagId: 8 }]);
        await mergeCandidates({ tenantId: TENANT, sourceId: 1, targetId: 2, actorId: 9 });

        for (const model of ["candidateConsent", "talentPool", "candidateSkill", "aiInferenceRecord"]) {
            expect(prisma[model].updateMany).toHaveBeenCalledWith(
                expect.objectContaining({ data: { candidateId: 2 } }),
            );
        }
        // The source's live status link is consumed BEFORE the re-point, so the
        // survivor's own link stays the only live one.
        expect(prisma.candidateEmailVerification.updateMany).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ where: expect.objectContaining({ purpose: "STATUS_LINK" }), data: expect.objectContaining({ consumedAt: expect.anything() }) }),
        );
        // Tags union into the survivor with skipDuplicates.
        expect(prisma.candidateTag.createMany).toHaveBeenCalledWith(
            expect.objectContaining({ skipDuplicates: true }),
        );
    });

    it("hard-refuses self-merge, anonymized rows and unreleased legal holds", async () => {
        await expect(
            mergeCandidates({ tenantId: TENANT, sourceId: 2, targetId: 2 }),
        ).rejects.toMatchObject({ code: "HR-RECRUITMENT-MERGE-SELF" });

        seedPair({}, { anonymizedAt: new Date() });
        await expect(
            mergeCandidates({ tenantId: TENANT, sourceId: 1, targetId: 2 }),
        ).rejects.toMatchObject({ code: "HR-RECRUITMENT-MERGE-ANONYMIZED" });

        seedPair();
        prisma.candidateLegalHold.findMany.mockResolvedValueOnce([{ candidateId: 1 }]);
        await expect(
            mergeCandidates({ tenantId: TENANT, sourceId: 1, targetId: 2 }),
        ).rejects.toMatchObject({ code: "HR-RECRUITMENT-MERGE-LEGAL-HOLD" });
    });

    it("a foreign-tenant id reads as not-found (fail-closed)", async () => {
        // findFirst is called with the scoped where; the mock honors id only, so
        // simulate the scoping by hiding both rows for a foreign tenant call.
        prisma.candidate.findFirst.mockImplementation(async ({ where }) =>
            where.tenantId === TENANT ? rows.get(where.id) ?? null : null,
        );
        await expect(
            mergeCandidates({ tenantId: "22222222-2222-2222-2222-222222222222", sourceId: 1, targetId: 2 }),
        ).rejects.toMatchObject({ code: "HR-RECRUITMENT-MERGE-NOT-FOUND" });
    });
});
