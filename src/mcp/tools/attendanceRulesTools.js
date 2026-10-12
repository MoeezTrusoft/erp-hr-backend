import { z } from "zod";
import { getCtx } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import * as service from "../../services/attendanceRules.service.js";
export function registerAttendanceRulesTools(server) {
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    id = z.number().int().positive();
  const version = z.number().int().nonnegative(),
    reason = z.string().trim().min(1).max(4000);
  const common = { anomalyId: id, version };
  const defs = [
    [
      "list",
      {
        from: date,
        to: date,
        status: z
          .enum(["PENDING", "APPROVED", "REJECTED", "RESOLVED"])
          .optional(),
        employeeId: id.optional(),
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
        return {
          content: [
            { type: "text", text: JSON.stringify(await fn({ ...args, user })) },
          ],
        };
      }, "hr_attendance_rules_" + action),
    );
}
