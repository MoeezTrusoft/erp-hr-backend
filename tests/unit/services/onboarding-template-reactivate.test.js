// Recruitment Phase 6 — onboarding templates can be reactivated (optionally as
// the default) and the default can be unset without deactivating the
// template. At most one default per tenant at every step; no default means
// the baseline.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

let rows;
const matches = (row, where = {}) => Object.entries(where).every(([k, v]) => row[k] === v);
const table = {
    findFirst: jest.fn(async ({ where, select } = {}) => {
        const row = rows.find((r) => matches(r, where));
        if (!row) return null;
        return select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : { ...row };
    }),
    findMany: jest.fn(async ({ where } = {}) => rows.filter((r) => matches(r, where)).map((r) => ({ ...r }))),
    updateMany: jest.fn(async ({ where, data }) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
    }),
    update: jest.fn(async ({ where, data }) => {
        const row = rows.find((r) => r.id === where.id);
        Object.assign(row, data);
        return { ...row };
    }),
    create: jest.fn(),
    count: jest.fn(async () => rows.length),
};
const prisma = { onboardingChecklistTemplate: table };
const tenantTransaction = jest.fn((client, fn, opts) => fn(client, opts));

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/lib/rlsTenant.js", () => ({ tenantTransaction }));

const svc = await import("../../../src/services/onboarding-template.service.js");
const { registerOnboardingTemplateTools } = await import("../../../src/mcp/tools/onboarding-template.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const defaults = (tenantId = T1) => rows.filter((r) => r.tenantId === tenantId && r.isDefault).map((r) => r.id);

beforeEach(() => {
    jest.clearAllMocks();
    rows = [
        { id: 1, tenantId: T1, name: "Standard", isActive: true, isDefault: true, sessions: null },
        { id: 2, tenantId: T1, name: "Engineering", isActive: false, isDefault: false, sessions: [{ key: "x" }] },
        { id: 3, tenantId: T1, name: "Sales", isActive: true, isDefault: false, sessions: null },
        { id: 9, tenantId: T2, name: "Theirs", isActive: false, isDefault: true, sessions: null },
    ];
});

describe("reactivateTemplate", () => {
    it("brings a deactivated template back as a plain active one, keeping its sessions and the default", async () => {
        const out = await svc.reactivateTemplate({ tenantId: T1, templateId: "2" });
        expect(out).toMatchObject({ changed: true, template: { id: 2, isActive: true, isDefault: false, sessions: [{ key: "x" }] } });
        expect(defaults()).toEqual([1]);
        expect(tenantTransaction).toHaveBeenCalledWith(prisma, expect.any(Function), { tenantId: T1 });
    });

    it("with makeDefault it becomes the only default", async () => {
        const out = await svc.reactivateTemplate({ tenantId: T1, templateId: 2, makeDefault: true });
        expect(out).toMatchObject({ changed: true, template: { id: 2, isActive: true, isDefault: true } });
        expect(defaults()).toEqual([2]);
        expect(defaults(T2)).toEqual([9]); // another tenant's default is untouched
    });

    it("an active template is a no-op (changed false) unless it is promoted", async () => {
        await expect(svc.reactivateTemplate({ tenantId: T1, templateId: 3 })).resolves.toMatchObject({ changed: false, template: { id: 3 } });
        expect(table.update).not.toHaveBeenCalled();
        await expect(svc.reactivateTemplate({ tenantId: T1, templateId: 3, makeDefault: true })).resolves.toMatchObject({ changed: true, template: { isDefault: true } });
        expect(defaults()).toEqual([3]);
        // The current default promoted again changes nothing.
        await expect(svc.reactivateTemplate({ tenantId: T1, templateId: 3, makeDefault: true })).resolves.toMatchObject({ changed: false });
    });

    it("another tenant's id, a missing id and junk are 404; no tenant is 400", async () => {
        for (const templateId of [9, 77, "abc", undefined]) {
            await expect(svc.reactivateTemplate({ tenantId: T1, templateId })).rejects.toMatchObject({ status: 404, code: "HR-ONBOARDING-TEMPLATE-NOT-FOUND" });
        }
        await expect(svc.reactivateTemplate({ templateId: 2 })).rejects.toMatchObject({ status: 400 });
        expect(rows.find((r) => r.id === 9).isActive).toBe(false);
    });
});

describe("unsetDefaultTemplate", () => {
    it("clears the default without deactivating it; the tenant falls back to the baseline", async () => {
        const out = await svc.unsetDefaultTemplate({ tenantId: T1, templateId: 1 });
        expect(out).toMatchObject({ changed: true, template: { id: 1, isActive: true, isDefault: false } });
        expect(defaults()).toEqual([]);
        expect(await svc.findDefaultTemplate(prisma, T1)).toBeNull();
        const plan = await svc.resolveSessionsForProvisioning(prisma, T1);
        expect(plan).toMatchObject({ source: "DEFAULT", templateId: null });
    });

    it("a template that is not the default is a no-op; another tenant's is 404", async () => {
        await expect(svc.unsetDefaultTemplate({ tenantId: T1, templateId: 3 })).resolves.toMatchObject({ changed: false, template: { id: 3 } });
        expect(table.update).not.toHaveBeenCalled();
        await expect(svc.unsetDefaultTemplate({ tenantId: T1, templateId: 9 })).rejects.toMatchObject({ status: 404 });
        expect(defaults(T2)).toEqual([9]);
    });
});

describe("the tools", () => {
    const handlers = new Map();
    registerOnboardingTemplateTools({ tool: (name, _d, _s, handler) => handlers.set(name, handler) });
    const USER = { tenantId: T1, isAdmin: true, employeeId: 5 };
    const call = (name, args, permissions) => mcpCtx.run({ user: USER, permissions }, () => handlers.get(name)(args));
    const parse = (res) => JSON.parse(res.content[0].text);

    it.each([
        ["hr_onboarding_template_reactivate", { templateId: "2", makeDefault: true }],
        ["hr_onboarding_template_default_unset", { templateId: "1" }],
    ])("%s needs hr:recruitment EDIT (an admin claim alone is not enough)", async (name, args) => {
        expect(parse(await call(name, args, { "hr:recruitment": ["VIEW"] })).status).toBe(403);
        expect(parse(await call(name, args, { "hr:onboarding": ["EDIT"] })).status).toBe(403);
        expect(table.update).not.toHaveBeenCalled();
        const ok = parse(await call(name, args, { "hr:recruitment": ["EDIT"] }));
        expect(ok).toMatchObject({ success: true, data: { changed: true } });
    });

    it("reactivate passes makeDefault and the verified tenant", async () => {
        const ok = parse(await call("hr_onboarding_template_reactivate", { templateId: "2" }, { "hr:recruitment": ["EDIT"] }));
        expect(ok.data.template).toMatchObject({ id: 2, isActive: true, isDefault: false });
        expect(defaults()).toEqual([1]);
    });
});
