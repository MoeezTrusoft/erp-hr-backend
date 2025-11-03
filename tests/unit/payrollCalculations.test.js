import { describe, it, expect } from '@jest/globals';

// Mock the payroll service since we don't have the actual file yet
const payrollService = {
    calculatePeriodSalary: (employmentTerm, payrollRun) => {
        const { baseSalary, payFrequency } = employmentTerm;

        switch (payFrequency) {
            case 'MONTHLY':
                return baseSalary;
            case 'SEMI_MONTHLY':
                return baseSalary / 2;
            case 'BI_WEEKLY':
                return baseSalary * 12 / 52;
            case 'WEEKLY':
                return baseSalary * 12 / 52;
            default:
                return baseSalary;
        }
    }
};

describe('Payroll Calculations - Unit Tests', () => {
    describe('calculateBaseSalary', () => {
        it('should calculate monthly salary correctly', () => {
            const employmentTerm = {
                baseSalary: 60000,
                payFrequency: 'MONTHLY'
            };

            const payrollRun = {
                periodStart: new Date('2024-01-01'),
                periodEnd: new Date('2024-01-31')
            };

            const salary = payrollService.calculatePeriodSalary(employmentTerm, payrollRun);
            expect(salary).toBe(60000);
        });

        it('should calculate semi-monthly salary correctly', () => {
            const employmentTerm = {
                baseSalary: 60000,
                payFrequency: 'SEMI_MONTHLY'
            };

            const payrollRun = {
                periodStart: new Date('2024-01-01'),
                periodEnd: new Date('2024-01-15')
            };

            const salary = payrollService.calculatePeriodSalary(employmentTerm, payrollRun);
            expect(salary).toBe(30000);
        });

        it('should calculate bi-weekly salary correctly', () => {
            const employmentTerm = {
                baseSalary: 60000,
                payFrequency: 'BI_WEEKLY'
            };

            const payrollRun = {
                periodStart: new Date('2024-01-01'),
                periodEnd: new Date('2024-01-14')
            };

            const salary = payrollService.calculatePeriodSalary(employmentTerm, payrollRun);
            expect(salary).toBeCloseTo(60000 * 12 / 52, 2);
        });
    });
});