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
} from "../../controllers/payrollController.js";

export const mcpListPayrollRuns = (user) => runController(getPayrollRuns, { user });
export const mcpListPayslips = (user) => runController(getPayslips, { user });
export const mcpListEarningTypes = (user) => runController(getEarningTypes, { user });
export const mcpListDeductionTypes = (user) => runController(getDeductionTypes, { user });
export const mcpListPayrollAuditLogs = (user) => runController(getAuditLogs, { user });

export const mcpCreatePayrollRun = (user, data) => runController(createPayrollRun, { user, body: data });
export const mcpProcessPayrollRun = (user, id) => runController(processPayrollRun, { user, params: { id: String(id) } });
export const mcpFinalizePayrollRun = (user, id) => runController(finalizePayrollRun, { user, params: { id: String(id) } });
export const mcpCancelPayrollRun = (user, id) => runController(cancelPayrollRun, { user, params: { id: String(id) } });
export const mcpDistributePayslip = (user, id) => runController(distributePayslip, { user, params: { id: String(id) } });

export const mcpCreateEmploymentTerms = (user, employeeId, data) =>
  runController(createEmploymentTerms, { user, params: { employeeId: String(employeeId) }, body: data });
export const mcpCreatePayrollAssignment = (user, employeeId, data) =>
  runController(createPayrollAssignment, { user, params: { employeeId: String(employeeId) }, body: data });
export const mcpCreateEarningType = (user, data) => runController(createEarningType, { user, body: data });
export const mcpCreateDeductionType = (user, data) => runController(createDeductionType, { user, body: data });
