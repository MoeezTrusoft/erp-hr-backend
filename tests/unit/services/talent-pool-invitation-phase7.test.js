// Recruitment Phase 7 (C11) — the invitation list can be narrowed to the
// invitations one nurture run sent: an optional positive-integer nurtureRunId,
// validated, inside the caller's tenant, and every row says which run sent it.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: {} }));
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: {} }));
jest.unstable_mockModule("../../../src/lib/recruitmentOpsMetrics.js", () => ({ recordRetentionRun: jest.fn() }));

const { listInvitations } = await import("../../../src/services/talentPoolInvitation.service.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const row = (over = {}) => ({
    id: 1,
    tenantId: TENANT,
    candidateId: 9,
    status: "INVITED",
    invitedAt: new Date("2026-10-01T00:00:00.000Z"),
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    responseTokenHash: "secret-hash",
    ...over,
});

let client;
beforeEach(() => {
    client = { talentPoolInvitation: { findMany: jest.fn(async () => [row({ nurtureRunId: 12 }), row({ id: 2 })]) } };
});

describe("listInvitations by nurture run", () => {
    it("narrows to the run, inside the tenant, and returns nurtureRunId on every row", async () => {
        const out = await listInvitations({ tenantId: TENANT, nurtureRunId: "12", status: "invited", db: client });
        expect(client.talentPoolInvitation.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { tenantId: TENANT, status: "INVITED", nurtureRunId: 12 },
        }));
        expect(out.items.map((i) => i.nurtureRunId)).toEqual([12, null]);
        expect(JSON.stringify(out)).not.toContain("secret-hash");
    });

    it("leaves the filter off when it is absent", async () => {
        for (const value of [undefined, null, ""]) {
            await listInvitations({ tenantId: TENANT, nurtureRunId: value, db: client });
            expect(client.talentPoolInvitation.findMany.mock.calls.at(-1)[0].where).toEqual({ tenantId: TENANT });
        }
    });

    it.each([0, -3, 1.5, "abc", "7x"])("refuses %p as a 400 before any read", async (value) => {
        await expect(listInvitations({ tenantId: TENANT, nurtureRunId: value, db: client }))
            .rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-INVITATION-FILTER-INVALID" });
        expect(client.talentPoolInvitation.findMany).not.toHaveBeenCalled();
    });

    it("still needs the tenant", async () => {
        await expect(listInvitations({ nurtureRunId: 1, db: client })).rejects.toMatchObject({ code: "HR-TENANT-REQUIRED" });
    });
});

describe("hr_talent_pool_invitation_list passes the filter", () => {
    it("validates nurtureRunId as a positive integer and hands it to the service", async () => {
        jest.resetModules();
        const listMock = jest.fn(async () => ({ items: [], total: 0 }));
        jest.unstable_mockModule("../../../src/services/talentPoolInvitation.service.js", () => ({
            listInvitations: listMock,
            respondToInvitation: jest.fn(),
            segmentTalentPool: jest.fn(),
            sweepTalentPoolRetention: jest.fn(),
            withdrawInvitation: jest.fn(),
        }));
        jest.unstable_mockModule("../../../src/services/talentPoolMgmt.service.js", () => ({
            listManagedPool: jest.fn(),
            getPoolProfile: jest.fn(),
            moveToPipeline: jest.fn(),
            inviteCandidate: jest.fn(),
        }));
        const { registerTalentPoolMgmtTools } = await import("../../../src/mcp/tools/talentPoolMgmtTools.js");
        const { mcpCtx } = await import("../../../src/mcp/context.js");
        const tools = new Map();
        registerTalentPoolMgmtTools({ tool: (name, _d, schema, handler) => tools.set(name, { schema, handler }) });
        const { schema, handler } = tools.get("hr_talent_pool_invitation_list");

        expect(schema.nurtureRunId.safeParse("5").data).toBe(5);
        expect(schema.nurtureRunId.safeParse(0).success).toBe(false);
        expect(schema.nurtureRunId.safeParse(-1).success).toBe(false);
        expect(schema.nurtureRunId.safeParse(undefined).success).toBe(true);

        const user = { tenantId: TENANT, employeeId: 1, roles: ["RECRUITER"] };
        await mcpCtx.run({ user, permissions: { "hr:recruitment": ["VIEW"] } }, () => handler({ nurtureRunId: 5 }));
        expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, nurtureRunId: 5 }));
        await mcpCtx.run({ user, permissions: { "hr:recruitment": ["VIEW"] } }, () => handler({}));
        expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ nurtureRunId: null }));
    });
});
