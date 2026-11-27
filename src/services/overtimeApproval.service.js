import { legacyDecision } from "./approval/legacy.js";
// src/services/overtimeApproval.service.js
//
// Overtime uses the shared employee, manager, HR and Management workflow.
// Legacy payroll matrices remain readable for historical configuration only.
//
// Two ways overtime arrives:
//   * the employee punches overtime in/out on the device — ZKTeco status 4 and
//     5 are Overtime-In and Overtime-Out, and those punches are already stored;
//   * the employee raises a manual request for hours the device did not capture.
//
// Both land in the same queue and follow the same approvals, so approved
// overtime has one meaning regardless of how it was recorded.
//
// Only APPROVED overtime reaches payroll. It is written to
// shift_assignments.overtimeHours for the day, which is what payroll reads —
// pending or rejected hours never appear there.
//
// HR-OT-APPROVAL-01.
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import logger from "../lib/logger.js";
import { legacySubmit } from "./approval/legacy.js";

const badRequest = (m) => Object.assign(new Error(m), { status: 400 });
const notFound = (m) => Object.assign(new Error(m), { status: 404 });
const forbidden = (m) => Object.assign(new Error(m), { status: 403 });

// The civil date the overtime belongs to. Dates are stored as UTC midnight; the
// server clock's zone must not move a day (it used setHours, i.e. server-local).
const startOfDay = (v) => { const d = new Date(v); d.setUTCHours(0, 0, 0, 0); return d; };
const DEFAULT_OVERTIME_RATE = 1.5;

/**
 * HR-OT-RULE-01 — the overtime rule of the roster in force on the day, if any.
 * Rules could be attached to rosters but nothing read them: every request was
 * paid at 1.5x and no limit was checked.
 */
export async function rosterRuleFor(db, { tenantId, employeeId, day }) {
  const roster = await db.workSchedule.findFirst({
    where: {
      tenantId,
      employeeId,
      effective_start_date: { lte: day },
      OR: [{ effective_end_date: null }, { effective_end_date: { gte: day } }],
    },
    include: { overtimeRule: true },
    orderBy: { effective_start_date: "desc" },
  });
  return roster?.overtimeRule?.is_active ? roster.overtimeRule : null;
}

/** The rule's daily and weekly caps (Monday to Sunday), counting live requests. */
async function assertWithinLimits(db, { tenantId, employeeId, day, hours, rule }) {
  if (!rule) return;
  if (rule.max_hours_per_day != null && hours > rule.max_hours_per_day)
    throw badRequest(`The overtime rule "${rule.name}" allows at most ${rule.max_hours_per_day} hours a day`);
  if (rule.max_hours_per_week == null) return;
  const monday = new Date(day);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const nextMonday = new Date(monday);
  nextMonday.setUTCDate(nextMonday.getUTCDate() + 7);
  const week = await db.overtimeRequest.aggregate({
    _sum: { hours: true },
    where: { tenantId, employeeId, date: { gte: monday, lt: nextMonday }, status: { in: ["PENDING", "APPROVED"] } },
  });
  const already = week._sum.hours ?? 0;
  if (already + hours > rule.max_hours_per_week)
    throw badRequest(
      `The overtime rule "${rule.name}" allows at most ${rule.max_hours_per_week} hours a week; ${already} are already requested for that week`,
    );
}

/**
 * The payroll approval chain as it applies to ONE requester.
 *
 * Deliberately the payroll matrix rather than the attendance one: overtime is
 * money, and the instruction was that it follows the same order as payroll.
 * Levels whose approver cannot be resolved, or who ARE the requester, drop out —
 * nobody approves their own overtime.
 */
export async function resolveOvertimeChain({ tenantId, employeeId }) {
  const levels = await prisma.payrollApprovalMatrix.findMany({
    where: { tenantId, status: "ACTIVE" },
    orderBy: [{ level: "asc" }, { id: "asc" }],
  });

  return levels.map((lvl) => {
    let approverId = lvl.approverId ?? null;
    let reason = approverId ? null : "no approver configured";
    if (approverId && approverId === employeeId) {
      approverId = null;
      reason = "approver is the requester";
    }
    return { level: lvl.level, role: lvl.role, approverId, resolved: Boolean(approverId), reason };
  });
}


/** Raise overtime for a day. `source` records whether the device saw it. */
export async function createOvertimeRequest({
  tenantId, employeeId, date, hours, reason, fromTime, toTime, source = "MANUAL", project, submit = null,
}) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) throw badRequest("hours must be greater than 0");
  // A day cannot contain more than a day of overtime; a typo here is expensive.
  if (h > 16) throw badRequest("hours must be 16 or fewer for a single day");
  const text = typeof reason === "string" ? reason.trim() : "";
  if (!text) throw badRequest("reason is required");

  const day = startOfDay(date);
  if (Number.isNaN(day.getTime())) throw badRequest("date must be YYYY-MM-DD");
  const person = await prisma.employee.findFirst({ where: { id: Number(employeeId), tenant_id: tenantId }, select: { id: true } });
  if (!person) throw notFound("Employee not found");
  const rule = await rosterRuleFor(prisma, { tenantId, employeeId, day });
  await assertWithinLimits(prisma, { tenantId, employeeId, day, hours: h, rule });

  const existing = await prisma.overtimeRequest.findFirst({
    where: { tenantId, employeeId, date: day, status: { in: ["PENDING", "APPROVED"] } },
  });
  // One live request per employee-day, or the same hours get approved twice and
  // paid twice.
  if (existing) {
    throw badRequest(`Overtime for ${day.toISOString().slice(0, 10)} is already ${existing.status}`);
  }

  // Capture creates a candidate. Only the employee can submit it for review.

  const request = await tenantTransaction(prisma, async (tx) =>
    tx.overtimeRequest.create({
      data: {
        tenantId, employeeId, date: day, hours: h, reason: text,
        // The roster's rule sets the pay multiplier, sealed on the request so the
        // approvers see the rate that will be paid (HR-OT-RULE-01).
        rate: rule?.daily_overtime_rate ?? DEFAULT_OVERTIME_RATE,
        fromTime: fromTime ?? null, toTime: toTime ?? null,
        project: project ?? null, source,
        status: "PENDING",
        currentApprovalLevel: 1,
        approverId: null,
      },
    }),
  );

  // HR-OT-SUBMIT-01 — a request someone files is sent for approval in the same
  // step: by the employee for themselves, or by HR on their behalf. (It used to
  // stop at INITIATOR until the employee found and submitted it.) Device-detected
  // candidates (submit null) still wait for the employee. If the approval cannot
  // be opened the request is removed, so no orphan stays pending.
  if (submit) {
    try {
      await legacySubmit("OVERTIME", request.id, text, submit === "onBehalf" ? { onBehalf: true } : {});
    } catch (error) {
      await prisma.overtimeRequest.deleteMany({ where: { tenantId, id: request.id, status: "PENDING" } });
      throw error;
    }
    return { request, submitted: true, stage: "SUBMITTED", workflowUrl: "/hr/approvals" };
  }
  return {request,routed:false,level:null,chain:[],stage:'INITIATOR',workflowUrl:'/hr/approvals'};
}

/**
 * Record one decision. REJECTED is terminal; APPROVED advances, and only the
 * final approval writes hours to payroll.
 */
export async function decideOvertimeRequest({ tenantId, requestId, approverId, decision, comments }) {
  return legacyDecision('OVERTIME',requestId);
}

/** Overtime requests waiting on this approver right now. */
export async function listOvertimeForApprover({ tenantId, approverId }) {
  const pending = await prisma.overtimeRequest.findMany({
    where: { tenantId, status: "PENDING" },
    orderBy: [{ date: "asc" }, { id: "asc" }],
  });
  const out = [];
  for (const r of pending) {
    const chain = await resolveOvertimeChain({ tenantId, employeeId: r.employeeId });
    const current = chain.find((c) => c.level === r.currentApprovalLevel);
    if (current?.resolved && current.approverId === approverId) {
      out.push({ ...r, level: current.level, role: current.role });
    }
  }
  return out;
}

/**
 * Raise overtime requests from OVERTIME PUNCHES already on the device.
 *
 * ZKTeco status 4 is Overtime-In and 5 is Overtime-Out; those punches are stored
 * exactly like any other, so overtime the employee actually clocked can become a
 * request without anyone re-typing it. Paired in/out only — a lone overtime
 * punch has no duration and is reported rather than guessed at.
 *
 * Defaults to a dry run: this creates payable claims.
 */
export async function detectOvertimeFromPunches({ tenantId, from, to, dryRun = true }) {
  const punches = await prisma.attendanceDevicePunch.findMany({
    where: {
      tenantId,
      employeeId: { not: null },
      status: { in: [4, 5] },
      punchedAt: { gte: new Date(`${from}T00:00:00`), lte: new Date(`${to}T23:59:59`) },
    },
    select: { employeeId: true, punchedAt: true, status: true },
    orderBy: [{ employeeId: "asc" }, { punchedAt: "asc" }],
  });

  const summary = { from, to, dryRun, overtimePunches: punches.length, created: 0, unpaired: 0, skippedExisting: 0, details: [] };

  const byEmployee = new Map();
  for (const p of punches) {
    if (!byEmployee.has(p.employeeId)) byEmployee.set(p.employeeId, []);
    byEmployee.get(p.employeeId).push(p);
  }

  for (const [employeeId, list] of byEmployee) {
    let open = null;
    for (const p of list) {
      if (p.status === 4) { open = p; continue; }
      if (p.status === 5 && open) {
        const started = open;
        open = null;
        const hours = Number(((p.punchedAt - started.punchedAt) / 3600000).toFixed(2));
        if (hours <= 0 || hours > 16) { summary.unpaired += 1; continue; }
        // Attributed to the day the overtime STARTED, so a session running past
        // midnight is not split across two days.
        const day = startOfDay(started.punchedAt);
        summary.details.push({ employeeId, date: day.toISOString().slice(0, 10), hours });
        if (!dryRun) {
          try {
            await createOvertimeRequest({
              tenantId, employeeId, date: day, hours,
              reason: "Overtime punched on the device",
              source: "DEVICE_PUNCH",
            });
            summary.created += 1;
          } catch (err) {
            if (/already/.test(err?.message || "")) summary.skippedExisting += 1;
            else throw err;
          }
        } else {
          summary.created += 1;
        }
      } else if (p.status === 5) {
        summary.unpaired += 1;   // an overtime-out with no overtime-in
      }
    }
    if (open) summary.unpaired += 1;
  }

  logger[dryRun ? "info" : "warn"](summary, dryRun ? "overtime detection (dry run)" : "overtime requests created from punches");
  return summary;
}
