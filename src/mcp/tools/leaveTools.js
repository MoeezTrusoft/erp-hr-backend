import { z } from "zod";
import axios from "axios";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";

async function self(method, path, user, data) {
  const PORT = process.env.PORT || 3003;
  const headers = { "X-Internal": "true" };
  if (user?.userId) headers["X-User-ID"] = String(user.userId);
  const r = await axios({ method, url: `http://localhost:${PORT}${path}`, data, headers, timeout: 30000 });
  return r.data;
}


function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerLeaveTools(server) {
  // ── RESOURCES ────────────────────────────────────────────────────────────

  server.resource(
    "hr_leave_requests_list",
    "hr://leaves/requests",
    { description: "List all leave requests" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/leaves/requests", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_leave_policies_list",
    "hr://leaves/policies",
    { description: "List all leave policies" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/leaves/policies", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_leave_balances_list",
    "hr://leaves/balances",
    { description: "List leave balances for all employees" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/leaves/balances", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_leave_pending_approvals",
    "hr://leaves/approvals/pending",
    { description: "Get leave requests pending approval" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/leaves/approvals/pending", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_holidays_list",
    "hr://holidays",
    { description: "List all public holidays" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/holidays/holidays", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  // ── TOOLS ────────────────────────────────────────────────────────────────

  server.tool(
    "hr_leave_request_create",
    "Submit a leave request",
    {
      employeeId: z.string().min(1),
      leaveType: z.string().min(1).describe("Leave type (e.g. ANNUAL, SICK, MATERNITY)"),
      startDate: z.string().describe("ISO 8601 date"),
      endDate: z.string().describe("ISO 8601 date"),
      reason: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/leaves/requests", user.isAdmin);
      const data = await self("POST", "/api/leaves/requests", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_request_approve",
    "Approve a leave request",
    {
      id: z.string().min(1).describe("Leave request ID"),
      comment: z.string().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", `/hr/api/leaves/requests/${id}/approve`, user.isAdmin);
      const data = await self("POST", `/api/leaves/requests/${id}/approve`, user, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_request_reject",
    "Reject a leave request",
    {
      id: z.string().min(1).describe("Leave request ID"),
      reason: z.string().min(1).describe("Reason for rejection"),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", `/hr/api/leaves/requests/${id}/reject`, user.isAdmin);
      const data = await self("POST", `/api/leaves/requests/${id}/reject`, user, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_request_cancel",
    "Cancel a leave request",
    {
      id: z.string().min(1),
      reason: z.string().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/leaves/requests/${id}/cancel`, user.isAdmin);
      const data = await self("PUT", `/api/leaves/requests/${id}/cancel`, user, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_policy_create",
    "Create a new leave policy",
    {
      name: z.string().min(1),
      leaveType: z.string().min(1),
      daysPerYear: z.number().int().positive(),
      carryOver: z.boolean().optional(),
      maxCarryOverDays: z.number().int().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/leaves/policies", user.isAdmin);
      const data = await self("POST", "/api/leaves/policies", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_policy_update",
    "Update a leave policy",
    {
      id: z.string().min(1),
      name: z.string().optional(),
      daysPerYear: z.number().int().optional(),
      carryOver: z.boolean().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/leaves/policies/${id}`, user.isAdmin);
      const data = await self("PUT", `/api/leaves/policies/${id}`, user, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_policy_delete",
    "Delete a leave policy",
    { id: z.string().min(1) },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", `/hr/api/leaves/policies/${id}`, user.isAdmin);
      const data = await self("DELETE", `/api/leaves/policies/${id}`, user);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_balance_update",
    "Update leave balance for an employee",
    {
      employeeId: z.string().min(1),
      leaveType: z.string().min(1),
      balance: z.number(),
    },
    withToolError(async ({ employeeId, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/leaves/balances/${employeeId}`, user.isAdmin);
      const data = await self("PUT", `/api/leaves/balances/${employeeId}`, user, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_leave_accruals_run",
    "Trigger a leave accrual run for all employees",
    {
      asOfDate: z.string().optional().describe("ISO 8601 date; defaults to today"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/leaves/accruals/run", user.isAdmin);
      const data = await self("POST", "/api/leaves/accruals/run", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_holiday_create",
    "Create a public holiday",
    {
      name: z.string().min(1),
      date: z.string().describe("ISO 8601 date"),
      calendarId: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/holidays/holidays", user.isAdmin);
      const data = await self("POST", "/api/holidays/holidays", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
