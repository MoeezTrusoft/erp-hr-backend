// tests/unit/mcp/recruitment-disposition.tools.test.js
//
// Recruitment Phase 2 — the scheduled-disposition tools: list is cut to the
// caller's recruitment scope; cancel is PUT on hr:recruitment and ORG-only.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const prisma = {
    scheduledDisposition: {
        findMany: jest.fn(async () => []),
        count: jest.fn(async () => 0),
        findFirst: jest.fn(async () => ({ id: 1, tenantId: "tenant-A", applicationId: 10, source: "KNOCKOUT", reasonCode: "X", status: "PENDING" })),
        updateMany: jest.fn(async () => ({ count: 1 })),
    },
    $transaction: jest.fn(async (fn) => fn(prisma)),
};
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/lib/rlsTenant.js", () => ({
    tenantTransaction: jest.fn(async (client, fn) => fn(client)),
    rlsTenantExtension: jest.fn((c) => c),
}));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent: jest.fn(async () => null) }));

const { registerRecruitmentDispositionTools } = await import("../../../src/mcp/tools/recruitment-disposition.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const handlers = new Map();
registerRecruitmentDispositionTools({ tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]) });

const RECRUITER = { roles: ["RECRUITER"], employeeId: 7, tenantId: "tenant-A", isAdmin: false };
const MANAGER = { roles: ["HIRING_MANAGER"], employeeId: 8, tenantId: "tenant-A", isAdmin: false };
const PERMS = { "hr:recruitment": ["VIEW", "EDIT"] };

const call = (name, args, user = RECRUITER, permissions = PERMS) =>
    mcpCtx.run({ user, permissions }, async () => await handlers.get(name)(args));

beforeEach(() => jest.clearAllMocks());

describe("recruitment disposition tools", () => {
    it("registers exactly the two tools", () => {
        expect([...handlers.keys()].sort()).toEqual([
            "hr_application_scheduled_disposition_cancel",
            "hr_application_scheduled_disposition_list",
        ]);
    });

    it("list: a hiring manager only reaches their own requisitions' applications", async () => {
        const res = await call("hr_application_scheduled_disposition_list", { requisitionId: "5", status: "PENDING" }, MANAGER);
        expect(res.isError).not.toBe(true);
        const { where } = prisma.scheduledDisposition.findMany.mock.calls[0][0];
        expect(where).toMatchObject({ tenantId: "tenant-A", status: "PENDING" });
        expect(where.application.is).toEqual({
            jobRequisition: { OR: [{ requestedById: 8 }, { approvedById: 8 }] },
            jobRequisitionId: 5,
        });
    });

    it("list: a recruiter is unrestricted within the tenant", async () => {
        await call("hr_application_scheduled_disposition_list", {});
        expect(prisma.scheduledDisposition.findMany.mock.calls[0][0].where.application.is).toEqual({});
    });

    it("cancel: a recruiter cancels with a reason", async () => {
        const res = await call("hr_application_scheduled_disposition_cancel", { id: "1", reason: "Permit on file" });
        expect(res.isError).not.toBe(true);
        expect(prisma.scheduledDisposition.updateMany.mock.calls[0][0]).toMatchObject({
            where: { id: 1, tenantId: "tenant-A", status: "PENDING" },
            data: { status: "CANCELLED", cancelledById: 7, cancelReason: "Permit on file" },
        });
    });

    it("cancel: a hiring manager is refused and nothing is written", async () => {
        const res = await call("hr_application_scheduled_disposition_cancel", { id: "1", reason: "x" }, MANAGER);
        expect(res.isError).toBe(true);
        expect(prisma.scheduledDisposition.updateMany).not.toHaveBeenCalled();
    });

    it("cancel: without the PUT grant it is refused", async () => {
        const res = await call("hr_application_scheduled_disposition_cancel", { id: "1", reason: "x" }, RECRUITER, { "hr:recruitment": ["VIEW"] });
        expect(res.isError).toBe(true);
        expect(prisma.scheduledDisposition.updateMany).not.toHaveBeenCalled();
    });
});
