// Recruitment Phase 7 (C12a) — getRetentionPolicyView: the stored policy per
// population, else the default the nightly run uses (no policy, so no clock:
// retentionMonths null) flagged isDefault, always inside the caller's tenant.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: {} }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn() }));
jest.unstable_mockModule("../../../src/services/dam.media.service.js", () => ({ deleteDamAsset: jest.fn() }));

const { getRetentionPolicyView, DEFAULT_RETENTION_POLICY, computeRetentionUntil } = await import("../../../src/services/candidate-privacy.service.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const stored = {
    id: 3,
    tenantId: TENANT,
    appliesTo: "APPLICANT",
    retentionMonths: 24,
    legalBasis: "Legitimate interest",
    isActive: true,
    createdById: 42,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-02-01T00:00:00.000Z"),
};

let db;
beforeEach(() => {
    db = { candidateRetentionPolicy: { findMany: jest.fn(async () => [stored]), findFirst: jest.fn(async () => null) } };
});

describe("getRetentionPolicyView", () => {
    it("returns the stored policy, and the default (isDefault) for a population with none", async () => {
        const out = await getRetentionPolicyView({ tenantId: TENANT }, { db });
        expect(db.candidateRetentionPolicy.findMany).toHaveBeenCalledWith({
            where: { tenantId: TENANT, appliesTo: { in: ["APPLICANT", "TALENT_POOL"] } },
        });
        expect(out.items).toEqual([
            {
                appliesTo: "APPLICANT", retentionMonths: 24, legalBasis: "Legitimate interest", isActive: true, isDefault: false,
                createdById: 42, createdAt: stored.created_at, updatedAt: stored.updated_at,
            },
            {
                appliesTo: "TALENT_POOL", retentionMonths: null, legalBasis: null, isActive: false, isDefault: true,
                createdById: null, createdAt: null, updatedAt: null,
            },
        ]);
    });

    it("the default is what the run uses: no policy means no clock", async () => {
        expect(DEFAULT_RETENTION_POLICY).toEqual({ retentionMonths: null, legalBasis: null, isActive: false });
        // computeRetentionUntil (the clock stamp) reads null with no policy stored.
        expect(await computeRetentionUntil({ tenantId: TENANT, appliesTo: "TALENT_POOL" }, { db })).toBeNull();
    });

    it("narrows to one population", async () => {
        db.candidateRetentionPolicy.findMany.mockResolvedValueOnce([]);
        const out = await getRetentionPolicyView({ tenantId: TENANT, appliesTo: "TALENT_POOL" }, { db });
        expect(db.candidateRetentionPolicy.findMany).toHaveBeenCalledWith({ where: { tenantId: TENANT, appliesTo: { in: ["TALENT_POOL"] } } });
        expect(out.items).toHaveLength(1);
        expect(out.items[0]).toMatchObject({ appliesTo: "TALENT_POOL", isDefault: true });
    });

    it("returns a stored but inactive row as stored, with isActive false", async () => {
        db.candidateRetentionPolicy.findMany.mockResolvedValueOnce([{ ...stored, isActive: false }]);
        const out = await getRetentionPolicyView({ tenantId: TENANT, appliesTo: "APPLICANT" }, { db });
        expect(out.items[0]).toMatchObject({ retentionMonths: 24, isActive: false, isDefault: false });
    });

    it("refuses an unknown population and a missing tenant before any read", async () => {
        await expect(getRetentionPolicyView({ tenantId: TENANT, appliesTo: "EMPLOYEE" }, { db }))
            .rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-RETENTION-POPULATION-INVALID" });
        await expect(getRetentionPolicyView({}, { db })).rejects.toMatchObject({ code: "HR-TENANT-REQUIRED" });
        expect(db.candidateRetentionPolicy.findMany).not.toHaveBeenCalled();
    });
});
