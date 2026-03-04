import prisma from "../config/prisma.js";

export const exportEmployeeData = async (employeeId) => {
  const id = Number(employeeId);

  const [employee, emergencyContacts, media, leaves, attendances, payslips, goals, reviews, certifications] = await Promise.all([
    prisma.employee.findUnique({ where: { id } }),
    prisma.emergencyContacts.findMany({ where: { employeeId: id } }),
    prisma.employeeMedia.findMany({ where: { employee_id: id } }),
    prisma.leave.findMany({ where: { employeeId: id } }),
    prisma.attendance.findMany({ where: { employeeId: id } }),
    prisma.payrollPayslip.findMany({ where: { employeeId: id } }),
    prisma.goal.findMany({ where: { employeeId: id } }),
    prisma.performanceReview.findMany({ where: { employeeId: id } }),
    prisma.certification.findMany({ where: { employeeId: id } }),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    employee,
    emergencyContacts,
    media,
    leaves,
    attendances,
    payslips,
    goals,
    reviews,
    certifications,
  };
};

export const eraseEmployeeData = async (employeeId) => {
  const id = Number(employeeId);

  await prisma.$transaction(async (tx) => {
    await tx.emergencyContacts.deleteMany({ where: { employeeId: id } });
    await tx.employeeMedia.deleteMany({ where: { employee_id: id } });
    await tx.employeeLifecycleEvent.deleteMany({ where: { employeeId: id } });
    await tx.employeeSkill.deleteMany({ where: { employeeId: id } });
    await tx.developmentPlan.deleteMany({ where: { employeeId: id } });
    await tx.reimbursementClaim.deleteMany({ where: { employeeId: id } });

    await tx.employee.update({
      where: { id },
      data: {
        first_name: null,
        middle_name: null,
        last_name: null,
        preferred_name: null,
        email: null,
        work_email: null,
        personal_contact: null,
        current_address: null,
        permenant_address: null,
        nationality_id_no: null,
        remarks: "Anonymized per GDPR request",
      },
    });
  });

  return { success: true, employeeId: id, anonymizedAt: new Date().toISOString() };
};
