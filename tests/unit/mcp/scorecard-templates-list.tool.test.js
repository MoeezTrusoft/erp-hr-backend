// tests/unit/mcp/scorecard-templates-list.tool.test.js
//
// hr_scorecard_templates_list — the MCP read the form admin screen needs (the
// list was REST-only). Gated on hr:recruitment VIEW; tenant-scoped; active
// templates by default, deactivated ones on request.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const prisma = { scorecardTemplate: { findMany: jest.fn(async () => [{ id: 1, name: "Engineering", links: [] }]) } };
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));

const { registerInterviewMgmtTools } = await import("../../../src/mcp/tools/interviewMgmtTools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const handlers = new Map();
registerInterviewMgmtTools({ tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]), resource: () => {} });

const USER = { userId: "7", roles: ["HR_ADMIN"], isAdmin: false, employeeId: "7", tenantId: "tenant-A" };
const call = (args, permissions) =>
    mcpCtx.run({ user: USER, permissions }, async () => await handlers.get("hr_scorecard_templates_list")(args));

beforeEach(() => jest.clearAllMocks());

describe("hr_scorecard_templates_list", () => {
    it("lists the tenant's active templates with their links", async () => {
        const res = await call({}, { "hr:recruitment": ["VIEW"] });
        // Phase 7 (B10) — the author's name rides next to createdById.
        expect(JSON.parse(res.content[0].text)).toEqual([{ id: 1, name: "Engineering", links: [], createdByName: null }]);
        const where = prisma.scorecardTemplate.findMany.mock.calls[0][0].where;
        expect(JSON.stringify(where)).toContain("tenant-A");
        expect(where.isActive).toBe(true);
    });

    it("Phase 7 (B10): templates and links carry their author's name from one lookup", async () => {
        prisma.scorecardTemplate.findMany.mockResolvedValueOnce([
            { id: 1, name: "Engineering", createdById: 7, links: [{ id: 3, createdById: 8 }, { id: 4, createdById: null }] },
        ]);
        prisma.employee = { findMany: jest.fn(async () => [{ id: 7, first_name: "Zara", last_name: "Malik" }, { id: 8, employee_name: "Omar Farooq" }]) };
        const res = await call({}, { "hr:recruitment": ["VIEW"] });
        expect(JSON.parse(res.content[0].text)).toEqual([{
            id: 1, name: "Engineering", createdById: 7, createdByName: "Zara Malik",
            links: [{ id: 3, createdById: 8, createdByName: "Omar Farooq" }, { id: 4, createdById: null, createdByName: null }],
        }]);
        expect(prisma.employee.findMany).toHaveBeenCalledTimes(1);
        expect(prisma.employee.findMany.mock.calls[0][0].where).toEqual({ id: { in: [7, 8] }, tenant_id: "tenant-A" });
        delete prisma.employee;
    });

    it("includes deactivated templates only when asked", async () => {
        await call({ includeInactive: true }, { "hr:recruitment": ["VIEW"] });
        expect(prisma.scorecardTemplate.findMany.mock.calls[0][0].where.isActive).toBeUndefined();
    });

    it("refuses a caller without recruitment view", async () => {
        const res = await call({}, {}).catch((err) => err);
        expect(res?.isError === true || res instanceof Error).toBe(true);
        expect(prisma.scorecardTemplate.findMany).not.toHaveBeenCalled();
    });
});
