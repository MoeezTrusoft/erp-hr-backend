// src/mcp/tools/offboardingTaskTools.js — Offboarding task management MCP tools.
//
// Add task, update task for an offboarding checklist.
// Gated on hr:employee and tenant-scoped.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { addTask, updateTask } from "../../services/offboarding.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerOffboardingTaskTools(server) {
  server.tool(
    "hr_offboarding_task_add",
    "Add a task to an offboarding checklist",
    {
      offboardingId: z.union([z.number(), z.string()]).describe("Offboarding checklist ID"),
      title: z.string().min(1).describe("Task title"),
      assigneeId: z.union([z.number(), z.string()]).optional().describe("Assignee employee ID"),
      assigneeType: z.string().optional().describe("Assignee type (HR, MANAGER, IT)"),
      dueDate: z.string().optional().describe("Due date (ISO 8601)"),
      notes: z.string().optional().describe("Task notes"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:employee", user.isAdmin);
      const data = await addTask({ ...args, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_offboarding_task_add")
  );

  server.tool(
    "hr_offboarding_task_update",
    "Update an offboarding task",
    {
      taskId: z.union([z.number(), z.string()]).describe("Task ID"),
      title: z.string().optional().describe("Task title"),
      status: z.string().optional().describe("Task status"),
      assigneeId: z.union([z.number(), z.string()]).optional().describe("Assignee employee ID"),
      dueDate: z.string().optional().describe("Due date"),
      notes: z.string().optional().describe("Task notes"),
    },
    withToolError(async ({ taskId, ...data }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:employee", user.isAdmin);
      const result = await updateTask(taskId, data, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }, "hr_offboarding_task_update")
  );
}
