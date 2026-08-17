// F-07 / ARCH-00 P-02 / ARCH-05 §7.1 / ARCH-06 §9.1
// Employee-owned records use Employee.id only. RBAC User.id is never a fallback.
//
// When the JWT claim is absent (admin without a linked Employee record, or
// gateway minted the token before employeeId was added), we fall back to an
// email-based Employee lookup so administrative actions (create employee,
// create position, etc.) are not blocked.

let _prismaCache = null;
const getPrisma = async () => {
  if (!_prismaCache) {
    const mod = await import("../lib/prisma.js");
    _prismaCache = mod.default ?? mod;
  }
  return _prismaCache;
};

export async function requireEmployeeActor(user) {
  const employeeId = Number(user?.employeeId);
  if (Number.isInteger(employeeId) && employeeId > 0) {
    return employeeId;
  }

  // Admin bypass: admins without a linked Employee record can still act
  // (e.g. create positions, create employees). Pass null as the actor —
  // downstream services must handle null actor gracefully for admin callers.
  if (user?.isAdmin === true) {
    return null;
  }

  // Fallback: look up Employee by email (work_email or email) within the tenant.
  const email = user?.email;
  if (email) {
    const prisma = await getPrisma();
    const where = { OR: [{ work_email: email }, { email: email }] };
    if (user?.tenantId) where.tenant_id = user.tenantId;
    const employee = await prisma.employee.findFirst({
      where,
      select: { id: true },
    });
    if (employee) {
      // Cache on the user object so subsequent calls in the same request skip the DB.
      user.employeeId = employee.id;
      return employee.id;
    }
  }

  throw Object.assign(new Error("Employee identity is required"), {
    status: 403,
    code: "HR-0701",
  });
}

/**
 * REQ-HR-001 — soft counterpart of requireEmployeeActor.
 *
 * Some writes are ADMINISTRATIVE: the actor is audit metadata (updatedById),
 * not an authorization input. Authorization for those is already decided by
 * assertPermission / the route policy before we get here, so refusing the write
 * because the CALLER happens to have no linked Employee record adds no safety —
 * it only makes the action impossible for RBAC-only accounts. That is exactly
 * how hr_employee_status_update failed: every deactivate from the Employee
 * Directory 403'd with HR-0701 for an admin whose account has employeeId: null.
 *
 * Use this when the actor is metadata. Keep requireEmployeeActor for
 * self-service paths (attendance punch, own leave request, …) where the
 * employee identity IS the subject of the action and a missing one is fatal.
 *
 * @param {object} user
 * @returns {Promise<number|null>} the Employee id, or null when none resolves
 */
export async function resolveEmployeeActor(user) {
  try {
    return await requireEmployeeActor(user);
  } catch (err) {
    if (err?.code === "HR-0701") return null;
    throw err;
  }
}
