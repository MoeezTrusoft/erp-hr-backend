import express from 'express';
import * as payrollController from '../controllers/payrollController.js';
import * as taxFormController from '../controllers/taxFormController.js';
import { requirePermission } from '../middlewares/hrContext.middleware.js';


const router = express.Router();

// HR-03: deny-by-default authz on the C4 payroll surface. `admin` requires the
// hr:payroll permission for the method's action; `self` additionally lets an
// EMPLOYEE through to routes the controller self-scopes (own data only).
const admin = requirePermission('hr:payroll');
const self = requirePermission('hr:payroll', { allowSelf: true });


// Payroll Runs (org-wide — admin only)
router.get('/runs', admin, payrollController.getPayrollRuns);
router.get('/runs/:id', admin, payrollController.getPayrollRunById);
router.post('/runs', admin, payrollController.createPayrollRun);
router.put('/runs/:id/process', admin, payrollController.processPayrollRun);
// HR-02 / T-P4.1 — approval gate: a distinct approver must approve before finalize.
router.put('/runs/:id/approve', admin, payrollController.approvePayrollRun);
router.put('/runs/:id/finalize', admin, payrollController.finalizePayrollRun);
// HR-BANKFILE-03 / HR-PAY-04 — bank/ACH disbursement export (FINALIZED runs
// only). Deny-by-default gated like the rest of the C4 payroll surface; the
// service tenant-scopes the run and never logs decrypted account numbers.
router.get('/runs/:id/bank-file', admin, payrollController.exportBankDisbursementFile);
router.delete('/runs/:id', admin, payrollController.cancelPayrollRun);

// Payroll Configuration (admin only)
router.get('/earning-types', admin, payrollController.getEarningTypes);
router.post('/earning-types', admin, payrollController.createEarningType);
router.put('/earning-types/:id', admin, payrollController.updateEarningType);

router.get('/deduction-types', admin, payrollController.getDeductionTypes);
router.post('/deduction-types', admin, payrollController.createDeductionType);
router.put('/deduction-types/:id', admin, payrollController.updateDeductionType);

// Employee Payroll Data (self-scoped read; writes admin-only)
router.get('/employees/:employeeId/payroll-data', self, payrollController.getEmployeePayrollData);
router.post('/employees/:employeeId/employment-terms', admin, payrollController.createEmploymentTerms);
router.post('/employees/:employeeId/payroll-assignments', admin, payrollController.createPayrollAssignment);

// Payslips (list-all + distribute admin; single + own-list self-scoped)
router.get('/payslips', admin, payrollController.getPayslips);
router.get('/payslips/:id', self, payrollController.getPayslipById);
router.post('/payslips/:id/distribute', admin, payrollController.distributePayslip);
router.get('/employees/:employeeId/payslips', self, payrollController.getEmployeePayslips);

// Tax Configuration (admin only)
router.get('/tax-rates', admin, payrollController.getTaxRates);
router.post('/tax-rates', admin, payrollController.createTaxRate);

// HR-PAY-07 / HR-SEC-05 — statutory year-end tax forms (W-2 / 1099-NEC),
// computed from the tax year's FINALIZED runs. Admin-only (deny-by-default,
// same C4 hr:payroll gate); the service tenant-scopes every read, decrypts
// SSN/EIN in-memory only and never logs them. `export` streams a CSV artifact;
// the IRS EFW2/1099 fixed-width wire layout is a documented extension point.
router.get('/tax-forms/:taxYear', admin, taxFormController.getYearEndTaxForms);
router.get('/tax-forms/:taxYear/export', admin, taxFormController.exportYearEndTaxForms);

// Audit Logs (admin only)
router.get('/audit-logs', admin, payrollController.getAuditLogs);

export default router;