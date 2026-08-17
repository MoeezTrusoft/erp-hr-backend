// src/services/loginCredential.service.js
//
// Read-back of the auto-generated login passwords stored (C4-encrypted) on
// Employee.login_password during bulk import. RBAC still holds the real
// password hash for authentication; this is the HR-facing convenience copy so
// an admin can hand credentials to newly-imported staff.
//
// SENSITIVE: the caller is gated on hr:employee EXPORT in the MCP tool. Reads
// are tenant-scoped (scopedEmployeeWhere / FORCE-RLS) and the decrypt is done
// here, never in a query the DB can see.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { scopedEmployeeWhere } from "../lib/tenancy.js";
import { decryptString } from "../lib/crypto.js";

const MAX = 2000;

function toIntList(raw) {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return [...new Set(list.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))];
}

// Returns [{ employeeId, employeeCode, name, workEmail, loginEmail, password }].
export async function getLoginPasswords({ tenantId, employeeId, employeeIds, all }) {
  const ids = toIntList(employeeIds !== undefined ? employeeIds : employeeId);
  if (ids.length === 0 && !all) {
    throw Object.assign(new Error("Provide employeeId, employeeIds, or all:true"), { status: 400 });
  }

  const where = ids.length
    ? scopedEmployeeWhere(tenantId, { id: { in: ids } })
    : scopedEmployeeWhere(tenantId, { login_password: { not: null } });

  const rows = await prisma.employee.findMany({
    where,
    select: {
      id: true, employee_code: true, employee_name: true, first_name: true, last_name: true,
      work_email: true, email: true, login_password: true,
    },
    take: MAX,
    orderBy: { id: "asc" },
  });

  const items = [];
  for (const e of rows) {
    if (!e.login_password) continue;
    let password = null;
    try {
      password = decryptString(e.login_password);
    } catch (err) {
      logger.warn({ employeeId: e.id, err: err?.message }, "login password decrypt failed");
      password = null;
    }
    items.push({
      employeeId: e.id,
      employeeCode: e.employee_code ?? null,
      name: e.employee_name || [e.first_name, e.last_name].filter(Boolean).join(" ") || null,
      workEmail: e.work_email ?? null,
      loginEmail: e.work_email ?? e.email ?? null,
      password,
    });
  }

  // Report the ids that were asked for but have no stored password.
  const withPw = new Set(items.map((i) => i.employeeId));
  const missing = ids.filter((id) => !withPw.has(id));
  return { total: items.length, items, missing };
}
