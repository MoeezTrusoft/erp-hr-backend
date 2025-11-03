import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const createTestEmployee = async (employeeData = {}) => {
    return prisma.employee.create({
        data: {
            first_name: 'Test',
            last_name: 'Employee',
            job_title: 'Test Position',
            hire_date: new Date(),
            status: 'active',
            ...employeeData
        }
    });
};

export const createTestPayrollRun = async (payrollRunData = {}) => {
    return prisma.payrollRun.create({
        data: {
            periodStart: new Date('2024-01-01'),
            periodEnd: new Date('2024-01-31'),
            countryCode: 'US',
            currencyCode: 'USD',
            status: 'PENDING',
            ...payrollRunData
        }
    });
};

export const createTestEmploymentTerms = async (employeeId, termsData = {}) => {
    return prisma.employmentTerms.create({
        data: {
            employeeId,
            baseSalary: 60000,
            payFrequency: 'MONTHLY',
            effectiveFrom: new Date('2024-01-01'),
            currency: 'USD',
            ...termsData
        }
    });
};

export const createTestEarningType = async (earningTypeData = {}) => {
    return prisma.payrollEarningType.create({
        data: {
            code: 'TEST_EARNING',
            name: 'Test Earning',
            type: 'EARNING',
            isTaxable: true,
            ...earningTypeData
        }
    });
};

export const createTestDeductionType = async (deductionTypeData = {}) => {
    return prisma.payrollDeductionType.create({
        data: {
            code: 'TEST_DEDUCTION',
            name: 'Test Deduction',
            type: 'DEDUCTION',
            ...deductionTypeData
        }
    });
};

export const cleanupTestData = async () => {
    try {
        await prisma.payrollAuditLog.deleteMany({});
        await prisma.payrollPayslip.deleteMany({});
        await prisma.payrollRun.deleteMany({});
        await prisma.payrollAssignment.deleteMany({});
        await prisma.employmentTerms.deleteMany({});
        await prisma.bankDetail.deleteMany({});
        await prisma.payrollEarningType.deleteMany({});
        await prisma.payrollDeductionType.deleteMany({});
        await prisma.taxRate.deleteMany({});
    } catch (error) {
        console.log('Cleanup warning:', error.message);
    }
};

export const waitForProcessing = (ms = 1000) => {
    return new Promise(resolve => setTimeout(resolve, ms));
};

export { prisma };