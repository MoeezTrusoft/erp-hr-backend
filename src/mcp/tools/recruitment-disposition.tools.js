// src/mcp/tools/recruitment-disposition.tools.js
//
// Recruitment Phase 2 — the delayed, reversible system dispositions (today the
// knockout rejection scheduled at intake).
//
// Who may do what:
//   * list: any recruitment scope, cut to the applications the caller can see
//     (applicationScopeWhere) — a hiring manager sees the pending knockouts on
//     their own requisitions, FINANCE/AGENCY see none.
//   * cancel: ORG (recruiters) only, with a reason. Overruling a disposition is
//     a disposition decision, and those are ORG-only.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { resolveRecruitmentScope } from "../../lib/recruitment-access.util.js";
import {
  DISPOSITION_STATUS,
  cancelScheduledDisposition,
  listScheduledDispositions,
} from "../../services/scheduled-disposition.service.js";

const RESOURCE = "hr:recruitment";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return { user: ctx.user, permissions: ctx?.permissions || {} };
}

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

const idInput = z.union([z.string(), z.number()]);

export function registerRecruitmentDispositionTools(server) {
  server.tool(
    "hr_application_scheduled_disposition_list",
    "List scheduled (delayed, reversible) system dispositions such as knockout rejections, with when each runs and its status (PENDING | EXECUTED | CANCELLED | FAILED), limited to the applications you can see",
    {
      requisitionId: idInput.optional().describe("Only this requisition's applications"),
      applicationId: idInput.optional().describe("Only this application"),
      status: z.enum(Object.values(DISPOSITION_STATUS)).optional().describe("Filter by status"),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(100).optional().describe("Page size (default 50, max 100)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const data = await listScheduledDispositions({
        tenantId: user.tenantId,
        scope: resolveRecruitmentScope(user),
        requisitionId: args.requisitionId,
        applicationId: args.applicationId,
        status: args.status,
        page: args.page,
        limit: args.limit,
      });
      return text(data);
    }, "hr_application_scheduled_disposition_list"),
  );

  server.tool(
    "hr_application_scheduled_disposition_cancel",
    "Cancel a PENDING scheduled disposition (recruiters only) so the application is not rejected by the system; give the disposition id or the application id, and a reason",
    {
      id: idInput.optional().describe("Scheduled disposition id"),
      applicationId: idInput.optional().describe("Application id (cancels its pending knockout disposition)"),
      reason: z.string().min(1).max(500).describe("Why the disposition is overruled"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
      const scope = resolveRecruitmentScope(user);
      const data = await cancelScheduledDisposition({
        id: args.id,
        applicationId: args.applicationId,
        tenantId: user.tenantId,
        actorId: scope.employeeId,
        reason: args.reason,
        scope,
      });
      return text(data);
    }, "hr_application_scheduled_disposition_cancel"),
  );
}
