import { runController } from "./_runner.js";
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
