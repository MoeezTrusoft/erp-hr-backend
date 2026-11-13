// src/mcp/tools/overtimeWorkScheduleTools.js — OvertimeRule LIST/GET + WorkSchedule LIST/GET.
//
// Both models have CREATE/UPDATE/DELETE via existing tools; this adds the read side.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { getOvertimeRules } from "../../services/overtimeService.js";
import { getWorkSchedules, getRosterCoverage } from "../../services/workScheduleService.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerOvertimeWorkScheduleTools(server) {
  // ── OvertimeRule ──────────────────────────────────────────────────────
  server.tool(
    "hr_overtime_rule_list",
    "List all overtime rules",
    z.object({}),
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await getOvertimeRules(user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_overtime_rule_list")
  );

  // ── WorkSchedule ──────────────────────────────────────────────────────
  server.tool(
    "hr_work_schedule_list",
    "List work schedules with optional employee filter",
    {
      employeeId: z.union([z.number(), z.string()]).optional().describe("Filter by employee ID"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await getWorkSchedules({ ...args, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_work_schedule_list")
  );

  // ROSTER-COVERAGE-01 — which active employees have NO schedule in force on a
  // given date. The Schedule screen's coverage widget reads this instead of
  // deriving "active" client-side: termination/rehire truth lives in
  // employment_periods + employement_status server-side, and an employee with
  // no roster in force is derived as working EVERY day — a silent absence
  // deduction machine. AS-AT a date, not just today, so a future-dated rehire
  // does not flip coverage retroactively.
  server.tool(
    "hr_work_schedule_coverage",
    "Roster coverage: active employees without a work schedule in force on a date",
    {
      date: z.string().optional().describe("ISO date (YYYY-MM-DD) to evaluate coverage as-at; defaults to today"),
    },
    withToolError(async ({ date }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await getRosterCoverage({ tenantId: user.tenantId, date });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_work_schedule_coverage")
  );
}
