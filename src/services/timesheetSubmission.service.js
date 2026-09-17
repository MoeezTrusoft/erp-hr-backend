// src/services/timesheetSubmission.service.js
//
// TS-SUBMIT-01 (operator item 3, 2026-09-17) — the Submit-Timesheet gatekeeper.
//
// The workflow, as the operator specified it:
//
//   1. The attendance cycle for the payroll month must be LOCKED with the
//      configured attendance lock rule from payroll setup (PayrollCalendar.
//      attendanceCutoff). HR may override timing at their discretion — a
//      `force` flag exists for exactly that (the override itself is audited).
//   2. The timesheet can only be submitted after ALL pending anomaly requests
//      for the month are resolved (approved/disapproved/rejected/cancelled).
//      A pending anomaly is a question about money that nobody has answered.
//   3. Submitting is a mandatory BLOCKER: payroll cannot be initiated for the
//      month until a submission exists.
//
// There is deliberately no new state table: submission is recorded as the
// month's PENDING PayrollRun (the Payroll Vault row the operator described —
// "a payroll run request is automatically activated in the Payroll Vault with
// a Pending status"), plus a payroll_audit_log entry naming the submitter.
// The run is CREATED here but never PROCESSED here — running the calculation
// stays a separate, explicit act on the Payroll Vault screen.
//
// The gate that payroll processing honours: processPayroll* refuses to run a
// month with no submission record (see payrollService.assertTimesheetSubmitted).
import prisma from "../lib/prisma.js";
import { scopedWhere } from "../lib/tenancy.js";
import { AppError } from "../utils/AppError.js";
import { logAction } from "../utils/logs.js";
import { resolvePeriod as resolveReportPeriod } from "./timesheetReport.service.js";

const PENDING_ANOMALY_STATUSES = ["PENDING"];

/** The month window a submission covers (payroll period = calendar month). */
function submissionWindow(month) {
  // resolvePeriod(from, to) returns { from, to, label }; the month window is
  // the report service's default-window rule (1st..last calendar day).
  const { from, to } = resolveReportPeriod(`${month}-01`, null);
  return { from, to };
}

/** Has this month's timesheet been submitted? (submission ⇒ a PayrollRun exists) */
export async function isTimesheetSubmitted(tenantId, month) {
  const { from, to } = submissionWindow(month);
  const run = await prisma.payrollRun.findFirst({
    where: scopedWhere(tenantId, {
      periodStart: { gte: from, lte: to },
      periodEnd: { gte: from, lte: to },
      status: { notIn: ["CANCELLED", "FAILED"] },
    }),
    select: { id: true, status: true, periodStart: true, periodEnd: true },
  });
  return run ? { submitted: true, run } : { submitted: false, run: null };
}

/** Count unresolved anomaly requests inside the month window. */
async function pendingAnomalyCount(tenantId, { from, to }) {
  return prisma.attendanceAnomaly.count({
    where: scopedWhere(tenantId, {
      date: { gte: from, lte: to },
      status: { in: PENDING_ANOMALY_STATUSES },
    }),
  });
}

/**
 * Submit the timesheet for `month` (YYYY-MM) — the gatekeeper.
 *
 * @param {{tenantId:string, month:string, actorEmployeeId?:number|null, actorNote?:string, force?:boolean}} args
 * @returns {Promise<{run:object, created:boolean, pendingAnomalies:number, forced: boolean}>}
 */
export async function submitTimesheet({
  tenantId,
  month,
  actorEmployeeId = null,
  actorNote = null,
  force = false,
}) {
  if (!/^\d{4}-\d{2}$/.test(String(month ?? ""))) {
    throw new AppError("month must be YYYY-MM", 400);
  }
  const who =
    Number.isInteger(actorEmployeeId) && actorEmployeeId > 0
      ? { actorEmployeeId }
      : actorNote
        ? { actorNote }
        : (() => {
            throw new AppError("actorEmployeeId is required to submit a timesheet", 400);
          })();

  const { from, to } = submissionWindow(month);
  const now = new Date();

  // ── Gate 1: attendance cycle locked (PayrollCalendar.attendanceCutoff) ────
  const calendar = await prisma.payrollCalendar.findFirst({
    where: scopedWhere(tenantId, {}),
    select: { attendanceCutoff: true },
  });
  const cutoff = calendar?.attendanceCutoff ?? null;
  const cutoffPassed = cutoff != null && new Date(cutoff).getTime() <= now.getTime();
  if (!cutoffPassed && !force) {
    throw new AppError(
      `HR-TP-01 the attendance cycle for ${month} is not locked yet `
        + `(attendance cutoff ${cutoff ? new Date(cutoff).toISOString() : "not configured"}). `
        + "HR may submit early with an explicit override (force).",
      400,
    );
  }

  // ── Gate 2: zero unresolved anomaly requests for the month ────────────────
  const pendingAnomalies = await pendingAnomalyCount(tenantId, { from, to });
  if (pendingAnomalies > 0) {
    throw new AppError(
      `HR-TP-02 ${pendingAnomalies} unresolved anomaly request(s) for ${month} — `
        + "the timesheet can only be submitted after every anomaly request is resolved "
        + "(approved or disapproved).",
      400,
    );
  }
  // Note: gate 2 has no force escape — an answered question cannot be
  // unanswered by HR discretion, and paying over unresolved anomalies is
  // exactly what the operator's gatekeeper exists to prevent.

  // ── Effect: activate the Payroll Vault run request (PENDING) ──────────────
  const existing = await isTimesheetSubmitted(tenantId, month);
  if (existing.submitted) {
    // Idempotent: a re-submit after edits must not stack duplicate vault rows.
    // But the submission AUDIT row must exist for this run either way — the
    // payroll blocker (HR-TP-03) reads it, and runs created out-of-band
    // (e.g. before this gatekeeper existed) only become processable once HR
    // submits their month through here. Write it when missing.
    const audit = await prisma.payrollAuditLog.findFirst({
      where: scopedWhere(tenantId, {
        action: "TIMESHEET_SUBMITTED",
        payrollRunId: existing.run.id,
      }),
      select: { id: true },
    });
    if (!audit) {
      await prisma.payrollAuditLog.create({
        data: {
          tenantId: tenantId ?? null,
          action: "TIMESHEET_SUBMITTED",
          payrollRunId: existing.run.id,
          details:
            `Timesheet for ${month} submitted by ${
              who.actorEmployeeId != null ? `employee ${who.actorEmployeeId}` : who.actorNote
            }; linked to existing vault run #${existing.run.id} (PENDING)`,
        },
      });
    }
    return {
      run: existing.run,
      created: false,
      pendingAnomalies,
      forced: false,
    };
  }

  const run = await prisma.payrollRun.create({
    data: {
      tenantId: tenantId ?? null,
      periodStart: from,
      periodEnd: to,
      countryCode: "PK",
      currencyCode: "PKR",
      status: "PENDING",
      employeeCount: 0,
    },
  });

  await prisma.payrollAuditLog.create({
    data: {
      tenantId: tenantId ?? null,
      action: "TIMESHEET_SUBMITTED",
      payrollRunId: run.id,
      details:
        `Timesheet for ${month} submitted${force ? " (HR early-submission override)" : ""}`
        + ` by ${who.actorEmployeeId != null ? `employee ${who.actorEmployeeId}` : who.actorNote}`
        + `; vault run #${run.id} activated as PENDING`
        + `${cutoffPassed ? "" : `; cutoff was ${cutoff ? new Date(cutoff).toISOString() : "not configured"}`}`,
    },
  });

  await logAction({
    employeeId: who.actorEmployeeId ?? null,
    type: "Create",
    module: "Payroll Run",
    result: "SUCCESS",
    notes: `Timesheet ${month} submitted — vault run #${run.id} (PENDING)${force ? " [force]" : ""}`,
    tenantId: tenantId ?? null,
  });

  return { run, created: true, pendingAnomalies, forced: Boolean(force) && !cutoffPassed };
}
