// src/services/attendanceCorrection.service.js
//
// HR/admin correction of a single attendance day.
//
// This exists because the device cannot be the only authority: it was out of
// service on some days, people press the wrong key, and HR holds a reconciled
// record the machine never saw. August alone produced 527 employee-days needing
// human review.
//
// Two properties matter more than anything else here:
//
//   1. A correction SURVIVES the next device sync. syncAttendanceFromPunches
//      skips any day flagged manually_corrected. Without that, HR fixes a day,
//      the next push overwrites it, and the whole feature is theatre.
//   2. Every correction is ATTRIBUTED. Who, when, why — written to the day
//      itself and to the Log audit trail. These days feed payroll, so "someone
//      changed it at some point" is not good enough.
//
// HR-ATT-CORRECTION-01.
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { normalizeWorkMode } from "../lib/attendanceStatus.js";
import logger from "../lib/logger.js";

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

const STATUSES = ["PRESENT", "ABSENT", "LATE", "HALF_DAY", "MISSING_CHECKIN", "MISSING_CHECKOUT"];

function startOfDay(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest(`Invalid date: ${value}`);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** "HH:MM" on the given day. A check-out earlier than the check-in rolls to the
 *  next day, so a night shift can be corrected without gymnastics. */
function atClock(day, hhmm, { after = null } = {}) {
  if (hhmm == null || hhmm === "") return null;
  const m = String(hhmm).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw badRequest(`Time must be HH:MM, got "${hhmm}"`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) throw badRequest(`Time out of range: "${hhmm}"`);
  const d = new Date(day);
  d.setHours(h, mi, 0, 0);
  if (after && d <= after) d.setDate(d.getDate() + 1);
  return d;
}

/** Day credit from the corrected status. Kept explicit rather than derived from
 *  hours: HR is stating what the day is worth, not asking us to infer it. */
function creditFor(status) {
  if (status === "PRESENT" || status === "LATE") return 1.0;
  if (status === "HALF_DAY") return 0.5;
  if (status === "ABSENT") return 0.0;
  return null; // MISSING_* stays unresolved
}

export async function correctAttendanceDay({
  tenantId, employeeId, date, checkIn, checkOut, status, workMode, reason, actorEmployeeId,
}) {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (!text) throw badRequest("reason is required — corrections feed payroll and must be explainable");
  if (!Number.isInteger(actorEmployeeId) || actorEmployeeId < 1) {
    throw badRequest("actorEmployeeId is required");
  }
  if (status != null && !STATUSES.includes(status)) {
    throw badRequest(`status must be one of: ${STATUSES.join(", ")}`);
  }

  const day = startOfDay(date);
  const cin = atClock(day, checkIn);
  const cout = atClock(day, checkOut, { after: cin });

  if (cin && cout && cout <= cin) {
    throw badRequest("check-out must be after check-in");
  }

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, tenant_id: true, work_mode: true },
  });
  if (!employee) throw badRequest(`Employee ${employeeId} not found in this tenant`);

  const hours = cin && cout ? Number(((cout - cin) / 3600000).toFixed(2)) : null;
  const finalStatus = status ?? (cin && cout ? "PRESENT" : cin ? "MISSING_CHECKOUT" : "ABSENT");
  const mode = workMode !== undefined ? normalizeWorkMode(workMode) : undefined;

  const result = await tenantTransaction(prisma, async (tx) => {
    const existing = await tx.attendance.findFirst({
      where: { employeeId, date: day },
      orderBy: { id: "desc" },
    });

    const data = {
      check_in: cin,
      check_out: cout,
      total_hours: hours,
      status: finalStatus,
      day_credit: creditFor(finalStatus),
      // HR has ruled on the day, so it is no longer waiting on regularization.
      requires_regularization: false,
      manually_corrected: true,
      corrected_by_id: actorEmployeeId,
      corrected_at: new Date(),
      correction_reason: text,
      ...(mode !== undefined ? { work_mode: mode } : {}),
    };

    const row = existing
      ? await tx.attendance.update({ where: { id: existing.id }, data })
      : await tx.attendance.create({
          data: { employeeId, date: day, tenantId: employee.tenant_id ?? tenantId, ...data },
        });

    // Audit trail. Log is the existing HR audit table and already relates to
    // Attendance, so corrections sit alongside every other tracked action.
    await tx.log.create({
      data: {
        tenantId,
        employeeId,
        attendanceId: row.id,
        actionById: actorEmployeeId,
        type: "ATTENDANCE",
        action_type: existing ? "ATTENDANCE_CORRECTED" : "ATTENDANCE_CREATED_MANUALLY",
        module: "attendance",
        ip: "internal",
        os: "internal",
        result: "success",
        notes: `${day.toISOString().slice(0, 10)}: ` +
               `in=${cin ? cin.toISOString() : "-"} out=${cout ? cout.toISOString() : "-"} ` +
               `status=${finalStatus} credit=${creditFor(finalStatus)} — ${text}`,
      },
    });

    return { row, created: !existing };
  });

  logger.info(
    { employeeId, date: day.toISOString().slice(0, 10), status: finalStatus, by: actorEmployeeId },
    "attendance day corrected",
  );

  return {
    attendanceId: result.row.id,
    created: result.created,
    employeeId,
    date: day,
    check_in: result.row.check_in,
    check_out: result.row.check_out,
    total_hours: result.row.total_hours,
    status: result.row.status,
    day_credit: result.row.day_credit,
    manually_corrected: true,
  };
}

/** Corrections in a window, for review and for proving what was changed. */
export async function listCorrections({ tenantId, from, to, employeeId } = {}) {
  const where = { tenantId, manually_corrected: true };
  if (employeeId) where.employeeId = Number(employeeId);
  if (from || to) {
    where.date = {};
    if (from) where.date.gte = startOfDay(from);
    if (to) where.date.lte = startOfDay(to);
  }
  return prisma.attendance.findMany({
    where,
    select: {
      id: true, employeeId: true, date: true, check_in: true, check_out: true,
      total_hours: true, status: true, day_credit: true,
      corrected_by_id: true, corrected_at: true, correction_reason: true,
    },
    orderBy: [{ date: "asc" }, { employeeId: "asc" }],
  });
}
