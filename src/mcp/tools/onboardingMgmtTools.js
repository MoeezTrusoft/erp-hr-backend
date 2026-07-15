// src/mcp/tools/onboardingMgmtTools.js — onboarding list screen tool.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { listOnboarding } from "../../services/onboardingMgmt.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  return { user: ctx?.user || {}, permissions: ctx?.permissions || {} };
}

export function registerOnboardingMgmtTools(server) {
  server.tool(
    "hr_onboarding_manage_list",
    "List onboarding checklists (per new hire) with search, filter (status), sort and pagination.",
    {
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(10),
      q: z.string().optional().describe("Search: employee name or checklist title"),
      status: z.enum(["NOT_STARTED", "IN_PROGRESS", "COMPLETED", "OVERDUE"]).optional(),
      sort: z.string().optional().describe("startDate | targetDate | status | title | completedAt"),
      order: z.enum(["asc", "desc"]).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:onboarding", user.isAdmin);
      const data = await listOnboarding({ page: 1, pageSize: 10, ...args }, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_onboarding_manage_list")
  );
}
