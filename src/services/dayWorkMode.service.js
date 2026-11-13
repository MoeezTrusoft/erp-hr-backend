// src/services/dayWorkMode.service.js
//
// Sudden WFH: set the work mode for ONE employee on ONE day.
//
// Before this, work_mode came from Employee.work_mode — the person's default —
// so "work from home tomorrow" had nowhere to live. The day was recorded as
// Onsite whatever actually happened, and the WFH/Remote KPI counted it wrong.
//
// The override is stored on the per-date shift_assignments row, which already
// carries workMode and is the natural home for anything true of one day only.
// Any Attendance row already written for that day is updated too, so a mode set
// after the fact corrects history rather than only applying going forward.
//
// HR-ATT-POLICY-01.
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { normalizeWorkMode } from "../lib/attendanceStatus.js";
import logger from "../lib/logger.js";

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function startOfDay(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest(`Invalid date: ${value}`);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** shift_assignments stores the lowercase form; Attendance stores canonical. */
const TO_ASSIGNMENT = { Remote: "remote", Hybrid: "hybrid", Onsite: "onsite" };

/**
 * The work mode in force for one employee on one day: the per-day override if
 * there is one, otherwise the employee's default.
 */
export async function getDayWorkMode({ employeeId, date }) {
  const day = startOfDay(date);
  const [assignment, employee] = await Promise.all([
    prisma.shiftAssignment.findFirst({
      where: { employeeId, date: day },
      orderBy: { id: "desc" },
      select: { workMode: true },
    }),
    prisma.employee.findUnique({ where: { id: employeeId }, select: { work_mode: true } }),
  ]);

  const override = normalizeWorkMode(assignment?.workMode);
  return {
    workMode: override ?? normalizeWorkMode(employee?.work_mode),
    source: override ? "DAY_OVERRIDE" : "EMPLOYEE_DEFAULT",
  };
}

/**
 * Set (or clear) the work mode for one day.
 *
 * `workMode: null` removes the override, so the day falls back to the
 * employee's default rather than being pinned to a stale value.
 */
export async function setDayWorkMode({ tenantId, employeeId, date, workMode, note }) {
  const day = startOfDay(date);

  let canonical = null;
  if (workMode != null) {
    canonical = normalizeWorkMode(workMode);
    if (!canonical) throw badRequest("workMode must be Remote, Hybrid, Onsite (or null to clear)");
  }

  return tenantTransaction(prisma, async (tx) => {
    const existing = await tx.shiftAssignment.findFirst({
      where: { employeeId, date: day },
      orderBy: { id: "desc" },
    });

    const assignmentMode = canonical ? TO_ASSIGNMENT[canonical] : null;

    let assignment;
    if (existing) {
      assignment = await tx.shiftAssignment.update({
        where: { id: existing.id },
        // Keep the existing shift; only the mode moves.
        data: { workMode: assignmentMode ?? "onsite", updatedAt: new Date() },
      });
    } else {
      assignment = await tx.shiftAssignment.create({
        data: {
          tenantId,
          employeeId,
          date: day,
          shiftType: "morning",
          workMode: assignmentMode ?? "onsite",
          status: "on_shift",
          overtimeHours: 0,
        },
      });
    }

    // Correct any Attendance already written for that day. Without this a mode
    // set after the shift would leave the recorded day saying Onsite.
    const attendance = await tx.attendance.findFirst({
      where: { employeeId, date: day },
      orderBy: { id: "desc" },
      select: { id: true },
    });
    if (attendance) {
      await tx.attendance.update({
        where: { id: attendance.id },
        data: {
          work_mode: canonical,
          ...(note ? { remarks: note } : {}),
        },
      });
    }

    logger.info(
      { employeeId, date: day.toISOString().slice(0, 10), workMode: canonical, attendanceUpdated: Boolean(attendance) },
      "day work mode set",
    );

    return {
      employeeId,
      date: day,
      workMode: canonical,
      cleared: canonical === null,
      assignmentId: assignment.id,
      attendanceUpdated: Boolean(attendance),
    };
  });
}
