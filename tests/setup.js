// tests/setup.js
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

beforeAll(function () {
    return prisma.$connect();
});

afterAll(function () {
    return prisma.$disconnect();
});

beforeEach(function () {
    return Promise.all([
        prisma.payrollAuditLog.deleteMany(),
        prisma.payrollDeduction.deleteMany(),
        prisma.payrollEarning.deleteMany(),
        prisma.payrollPayslip.deleteMany(),
        prisma.payrollRun.deleteMany(),
        prisma.payrollAssignment.deleteMany(),
        prisma.employmentTerms.deleteMany(),
        prisma.bankDetail.deleteMany(),
        prisma.payrollDeductionType.deleteMany(),
        prisma.payrollEarningType.deleteMany(),
        prisma.taxRate.deleteMany(),
        prisma.employee.deleteMany()
    ]);
});

module.exports = { prisma };