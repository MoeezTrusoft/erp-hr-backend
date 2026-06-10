import { runController } from "./_runner.js";
import prisma from "../../config/prisma.js";
import { listChecklists, createChecklist, updateItem } from "../../controllers/compliance.controller.js";
import { exportData, eraseData } from "../../controllers/gdpr.controller.js";
import { createClaim, approveClaim } from "../../controllers/reimbursement.controller.js";

export const mcpListComplianceChecklists = (user) => runController(listChecklists, { user });
export const mcpCreateComplianceChecklist = (user, data) => runController(createChecklist, { user, body: data });
export const mcpUpdateComplianceItem = (user, id, data) => runController(updateItem, { user, params: { id: String(id) }, body: data });

export const mcpExportGdprEmployeeData = (user, employeeId) => runController(exportData, { user, params: { employeeId: String(employeeId) } });
export const mcpEraseGdprEmployeeData = (user, employeeId) => runController(eraseData, { user, params: { employeeId: String(employeeId) } });

export const mcpCreateReimbursement = (user, data) => runController(createClaim, { user, body: data });
export const mcpApproveReimbursement = (user, id, data) => runController(approveClaim, { user, params: { id: String(id) }, body: data });

export const mcpListAuditLogs = async () => {
  const rows = await prisma.log.findMany({
    orderBy: { created_at: "desc" },
    take: 200,
    include: {
      employee: { select: { id: true, employee_name: true, first_name: true, last_name: true } },
      action_by: { select: { id: true, employee_name: true, first_name: true, last_name: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    date: row.created_at,
    createdAt: row.created_at,
    entity: row.module,
    action: row.action_type || row.type,
    status: row.result,
    user: {
      id: row.action_by?.id || row.employee?.id || row.actionById || row.employeeId,
      name:
        row.action_by?.employee_name ||
        [row.action_by?.first_name, row.action_by?.last_name].filter(Boolean).join(" ") ||
        row.employee?.employee_name ||
        [row.employee?.first_name, row.employee?.last_name].filter(Boolean).join(" ") ||
        "System",
    },
    details: row.notes,
    ip: row.ip,
  }));
};

export const mcpListDocumentExpiryAlerts = async () => {
  const rows = await prisma.documentExpiryAlert.findMany({
    orderBy: { alertDate: "asc" },
    take: 200,
    include: {
      employee: {
        select: {
          id: true,
          employee_name: true,
          first_name: true,
          last_name: true,
        },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    employeeId: row.employeeId,
    employeeName:
      row.employee?.employee_name ||
      [row.employee?.first_name, row.employee?.last_name].filter(Boolean).join(" ") ||
      `Employee ${row.employeeId}`,
    documentType: "Employee Document",
    expiryDate: row.alertDate,
    daysUntilExpiry: row.daysBeforeExpiry,
    notified: row.notified,
    notifiedAt: row.notifiedAt,
    department: "-",
    location: "-",
  }));
};

export const mcpListGdprRecords = async () => {
  const employees = await prisma.employee.findMany({
    orderBy: { id: "desc" },
    take: 100,
    select: {
      id: true,
      employee_name: true,
      first_name: true,
      last_name: true,
      created_at: true,
      updated_at: true,
      status: true,
    },
  });

  return employees.map((employee) => ({
    id: `employee-${employee.id}`,
    employeeId: employee.id,
    employeeName:
      employee.employee_name ||
      [employee.first_name, employee.last_name].filter(Boolean).join(" ") ||
      `Employee ${employee.id}`,
    requestType: "Data Processing",
    status: employee.status || "Active",
    submittedAt: employee.created_at,
    completedAt: null,
    notes: "Derived from employee record; no dedicated GDPR request table exists yet.",
  }));
};
