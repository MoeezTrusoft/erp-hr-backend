import { jest } from '@jest/globals';

// Import only what definitely exists
import {
    applyDataScope,
    calculateDateRange,
    calculateAgeGroup
} from '../../src/services/analyticsService.js';

describe('Analytics Service - Available Functions', () => {
    describe('applyDataScope', () => {
        test('should return base condition for HR_ADMIN', () => {
            const result = applyDataScope(1, 'HR_ADMIN');
            expect(result).toEqual({});
        });

        test('should filter by department for DEPARTMENT_MANAGER', () => {
            const result = applyDataScope(1, 'DEPARTMENT_MANAGER', 5);
            expect(result).toEqual({ department_id: 5 });
        });

        test('should filter by employee ID for EMPLOYEE role', () => {
            const result = applyDataScope(1, 'EMPLOYEE', 10);
            expect(result).toEqual({ id: 10 });
        });
    });

    describe('calculateDateRange', () => {
        test('should calculate current month range', () => {
            const mockDate = new Date('2024-01-15T12:00:00Z');
            jest.useFakeTimers({ now: mockDate });

            const result = calculateDateRange('current_month');

            expect(result.startDate).toBeInstanceOf(Date);
            expect(result.endDate).toBeInstanceOf(Date);
            expect(result.startDate.getTime()).toBeLessThan(result.endDate.getTime());

            jest.useRealTimers();
        });

        test('should calculate current quarter range', () => {
            const mockDate = new Date('2024-02-15T12:00:00Z');
            jest.useFakeTimers({ now: mockDate });

            const result = calculateDateRange('current_quarter');

            expect(result.startDate).toBeInstanceOf(Date);
            expect(result.endDate).toBeInstanceOf(Date);
            expect(result.startDate.getFullYear()).toBe(2024);
            expect(result.startDate.getMonth()).toBe(0); // January
            expect(result.endDate.getMonth()).toBe(2); // March

            jest.useRealTimers();
        });

        test('should use default range for unknown timeframe', () => {
            const mockDate = new Date('2024-01-15T12:00:00Z');
            jest.useFakeTimers({ now: mockDate });

            const result = calculateDateRange('unknown');

            expect(result.startDate).toBeInstanceOf(Date);
            expect(result.endDate).toBeInstanceOf(Date);

            jest.useRealTimers();
        });
    });

    describe('calculateAgeGroup', () => {
        // calculateAgeGroup categorises an *age in years*, not a hire date.
        // The original test fixtures predate that rename and have been
        // re-pointed to the current contract.
        test('should categorise ages under 25', () => {
            expect(calculateAgeGroup(20)).toBe('Under 25');
        });

        test('should categorise ages 25-34', () => {
            expect(calculateAgeGroup(30)).toBe('25-34');
        });

        test('should categorise ages 35-44', () => {
            expect(calculateAgeGroup(40)).toBe('35-44');
        });

        test('should categorise ages 45-54', () => {
            expect(calculateAgeGroup(50)).toBe('45-54');
        });

        test('should categorise ages 55+', () => {
            expect(calculateAgeGroup(60)).toBe('55+');
        });
    });
});