// Attendance month close: one read that tells HR and Management whether a month can be submitted to payroll, and why not.
// It reuses the gates the submit itself enforces, so the screen never says "ready" when the submit would refuse.
import prisma from "../lib/prisma.js";
import { scopedWhere } from "../lib/tenancy.js";
import { AppError } from "../utils/AppError.js";
import { getTimesheetSubmissionState } from "./timesheetSubmission.service.js";
import { assertMonthlyInputsComplete } from "./monthlyPayrollAttendance.service.js";
import { listLongAbsences, DEFAULT_MIN_DAYS } from "./longAbsence.service.js";

const OK = "OK";
const BLOCKING = "BLOCKING";
const WARNING = "WARNING";

const window = (month) => {
  const [y, m] = month.split("-").map(Number);
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 0, 23, 59, 59, 999)) };
};

export const monthOf = (value) => {
  const month = String(value ?? "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new AppError("Choose a month (YYYY-MM)", 400);
  return month;
};

export async function getMonthCloseOverview({ tenantId, month: raw, minDays = DEFAULT_MIN_DAYS, now = new Date() }) {
  const month = monthOf(raw);
  const { from, to } = window(month);
  const state = await getTimesheetSubmissionState(tenantId, month);
  const monthEnded = to.getTime() < now.getTime();
  let monthlyInputs = { ok: true, message: null };
  try {
    await assertMonthlyInputsComplete({ tenantId, month });
  } catch (error) {
    monthlyInputs = { ok: false, message: error?.message ?? "Monthly attendance inputs are incomplete" };
  }
  const run = await prisma.payrollRun.findFirst({
    where: scopedWhere(tenantId, { periodStart: { gte: from, lte: to }, periodEnd: { gte: from, lte: to }, status: { notIn: ["CANCELLED", "FAILED"] } }),
    orderBy: { id: "desc" },
    select: { id: true, status: true },
  });
  const asOf = monthEnded ? to : now;
  const absences = await listLongAbsences({ tenantId, minDays, asOf });

  const processed = Boolean(run && run.status !== "PENDING");
  const issues = state.completeness?.issues?.length ?? 0;
  const checks = [
    {
      code: "CUTOFF",
      label: "Attendance cutoff has passed",
      status: state.attendanceLocked ? OK : BLOCKING,
      overridable: !state.attendanceLocked && monthEnded,
      detail: state.attendanceLocked
        ? "The cycle is locked."
        : monthEnded
          ? "The cutoff has not passed. HR may submit early with a written reason."
          : "The month has not ended, so it cannot be submitted yet.",
    },
    {
      code: "OPEN_REQUESTS",
      label: "No attendance requests waiting for a decision",
      status: state.pendingAnomalies ? BLOCKING : OK,
      count: state.pendingAnomalies,
      detail: state.pendingAnomalies ? `${state.pendingAnomalies} request(s) still need a decision. There is no override.` : "Every request is decided.",
    },
    {
      code: "ATTENDANCE_COMPLETE",
      label: "Attendance is fully calculated",
      status: issues ? BLOCKING : OK,
      count: issues,
      detail: issues ? `${issues} calculation or capture issue(s) are unresolved.` : "Every day is calculated.",
    },
    {
      code: "MONTHLY_INPUTS",
      label: "Payable days entered for monthly-entry employees",
      status: monthlyInputs.ok ? OK : BLOCKING,
      detail: monthlyInputs.ok ? "Nothing missing." : monthlyInputs.message,
    },
    {
      code: "PAYROLL_RUN",
      label: "Payroll not yet processed for this month",
      status: processed ? BLOCKING : OK,
      detail: processed ? `Payroll for this month is already ${run.status.toLowerCase()}, so it cannot be submitted or reopened.` : "No processed payroll.",
    },
    {
      code: "LONG_ABSENCES",
      label: `No one absent ${absences.minDays} or more days in a row`,
      status: absences.employees.length ? WARNING : OK,
      count: absences.employees.length,
      detail: absences.employees.length ? "Review these before payroll prices the days." : "No long absences.",
    },
  ];
  const blockers = checks.filter((c) => c.status === BLOCKING);
  const canSubmit = !state.submitted && !processed && blockers.every((b) => b.code === "CUTOFF" && b.overridable);
  return {
    month,
    monthEnded,
    submitted: Boolean(state.submitted),
    run: state.run ?? run ?? null,
    attendanceCutoff: state.attendanceCutoff,
    checks,
    canSubmit,
    needsOverride: canSubmit && blockers.length > 0,
    canReopen: Boolean(state.submitted && run && run.status === "PENDING"),
    longAbsences: absences,
  };
}
