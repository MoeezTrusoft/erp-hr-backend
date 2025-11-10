import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Apply data scope filtering based on user role and permissions
 * @param {number} tenantId - The tenant ID
 * @param {string} userRole - User role (HR_ADMIN, HR_MANAGER, DEPARTMENT_MANAGER, EMPLOYEE)
 * @param {number} departmentId - Department ID for filtering
 * @returns {Object} Data scope conditions for database queries
 */
export const applyDataScope = (tenantId, userRole, departmentId = null) => {
    const conditions = {};

    // Since your schema doesn't have tenantId, we'll filter by department only
    if (userRole === 'DEPARTMENT_MANAGER' && departmentId) {
        conditions.department_id = departmentId;
    }

    // Regular employees can only see their own data
    if (userRole === 'EMPLOYEE' && departmentId) {
        conditions.id = departmentId; // departmentId used as employeeId in this context
    }

    // HR_ADMIN, HR_MANAGER, and other roles see all data (no additional filters)
    return conditions;
};

/**
 * Calculate date range based on timeframe parameter
 * @param {string} timeframe - Timeframe identifier
 * @returns {Object} startDate and endDate
 */
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
        case 'last_quarter':
            const currentQuarter = Math.floor(now.getMonth() / 3);
            const lastQuarter = currentQuarter === 0 ? 3 : currentQuarter - 1;
            const year = currentQuarter === 0 ? now.getFullYear() - 1 : now.getFullYear();
            startDate = new Date(year, lastQuarter * 3, 1);
            endDate = new Date(year, (lastQuarter + 1) * 3, 0, 23, 59, 59, 999);
            break;
        case 'last_year':
            startDate = new Date(now.getFullYear() - 1, 0, 1);
            endDate = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999);
            break;
        default:
            // Default to current month
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    }

    return { startDate, endDate };
};

/**
 * Calculate years of service group based on hire date
 * @param {Date|string} hireDate - Employee hire date
 * @returns {string} Years of service category
 */
export const calculateYearsOfService = (hireDate) => {
    const today = new Date();
    const startDate = new Date(hireDate);

    if (isNaN(startDate.getTime())) {
        return 'Invalid hire date';
    }

    let yearsOfService = today.getFullYear() - startDate.getFullYear();
    const monthDiff = today.getMonth() - startDate.getMonth();

    // Adjust if the anniversary hasn't occurred yet this year
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < startDate.getDate())) {
        yearsOfService--;
    }

    // Categorize by years of service
    if (yearsOfService < 1) return 'Less than 1 year';
    if (yearsOfService < 3) return '1-3 years';
    if (yearsOfService < 5) return '3-5 years';
    if (yearsOfService < 10) return '5-10 years';
    return '10+ years';
};

/**
 * Calculate diversity index (Simpson's Diversity Index)
 * @param {number[]} counts - Array of counts for each demographic group
 * @returns {number} Diversity index (0-1)
 */
export const calculateDiversityIndex = (counts) => {
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (total === 0) return 0;

    const proportions = counts.map(count => count / total);
    const sumSquares = proportions.reduce((sum, prop) => sum + Math.pow(prop, 2), 0);

    return 1 - sumSquares;
};

/**
 * Calculate median value from an array of numbers
 * @param {number[]} values - Array of numeric values
 * @returns {number} Median value
 */
export const calculateMedian = (values) => {
    if (values.length === 0) return 0;

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
        return (sorted[middle - 1] + sorted[middle]) / 2;
    }

    return sorted[middle];
};

/**
 * Create salary distribution buckets
 * @param {number[]} salaries - Array of salary values
 * @param {number} buckets - Number of buckets to create
 * @returns {Object[]} Salary distribution data
 */
export const createSalaryDistribution = (salaries, buckets = 5) => {
    if (salaries.length === 0) {
        return Array(buckets).fill(0).map((_, i) => ({
            range: `0 - 0`,
            count: 0,
            min: 0,
            max: 0
        }));
    }

    const min = Math.min(...salaries);
    const max = Math.max(...salaries);
    const range = max - min;
    const bucketSize = range / buckets;

    const distribution = Array(buckets).fill(0).map((_, i) => ({
        range: `${Math.round(min + (i * bucketSize))} - ${Math.round(min + ((i + 1) * bucketSize))}`,
        min: Math.round(min + (i * bucketSize)),
        max: Math.round(min + ((i + 1) * bucketSize)),
        count: 0
    }));

    salaries.forEach(salary => {
        const bucketIndex = Math.min(buckets - 1, Math.floor((salary - min) / bucketSize));
        distribution[bucketIndex].count++;
    });

    return distribution;
};

/**
 * Calculate number of working days between two dates (excluding weekends)
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @returns {number} Number of working days
 */
export const calculateWorkingDays = (startDate, endDate) => {
    if (!(startDate instanceof Date) || !(endDate instanceof Date)) {
        throw new Error('Invalid date parameters');
    }

    let count = 0;
    const current = new Date(startDate);

    while (current <= endDate) {
        const dayOfWeek = current.getDay();
        if (dayOfWeek !== 0 && dayOfWeek !== 6) { // Skip weekends (0=Sunday, 6=Saturday)
            count++;
        }
        current.setDate(current.getDate() + 1);
    }

    return count;
};

/**
 * Calculate turnover rate
 * @param {number} leavers - Number of employees who left
 * @param {number} averageHeadcount - Average headcount during period
 * @returns {number} Turnover rate percentage
 */
export const calculateTurnoverRate = (leavers, averageHeadcount) => {
    if (averageHeadcount <= 0) return 0;
    return (leavers / averageHeadcount) * 100;
};

/**
 * Calculate absenteeism rate
 * @param {number} absenceDays - Total days absent
 * @param {number} availableWorkDays - Total available work days
 * @returns {number} Absenteeism rate percentage
 */
export const calculateAbsenteeismRate = (absenceDays, availableWorkDays) => {
    if (availableWorkDays <= 0) return 0;
    return (absenceDays / availableWorkDays) * 100;
};

/**
 * Generate department alerts based on metrics
 * @param {Object} metrics - Department metrics
 * @returns {Object[]} Array of alert objects
 */
export const generateDepartmentAlerts = (metrics) => {
    const alerts = [];

    if (metrics.turnoverRate > 15) {
        alerts.push({
            type: 'HIGH_TURNOVER',
            severity: 'HIGH',
            message: `Turnover rate (${metrics.turnoverRate.toFixed(1)}%) exceeds 15% threshold`,
            suggestedAction: 'Review retention strategies and conduct exit interviews',
            metric: 'turnoverRate',
            value: metrics.turnoverRate,
            threshold: 15
        });
    }

    if (metrics.absenteeismRate > 5) {
        alerts.push({
            type: 'HIGH_ABSENTEEISM',
            severity: 'MEDIUM',
            message: `Absenteeism rate (${metrics.absenteeismRate.toFixed(1)}%) exceeds 5% threshold`,
            suggestedAction: 'Investigate root causes and consider wellness initiatives',
            metric: 'absenteeismRate',
            value: metrics.absenteeismRate,
            threshold: 5
        });
    }

    if (metrics.performance && metrics.performance < 3.0) {
        alerts.push({
            type: 'LOW_PERFORMANCE',
            severity: 'MEDIUM',
            message: `Average performance rating (${metrics.performance.toFixed(1)}) below 3.0 target`,
            suggestedAction: 'Implement performance improvement plans and training',
            metric: 'performance',
            value: metrics.performance,
            threshold: 3.0
        });
    }

    if (metrics.recruitmentTime && metrics.recruitmentTime > 60) {
        alerts.push({
            type: 'LONG_RECRUITMENT_TIME',
            severity: 'MEDIUM',
            message: `Average time to fill positions (${metrics.recruitmentTime} days) exceeds 60 days`,
            suggestedAction: 'Review recruitment process and candidate pipeline',
            metric: 'recruitmentTime',
            value: metrics.recruitmentTime,
            threshold: 60
        });
    }

    return alerts;
};

/**
 * Identify recruitment pipeline bottlenecks
 * @param {Object} conversionRates - Conversion rates between stages
 * @returns {string[]} Array of bottleneck descriptions
 */
export const identifyRecruitmentBottlenecks = (conversionRates) => {
    const bottlenecks = [];

    if (conversionRates.screenToInterview < 30) {
        bottlenecks.push({
            stage: 'SCREENING_TO_INTERVIEW',
            conversionRate: conversionRates.screenToInterview,
            message: 'Low screening-to-interview conversion - review candidate qualification criteria',
            severity: 'MEDIUM'
        });
    }

    if (conversionRates.interviewToOffer < 40) {
        bottlenecks.push({
            stage: 'INTERVIEW_TO_OFFER',
            conversionRate: conversionRates.interviewToOffer,
            message: 'Low interview-to-offer conversion - assess interview process and candidate experience',
            severity: 'HIGH'
        });
    }

    if (conversionRates.offerToHire < 80) {
        bottlenecks.push({
            stage: 'OFFER_TO_HIRE',
            conversionRate: conversionRates.offerToHire,
            message: 'Low offer-to-hire conversion - review compensation competitiveness and offer process',
            severity: 'HIGH'
        });
    }

    if (conversionRates.applyToScreen < 20) {
        bottlenecks.push({
            stage: 'APPLY_TO_SCREEN',
            conversionRate: conversionRates.applyToScreen,
            message: 'Low application-to-screening conversion - review job requirements and candidate sourcing',
            severity: 'LOW'
        });
    }

    return bottlenecks;
};

/**
 * Calculate conversion rates between recruitment stages
 * @param {Object} stageCounts - Counts at each recruitment stage
 * @returns {Object} Conversion rates between stages
 */
export const calculateRecruitmentConversionRates = (stageCounts) => {
    const rates = {};

    // Apply to Screen
    if (stageCounts.applied > 0) {
        rates.applyToScreen = (stageCounts.screened / stageCounts.applied) * 100;
    }

    // Screen to Interview
    if (stageCounts.screened > 0) {
        rates.screenToInterview = (stageCounts.interviewed / stageCounts.screened) * 100;
    }

    // Interview to Offer
    if (stageCounts.interviewed > 0) {
        rates.interviewToOffer = (stageCounts.offered / stageCounts.interviewed) * 100;
    }

    // Offer to Hire
    if (stageCounts.offered > 0) {
        rates.offerToHire = (stageCounts.hired / stageCounts.offered) * 100;
    }

    // Overall conversion
    if (stageCounts.applied > 0) {
        rates.overallConversion = (stageCounts.hired / stageCounts.applied) * 100;
    }

    return rates;
};

/**
 * Format currency values
 * @param {number} amount - Amount to format
 * @param {string} currency - Currency code (default: USD)
 * @param {string} locale - Locale (default: en-US)
 * @returns {string} Formatted currency string
 */
export const formatCurrency = (amount, currency = 'USD', locale = 'en-US') => {
    return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currency
    }).format(amount);
};

/**
 * Calculate age from birth date
 * @param {Date|string} birthDate - Birth date
 * @returns {number} Age in years
 */
export const calculateAge = (birthDate) => {
    const today = new Date();
    const birth = new Date(birthDate);

    if (isNaN(birth.getTime())) {
        return 0;
    }

    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();

    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
        age--;
    }

    return age;
};

/**
 * Calculate age group
 * @param {number} age - Age in years
 * @returns {string} Age group category
 */
export const calculateAgeGroup = (age) => {
    if (age < 25) return 'Under 25';
    if (age < 35) return '25-34';
    if (age < 45) return '35-44';
    if (age < 55) return '45-54';
    return '55+';
};

/**
 * Validate and parse date parameters
 * @param {string} dateStr - Date string to validate
 * @param {string} fieldName - Field name for error messages
 * @returns {Date} Validated date object
 */
export const validateDate = (dateStr, fieldName = 'Date') => {
    if (!dateStr) {
        throw new Error(`${fieldName} is required`);
    }

    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
        throw new Error(`${fieldName} must be a valid date`);
    }

    return date;
};

/**
 * Calculate average from array of numbers
 * @param {number[]} numbers - Array of numbers
 * @returns {number} Average value
 */
export const calculateAverage = (numbers) => {
    if (!numbers || numbers.length === 0) return 0;
    const sum = numbers.reduce((acc, num) => acc + num, 0);
    return sum / numbers.length;
};

/**
 * Calculate standard deviation
 * @param {number[]} numbers - Array of numbers
 * @returns {number} Standard deviation
 */
export const calculateStandardDeviation = (numbers) => {
    if (!numbers || numbers.length === 0) return 0;

    const avg = calculateAverage(numbers);
    const squareDiffs = numbers.map(num => Math.pow(num - avg, 2));
    const avgSquareDiff = calculateAverage(squareDiffs);

    return Math.sqrt(avgSquareDiff);
};

/**
 * Generate trend analysis (increasing, decreasing, stable)
 * @param {number[]} values - Array of values over time
 * @returns {string} Trend description
 */
export const analyzeTrend = (values) => {
    if (values.length < 2) return 'INSUFFICIENT_DATA';

    const first = values[0];
    const last = values[values.length - 1];
    const change = ((last - first) / first) * 100;

    if (Math.abs(change) < 5) return 'STABLE';
    return change > 0 ? 'INCREASING' : 'DECREASING';
};

/**
 * Format percentage values
 * @param {number} value - Decimal value (e.g., 0.15 for 15%)
 * @param {number} decimals - Number of decimal places
 * @returns {string} Formatted percentage string
 */
export const formatPercentage = (value, decimals = 2) => {
    return `${(value * 100).toFixed(decimals)}%`;
};

export default {
    applyDataScope,
    calculateDateRange,
    calculateYearsOfService,
    calculateDiversityIndex,
    calculateMedian,
    createSalaryDistribution,
    calculateWorkingDays,
    calculateTurnoverRate,
    calculateAbsenteeismRate,
    generateDepartmentAlerts,
    identifyRecruitmentBottlenecks,
    calculateRecruitmentConversionRates,
    formatCurrency,
    calculateAge,
    calculateAgeGroup,
    validateDate,
    calculateAverage,
    calculateStandardDeviation,
    analyzeTrend,
    formatPercentage
};