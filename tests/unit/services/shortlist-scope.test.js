// tests/unit/services/shortlist-scope.test.js
//
// Recruitment Phase 2 — the shortlist is scoped by recruitment scope on every
// read and write: a hiring manager cannot shortlist (or unshortlist) an
// application on someone else's requisition, and the list's rows carry the
// same predicate. A manual add over a pending fit-score proposal confirms it.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const prisma = {
    application: { findFirst: jest.fn() },
    jobRequisition: { findFirst: jest.fn() },
    shortlistEntry: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), deleteMany: jest.fn(), findMany: jest.fn() },
};

jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../../src/lib/rlsTenant.js", () => ({ tenantTransaction: (client, fn) => fn(client) }));

const service = await import("../../../src/services/application-screening.service.js");
const { resolveRecruitmentScope } = await import("../../../src/lib/recruitment-access.util.js");

const TENANT = "t-1";
const ORG = resolveRecruitmentScope({ roles: ["RECRUITER"], employeeId: 5 });
const MANAGER = resolveRecruitmentScope({ roles: ["HIRING_MANAGER"], employeeId: 42 });
const FINANCE = resolveRecruitmentScope({ roles: ["FINANCE"], employeeId: 9 });
const MANAGED_PREDICATE = { jobRequisition: { OR: [{ requestedById: 42 }, { approvedById: 42 }] } };

beforeEach(() => {
    jest.clearAllMocks();
    prisma.shortlistEntry.findUnique.mockResolvedValue(null);
    prisma.shortlistEntry.create.mockResolvedValue({ id: 1, applicationId: 900 });
});

describe("addToShortlist — scoped", () => {
    it("a manager's add is limited to applications on their own requisitions", async () => {
        prisma.application.findFirst.mockResolvedValue({ id: 900, jobRequisitionId: 12 });
        await service.addToShortlist({ applicationId: 900, tenantId: TENANT, actorId: 42, scope: MANAGER });
        expect(prisma.application.findFirst).toHaveBeenCalledWith({
            where: { id: 900, tenantId: TENANT, AND: [MANAGED_PREDICATE] },
            select: { id: true, jobRequisitionId: true },
        });
    });

    it("someone else's requisition reads as 404 and writes nothing", async () => {
        prisma.application.findFirst.mockResolvedValue(null);
        await expect(
            service.addToShortlist({ applicationId: 901, tenantId: TENANT, actorId: 42, scope: MANAGER }),
        ).rejects.toMatchObject({ status: 404 });
        expect(prisma.shortlistEntry.create).not.toHaveBeenCalled();
    });

    it("a scope that reaches no application can never match by id", async () => {
        prisma.application.findFirst.mockResolvedValue(null);
        await expect(service.addToShortlist({ applicationId: 900, tenantId: TENANT, scope: FINANCE })).rejects.toMatchObject({ status: 404 });
        expect(prisma.application.findFirst.mock.calls[0][0].where).toEqual({ id: 900, tenantId: TENANT, AND: [{ id: { in: [] } }] });
    });

    it("an ORG recruiter is unrestricted", async () => {
        prisma.application.findFirst.mockResolvedValue({ id: 900, jobRequisitionId: 12 });
        await service.addToShortlist({ applicationId: 900, tenantId: TENANT, actorId: 5, scope: ORG });
        expect(prisma.application.findFirst.mock.calls[0][0].where).toEqual({ id: 900, tenantId: TENANT, AND: [] });
    });

    it("adding an application with a pending proposal confirms it as MANUAL with the actor", async () => {
        prisma.application.findFirst.mockResolvedValue({ id: 900, jobRequisitionId: 12 });
        prisma.shortlistEntry.findUnique.mockResolvedValue({ id: 3, applicationId: 900, source: "SCORING_PROPOSAL", addedById: null });
        prisma.shortlistEntry.update.mockResolvedValue({ id: 3, source: "MANUAL", addedById: 5 });
        await service.addToShortlist({ applicationId: 900, tenantId: TENANT, actorId: 5, scope: ORG });
        expect(prisma.shortlistEntry.update).toHaveBeenCalledWith({
            where: { applicationId: 900 },
            data: { source: "MANUAL", addedById: 5, addedAt: expect.any(Date) },
        });
        expect(prisma.shortlistEntry.create).not.toHaveBeenCalled();
    });
});

describe("removeFromShortlist — scoped", () => {
    it("a manager removes only entries on their own requisitions", async () => {
        prisma.shortlistEntry.deleteMany.mockResolvedValue({ count: 0 });
        await expect(
            service.removeFromShortlist({ applicationId: 901, tenantId: TENANT, scope: MANAGER }),
        ).rejects.toMatchObject({ status: 404 });
        expect(prisma.shortlistEntry.deleteMany).toHaveBeenCalledWith({
            where: { applicationId: 901, tenantId: TENANT, application: MANAGED_PREDICATE },
        });
    });

    it("an unscoped internal caller keeps the tenant-only predicate", async () => {
        prisma.shortlistEntry.deleteMany.mockResolvedValue({ count: 1 });
        await service.removeFromShortlist({ applicationId: 900, tenantId: TENANT, scope: ORG });
        expect(prisma.shortlistEntry.deleteMany).toHaveBeenCalledWith({ where: { applicationId: 900, tenantId: TENANT } });
    });
});

describe("listShortlist — scoped rows", () => {
    it("applies the application scope to the rows as well as the requisition gate", async () => {
        prisma.jobRequisition.findFirst.mockResolvedValue({ id: 12 });
        prisma.shortlistEntry.findMany.mockResolvedValue([]);
        await service.listShortlist(12, TENANT, MANAGER);
        expect(prisma.shortlistEntry.findMany.mock.calls[0][0].where).toEqual({
            requisitionId: 12,
            tenantId: TENANT,
            application: MANAGED_PREDICATE,
        });
    });
});
