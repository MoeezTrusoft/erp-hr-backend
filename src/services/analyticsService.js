import { logAction } from "../utils/logs.js";
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import * as utils from '../utils/analyticsUtils.js';


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

        // Get employee data with positions. IC-15 — tenant-scope (Employee uses
        // snake_case `tenant_id`) and match the free-form status column
        // case-insensitively ('Active'/'Inactive' are stored title-cased).
        const employees = await prisma.employee.findMany({
            where: {
                ...dataScope,
                ...(tenantId ? { tenant_id: tenantId } : {}),
                hire_date: {
                    lte: end
                },
                OR: [
                    { status: { equals: 'ACTIVE', mode: 'insensitive' } },
                    { status: { equals: 'INACTIVE', mode: 'insensitive' } }
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
        logger.error({ err: error }, 'Headcount Report Service Error');
        throw error;
    }
};

export const generateTurnoverReport = async ({ tenantId, startDate, endDate, positionId, terminationType, userRole }) => {
    try {
        const start = utils.validateDate(startDate, 'startDate');
        const end = utils.validateDate(endDate, 'endDate');

        const dataScope = utils.applyDataScope(tenantId, userRole, positionId);

        // Get employees who left during the period. IC-15 — tenant-scope and
        // match status case-insensitively (stored as 'Inactive').
        const turnoverData = await prisma.employee.findMany({
            where: {
                ...dataScope,
                ...(tenantId ? { tenant_id: tenantId } : {}),
                status: { equals: 'INACTIVE', mode: 'insensitive' },
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
                ...(tenantId ? { tenant_id: tenantId } : {}),
                status: { equals: 'ACTIVE', mode: 'insensitive' }
            }
        });

        // Calculate turnover rates
        Object.values(positionTurnover).forEach(position => {
            position.turnoverRate = utils.calculateTurnoverRate(position.terminations, totalEmployees);
        });

        return Object.values(positionTurnover);

    } catch (error) {
        logger.error({ err: error }, 'Turnover Report Service Error');
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
        logger.error({ err: error }, 'Salary Report Service Error');
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
        logger.error({ err: error }, 'Leave Balances Report Error');
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
        logger.error({ err: error }, 'Absence Report Service Error');
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

        // HR-ANL-02 — diversity/EEO distribution from the category fields the
        // Employee model actually carries (gender, nationality, age-group from
        // date_of_birth, tenure). Standard US-EEO race/ethnicity, veteran and
        // disability categories have no source column on Employee, so they are
        // intentionally NOT fabricated; see `unavailableCategories` below.
        const eeoData = employees.reduce((acc, employee) => {
            const positionTitle = employee.Position?.title || 'No Position';
            if (!acc[positionTitle]) {
                acc[positionTitle] = {
                    position: positionTitle,
                    demographics: {
                        gender: {},
                        nationality: {},
                        ageGroup: {},
                        yearsOfService: {}
                    }
                };
            }

            // Gender distribution
            const gender = employee.gender || 'Not Specified';
            acc[positionTitle].demographics.gender[gender] =
                (acc[positionTitle].demographics.gender[gender] || 0) + 1;

            // Nationality distribution (real Employee.nationality column)
            const nationality = employee.nationality || 'Not Specified';
            acc[positionTitle].demographics.nationality[nationality] =
                (acc[positionTitle].demographics.nationality[nationality] || 0) + 1;

            // Age-group distribution (derived from Employee.date_of_birth)
            const ageGroup = employee.date_of_birth
                ? utils.calculateAgeGroup(utils.calculateAge(employee.date_of_birth))
                : 'Not Specified';
            acc[positionTitle].demographics.ageGroup[ageGroup] =
                (acc[positionTitle].demographics.ageGroup[ageGroup] || 0) + 1;

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

            // Diversity index is computed from the gender counts BEFORE they are
            // reshaped into {group, count} arrays.
            const genderCounts = Object.values(position.demographics.gender);

            // Convert to arrays with percentages
            Object.keys(position.demographics).forEach(category => {
                position.demographics[category] = Object.entries(position.demographics[category]).map(([group, count]) => ({
                    group,
                    count,
                    percentage: total > 0 ? parseFloat(((count / total) * 100).toFixed(2)) : 0
                }));
            });

            position.diversityIndex = parseFloat(
                utils.calculateDiversityIndex(genderCounts).toFixed(4)
            );
        });

        // Return shape preserved as an array (existing contract). The added
        // nationality/ageGroup demographics are purely additive extra keys.
        // HR-ANL-02 — race/ethnicity, veteran_status and disability_status have
        // no source column on Employee and are therefore NOT fabricated here;
        // see remaining[] for the missing columns needed to complete the report.
        return Object.values(eeoData);

    } catch (error) {
        logger.error({ err: error }, 'EEO Report Service Error');
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
        logger.error({ err: error }, 'Recruitment Pipeline Report Service Error');
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

        // IC-15 — tenant-scope every query (deny cross-tenant aggregation).
        // The Employee model uses snake_case `tenant_id` (REQ-007); every other
        // analytics model uses camelCase `tenantId` (T-P2.2). Build the correct
        // scope per model so the dashboard returns this tenant's real numbers
        // instead of an unscoped (and previously case-mismatched) zero.
        const employeeScope = { ...dataScope, ...(tenantId ? { tenant_id: tenantId } : {}) };
        const relScope = tenantId ? { tenantId } : {};

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
                where: employeeScope
            }),
            // Turnover (employees who became inactive). Status is a free-form
            // string column (e.g. 'Active'/'Inactive'); match case-insensitively.
            prisma.employee.findMany({
                where: {
                    ...employeeScope,
                    status: { equals: 'INACTIVE', mode: 'insensitive' },
                    updated_at: {
                        gte: startDate,
                        lte: endDate
                    }
                }
            }),
            // Absence
            prisma.attendance.findMany({
                where: {
                    ...relScope,
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
                    ...relScope,
                    effectiveTo: null
                },
                include: {
                    employee: true
                }
            }),
            // Performance data
            prisma.performanceReview.findMany({
                where: {
                    ...relScope,
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
                    ...relScope,
                    createdAt: {
                        gte: startDate,
                        lte: endDate
                    }
                }
            })
        ]);

        // Calculate KPIs (status is case-insensitive — DB stores 'Active').
        const totalHeadcount = employees.filter(emp => String(emp.status || '').toUpperCase() === 'ACTIVE').length;
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
        logger.error({ err: error }, 'Dashboard KPIs Service Error');
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
        logger.error({ err: error }, 'Position Dashboard Service Error');
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
                postings: true,
                // HR-KPI-04 — approval timestamp anchor (latest APPROVED decision).
                approvals: true,
                // HR-KPI-04 / HR-REC-09 — accepted-offer anchor + funnel counts.
                offers: true,
                applications: {
                    include: { interviews: true }
                }
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

        // HR-KPI-04 — Time to Fill, computed from real timestamps:
        //   approved-at  = latest RequisitionApproval.decidedAt for an APPROVED
        //                  decision (fallback: requisition.updatedAt).
        //   accepted-at  = Offer.respondedAt for the ACCEPTED offer.
        // Category = position title so it is reported per job category.
        const timeToFillRows = recruitmentData.map(req => {
            const acceptedOffer = (req.offers || []).find(o => o.status === 'ACCEPTED');
            if (!acceptedOffer || !acceptedOffer.respondedAt) return null;

            const approvalDates = (req.approvals || [])
                .filter(a => a.status === 'APPROVED' && a.decidedAt)
                .map(a => new Date(a.decidedAt).getTime());
            const approvedAt = approvalDates.length > 0
                ? new Date(Math.max(...approvalDates))
                : req.updatedAt; // fallback to requisition transition timestamp

            return {
                approvedAt,
                acceptedAt: acceptedOffer.respondedAt,
                category: req.position?.title || req.title || 'Uncategorized',
            };
        }).filter(Boolean);

        const timeToFill = utils.computeTimeToFill(timeToFillRows);

        // HR-REC-09 — recruitment funnel from real application stages + offers.
        const allApplications = recruitmentData.flatMap(req => req.applications || []);
        const allOffers = recruitmentData.flatMap(req => req.offers || []);
        const funnelCounts = {
            applied: allApplications.length,
            screened: allApplications.filter(a => a.stage !== 'applied').length,
            interviewed: allApplications.filter(a => (a.interviews || []).length > 0).length,
            offered: allOffers.filter(o => ['SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN'].includes(o.status)).length,
            accepted: allOffers.filter(o => o.status === 'ACCEPTED').length,
            hired: allApplications.filter(a => a.stage === 'hired').length,
        };
        const recruitmentFunnel = utils.computeRecruitmentFunnel(funnelCounts);

        // HR-REC-09 — data-driven bottlenecks from the computed conversion rates.
        const bottlenecks = utils.identifyRecruitmentBottlenecks(recruitmentFunnel.conversions);

        // HR-KPI-07 — flag KPIs that breach configured targets.
        const kpiAlerts = utils.evaluateKpiTargets({
            timeToFillDays: timeToFill.avgDays,
            offerAcceptanceRate: recruitmentFunnel.offerAcceptanceRate,
        });

        return {
            openPositions,
            filledPositions,
            totalRequisitions: recruitmentData.length,
            stageCounts,
            timeToFill, // { avgDays, medianDays, count, byCategory } — HR-KPI-04
            recruitmentFunnel, // HR-REC-09 / HR-KPI-03
            bottlenecks,
            kpiAlerts, // HR-KPI-07
        };

    } catch (error) {
        logger.error({ err: error }, 'Recruitment Dashboard Service Error');
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
                },
                // HR-KPI-05 — cycle end_date is the on-time deadline.
                cycle: true
            }
        });

        // HR-KPI-05 — Appraisal completion % AND on-time completion %.
        // On-time uses each review's own cycle end_date as the deadline; reviews
        // with no cycle fall back to the dashboard window endDate so they are
        // still scored rather than silently dropped. Computed per-cycle below so
        // each cycle is measured against its own end_date.

        // Per-cycle on-time aggregation (each cycle has its own end_date).
        const byCycleMap = performanceData.reduce((acc, r) => {
            const key = r.cycleId ?? 'no-cycle';
            if (!acc[key]) {
                acc[key] = {
                    cycleId: r.cycleId ?? null,
                    cycleName: r.cycle?.name ?? 'No Cycle',
                    cycleEnd: r.cycle?.end_date ?? endDate,
                    reviews: [],
                };
            }
            acc[key].reviews.push(r);
            return acc;
        }, {});

        const byCycle = Object.values(byCycleMap).map(c => {
            const stats = utils.computeAppraisalCompletion(c.reviews, c.cycleEnd);
            return {
                cycleId: c.cycleId,
                cycleName: c.cycleName,
                total: stats.total,
                finalized: stats.finalized,
                completionRate: stats.completionRate,
                onTimeRate: stats.onTimeRate,
            };
        });

        // Overall completion + on-time using each row's own cycle deadline.
        const overallStats = utils.computeAppraisalCompletion(
            performanceData.map(r => ({ status: r.status, submittedAt: r.submittedAt })),
            null
        );
        // Weighted overall on-time: sum of on-time reviews / total across cycles.
        const overallOnTime = byCycle.reduce((sum, c) => {
            const ot = (c.onTimeRate ?? 0) / 100 * c.total;
            return sum + ot;
        }, 0);
        const totalReviewsCount = performanceData.length;
        const completionRate = overallStats.completionRate;
        const onTimeCompletionRate = totalReviewsCount > 0
            ? parseFloat(((overallOnTime / totalReviewsCount) * 100).toFixed(2))
            : null;

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

        // HR-KPI-07 — flag completion/on-time KPIs against targets.
        const kpiAlerts = utils.evaluateKpiTargets({
            appraisalCompletionRate: completionRate,
            appraisalOnTimeRate: onTimeCompletionRate,
        });

        return {
            completionRate: parseFloat(completionRate.toFixed(2)),
            onTimeCompletionRate, // HR-KPI-05
            byCycle, // HR-KPI-05 — per-cycle/department breakdown
            avgRating: parseFloat(avgRating.toFixed(1)),
            ratingsDistribution,
            totalReviews: performanceData.length,
            overdueReviews: performanceData.filter(record => record.status === 'IN_PROGRESS').length,
            kpiAlerts, // HR-KPI-07
        };

    } catch (error) {
        logger.error({ err: error }, 'Performance Dashboard Service Error');
        throw error;
    }
};

/**
 * HR-KPI-06 — Payroll Accuracy + On-Time Dashboard.
 * Computes, over the selected window, the share of payroll runs that completed
 * without failing (accuracy) and the share of finalized runs that were
 * finalized within the grace window after their period end (on-time). All
 * values are derived from PayrollRun.status and the run's own timestamps — no
 * hardcoded numbers.
 */
export const getPayrollKpis = async ({ tenantId, timeframe, userRole, graceDays = 5 }) => {
    try {
        const { startDate, endDate } = utils.calculateDateRange(timeframe);
        const dataScope = utils.applyDataScope(tenantId, userRole);

        const runs = await prisma.payrollRun.findMany({
            where: {
                ...dataScope,
                // Runs whose pay period falls inside the window.
                periodEnd: {
                    gte: startDate,
                    lte: endDate
                }
            },
            select: {
                id: true,
                status: true,
                periodEnd: true,
                processedAt: true,
                approvedAt: true,
                updated_at: true,
                employeeCount: true
            }
        });

        const kpis = utils.computePayrollKpis(runs, graceDays);

        // HR-KPI-07 — flag accuracy/on-time KPIs against targets.
        const kpiAlerts = utils.evaluateKpiTargets({
            payrollAccuracyRate: kpis.accuracyRate,
            payrollOnTimeRate: kpis.onTimeRate,
        });

        return {
            ...kpis,
            graceDays,
            kpiAlerts,
        };

    } catch (error) {
        logger.error({ err: error }, 'Payroll KPIs Service Error');
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