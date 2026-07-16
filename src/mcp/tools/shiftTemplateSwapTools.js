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

const shiftTypeEnum = z.enum(["morning", "evening", "night"]);
const workModeEnum = z.enum(["remote", "hybrid", "onsite"]);
const id = z.union([z.number(), z.string()]);

export function registerShiftTemplateSwapTools(server) {
  // ---- Shift templates ----------------------------------------------------
  server.tool(
    "hr_shift_template_list",
    "List shift templates with the assigned-employee count per template (tenant-scoped)",
    {
      q: z.string().optional(),
      shiftType: shiftTypeEnum.optional(),
      workMode: workModeEnum.optional(),
      sort: z.string().optional(),
      order: z.enum(["asc", "desc"]).optional(),
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().optional(),
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
      name: z.string(),
      fromTime: z.string().describe('e.g. "09:00"'),
      toTime: z.string().describe('e.g. "17:00"'),
      shiftType: shiftTypeEnum.optional(),
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
      id,
      name: z.string().optional(),
      fromTime: z.string().optional(),
      toTime: z.string().optional(),
      shiftType: shiftTypeEnum.optional(),
      workMode: workModeEnum.nullable().optional(),
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
      id,
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
      status: z.enum(["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"]).optional(),
      sort: z.string().optional(),
      order: z.enum(["asc", "desc"]).optional(),
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().optional(),
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
      requesterId: id,
      targetId: id.optional(),
      fromDate: z.string().describe("ISO 8601 date/datetime"),
      toDate: z.string().optional(),
      shiftType: shiftTypeEnum.optional(),
      reason: z.string().optional(),
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
      id,
      targetId: id.nullable().optional(),
      fromDate: z.string().optional(),
      toDate: z.string().nullable().optional(),
      shiftType: shiftTypeEnum.nullable().optional(),
      reason: z.string().nullable().optional(),
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
      id,
      decision: z.enum(["approve", "reject", "withdraw"]),
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
      id,
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:attendance", user.isAdmin);
      const data = await withdrawOvertimeRequest(args, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_overtime_request_withdraw")
  );
}
