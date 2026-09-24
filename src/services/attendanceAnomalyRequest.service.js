// src/services/attendanceAnomalyRequest.service.js
//
// The regularization request form. The employee supplies ONE field — reason.
// Everything else is derived here: application date, applicant, position,
// department, the affected date, the time window, and the category.
//
// Category is never chosen by the requester. It is read off the attendance day
// itself, so somebody who forgot to check out cannot file it as "late" (a
// cheaper deduction) instead.
//
// Position and department are SNAPSHOTS. A transfer six months later must not
// rewrite the record an approval decision was made on.
//
// HR-ATT-POLICY-01.
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { routeAnomaly } from "./attendanceAnomalyRouting.service.js";
import { resolveWorkingDays } from "./workingDay.service.js";
import logger from "../lib/logger.js";

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}
function notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
}

function startOfDay(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest(`Invalid date: ${value}`);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** "HH:MM" on a given day. Returns null when the clock string is unusable. */
function atClock(day, hhmm) {
  if (typeof hhmm !== "string") return null;
  const m = hhmm.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(day);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d;
}

async function loadShift(employeeId, day, tenantId) {
  // Effective-dated: the form must describe the shift in force on the DAY being
  // regularised, not whatever the employee's schedule is today.
  const ws = await prisma.workSchedule.findFirst({
    where: {
      employeeId,
      tenantId,
      effective_start_date: { lte: day },
      OR: [{ effective_end_date: null }, { effective_end_date: { gte: day } }],
    },
    orderBy: { effective_start_date: "desc" },
    select: { schedule_pattern: true },
  });
  const shift = ws?.schedule_pattern?.shift ?? null;
  const from = atClock(day, shift?.from);
  let to = atClock(day, shift?.to);
  // A night shift ends on the following day; without this the window would be
  // negative and every night worker's request would look malformed.
  if (from && to && to <= from) to = new Date(to.getTime() + 24 * 60 * 60 * 1000);
  return { from, to, raw: shift };
}

/**
 * Derive the category and its time window from the attendance day.
 *
 * The window follows the anomaly: a whole-day absence spans the whole shift; a
 * late arrival spans expected -> actual arrival; a missing punch spans the punch
 * that exists -> the shift boundary that is missing.
 */
function deriveCategory({ attendance, shift }) {
  if (!attendance) {
    return {
      type: "ABSENT",
      fromTime: shift.from,
      toTime: shift.to,
      expectedTime: shift.from,
      actualTime: null,
    };
  }

  switch (attendance.status) {
    case "MISSING_CHECKIN":
      return {
        type: "MISSING_CHECKIN",
        fromTime: shift.from,
        toTime: attendance.check_out ?? shift.to,
        expectedTime: shift.from,
        actualTime: null,
      };
    case "MISSING_CHECKOUT":
      return {
        type: "MISSING_CHECKOUT",
        fromTime: attendance.check_in ?? shift.from,
        toTime: shift.to,
        expectedTime: shift.to,
        actualTime: null,
      };
    case "LATE":
    case "HALF_DAY":
      return {
        type: "LATE_CHECKIN",
        fromTime: shift.from,          // expected arrival
        toTime: attendance.check_in,   // actual arrival
        expectedTime: shift.from,
        actualTime: attendance.check_in,
      };
    case "ABSENT":
      return {
        type: "ABSENT",
        fromTime: shift.from,
        toTime: shift.to,
        expectedTime: shift.from,
        actualTime: null,
      };
    default: {
      // PRESENT with an early departure is still worth regularising.
      const leftEarly =
        attendance.check_out && shift.to && attendance.check_out < shift.to;
      if (leftEarly) {
        return {
          type: "EARLY_CHECKOUT",
          fromTime: attendance.check_out,
          toTime: shift.to,
          expectedTime: shift.to,
          actualTime: attendance.check_out,
        };
      }
      return {
        type: "OTHER",
        fromTime: attendance.check_in ?? shift.from,
        toTime: attendance.check_out ?? shift.to,
        expectedTime: shift.from,
        actualTime: attendance.check_in ?? null,
      };
    }
  }
}

async function loadRequester(employeeId, tenantId) {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      tenant_id: true,
      id: true,
      employee_code: true,
      employee_name: true,
      first_name: true,
      last_name: true,
      job_title: true,
      businessUnit: { select: { name: true } },
      // Relation is capital-P on Employee (Position), unlike businessUnit.
      Position: { select: { title: true } },
    },
  });
  if (!employee || employee.tenant_id !== tenantId) {
    throw notFound(`Employee ${employeeId} not found in this tenant`);
  }

  return {
    id: employee.id,
    employee_code: employee.employee_code,
    // employee_name is frequently null in this roster.
    name:
      employee.employee_name ||
      [employee.first_name, employee.last_name].filter(Boolean).join(" ") ||
      employee.employee_code,
    // Position prefers the linked Position record, then the free-text job title.
    position: employee.Position?.title ?? employee.job_title ?? null,
    // Department authoritative source is RBAC; businessUnit is the local
    // equivalent and avoids making a form preview depend on another service.
    department: employee.businessUnit?.name ?? null,
  };
}

/**
 * Everything the form shows before the employee types anything.
 * `reason` is the only field left blank.
 */
export async function getAnomalyFormDefaults({ tenantId, employeeId, date }) {
  const day = startOfDay(date);
  const [requester, shift, attendance] = await Promise.all([
    loadRequester(employeeId, tenantId),
    loadShift(employeeId, day, tenantId),
    prisma.attendance.findFirst({
      where: { tenantId, employeeId, date: day },
      orderBy: { id: "desc" },
    }),
  ]);

  const derived = deriveCategory({ attendance, shift });

  return {
    applicationDate: new Date(),
    applicant: { id: requester.id, name: requester.name, employee_code: requester.employee_code },
    position: requester.position,
    department: requester.department,
    leaveDate: day,
    // category is display-only; the server re-derives it on submit.
    category: derived.type,
    fromTime: derived.fromTime,
    toTime: derived.toTime,
    expectedTime: derived.expectedTime,
    actualTime: derived.actualTime,
    shift: shift.raw,
    attendanceStatus: attendance?.status ?? null,
    reason: null,
  };
}

/**
 * HR-ANOM-DEADLINE-01 — last day the employee may submit a request about this
 * anomaly: TWO WORKING DAYS, per the employee's own roster (weekends/holidays
 * skipped via resolveWorkingDays).
 *
 * LATE / MISSING_CHECKIN / MISSING_CHECKOUT count the anomaly day itself as
 * working day 1 (operator ruling 2026-09-16: "the deadline should include the
 * current working anomaly day as well"); every other type starts the count the
 * day AFTER. A working day is one whose working verdict is not explicitly
 * false — a missing roster verdict never shortens the window.
 */
export async function computeAnomalyDeadline({ tenantId, employeeId, anomalyDate, type }) {
  const day = startOfDay(anomalyDate);
  // Scan generously: a long holiday stretch must never truncate the window.
  const horizonEnd = new Date(day.getTime() + 30 * 86_400_000);
  const working = await resolveWorkingDays({
    tenantId,
    employeeId,
    from: day.toISOString().slice(0, 10),
    to: horizonEnd.toISOString().slice(0, 10),
  });

  // Same key format resolveWorkingDays uses (UTC YYYY-MM-DD) — string compare
  // sorts correctly. (A numeric local-midnight key here would never match the
  // map's string keys and every request would silently fall back.)
  const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
  // Ascending working days from the anomaly day; explicit false = off day.
  const workingDays = [...working.entries()]
    .filter(([, info]) => info?.working !== false)
    .map(([k]) => k)
    .sort();
  const SELF_INCLUSIVE = new Set(["LATE_CHECKIN", "MISSING_CHECKIN", "MISSING_CHECKOUT"]);
  const fromSelfInclusive = SELF_INCLUSIVE.has(type);

  const candidates = workingDays.filter((k) => (fromSelfInclusive ? k >= dayKey(day) : k > dayKey(day)));
  if (candidates.length < 2) {
    // Pathological roster (no working days resolvable) — fall back to the
    // calendar rule rather than leaving the request permanently open.
    const fallback = new Date(day.getTime() + (fromSelfInclusive ? 1 : 2) * 86_400_000);
    return { deadline: fallback, workingDaysUsed: null };
  }
  // HR-ANOM-DEADLINE-PKT — the window closes at KARACHI midnight, not the
  // server's UTC midnight. Operator ruling 2026-09-17: employees live in PKT,
  // and a bare `T23:59:59` (parsed as UTC) closed the window at 04:59:59 AM
  // PKT the next morning. The explicit +05:00 offset pins the close to
  // 23:59:59 PKT = 18:59:59Z regardless of the host timezone.
  return { deadline: new Date(`${candidates[1]}T23:59:59+05:00`), workingDaysUsed: [candidates[0], candidates[1]] };
}

/**
 * Submit the request. `reason` is the only accepted input beyond who and when —
 * category and times are re-derived server-side so a client cannot downgrade its
 * own anomaly to a cheaper one.
 */
export async function createAnomalyRequest({ tenantId, employeeId, date, reason }) {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (!text) throw badRequest("reason is required");

  const day = startOfDay(date);
  const defaults = await getAnomalyFormDefaults({ tenantId, employeeId, date: day });

  // HR-ANOM-DEADLINE-01 — the 2-working-day window, enforced BEFORE any write.
  const { deadline } = await computeAnomalyDeadline({ tenantId, employeeId, anomalyDate: day, type: defaults.category });
  if (new Date() > deadline) {
    throw badRequest(
      `The request window closed on ${deadline.toISOString().slice(0, 10)} — anomaly requests must be submitted within 2 working days`,
    );
  }

  const sourceRef = `regularization:${employeeId}:${day.toISOString().slice(0, 10)}`;

  const anomaly = await tenantTransaction(prisma, async (tx) => {
    const existing = await tx.attendanceAnomaly.findFirst({
      where: { tenantId, sourceKind: "REGULARIZATION", sourceRef },
    });
    // One open request per employee-day. Re-filing while a decision is pending
    // would give the same day two outcomes and, downstream, two deductions.
    if (existing && existing.status === "PENDING") {
      throw badRequest(`A regularization request for ${sourceRef} is already pending`);
    }
    if (existing) {
      throw badRequest(`${sourceRef} was already ${existing.status}`);
    }

    return tx.attendanceAnomaly.create({
      data: {
        tenantId,
        employeeId,
        type: defaults.category,
        reason: text,
        date: day,
        fromTime: defaults.fromTime,
        toTime: defaults.toTime,
        expectedTime: defaults.expectedTime,
        actualTime: defaults.actualTime,
        applicationDate: new Date(),
        positionSnapshot: defaults.position,
        departmentSnapshot: defaults.department,
        sourceKind: "REGULARIZATION",
        sourceRef,
        status: "PENDING",
        currentApprovalLevel: 1,
        // TS-ONBEHALF-01 — the employee filed this themselves (raisedById ===
        // employeeId); the ops path stamps the HR filler instead.
        raisedById: employeeId,
        raisedByName: null,
        requestDeadline: deadline,
      },
    });
  });

  const routing = await routeAnomaly({ tenantId, anomalyId: anomaly.id });

  logger.info(
    { anomalyId: anomaly.id, type: anomaly.type, routed: routing.routed },
    "attendance regularization request created",
  );

  return { anomaly, routing };
}
