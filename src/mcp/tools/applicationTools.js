// src/mcp/tools/applicationTools.js — Application LIST + GET (补齐 CRUD).
//
// Application has CREATE/UPDATE_STAGE/UPDATE_STATUS via existing tools; this adds LIST, GET.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  listApplications,
  getApplication,
  deleteApplication,
} from "../../services/applicationService.js";
import { resolveRecruitmentScope } from "../../lib/recruitmentAccess.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerApplicationTools(server) {
  server.tool(
    "hr_application_list",
    "List recruitment applications with optional filters",
    {
      candidateId: z.union([z.number(), z.string()]).optional().describe("Filter by candidate"),
      requisitionId: z.union([z.number(), z.string()]).optional().describe("Filter by requisition"),
      stage: z.string().optional().describe("Filter by stage"),
      status: z.string().optional().describe("Filter by status"),
      page: z.number().int().positive().optional().describe("Page number"),
      limit: z.number().int().positive().optional().describe("Rows per page"),
    },
    withToolError(async ({ requisitionId, ...args }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      // The tool declares `requisitionId` but the service filters on
      // `jobRequisitionId`; passing the argument through under its own name
      // silently dropped the filter and returned the whole page.
      const data = await listApplications({
        ...args,
        jobRequisitionId: requisitionId,
        tenantId: user.tenantId,
        scope: resolveRecruitmentScope(user),
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_application_list")
  );

  server.tool(
    "hr_application_get",
    "Get an application by ID",
    { id: z.union([z.number(), z.string()]).describe("Application ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await getApplication({
        id,
        tenantId: user.tenantId,
        scope: resolveRecruitmentScope(user),
      });
      if (!data) {
        throw Object.assign(new Error("Application not found"), {
          status: 404,
          code: "HR-4040",
        });
      }
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_application_get")
  );

  server.tool(
    "hr_application_delete",
    "Delete a recruitment application",
    { id: z.union([z.number(), z.string()]).describe("Application ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:recruitment", user.isAdmin);
      const deletedId = await deleteApplication({
        id,
        tenantId: user.tenantId,
        scope: resolveRecruitmentScope(user),
      });
      // Same not-found shape as a cross-tenant id: a 403 here would confirm the
      // row exists in another tenant.
      if (deletedId === null) {
        throw Object.assign(new Error("Application not found"), {
          status: 404,
          code: "HR-4040",
        });
      }
      return { content: [{ type: "text", text: JSON.stringify({ success: true, id: deletedId }) }] };
    }, "hr_application_delete")
  );
}
