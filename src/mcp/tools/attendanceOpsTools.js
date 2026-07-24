// src/mcp/tools/attendanceOpsTools.js
//
// MCP tools for the Attendance Anomaly + unified Pending-Approvals surface
// (shared by the HR Timesheet and Leave & Anomaly screens). Wraps the
// attendanceAnomaly + pendingApprovals services. All tools are permission-gated
// (deny-by-default) and error-wrapped via withToolError.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  informAbnormality,
  listAnomalies,
  decideAnomaly,
} from "../../services/attendanceAnomaly.service.js";
import {
  listPendingApprovals,
  decidePendingApproval,
} from "../../services/pendingApprovals.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

const ANOMALY_TYPE = z.enum([
  "LATE_CHECKIN",
  "MISSING_CHECKIN",
  "MISSING_CHECKOUT",
  "EARLY_CHECKOUT",
  "ABSENT",
  "OTHER",
]);

export function registerAttendanceOpsTools(server) {
  // ── ANOMALY: inform / raise (POST → hr:attendance CREATE) ──────────────────
  server.tool(
    "hr_anomaly_inform",
    "Raise an attendance anomaly / time-correction request (status PENDING). employeeId defaults to the calling employee. detail is the free-text specifier and should be supplied when type=OTHER.",
    {
      employeeId: z.coerce
        .number()
        .int()
        .optional()
        .describe("Employee the anomaly is for (references Employee); defaults to the caller's employeeId when omitted (400 if neither)"),
      type: ANOMALY_TYPE.describe(
        "enum AnomalyType (required): one of LATE_CHECKIN | MISSING_CHECKIN | MISSING_CHECKOUT | EARLY_CHECKOUT | ABSENT | OTHER"
      ),
      reason: z.string().optional().describe("Free-text reason for the anomaly"),
      detail: z.string().optional().describe("Free-text detail; required-ish when type=OTHER (the 'specify' text)"),
      date: z.string().optional().describe("Affected work date, ISO 8601 (parsed; invalid → null)"),
      fromTime: z.string().optional().describe("Time-range start, ISO 8601 datetime (parsed; invalid → null)"),
      toTime: z.string().optional().describe("Time-range end, ISO 8601 datetime (parsed; invalid → null)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:attendance", user.isAdmin);
      const employeeId =
        args.employeeId != null ? args.employeeId : user.employeeId;
      if (employeeId == null || employeeId === "") {
        throw Object.assign(
          new Error("employeeId is required (none supplied and no employeeId in session)"),
          { status: 400 }
        );
      }
      const data = await informAbnormality({
        tenantId: user.tenantId,
        employeeId,
        type: args.type,
        reason: args.reason,
        detail: args.detail,
        date: args.date,
        fromTime: args.fromTime,
        toTime: args.toTime,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_anomaly_inform")
  );

  // ── ANOMALY: list (GET → hr:attendance VIEW) ───────────────────────────────
  server.tool(
    "hr_anomaly_list",
    "List attendance anomalies (paginated) with filters and sort for the Leave & Anomaly screen.",
    {
      status: z
        .enum(["PENDING", "APPROVED", "REJECTED"])
        .optional()
        .describe("enum AnomalyStatus filter: one of PENDING | APPROVED | REJECTED"),
      employeeId: z.coerce.number().int().optional().describe("Filter by employee id (references Employee)"),
      type: ANOMALY_TYPE.optional().describe(
        "enum AnomalyType filter: one of LATE_CHECKIN | MISSING_CHECKIN | MISSING_CHECKOUT | EARLY_CHECKOUT | ABSENT | OTHER"
      ),
      q: z.string().optional().describe("Search employee name or reason (case-insensitive contains)"),
      sortBy: z
        .enum(["createdAt", "date", "status"])
        .optional()
        .describe("Sort field: one of createdAt (default) | date | status"),
      sortDir: z.enum(["asc", "desc"]).optional().describe("Sort direction: one of asc | desc (default desc)"),
      page: z.coerce.number().int().positive().optional().describe("1-based page number (default 1)"),
      pageSize: z.coerce.number().int().positive().optional().describe("Page size (default 20, max 200)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await listAnomalies({ tenantId: user.tenantId, ...args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_anomaly_list")
  );

  // ── ANOMALY: decide (PUT → hr:attendance EDIT) ─────────────────────────────
  server.tool(
    "hr_anomaly_decide",
    "Approve or reject an attendance anomaly. The reviewer is the calling employee (session-derived).",
    {
      id: z.coerce.number().int().describe("Anomaly id to decide (required; references AttendanceAnomaly)"),
      decision: z.enum(["approve", "reject"]).describe("Decision (required): one of approve | reject"),
      reviewNote: z.string().optional().describe("Free-text review note stored on the anomaly"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:attendance", user.isAdmin);
      const data = await decideAnomaly({
        tenantId: user.tenantId,
        id: args.id,
        decision: args.decision,
        reviewNote: args.reviewNote,
        reviewerId: user.employeeId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_anomaly_decide")
  );

  // ── PENDING APPROVALS: list (GET → hr:attendance VIEW) ─────────────────────
  server.tool(
    "hr_pending_approvals_list",
    "Unified pending-approvals feed (attendance anomalies + overtime requests, both PENDING) for the Timesheet screen. Sorted by timestamp desc.",
    {
      type: z
        .enum(["anomaly", "overtime"])
        .optional()
        .describe("Filter by source: one of anomaly | overtime (omit for both)"),
      q: z.string().optional().describe("Search employee name (case-insensitive contains)"),
      page: z.coerce.number().int().positive().optional().describe("1-based page number (default 1)"),
      pageSize: z.coerce.number().int().positive().optional().describe("Page size (default 20, max 200)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await listPendingApprovals({ tenantId: user.tenantId, ...args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_pending_approvals_list")
  );

  // ── PENDING APPROVALS: decide (PUT → per-source permission) ────────────────
  server.tool(
    "hr_pending_approval_decide",
    "Approve or reject a pending approval, dispatching by source (anomaly → hr:attendance, overtime → hr:overtime). The reviewer is the calling employee.",
    {
      source: z.enum(["anomaly", "overtime"]).describe("Source (required): one of anomaly | overtime"),
      id: z.coerce.number().int().describe("Request id to decide (required)"),
      decision: z.enum(["approve", "reject"]).describe("Decision (required): one of approve | reject"),
      reason: z.string().optional().describe("Optional reason/note (stored as reviewNote for anomalies; ignored for overtime)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      // Per-source authorization: assert AFTER reading `source` from args.
      if (args.source === "overtime") {
        assertPermission(permissions, "PUT", "hr:overtime", user.isAdmin);
      } else {
        assertPermission(permissions, "PUT", "hr:attendance", user.isAdmin);
      }
      const data = await decidePendingApproval({
        tenantId: user.tenantId,
        source: args.source,
        id: args.id,
        decision: args.decision,
        reason: args.reason,
        reviewerId: user.employeeId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_pending_approval_decide")
  );
}
