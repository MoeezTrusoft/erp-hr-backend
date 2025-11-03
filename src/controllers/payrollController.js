import { createPayrollRunService, distributePayslipService, finalizePayrollRunService, getEarningTypesService, getEmployeePayslipsService, getPayrollRunService, getPayrollRunsService, getPayslipService, getPayslipsService, processPayrollRunService, updateEarningTypeService, updatePayrollRunService, updatePayslipService, createEarningTypeService, getDeductionTypesService, createDeductionTypeService, updateDeductionTypeService, getTaxRatesService, getPayrollSummaryService, getPayrollRegisterService, getTaxReportService, getAuditLogsService } from "../services/payrollService";
import { errorResponse, successResponse } from "../utils/response";




// Payroll Run Controllers
export const createPayrollRun = async (req, res) => {
    try {
        const payrollRun = await createPayrollRunService(req.body, req.user);
        successResponse(res, payrollRun, 'Payroll run created successfully', 201);
    } catch (error) {
        errorResponse(res, error.message);
    }
};

export const getPayrollRuns = async (req, res) => {
    try {
        const { page = 1, limit = 10, status, period } = req.query;
        const payrollRuns = await getPayrollRunsService({
            page: parseInt(page),
            limit: parseInt(limit),
            status,
            period
        });
        successResponse(res, payrollRuns, 'Payroll runs retrieved successfully');
    } catch (error) {
        errorResponse(res, error.message);
    }
};

export const getPayrollRun = async (req, res) => {
    try {
        const payrollRun = await getPayrollRunService(parseInt(req.params.id));
        successResponse(res, payrollRun, 'Payroll run retrieved successfully');
    } catch (error) {
        errorResponse(res, error.message);
    }
};

export const updatePayrollRun = async (req, res) => {
    try {
        const payrollRun = await updatePayrollRunService(
            parseInt(req.params.id),
            req.body,
            req.user
        );
        successResponse(res, payrollRun, 'Payroll run updated successfully');
    } catch (error) {
        errorResponse(res, error.message);
    }
};

export const processPayrollRun = async (req, res) => {
    try {
        const result = await processPayrollRunService(parseInt(req.params.id), req.user);
        successResponse(res, result, 'Payroll run processed successfully');
    } catch (error) {
        errorResponse(res, error.message);
    }
};

export const finalizePayrollRun = async (req, res) => {
    try {
        const result = await finalizePayrollRunService(parseInt(req.params.id), req.user);
        successResponse(res, result, 'Payroll run finalized successfully');
    } catch (error) {
        errorResponse(res, error.message);
    }
};

// Payslip Controllers
export const getPayslips = async (req, res) => {
    try {
        const { page = 1, limit = 10, payrollRunId, employeeId, status } = req.query;
        const payslips = await getPayslipsService({
            page: parseInt(page),
            limit: parseInt(limit),
            payrollRunId: payrollRunId ? parseInt(payrollRunId) : undefined,
            employeeId: employeeId ? parseInt(employeeId) : undefined,
            status
        });
        successResponse(res, payslips, 'Payslips retrieved successfully');
    } catch (error) {
        errorResponse(res, error.message);
    }
};

export const getPayslip = async (req, res) => {
    try {
        const payslip = await getPayslipService(parseInt(req.params.id));
        successResponse(res, payslip, 'Payslip retrieved successfully');
    } catch (error) {
        errorResponse(res, error.message);
    }
};

export const updatePayslip = async (req, res) => {
    try {
        const payslip = await updatePayslipService(
            parseInt(req.params.id),
            req.body,
            req.user
        );
        successResponse(res, payslip, 'Payslip updated successfully');
    } catch (error) {
        errorResponse(res, error.message);
    }
};

export const distributePayslip = async (req, res) => {
    try {
        const result = await distributePayslipService(parseInt(req.params.id), req.user);
        successResponse(res, result, 'Payslip distributed successfully');
    } catch (error) {
        errorResponse(res, error.message);
    }
};

export const getEmployeePayslips = async (req, res) => {
    try {
        const { page = 1, limit = 10 } = req.query;
        const payslips = await getEmployeePayslipsService({
            employeeId: parseInt(req.params.employeeId),
            page: parseInt(page),
            limit: parseInt(limit)
        });
        successResponse(res, payslips, 'Employee payslips retrieved successfully');
    } catch (error) {
        errorResponse(res, error.message);
    }
};

// Configuration Controllers
export const getEarningTypes = async (req, res) => {
    try {
        const earningTypes = await getEarningTypesService();
        successResponse(res, earningTypes, 'Earning types retrieved successfully');
    } catch (error) {
        errorResponse(res, error.message);
    }
};

export const createEarningType = async (req, res) => {
    try {
        const earningType = await createEarningTypeService(req.body);
        successResponse(res, earningType, 'Earning type created successfully', 201);
    } catch (error) {
        errorResponse(res, error.message);
    }
};

export const updateEarningType = async (req, res) => {
    try {
        const earningType = await updateEarningTypeService(
            parseInt(req.params.id),
            req.body
        );
        successResponse(res, earningType, 'Earning type updated successfully');
    } catch (error) {
        errorResponse(res, error.message);
    }
};

export const getDeductionTypes = async (req, res) => {
    try {
        const deductionTypes = await getDeductionTypesService();
        successResponse(res, deductionTypes, 'Deduction types retrieved successfully');
    } catch (error) {
        errorResponse(res, error.message);
    }
};

export const createDeductionType = async (req, res) => {
    try {
        const deductionType = await createDeductionTypeService(req.body);
        successResponse(res, deductionType, 'Deduction type created successfully', 201);
    } catch (error) {
        errorResponse(res, error.message);
    }
};

export const updateDeductionType = async (req, res) => {
    try {
        const deductionType = await updateDeductionTypeService(
            parseInt(req.params.id),
            req.body
        );
        successResponse(res, deductionType, 'Deduction type updated successfully');
    } catch (error) {
        errorResponse(res, error.message);
    }
};

// Tax Configuration Controllers
export const getTaxRates = async (req, res) => {
    try {
        const { countryCode, effectiveDate } = req.query;
        const taxRates = await getTaxRatesService({ countryCode, effectiveDate });
        successResponse(res, taxRates, 'Tax rates retrieved successfully');
    } catch (error) {
        errorResponse(res, error.message);
    }
};

// Report Controllers
export const getPayrollSummary = async (req, res) => {
    try {
        const { payrollRunId, periodStart, periodEnd } = req.query;
        const summary = await getPayrollSummaryService({
            payrollRunId: payrollRunId ? parseInt(payrollRunId) : undefined,
            periodStart,
            periodEnd
        });
        successResponse(res, summary, 'Payroll summary retrieved successfully');
    } catch (error) {
        errorResponse(res, error.message);
    }
};

export const getPayrollRegister = async (req, res) => {
    try {
        const { payrollRunId } = req.query;
        const register = await getPayrollRegisterService(parseInt(payrollRunId));
        successResponse(res, register, 'Payroll register retrieved successfully');
    } catch (error) {
        errorResponse(res, error.message);
    }
};

export const getTaxReport = async (req, res) => {
    try {
        const { periodStart, periodEnd, countryCode } = req.query;
        const report = await getTaxReportService({
            periodStart,
            periodEnd,
            countryCode
        });
        successResponse(res, report, 'Tax report retrieved successfully');
    } catch (error) {
        errorResponse(res, error.message);
    }
};

// Audit Controllers
export const getAuditLogs = async (req, res) => {
    try {
        const { page = 1, limit = 10, action, startDate, endDate } = req.query;
        const auditLogs = await getAuditLogsService({
            page: parseInt(page),
            limit: parseInt(limit),
            action,
            startDate,
            endDate
        });
        successResponse(res, auditLogs, 'Audit logs retrieved successfully');
    } catch (error) {
        errorResponse(res, error.message);
    }
};

