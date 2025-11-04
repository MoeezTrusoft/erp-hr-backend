import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Utility functions for data access and calculations
 */

export const applyDataScope = (tenantId, userRole, departmentId = null) => {
    // Since your schema doesn't have tenantId, we'll filter by department only
    if (userRole === 'DEPARTMENT_MANAGER' && departmentId) {
        return { departmentId };
    }

    // Regular employees can only see their own data
    if (userRole === 'EMPLOYEE') {
        return { id: departmentId }; // departmentId used as employeeId in this context
    }

    return {}; // HR_ADMIN and other roles see all data
};

export const calculateDateRange = (timeframe) => {
    const now = new Date();
    let startDate, endDate;

    switch (timeframe) {
        case 'current_month':
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
            break;
        case 'current_quarter':
            const quarter = Math.floor(now.getMonth() / 3);
            startDate = new Date(now.getFullYear(), quarter * 3, 1);
            endDate = new Date(now.getFullYear(), (quarter + 1) * 3, 0, 23, 59, 59, 999);
            break;
        case 'current_year':
            startDate = new Date(now.getFullYear(), 0, 1);
            endDate = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
            break;
        case 'last_30_days':
            startDate = new Date(now);
            startDate.setDate(now.getDate() - 30);
            endDate = new Date(now);
            break;
        default:
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    }

    return { startDate, endDate };
};

export const calculateAgeGroup = (hireDate) => {
    const today = new Date();
    const startDate = new Date(hireDate);
    let yearsOfService = today.getFullYear() - startDate.getFullYear();
    const monthDiff = today.getMonth() - startDate.getMonth();

    // Adjust if the anniversary hasn't occurred yet this year
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < startDate.getDate())) {
        yearsOfService--;
    }

    // Categorize by years of service, not age
    if (yearsOfService < 1) return 'Less than 1 year';
    if (yearsOfService < 3) return '1-3 years';
    if (yearsOfService < 5) return '3-5 years';
    if (yearsOfService < 10) return '5-10 years';
    return '10+ years';
};

// Add this function to your analyticsService.js if it's missing
export const calculateDiversityIndex = (counts) => {
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (total === 0) return 0;

    const proportions = counts.map(count => count / total);
    const sumSquares = proportions.reduce((sum, prop) => sum + Math.pow(prop, 2), 0);

    return 1 - sumSquares;
};

export const calculateMedian = (values) => {
    if (values.length === 0) return 0;

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
        return (sorted[middle - 1] + sorted[middle]) / 2;
    }

    return sorted[middle];
};

export const createSalaryDistribution = (salaries) => {
    if (salaries.length === 0) {
        return Array(5).fill(0).map((_, i) => ({
            range: `0 - 0`,
            count: 0
        }));
    }

    const min = Math.min(...salaries);
    const max = Math.max(...salaries);
    const range = max - min;
    const bucketSize = range / 5;

    const distribution = Array(5).fill(0).map((_, i) => ({
        range: `${Math.round(min + (i * bucketSize))} - ${Math.round(min + ((i + 1) * bucketSize))}`,
        count: 0
    }));

    salaries.forEach(salary => {
        const bucketIndex = Math.min(4, Math.floor((salary - min) / bucketSize));
        distribution[bucketIndex].count++;
    });

    return distribution;
};


export const calculateWorkingDays = (startDate, endDate) => {
    let count = 0;
    const current = new Date(startDate);

    while (current <= endDate) {
        const dayOfWeek = current.getDay();
        if (dayOfWeek !== 0 && dayOfWeek !== 6) { // Skip weekends
            count++;
        }
        current.setDate(current.getDate() + 1);
    }

    return count;
};

export const generateDepartmentAlerts = (metrics) => {
    const alerts = [];

    if (metrics.turnoverRate > 15) {
        alerts.push({
            type: 'HIGH_TURNOVER',
            severity: 'HIGH',
            message: `Turnover rate (${metrics.turnoverRate.toFixed(1)}%) exceeds threshold`,
            suggestedAction: 'Review retention strategies and conduct exit interviews'
        });
    }

    if (metrics.absenteeismRate > 5) {
        alerts.push({
            type: 'HIGH_ABSENTEEISM',
            severity: 'MEDIUM',
            message: `Absenteeism rate (${metrics.absenteeismRate.toFixed(1)}%) is elevated`,
            suggestedAction: 'Investigate root causes and consider wellness initiatives'
        });
    }

    if (metrics.performance < 3.0) {
        alerts.push({
            type: 'LOW_PERFORMANCE',
            severity: 'MEDIUM',
            message: 'Average performance rating below target',
            suggestedAction: 'Implement performance improvement plans and training'
        });
    }

    return alerts;
};

export const identifyRecruitmentBottlenecks = (conversionRates) => {
    const bottlenecks = [];

    if (conversionRates.screenToInterview < 30) {
        bottlenecks.push('Low screening-to-interview conversion - review candidate qualification criteria');
    }

    if (conversionRates.interviewToOffer < 40) {
        bottlenecks.push('Low interview-to-offer conversion - assess interview process and candidate experience');
    }

    if (conversionRates.offerToHire < 80) {
        bottlenecks.push('Low offer-to-hire conversion - review compensation competitiveness and offer process');
    }

    return bottlenecks;
};