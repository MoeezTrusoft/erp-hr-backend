import { z } from "zod";
import { getCtx } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import * as service from "../../services/attendanceRules.service.js";
import { saveCorrectionRequest, myCorrectionRequests } from '../../services/attendanceCorrectionRequest.service.js';
import * as workspace from '../../services/attendanceWorkspace.service.js';
import { attendanceExportInput, attendanceViewInput } from '../../lib/attendanceWorkspaceSchemas.js';
export function registerAttendanceRulesTools(server) {
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    id = z.number().int().positive();
  const version = z.number().int().nonnegative(),
    reason = z.string().trim().min(1).max(4000);
  const common = { anomalyId: id, version };
  const filters = { site:z.string().max(100).optional(),department:z.string().max(100).optional(),shift:z.string().max(100).optional() };
  const defs = [
    ['export_start',attendanceExportInput.shape,workspace.startAttendanceExport],
    ['exports',{},workspace.listAttendanceExports],
    ['export_status',{id:z.string().uuid()},workspace.readAttendanceExport],
    ['export_download',{id:z.string().uuid(),page:z.number().int().positive().default(1)},workspace.downloadAttendanceExport],
    ['views',{},workspace.listAttendanceViews],
    ['view_save',attendanceViewInput.shape,workspace.saveAttendanceView],
    ['view_delete',{id:z.string().uuid(),version},workspace.deleteAttendanceView],
    ['my_day',{},service.myAttendanceDay],
    ['export_records',{from:date,to:date,...filters,q:z.string().max(50).optional(),status:z.string().max(50).optional(),sortBy:z.enum(['date','employee','status','checkIn','checkOut']).optional(),sortDir:z.enum(['asc','desc']).optional()},service.exportAttendanceRecords],
    ['filter_options',{from:date,to:date},service.attendanceFilterOptions],
    ['employee_options', { q: z.string().trim().max(50).default(''), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(50) }, service.employeeCodeOptions],
    ['correction_mine', { date }, myCorrectionRequests],
    ["correction_save", {
      id: z.string().uuid(), version, date, sessionKey: z.string().min(1).max(160),
      checkIn: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/).nullable(),
      checkOut: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/).nullable(),
      reason: z.string().trim().max(4000), evidence: z.string().trim().max(4000),
      reasonCategory: z.enum(['MISSED_PUNCH','READER_FAILURE','DELAYED_CAPTURE','OTHER']).nullable().optional(),
      evidenceDate: date.nullable().optional(),
    }, saveCorrectionRequest],
    [
      "list",
      {
        ...filters,
        from: date,
        to: date,
        status: z
          .enum(["PENDING", "APPROVED", "REJECTED", "RESOLVED"])
          .optional(),
        employeeId: id.optional(),
        q: z.string().trim().max(50).optional(),
        category: z.enum(['absent','late','early','other']).optional(),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(30),
      },
      service.listRuleCases,
    ],
    ["detail", { anomalyId: id }, service.ruleCaseDetail],
    [
      "comment",
      {
        ...common,
        kind: z.enum(["EMPLOYEE", "MANAGER", "HR"]),
        comment: reason,
        recommendation: z.enum(["APPROVE", "DISAPPROVE"]).optional(),
      },
      service.commentRuleCase,
    ],
    [
      "decide",
      {
        ...common,
        decision: z.enum(["APPROVED", "REJECTED"]),
        comment: reason,
      },
      service.decideRuleCase,
    ],
    [
      "enter_time",
      {
        employeeId: id,
        date,
        sessionKey: z.string().optional(),
        version,
        checkIn: z.string().optional(),
        checkOut: z.string().optional(),
        reason,
      },
      service.enterRuleTime,
    ],
    ["configuration", {}, service.rulesConfiguration],
    [
      "pricing_adopt",
      { payslipId: id, basis: z.string().regex(/^\d+(\.\d{1,4})?$/), reason },
      service.adoptHistoricalPricing,
    ],
    [
      "grace_save",
      {
        scope: z.enum(["COMPANY", "DEPARTMENT", "TEAM", "EMPLOYEE", "SHIFT"]),
        scopeKey: z.string().min(1).max(100),
        effectiveFrom: date,
        checkInMinutes: z.number().int().min(0).max(1440).nullable(),
        checkOutMinutes: z.number().int().min(0).max(1440).nullable(),
        version: z.number().int().min(-1),
        reason,
      },
      service.saveGraceRule,
    ],
    [
      "membership_save",
      {
        employeeId: id,
        effectiveFrom: date,
        teamKey: z.string().max(100).nullable(),
        departmentKey: z.string().max(100).nullable(),
        version: z.number().int().min(-1),
        reason,
      },
      service.saveGraceMembership,
    ],
  ];
  for (const [action, schema, fn] of defs)
    server.tool(
      "hr_attendance_rules_" + action,
      "Attendance anomaly rules: " + action,
      schema,
      withToolError(async (args) => {
        const { user, permissions } = getCtx();
        assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
        if (action === 'export_records') assertPermission(permissions,'EXPORT','hr:attendance',user.isAdmin);
        return {
          content: [
            { type: "text", text: JSON.stringify(await fn({ ...args, user })) },
          ],
        };
      }, "hr_attendance_rules_" + action),
    );
}
