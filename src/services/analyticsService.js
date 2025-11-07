import { PrismaClient } from '@prisma/client';
import {
    applyDataScope,
    calculateDateRange,
    calculateAgeGroup,
    calculateDiversityIndex,
    calculateMedian,
    createSalaryDistribution,
    calculateWorkingDays,
    generateDepartmentAlerts,
    identifyRecruitmentBottlenecks
} from '../utils/analyticsUtils.js';

const prisma = new PrismaClient();

/**
 * Standard Report Services
 */

export const generateHeadcountReport = async ({ tenantId, startDate, endDate, departmentId, location, userRole }) => {
    const dataScope = applyDataScope(tenantId, userRole, departmentId);

    // Get headcount data from fact_headcount table
    const headcountData = await prisma.fact_headcount.findMany({
        where: {
            ...dataScope,
            date: {
                gte: new Date(startDate),
                lte: new Date(endDate)
            }
        },
        include: {
            department: true,
            date_dimension: true
        },
        orderBy: {
            date: 'asc'
        }
    });

    // Aggregate by department and date
    const reportData = headcountData.reduce((acc, record) => {
        const key = `${record.department.name}_${record.date.toISOString().split('T')[0]}`;
        if (!acc[key]) {
            acc[key] = {
                department: record.department.name,
                date: record.date,
                headcount: 0,
                trend: 0
            };
        }
        acc[key].headcount += record.headcount;
        return acc;
    }, {});

    return Object.values(reportData);
};

export const generateTurnoverReport = async ({ tenantId, startDate, endDate, departmentId, terminationType, userRole }) => {
    const dataScope = applyDataScope(tenantId, userRole, departmentId);

    const turnoverData = await prisma.fact_attrition.findMany({
        where: {
            ...dataScope,
            date: {
                gte: new Date(startDate),
                lte: new Date(endDate)
            },
            ...(terminationType && { termination_type: terminationType })
        },
        include: {
            employee: {
                include: {
                    department: true
                }
            },
            date_dimension: true
        }
    });

    // Calculate turnover metrics
    const departmentTurnover = turnoverData.reduce((acc, record) => {
        const deptName = record.employee.department.name;
        if (!acc[deptName]) {
            acc[deptName] = {
                department: deptName,
                terminations: 0,
                voluntary: 0,
                involuntary: 0
            };
        }

        acc[deptName].terminations++;
        if (record.termination_type === 'VOLUNTARY') {
            acc[deptName].voluntary++;
        } else {
            acc[deptName].involuntary++;
        }

        return acc;
    }, {});

    // Calculate turnover rates
    const headcountData = await prisma.fact_headcount.findMany({
        where: {
            ...dataScope,
            date: {
                gte: new Date(startDate),
                lte: new Date(endDate)
            }
        }
    });

    Object.values(departmentTurnover).forEach(dept => {
        const deptHeadcount = headcountData
            .filter(h => h.department.name === dept.department)
            .reduce((sum, h) => sum + h.headcount, 0);

        const avgHeadcount = deptHeadcount / Math.max(1, headcountData.filter(h => h.department.name === dept.department).length);
        dept.turnoverRate = avgHeadcount > 0 ? (dept.terminations / avgHeadcount) * 100 : 0;
    });

    return Object.values(departmentTurnover);
};

export const generateSalaryReport = async ({ tenantId, departmentId, jobGrade, location, userRole }) => {
    const dataScope = applyDataScope(tenantId, userRole, departmentId);

    const salaryData = await prisma.fact_payroll.findMany({
        where: {
            ...dataScope,
            ...(jobGrade && { job_grade: jobGrade })
        },
        include: {
            employee: {
                include: {
                    department: true
                }
            }
        }
    });

    // Aggregate salary data
    const reportData = salaryData.reduce((acc, record) => {
        const deptName = record.employee.department.name;
        if (!acc[deptName]) {
            acc[deptName] = {
                department: deptName,
                salaries: [],
                min: 0,
                max: 0,
                avg: 0,
                median: 0
            };
        }

        acc[deptName].salaries.push(record.total_pay);
        return acc;
    }, {});

    // Calculate statistics
    Object.values(reportData).forEach(dept => {
        if (dept.salaries.length > 0) {
            dept.min = Math.min(...dept.salaries);
            dept.max = Math.max(...dept.salaries);
            dept.avg = dept.salaries.reduce((sum, salary) => sum + salary, 0) / dept.salaries.length;
            dept.median = calculateMedian(dept.salaries);
        }
        delete dept.salaries; // Remove raw data from response
    });

    return Object.values(reportData);
};

export const generateLeaveBalancesReport = async ({ tenantId, departmentId, employeeId, userRole }) => {
    const dataScope = applyDataScope(tenantId, userRole, departmentId);

    const leaveData = await prisma.leave_balances.findMany({
        where: {
            ...dataScope,
            ...(employeeId && { employee_id: parseInt(employeeId) })
        },
        include: {
            employee: {
                include: {
                    department: true
                }
            }
        }
    });

    return leaveData.map(record => ({
        employeeName: `${record.employee.first_name} ${record.employee.last_name}`,
        department: record.employee.department.name,
        leaveType: record.leave_type,
        entitledDays: record.entitled_days,
        takenDays: record.taken_days,
        balance: record.balance_days,
        fiscalYear: record.fiscal_year
    }));
};

export const generateAbsenceReport = async ({ tenantId, startDate, endDate, departmentId, absenceType, userRole }) => {
    const dataScope = applyDataScope(tenantId, userRole, departmentId);

    const absenceData = await prisma.fact_attendance.findMany({
        where: {
            ...dataScope,
            date: {
                gte: new Date(startDate),
                lte: new Date(endDate)
            },
            ...(absenceType && { absence_type: absenceType })
        },
        include: {
            employee: {
                include: {
                    department: true
                }
            }
        }
    });

    // Calculate absence metrics
    const reportData = absenceData.reduce((acc, record) => {
        const deptName = record.employee.department.name;
        const empName = `${record.employee.first_name} ${record.employee.last_name}`;

        if (!acc[deptName]) {
            acc[deptName] = {
                department: deptName,
                employees: {},
                totalDays: 0,
                absenceRate: 0
            };
        }

        if (!acc[deptName].employees[empName]) {
            acc[deptName].employees[empName] = {
                name: empName,
                absenceDays: 0,
                absenceType: record.absence_type
            };
        }

        acc[deptName].employees[empName].absenceDays += record.absence_days;
        acc[deptName].totalDays += record.absence_days;

        return acc;
    }, {});

    // Calculate absence rates
    const workingDays = calculateWorkingDays(new Date(startDate), new Date(endDate));
    Object.values(reportData).forEach(dept => {
        const employeeCount = Object.keys(dept.employees).length;
        const totalPossibleDays = employeeCount * workingDays;
        dept.absenceRate = totalPossibleDays > 0 ? (dept.totalDays / totalPossibleDays) * 100 : 0;
        dept.employees = Object.values(dept.employees); // Convert to array
    });

    return Object.values(reportData);
};

export const generateEEOReport = async ({ tenantId, departmentId, location, userRole }) => {
    const dataScope = applyDataScope(tenantId, userRole, departmentId);

    const employees = await prisma.employees.findMany({
        where: dataScope,
        include: {
            department: true
        }
    });

    // Group by department and demographics
    const eeoData = employees.reduce((acc, employee) => {
        const deptName = employee.department.name;
        if (!acc[deptName]) {
            acc[deptName] = {
                department: deptName,
                demographics: {}
            };
        }

        const demoKey = employee.gender || 'Not Specified'; // Assuming gender field exists
        if (!acc[deptName].demographics[demoKey]) {
            acc[deptName].demographics[demoKey] = 0;
        }

        acc[deptName].demographics[demoKey]++;
        return acc;
    }, {});

    // Calculate percentages and diversity index
    Object.values(eeoData).forEach(dept => {
        const total = Object.values(dept.demographics).reduce((sum, count) => sum + count, 0);
        dept.totalEmployees = total;
        dept.demographics = Object.entries(dept.demographics).map(([group, count]) => ({
            group,
            count,
            percentage: total > 0 ? (count / total) * 100 : 0
        }));
        dept.diversityIndex = calculateDiversityIndex(Object.values(dept.demographics.map(d => d.count)));
    });

    return Object.values(eeoData);
};

export const generateRecruitmentPipelineReport = async ({ tenantId, status, departmentId, hiringManagerId, userRole }) => {
    const dataScope = applyDataScope(tenantId, userRole, departmentId);

    const pipelineData = await prisma.recruitment_pipeline.findMany({
        where: {
            ...dataScope,
            ...(status && { status }),
            ...(hiringManagerId && { hiring_manager_id: parseInt(hiringManagerId) })
        },
        include: {
            requisition: {
                include: {
                    department: true
                }
            },
            candidates: true
        }
    });

    // Aggregate pipeline metrics
    const reportData = pipelineData.reduce((acc, record) => {
        const reqId = record.requisition.id;
        if (!acc[reqId]) {
            acc[reqId] = {
                requisitionId: reqId,
                jobTitle: record.requisition.job_title,
                department: record.requisition.department.name,
                hiringManager: record.requisition.hiring_manager,
                status: record.status,
                stages: {
                    applied: 0,
                    screened: 0,
                    interviewed: 0,
                    offered: 0,
                    hired: 0
                }
            };
        }

        // Count candidates by stage
        record.candidates.forEach(candidate => {
            if (acc[reqId].stages.hasOwnProperty(candidate.stage)) {
                acc[reqId].stages[candidate.stage]++;
            }
        });

        return acc;
    }, {});

    return Object.values(reportData);
};

/**
 * Dashboard Services
 */

export const getDashboardKPIs = async ({ tenantId, timeframe, userRole }) => {
    const { startDate, endDate } = calculateDateRange(timeframe);
    const dataScope = applyDataScope(tenantId, userRole);

    // Get multiple metrics in parallel
    const [
        headcountData,
        turnoverData,
        absenceData,
        payrollData,
        performanceData
    ] = await Promise.all([
        // Headcount
        prisma.fact_headcount.findMany({
            where: {
                ...dataScope,
                date: {
                    gte: startDate,
                    lte: endDate
                }
            }
        }),
        // Turnover
        prisma.fact_attrition.findMany({
            where: {
                ...dataScope,
                date: {
                    gte: startDate,
                    lte: endDate
                }
            }
        }),
        // Absence
        prisma.fact_attendance.findMany({
            where: {
                ...dataScope,
                date: {
                    gte: startDate,
                    lte: endDate
                }
            }
        }),
        // Payroll
        prisma.fact_payroll.findMany({
            where: {
                ...dataScope,
                date: {
                    gte: startDate,
                    lte: endDate
                }
            }
        }),
        // Performance (assuming performance table exists)
        prisma.performance_reviews.findMany({
            where: {
                ...dataScope,
                review_date: {
                    gte: startDate,
                    lte: endDate
                }
            }
        })
    ]);

    // Calculate KPIs
    const totalHeadcount = headcountData.reduce((sum, record) => sum + record.headcount, 0);
    const avgHeadcount = headcountData.length > 0 ? totalHeadcount / headcountData.length : 0;
    const turnoverRate = avgHeadcount > 0 ? (turnoverData.length / avgHeadcount) * 100 : 0;

    const totalPayroll = payrollData.reduce((sum, record) => sum + record.total_pay, 0);
    const avgSalary = payrollData.length > 0 ? totalPayroll / payrollData.length : 0;

    const totalAbsenceDays = absenceData.reduce((sum, record) => sum + record.absence_days, 0);
    const workingDays = calculateWorkingDays(startDate, endDate);
    const absenteeismRate = workingDays > 0 ? (totalAbsenceDays / (avgHeadcount * workingDays)) * 100 : 0;

    const avgPerformance = performanceData.length > 0
        ? performanceData.reduce((sum, record) => sum + record.rating, 0) / performanceData.length
        : 0;

    return {
        headcount: totalHeadcount,
        turnoverRate: parseFloat(turnoverRate.toFixed(2)),
        absenteeismRate: parseFloat(absenteeismRate.toFixed(2)),
        avgSalary: parseFloat(avgSalary.toFixed(2)),
        totalPayroll: parseFloat(totalPayroll.toFixed(2)),
        avgPerformance: parseFloat(avgPerformance.toFixed(1)),
        alerts: generateDepartmentAlerts({
            turnoverRate,
            absenteeismRate,
            performance: avgPerformance
        })
    };
};

export const getDepartmentDashboard = async ({ tenantId, departmentId, timeframe, userRole }) => {
    const dataScope = applyDataScope(tenantId, userRole, departmentId);
    const { startDate, endDate } = calculateDateRange(timeframe);

    // Get department-specific data
    const [headcountTrend, turnoverData, absenceData, performanceData] = await Promise.all([
        prisma.fact_headcount.findMany({
            where: {
                ...dataScope,
                date: {
                    gte: startDate,
                    lte: endDate
                }
            },
            orderBy: { date: 'asc' }
        }),
        prisma.fact_attrition.findMany({
            where: {
                ...dataScope,
                date: {
                    gte: startDate,
                    lte: endDate
                }
            },
            include: {
                employee: true
            }
        }),
        prisma.fact_attendance.findMany({
            where: {
                ...dataScope,
                date: {
                    gte: startDate,
                    lte: endDate
                }
            }
        }),
        prisma.performance_reviews.findMany({
            where: {
                ...dataScope,
                review_date: {
                    gte: startDate,
                    lte: endDate
                }
            }
        })
    ]);

    // Calculate department metrics
    const currentHeadcount = headcountTrend.length > 0 ? headcountTrend[headcountTrend.length - 1].headcount : 0;
    const turnoverRate = currentHeadcount > 0 ? (turnoverData.length / currentHeadcount) * 100 : 0;
    const avgPerformance = performanceData.length > 0
        ? performanceData.reduce((sum, record) => sum + record.rating, 0) / performanceData.length
        : 0;

    return {
        departmentId,
        currentHeadcount,
        turnoverRate: parseFloat(turnoverRate.toFixed(2)),
        avgPerformance: parseFloat(avgPerformance.toFixed(1)),
        headcountTrend: headcountTrend.map(record => ({
            date: record.date,
            headcount: record.headcount
        })),
        recentTurnovers: turnoverData.slice(0, 5).map(record => ({
            employeeName: `${record.employee.first_name} ${record.employee.last_name}`,
            terminationDate: record.date,
            type: record.termination_type
        })),
        alerts: generateDepartmentAlerts({
            turnoverRate,
            absenteeismRate: 0, // Calculate if needed
            performance: avgPerformance
        })
    };
};

export const getRecruitmentDashboard = async ({ tenantId, timeframe, userRole }) => {
    const { startDate, endDate } = calculateDateRange(timeframe);
    const dataScope = applyDataScope(tenantId, userRole);

    const recruitmentData = await prisma.recruitment_pipeline.findMany({
        where: {
            ...dataScope,
            created_at: {
                gte: startDate,
                lte: endDate
            }
        },
        include: {
            candidates: true,
            requisition: {
                include: {
                    department: true
                }
            }
        }
    });

    // Calculate recruitment metrics
    const openPositions = recruitmentData.filter(req => req.status === 'OPEN').length;
    const totalCandidates = recruitmentData.reduce((sum, req) => sum + req.candidates.length, 0);

    const stageCounts = {
        applied: 0,
        screened: 0,
        interviewed: 0,
        offered: 0,
        hired: 0
    };

    recruitmentData.forEach(req => {
        req.candidates.forEach(candidate => {
            if (stageCounts.hasOwnProperty(candidate.stage)) {
                stageCounts[candidate.stage]++;
            }
        });
    });

    // Calculate conversion rates
    const conversionRates = {
        screenToInterview: stageCounts.screened > 0 ? (stageCounts.interviewed / stageCounts.screened) * 100 : 0,
        interviewToOffer: stageCounts.interviewed > 0 ? (stageCounts.offered / stageCounts.interviewed) * 100 : 0,
        offerToHire: stageCounts.offered > 0 ? (stageCounts.hired / stageCounts.offered) * 100 : 0
    };

    return {
        openPositions,
        totalCandidates,
        stageCounts,
        conversionRates: Object.fromEntries(
            Object.entries(conversionRates).map(([key, value]) => [key, parseFloat(value.toFixed(2))])
        ),
        bottlenecks: identifyRecruitmentBottlenecks(conversionRates),
        timeToFill: 42 // This would be calculated from actual data
    };
};

export const getPerformanceDashboard = async ({ tenantId, timeframe, userRole }) => {
    const { startDate, endDate } = calculateDateRange(timeframe);
    const dataScope = applyDataScope(tenantId, userRole);

    const performanceData = await prisma.performance_reviews.findMany({
        where: {
            ...dataScope,
            review_date: {
                gte: startDate,
                lte: endDate
            }
        },
        include: {
            employee: {
                include: {
                    department: true
                }
            }
        }
    });

    // Calculate performance metrics
    const completionRate = performanceData.length > 0
        ? (performanceData.filter(record => record.status === 'COMPLETED').length / performanceData.length) * 100
        : 0;

    const ratingsDistribution = {
        '1': 0, '2': 0, '3': 0, '4': 0, '5': 0
    };

    performanceData.forEach(record => {
        const rating = Math.floor(record.rating).toString();
        if (ratingsDistribution.hasOwnProperty(rating)) {
            ratingsDistribution[rating]++;
        }
    });

    const avgRating = performanceData.length > 0
        ? performanceData.reduce((sum, record) => sum + record.rating, 0) / performanceData.length
        : 0;

    return {
        completionRate: parseFloat(completionRate.toFixed(2)),
        avgRating: parseFloat(avgRating.toFixed(1)),
        ratingsDistribution,
        totalReviews: performanceData.length,
        overdueReviews: performanceData.filter(record => record.status === 'OVERDUE').length
    };
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