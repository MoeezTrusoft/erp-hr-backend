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

async function loadShift(employeeId, day) {
  const ws = await prisma.workSchedule.findFirst({
    where: { employeeId },
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

async function loadRequester(employeeId) {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
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
  if (!employee) throw notFound(`Employee ${employeeId} not found`);

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
    loadRequester(employeeId),
    loadShift(employeeId, day),
    prisma.attendance.findFirst({
      where: { employeeId, date: day },
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
 * Submit the request. `reason` is the only accepted input beyond who and when —
 * category and times are re-derived server-side so a client cannot downgrade its
 * own anomaly to a cheaper one.
 */
export async function createAnomalyRequest({ tenantId, employeeId, date, reason }) {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (!text) throw badRequest("reason is required");

  const day = startOfDay(date);
  const defaults = await getAnomalyFormDefaults({ tenantId, employeeId, date: day });

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
