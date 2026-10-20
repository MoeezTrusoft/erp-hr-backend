// Recruitment Phase 6 — hr_onboarding_session_plan_preview with baseline: true
// previews the built-in session set even when the tenant's default template
// carries its own sessions; it cannot be combined with a template or a draft.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { z } from "zod";
import { createOnboardingDb } from "./helpers/onboarding-sessions.fake.js";

const { db, state } = createOnboardingDb();
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));

const plan = await import("../../../src/services/onboarding-session-plan.service.js");
const { DEFAULT_ONBOARDING_SESSIONS } = await import("../../../src/lib/onboarding-sessions.util.js");
const { registerOnboardingSessionPlanTools } = await import("../../../src/mcp/tools/onboarding-session-plan.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const asTenant = (fn) => mcpCtx.run({ user: { tenantId: TENANT } }, async () => await fn());
const preview = (args) => asTenant(() => plan.previewOnboardingSessionPlan({ tenantId: TENANT, ...args }));
const CUSTOM = [{ key: "custom", title: "Custom intro", sessionType: "orientation", dayOffset: 0, assigneeType: "HR" }];

beforeEach(() => {
    for (const key of Object.keys(state)) state[key] = [];
    // The tenant's default template has its own sessions.
    state.templates.push({ id: 5, tenantId: TENANT, isActive: true, isDefault: true, sessions: CUSTOM });
});

describe("previewOnboardingSessionPlan baseline", () => {
    it("without baseline the default template's sessions are previewed (unchanged)", async () => {
        await expect(preview({ startDate: "2026-10-23" })).resolves.toMatchObject({ source: "TEMPLATE", templateId: 5, sessions: [{ key: "custom" }] });
    });

    it("baseline: true previews the built-in set, source DEFAULT, no template", async () => {
        const result = await preview({ startDate: "2026-10-24", baseline: true });
        expect(result).toMatchObject({ source: "DEFAULT", templateId: null, startDate: "2026-10-24" });
        expect(result.sessions.map((s) => s.key)).toEqual(DEFAULT_ONBOARDING_SESSIONS.map((s) => s.key));
        // Placed on working days like every preview: a Saturday start begins Monday.
        expect(result.sessions[0]).toMatchObject({ sessionDate: "2026-10-26", weekday: "Monday" });
        expect(state.sessions).toEqual([]);
    });

    it("baseline with a template or a draft list is refused; baseline false is the normal preview", async () => {
        await expect(preview({ startDate: "2026-10-23", baseline: true, templateId: 5 })).rejects.toMatchObject({ status: 400, code: "HR-ONBOARDING-SESSION-PREVIEW-SOURCE" });
        await expect(preview({ startDate: "2026-10-23", baseline: true, sessions: CUSTOM })).rejects.toMatchObject({ status: 400, code: "HR-ONBOARDING-SESSION-PREVIEW-SOURCE" });
        await expect(preview({ startDate: "2026-10-23", baseline: false })).resolves.toMatchObject({ source: "TEMPLATE" });
        // The start date is still checked first.
        await expect(preview({ startDate: "soon", baseline: true })).rejects.toMatchObject({ code: "HR-ONBOARDING-SESSION-START-INVALID" });
    });
});

describe("the tool", () => {
    const tools = new Map();
    registerOnboardingSessionPlanTools({ tool: (name, _d, schema, handler) => tools.set(name, { schema: z.object(schema), handler }) });
    const call = (args, permissions = { "hr:onboarding": ["VIEW"] }) => {
        const { schema, handler } = tools.get("hr_onboarding_session_plan_preview");
        return mcpCtx.run({ user: { tenantId: TENANT, isAdmin: false }, permissions }, () => handler(schema.parse(args)));
    };
    const parse = (res) => JSON.parse(res.content[0].text);

    it("takes baseline as a boolean and answers the built-in set", async () => {
        expect(() => tools.get("hr_onboarding_session_plan_preview").schema.parse({ startDate: "2026-10-23", baseline: "yes" })).toThrow();
        const out = parse(await call({ startDate: "2026-10-23", baseline: true }));
        expect(out).toMatchObject({ source: "DEFAULT", templateId: null });
        expect(parse(await call({ startDate: "2026-10-23", baseline: true }, {})).status).toBe(403);
    });
});
