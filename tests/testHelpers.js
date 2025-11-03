// tests/testHelpers.js
const jwt = require('jsonwebtoken');

function createTestUser(overrides) {
    if (overrides === void 0) { overrides = {}; }
    return Object.assign({
        id: 1,
        email: 'test@example.com',
        first_name: 'Test',
        last_name: 'User',
        role: 'PAYROLL_ADMIN'
    }, overrides);
}

function createTestToken(user) {
    return jwt.sign(user, process.env.JWT_SECRET || 'test-secret');
}

function createTestEmployee(overrides) {
    if (overrides === void 0) { overrides = {}; }
    return Object.assign({
        first_name: 'John',
        last_name: 'Doe',
        job_title: 'Software Engineer',
        hire_date: new Date('2020-01-01'),
        status: 'ACTIVE'
    }, overrides);
}

function createTestPayrollRun(overrides) {
    if (overrides === void 0) { overrides = {}; }
    return Object.assign({
        periodStart: new Date('2024-01-01'),
        periodEnd: new Date('2024-01-31'),
        countryCode: 'US',
        currencyCode: 'USD',
        status: 'PENDING'
    }, overrides);
}

function createTestEmploymentTerms(employeeId, overrides) {
    if (overrides === void 0) { overrides = {}; }
    return Object.assign({
        employeeId: employeeId,
        baseSalary: 60000,
        currency: 'USD',
        payFrequency: 'MONTHLY',
        effectiveFrom: new Date('2024-01-01')
    }, overrides);
}

function createTestEarningType(overrides) {
    if (overrides === void 0) { overrides = {}; }
    return Object.assign({
        code: 'BASE_SALARY',
        name: 'Base Salary',
        type: 'EARNING',
        isTaxable: true
    }, overrides);
}

function createTestDeductionType(overrides) {
    if (overrides === void 0) { overrides = {}; }
    return Object.assign({
        code: 'INCOME_TAX',
        name: 'Income Tax',
        type: 'DEDUCTION',
        rate: 20.0
    }, overrides);
}

function createTestTaxRate(overrides) {
    if (overrides === void 0) { overrides = {}; }
    return Object.assign({
        countryCode: 'US',
        bracketMin: 0,
        bracketMax: 10000,
        rate: 0.1,
        effectiveFrom: new Date('2024-01-01')
    }, overrides);
}

module.exports = {
    createTestUser: createTestUser,
    createTestToken: createTestToken,
    createTestEmployee: createTestEmployee,
    createTestPayrollRun: createTestPayrollRun,
    createTestEmploymentTerms: createTestEmploymentTerms,
    createTestEarningType: createTestEarningType,
    createTestDeductionType: createTestDeductionType,
    createTestTaxRate: createTestTaxRate
};