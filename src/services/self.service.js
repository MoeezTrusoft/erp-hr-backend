import prisma from "../config/prisma.js";

function requireEmployeeId(req) {
  const employeeId = Number(req.headers["x-employee-id"] || 0);
  if (!employeeId) throw new Error("Missing employee identity");
  return employeeId;
}

export const getSelfProfile = async (req) => {
  const employeeId = requireEmployeeId(req);
  return prisma.employee.findUnique({ where: { id: employeeId } });
};

export const updateSelfProfile = async (req) => {
  const employeeId = requireEmployeeId(req);
  const { preferred_name, current_address, personal_contact, email, work_phone, city, state, country } = req.body;
  return prisma.employee.update({
    where: { id: employeeId },
    data: { preferred_name, current_address, personal_contact, email, work_phone, city, state, country },
  });
};

export const listSelfEmergencyContacts = async (req) => {
  const employeeId = requireEmployeeId(req);
  return prisma.emergencyContacts.findMany({ where: { employeeId } });
};

export const upsertSelfEmergencyContact = async (req) => {
  const employeeId = requireEmployeeId(req);
  const { id, ...rest } = req.body;
  if (id) {
    return prisma.emergencyContacts.update({ where: { id: Number(id) }, data: { ...rest, employeeId } });
  }
  return prisma.emergencyContacts.create({ data: { ...rest, employeeId } });
};

export const listSelfPayslips = async (req) => {
  const employeeId = requireEmployeeId(req);
  return prisma.payrollPayslip.findMany({ where: { employeeId }, orderBy: { created_at: "desc" } });
};

export const listSelfLeaveBalances = async (req) => {
  const employeeId = requireEmployeeId(req);
  return prisma.leaveBalance.findMany({ where: { employeeId }, include: { policy: true } });
};
