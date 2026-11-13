// F-05 — read-only list of active employees on a long ABSENT streak, so HR can
// raise a separation or leave case before payroll prices the days blindly.
import prisma from "../lib/prisma.js";
import { longAbsences } from "../lib/absenceStreak.js";

export const DEFAULT_MIN_DAYS = 5;
const LOOKBACK_DAYS = 62;

export async function listLongAbsences({ tenantId, minDays = DEFAULT_MIN_DAYS, asOf = new Date(), employeeIds }) {
  const min = Number(minDays);
  if (!Number.isInteger(min) || min < 1 || min > 31) throw Object.assign(new Error("minDays must be a whole number from 1 to 31"), { status: 400 });
  const end = new Date(asOf);
  if (Number.isNaN(+end)) throw Object.assign(new Error("asOf is not a valid date"), { status: 400 });
  const from = new Date(+end - LOOKBACK_DAYS * 86400000);
  const rows = await prisma.attendance.findMany({
    where: {
      tenantId,
      date: { gte: from, lte: end },
      ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
      employee: { OR: [{ employement_status: null }, { employement_status: { not: "Inactive" } }], payroll_included: true },
    },
    select: { employeeId: true, date: true, status: true },
    orderBy: [{ employeeId: "asc" }, { date: "asc" }],
  });
  const byEmployee = new Map();
  for (const r of rows) byEmployee.set(r.employeeId, [...(byEmployee.get(r.employeeId) || []), r]);
  const list = longAbsences(byEmployee, min);
  if (!list.length) return { minDays: min, asOf: end.toISOString().slice(0, 10), employees: [] };
  const people = await prisma.employee.findMany({
    where: { tenant_id: tenantId, id: { in: list.map((l) => l.employeeId) } },
    select: { id: true, employee_code: true, employee_name: true },
  });
  const byId = new Map(people.map((p) => [p.id, p]));
  return {
    minDays: min,
    asOf: end.toISOString().slice(0, 10),
    employees: list.map((l) => ({ ...l, employeeCode: byId.get(l.employeeId)?.employee_code ?? null, name: byId.get(l.employeeId)?.employee_name ?? null })),
  };
}
