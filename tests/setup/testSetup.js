const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Global test configuration
beforeAll(async () => {
    // Set test environment
    process.env.NODE_ENV = 'test';

    // Clean database before all tests
    await cleanDatabase();
});

afterAll(async () => {
    await prisma.$disconnect();
});

// Clean database function
const cleanDatabase = async () => {
    const tables = [
        'leave_requests',
        'leave_balances',
        'leave_policies',
        'holidays',
        'holiday_calendars',
        'regions',
        'employees'
    ];

    for (const table of tables) {
        try {
            await prisma.$executeRawUnsafe(`DELETE FROM "${table}";`);
        } catch (error) {
            console.log(`Note: Table ${table} doesn't exist or already clean`);
        }
    }
};

// Global test utilities
global.prisma = prisma;
global.cleanDatabase = cleanDatabase;