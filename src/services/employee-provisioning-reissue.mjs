import { fingerprint } from "./intent-contract.mjs";

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

export function recoveryPrincipal(context) {
  const claims = context?.claims;
  const actor = claims?.act;
  const permissions = typeof claims?.scope === "string" ? claims.scope.split(/\s+/) : [];
  if (context?.source !== "service-jwt" || context.alg !== "EdDSA" ||
      claims?.iss !== "erp-gateway" || claims.svc !== "hr" ||
      claims.actor?.type !== "user" || !Number.isSafeInteger(Number(claims.uid)) ||
      Number(claims.uid) <= 0 || String(claims.uid) !== String(actor?.sub) ||
      String(claims.actor.id) !== String(actor.sub) || !actor.sid ||
      !context.tenantId || context.tenantId !== actor.tid ||
      !permissions.includes("hr.employee.update") || !permissions.includes("rbac.employee.create")) {
    fail(403, "A current employee administrator session is required");
  }
  return { tenantId: context.tenantId, userId: String(claims.uid), permissions };
}

// Run inside a tenant-bound transaction. The native RBAC receiver checks current
// membership and role delegation again when it consumes the updated intent.
export async function reissueForEmployee(tx, principal, employeeId, input) {
  if (!Number.isSafeInteger(employeeId) || employeeId <= 0 ||
      !input || Object.keys(input).some(k => !["employeeCode", "email", "roleId"].includes(k)) ||
      typeof input.employeeCode !== "string" || !input.employeeCode.trim() ||
      typeof input.email !== "string" || !input.email.trim() ||
      !Number.isSafeInteger(input.roleId) || input.roleId <= 0) {
    fail(400, "Employee code, login email and recipient role ID are required");
  }
  const { tenantId } = principal;
  const email = input.email.trim().toLowerCase();
  const employee = await tx.employee.findFirst({
    where: { id: employeeId, tenant_id: tenantId, employee_code: input.employeeCode },
    select: { work_email: true, separatedAt: true, userId: true, employement_status: true },
  });
  if (!employee || employee.work_email?.toLowerCase() !== email) fail(404, "Employee identity does not match");
  const row = await tx.systemAccountProvisioning.findUnique({
    where: { tenantId_employeeId: { tenantId, employeeId } },
  });
  if (!row || row.payload?.hrEmployeeId !== employeeId || row.payload.email?.toLowerCase() !== email ||
      fingerprint(row.payload) !== row.payloadFingerprint) fail(409, "Provisioning identity does not match");
  // Repeated submissions of the same recovery only read its public status.
  const recoveryId = fingerprint({ tenantId, employeeId, email, roleId: input.roleId, purpose: "reissue" });
  if (row.correlationId === recoveryId && row.payload.roles?.length === 1 &&
      row.payload.roles[0].roleId === input.roleId) return row;
  if (employee.separatedAt || employee.userId || employee.employement_status !== "Active" ||
      row.rbacUserId || row.status !== "TERMINAL_FAILED" || row.lastHttpStatus !== 403 ||
      row.lastError !== "Insufficient permissions: rbac:employee:CREATE") {
    fail(409, "Only a failed employee-create authorization can be reissued");
  }
  const payload = { ...row.payload, roles: [{ roleId: input.roleId }] };
  const update = await tx.systemAccountProvisioning.updateMany({
    where: { id: row.id, tenantId, employeeId, status: row.status, rbacUserId: null,
      payloadFingerprint: row.payloadFingerprint, updatedAt: row.updatedAt },
    data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date(), claimedAt: null,
      claimedBy: null, claimExpiresAt: null, completedAt: null, lastError: null, lastErrorCode: null,
      lastHttpStatus: null, manualRetryCount: { increment: 1 }, correlationId: recoveryId,
      payload, payloadFingerprint: fingerprint(payload),
      actor: { userId: principal.userId, roles: [], permissions: principal.permissions } },
  });
  if (update.count === 1) {
    await tx.log.create({ data: {
      tenantId, employeeId, type: "UPDATE", action_type: "SYSTEM_ACCOUNT_REISSUE",
      module: "Employee", result: "QUEUED", ip: "", os: "",
      notes: JSON.stringify({ operatorUserId: principal.userId, previousRoleIds: row.payload.roles?.map(role => role.roleId),
        recipientRoleId: input.roleId, previousFingerprint: row.payloadFingerprint, recoveryId }),
    } });
  }
  const current = await tx.systemAccountProvisioning.findUnique({ where: { id: row.id } });
  if (!current || current.correlationId !== recoveryId || (!update.count && current.payload?.roles?.[0]?.roleId !== input.roleId)) {
    fail(409, "Provisioning changed during recovery");
  }
  return current;
}
