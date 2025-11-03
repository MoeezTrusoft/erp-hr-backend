import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Global test setup
beforeAll(async () => {
    // Ensure database is clean before tests
    await cleanupTestData();
});

afterAll(async () => {
    await prisma.$disconnect();
});

// Global test teardown
afterEach(async () => {
    await cleanupTestData();
});

async function cleanupTestData() {
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
        await prisma.employee.deleteMany({});
    } catch (error) {
        console.log('Cleanup warning:', error.message);
    }
}

global.prisma = prisma;