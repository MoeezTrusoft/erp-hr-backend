import { z } from "zod";
import {
  mcpCreateSelfLeaveRequest,
  mcpGetSelfAttendance,
  mcpGetSelfLeaveBalances,
  mcpGetSelfPayslips,
  mcpGetSelfProfile,
  mcpSelfCheckin,
  mcpUpdateSelfProfile,
} from "../controllers/selfMcpController.js";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { withToolError } from "../utils/toolError.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerSelfTools(server) {
  // ── RESOURCES (employee self-service reads) ──────────────────────────────

  server.resource(
    "hr_self_profile",
    "hr://self/profile",
    { description: "Get the current employee's own profile" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpGetSelfProfile(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_self_leave_balance",
    "hr://self/leave-balance",
    { description: "Get the current employee's leave balances" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpGetSelfLeaveBalances(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_self_payslips",
    "hr://self/payslips",
    { description: "Get the current employee's payslips" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpGetSelfPayslips(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_self_attendance",
    "hr://self/attendance",
    { description: "Get the current employee's attendance records" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpGetSelfAttendance(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  // ── TOOLS ────────────────────────────────────────────────────────────────

  server.tool(
    "hr_self_update_profile",
    "Update the current employee's own profile information",
    {
      phone: z.string().optional(),
      address: z.string().optional(),
      emergencyContactName: z.string().optional(),
      emergencyContactPhone: z.string().optional(),
      bio: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user } = getCtx();
      const data = await mcpUpdateSelfProfile(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_self_leave_request",
    "Submit a leave request as the current employee",
    {
      leaveType: z.string().min(1),
      startDate: z.string().describe("ISO 8601 date"),
      endDate: z.string().describe("ISO 8601 date"),
      reason: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user } = getCtx();
      const data = await mcpCreateSelfLeaveRequest(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_self_checkin",
    "Employee self-service check-in",
    {
      location: z.string().optional(),
      notes: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user } = getCtx();
      const data = await mcpSelfCheckin(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
