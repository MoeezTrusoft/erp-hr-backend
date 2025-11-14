import * as payrollService from '../services/payrollService.js';

export const getPayrollRuns = async (req, res) => {
    try {
        const { page = 1, limit = 10, status } = req.query;
        const result = await payrollService.getPayrollRuns({
            page: parseInt(page),
            limit: parseInt(limit),
            status
        });
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

export const getPayrollRunById = async (req, res) => {
    try {
        const { id } = req.params;
        const payrollRun = await payrollService.getPayrollRunById(parseInt(id));
        if (!payrollRun) {
            return res.status(404).json({ success: false, error: 'Payroll run not found' });
        }
        res.json({ success: true, data: payrollRun });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

export const createPayrollRun = async (req, res) => {
    try {
        const createdBy = req.headers['employee-id'];
        const payrollRun = await payrollService.createPayrollRun(req.body, createdBy);
        res.status(201).json({ success: true, data: payrollRun });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
};

export const processPayrollRun = async (req, res) => {
    try {
        const { id } = req.params;
        const updatedBy = req.headers['employee-id'];
        const result = await payrollService.processPayrollRun(parseInt(id),updatedBy);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
};

export const finalizePayrollRun = async (req, res) => {
    try {
        const { id } = req.params;
        const finalizedBy = req.headers['employee-id'];
        const result = await payrollService.finalizePayrollRun(parseInt(id),finalizedBy);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
};

export const cancelPayrollRun = async (req, res) => {
    try {
        const { id } = req.params;
        const cancelledBy = req.headers['employee-id'];
        await payrollService.cancelPayrollRun(parseInt(id),cancelledBy);
        res.json({ success: true, message: 'Payroll run cancelled successfully' });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
};

// Earning Types
export const getEarningTypes = async (req, res) => {
    try {
        const earningTypes = await payrollService.getEarningTypes();
        res.json({ success: true, data: earningTypes });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

export const createEarningType = async (req, res) => {
    try {
        const createdBy = req.headers['employee-id'];
        const earningType = await payrollService.createEarningType(req.body, createdBy);
        res.status(201).json({ success: true, data: earningType });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
};

export const updateEarningType = async (req, res) => {
    try {
        const { id } = req.params;
        const updatedBy = req.headers['employee-id'];
        const earningType = await payrollService.updateEarningType(parseInt(id), req.body, updatedBy);
        res.json({ success: true, data: earningType });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
};

// Deduction Types
export const getDeductionTypes = async (req, res) => {
    try {
        const deductionTypes = await payrollService.getDeductionTypes();
        res.json({ success: true, data: deductionTypes });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

export const createDeductionType = async (req, res) => {
    try {
        const createdBy = req.headers['employee-id'];
        const deductionType = await payrollService.createDeductionType(req.body,createdBy);
        res.status(201).json({ success: true, data: deductionType });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
};

export const updateDeductionType = async (req, res) => {
    try {
        const { id } = req.params;
        const updatedBy = req.headers['employee-id'];
        const deductionType = await payrollService.updateDeductionType(parseInt(id), req.body, updatedBy);
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

        const data = await payrollService.getEmployeePayrollData(parseInt(employeeId));
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
        });
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
        });
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
            employeeId
        });
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

export const getPayslipById = async (req, res) => {
    try {
        const { id } = req.params;
        const payslip = await payrollService.getPayslipById(parseInt(id));
        if (!payslip) {
            return res.status(404).json({ success: false, error: 'Payslip not found' });
        }

        // Check if user has permission to view this payslip
        if (req.user.role === 'EMPLOYEE' && req.user.id !== payslip.employeeId) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        res.json({ success: true, data: payslip });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

export const distributePayslip = async (req, res) => {
    try {
        const { id } = req.params;
        const createdBy = req.headers['employee-id'];
        const payslip = await payrollService.distributePayslip(parseInt(id),createdBy);
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
            limit: parseInt(limit)
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
        const taxRates = await payrollService.getTaxRates(countryCode);
        res.json({ success: true, data: taxRates });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

export const createTaxRate = async (req, res) => {
    try {
        const createdBy = req.headers['employee-id'];
        const taxRate = await payrollService.createTaxRate(req.body, createdBy);
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
            payslipId
        });
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};