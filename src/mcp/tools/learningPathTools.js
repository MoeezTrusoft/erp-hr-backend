// src/mcp/tools/learningPathTools.js — Learning Path CRUD (补齐 missing ops).
//
// LearningPath has CREATE via existing tools; this adds LIST, GET, UPDATE, DELETE + enroll.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  listPaths,
  getPath,
  updatePath,
  addCourseToPath,
  enrollEmployee,
} from "../../services/learningPath.service.js";
import prisma from "../../lib/prisma.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerLearningPathTools(server) {
  server.tool(
    "hr_learning_path_list",
    "List all learning paths with pagination",
    {
      page: z.number().int().positive().optional().describe("Page number"),
      limit: z.number().int().positive().optional().describe("Rows per page"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:learning", user.isAdmin);
      const data = await listPaths({ ...args, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_learning_path_list")
  );

  server.tool(
    "hr_learning_path_get",
    "Get a learning path by ID with its courses",
    { id: z.union([z.number(), z.string()]).describe("Learning path ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:learning", user.isAdmin);
      const data = await getPath(id, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_learning_path_get")
  );

  server.tool(
    "hr_learning_path_update",
    "Update a learning path",
    {
      id: z.union([z.number(), z.string()]).describe("Learning path ID"),
      name: z.string().optional().describe("Path name"),
      description: z.string().optional().describe("Path description"),
      targetRole: z.string().optional().describe("Target role"),
    },
    withToolError(async ({ id, ...data }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:learning", user.isAdmin);
      const result = await updatePath(id, data, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }, "hr_learning_path_update")
  );

  server.tool(
    "hr_learning_path_delete",
    "Delete a learning path",
    { id: z.union([z.number(), z.string()]).describe("Learning path ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:learning", user.isAdmin);
      await prisma.learningPath.delete({ where: { id: Number(id) } });
      return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
    }, "hr_learning_path_delete")
  );

  server.tool(
    "hr_learning_path_enroll",
    "Enroll an employee in a learning path",
    {
      pathId: z.union([z.number(), z.string()]).describe("Learning path ID"),
      employeeId: z.union([z.number(), z.string()]).describe("Employee ID"),
    },
    withToolError(async ({ pathId, employeeId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:learning", user.isAdmin);
      const data = await enrollEmployee({ pathId, employeeId, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_learning_path_enroll")
  );
}
