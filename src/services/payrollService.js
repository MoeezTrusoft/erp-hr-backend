import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();


export const createPayrollRunService = async (data, user) => {
    const { periodStart, periodEnd, countryCode, currencyCode } = data;

    // Check for duplicate payroll run
    const existingRun = await prisma.payrollRun.findFirst({
        where: {
            periodStart: new Date(periodStart),
            periodEnd: new Date(periodEnd)
        }
    });

    if (existingRun) {
        throw new Error('Payroll run already exists for this period');
    }

    return await prisma.payrollRun.create({
        data: {
            periodStart: new Date(periodStart),
            periodEnd: new Date(periodEnd),
            countryCode,
            currencyCode
        }
    });
};

export const getPayrollRunsService = async ({ page, limit, status, period }) => {
    const skip = (page - 1) * limit;
    const where = {};

    if (status) where.status = status;
    if (period) {
        where.periodStart = { lte: new Date(period) };
        where.periodEnd = { gte: new Date(period) };
    }

    const [runs, total] = await Promise.all([
        prisma.payrollRun.findMany({
            where,
            include: {
                payslips: {
                    select: {
                        _count: true
                    }
                }
            },
            skip,
            take: limit,
            orderBy: { created_at: 'desc' }
        }),
        prisma.payrollRun.count({ where })
    ]);

    return {
        runs,
        pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
        }
    };
};

export const getPayrollRunService = async (id) => {
    const payrollRun = await prisma.payrollRun.findUnique({
        where: { id },
        include: {
            payslips: {
                include: {
                    employee: {
                        select: {
                            id: true,
                            first_name: true,
                            last_name: true,
                            job_title: true
                        }
                    },
                    earnings: {
                        include: {
                            earningType: true
                        }
                    },
                    deductions: {
                        include: {
                            deductionType: true
                        }
                    }
                }
            }
        }
    });

    if (!payrollRun) {
        throw new Error('Payroll run not found');
    }

    return payrollRun;
};

export const updatePayrollRunService = async (id, data, user) => {
    const payrollRun = await prisma.payrollRun.findUnique({
        where: { id }
    });

    if (!payrollRun) {
        throw new Error('Payroll run not found');
    }

    return await prisma.payrollRun.update({
        where: { id },
        data: {
            ...data,
            updated_at: new Date()
        }
    });
};

export const processPayrollRunService = async (id, user) => {
    const payrollRun = await prisma.payrollRun.findUnique({
        where: { id },
        include: {
            payslips: true
        }
    });

    if (!payrollRun) {
        throw new Error('Payroll run not found');
    }

    if (payrollRun.status !== 'PENDING') {
        throw new Error('Payroll run cannot be processed in current status');
    }

    // Update status to processing
    await prisma.payrollRun.update({
        where: { id },
        data: { status: 'PROCESSING' }
    });

    try {
        // Calculate payroll for all employees
        await calculatePayroll(payrollRun);

        // Update status to completed with totals
        const updatedRun = await prisma.payrollRun.update({
            where: { id },
            data: {
                status: 'COMPLETED',
                processedAt: new Date(),
                ...await calculatePayrollTotals(id)
            }
        });

        // Log the processing
        await createAuditLogService({
            action: 'RUN_PROCESSED',
            details: `Payroll run ${id} processed successfully`,
            payrollRunId: id
        });

        return updatedRun;
    } catch (error) {
        // Revert status on error
        await prisma.payrollRun.update({
            where: { id },
            data: { status: 'FAILED' }
        });
        throw error;
    }
};

export const finalizePayrollRunService = async (id, user) => {
    const payrollRun = await prisma.payrollRun.findUnique({
        where: { id }
    });

    if (!payrollRun) {
        throw new Error('Payroll run not found');
    }

    if (payrollRun.status !== 'COMPLETED') {
        throw new Error('Payroll run must be completed before finalizing');
    }

    // Update all payslips to FINALIZED
    await prisma.payrollPayslip.updateMany({
        where: { payrollRunId: id },
        data: { status: 'FINALIZED' }
    });

    await createAuditLogService({
        action: 'RUN_FINALIZED',
        details: `Payroll run ${id} finalized`,
        payrollRunId: id
    });

    return { success: true, message: 'Payroll run finalized successfully' };
};

// Payslip Services
export const getPayslipsService = async ({ page, limit, payrollRunId, employeeId, status }) => {
    const skip = (page - 1) * limit;
    const where = {};

    if (payrollRunId) where.payrollRunId = payrollRunId;
    if (employeeId) where.employeeId = employeeId;
    if (status) where.status = status;

    const [payslips, total] = await Promise.all([
        prisma.payrollPayslip.findMany({
            where,
            include: {
                employee: {
                    select: {
                        first_name: true,
                        last_name: true,
                        job_title: true
                    }
                },
                payrollRun: {
                    select: {
                        periodStart: true,
                        periodEnd: true,
                        currencyCode: true
                    }
                }
            },
            skip,
            take: limit,
            orderBy: { created_at: 'desc' }
        }),
        prisma.payrollPayslip.count({ where })
    ]);

    return {
        payslips,
        pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
        }
    };
};

export const getPayslipService = async (id) => {
    const payslip = await prisma.payrollPayslip.findUnique({
        where: { id },
        include: {
            employee: {
                select: {
                    id: true,
                    first_name: true,
                    last_name: true,
                    job_title: true,
                    hire_date: true
                }
            },
            payrollRun: true,
            earnings: {
                include: {
                    earningType: true
                }
            },
            deductions: {
                include: {
                    deductionType: true
                }
            }
        }
    });

    if (!payslip) {
        throw new Error('Payslip not found');
    }

    return payslip;
};

export const updatePayslipService = async (id, data, user) => {
    const payslip = await prisma.payrollPayslip.findUnique({
        where: { id }
    });

    if (!payslip) {
        throw new Error('Payslip not found');
    }

    return await prisma.payrollPayslip.update({
        where: { id },
        data: {
            ...data,
            updated_at: new Date()
        }
    });
};

export const distributePayslipService = async (id, user) => {
    const payslip = await prisma.payrollPayslip.findUnique({
        where: { id }
    });

    if (!payslip) {
        throw new Error('Payslip not found');
    }

    if (payslip.status !== 'FINALIZED') {
        throw new Error('Payslip must be finalized before distribution');
    }

    const updatedPayslip = await prisma.payrollPayslip.update({
        where: { id },
        data: {
            status: 'DISTRIBUTED',
            distributedAt: new Date()
        }
    });

    // Log distribution
    await createAuditLogService({
        action: 'PAYSLIP_DISTRIBUTED',
        details: `Payslip ${id} distributed to employee`,
        payslipId: id,
        employeeId: payslip.employeeId
    });

    return updatedPayslip;
};

export const getEmployeePayslipsService = async ({ employeeId, page, limit }) => {
    const skip = (page - 1) * limit;
    const where = { employeeId };

    const [payslips, total] = await Promise.all([
        prisma.payrollPayslip.findMany({
            where,
            include: {
                payrollRun: {
                    select: {
                        periodStart: true,
                        periodEnd: true,
                        currencyCode: true
                    }
                }
            },
            skip,
            take: limit,
            orderBy: { created_at: 'desc' }
        }),
        prisma.payrollPayslip.count({ where })
    ]);

    return {
        payslips,
        pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
        }
    };
};

// Configuration Services
export const getEarningTypesService = async () => {
    return await prisma.payrollEarningType.findMany({
        orderBy: { code: 'asc' }
    });
};

export const createEarningTypeService = async (data) => {
    return await prisma.payrollEarningType.create({
        data
    });
};

export const updateEarningTypeService = async (id, data) => {
    const earningType = await prisma.payrollEarningType.findUnique({
        where: { id }
    });

    if (!earningType) {
        throw new Error('Earning type not found');
    }

    return await prisma.payrollEarningType.update({
        where: { id },
        data: {
            ...data,
            updated_at: new Date()
        }
    });
};

export const getDeductionTypesService = async () => {
    return await prisma.payrollDeductionType.findMany({
        orderBy: { code: 'asc' }
    });
};

export const createDeductionTypeService = async (data) => {
    return await prisma.payrollDeductionType.create({
        data
    });
};

export const updateDeductionTypeService = async (id, data) => {
    const deductionType = await prisma.payrollDeductionType.findUnique({
        where: { id }
    });

    if (!deductionType) {
        throw new Error('Deduction type not found');
    }

    return await prisma.payrollDeductionType.update({
        where: { id },
        data: {
            ...data,
            updated_at: new Date()
        }
    });
};

// Tax Configuration Services
export const getTaxRatesService = async ({ countryCode, effectiveDate }) => {
    const where = {};
    if (countryCode) where.countryCode = countryCode;

    if (effectiveDate) {
        where.effectiveFrom = { lte: new Date(effectiveDate) };
        where.OR = [
            { effectiveTo: null },
            { effectiveTo: { gte: new Date(effectiveDate) } }
        ];
    }

    return await prisma.taxRate.findMany({
        where,
        orderBy: { bracketMin: 'asc' }
    });
};

// Report Services
export const getPayrollSummaryService = async ({ payrollRunId, periodStart, periodEnd }) => {
    let where = {};

    if (payrollRunId) {
        where.payrollRunId = payrollRunId;
    } else if (periodStart && periodEnd) {
        where.payrollRun = {
            periodStart: { gte: new Date(periodStart) },
            periodEnd: { lte: new Date(periodEnd) }
        };
    }

    const payslips = await prisma.payrollPayslip.findMany({
        where,
        include: {
            employee: {
                select: {
                    id: true,
                    first_name: true,
                    last_name: true
                }
            }
        }
    });

    const summary = {
        totalGross: 0,
        totalDeductions: 0,
        totalNet: 0,
        employeeCount: payslips.length,
        byEmployee: {}
    };

    payslips.forEach(payslip => {
        summary.totalGross += payslip.grossAmount;
        summary.totalDeductions += payslip.totalDeductions;
        summary.totalNet += payslip.netAmount;

        // Group by employee
        const employeeId = payslip.employee.id;
        if (!summary.byEmployee[employeeId]) {
            summary.byEmployee[employeeId] = {
                employeeName: `${payslip.employee.first_name} ${payslip.employee.last_name}`,
                gross: 0,
                deductions: 0,
                net: 0
            };
        }

        summary.byEmployee[employeeId].gross += payslip.grossAmount;
        summary.byEmployee[employeeId].deductions += payslip.totalDeductions;
        summary.byEmployee[employeeId].net += payslip.netAmount;
    });

    return summary;
};

export const getPayrollRegisterService = async (payrollRunId) => {
    return await prisma.payrollPayslip.findMany({
        where: {
            payrollRunId
        },
        include: {
            employee: {
                select: {
                    first_name: true,
                    last_name: true,
                    job_title: true
                }
            },
            earnings: {
                include: {
                    earningType: true
                }
            },
            deductions: {
                include: {
                    deductionType: true
                }
            }
        },
        orderBy: {
            employee: {
                first_name: 'asc'
            }
        }
    });
};

export const getTaxReportService = async ({ periodStart, periodEnd, countryCode }) => {
    const where = {
        payrollRun: {
            periodStart: { gte: new Date(periodStart) },
            periodEnd: { lte: new Date(periodEnd) }
        }
    };

    if (countryCode) {
        where.payrollRun.countryCode = countryCode;
    }

    const payslips = await prisma.payrollPayslip.findMany({
        where,
        include: {
            employee: {
                select: {
                    first_name: true,
                    last_name: true
                }
            },
            payrollRun: {
                select: {
                    periodStart: true,
                    periodEnd: true,
                    countryCode: true
                }
            },
            deductions: {
                include: {
                    deductionType: true
                }
            }
        }
    });

    const taxReport = {
        totalTax: 0,
        byDeductionType: {}
    };

    payslips.forEach(payslip => {
        payslip.deductions.forEach(deduction => {
            const deductionType = deduction.deductionType.name;

            if (!taxReport.byDeductionType[deductionType]) {
                taxReport.byDeductionType[deductionType] = {
                    total: 0,
                    employees: []
                };
            }

            taxReport.byDeductionType[deductionType].total += deduction.amount;
            taxReport.totalTax += deduction.amount;

            // Add employee tax detail
            taxReport.byDeductionType[deductionType].employees.push({
                employeeId: payslip.employeeId,
                employeeName: `${payslip.employee.first_name} ${payslip.employee.last_name}`,
                amount: deduction.amount
            });
        });
    });

    return taxReport;
};

// Audit Services
export const getAuditLogsService = async ({ page, limit, action, startDate, endDate }) => {
    const skip = (page - 1) * limit;
    const where = {};

    if (action) where.action = action;
    if (startDate && endDate) {
        where.created_at = {
            gte: new Date(startDate),
            lte: new Date(endDate)
        };
    }

    const [logs, total] = await Promise.all([
        prisma.payrollAuditLog.findMany({
            where,
            include: {
                employee: {
                    select: {
                        first_name: true,
                        last_name: true
                    }
                },
                payrollRun: {
                    select: {
                        periodStart: true,
                        periodEnd: true
                    }
                }
            },
            skip,
            take: limit,
            orderBy: { created_at: 'desc' }
        }),
        prisma.payrollAuditLog.count({ where })
    ]);

    return {
        logs,
        pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
        }
    };
};

// Helper Functions
export const calculatePayroll = async (payrollRun) => {
    // Get all active employees with their employment terms
    const employees = await prisma.employee.findMany({
        where: {
            status: 'ACTIVE'
        },
        include: {
            employmentTerms: {
                where: {
                    effectiveFrom: { lte: payrollRun.periodEnd },
                    OR: [
                        { effectiveTo: null },
                        { effectiveTo: { gte: payrollRun.periodStart } }
                    ]
                },
                orderBy: { effectiveFrom: 'desc' },
                take: 1
            },
            payrollAssignments: {
                where: {
                    isActive: true,
                    effectiveFrom: { lte: payrollRun.periodEnd },
                    OR: [
                        { effectiveTo: null },
                        { effectiveTo: { gte: payrollRun.periodStart } }
                    ]
                },
                include: {
                    earningType: true,
                    deductionType: true
                }
            },
            attendance: {
                where: {
                    date: {
                        gte: payrollRun.periodStart,
                        lte: payrollRun.periodEnd
                    }
                }
            }
        }
    });

    for (const employee of employees) {
        if (employee.employmentTerms.length > 0) {
            await calculateEmployeePay(employee, payrollRun);
        }
    }
};

export const calculateEmployeePay = async (employee, payrollRun) => {
    const employmentTerm = employee.employmentTerms[0];

    // Calculate base salary based on pay frequency
    const baseSalary = calculateBaseSalary(employmentTerm.baseSalary, employmentTerm.payFrequency);

    // Calculate additional earnings from assignments
    const additionalEarnings = await calculateAdditionalEarnings(employee, payrollRun);

    const grossAmount = baseSalary + additionalEarnings;

    // Calculate deductions
    const taxDeductions = await calculateTaxDeductions(employee, grossAmount, payrollRun);
    const otherDeductions = await calculateOtherDeductions(employee, grossAmount, payrollRun);

    const totalDeductions = taxDeductions + otherDeductions;
    const netAmount = grossAmount - totalDeductions;

    // Create payslip
    const payslip = await prisma.payrollPayslip.create({
        data: {
            payrollRunId: payrollRun.id,
            employeeId: employee.id,
            grossAmount,
            totalDeductions,
            netAmount,
            status: 'DRAFT'
        }
    });

    // Create earning entries
    await createEarningEntries(payslip, employee, baseSalary, additionalEarnings);

    // Create deduction entries
    await createDeductionEntries(payslip, employee, taxDeductions, otherDeductions);
};

export const calculateBaseSalary = (salary, payFrequency) => {
    switch (payFrequency) {
        case 'WEEKLY':
            return salary / 52;
        case 'BI_WEEKLY':
            return salary / 26;
        case 'SEMI_MONTHLY':
            return salary / 24;
        case 'MONTHLY':
            return salary / 12;
        default:
            return salary / 12; // Default to monthly
    }
};

export const calculateAdditionalEarnings = async (employee, payrollRun) => {
    let total = 0;

    const earningAssignments = employee.payrollAssignments.filter(
        assignment => assignment.earningType && assignment.isActive
    );

    for (const assignment of earningAssignments) {
        if (assignment.amount) {
            total += assignment.amount;
        } else if (assignment.rate) {
            // Calculate based on rate and base salary or hours
            total += await calculateRateBasedEarning(assignment, employee, payrollRun);
        }
    }

    return total;
};

export const calculateRateBasedEarning = async (assignment, employee, payrollRun) => {
    // This is a simplified calculation - implement based on your business rules
    const employmentTerm = employee.employmentTerms[0];
    const baseSalary = calculateBaseSalary(employmentTerm.baseSalary, employmentTerm.payFrequency);
    return baseSalary * (assignment.rate / 100);
};

export const calculateTaxDeductions = async (employee, grossAmount, payrollRun) => {
    // Get applicable tax rates
    const taxRates = await prisma.taxRate.findMany({
        where: {
            countryCode: payrollRun.countryCode,
            effectiveFrom: { lte: payrollRun.periodEnd },
            OR: [
                { effectiveTo: null },
                { effectiveTo: { gte: payrollRun.periodStart } }
            ]
        },
        orderBy: { bracketMin: 'asc' }
    });

    return calculateTaxAmount(grossAmount, taxRates);
};

export const calculateTaxAmount = (taxableIncome, taxRates) => {
    let taxAmount = 0;
    let remainingIncome = taxableIncome;

    for (const rate of taxRates) {
        if (remainingIncome <= 0) break;

        const bracketRange = rate.bracketMax ?
            Math.min(rate.bracketMax, remainingIncome) - rate.bracketMin :
            remainingIncome;

        if (bracketRange > 0 && remainingIncome > rate.bracketMin) {
            const taxableInBracket = Math.min(bracketRange, remainingIncome - rate.bracketMin);
            taxAmount += taxableInBracket * rate.rate;
            remainingIncome -= taxableInBracket;
        }
    }

    return taxAmount;
};

export const calculateOtherDeductions = async (employee, grossAmount, payrollRun) => {
    let total = 0;

    const deductionAssignments = employee.payrollAssignments.filter(
        assignment => assignment.deductionType && assignment.isActive
    );

    for (const assignment of deductionAssignments) {
        if (assignment.amount) {
            total += assignment.amount;
        } else if (assignment.rate) {
            total += grossAmount * (assignment.rate / 100);
        }
    }

    return total;
};

export const createEarningEntries = async (payslip, employee, baseSalary, additionalEarnings) => {
    // Create base salary earning
    const baseEarningType = await getOrCreateEarningType('BASE_SALARY', 'Base Salary');
    await prisma.payrollEarning.create({
        data: {
            payslipId: payslip.id,
            earningTypeId: baseEarningType.id,
            amount: baseSalary,
            description: 'Base salary'
        }
    });

    // Create additional earnings if any
    if (additionalEarnings > 0) {
        const additionalEarningType = await getOrCreateEarningType('ADDITIONAL', 'Additional Earnings');
        await prisma.payrollEarning.create({
            data: {
                payslipId: payslip.id,
                earningTypeId: additionalEarningType.id,
                amount: additionalEarnings,
                description: 'Additional earnings'
            }
        });
    }
};

export const createDeductionEntries = async (payslip, employee, taxDeductions, otherDeductions) => {
    // Create tax deductions
    if (taxDeductions > 0) {
        const taxDeductionType = await getOrCreateDeductionType('INCOME_TAX', 'Income Tax');
        await prisma.payrollDeduction.create({
            data: {
                payslipId: payslip.id,
                deductionTypeId: taxDeductionType.id,
                amount: taxDeductions,
                description: 'Income tax deduction'
            }
        });
    }

    // Create other deductions
    if (otherDeductions > 0) {
        const otherDeductionType = await getOrCreateDeductionType('OTHER', 'Other Deductions');
        await prisma.payrollDeduction.create({
            data: {
                payslipId: payslip.id,
                deductionTypeId: otherDeductionType.id,
                amount: otherDeductions,
                description: 'Other deductions'
            }
        });
    }
};

export const getOrCreateEarningType = async (code, name) => {
    let earningType = await prisma.payrollEarningType.findUnique({
        where: { code }
    });

    if (!earningType) {
        earningType = await prisma.payrollEarningType.create({
            data: {
                code,
                name,
                type: 'EARNING',
                isTaxable: true
            }
        });
    }

    return earningType;
};

export const getOrCreateDeductionType = async (code, name) => {
    let deductionType = await prisma.payrollDeductionType.findUnique({
        where: { code }
    });

    if (!deductionType) {
        deductionType = await prisma.payrollDeductionType.create({
            data: {
                code,
                name,
                type: 'DEDUCTION'
            }
        });
    }

    return deductionType;
};

export const calculatePayrollTotals = async (payrollRunId) => {
    const result = await prisma.payrollPayslip.aggregate({
        where: { payrollRunId },
        _sum: {
            grossAmount: true,
            totalDeductions: true,
            netAmount: true
        },
        _count: {
            id: true
        }
    });

    return {
        totalGross: result._sum.grossAmount || 0,
        totalDeductions: result._sum.totalDeductions || 0,
        totalNet: result._sum.netAmount || 0,
        employeeCount: result._count.id || 0
    };
};

export const createAuditLogService = async (logData) => {
    return await prisma.payrollAuditLog.create({
        data: logData
    });
};

