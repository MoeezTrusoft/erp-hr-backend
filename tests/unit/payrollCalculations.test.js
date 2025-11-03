// tests/unit/payrollCalculations.test.js
const payrollService = require('../mocks/payrollServiceMock');

describe('Payroll Calculations - Unit Tests', function () {
    describe('calculateBaseSalary', function () {
        test('should calculate monthly salary correctly', function () {
            var annualSalary = 60000;
            var result = payrollService.calculateBaseSalary(annualSalary, 'MONTHLY');
            expect(result).toBe(5000);
        });

        test('should calculate weekly salary correctly', function () {
            var annualSalary = 52000;
            var result = payrollService.calculateBaseSalary(annualSalary, 'WEEKLY');
            expect(result).toBe(1000);
        });
    });

    describe('calculateTaxAmount', function () {
        test('should calculate tax using progressive brackets', function () {
            var taxRates = [
                { bracketMin: 0, bracketMax: 10000, rate: 0.1 },
                { bracketMin: 10000, bracketMax: 40000, rate: 0.15 },
                { bracketMin: 40000, bracketMax: null, rate: 0.25 }
            ];

            var result = payrollService.calculateTaxAmount(45000, taxRates);
            expect(result).toBe(6750);
        });
    });
});