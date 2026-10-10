import { z } from "zod";
import { mcpCtx } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { requireEmployeeActor } from "../../lib/employeeActor.js";
import {
  explainAttendance,
  evaluationOverview,
  saveAttendanceTimeCredit,
  revokeAttendanceTimeCredit,
  reviewAttendancePunch,
} from "../../services/attendanceEvaluation.service.js";
import { queueAttendanceEvaluation } from "../../services/attendanceFinalization.service.js";
import { applyEvaluatedShifts } from "../../services/attendanceWriter.service.js";

export function registerAttendanceEvaluationTools(server) {
  const register = (name, description, schema, fn, needsActor = false) =>
    server.tool(
      name,
      description,
      schema,
      withToolError(async (args) => {
        const { user, permissions } = mcpCtx.getStore() || {};
        if (!user?.tenantId)
          throw Object.assign(new Error("Authentication required"), {
            status: 401,
          });
        assertPermission(permissions, "PUT", "hr:attendance", user.isAdmin);
        const actorEmployeeId = needsActor
          ? await requireEmployeeActor(user)
          : user.employeeId;
        const result = await fn({
          ...args,
          tenantId: user.tenantId,
          actorId: user.id || user.userId || actorEmployeeId,
          actorEmployeeId,
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }, name),
    );
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    employeeId = z.number().int().positive();
  register(
    "hr_attendance_evaluation_overview",
    "Attendance completeness, site totals and evaluation queue health",
    { from: date, to: date },
    evaluationOverview,
  );
  register(
    "hr_attendance_explain",
    "Explain recorded intervals, policy, evidence and calculation revisions",
    { employeeId, date },
    explainAttendance,
  );
  register(
    "hr_attendance_evaluate",
    "Preview or recalculate an open period with immutable revision history",
    {
      from: date,
      to: date,
      employeeIds: z.array(employeeId).min(1).max(1000).optional(),
      dryRun: z.boolean().default(true),
    },
    (args) =>
      args.dryRun
        ? applyEvaluatedShifts({ ...args, trigger: "HR_REPLAY" })
        : queueAttendanceEvaluation(args),
  );
  register(
    "hr_attendance_time_credit",
    "Approve attributed site travel without editing punches",
    {
      employeeId,
      date,
      kind: z.enum(["TRAVEL"]),
      start: z.string().datetime(),
      end: z.string().datetime(),
      fromSiteId: z.string().optional(),
      toSiteId: z.string().optional(),
      paid: z.boolean().default(false),
      reason: z.string().trim().min(1).max(2000),
    },
    saveAttendanceTimeCredit,
    true,
  );
  register(
    "hr_attendance_time_credit_revoke",
    "Revoke an approved time credit with retained history",
    { id: z.string().uuid(), reason: z.string().trim().min(1).max(2000) },
    revokeAttendanceTimeCredit,
    true,
  );
  register(
    "hr_attendance_punch_review",
    "Exclude or restore conflicting punch evidence while retaining original capture",
    {
      id: z.number().int().positive(),
      version: z.number().int().min(0),
      exclude: z.boolean(),
      reason: z.string().trim().min(1).max(2000),
    },
    reviewAttendancePunch,
    true,
  );
}
