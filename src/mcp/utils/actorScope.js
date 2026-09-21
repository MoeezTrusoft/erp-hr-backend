// src/mcp/utils/actorScope.js — HR-RBAC-01 (2026-09-21, T1.1).
//
// The payslip IDOR root cause: "my payslip" tools treated an explicit
// payslipId/employeeId argument as an ADMIN-view selector whenever the session
// held hr:payroll:VIEW — and after the Employee-role grant remediation nearly
// every employee carries at least one hr VIEW. Entitlement to the payroll ADMIN
// surface must never be inferred from a read-only grant.
//
// This helper is the single authorization decision for "may this session act on
// OTHER employees' data in the my-payslip family": the caller must hold the
// payroll or employee WRITE/EXPORT gate (the admin surface), or be a verified
// admin per the verified service-JWT claim (never a client header).
//
// D1=A ruling: employees keep reading their OWN rows; a session without the
// admin surface is hard-scoped to the acting employee everywhere it lands —
// explicit employeeId/payslipId arguments selecting someone else are refused,
// not silently remapped, so misuse is observable in logs.
import { hasPermission } from "./assertPermission.js";

// Actions that prove the caller belongs on the payroll/employee ADMIN surface.
const ADMIN_SURFACE_ACTIONS = ["EDIT", "EXPORT", "CREATE", "DELETE"];

// Attendance admin surface: anyone who may write attendance (corrections,
// manual punches, imports) or export it may read everyone's. A VIEW-only
// session (a plain Employee) reads only their own rows (plan T1.5).
const ATTENDANCE_ADMIN_ACTIONS = ["EDIT", "EXPORT", "CREATE", "DELETE"];

/**
 * Attendance/timesheet read scope (T1.5, ruling D1=A): a caller with the
 * attendance WRITE surface reads tenant-wide; everyone else is pinned to the
 * acting employee. Returns the effective employeeId to force downstream
 * (null = no pinning — the tenant-wide path).
 */
// HR-RBAC-01 T1.6 (ruling D2=Hidden) — the employee directory is an HR
// surface. A session without hr:employee VIEW gets nothing from it — not a
// sanitized subset: an employee roster, even names-only, is exactly the
// org-chart / reporting-line data this ruling was meant to protect. The one
// sanctioned exception is hr_employee_resolve (display name + work email for
// cross-service recipient cards), which lives outside this gate.
export function assertDirectoryAccess(permissions) {
  if (!hasPermission(permissions, "hr:employee", "VIEW")) {
    throw Object.assign(
      new Error("Insufficient permissions: hr:employee:VIEW"),
      { statusCode: 403, status: 403, code: "HR-4030" },
    );
  }
}

// HR-RBAC-01 T1.7 — the payroll ADMIN surface (employee grids, payslip
// listings, run lists, money KPIs) requires a WRITE/EXPORT-class grant, not a
// read. A VIEW-only session is refused outright (ruling D4: employees get the
// Forbidden page) — self-service money reads are the hr_my_payslip* family,
// which gate on identity, not on this surface.
export function assertPayrollAdminSurface(permissions) {
  const ok = ADMIN_SURFACE_ACTIONS.some((action) => hasPermission(permissions, "hr:payroll", action));
  if (!ok) {
    throw Object.assign(
      new Error("Insufficient permissions: hr:payroll:VIEW is not sufficient for the payroll admin surface"),
      { statusCode: 403, status: 403, code: "HR-4030" },
    );
  }
}

export function resolveAttendanceReadScope(user, permissions) {
  const canViewOthers =
    user?.isAdmin === true ||
    ATTENDANCE_ADMIN_ACTIONS.some((action) => hasPermission(permissions, "hr:attendance", action));
  if (canViewOthers) return { canViewOthers, employeeId: null };
  const n = Number(user?.employeeId);
  return { canViewOthers: false, employeeId: Number.isInteger(n) && n > 0 ? n : null };
}

function isAdminClaim(user) {
  return user?.isAdmin === true;
}

/**
 * Resolve the actor scope for a my-payslip-family call.
 *
 * @param {{}} user        ctx.user (verified claims: employeeId, isAdmin, …)
 * @param {{}} permissions ctx.permissions (RBAC blob or dotted list)
 * @returns {{ actingEmployeeId: number|null, canViewOthers: boolean }}
 */
export function resolveActorScope(user, permissions) {
  const raw = user?.employeeId;
  const n = Number(raw);
  const actingEmployeeId = Number.isInteger(n) && n > 0 ? n : null;

  const canViewOthers =
    isAdminClaim(user) ||
    ADMIN_SURFACE_ACTIONS.some((action) => hasPermission(permissions, "hr:payroll", action)) ||
    ADMIN_SURFACE_ACTIONS.some((action) => hasPermission(permissions, "hr:employee", action));

  return { actingEmployeeId, canViewOthers };
}

/**
 * Refuse a client-supplied employeeId that a non-admin-surface session may not
 * select. Returns the effective employeeId to use downstream:
 *   • admin surface  → explicit ?? acting ?? null (null = let the row decide,
 *     HR-PAYSLIP-ADMIN-VIEW-01 stays intact)
 *   • employee scope → acting only; any DIFFERENT explicit id throws 403
 */
export function assertEmployeeScope({ user, permissions, explicit, actingEmployeeId, canViewOthers, allowUnbound = false }) {
  const requested = explicit == null || explicit === "" ? null : Number(explicit);

  if (canViewOthers) return requested ?? actingEmployeeId ?? null;

  if (requested != null && actingEmployeeId != null && requested !== actingEmployeeId) {
    throw Object.assign(new Error("Insufficient permissions: employeeId does not belong to the acting session"), {
      status: 403,
      code: "HR-4030",
    });
  }
  if (requested != null && actingEmployeeId == null) {
    // No binding + someone else's id → never allowed off a VIEW grant.
    throw Object.assign(new Error("Insufficient permissions: no employee is bound to this session"), {
      status: 403,
      code: "HR-4030",
    });
  }
  if (actingEmployeeId == null && !allowUnbound) {
    throw Object.assign(new Error("employeeId is required (no employee bound to the session)"), {
      status: 400,
      code: "HR-4000",
    });
  }
  return actingEmployeeId;
}

/**
 * Ownership check AFTER the row resolves: an explicit payslipId fetch on the
 * employee scope must belong to the acting employee, else 404 — generic text so
 * ids cannot be enumerated (a 403 would confirm the id exists).
 */
export function assertPayslipOwnership({ slip, actingEmployeeId, canViewOthers, explicitPayslipId }) {
  if (canViewOthers || explicitPayslipId == null || slip == null) return;
  if (actingEmployeeId != null && Number(slip.employeeId) !== actingEmployeeId) {
    throw Object.assign(new Error("No payslip found for this employee"), { status: 404, code: "HR-4004" });
  }
}
