import express from 'express';
import * as payrollController from '../controllers/payrollController.js';


const router = express.Router();


// Payroll Runs
router.get('/runs', payrollController.getPayrollRuns);
router.get('/runs/:id', payrollController.getPayrollRunById);
router.post('/runs', payrollController.createPayrollRun);
router.put('/runs/:id/process', payrollController.processPayrollRun);
router.put('/runs/:id/finalize', payrollController.finalizePayrollRun);
router.delete('/runs/:id', payrollController.cancelPayrollRun);

// Payroll Configuration
router.get('/earning-types', payrollController.getEarningTypes);
router.post('/earning-types', payrollController.createEarningType);
router.put('/earning-types/:id', payrollController.updateEarningType);

router.get('/deduction-types', payrollController.getDeductionTypes);
router.post('/deduction-types', payrollController.createDeductionType);
router.put('/deduction-types/:id', payrollController.updateDeductionType);

// Employee Payroll Data
router.get('/employees/:employeeId/payroll-data', payrollController.getEmployeePayrollData);
router.post('/employees/:employeeId/employment-terms', payrollController.createEmploymentTerms);
router.post('/employees/:employeeId/payroll-assignments', payrollController.createPayrollAssignment);

// Payslips
router.get('/payslips', payrollController.getPayslips);
router.get('/payslips/:id', payrollController.getPayslipById);
router.post('/payslips/:id/distribute', payrollController.distributePayslip);
router.get('/employees/:employeeId/payslips', payrollController.getEmployeePayslips);

// Tax Configuration
router.get('/tax-rates', payrollController.getTaxRates);
router.post('/tax-rates', payrollController.createTaxRate);

// Audit Logs
router.get('/audit-logs', payrollController.getAuditLogs);

export default router;