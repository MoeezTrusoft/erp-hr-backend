// Recruitment Phase 6 — onboarding checklist reads no longer hand the hire's
// home address to every hr:onboarding reader (the screen showed it as the
// office). Each checklist carries workLocation (requisition location of the
// hire's offer, else the employee's region) and the home address is added only
// for a caller with hr:employee VIEW; the buddy's address is never read.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const TENANT = "11111111-1111-4111-8111-111111111111";

const prisma = {
    onboardingChecklist: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(async () => 0) },
    offerHandoff: { findMany: jest.fn(async () => []) },
};
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma, prisma }));

const svc = await import("../../../src/services/onboarding.service.js");
const ctrl = await import("../../../src/controllers/onboarding.controller.js");
const { registerOnboardingTools } = await import("../../../src/mcp/tools/onboarding.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

// Prisma would return only the selected columns; the fake does the same for
// the embedded employee so the test sees what a caller would.
const pick = (row, select) => Object.fromEntries(Object.keys(select).filter((k) => k in row).map((k) => [k, structuredClone(row[k])]));
const HIRE_ROW = {
    id: 30, employee_name: "Ayesha Khan", first_name: "Ayesha", last_name: "Khan", job_title: "Engineer",
    joining_date: null, hire_date: null, photo_url: null,
    current_address: "House 12, Street 4, F-7/2", city: "Islamabad",
    work_mode: "Hybrid", region: { name: "North Region" },
};
const BUDDY_ROW = { id: 31, employee_name: "Bilal", current_address: "Buddy home", city: "Lahore" };

function checklistRows(include, rows) {
    return rows.map((r) => ({
        ...r,
        employee: pick(r.employee, include.employee.select),
        buddy: r.buddy ? { buddy: pick(r.buddy.buddy, include.buddy.include.buddy.select) } : null,
        tasks: [],
    }));
}

let stored;
beforeEach(() => {
    jest.clearAllMocks();
    stored = [
        { id: 70, employeeId: 30, tenantId: TENANT, employee: HIRE_ROW, buddy: { buddy: BUDDY_ROW } },
        { id: 71, employeeId: 32, tenantId: TENANT, employee: { ...HIRE_ROW, id: 32, region: null, work_mode: null }, buddy: null },
        { id: 72, employeeId: 33, tenantId: TENANT, employee: { ...HIRE_ROW, id: 33, region: { name: "  " }, work_mode: "Remote" }, buddy: null },
    ];
    prisma.onboardingChecklist.findMany.mockImplementation(async ({ include }) => checklistRows(include, stored));
    prisma.onboardingChecklist.findFirst.mockImplementation(async ({ include }) => checklistRows(include, stored.slice(0, 1))[0]);
    prisma.offerHandoff.findMany.mockResolvedValue([
        // Checklist 70: its own handoff wins over the hire's other one.
        { checklistId: 70, employeeId: 30, offer: { jobRequisition: { location: " Karachi HQ, Floor 3 " } } },
        { checklistId: 99, employeeId: 30, offer: { jobRequisition: { location: "Old office" } } },
        // Hire 32: no handoff on this checklist, a later one for the employee.
        { checklistId: null, employeeId: 32, offer: { jobRequisition: { location: "Lahore Tech Park" } } },
        // Hire 33: a handoff whose requisition has no location.
        { checklistId: 72, employeeId: 33, offer: { jobRequisition: { location: null } } },
    ]);
});

describe("the service", () => {
    it("by default selects no home address for the hire or the buddy and returns the work location", async () => {
        const { items } = await svc.listChecklists({ tenantId: TENANT });
        const include = prisma.onboardingChecklist.findMany.mock.calls[0][0].include;
        expect(include.employee.select).not.toHaveProperty("current_address");
        expect(include.employee.select).not.toHaveProperty("city");
        expect(include.buddy.include.buddy.select).not.toHaveProperty("current_address");
        expect(include.buddy.include.buddy.select).not.toHaveProperty("city");

        expect(items.map((c) => c.workLocation)).toEqual([
            { location: "Karachi HQ, Floor 3", workMode: "Hybrid", source: "REQUISITION" },
            { location: "Lahore Tech Park", workMode: null, source: "REQUISITION" },
            { location: null, workMode: "Remote", source: null },
        ]);
        const text = JSON.stringify(items);
        expect(text).not.toContain("current_address");
        expect(text).not.toContain("Islamabad");
        expect(text).not.toContain("Buddy home");
        // The helper columns do not leak into the embedded profile.
        expect(items[0].employee).not.toHaveProperty("region");
        expect(items[0].employee).not.toHaveProperty("work_mode");
    });

    it("falls back to the employee's region when no handoff names a location", async () => {
        prisma.offerHandoff.findMany.mockResolvedValue([]);
        const { items } = await svc.listChecklists({ tenantId: TENANT });
        expect(items[0].workLocation).toEqual({ location: "North Region", workMode: "Hybrid", source: "REGION" });
    });

    it("adds the hire's home address (never the buddy's) when asked by the caller layer", async () => {
        const { items } = await svc.listChecklists({ tenantId: TENANT, includeHomeAddress: true });
        expect(items[0].employee).toMatchObject({ current_address: "House 12, Street 4, F-7/2", city: "Islamabad" });
        expect(items[0].buddy.buddy).not.toHaveProperty("current_address");
        expect(items[0].workLocation.source).toBe("REQUISITION");
    });

    it("scopes the handoff read to the tenant and the listed checklists and hires", async () => {
        await svc.listChecklists({ tenantId: TENANT });
        expect(prisma.offerHandoff.findMany.mock.calls[0][0].where).toEqual({
            tenantId: TENANT,
            OR: [{ checklistId: { in: [70, 71, 72] } }, { employeeId: { in: [30, 32, 33] } }],
        });
    });

    it("getChecklist and getChecklistByEmployee carry workLocation; an empty read asks nothing more", async () => {
        const one = await svc.getChecklist(70, TENANT);
        expect(one.workLocation).toMatchObject({ source: "REQUISITION" });
        expect(one.employee).not.toHaveProperty("current_address");
        const byEmployee = await svc.getChecklistByEmployee(30, TENANT, { includeHomeAddress: true });
        expect(byEmployee[0].employee.city).toBe("Islamabad");

        prisma.offerHandoff.findMany.mockClear();
        prisma.onboardingChecklist.findFirst.mockResolvedValueOnce(null);
        expect(await svc.getChecklist(5, TENANT)).toBeNull();
        prisma.onboardingChecklist.findMany.mockResolvedValueOnce([]);
        expect((await svc.listChecklists({ tenantId: TENANT })).items).toEqual([]);
        expect(prisma.offerHandoff.findMany).not.toHaveBeenCalled();
    });
});

describe("who gets the home address", () => {
    const resources = new Map();
    registerOnboardingTools({ tool: () => {}, registerTool: () => {}, resource: (_n, uri, _m, handler) => resources.set(String(uri), handler) });
    const USER = { userId: "7", roles: ["HR"], isAdmin: true, employeeId: "7", tenantId: TENANT };
    const readList = async (permissions) => {
        const out = await mcpCtx.run({ user: USER, permissions }, () => resources.get("hr://onboarding/checklists")(new URL("hr://onboarding/checklists")));
        return JSON.parse(out.contents[0].text);
    };

    it("an hr:onboarding reader (even an admin claim) gets the work location and no home address", async () => {
        const body = await readList({ "hr:onboarding": ["VIEW"] });
        expect(body.success).toBe(true);
        expect(body.data.items[0].workLocation).toEqual({ location: "Karachi HQ, Floor 3", workMode: "Hybrid", source: "REQUISITION" });
        expect(JSON.stringify(body)).not.toContain("current_address");
        // Scoped to the verified tenant.
        expect(prisma.onboardingChecklist.findMany.mock.calls[0][0].where).toEqual({ tenantId: TENANT });
    });

    it("a reader who also holds hr:employee VIEW gets the hire's home address", async () => {
        const body = await readList({ "hr:onboarding": ["VIEW"], "hr:employee": ["VIEW"] });
        expect(body.data.items[0].employee).toMatchObject({ current_address: "House 12, Street 4, F-7/2", city: "Islamabad" });
    });

    it("the REST controller decides from the verified permission set", async () => {
        const run = async (permissions) => {
            let payload;
            const res = { status: () => res, json: (data) => { payload = data; return res; } };
            await ctrl.listChecklists({ query: {}, user: { permissions } }, res);
            return payload;
        };
        expect(JSON.stringify(await run(["hr.onboarding.read"]))).not.toContain("current_address");
        expect((await run(["hr.onboarding.read", "hr.employee.read"])).data.items[0].employee.city).toBe("Islamabad");
        // A client flag in the query changes nothing.
        let payload;
        const res = { status: () => res, json: (data) => { payload = data; return res; } };
        await ctrl.listChecklists({ query: { includeHomeAddress: "true" }, user: { permissions: ["hr.onboarding.read"] } }, res);
        expect(JSON.stringify(payload)).not.toContain("current_address");
    });
});
