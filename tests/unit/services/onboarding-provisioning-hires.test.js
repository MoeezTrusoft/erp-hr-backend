// Recruitment Phase 6 — the hire facet on IT's provisioning queue: with
// includeHires the list also answers the distinct hires that have an OPEN
// request, as { employeeId, name } only, in the caller's tenant, independent
// of the page's own filters. Without it the answer is unchanged.
import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";
import { makeProvisioningDb } from "./helpers/onboarding-provisioning.fake.js";

let db = makeProvisioningDb();
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({
    default: new Proxy({}, { get: (_t, prop) => db[prop] }),
}));

const svc = await import("../../../src/services/onboarding-provisioning.service.js");
const { registerOnboardingProvisioningTools } = await import("../../../src/mcp/tools/onboarding-provisioning.tools.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-20T09:00:00.000Z");
const as = (tenantId, fn) => mcpCtx.run({ user: { tenantId, employeeId: 77 } }, async () => await fn());

const ORIGINAL_FLAG = process.env.HR_ONBOARDING_AUTOMATION;
afterAll(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.HR_ONBOARDING_AUTOMATION;
    else process.env.HR_ONBOARDING_AUTOMATION = ORIGINAL_FLAG;
});

let nextId = 1;
const request = (tenantId, employeeId, status, extra = {}) =>
    db.rows("onboardingProvisioningRequest").push({
        id: nextId++, tenantId, checklistId: employeeId * 10, taskId: null, employeeId, kind: "DEVICE", title: "Laptop",
        status, dueDate: new Date("2026-10-30"), version: 0, requestedAt: NOW, createdAt: NOW, updatedAt: NOW, ...extra,
    });

beforeEach(() => {
    db = makeProvisioningDb();
    nextId = 1;
    process.env.HR_ONBOARDING_AUTOMATION = "true";
    const person = (id, tenant_id, name, extra = {}) =>
        db.rows("employee").push({ id, tenant_id, employee_name: name, first_name: null, last_name: null, work_email: `${id}@x.test`, current_address: "home", ...extra });
    person(500, TENANT, "Zara Ahmed");
    person(501, TENANT, null, { first_name: "Ali", last_name: "Raza" });
    person(502, TENANT, "Closed Only");
    person(503, TENANT, null);
    person(600, OTHER, "Other Tenant Hire");

    request(TENANT, 500, "REQUESTED");
    request(TENANT, 500, "IN_PROGRESS", { kind: "ACCOUNT" });
    request(TENANT, 501, "IN_PROGRESS");
    request(TENANT, 502, "FULFILLED");
    request(TENANT, 502, "CANCELLED");
    request(TENANT, 503, "REQUESTED");
    request(OTHER, 600, "REQUESTED");
});

describe("listProvisioningHires", () => {
    it("lists each hire with an open request once, name-sorted, unnamed last, in the tenant only", async () => {
        const hires = await as(TENANT, () => svc.listProvisioningHires(db, TENANT));
        expect(hires).toEqual([
            { employeeId: 501, name: "Ali Raza" },
            { employeeId: 500, name: "Zara Ahmed" },
            { employeeId: 503, name: null },
        ]);
        // Nothing but the id and the display name.
        for (const hire of hires) expect(Object.keys(hire).sort()).toEqual(["employeeId", "name"]);
    });

    it("another tenant sees only its own hires; no tenant is refused", async () => {
        await expect(as(OTHER, () => svc.listProvisioningHires(db, OTHER))).resolves.toEqual([{ employeeId: 600, name: "Other Tenant Hire" }]);
        await expect(as(TENANT, () => svc.listProvisioningHires(db, undefined))).rejects.toMatchObject({ code: "HR-TENANT-REQUIRED" });
    });

    it("with no open requests the facet is empty and no employee is read", async () => {
        db = makeProvisioningDb();
        await expect(as(TENANT, () => svc.listProvisioningHires(db, TENANT))).resolves.toEqual([]);
        expect(db.state.ops.some((op) => op.model === "employee")).toBe(false);
    });
});

describe("listProvisioningRequests includeHires", () => {
    it("adds hires only when asked, independent of the page's filters", async () => {
        const plain = await as(TENANT, () => svc.listProvisioningRequests({ tenantId: TENANT, now: NOW }));
        expect(plain).not.toHaveProperty("hires");
        const filtered = await as(TENANT, () => svc.listProvisioningRequests({ tenantId: TENANT, now: NOW, employeeId: 502, includeHires: true }));
        expect(filtered.items.map((r) => r.employeeId)).toEqual([502, 502]);
        expect(filtered.hires.map((h) => h.employeeId)).toEqual([501, 500, 503]);
    });

    it("the tool passes includeHires through behind the same gate and flag", async () => {
        const handlers = new Map();
        registerOnboardingProvisioningTools({ tool: (name, _d, _s, handler) => handlers.set(name, handler) });
        const call = (args, permissions) =>
            mcpCtx.run({ user: { tenantId: TENANT, employeeId: 77, roles: ["IT"] }, permissions }, () => handlers.get("hr_onboarding_provisioning_requests_list")(args));
        const parse = (res) => JSON.parse(res.content[0].text);

        expect(parse(await call({ includeHires: true }, { "hr:employee": ["VIEW"] })).status).toBe(403);
        const ok = parse(await call({ includeHires: true }, { "hr:onboarding": ["VIEW"] }));
        expect(ok.hires).toEqual([
            { employeeId: 501, name: "Ali Raza" },
            { employeeId: 500, name: "Zara Ahmed" },
            { employeeId: 503, name: null },
        ]);
        expect(JSON.stringify(ok.hires)).not.toContain("home");
        process.env.HR_ONBOARDING_AUTOMATION = "false";
        expect(parse(await call({ includeHires: true }, { "hr:onboarding": ["VIEW"] })).status).toBe(503);
    });
});
