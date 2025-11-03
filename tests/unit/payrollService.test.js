// tests/unit/payrollService.test.js
const payrollService = require('../mocks/payrollServiceMock');

// Mock Prisma client
jest.mock('@prisma/client', function () {
    var mockPrisma = {
        payrollRun: {
            findFirst: jest.fn(),
            create: jest.fn()
        }
    };
    return {
        PrismaClient: jest.fn(function () { return mockPrisma; })
    };
});

describe('Payroll Service - Unit Tests', function () {
    var mockPrisma;
    var testUser;

    beforeEach(function () {
        mockPrisma = new (require('@prisma/client')).PrismaClient();
        testUser = { id: 1, role: 'PAYROLL_ADMIN' };
        jest.clearAllMocks();
    });

    describe('createPayrollRunService', function () {
        test('should create a payroll run successfully', function () {
            return payrollService.createPayrollRunService({
                periodStart: '2024-01-01',
                periodEnd: '2024-01-31',
                countryCode: 'US',
                currencyCode: 'USD'
            }, testUser).then(function (result) {
                expect(result.id).toBe(1);
                expect(result.status).toBe('PENDING');
            });
        });
    });

    describe('calculateBaseSalary', function () {
        test('should calculate monthly salary correctly', function () {
            var result = payrollService.calculateBaseSalary(60000, 'MONTHLY');
            expect(result).toBe(5000);
        });
    });
});