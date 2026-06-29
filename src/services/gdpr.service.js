import prisma from "../config/prisma.js";
import { scopedEmployeeWhere } from "../lib/tenancy.js";

// HR-SEC-02 / HR-SEC-07 — GDPR "right to be forgotten" + tenant isolation.
//
// Every export/erase is scoped to the VERIFIED caller tenant (the RBAC
// Company.uuid string on req.user.tenantId, set by internalServiceGuard from the
// service-JWT claim — T-P2.1; threaded in by the controller). The employee row
// is resolved FAIL-CLOSED against that tenant first: a wrong-tenant (or unknown)
// id resolves to not-found and the operation 404s WITHOUT reading or mutating
// any data. This closes the cross-tenant export/erase-by-raw-id hole.
//
// `scopedEmployeeWhere` names the Employee tenant column (`tenant_id`, snake_case
// per REQ-007). The C.2-tenant child tables carry `tenantId`; we additionally
// scope deletes by that column where it exists, but the employee-tenant guard is
// the authoritative gate — the employeeId predicate is already tenant-bound once
// the parent employee has been confirmed in-tenant.

const notFound = () => {
  const err = new Error("Employee not found");
  err.code = "HR-GDPR-NOT-FOUND";
  err.statusCode = 404;
  return err;
};

// Resolve the employee FAIL-CLOSED inside the caller tenant. Throws 404 when the
// id belongs to another tenant (or does not exist) so nothing downstream runs.
const resolveInTenant = async (db, id, tenantId) => {
  const employee = await db.employee.findFirst({
    where: scopedEmployeeWhere(tenantId, { id }),
  });
  if (!employee) throw notFound();
  return employee;
};

export const exportEmployeeData = async (employeeId, tenantId) => {
  const id = Number(employeeId);

  // Fail-closed tenant gate: a wrong-tenant id never exports another tenant's PII.
  const employee = await resolveInTenant(prisma, id, tenantId);

  const [emergencyContacts, media, leaves, attendances, payslips, goals, reviews, certifications, employmentTerms, bankDetails] =
    await Promise.all([
      prisma.emergencyContacts.findMany({ where: { employeeId: id } }),
      prisma.employeeMedia.findMany({ where: { employee_id: id } }),
      prisma.leave.findMany({ where: { employeeId: id } }),
      prisma.attendance.findMany({ where: { employeeId: id } }),
      prisma.payrollPayslip.findMany({ where: { employeeId: id } }),
      prisma.goal.findMany({ where: { employeeId: id } }),
      prisma.performanceReview.findMany({ where: { employeeId: id } }),
      prisma.certification.findMany({ where: { employeeId: id } }),
      prisma.employmentTerms.findMany({ where: { employeeId: id } }),
      prisma.bankDetail.findMany({ where: { employeeId: id } }),
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
    employmentTerms,
    bankDetails,
  };
};

export const eraseEmployeeData = async (employeeId, tenantId) => {
  const id = Number(employeeId);

  const report = await prisma.$transaction(async (tx) => {
    // Fail-closed tenant gate: a wrong-tenant id 404s with ZERO writes.
    await resolveInTenant(tx, id, tenantId);

    // 1) Break restricted FK back-references so the child deletes below cannot
    //    trip an onDelete: Restrict constraint. Logs/audit logs that POINT AT
    //    this employee's attendance/payslips have those references nulled (the
    //    rows themselves are handled separately).
    await tx.log.updateMany({
      where: { attendanceId: { not: null }, attendance: { employeeId: id } },
      data: { attendanceId: null },
    });
    await tx.log.updateMany({
      where: { payslipId: { not: null }, payslip: { employeeId: id } },
      data: { payslipId: null },
    });
    await tx.payrollAuditLog.updateMany({
      where: { payslipId: { not: null }, payslip: { employeeId: id } },
      data: { payslipId: null },
    });

    // 2) Performance reviews — HOLE 2. The review tree (feedback, reminders,
    //    rating adjustments, review items) is FK-restricted, so we IRREVERSIBLY
    //    ANONYMIZE the free-text PII rather than delete the tree: the subject's
    //    comments and the per-feedback narrative are redacted; aggregate ratings
    //    (non-PII) and referential integrity are preserved.
    await tx.reviewFeedback.updateMany({
      where: { review: { employeeId: id } },
      data: { feedback: "[erased]" },
    });
    await tx.performanceReview.updateMany({
      where: { employeeId: id },
      data: { comments: null },
    });

    // 3) Financial PII — HOLE 2. Bank accounts, salary (employment terms),
    //    payroll assignments and payslips are hard-deleted. Deleting a payslip
    //    cascade-deletes its earnings/deductions (schema onDelete: Cascade).
    const bankAccounts = await tx.bankDetail.deleteMany({ where: { employeeId: id } });
    const salary = await tx.employmentTerms.deleteMany({ where: { employeeId: id } });
    const payrollAssignments = await tx.payrollAssignment.deleteMany({ where: { employeeId: id } });
    const payslips = await tx.payrollPayslip.deleteMany({ where: { employeeId: id } });

    // 4) Attendance + leave — HOLE 2.
    const attendance = await tx.attendance.deleteMany({ where: { employeeId: id } });
    const leave = await tx.leave.deleteMany({ where: { employeeId: id } });

    // 5) Previously-covered categories (kept).
    await tx.emergencyContacts.deleteMany({ where: { employeeId: id } });
    await tx.employeeMedia.deleteMany({ where: { employee_id: id } });
    await tx.employeeLifecycleEvent.deleteMany({ where: { employeeId: id } });
    await tx.employeeSkill.deleteMany({ where: { employeeId: id } });
    await tx.developmentPlan.deleteMany({ where: { employeeId: id } });
    await tx.reimbursementClaim.deleteMany({ where: { employeeId: id } });

    // 6) Anonymize the employee root record.
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

    return {
      bankAccounts: bankAccounts.count,
      salary: salary.count,
      payrollAssignments: payrollAssignments.count,
      payslips: payslips.count,
      attendance: attendance.count,
      leave: leave.count,
    };
  });

  return {
    success: true,
    employeeId: id,
    anonymizedAt: new Date().toISOString(),
    erased: report,
  };
};
