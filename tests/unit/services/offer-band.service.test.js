// tests/unit/services/offer-band.service.test.js
//
// Recruitment Phase 3a — the grade band warning on offer drafting.
//
// Pinned: the band comes from the requisition's grade (or its position's band
// label); a salary outside it is a warning, never a block; a band in another
// currency is not compared; the warnings (which carry band figures) reach only
// callers who may see compensation; a failed lookup never fails the create.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const TENANT = "11111111-1111-4111-8111-111111111111";

const prisma = {
    offer: { create: jest.fn(), findFirst: jest.fn() },
    candidate: { findFirst: jest.fn(async () => ({ id: 5 })) },
    jobRequisition: { findFirst: jest.fn() },
    gradeLevel: { findFirst: jest.fn() },
    $transaction: jest.fn(async (fn) => await fn(prisma)),
};
const mockTransition = jest.fn(async () => ({ success: true }));

jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/lib/rlsTenant.js", () => ({
    tenantTransaction: jest.fn(async (_client, fn) => await fn(prisma)),
    rlsTenantExtension: jest.fn((client) => client),
}));
jest.unstable_mockModule("../../../src/services/dam.media.service.js", () => ({ uploadFileToDAM: jest.fn(), deleteDamAsset: jest.fn() }));
jest.unstable_mockModule("../../../src/services/applicationWorkflow.service.js", () => ({
    transitionApplicationStageInTransaction: mockTransition,
    transitionApplicationStage: jest.fn(),
}));
jest.unstable_mockModule("../../../src/services/recruitmentHandoff.service.js", () => ({ runOfferHandoff: jest.fn(), getOfferHandoff: jest.fn() }));
jest.unstable_mockModule("../../../src/services/candidatePrivacy.service.js", () => ({ assertCommunicationsAllowed: jest.fn() }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent: jest.fn(async () => null) }));

const { compareSalaryToBand, checkOfferSalaryBand, createOfferFull, resolveRequisitionBand } = await import("../../../src/services/offerMgmt.service.js");
const { createOffer } = await import("../../../src/services/offer.service.js");

const BAND = { id: 3, name: "G5", minSalary: "100000.0000", maxSalary: "150000.0000", bandCurrency: "PKR" };

const fullInput = (over = {}) => ({ applicationId: 1, candidateId: 5, jobRequisitionId: 4, baseSalary: 90000, currency: "PKR", ...over });
const offerRow = { id: 9, applicationId: 1, candidateId: 5, jobRequisitionId: 4, salary: 90000, currency: "PKR", status: "DRAFT", tenantId: TENANT };

beforeEach(() => {
    jest.clearAllMocks();
    prisma.jobRequisition.findFirst.mockImplementation(async ({ select }) =>
        select?.gradeLevelId ? { id: 4, gradeLevelId: 3, position: null } : { id: 4 },
    );
    prisma.gradeLevel.findFirst.mockResolvedValue({ ...BAND });
    prisma.offer.create.mockResolvedValue({ ...offerRow });
    prisma.offer.findFirst.mockResolvedValue({ ...offerRow, candidate: { firstName: "A" }, jobRequisition: { title: "Eng" } });
});

describe("compareSalaryToBand", () => {
    const band = { min: 100, max: 150, currency: "PKR" };
    it("warns below and above, not inside or on the edges", () => {
        expect(compareSalaryToBand(90, "PKR", band).warnings).toEqual([{ code: "SALARY_BELOW_BAND", min: 100, max: 150 }]);
        expect(compareSalaryToBand(151, "pkr", band).warnings).toEqual([{ code: "SALARY_ABOVE_BAND", min: 100, max: 150 }]);
        expect(compareSalaryToBand(100, "PKR", band).warnings).toEqual([]);
        expect(compareSalaryToBand(150, "PKR", band)).toMatchObject({ comparable: true, warnings: [] });
    });
    it("handles a one-sided band, no band, and another currency", () => {
        expect(compareSalaryToBand(90, null, { min: 100, max: null, currency: null }).warnings).toEqual([{ code: "SALARY_BELOW_BAND", min: 100, max: null }]);
        expect(compareSalaryToBand(90, "PKR", null)).toMatchObject({ hasBand: false, comparable: false, reason: "NO_BAND", warnings: [] });
        expect(compareSalaryToBand(90, "USD", band)).toMatchObject({ hasBand: true, comparable: false, reason: "CURRENCY_MISMATCH", warnings: [] });
    });
});

describe("resolveRequisitionBand", () => {
    it("reads the requisition's grade, tenant-scoped", async () => {
        expect(await resolveRequisitionBand({ tenantId: TENANT, jobRequisitionId: 4 })).toEqual({
            gradeLevelId: 3, gradeName: "G5", min: 100000, max: 150000, currency: "PKR",
        });
        expect(prisma.gradeLevel.findFirst.mock.calls[0][0].where).toEqual({ id: 3, tenantId: TENANT });
    });
    it("falls back to the position's band label, and reports no band for a grade without figures", async () => {
        prisma.jobRequisition.findFirst.mockResolvedValue({ id: 4, gradeLevelId: null, position: { band: "G5" } });
        await resolveRequisitionBand({ tenantId: TENANT, jobRequisitionId: 4 });
        expect(prisma.gradeLevel.findFirst.mock.calls[0][0].where).toEqual({ name: "G5", tenantId: TENANT });

        prisma.gradeLevel.findFirst.mockResolvedValue({ ...BAND, minSalary: null, maxSalary: null });
        expect(await resolveRequisitionBand({ tenantId: TENANT, jobRequisitionId: 4 })).toBeNull();
    });
    it("tells a missing requisition apart from a missing band", async () => {
        prisma.jobRequisition.findFirst.mockResolvedValue(null);
        expect(await checkOfferSalaryBand({ tenantId: TENANT, jobRequisitionId: 4, salary: 1 })).toMatchObject({ requisitionFound: false, band: null });
    });
});

describe("createOfferFull warnings", () => {
    it("returns the warning to a caller who may see compensation, and still creates the draft", async () => {
        const result = await createOfferFull(fullInput(), { tenantId: TENANT, showSensitive: true });
        expect(prisma.offer.create).toHaveBeenCalledTimes(1);
        expect(result.warnings).toEqual([{ code: "SALARY_BELOW_BAND", min: 100000, max: 150000 }]);
        expect(result.offerId).toBe(9);
    });
    it("redacts the warning for a caller who may not", async () => {
        const result = await createOfferFull(fullInput(), { tenantId: TENANT, showSensitive: false });
        expect(result).toMatchObject({ warnings: [], warningsRedacted: true });
    });
    it("never fails the create when the band lookup fails", async () => {
        prisma.gradeLevel.findFirst.mockRejectedValue(new Error("db down"));
        const result = await createOfferFull(fullInput(), { tenantId: TENANT, showSensitive: true });
        expect(result.warnings).toEqual([]);
        expect(result.offerId).toBe(9);
    });
});

describe("createOffer warnings", () => {
    const args = { applicationId: null, candidateId: 5, jobRequisitionId: 4, salary: 200000, currency: "PKR", tenantId: TENANT };
    it("returns the warning to existing callers (they already receive the salary)", async () => {
        const result = await createOffer(args);
        expect(result.warnings).toEqual([{ code: "SALARY_ABOVE_BAND", min: 100000, max: 150000 }]);
        expect(result.id).toBe(9);
    });
    it("redacts it for a scope that may not see compensation, and shows it to one that may", async () => {
        const managed = await createOffer({ ...args, scope: { level: "MANAGED", canSeeCompensation: false } });
        expect(managed).toMatchObject({ warnings: [], warningsRedacted: true });
        const finance = await createOffer({ ...args, scope: { level: "FINANCE", canSeeCompensation: true } });
        expect(finance.warnings).toHaveLength(1);
    });
    it("no band, no warning", async () => {
        prisma.jobRequisition.findFirst.mockImplementation(async ({ select }) => (select?.gradeLevelId ? { id: 4, gradeLevelId: null, position: null } : { id: 4 }));
        expect((await createOffer(args)).warnings).toEqual([]);
    });
});

describe("getOfferManage detail (Phase 3a panel)", () => {
    it("carries the version for If-Match and the employee category for e-signature", async () => {
        const { getOfferManage } = await import("../../../src/services/offerMgmt.service.js");
        prisma.offer.findFirst.mockResolvedValue({ ...offerRow, version: 4, employeeCategory: "PERMANENT", candidate: { firstName: "A", lastName: "K" }, jobRequisition: { title: "Engineer" } });
        await expect(getOfferManage(9, { tenantId: TENANT })).resolves.toMatchObject({ version: 4, employeeCategory: "PERMANENT" });
        prisma.offer.findFirst.mockResolvedValue({ ...offerRow, candidate: null, jobRequisition: null });
        await expect(getOfferManage(9, { tenantId: TENANT })).resolves.toMatchObject({ version: 0, employeeCategory: null });
    });
});
