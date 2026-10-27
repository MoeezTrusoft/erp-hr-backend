// Recruitment Phase 4 — an onboarding template's `sessions`: validated before
// it is stored, omitted leaves the stored list alone, null restores the
// baseline (stored as a database NULL), an empty list means "no sessions";
// the set tool passes them through and its schema accepts them.
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { Prisma } from "@prisma/client";

const prisma = {
    onboardingChecklistTemplate: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(async (args) => ({ id: 7, ...args.data })),
        create: jest.fn(async (args) => ({ id: 1, ...args.data })),
        count: jest.fn(async () => 0),
    },
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({ tenantTransaction: (c, fn, o) => fn(c, o) }));

const templates = await import("../../src/services/onboarding-template.service.js");
const { registerOnboardingTemplateTools } = await import("../../src/mcp/tools/onboarding-template.tools.js");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { DEFAULT_ONBOARDING_SESSIONS } = await import("../../src/lib/onboarding-sessions.util.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const task = { title: "Laptop", stage: "equipment", category: "IT_ACCESS_SETUP", assigneeType: "IT", dueInDays: -2 };
const session = { key: "welcome", title: "Welcome", sessionType: "orientation", dayOffset: 0, fromTime: "09:00", toTime: "10:00", assigneeType: "HR" };

beforeEach(() => {
    jest.clearAllMocks();
    prisma.onboardingChecklistTemplate.findFirst.mockResolvedValue(null);
});

describe("upsertTemplate sessions", () => {
    it("stores a validated list on create", async () => {
        await templates.upsertTemplate({ tenantId: TENANT, name: "Standard", tasks: [task], sessions: [session] });
        expect(prisma.onboardingChecklistTemplate.create.mock.calls[0][0].data.sessions).toEqual([
            { ...session, location: null, required: false },
        ]);
    });

    it("refuses an invalid list before anything is written (422 with the reason)", async () => {
        await expect(
            templates.upsertTemplate({ tenantId: TENANT, name: "Standard", tasks: [task], sessions: [{ ...session, dayOffset: 0.5 }] }),
        ).rejects.toMatchObject({ status: 422, code: "HR-ONBOARDING-TEMPLATE-INVALID", details: { reason: expect.stringMatching(/dayOffset/) } });
        expect(prisma.onboardingChecklistTemplate.create).not.toHaveBeenCalled();
        expect(prisma.onboardingChecklistTemplate.updateMany).not.toHaveBeenCalled();
    });

    it("on update: omitted leaves the column alone, null clears it, [] stores no sessions", async () => {
        prisma.onboardingChecklistTemplate.findFirst.mockResolvedValue({ id: 7 });
        await templates.upsertTemplate({ tenantId: TENANT, name: "Standard", tasks: [task] });
        expect(prisma.onboardingChecklistTemplate.update.mock.calls[0][0].data).not.toHaveProperty("sessions");
        await templates.upsertTemplate({ tenantId: TENANT, name: "Standard", tasks: [task], sessions: null });
        expect(prisma.onboardingChecklistTemplate.update.mock.calls[1][0].data.sessions).toBe(Prisma.DbNull);
        await templates.upsertTemplate({ tenantId: TENANT, name: "Standard", tasks: [task], sessions: [] });
        expect(prisma.onboardingChecklistTemplate.update.mock.calls[2][0].data.sessions).toEqual([]);
    });

    it("the provisioning resolver reads the default template's sessions, else the baseline", async () => {
        const db = { onboardingChecklistTemplate: { findFirst: jest.fn(async () => ({ id: 3, sessions: [session] })) } };
        await expect(templates.resolveSessionsForProvisioning(db, TENANT)).resolves.toMatchObject({ source: "TEMPLATE", templateId: 3 });
        db.onboardingChecklistTemplate.findFirst.mockResolvedValue(null);
        await expect(templates.resolveSessionsForProvisioning(db, TENANT)).resolves.toEqual({ sessions: DEFAULT_ONBOARDING_SESSIONS, source: "DEFAULT", templateId: null });
    });
});

describe("hr_onboarding_template_set", () => {
    const handlers = new Map();
    const schemas = new Map();
    registerOnboardingTemplateTools({
        tool: (name, _d, schema, handler) => {
            handlers.set(name, handler);
            schemas.set(name, schema);
        },
    });
    const call = (args) =>
        mcpCtx.run({ user: { tenantId: TENANT, isAdmin: false, employeeId: 5 }, permissions: { "hr:recruitment": ["EDIT"] } }, () => handlers.get("hr_onboarding_template_set")(args));

    it("registers the three Phase 4 tools plus the two Phase 6 ones; sessions are optional in the schema", () => {
        expect([...handlers.keys()]).toEqual([
            "hr_onboarding_template_list", "hr_onboarding_template_set", "hr_onboarding_template_deactivate",
            "hr_onboarding_template_reactivate", "hr_onboarding_template_default_unset",
        ]);
        expect(schemas.get("hr_onboarding_template_set").sessions.isOptional()).toBe(true);
    });

    it("passes sessions through when given and leaves them out when not", async () => {
        await call({ name: "Standard", tasks: [task] });
        expect(prisma.onboardingChecklistTemplate.create.mock.calls[0][0].data).not.toHaveProperty("sessions");
        await call({ name: "Standard", tasks: [task], sessions: [session] });
        expect(prisma.onboardingChecklistTemplate.create.mock.calls[1][0].data.sessions).toHaveLength(1);
    });
});
