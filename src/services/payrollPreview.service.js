import { processPayrollRun } from "./payrollService.js";
// The production loader and engine, with all writes disabled.
export async function previewPayslip({ tenantId, runId, employeeCode }) {
  if (!Number.isInteger(Number(runId)) || !employeeCode?.trim())
    throw Object.assign(new Error("Select a payroll run and employee code"), {
      status: 400,
    });
  const result = await processPayrollRun(Number(runId), null, tenantId, {
    preview: true,
    employeeCode: employeeCode.trim(),
  });
  return { ...result, payslip: result.payslips[0] };
}
