// src/mcp/tools/offer-extension.tools.js
//
// Recruitment Phase 6 — the offer EXPIRY EXTENSION re-approval, recruiter side.
// The request itself is made by hr_offer_expiry_extend (offer-lifecycle.tools.js)
// and decided in the HR Approval Centre (hr_approval_action); these two tools
// let a recruiter see where it stands and take it back.
//
// Who may do what (both answer 503 HR-RECRUITMENT-OFFER-EXTENSION-APPROVAL-
// DISABLED while HR_RECRUITMENT_OFFER_EXTENSION_APPROVAL is off):
//   * hr_offer_expiry_extension_get (GET): ORG (recruiters) only.
//   * hr_offer_expiry_extension_withdraw (PUT): ORG only; the offer is never
//     changed, only the open request is withdrawn.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { resolveRecruitmentScope } from "../../lib/recruitmentAccess.js";
import { getOfferExtensionApproval, withdrawOfferExtension } from "../../services/offer-expiry.service.js";

const RESOURCE = "hr:recruitment";

function getCtx() {
    const ctx = mcpRequestContext.getStore();
    if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
    return { user: ctx.user, permissions: ctx?.permissions || {} };
}

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

const idInput = z.union([z.string(), z.number()]);

export function registerOfferExtensionTools(server) {
    server.tool(
        "hr_offer_expiry_extension_get",
        "Where an offer's expiry extension stands in the HR Approval Centre (recruiters only): the offer's current expiry and extension count, whether a request is open, and the latest request with its stage (LINE_MANAGER | HR | MANAGEMENT | APPROVED | REJECTED | WITHDRAWN | INITIATOR when returned), its approvalRef and the proposed date",
        { id: idInput.describe("Offer id") },
        withToolError(async (args) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
            const scope = resolveRecruitmentScope(user);
            return text(await getOfferExtensionApproval({ tenantId: user.tenantId, id: args.id, scope }));
        }, "hr_offer_expiry_extension_get"),
    );

    server.tool(
        "hr_offer_expiry_extension_withdraw",
        "Withdraw an offer's open expiry extension request from the HR Approval Centre (recruiters only). The offer keeps its current expiry; a repeat answers withdrawn: []",
        {
            id: idInput.describe("Offer id"),
            reason: z.string().max(1000).optional().describe("Why the request is withdrawn (kept in the Approval Centre history)"),
        },
        withToolError(async (args) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
            const scope = resolveRecruitmentScope(user);
            return text(await withdrawOfferExtension({
                tenantId: user.tenantId,
                id: args.id,
                reason: args.reason,
                scope,
                actorId: scope.employeeId ?? null,
            }));
        }, "hr_offer_expiry_extension_withdraw"),
    );
}

export default registerOfferExtensionTools;
