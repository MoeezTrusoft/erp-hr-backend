import { logAction } from "../utils/logs.js";
import { PrismaClient } from '@prisma/client';
import * as utils from '../utils/analyticsUtils.js';

const prisma = new PrismaClient();

/**
 * Standard Report Services
 */

export const generateHeadcountReport = async ({ tenantId, startDate, endDate, positionId, location, userRole }) => {
    try {
        // Validate parameters
        const start = utils.validateDate(startDate, 'startDate');
        const end = utils.validateDate(endDate, 'endDate');

        if (start > end) {
            throw new Error('startDate must be before endDate');
        }

        const dataScope = utils.applyDataScope(tenantId, userRole, positionId);

        // Get employee data with positions
        const employees = await prisma.employee.findMany({
            where: {
                ...dataScope,
                hire_date: {
                    lte: end
                },
                OR: [
                    { status: 'ACTIVE' },
                    {
                        status: 'INACTIVE',
                        AND: {
                            // Include employees who were active during the period but left
                            hire_date: { lte: end },
                            // You might need to add termination_date logic here
                        }
                    }
                ]
            },
            include: {
                Position: true
            }
        });

        // Group by position and calculate headcount
        const headcountByPosition = employees.reduce((acc, employee) => {
            const positionTitle = employee.Position?.title || 'No Position';
            if (!acc[positionTitle]) {
                acc[positionTitle] = {
                    position: positionTitle,
                    headcount: 0,
                    activeEmployees: []
                };
            }
            acc[positionTitle].headcount++;
            acc[positionTitle].activeEmployees.push({
                name: `${employee.first_name} ${employee.last_name}`,
                hireDate: employee.hire_date,
                status: employee.status
            });
            return acc;
        }, {});

        return Object.values(headcountByPosition);

    } catch (error) {
        console.error('Headcount Report Service Error:', error);
        throw error;
    }
};

export const generateTurnoverReport = async ({ tenantId, startDate, endDate, positionId, terminationType, userRole }) => {
    try {
        const start = utils.validateDate(startDate, 'startDate');
        const end = utils.validateDate(endDate, 'endDate');

        const dataScope = utils.applyDataScope(tenantId, userRole, positionId);

        // Get employees who left during the period
        const turnoverData = await prisma.employee.findMany({
            where: {
                ...dataScope,
                status: 'INACTIVE',
                // Assuming we track termination date - you might need to adjust this logic
                updated_at: {
                    gte: start,
                    lte: end
                }
            },
            include: {
                Position: true
            }
        });

        // Calculate turnover metrics by position
        const positionTurnover = turnoverData.reduce((acc, employee) => {
            const positionTitle = employee.Position?.title || 'No Position';
            if (!acc[positionTitle]) {
                acc[positionTitle] = {
                    position: positionTitle,
                    terminations: 0,
                    turnoverRate: 0
                };
            }

            acc[positionTitle].terminations++;
            return acc;
        }, {});

        // Calculate total headcount for turnover rate calculation
        const totalEmployees = await prisma.employee.count({
            where: {
                ...dataScope,
                status: 'ACTIVE'
            }
        });

        // Calculate turnover rates
        Object.values(positionTurnover).forEach(position => {
            position.turnoverRate = utils.calculateTurnoverRate(position.terminations, totalEmployees);
        });

        return Object.values(positionTurnover);

    } catch (error) {
        console.error('Turnover Report Service Error:', error);
        throw error;
    }
};

export const generateSalaryReport = async ({ tenantId, positionId, jobGrade, location, userRole }) => {
    try {
        const dataScope = utils.applyDataScope(tenantId, userRole, positionId);

        // Get salary data from employment terms
        const salaryData = await prisma.employmentTerms.findMany({
            where: {
                ...dataScope,
                effectiveTo: null // Current active terms
            },
            include: {
                employee: {
                    include: {
                        Position: true
                    }
                }
            }
        });

        // Aggregate salary data by position
        const reportData = salaryData.reduce((acc, record) => {
            const positionTitle = record.employee.Position?.title || 'No Position';
            if (!acc[positionTitle]) {
                acc[positionTitle] = {
                    position: positionTitle,
                    salaries: [],
                    employeeCount: 0
                };
            }

            acc[positionTitle].salaries.push(record.baseSalary);
            acc[positionTitle].employeeCount++;
            return acc;
        }, {});

        // Calculate statistics
        Object.values(reportData).forEach(position => {
            if (position.salaries.length > 0) {
                position.min = Math.min(...position.salaries);
                position.max = Math.max(...position.salaries);
                position.avg = utils.calculateAverage(position.salaries);
                position.median = utils.calculateMedian(position.salaries);
                position.stdDev = utils.calculateStandardDeviation(position.salaries);
                position.distribution = utils.createSalaryDistribution(position.salaries);
            }
            delete position.salaries; // Remove raw data from response
        });

        return Object.values(reportData);

    } catch (error) {
        console.error('Salary Report Service Error:', error);
        throw error;
    }
};

export const generateLeaveBalancesReport = async ({ tenantId, positionId, employeeId, userRole }) => {
    try {
        const dataScope = utils.applyDataScope(tenantId, userRole, positionId);

        const leaveData = await prisma.leaveBalance.findMany({
            where: {
                ...dataScope,
                ...(employeeId && { employeeId: parseInt(employeeId) })
            },
            include: {
                employee: {
                    include: {
                        Position: true
                    }
                },
                leavePolicy: true
            }
        });

        return leaveData.map(record => ({
            employeeName: `${record.employee.first_name} ${record.employee.last_name}`,
            position: record.employee.Position?.title || 'No Position',
            leaveType: record.leavePolicy.name,
            balance: record.balance,
            carryOverBalance: record.carryOverBalance,
            lastUpdated: record.lastUpdated
        }));

    } catch (error) {
        console.error('Leave Balances Report Error:', error);
        throw error;
    }
};

export const generateAbsenceReport = async ({ tenantId, startDate, endDate, positionId, absenceType, userRole }) => {
    try {
        const start = utils.validateDate(startDate, 'startDate');
        const end = utils.validateDate(endDate, 'endDate');

        const dataScope = utils.applyDataScope(tenantId, userRole, positionId);

        const absenceData = await prisma.attendance.findMany({
            where: {
                ...dataScope,
                date: {
                    gte: start,
                    lte: end
                },
                status: 'ABSENT'
            },
            include: {
                employee: {
                    include: {
                        Position: true
                    }
                }
            }
        });

        // Calculate absence metrics by position
        const reportData = absenceData.reduce((acc, record) => {
            const positionTitle = record.employee.Position?.title || 'No Position';
            const empName = `${record.employee.first_name} ${record.employee.last_name}`;

            if (!acc[positionTitle]) {
                acc[positionTitle] = {
                    position: positionTitle,
                    employees: {},
                    totalDays: 0,
                    absenceRate: 0
                };
            }

            if (!acc[positionTitle].employees[empName]) {
                acc[positionTitle].employees[empName] = {
                    name: empName,
                    absenceDays: 0
                };
            }

            // Count each absence day (assuming each record is one day)
            acc[positionTitle].employees[empName].absenceDays++;
            acc[positionTitle].totalDays++;

            return acc;
        }, {});

        // Calculate absence rates
        const workingDays = utils.calculateWorkingDays(start, end);
        Object.values(reportData).forEach(position => {
            const employeeCount = Object.keys(position.employees).length;
            const totalPossibleDays = employeeCount * workingDays;
            position.absenceRate = utils.calculateAbsenteeismRate(position.totalDays, totalPossibleDays);

            // Convert employees object to array
            position.employees = Object.values(position.employees);
        });

        return Object.values(reportData);

    } catch (error) {
        console.error('Absence Report Service Error:', error);
        throw error;
    }
};

export const generateEEOReport = async ({ tenantId, positionId, location, userRole }) => {
    try {
        const dataScope = utils.applyDataScope(tenantId, userRole, positionId);

        const employees = await prisma.employee.findMany({
            where: dataScope,
            include: {
                Position: true
            }
        });

        // Group by position and demographics
        const eeoData = employees.reduce((acc, employee) => {
            const positionTitle = employee.Position?.title || 'No Position';
            if (!acc[positionTitle]) {
                acc[positionTitle] = {
                    position: positionTitle,
                    demographics: {
                        gender: {},
                        yearsOfService: {}
                    }
                };
            }

            // Gender distribution
            const gender = employee.gender || 'Not Specified';
            acc[positionTitle].demographics.gender[gender] =
                (acc[positionTitle].demographics.gender[gender] || 0) + 1;

            // Years of service
            const yearsOfService = utils.calculateYearsOfService(employee.hire_date);
            acc[positionTitle].demographics.yearsOfService[yearsOfService] =
                (acc[positionTitle].demographics.yearsOfService[yearsOfService] || 0) + 1;

            return acc;
        }, {});

        // Calculate percentages and diversity index
        Object.values(eeoData).forEach(position => {
            const total = Object.values(position.demographics.gender).reduce((sum, count) => sum + count, 0);
            position.totalEmployees = total;

            // Convert to arrays with percentages
            Object.keys(position.demographics).forEach(category => {
                position.demographics[category] = Object.entries(position.demographics[category]).map(([group, count]) => ({
                    group,
                    count,
                    percentage: total > 0 ? (count / total) * 100 : 0
                }));
            });

            position.diversityIndex = utils.calculateDiversityIndex(
                Object.values(position.demographics.gender).map(g => g.count)
            );
        });

        return Object.values(eeoData);

    } catch (error) {
        console.error('EEO Report Service Error:', error);
        throw error;
    }
};

export const generateRecruitmentPipelineReport = async ({ tenantId, status, positionId, hiringManagerId, userRole }) => {
    try {
        const dataScope = utils.applyDataScope(tenantId, userRole, positionId);

        const pipelineData = await prisma.jobRequisition.findMany({
            where: {
                ...dataScope,
                ...(status && { status })
            },
            include: {
                position: true,
                requestedBy: true,
                postings: true
            }
        });

        // Aggregate pipeline metrics
        const reportData = pipelineData.map(requisition => ({
            requisitionId: requisition.id,
            jobTitle: requisition.title,
            position: requisition.position?.title || 'No Position',
            hiringManager: `${requisition.requestedBy.first_name} ${requisition.requestedBy.last_name}`,
            status: requisition.status,
            openings: requisition.openings,
            createdAt: requisition.createdAt,
            postings: requisition.postings.length
        }));

        return reportData;

    } catch (error) {
        console.error('Recruitment Pipeline Report Service Error:', error);
        throw error;
    }
};

/**
 * Dashboard Services
 */

export const getDashboardKPIs = async ({ tenantId, timeframe, userRole }) => {
    try {
        const { startDate, endDate } = utils.calculateDateRange(timeframe);
        const dataScope = utils.applyDataScope(tenantId, userRole);

        // Get multiple metrics in parallel
        const [
            employees,
            turnoverData,
            absenceData,
            salaryData,
            performanceData,
            recruitmentData
        ] = await Promise.all([
            // Employees
            prisma.employee.findMany({
                where: dataScope
            }),
            // Turnover (employees who became inactive)
            prisma.employee.findMany({
                where: {
                    ...dataScope,
                    status: 'INACTIVE',
                    updated_at: {
                        gte: startDate,
                        lte: endDate
                    }
                }
            }),
            // Absence
            prisma.attendance.findMany({
                where: {
                    ...dataScope,
                    date: {
                        gte: startDate,
                        lte: endDate
                    },
                    status: 'ABSENT'
                }
            }),
            // Salary data
            prisma.employmentTerms.findMany({
                where: {
                    ...dataScope,
                    effectiveTo: null
                },
                include: {
                    employee: true
                }
            }),
            // Performance data
            prisma.performanceReview.findMany({
                where: {
                    ...dataScope,
                    submittedAt: {
                        gte: startDate,
                        lte: endDate
                    },
                    status: 'FINALIZED'
                }
            }),
            // Recruitment data
            prisma.jobRequisition.findMany({
                where: {
                    ...dataScope,
                    createdAt: {
                        gte: startDate,
                        lte: endDate
                    }
                }
            })
        ]);

        // Calculate KPIs
        const totalHeadcount = employees.filter(emp => emp.status === 'ACTIVE').length;
        const turnoverRate = utils.calculateTurnoverRate(turnoverData.length, totalHeadcount);

        const salaries = salaryData.map(s => s.baseSalary);
        const totalPayroll = salaries.reduce((sum, salary) => sum + salary, 0);
        const avgSalary = utils.calculateAverage(salaries);

        const totalAbsenceDays = absenceData.length;
        const workingDays = utils.calculateWorkingDays(startDate, endDate);
        const absenteeismRate = utils.calculateAbsenteeismRate(totalAbsenceDays, totalHeadcount * workingDays);

        const performanceRatings = performanceData.map(p => p.overall_rating).filter(r => r !== null);
        const avgPerformance = performanceRatings.length > 0 ? utils.calculateAverage(performanceRatings) : 0;

        const openPositions = recruitmentData.filter(req => req.status === 'POSTED').length;

        return {
            headcount: totalHeadcount,
            turnoverRate: parseFloat(turnoverRate.toFixed(2)),
            absenteeismRate: parseFloat(absenteeismRate.toFixed(2)),
            avgSalary: parseFloat(avgSalary.toFixed(2)),
            totalPayroll: parseFloat(totalPayroll.toFixed(2)),
            avgPerformance: parseFloat(avgPerformance.toFixed(1)),
            openPositions,
            alerts: utils.generatePositionAlerts({
                turnoverRate,
                absenteeismRate,
                performance: avgPerformance
            })
        };

    } catch (error) {
        console.error('Dashboard KPIs Service Error:', error);
        throw error;
    }
};

export const getPositionDashboard = async ({ tenantId, positionId, timeframe, userRole }) => {
    try {
        const dataScope = utils.applyDataScope(tenantId, userRole, positionId);
        const { startDate, endDate } = utils.calculateDateRange(timeframe);

        // Get position-specific data
        const [employees, turnoverData, absenceData, performanceData] = await Promise.all([
            prisma.employee.findMany({
                where: {
                    ...dataScope,
                    positionId: positionId
                },
                include: {
                    Position: true
                }
            }),
            prisma.employee.findMany({
                where: {
                    ...dataScope,
                    positionId: positionId,
                    status: 'INACTIVE',
                    updated_at: {
                        gte: startDate,
                        lte: endDate
                    }
                }
            }),
            prisma.attendance.findMany({
                where: {
                    ...dataScope,
                    date: {
                        gte: startDate,
                        lte: endDate
                    },
                    status: 'ABSENT'
                },
                include: {
                    employee: true
                }
            }),
            prisma.performanceReview.findMany({
                where: {
                    ...dataScope,
                    submittedAt: {
                        gte: startDate,
                        lte: endDate
                    },
                    status: 'FINALIZED'
                },
                include: {
                    employee: true
                }
            })
        ]);

        // Calculate position metrics
        const currentHeadcount = employees.filter(emp => emp.status === 'ACTIVE').length;
        const turnoverRate = utils.calculateTurnoverRate(turnoverData.length, currentHeadcount);

        const performanceRatings = performanceData.map(p => p.overall_rating).filter(r => r !== null);
        const avgPerformance = performanceRatings.length > 0 ? utils.calculateAverage(performanceRatings) : 0;

        return {
            positionId,
            positionTitle: employees[0]?.Position?.title || 'Unknown Position',
            currentHeadcount,
            turnoverRate: parseFloat(turnoverRate.toFixed(2)),
            avgPerformance: parseFloat(avgPerformance.toFixed(1)),
            recentTurnovers: turnoverData.slice(0, 5).map(employee => ({
                employeeName: `${employee.first_name} ${employee.last_name}`,
                terminationDate: employee.updated_at
            })),
            alerts: utils.generatePositionAlerts({
                turnoverRate,
                absenteeismRate: 0, // Calculate if needed
                performance: avgPerformance
            })
        };

    } catch (error) {
        console.error('Position Dashboard Service Error:', error);
        throw error;
    }
};

export const getRecruitmentDashboard = async ({ tenantId, timeframe, userRole }) => {
    try {
        const { startDate, endDate } = utils.calculateDateRange(timeframe);
        const dataScope = utils.applyDataScope(tenantId, userRole);

        const recruitmentData = await prisma.jobRequisition.findMany({
            where: {
                ...dataScope,
                createdAt: {
                    gte: startDate,
                    lte: endDate
                }
            },
            include: {
                position: true,
                postings: true
            }
        });

        // Calculate recruitment metrics
        const openPositions = recruitmentData.filter(req =>
            ['POSTED', 'APPROVED', 'PENDING_APPROVAL'].includes(req.status)
        ).length;

        const filledPositions = recruitmentData.filter(req => req.status === 'CLOSED').length;

        // Simplified stage counts (you might need to enhance this based on your actual recruitment process)
        const stageCounts = {
            draft: recruitmentData.filter(req => req.status === 'DRAFT').length,
            pending_approval: recruitmentData.filter(req => req.status === 'PENDING_APPROVAL').length,
            posted: recruitmentData.filter(req => req.status === 'POSTED').length,
            closed: filledPositions
        };

        return {
            openPositions,
            filledPositions,
            totalRequisitions: recruitmentData.length,
            stageCounts,
            timeToFill: 42, // This would be calculated from actual data
            bottlenecks: ['Recruitment process needs enhancement'] // Placeholder
        };

    } catch (error) {
        console.error('Recruitment Dashboard Service Error:', error);
        throw error;
    }
};

export const getPerformanceDashboard = async ({ tenantId, timeframe, userRole }) => {
    try {
        const { startDate, endDate } = utils.calculateDateRange(timeframe);
        const dataScope = utils.applyDataScope(tenantId, userRole);

        const performanceData = await prisma.performanceReview.findMany({
            where: {
                ...dataScope,
                submittedAt: {
                    gte: startDate,
                    lte: endDate
                }
            },
            include: {
                employee: {
                    include: {
                        Position: true
                    }
                }
            }
        });

        // Calculate performance metrics
        const completionRate = performanceData.length > 0
            ? (performanceData.filter(record => record.status === 'FINALIZED').length / performanceData.length) * 100
            : 0;

        const ratingsDistribution = {
            '1': 0, '2': 0, '3': 0, '4': 0, '5': 0
        };

        performanceData.forEach(record => {
            if (record.overall_rating) {
                const rating = Math.floor(record.overall_rating).toString();
                if (ratingsDistribution.hasOwnProperty(rating)) {
                    ratingsDistribution[rating]++;
                }
            }
        });

        const performanceRatings = performanceData.map(p => p.overall_rating).filter(r => r !== null);
        const avgRating = performanceRatings.length > 0
            ? utils.calculateAverage(performanceRatings)
            : 0;

        return {
            completionRate: parseFloat(completionRate.toFixed(2)),
            avgRating: parseFloat(avgRating.toFixed(1)),
            ratingsDistribution,
            totalReviews: performanceData.length,
            overdueReviews: performanceData.filter(record => record.status === 'IN_PROGRESS').length
        };

    } catch (error) {
        console.error('Performance Dashboard Service Error:', error);
        throw error;
    }
};

/**
 * Export Service
 */

export const exportReport = async ({ tenantId, reportType, format, filters, userRole }) => {
    // This would generate the actual file based on reportType and format
    // For now, return a mock response
    return {
        message: `Exporting ${reportType} report in ${format} format`,
        filters,
        generatedAt: new Date().toISOString()
    };
};

export {
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
} from '../utils/analyticsUtils.js';