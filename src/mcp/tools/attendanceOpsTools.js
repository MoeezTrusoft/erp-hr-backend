// src/mcp/tools/attendanceOpsTools.js
//
// MCP tools for the Attendance Anomaly + unified Pending-Approvals surface
// (shared by the HR Timesheet and Leave & Anomaly screens). Wraps the
// attendanceAnomaly + pendingApprovals services. All tools are permission-gated
// (deny-by-default) and error-wrapped via withToolError.
import { anomalyAttachmentsSchema } from './anomalyAttachmentSchema.js';
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  informAbnormality,
  listAnomalies,
  decideAnomaly,
  updateAnomaly,
  deleteAnomaly,
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
    "Raise an attendance anomaly request (status PENDING). The anomaly type is assigned from the stored attendance day; only the reason is supplied.",
    {
      employeeId: z.coerce
        .number()
        .int()
        .optional()
        .describe("Employee the anomaly is for (references Employee); defaults to the caller's employeeId when omitted (400 if neither)"),
      attachments: anomalyAttachmentsSchema,
      reason: z.string().optional().describe("Free-text reason for the anomaly"),
      detail: z.string().optional().describe("Optional additional detail"),
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
        attachments: args.attachments,
        reason: args.reason,
        detail: args.detail,
        date: args.date,
        fromTime: args.fromTime,
        toTime: args.toTime,
        // TS-ONBEHALF-01 — the FILLER is the calling employee (HR when raised
        // on an employee's behalf), NOT the anomaly's subject employee.
        raisedById: user.employeeId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_anomaly_inform")
  );

  // ── ANOMALY: create (POST → hr:attendance CREATE) ─────────────────────────
  // T-FIX: the frontend hr-manifest has listed hr_anomaly_create as a write
  // tool since M2 and hr-mock.js serves it (aliased to inform), but NO real
  // tool was registered — a manifest write was a guaranteed tool-not-found at
  // the gateway. Registered with the same semantics as hr_anomaly_inform (the
  // mock's contract): generic raise, PENDING, employeeId defaults to caller.
  // The times-aware self-service flow remains hr_attendance_anomaly_create.
  server.tool(
    "hr_anomaly_create",
    "Raise an attendance anomaly request (status PENDING). The anomaly type and times are derived from the stored attendance day.",
    {
      employeeId: z.coerce
        .number()
        .int()
        .optional()
        .describe("Employee the anomaly is for (references Employee); defaults to the caller's employeeId when omitted (400 if neither)"),
      attachments: anomalyAttachmentsSchema,
      reason: z.string().optional().describe("Free-text reason for the anomaly"),
      detail: z.string().optional().describe("Optional additional detail"),
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
        attachments: args.attachments,
        reason: args.reason,
        detail: args.detail,
        date: args.date,
        fromTime: args.fromTime,
        toTime: args.toTime,
        raisedById: user.employeeId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_anomaly_create")
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
        "Filter by system-assigned anomaly type"
      ),
      sourceKind: z.enum(["REGULARIZATION", "evaluator", "IMPORT", "DISAPPROVED_LEAVE"]).optional()
        .describe("Filter by origin; REGULARIZATION means an employee-submitted form."),
      raised: z.boolean().optional()
        .describe(
          "When true, list only requests that were actually raised (employee-submitted or paper forms entered by HR). " +
            "Excludes system-generated rows (evaluator-detected anomalies etc.), which are attendance evidence, not requests."
        ),
      q: z.string().optional().describe("Search employee name or reason (case-insensitive contains)"),
      // T&A-MONTH-FILTER (operator, 2026-10-06) — the Timesheet month
      // selector. Both bound the request's OWN DAY ("For date"), inclusive,
      // not the day the request was filed on.
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD")
        .optional()
        .describe("Inclusive first 'For date' of the period (YYYY-MM-DD)"),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD")
        .optional()
        .describe("Inclusive last 'For date' of the period (YYYY-MM-DD)"),
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

  // ── ANOMALY: edit (PUT → hr:attendance EDIT) ────────────────────────────────
  // HR edit of a PENDING anomaly request. Category, date, status, decisions and
  // raise-info remain system-controlled; only explanation and time detail change.
  server.tool(
    "hr_anomaly_update",
    "Edit the explanation and time details on a PENDING attendance anomaly request. Category, date, decisions and raise metadata are not editable.",
    {
      id: z.coerce.number().int().describe("Anomaly id to edit (required; references AttendanceAnomaly)"),
      // Explicit JSON nulls from the editor mean leave unchanged.
      reason: z.string().nullable().optional().describe("New reason text (optional)"),
      detail: z.string().nullable().optional().describe("New detail text (optional; use for OTHER specify)"),
      fromTime: z.string().nullable().optional().describe("New time-range start, ISO 8601 datetime (optional)"),
      toTime: z.string().nullable().optional().describe("New time-range end, ISO 8601 datetime (optional)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:attendance", user.isAdmin);
      const data = await updateAnomaly({
        tenantId: user.tenantId,
        id: args.id,
        reason: args.reason,
        detail: args.detail,
        fromTime: args.fromTime,
        toTime: args.toTime,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_anomaly_update")
  );

  // ── ANOMALY: delete (DELETE → hr:attendance) ───────────────────────────────
  // TS-ANOM-DELETE-01/2 — withdraw a PENDING request. The edge gate below IS
  // the whole rule: DELETE hr:attendance is held only by the Admin and HR
  // Manager roles (RBAC data verified 2026-10-09; no user-level overrides),
  // so once assertPermission passes, HR/admin may withdraw ANY pending
  // request — the service is told via requesterCanDeleteAny. The
  // subject/filer rule remains for service callers without this edge.
  // Decided requests stay immutable: that guard lives in the service.
  server.tool(
    "hr_anomaly_delete",
    "Withdraw a PENDING attendance anomaly request. Allowed for the employee the request is about, the HR user who raised it on their behalf, or any HR/admin user holding DELETE hr:attendance (Admin / HR Manager). Decided (APPROVED/REJECTED) requests cannot be deleted.",
    {
      id: z.coerce.number().int().describe("Anomaly id to delete (required; references AttendanceAnomaly)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:attendance", user.isAdmin);
      const data = await deleteAnomaly({
        tenantId: user.tenantId,
        id: args.id,
        requesterEmployeeId: user.employeeId,
        requesterCanDeleteAny: true, // DELETE hr:attendance asserted above (Admin/HR Manager)
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_anomaly_delete")
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
