// src/lib/actingEmployee.js
//
// Resolve the acting employee for MCP writes that must stamp a NOT-NULL
// Employee FK (LeaveRequest.createdById, LeaveRequestApproval.approverId,
// TimeEntry owner checks, ...).
//
// WHY THIS EXISTS: the MCP request context (src/mcp/context.js) sources
// `user.employeeId` ONLY from the gateway `x-employee-id` header. A super-admin
// (e.g. rbac_admin@test.com) that is not itself an HR Employee carries no
// `x-employee-id`, so `user.employeeId` is empty and the FK write fails with an
// opaque error ("createdById NaN" / "approverId is required to decide"). The
// context also hard-forces `isAdmin=false` (SEC-5), so authority for these
// paths comes from the `permissions` bitmask, not the admin flag.
//
// Resolution order (first hit wins):
//   1. explicit          — an id the FE passed on the tool (approverId / actingEmployeeId)
//   2. user.employeeId   — the common case: caller IS an HR employee
//   3. Employee.userId   — matches the RBAC user id (user.userId)
//   4. Employee.email    — matches the RBAC login email (email OR work_email)
//   5. fallbackEmployeeId — CREATE only: the request's own subject employee
// Returns a valid Employee.id (Int) or null when nothing resolves.

import prisma from "./prisma.js";
import { scopedEmployeeWhere } from "./tenancy.js";
export { hasPermission as canManage } from "../mcp/utils/assertPermission.js";

const toIntOrNull = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

// Confirm an Employee id actually exists within the tenant before we stamp it
// on an FK. Cheap findFirst on the primary key; RLS also scopes it.
async function existsInTenant(client, id, tenantId) {
  const row = await client.employee.findFirst({
    where: scopedEmployeeWhere(tenantId, { id }),
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * @param {object} user            MCP ctx user ({ employeeId, userId, email })
 * @param {object} [opts]
 * @param {string|number} [opts.explicit]            FE-supplied override id
 * @param {string|null}   [opts.tenantId]            verified tenant (RLS scope)
 * @param {string|number} [opts.fallbackEmployeeId]  create-only self-service fallback
 * @param {object}        [opts.client]              prisma/tx client (defaults to singleton)
 * @returns {Promise<number|null>} a valid Employee.id, or null
 */
export async function resolveActingEmployeeId(
  user = {},
  { explicit, tenantId, fallbackEmployeeId, client = prisma } = {}
) {
  // 1. explicit override — must exist in tenant.
  const exp = toIntOrNull(explicit);
  if (exp != null) {
    const ok = await existsInTenant(client, exp, tenantId);
    if (ok != null) return ok;
  }

  // 2. session-bound employee (a real HR employee acting on their own auth).
  const own = toIntOrNull(user?.employeeId);
  if (own != null) return own;

  // 3. Employee linked to the RBAC user id.
  const uid = toIntOrNull(user?.userId);
  if (uid != null) {
    const row = await client.employee.findFirst({
      where: scopedEmployeeWhere(tenantId, { userId: uid }),
      select: { id: true },
    });
    if (row?.id != null) return row.id;
  }

  // 4. Employee linked by RBAC login email (email or work_email).
  const email = typeof user?.email === "string" ? user.email.trim() : "";
  if (email) {
    const row = await client.employee.findFirst({
      where: scopedEmployeeWhere(tenantId, {
        OR: [
          { email: { equals: email, mode: "insensitive" } },
          { work_email: { equals: email, mode: "insensitive" } },
        ],
      }),
      select: { id: true },
    });
    if (row?.id != null) return row.id;
  }

  // 5. create-only fallback — the request's own subject employee is always a
  //    valid Employee, so a self-service create can still stamp createdById.
  const fb = toIntOrNull(fallbackEmployeeId);
  if (fb != null) {
    const ok = await existsInTenant(client, fb, tenantId);
    if (ok != null) return ok;
  }

  return null;
}
