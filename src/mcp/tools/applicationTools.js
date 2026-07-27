// src/mcp/tools/applicationTools.js — Application LIST + GET (补齐 CRUD).
//
// Application has CREATE/UPDATE_STAGE/UPDATE_STATUS via existing tools; this adds LIST, GET.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { listApplications } from "../../services/applicationService.js";
import prisma from "../../lib/prisma.js";

const APPLICATION_INCLUDE = {
  candidate: true,
  jobRequisition: true,
  interviews: true,
  offer: true,
};

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
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await listApplications({ ...args, tenantId: user.tenantId });
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
      const data = await prisma.application.findUnique({
        where: { id: Number(id) },
        include: APPLICATION_INCLUDE,
      });
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
      await prisma.application.delete({ where: { id: Number(id) } });
      return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
    }, "hr_application_delete")
  );
}
