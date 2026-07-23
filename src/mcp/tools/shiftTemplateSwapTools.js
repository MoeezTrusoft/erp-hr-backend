// src/mcp/tools/shiftTemplateSwapTools.js — Shift Templates, Shift Swap
// requests, and Overtime withdraw MCP tools.
//
// Surfaces the HR "Shift Templates" library, the "Shift Swap" request workflow,
// and the overtime withdraw action as MCP tools (all gated on hr:attendance).
// Every handler resolves the request context locally (getCtx over
// mcpCtx.getStore()) and threads the verified tenant into the tenant-scoped
// service. Approve/reject of overtime stays on hr_overtime_request_decide.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  listShiftTemplates,
  createShiftTemplate,
  updateShiftTemplate,
  deleteShiftTemplate,
  listShiftSwaps,
  createShiftSwap,
  updateShiftSwap,
  decideShiftSwap,
  withdrawOvertimeRequest,
} from "../../services/shiftTemplateSwap.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

const shiftTypeEnum = z
  .enum(["morning", "evening", "night"])
  .describe("Shift band — one of morning | evening | night");
const workModeEnum = z
  .enum(["remote", "hybrid", "onsite"])
  .describe("Work mode — one of remote | hybrid | onsite");
const id = z.union([z.number(), z.string()]);

export function registerShiftTemplateSwapTools(server) {
  // ---- Shift templates ----------------------------------------------------
  server.tool(
    "hr_shift_template_list",
    "List shift templates with the assigned-employee count per template (tenant-scoped)",
    {
      q: z.string().optional().describe("Free-text search on template name (case-insensitive)"),
      shiftType: shiftTypeEnum.optional(),
      workMode: workModeEnum.optional(),
      sort: z.string().optional().describe("Sort field — one of name | fromTime | toTime | shiftType | workMode | createdAt | id"),
      order: z.enum(["asc", "desc"]).optional().describe("Sort direction — asc | desc"),
      page: z.coerce.number().int().positive().optional().describe("1-based page number; defaults to 1"),
      pageSize: z.coerce.number().int().positive().optional().describe("Rows per page; defaults to 20"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await listShiftTemplates(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_shift_template_list")
  );

  server.tool(
    "hr_shift_template_create",
    "Create a shift template",
    {
      name: z.string().min(1).describe("Template display name"),
      fromTime: z.string().min(1).describe('Start time, e.g. "09:00"'),
      toTime: z.string().min(1).describe('End time, e.g. "17:00"'),
      shiftType: shiftTypeEnum.optional().describe("Shift band — one of morning | evening | night; defaults to morning"),
      workMode: workModeEnum.optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:attendance", user.isAdmin);
      const data = await createShiftTemplate(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_shift_template_create")
  );

  server.tool(
    "hr_shift_template_update",
    "Update editable fields of a shift template",
    {
      id: id.describe("ShiftTemplate id to update (references ShiftTemplate.id)"),
      name: z.string().min(1).optional().describe("New template name"),
      fromTime: z.string().min(1).optional().describe('New start time, e.g. "09:00"'),
      toTime: z.string().min(1).optional().describe('New end time, e.g. "17:00"'),
      shiftType: shiftTypeEnum.optional(),
      workMode: workModeEnum.nullable().optional().describe("Work mode — one of remote | hybrid | onsite; null clears it"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:attendance", user.isAdmin);
      const data = await updateShiftTemplate(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_shift_template_update")
  );

  server.tool(
    "hr_shift_template_delete",
    "Hard-delete a shift template (tenant-scoped)",
    {
      id: id.describe("ShiftTemplate id to delete (references ShiftTemplate.id)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:attendance", user.isAdmin);
      const data = await deleteShiftTemplate(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_shift_template_delete")
  );

  // ---- Shift swap requests ------------------------------------------------
  server.tool(
    "hr_shift_swap_list",
    "List shift swap requests (paginated, tenant-scoped); requester/target/approver resolved to names",
    {
      status: z
        .enum(["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"])
        .optional()
        .describe("Status filter — one of PENDING | APPROVED | REJECTED | WITHDRAWN"),
      sort: z.string().optional().describe("Sort field — one of fromDate | toDate | status | createdAt | decidedAt | id"),
      order: z.enum(["asc", "desc"]).optional().describe("Sort direction — asc | desc"),
      page: z.coerce.number().int().positive().optional().describe("1-based page number; defaults to 1"),
      pageSize: z.coerce.number().int().positive().optional().describe("Rows per page; defaults to 20"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await listShiftSwaps(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_shift_swap_list")
  );

  server.tool(
    "hr_shift_swap_create",
    "Create a shift swap request (status PENDING)",
    {
      requesterId: id.describe("Employee id requesting the swap (references Employee.id)"),
      targetId: id.optional().describe("Employee id to swap with (references Employee.id)"),
      fromDate: z.string().describe("ISO 8601 date YYYY-MM-DD — the requester's shift date"),
      toDate: z.string().optional().describe("ISO 8601 date YYYY-MM-DD — the target's shift date"),
      shiftType: shiftTypeEnum.optional(),
      reason: z.string().optional().describe("Optional reason for the swap"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:attendance", user.isAdmin);
      const data = await createShiftSwap(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_shift_swap_create")
  );

  server.tool(
    "hr_shift_swap_update",
    "Update a shift swap request (only while PENDING)",
    {
      id: id.describe("ShiftSwapRequest id to update (references ShiftSwapRequest.id); must be PENDING"),
      targetId: id.nullable().optional().describe("Employee id to swap with (references Employee.id); null clears it"),
      fromDate: z.string().optional().describe("ISO 8601 date YYYY-MM-DD — the requester's shift date"),
      toDate: z.string().nullable().optional().describe("ISO 8601 date YYYY-MM-DD; null clears it"),
      shiftType: shiftTypeEnum.nullable().optional().describe("Shift band — one of morning | evening | night; null clears it"),
      reason: z.string().nullable().optional().describe("Reason for the swap; null clears it"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:attendance", user.isAdmin);
      const data = await updateShiftSwap(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_shift_swap_update")
  );

  server.tool(
    "hr_shift_swap_decide",
    "Approve, reject, or withdraw a shift swap request; sets decidedAt (approve/reject stamp the caller as approver)",
    {
      id: id.describe("ShiftSwapRequest id to decide (references ShiftSwapRequest.id)"),
      decision: z
        .enum(["approve", "reject", "withdraw"])
        .describe("Decision — one of approve | reject | withdraw"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:attendance", user.isAdmin);
      const approverEmployeeId = user.employeeId ?? user.userId;
      const data = await decideShiftSwap(
        { ...args, approverEmployeeId },
        user.tenantId
      );
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_shift_swap_decide")
  );

  // ---- Overtime withdraw --------------------------------------------------
  server.tool(
    "hr_overtime_request_withdraw",
    "Withdraw an overtime request (status WITHDRAWN); approve/reject use hr_overtime_request_decide",
    {
      id: id.describe("OvertimeRequest id to withdraw (references OvertimeRequest.id)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:attendance", user.isAdmin);
      const data = await withdrawOvertimeRequest(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_overtime_request_withdraw")
  );
}
