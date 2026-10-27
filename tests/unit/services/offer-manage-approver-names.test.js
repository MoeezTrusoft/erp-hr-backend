// Recruitment Phase 7: the offer manage list and detail name the approvers
// next to their ids (one tenant-scoped lookup per read).
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OFFER = {
    id: 41,
    candidateId: 5,
    candidate: { firstName: "Hina", lastName: "Raza" },
    jobRequisitionId: 2,
    jobRequisition: { title: "Analyst", position: null },
    status: "APPROVED",
    salary: 100,
    approvals: {
        hiringManager: { by: 7, decision: "APPROVED", at: "2026-10-01T00:00:00Z" },
        finance: { by: "legacy text", decision: "REJECTED", reason: "Over band" },
    },
};

const prisma = {
    offer: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn() },
    employee: { findMany: jest.fn() },
};
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));

const { listOffersManage, getOfferManage } = await import("../../../src/services/offer-mgmt.service.js");

beforeEach(() => {
    jest.clearAllMocks();
    prisma.offer.findMany.mockResolvedValue([structuredClone(OFFER)]);
    prisma.offer.count.mockResolvedValue(1);
    prisma.offer.findFirst.mockResolvedValue(structuredClone(OFFER));
    prisma.employee.findMany.mockResolvedValue([{ id: 7, first_name: "Omar", last_name: "Sheikh", employee_name: null }]);
});

describe("offer manage approver names (Phase 7)", () => {
    it("adds byName next to each approver id on the list, in one tenant query", async () => {
        const out = await listOffersManage({ tenantId: TENANT });
        const { approvedBy, rejectedBy } = out.items[0].approvals;
        expect(approvedBy).toEqual([{ stage: "hiringManager", by: 7, at: "2026-10-01T00:00:00Z", byName: "Omar Sheikh" }]);
        expect(rejectedBy[0]).toMatchObject({ stage: "finance", by: "legacy text", byName: null });
        expect(prisma.employee.findMany).toHaveBeenCalledTimes(1);
        expect(prisma.employee.findMany.mock.calls[0][0].where).toEqual({ id: { in: [7] }, tenant_id: TENANT });
    });

    it("names approvers on the detail too, and a failed lookup leaves names null", async () => {
        prisma.employee.findMany.mockRejectedValueOnce(new Error("db down"));
        const detail = await getOfferManage(41, { tenantId: TENANT });
        expect(detail.approvals.approvedBy[0]).toMatchObject({ by: 7, byName: null });
        const again = await getOfferManage(41, { tenantId: TENANT });
        expect(again.approvals.approvedBy[0].byName).toBe("Omar Sheikh");
    });
});
