import { jest } from '@jest/globals';

// Test only the functions that definitely exist
import {
    applyDataScope,
    calculateDateRange,
    calculateMedian,
    createSalaryDistribution,
    calculateWorkingDays,
    calculateAgeGroup
} from '../../src/services/analyticsService.js';

describe('Analytics Service - Core Functions', () => {
    describe('applyDataScope', () => {
        test('should return base condition for HR_ADMIN', () => {
            const result = applyDataScope(1, 'HR_ADMIN');
            expect(result).toEqual({});
        });

        test('should filter by department for DEPARTMENT_MANAGER', () => {
            const result = applyDataScope(1, 'DEPARTMENT_MANAGER', 5);
            expect(result).toEqual({ department_id: 5 });
        });
    });

    describe('calculateDateRange', () => {
        test('should calculate current month range', () => {
            const mockDate = new Date('2024-01-15T12:00:00Z');
            jest.useFakeTimers({ now: mockDate });

            const result = calculateDateRange('current_month');
            expect(result.startDate).toBeInstanceOf(Date);
            expect(result.endDate).toBeInstanceOf(Date);

            jest.useRealTimers();
        });
    });

    describe('calculateMedian', () => {
        test('should calculate median correctly', () => {
            expect(calculateMedian([1, 3, 5])).toBe(3);
            expect(calculateMedian([1, 3, 5, 7])).toBe(4);
        });
    });
});