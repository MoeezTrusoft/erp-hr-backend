import prisma from "../config/prisma.js";
import { scopedWhere, scopedEmployeeWhere } from "../lib/tenancy.js";
// Same as EMPLOYEE_VISIBLE_STATUSES in myPayslip.service.js (not imported: it pulls the whole payslip graph).
const EMPLOYEE_VISIBLE_STATUSES = ["FINALIZED", "DISTRIBUTED"];

// C.2-completion — verified tenant (T-P2.1) read off req.user.tenantId and folded
// into every self-service read/write as defense-in-depth. The employeeId already
// scopes to the caller, but tenant-scoping ensures a self row from another tenant
// (e.g. a recycled/duplicated employeeId) can never be read or mutated. Payslip
// reads stay on the C4-encrypted payroll surface untouched — only the where-clause
// is tenant-narrowed.

function requireEmployeeId(req) {
  const employeeId = Number(req.user?.employeeId || 0);
  if (!employeeId) throw new Error("Missing employee identity");
  return employeeId;
}

const tenantOf = (req) => req.user?.tenantId;

export const getSelfProfile = async (req) => {
  const employeeId = requireEmployeeId(req);
  return prisma.employee.findFirst({ where: scopedEmployeeWhere(tenantOf(req), { id: employeeId }) });
};

export const updateSelfProfile = async (req) => {
  const employeeId = requireEmployeeId(req);
  const tenantId = tenantOf(req);
  // Guard ownership within the tenant before mutating by id.
  const existing = await prisma.employee.findFirst({ where: scopedEmployeeWhere(tenantId, { id: employeeId }) });
  if (!existing) throw new Error("Employee not found");
  const { preferred_name, current_address, personal_contact, email, work_phone, city, state, country } = req.body;
  return prisma.employee.update({
    where: { id: employeeId },
    data: { preferred_name, current_address, personal_contact, email, work_phone, city, state, country },
  });
};

export const listSelfEmergencyContacts = async (req) => {
  const employeeId = requireEmployeeId(req);
  return prisma.emergencyContacts.findMany({ where: scopedWhere(tenantOf(req), { employeeId }) });
};

export const upsertSelfEmergencyContact = async (req) => {
  const employeeId = requireEmployeeId(req);
  const tenantId = tenantOf(req);
  const { id, ...rest } = req.body;
  if (id) {
    const existing = await prisma.emergencyContacts.findFirst({ where: scopedWhere(tenantId, { id: Number(id), employeeId }) });
    if (!existing) throw new Error("Emergency contact not found");
    return prisma.emergencyContacts.update({ where: { id: Number(id) }, data: { ...rest, employeeId } });
  }
  return prisma.emergencyContacts.create({ data: { ...rest, employeeId, ...(tenantId === undefined ? {} : { tenantId: tenantId ?? null }) } });
};

export const listSelfPayslips = async (req) => {
  const employeeId = requireEmployeeId(req);
  // Draft and held slips stay private until payroll is finalized, as in hr_my_payslips_list.
  return prisma.payrollPayslip.findMany({
    where: scopedWhere(tenantOf(req), { employeeId, status: { in: EMPLOYEE_VISIBLE_STATUSES } }),
    orderBy: { created_at: "desc" },
  });
};

export const listSelfLeaveBalances = async (req) => {
  const employeeId = requireEmployeeId(req);
  return prisma.leaveBalance.findMany({ where: scopedWhere(tenantOf(req), { employeeId }), include: { policy: true } });
};
