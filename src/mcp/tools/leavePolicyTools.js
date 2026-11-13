// src/mcp/tools/leavePolicyTools.js — Leave Policy LIST + GET (补齐 CRUD).
//
// leavePolicy has CREATE/UPDATE/DELETE via existing tools; this adds LIST and GET.
// Uses direct prisma queries (no separate service file).
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import prisma from "../../lib/prisma.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerLeavePolicyTools(server) {
  server.tool(
    "hr_leave_policy_list",
    "List all leave policies with optional search",
    {
      q: z.string().optional().describe("Search by policy name"),
    },
    withToolError(async ({ q } = {}) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:leave", user.isAdmin);
      const where = q ? { name: { contains: q, mode: "insensitive" } } : {};
      const data = await prisma.leavePolicy.findMany({ where, orderBy: { name: "asc" } });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_leave_policy_list")
  );

  server.tool(
    "hr_leave_policy_get",
    "Get a leave policy by ID",
    { id: z.union([z.number(), z.string()]).describe("Leave policy ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:leave", user.isAdmin);
      const data = await prisma.leavePolicy.findUnique({ where: { id: Number(id) } });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_leave_policy_get")
  );
}
