// src/mcp/tools/interview-bulk-cancel.tools.js
//
// Recruitment Phase 6 — hr_interviews_cancel_bulk: cancel several interviews
// with one MANDATORY coded reason (interview-bulk-cancel.service.js). Same
// gate as hr_interview_cancel: PUT on hr:recruitment, tenant from the verified
// context, the actor is the caller (never a supplied id).
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { BULK_CANCEL_MAX, BULK_CANCEL_REASONS, cancelInterviewsBulk } from "../../services/interview-bulk-cancel.service.js";

function getCtx() {
    const ctx = mcpRequestContext.getStore();
    if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
    return { user: ctx.user, permissions: ctx?.permissions || {} };
}

export function registerInterviewBulkCancelTools(server) {
    server.tool(
        "hr_interviews_cancel_bulk",
        `Cancel up to ${BULK_CANCEL_MAX} interviews with ONE MANDATORY coded reason (§5.4): ${BULK_CANCEL_REASONS.join(", ")} (OTHER requires notes). Each interview is cancelled exactly as hr_interview_cancel does it (ledger row, calendar cancel, candidate and panel notified through the lifecycle event); one failure does not stop the rest. Returns every id with CANCELLED | ALREADY_CANCELLED | FAILED and the counts.`,
        {
            interviewIds: z.array(z.coerce.number().int().positive()).min(1).max(BULK_CANCEL_MAX).describe("Interview ids to cancel"),
            reasonCode: z.enum(BULK_CANCEL_REASONS).describe("Why the interviews are being cancelled"),
            notes: z.string().optional().describe("Free-text notes; REQUIRED when reasonCode is OTHER"),
        },
        withToolError(async ({ interviewIds, reasonCode, notes }) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
            const data = await cancelInterviewsBulk({
                interviewIds,
                reasonCode,
                notes: notes ?? null,
                tenantId: user.tenantId,
                actorId: user.employeeId ?? null,
            });
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }, "hr_interviews_cancel_bulk"),
    );
}

export default registerInterviewBulkCancelTools;
