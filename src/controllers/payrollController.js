
import payrollService from '../services/payrollService.js';

export const getPayrollRuns = async (req, res) => {
    try {
        const { page = 1, limit = 10, status } = req.query;
        const result = await payrollService.getPayrollRuns({ page, limit, status });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const getPayrollRunById = async (req, res) => {
    try {
        const { id } = req.params;
        const payrollRun = await payrollService.getPayrollRunById(parseInt(id));
        if (!payrollRun) {
            return res.status(404).json({ error: 'Payroll run not found' });
        }
        res.json(payrollRun);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const createPayrollRun = async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const payrollRun = await payrollService.createPayrollRun(req.body);
        res.status(201).json(payrollRun);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

export const processPayrollRun = async (req, res) => {
    try {
        const { id } = req.params;
        const result = await payrollService.processPayrollRun(parseInt(id));
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

export const finalizePayrollRun = async (req, res) => {
    try {
        const { id } = req.params;
        const result = await payrollService.finalizePayrollRun(parseInt(id));
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

export const cancelPayrollRun = async (req, res) => {
    try {
        const { id } = req.params;
        await payrollService.cancelPayrollRun(parseInt(id));
        res.json({ message: 'Payroll run cancelled successfully' });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

// Earning Types
export const getEarningTypes = async (req, res) => {
    try {
        const earningTypes = await payrollService.getEarningTypes();
        res.json(earningTypes);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const createEarningType = async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const earningType = await payrollService.createEarningType(req.body);
        res.status(201).json(earningType);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

export const updateEarningType = async (req, res) => {
    try {
        const { id } = req.params;
        const earningType = await payrollService.updateEarningType(parseInt(id), req.body);
        res.json(earningType);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

// Deduction Types
export const getDeductionTypes = async (req, res) => {
    try {
        const deductionTypes = await payrollService.getDeductionTypes();
        res.json(deductionTypes);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const createDeductionType = async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const deductionType = await payrollService.createDeductionType(req.body);
        res.status(201).json(deductionType);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

export const updateDeductionType = async (req, res) => {
    try {
        const { id } = req.params;
        const deductionType = await payrollService.updateDeductionType(parseInt(id), req.body);
        res.json(deductionType);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

// Employee Payroll Data
export const getEmployeePayrollData = async (req, res) => {
    try {
        const { employeeId } = req.params;
        const data = await payrollService.getEmployeePayrollData(parseInt(employeeId));
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const createEmploymentTerms = async (req, res) => {
    try {
        const { employeeId } = req.params;
        const employmentTerms = await payrollService.createEmploymentTerms({
            ...req.body,
            employeeId: parseInt(employeeId)
        });
        res.status(201).json(employmentTerms);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

export const createPayrollAssignment = async (req, res) => {
    try {
        const { employeeId } = req.params;
        const assignment = await payrollService.createPayrollAssignment({
            ...req.body,
            employeeId: parseInt(employeeId)
        });
        res.status(201).json(assignment);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

// Payslips
export const getPayslips = async (req, res) => {
    try {
        const { page = 1, limit = 10, payrollRunId, employeeId } = req.query;
        const result = await payrollService.getPayslips({ page, limit, payrollRunId, employeeId });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const getPayslipById = async (req, res) => {
    try {
        const { id } = req.params;
        const payslip = await payrollService.getPayslipById(parseInt(id));
        if (!payslip) {
            return res.status(404).json({ error: 'Payslip not found' });
        }
        res.json(payslip);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const distributePayslip = async (req, res) => {
    try {
        const { id } = req.params;
        const payslip = await payrollService.distributePayslip(parseInt(id));
        res.json(payslip);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

export const getEmployeePayslips = async (req, res) => {
    try {
        const { employeeId } = req.params;
        const { page = 1, limit = 10 } = req.query;
        const result = await payrollService.getEmployeePayslips(parseInt(employeeId), { page, limit });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// Tax Rates
export const getTaxRates = async (req, res) => {
    try {
        const { countryCode } = req.query;
        const taxRates = await payrollService.getTaxRates(countryCode);
        res.json(taxRates);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const createTaxRate = async (req, res) => {
    try {
        const taxRate = await payrollService.createTaxRate(req.body);
        res.status(201).json(taxRate);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

// Audit Logs
export const getAuditLogs = async (req, res) => {
    try {
        const { page = 1, limit = 10, payrollRunId, payslipId } = req.query;
        const result = await payrollService.getAuditLogs({ page, limit, payrollRunId, payslipId });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export default {
    getPayrollRuns,
    getPayrollRunById,
    createPayrollRun,
    processPayrollRun,
    finalizePayrollRun,
    cancelPayrollRun,
    getEarningTypes,
    createEarningType,
    updateEarningType,
    getDeductionTypes,
    createDeductionType,
    updateDeductionType,
    getEmployeePayrollData,
    createEmploymentTerms,
    createPayrollAssignment,
    getPayslips,
    getPayslipById,
    distributePayslip,
    getEmployeePayslips,
    getTaxRates,
    createTaxRate,
    getAuditLogs
};