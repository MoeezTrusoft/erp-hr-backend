// src/mcp/tools/leaveReportTools.js
//
// MCP tools for the LEAVE half of the "Leave & Anomaly Management" screen. These
// are ADDITIVE (new file) alongside the existing leaveTools.js — they bind the
// screen's KPI cards, leave table, self-service submit, and HR decide flows to
// the leaveReport.service.js surface. All gated on the hr:leave resource key
// (deny-by-default via assertPermission).
//
// KEY WORKFLOW: the leave TYPE is chosen by HR at APPROVAL, not by the employee
// at request time — hr_leave_request_submit intentionally has NO type field;
// hr_leave_decide takes the leaveType (required when decision=approve).
import { z } from "zod";

import {
  getLeaveTypeKpis,
  listLeaveTable,
  requestLeave,
  decideLeave,
} from "../../services/leaveReport.service.js";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerLeaveReportTools(server) {
  // ── KPIs: leave counts by type for a period (GET → hr:leave VIEW) ───────────
  server.tool(
    "hr_leave_type_kpis",
    "Leave & Anomaly screen — leave-type KPI cards: counts of leave requests submitted in a period, grouped by the type HR assigned at approval (annual/sick/casual/maternity/other) plus total. Defaults to the current month.",
    {
      from: z
        .string()
        .optional()
        .describe("ISO 8601 date/datetime — period start (inclusive), matched on request created_at (submitted). Defaults to the 1st of the current month."),
      to: z
        .string()
        .optional()
        .describe("ISO 8601 date/datetime — period end (exclusive), matched on request created_at. Defaults to the 1st of next month."),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:leave", user.isAdmin);
      const data = await getLeaveTypeKpis({ tenantId: user.tenantId, ...args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_leave_type_kpis")
  );

  // ── TABLE: filterable/sortable/paginated leave rows (GET → hr:leave VIEW) ────
  server.tool(
    "hr_leave_table_list",
    "Leave & Anomaly screen — the leave table: filterable, sortable, paginated leave requests. Each row carries employee, assigned type/policy (null while pending), dates, submittedAt, totalDays and status.",
    {
      q: z.string().optional().describe("Free-text search over the employee's name."),
      status: z
        .enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"])
        .optional()
        .describe("Filter by request status."),
      leaveType: z
        .enum(["ANNUAL", "SICK", "CASUAL", "MATERNITY"])
        .optional()
        .describe("Filter by the type HR assigned (by the policy's leaveTypeCode). Pending requests have no type and are excluded when this is set."),
      from: z.string().optional().describe("ISO 8601 date — lower bound on startDate (inclusive)."),
      to: z.string().optional().describe("ISO 8601 date — upper bound on startDate (inclusive)."),
      sortBy: z
        .enum(["submittedAt", "startDate", "status", "totalDays"])
        .optional()
        .describe("Sort field; defaults to submittedAt."),
      sortDir: z
        .enum(["asc", "desc"])
        .optional()
        .describe("Sort direction; defaults to desc."),
      page: z.coerce.number().int().positive().optional().describe("1-based page number; defaults to 1."),
      pageSize: z.coerce.number().int().positive().optional().describe("Rows per page (max 200); defaults to 20."),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:leave", user.isAdmin);
      const data = await listLeaveTable({ tenantId: user.tenantId, ...args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_leave_table_list")
  );

  // ── SUBMIT: employee self-service request, NO type (POST → hr:leave CREATE) ─
  server.tool(
    "hr_leave_request_submit",
    "Leave & Anomaly screen — submit a leave request. NOTE: no leave type is chosen here; the request is created PENDING with no type. HR assigns the leave type when approving (see hr_leave_decide). totalDays is computed as the inclusive Mon–Sat working-day count of the range.",
    {
      startDate: z.string().describe("ISO 8601 date YYYY-MM-DD — first day of leave (required; must be <= endDate)."),
      endDate: z.string().describe("ISO 8601 date YYYY-MM-DD — last day of leave (required; must be >= startDate)."),
      reason: z.string().optional().describe("Optional free-text reason shown on the request."),
      employeeId: z
        .coerce.number()
        .int()
        .optional()
        .describe("Employee id the request is for; defaults to the caller's own employeeId. 400 if neither is present."),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:leave", user.isAdmin);
      const employeeId = args.employeeId ?? user.employeeId;
      if (employeeId == null || employeeId === "") {
        throw Object.assign(
          new Error("employeeId is required (pass one or authenticate as an employee)"),
          { status: 400 }
        );
      }
      const data = await requestLeave({
        tenantId: user.tenantId,
        employeeId,
        startDate: args.startDate,
        endDate: args.endDate,
        reason: args.reason,
        createdById: user.employeeId ?? employeeId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_leave_request_submit")
  );

  // ── DECIDE: HR approve/reject; approve assigns the type (PUT → hr:leave EDIT)
  server.tool(
    "hr_leave_decide",
    "Leave & Anomaly screen — HR decision on a leave request. On approve the leave type is assigned here (resolved to the tenant's LeavePolicy by code) — leaveType is REQUIRED when decision=approve. Reject needs no type. Records a LeaveRequestApproval row; the reviewer is the calling employee.",
    {
      id: z.coerce.number().int().describe("LeaveRequest id to decide (required)."),
      decision: z
        .enum(["approve", "reject"])
        .describe("The decision (required). 'approve' requires leaveType; 'reject' does not."),
      leaveType: z
        .enum(["ANNUAL", "SICK", "CASUAL", "MATERNITY"])
        .optional()
        .describe("Leave type to assign — REQUIRED when decision=approve; resolved to a LeavePolicy by leaveTypeCode. Ignored on reject."),
      comments: z.string().optional().describe("Optional reviewer note, persisted on the approval row."),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:leave", user.isAdmin);
      const data = await decideLeave({
        tenantId: user.tenantId,
        id: args.id,
        decision: args.decision,
        leaveType: args.leaveType,
        comments: args.comments,
        approverId: user.employeeId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_leave_decide")
  );
}
