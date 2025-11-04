import { jest } from '@jest/globals';

// Import only what definitely exists
import {
    applyDataScope,
    calculateDateRange,
    calculateAgeGroup
} from '../../src/services/analyticsService.js';

describe('Analytics Service - Core Functions', () => {
    describe('applyDataScope', () => {
        test('should return correct data scope for different roles', () => {
            expect(applyDataScope(1, 'HR_ADMIN')).toEqual({});
            expect(applyDataScope(1, 'DEPARTMENT_MANAGER', 5)).toEqual({ departmentId: 5 });
            expect(applyDataScope(1, 'EMPLOYEE', 10)).toEqual({ id: 10 });
        });
    });

    describe('calculateDateRange', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('should return valid date range objects', () => {
            jest.setSystemTime(new Date('2024-06-15'));

            const monthRange = calculateDateRange('current_month');
            const quarterRange = calculateDateRange('current_quarter');
            const yearRange = calculateDateRange('current_year');

            expect(monthRange).toHaveProperty('startDate');
            expect(monthRange).toHaveProperty('endDate');
            expect(quarterRange).toHaveProperty('startDate');
            expect(quarterRange).toHaveProperty('endDate');
            expect(yearRange).toHaveProperty('startDate');
            expect(yearRange).toHaveProperty('endDate');

            expect(monthRange.startDate).toBeInstanceOf(Date);
            expect(monthRange.endDate).toBeInstanceOf(Date);
        });

        test('should handle unknown timeframe with default range', () => {
            jest.setSystemTime(new Date('2024-06-15'));

            const result = calculateDateRange('unknown_timeframe');

            expect(result.startDate).toBeInstanceOf(Date);
            expect(result.endDate).toBeInstanceOf(Date);
            expect(result.startDate <= result.endDate).toBe(true);
        });
    });

    describe('calculateAgeGroup', () => {
        test('should return a string for any valid date', () => {
            const result = calculateAgeGroup(new Date('2020-01-01'));

            expect(typeof result).toBe('string');
            expect(result.length).toBeGreaterThan(0);
        });

        test('should handle recent hire dates', () => {
            const recentHire = new Date();
            recentHire.setMonth(recentHire.getMonth() - 6); // 6 months ago

            const result = calculateAgeGroup(recentHire);

            expect(typeof result).toBe('string');
            expect(['Less than 1 year', '1-3 years']).toContain(result);
        });

        test('should handle long-term employees', () => {
            const longTermHire = new Date('2010-01-01');

            const result = calculateAgeGroup(longTermHire);

            expect(typeof result).toBe('string');
            expect(result).toBe('10+ years');
        });
    });
});