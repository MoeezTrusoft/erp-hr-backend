// Recruitment Phase 7 (C12) — the retention tools:
//   * hr_candidate_retention_policy_get: registered on its own registrar, the
//     same gate as hr_candidate_retention_policy_set (hr:recruitment PUT), the
//     tenant from the verified context, the stored policy or the default;
//   * hr_candidate_retention_apply now goes through runManualRetention (the
//     recorded path) with the same arguments it gave applyRetention.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const getRetentionPolicyView = jest.fn(async () => ({ items: [] }));
const applyRetention = jest.fn();
const setRetentionPolicy = jest.fn(async () => ({ id: 1 }));
const runManualRetention = jest.fn(async () => ({ dryRun: true, runId: 5, runMode: "DRY_RUN" }));

jest.unstable_mockModule("../../../src/services/candidatePrivacy.service.js", () => ({
    RETENTION_POPULATIONS: Object.freeze(["APPLICANT", "TALENT_POOL"]),
    getRetentionPolicyView,
    applyRetention,
    setRetentionPolicy,
}));
jest.unstable_mockModule("../../../src/services/retention-run.service.js", () => ({ runManualRetention }));

const { registerRetentionPolicyTools, RETENTION_POLICY_TOOL_NAMES } = await import("../../../src/mcp/tools/retention-policy.tools.js");
const { registerCandidatePrivacyTools } = await import("../../../src/mcp/tools/candidatePrivacyTools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const tools = new Map();
const server = { tool: (name, _desc, schema, handler) => tools.set(name, { schema, handler }) };
registerRetentionPolicyTools(server);
const policyTools = [...tools.keys()];
registerCandidatePrivacyTools(server);

const TENANT = "11111111-1111-4111-8111-111111111111";
const HR = { userId: "1", roles: ["HR_ADMIN"], employeeId: 42, tenantId: TENANT, isAdmin: false };
const grant = (...actions) => ({ "hr:recruitment": actions });
const call = (name, args, { user = HR, permissions = grant("VIEW", "EDIT") } = {}) =>
    mcpCtx.run({ user, permissions }, () => tools.get(name).handler(args));
const parse = (res) => JSON.parse(res.content[0].text);

beforeEach(() => jest.clearAllMocks());

describe("hr_candidate_retention_policy_get", () => {
    it("is the only tool of its registrar", () => {
        expect(policyTools).toEqual(["hr_candidate_retention_policy_get"]);
        expect(RETENTION_POLICY_TOOL_NAMES).toEqual(policyTools);
    });

    it("needs hr:recruitment EDIT, like the policy set tool", async () => {
        for (const name of ["hr_candidate_retention_policy_get", "hr_candidate_retention_policy_set"]) {
            const args = name.endsWith("_set") ? { appliesTo: "APPLICANT", retentionMonths: 12 } : {};
            expect(parse(await call(name, args, { permissions: {} })).status).toBe(403);
            expect((await call(name, args, { permissions: grant("VIEW") })).isError).toBe(true);
            expect((await call(name, args, { permissions: grant("EDIT") })).isError).toBeUndefined();
        }
    });

    it("reads under the verified tenant, optionally one population", async () => {
        getRetentionPolicyView.mockResolvedValueOnce({ items: [{ appliesTo: "APPLICANT", retentionMonths: 24, isDefault: false }] });
        const out = parse(await call("hr_candidate_retention_policy_get", { appliesTo: "APPLICANT" }));
        expect(getRetentionPolicyView).toHaveBeenCalledWith({ tenantId: TENANT, appliesTo: "APPLICANT" });
        expect(out.items[0]).toMatchObject({ retentionMonths: 24, isDefault: false });
        await call("hr_candidate_retention_policy_get", {});
        expect(getRetentionPolicyView).toHaveBeenLastCalledWith({ tenantId: TENANT, appliesTo: null });
    });

    it("accepts only the two populations", () => {
        const { schema } = tools.get("hr_candidate_retention_policy_get");
        expect(schema.appliesTo.safeParse("TALENT_POOL").success).toBe(true);
        expect(schema.appliesTo.safeParse("EMPLOYEE").success).toBe(false);
    });

    it("refuses a caller without a tenant", async () => {
        const out = parse(await call("hr_candidate_retention_policy_get", {}, { user: { ...HR, tenantId: null } }));
        expect(out.status).toBe(400);
        expect(getRetentionPolicyView).not.toHaveBeenCalled();
    });
});

describe("hr_candidate_retention_apply records its run", () => {
    it("calls runManualRetention with the arguments applyRetention used to get", async () => {
        const out = parse(await call("hr_candidate_retention_apply", { dryRun: false, asOf: "2026-10-20T00:00:00.000Z", limit: 7 }));
        expect(runManualRetention).toHaveBeenCalledWith({
            tenantId: TENANT,
            asOf: new Date("2026-10-20T00:00:00.000Z"),
            actorId: 42,
            dryRun: false,
            limit: 7,
        });
        expect(applyRetention).not.toHaveBeenCalled();
        expect(out).toMatchObject({ runId: 5 });
    });

    it("stays a dry run unless dryRun is false, and keeps its PUT gate", async () => {
        await call("hr_candidate_retention_apply", {});
        expect(runManualRetention).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true, limit: 100 }));
        expect(parse(await call("hr_candidate_retention_apply", {}, { permissions: grant("VIEW") })).status).toBe(403);
    });
});
