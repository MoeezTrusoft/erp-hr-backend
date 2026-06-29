import * as payrollService from '../services/payrollService.js';
import * as bankFileService from '../services/bankFileService.js';
import { auditC4Read } from '../lib/c4Access.js';

// HR-04 / T-P2.2 — every payroll request is scoped to the VERIFIED tenant on
// req.user.tenantId (set by internalServiceGuard from the service-JWT claim —
// T-P2.1). NEVER read tenant from req.headers / x-tenant-id. The helper below
// centralizes that single source of truth.
const tenantOf = (req) => req.user?.tenantId ?? null;

export const getPayrollRuns = async (req, res) => {
    try {
        const { page = 1, limit = 10, status } = req.query;
        const result = await payrollService.getPayrollRuns({
            page: parseInt(page),
            limit: parseInt(limit),
            status,
            tenantId: tenantOf(req)
        });
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

export const getPayrollRunById = async (req, res) => {
    try {
        const { id } = req.params;
        const payrollRun = await payrollService.getPayrollRunById(parseInt(id), tenantOf(req));
        if (!payrollRun) {
            return res.status(404).json({ success: false, error: 'Payroll run not found' });
        }
        // HR-01 / T-P4.2 — run + its payslips carry C4 money; audit the read.
        await auditC4Read(req.user, { action: 'PAYROLL_RUN_READ', target: id });
        res.json({ success: true, data: payrollRun });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

export const createPayrollRun = async (req, res) => {
    try {
        const createdBy = req.headers['employee-id'];
        const payrollRun = await payrollService.createPayrollRun(req.body, createdBy, tenantOf(req));
        res.status(201).json({ success: true, data: payrollRun });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
};

export const processPayrollRun = async (req, res) => {
    try {
        const { id } = req.params;
        const updatedBy = req.headers['employee-id'];
        const result = await payrollService.processPayrollRun(parseInt(id), updatedBy, tenantOf(req));
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
};

// HR-02 / T-P4.1 — approval gate (separation of duties). The approver is the
// verified actor on the employee-id header; the service rejects self-approval
// (approver === processor).
export const approvePayrollRun = async (req, res) => {
    try {
        const { id } = req.params;
        const approvedBy = req.headers['employee-id'];
        const result = await payrollService.approvePayrollRun(parseInt(id), approvedBy, tenantOf(req));
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
};

export const finalizePayrollRun = async (req, res) => {
    try {
        const { id } = req.params;
        const finalizedBy = req.headers['employee-id'];
        const result = await payrollService.finalizePayrollRun(parseInt(id), finalizedBy, tenantOf(req));
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
};

// HR-BANKFILE-03 / HR-PAY-04 — generate a bank/ACH disbursement file from a
// FINALIZED run. The route already deny-by-default-gates this (requirePermission
// 'hr:payroll'); the service tenant-scopes the run (wrong tenant → 404), rejects
// non-FINALIZED runs, decrypts bank accounts IN-MEMORY only, and never logs them.
// `format` query selects NACHA (default) or the bank CSV.
export const exportBankDisbursementFile = async (req, res) => {
    try {
        const { id } = req.params;
        const format = (req.query.format || 'nacha').toLowerCase();
        const result = await bankFileService.generateBankDisbursementFile(parseInt(id), {
            tenantId: tenantOf(req),
            format,
            actorId: req.user?.employeeId ?? req.user?.userId ?? null,
        });

        // This export materializes decrypted C4 (bank) data; record the auditable
        // read (notes carry no account numbers — see auditC4Read + the service).
        await auditC4Read(req.user, { action: 'BANK_DISBURSEMENT_EXPORT', target: id });

        res.setHeader('Content-Type', result.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.setHeader('X-Disbursement-Count', String(result.summary.rowCount));
        return res.status(200).send(result.content);
    } catch (error) {
        const status = error.status || error.statusCode || 500;
        return res.status(status).json({ success: false, error: error.message, code: error.code });
    }
};

export const cancelPayrollRun = async (req, res) => {
    try {
        const { id } = req.params;
        const cancelledBy = req.headers['employee-id'];
        await payrollService.cancelPayrollRun(parseInt(id), cancelledBy, tenantOf(req));
        res.json({ success: true, message: 'Payroll run cancelled successfully' });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
};

// Earning Types
export const getEarningTypes = async (req, res) => {
    try {
        const earningTypes = await payrollService.getEarningTypes(tenantOf(req));
        res.json({ success: true, data: earningTypes });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

export const createEarningType = async (req, res) => {
    try {
        const createdBy = req.headers['employee-id'];
        const earningType = await payrollService.createEarningType(req.body, createdBy, tenantOf(req));
        res.status(201).json({ success: true, data: earningType });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
};

export const updateEarningType = async (req, res) => {
    try {
        const { id } = req.params;
        const updatedBy = req.headers['employee-id'];
        const earningType = await payrollService.updateEarningType(parseInt(id), req.body, updatedBy, tenantOf(req));
        res.json({ success: true, data: earningType });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
};

// Deduction Types
export const getDeductionTypes = async (req, res) => {
    try {
        const deductionTypes = await payrollService.getDeductionTypes(tenantOf(req));
        res.json({ success: true, data: deductionTypes });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

export const createDeductionType = async (req, res) => {
    try {
        const createdBy = req.headers['employee-id'];
        const deductionType = await payrollService.createDeductionType(req.body, createdBy, tenantOf(req));
        res.status(201).json({ success: true, data: deductionType });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
};

export const updateDeductionType = async (req, res) => {
    try {
        const { id } = req.params;
        const updatedBy = req.headers['employee-id'];
        const deductionType = await payrollService.updateDeductionType(parseInt(id), req.body, updatedBy, tenantOf(req));
        res.json({ success: true, data: deductionType });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
};

// Employee Payroll Data
export const getEmployeePayrollData = async (req, res) => {
    try {
        const { employeeId } = req.params;

        // Check if user has permission to view this employee's data
        if (req.user.role === 'EMPLOYEE' && req.user.id !== parseInt(employeeId)) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        const data = await payrollService.getEmployeePayrollData(parseInt(employeeId), tenantOf(req));
        // HR-01 / T-P4.2 — this read returns decrypted C4 (salary terms, bank
        // details). The route already deny-by-default-gated it; record the read
        // so every C4 access is auditable (roadmap L208).
        await auditC4Read(req.user, { action: 'EMPLOYEE_PAYROLL_DATA_READ', target: employeeId });
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

export const createEmploymentTerms = async (req, res) => {
    try {
        const { employeeId } = req.params;
        const createdBy = req.headers['employee-id'];
        const employmentTerms = await payrollService.createEmploymentTerms({
            ...req.body,
            employeeId: parseInt(employeeId),
            createdBy
        }, createdBy, tenantOf(req));
        res.status(201).json({ success: true, data: employmentTerms });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
};

export const createPayrollAssignment = async (req, res) => {
    try {
        const { employeeId } = req.params;
        const createdBy = req.headers['employee-id'];
        const assignment = await payrollService.createPayrollAssignment({
            ...req.body,
            employeeId: parseInt(employeeId),
            createdBy
        }, createdBy, tenantOf(req));
        res.status(201).json({ success: true, data: assignment });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
};

// Payslips
export const getPayslips = async (req, res) => {
    try {
        const { page = 1, limit = 10, payrollRunId, employeeId } = req.query;
        const result = await payrollService.getPayslips({
            page: parseInt(page),
            limit: parseInt(limit),
            payrollRunId,
            employeeId,
            tenantId: tenantOf(req)
        });
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

export const getPayslipById = async (req, res) => {
    try {
        const { id } = req.params;
        const payslip = await payrollService.getPayslipById(parseInt(id), tenantOf(req));
        if (!payslip) {
            return res.status(404).json({ success: false, error: 'Payslip not found' });
        }

        // Check if user has permission to view this payslip
        if (req.user.role === 'EMPLOYEE' && req.user.id !== payslip.employeeId) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        // HR-01 / T-P4.2 — payslip carries C4 money; record the auditable read.
        await auditC4Read(req.user, { action: 'PAYSLIP_READ', target: id });
        res.json({ success: true, data: payslip });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

export const distributePayslip = async (req, res) => {
    try {
        const { id } = req.params;
        const createdBy = req.headers['employee-id'];
        const payslip = await payrollService.distributePayslip(parseInt(id), createdBy, tenantOf(req));
        res.json({ success: true, data: payslip });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
};

export const getEmployeePayslips = async (req, res) => {
    try {
        const { employeeId } = req.params;
        const { page = 1, limit = 10 } = req.query;

        // Check if user has permission to view this employee's payslips
        if (req.user.role === 'EMPLOYEE' && req.user.id !== parseInt(employeeId)) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        const result = await payrollService.getEmployeePayslips(parseInt(employeeId), {
            page: parseInt(page),
            limit: parseInt(limit),
            tenantId: tenantOf(req)
        });
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

// Tax Rates
export const getTaxRates = async (req, res) => {
    try {
        const { countryCode } = req.query;
        const taxRates = await payrollService.getTaxRates(countryCode, tenantOf(req));
        res.json({ success: true, data: taxRates });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

export const createTaxRate = async (req, res) => {
    try {
        const createdBy = req.headers['employee-id'];
        const taxRate = await payrollService.createTaxRate(req.body, createdBy, tenantOf(req));
        res.status(201).json({ success: true, data: taxRate });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
};

// Audit Logs
export const getAuditLogs = async (req, res) => {
    try {
        const { page = 1, limit = 10, payrollRunId, payslipId } = req.query;
        const result = await payrollService.getAuditLogs({
            page: parseInt(page),
            limit: parseInt(limit),
            payrollRunId,
            payslipId,
            tenantId: tenantOf(req)
        });
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};
