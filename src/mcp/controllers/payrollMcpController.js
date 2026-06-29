import { runController } from "./_runner.js";
import {
  getPayrollRuns,
  getPayslips,
  getEarningTypes,
  getDeductionTypes,
  getAuditLogs,
  createPayrollRun,
  processPayrollRun,
  finalizePayrollRun,
  cancelPayrollRun,
  distributePayslip,
  createEmploymentTerms,
  createPayrollAssignment,
  createEarningType,
  createDeductionType,
  exportBankDisbursementFile,
} from "../../controllers/payrollController.js";

export const mcpListPayrollRuns = (user) => runController(getPayrollRuns, { user });
export const mcpListPayslips = (user, query = {}) => runController(getPayslips, { user, query });
export const mcpListEarningTypes = (user) => runController(getEarningTypes, { user });
export const mcpListDeductionTypes = (user) => runController(getDeductionTypes, { user });
export const mcpListPayrollAuditLogs = (user) => runController(getAuditLogs, { user });

export const mcpCreatePayrollRun = (user, data) => runController(createPayrollRun, { user, body: data });
export const mcpProcessPayrollRun = (user, id) => runController(processPayrollRun, { user, params: { id: String(id) } });
export const mcpFinalizePayrollRun = (user, id) => runController(finalizePayrollRun, { user, params: { id: String(id) } });
export const mcpCancelPayrollRun = (user, id) => runController(cancelPayrollRun, { user, params: { id: String(id) } });
export const mcpDistributePayslip = (user, id) => runController(distributePayslip, { user, params: { id: String(id) } });

// HR-BANKFILE-03 / HR-PAY-04 — bank/ACH disbursement export for a FINALIZED run.
export const mcpExportBankDisbursementFile = (user, id, query = {}) =>
  runController(exportBankDisbursementFile, { user, params: { id: String(id) }, query });

export const mcpCreateEmploymentTerms = (user, employeeId, data) =>
  runController(createEmploymentTerms, { user, params: { employeeId: String(employeeId) }, body: data });
export const mcpCreatePayrollAssignment = (user, employeeId, data) =>
  runController(createPayrollAssignment, { user, params: { employeeId: String(employeeId) }, body: data });
export const mcpCreateEarningType = (user, data) => runController(createEarningType, { user, body: data });
export const mcpCreateDeductionType = (user, data) => runController(createDeductionType, { user, body: data });
