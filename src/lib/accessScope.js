// X3 — one rule for "whose records may this caller act on", shared by every T&A
// and payroll function so Employee / Manager / HR / Management behave the same.
//
//   ALL   — a write-class grant on the resource (HR, admin): any employee in the tenant;
//   TEAM  — a line manager: only employees whose managerId is the caller's employee id;
//   SELF  — everyone else: only their own record;
//   NONE  — no identity to scope by: nothing.
//
// Pure functions, no I/O: unit-tested without the MCP stack. The reporting line is
// the authorisation for TEAM (same rule as lib/leaveOnBehalf.js), so a manager needs
// at least a VIEW grant on the resource to see anyone but themselves.
import { hasPermission } from "./assertPermission.js";

export const SCOPE = Object.freeze({ ALL: "ALL", TEAM: "TEAM", SELF: "SELF", NONE: "NONE" });

const WRITE_CLASS = ["CREATE", "EDIT", "DELETE", "EXPORT"];

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * `<resource>_all` VIEW is the read-only, tenant-wide grant (Management): scope ALL with
 * readOnly true. Callers must still assertPermission(...) for any write; ALL here never implies one.
 * @returns {{ scope: string, actingEmployeeId: number|null, readOnly: boolean }}
 * `isManager` is true when the caller has at least one direct report; the caller
 * (a service) looks that up once and passes it in.
 */
export function resolveAccessScope({ user, permissions, resource, isManager = false }) {
  const actingEmployeeId = positiveInt(user?.employeeId);
  if (user?.isAdmin === true || WRITE_CLASS.some((a) => hasPermission(permissions, resource, a))) {
    return { scope: SCOPE.ALL, actingEmployeeId, readOnly: false };
  }
  if (hasPermission(permissions, `${resource}_all`, "VIEW")) return { scope: SCOPE.ALL, actingEmployeeId, readOnly: true };
  if (actingEmployeeId === null) return { scope: SCOPE.NONE, actingEmployeeId, readOnly: false };
  if (isManager && hasPermission(permissions, resource, "VIEW")) {
    return { scope: SCOPE.TEAM, actingEmployeeId, readOnly: false };
  }
  return { scope: SCOPE.SELF, actingEmployeeId, readOnly: false };
}

/** May the caller act on this one employee's record? Pass `write: true` for any change: a read-only scope never passes it. */
export function mayAccessEmployee({ scope, readOnly = false, write = false, actingEmployeeId, targetEmployeeId, targetManagerId }) {
  const target = positiveInt(targetEmployeeId);
  if (target === null || scope === SCOPE.NONE) return false;
  if (write && readOnly) return false;
  if (scope === SCOPE.ALL) return true;
  const acting = positiveInt(actingEmployeeId);
  if (acting === null) return false;
  if (target === acting) return true;
  return scope === SCOPE.TEAM && positiveInt(targetManagerId) === acting;
}

/**
 * Employee ids a list/report query must be limited to: null = no limit (ALL),
 * otherwise the explicit list. Direct reports only (one level), tenant-scoped,
 * never the manager's own manager or an employee who manages themself.
 */
export async function scopedEmployeeIds(db, { tenantId, scope, actingEmployeeId }) {
  if (scope === SCOPE.ALL) return null;
  const acting = positiveInt(actingEmployeeId);
  if (scope === SCOPE.NONE || acting === null) return [];
  if (scope === SCOPE.SELF) return [acting];
  const reports = await db.employee.findMany({
    where: { tenant_id: tenantId, managerId: acting, id: { not: acting } },
    select: { id: true },
  });
  return [acting, ...reports.map((r) => r.id)];
}

/** True when the employee has at least one direct report in this tenant. */
export async function hasDirectReports(db, { tenantId, employeeId }) {
  const id = positiveInt(employeeId);
  if (id === null) return false;
  return (await db.employee.count({ where: { tenant_id: tenantId, managerId: id, id: { not: id } } })) > 0;
}
