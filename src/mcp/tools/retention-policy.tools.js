// src/mcp/tools/retention-policy.tools.js — Recruitment Phase 7 (C12a).
//
//   hr_candidate_retention_policy_get   the tenant's candidate retention policy
//                                       per population, or the default the
//                                       nightly run uses (no clock), flagged
//                                       isDefault
//
// The retention form used to start blank because only the write existed
// (hr_candidate_retention_policy_set in candidate-privacy.tools.js). This read
// carries the SAME gate as that write: hr:recruitment PUT (EDIT), the tenant
// from the verified context only. It sits in its own registrar so the pinned
// tool counts of candidatePrivacyTools stay as they are.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { getRetentionPolicyView, RETENTION_POPULATIONS } from "../../services/candidate-privacy.service.js";

export const RETENTION_POLICY_TOOL_NAMES = Object.freeze(["hr_candidate_retention_policy_get"]);

function getCtx() {
    const ctx = mcpRequestContext.getStore();
    if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
    return ctx;
}

export function registerRetentionPolicyTools(server) {
    server.tool(
        "hr_candidate_retention_policy_get",
        "Read the tenant's candidate retention policy, to prefill the policy form: one row per population (APPLICANT, TALENT_POOL, or only appliesTo) with retentionMonths, legalBasis, isActive and isDefault. isDefault true means nothing is stored: there is no retention clock and the nightly run skips that population (retentionMonths null). Same permission as hr_candidate_retention_policy_set.",
        {
            appliesTo: z.enum(RETENTION_POPULATIONS).optional().describe("Only this population (default: both)"),
        },
        withToolError(async ({ appliesTo } = {}) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
            const tenantId = user?.tenantId ?? null;
            if (!tenantId) throw Object.assign(new Error("Tenant context is required"), { status: 400, code: "HR-TENANT-REQUIRED" });
            const data = await getRetentionPolicyView({ tenantId, appliesTo: appliesTo ?? null });
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }, "hr_candidate_retention_policy_get"),
    );
}

export default registerRetentionPolicyTools;
