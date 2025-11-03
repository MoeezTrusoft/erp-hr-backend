const { body, param, query } = require('express-validator');

const payrollValidation = {
    createPayrollRun: [
        body('periodStart').isISO8601().withMessage('Valid period start date is required'),
        body('periodEnd').isISO8601().withMessage('Valid period end date is required'),
        body('countryCode').isLength({ min: 2, max: 2 }).withMessage('Valid country code is required'),
        body('currencyCode').isLength({ min: 3, max: 3 }).withMessage('Valid currency code is required')
    ],

    createEarningType: [
        body('code').notEmpty().withMessage('Code is required'),
        body('name').notEmpty().withMessage('Name is required'),
        body('type').isIn(['EARNING', 'DEDUCTION']).withMessage('Valid type is required')
    ],

    createDeductionType: [
        body('code').notEmpty().withMessage('Code is required'),
        body('name').notEmpty().withMessage('Name is required'),
        body('type').isIn(['EARNING', 'DEDUCTION']).withMessage('Valid type is required')
    ],

    createEmploymentTerms: [
        body('baseSalary').isFloat({ min: 0 }).withMessage('Valid base salary is required'),
        body('payFrequency').isIn(['WEEKLY', 'BI_WEEKLY', 'SEMI_MONTHLY', 'MONTHLY']).withMessage('Valid pay frequency is required'),
        body('effectiveFrom').isISO8601().withMessage('Valid effective from date is required')
    ],

    createTaxRate: [
        body('countryCode').isLength({ min: 2, max: 2 }).withMessage('Valid country code is required'),
        body('bracketMin').isFloat({ min: 0 }).withMessage('Valid bracket minimum is required'),
        body('rate').isFloat({ min: 0, max: 1 }).withMessage('Valid rate between 0 and 1 is required'),
        body('effectiveFrom').isISO8601().withMessage('Valid effective from date is required')
    ]
};

module.exports = payrollValidation;