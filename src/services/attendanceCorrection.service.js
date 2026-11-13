// Historical day-level corrections remain readable. New entries are per-shift
// immutable evidence, handled by attendanceRules.service.js.
import prisma from '../lib/prisma.js';
import {dateOnly as startOfDay} from '../lib/attendanceDates.js';
export async function correctAttendanceDay() {
  throw Object.assign(new Error('Use Attendance anomaly review: system-generated per-shift cases, HR missing-time entries, and Management-only decisions'),{status:410});
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
  const rows = await prisma.attendance.findMany({
    where,
    select: {
      id: true, employeeId: true, date: true, check_in: true, check_out: true,
      total_hours: true, status: true, day_credit: true,
      corrected_by_id: true, corrected_at: true, correction_reason: true,
    },
    orderBy: [{ date: "asc" }, { employeeId: "asc" }],
  });
  const ids = [...new Set(rows.flatMap(row => [row.employeeId,row.corrected_by_id]).filter(Boolean))];
  const employees = ids.length ? await prisma.employee.findMany({where:{tenant_id:tenantId,id:{in:ids}},select:{id:true,employee_code:true}}) : [];
  const codes = new Map(employees.map(e => [e.id,e.employee_code]));
  return rows.map(row => ({...row,employeeCode:codes.get(row.employeeId) || null,actorCode:codes.get(row.corrected_by_id) || null}));
}
