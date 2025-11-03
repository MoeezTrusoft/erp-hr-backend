import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Payroll Run Operations
export const getPayrollRuns = async ({ page, limit, status }) => {
    const skip = (page - 1) * limit;
    const where = status ? { status } : {};

    const [payrollRuns, total] = await Promise.all([
        prisma.payrollRun.findMany({
            where,
            skip,
            take: parseInt(limit),
            orderBy: { periodStart: 'desc' },
            include: {
                payslips: {
                    include: {
                        employee: {
                            select: { id: true, first_name: true, last_name: true }
                        }
                    }
                }
            }
        }),
        prisma.payrollRun.count({ where })
    ]);

    return {
        payrollRuns,
        pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / limit)
        }
    };
};

export const getPayrollRunById = async (id) => {
    return prisma.payrollRun.findUnique({
        where: { id },
        include: {
            payslips: {
                include: {
                    employee: {
                        select: { id: true, first_name: true, last_name: true, job_title: true }
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
};

export const createPayrollRun = async (data) => {
    // Check for overlapping payroll runs
    const existingRun = await prisma.payrollRun.findFirst({
        where: {
            OR: [
                {
                    periodStart: { lte: data.periodEnd },
                    periodEnd: { gte: data.periodStart }
                }
            ]
        }
    });

    if (existingRun) {
        throw new Error('Payroll run already exists for the specified period');
    }

    return prisma.payrollRun.create({
        data: {
            ...data,
            status: 'PENDING'
        }
    });
};

export const processPayrollRun = async (id) => {
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
        throw new Error('Payroll run can only be processed from PENDING status');
    }

    // Update status to PROCESSING
    await prisma.payrollRun.update({
        where: { id },
        data: { status: 'PROCESSING' }
    });

    try {
        // Get all active employees
        const employees = await prisma.employee.findMany({
            where: { status: 'active' },
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
                        effectiveFrom: { lte: payrollRun.periodEnd },
                        OR: [
                            { effectiveTo: null },
                            { effectiveTo: { gte: payrollRun.periodStart } }
                        ],
                        isActive: true
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

        const payslipPromises = employees.map(async (employee) => {
            const { grossAmount, earnings, deductions, netAmount } =
                await calculateEmployeePay(employee, payrollRun);

            return prisma.payrollPayslip.create({
                data: {
                    payrollRunId: id,
                    employeeId: employee.id,
                    grossAmount,
                    totalDeductions: deductions.reduce((sum, d) => sum + d.amount, 0),
                    netAmount,
                    status: 'DRAFT',
                    earnings: {
                        create: earnings
                    },
                    deductions: {
                        create: deductions
                    }
                },
                include: {
                    earnings: true,
                    deductions: true
                }
            });
        });

        const payslips = await Promise.all(payslipPromises);

        // Calculate totals
        const totalGross = payslips.reduce((sum, payslip) => sum + payslip.grossAmount, 0);
        const totalDeductions = payslips.reduce((sum, payslip) => sum + payslip.totalDeductions, 0);
        const totalNet = payslips.reduce((sum, payslip) => sum + payslip.netAmount, 0);

        // Update payroll run with totals
        const updatedRun = await prisma.payrollRun.update({
            where: { id },
            data: {
                status: 'COMPLETED',
                totalGross,
                totalDeductions,
                totalNet,
                employeeCount: payslips.length,
                processedAt: new Date()
            },
            include: {
                payslips: {
                    include: {
                        employee: {
                            select: { first_name: true, last_name: true }
                        }
                    }
                }
            }
        });

        // Create audit log
        await prisma.payrollAuditLog.create({
            data: {
                action: 'PAYROLL_PROCESSED',
                details: `Payroll run processed for period ${payrollRun.periodStart.toISOString().split('T')[0]} to ${payrollRun.periodEnd.toISOString().split('T')[0]}`,
                payrollRunId: id,
                oldValues: JSON.stringify(payrollRun),
                newValues: JSON.stringify(updatedRun)
            }
        });

        return updatedRun;
    } catch (error) {
        // Mark as failed if processing fails
        await prisma.payrollRun.update({
            where: { id },
            data: { status: 'FAILED' }
        });
        throw error;
    }
};

const calculateEmployeePay = async (employee, payrollRun) => {
    const earnings = [];
    const deductions = [];
    let grossAmount = 0;

    // Calculate base salary
    if (employee.employmentTerms.length > 0) {
        const employmentTerm = employee.employmentTerms[0];
        const baseSalary = calculatePeriodSalary(employmentTerm, payrollRun);

        earnings.push({
            earningTypeId: await getBaseSalaryEarningTypeId(),
            amount: baseSalary,
            description: `Base salary for ${payrollRun.periodStart.toISOString().split('T')[0]} to ${payrollRun.periodEnd.toISOString().split('T')[0]}`
        });
        grossAmount += baseSalary;
    }

    // Process additional earnings and deductions
    for (const assignment of employee.payrollAssignments) {
        if (assignment.earningType) {
            const amount = assignment.amount || (grossAmount * (assignment.rate || 0));
            earnings.push({
                earningTypeId: assignment.earningType.id,
                amount,
                description: assignment.earningType.name
            });
            grossAmount += amount;
        } else if (assignment.deductionType) {
            const amount = assignment.amount || (grossAmount * (assignment.rate || 0));
            deductions.push({
                deductionTypeId: assignment.deductionType.id,
                amount,
                description: assignment.deductionType.name
            });
        }
    }

    // Calculate taxes
    const taxDeductions = await calculateTaxes(grossAmount, employee);
    deductions.push(...taxDeductions);

    const totalDeductions = deductions.reduce((sum, d) => sum + d.amount, 0);
    const netAmount = grossAmount - totalDeductions;

    return { grossAmount, earnings, deductions, netAmount };
};

const calculatePeriodSalary = (employmentTerm, payrollRun) => {
    const { baseSalary, payFrequency } = employmentTerm;

    switch (payFrequency) {
        case 'MONTHLY':
            return baseSalary;
        case 'SEMI_MONTHLY':
            return baseSalary / 2;
        case 'BI_WEEKLY':
            return baseSalary * 12 / 52; // Approximate bi-weekly calculation
        case 'WEEKLY':
            return baseSalary * 12 / 52;
        default:
            return baseSalary;
    }
};

const getBaseSalaryEarningTypeId = async () => {
    let earningType = await prisma.payrollEarningType.findFirst({
        where: { code: 'BASE_SALARY' }
    });

    if (!earningType) {
        earningType = await prisma.payrollEarningType.create({
            data: {
                code: 'BASE_SALARY',
                name: 'Base Salary',
                type: 'EARNING',
                isTaxable: true
            }
        });
    }

    return earningType.id;
};

const calculateTaxes = async (grossAmount, employee) => {
    // Simplified tax calculation - in real implementation, use tax tables
    const taxes = [];

    // Federal tax (simplified)
    const federalTax = grossAmount * 0.15; // 15% for demonstration
    taxes.push({
        deductionTypeId: await getOrCreateDeductionType('FED_TAX', 'Federal Income Tax'),
        amount: federalTax,
        description: 'Federal Income Tax'
    });

    // State tax (simplified)
    const stateTax = grossAmount * 0.05; // 5% for demonstration
    taxes.push({
        deductionTypeId: await getOrCreateDeductionType('STATE_TAX', 'State Income Tax'),
        amount: stateTax,
        description: 'State Income Tax'
    });

    return taxes;
};

const getOrCreateDeductionType = async (code, name) => {
    let deductionType = await prisma.payrollDeductionType.findFirst({
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

    return deductionType.id;
};

export const finalizePayrollRun = async (id) => {
    const payrollRun = await prisma.payrollRun.findUnique({
        where: { id }
    });

    if (!payrollRun) {
        throw new Error('Payroll run not found');
    }

    if (payrollRun.status !== 'COMPLETED') {
        throw new Error('Only completed payroll runs can be finalized');
    }

    // Update all payslips to FINALIZED
    await prisma.payrollPayslip.updateMany({
        where: { payrollRunId: id },
        data: { status: 'FINALIZED' }
    });

    // Create audit log
    await prisma.payrollAuditLog.create({
        data: {
            action: 'PAYROLL_FINALIZED',
            details: 'Payroll run finalized and ready for distribution',
            payrollRunId: id
        }
    });

    return getPayrollRunById(id);
};

export const cancelPayrollRun = async (id) => {
    const payrollRun = await prisma.payrollRun.findUnique({
        where: { id }
    });

    if (!payrollRun) {
        throw new Error('Payroll run not found');
    }

    if (payrollRun.status === 'COMPLETED') {
        throw new Error('Cannot cancel a completed payroll run');
    }

    // Delete associated payslips and their earnings/deductions
    await prisma.payrollPayslip.deleteMany({
        where: { payrollRunId: id }
    });

    await prisma.payrollRun.delete({
        where: { id }
    });

    // Create audit log
    await prisma.payrollAuditLog.create({
        data: {
            action: 'PAYROLL_CANCELLED',
            details: 'Payroll run cancelled',
            payrollRunId: id
        }
    });
};

// Earning Type Operations
export const getEarningTypes = async () => {
    return prisma.payrollEarningType.findMany({
        orderBy: { name: 'asc' }
    });
};

export const createEarningType = async (data) => {
    return prisma.payrollEarningType.create({
        data
    });
};

export const updateEarningType = async (id, data) => {
    return prisma.payrollEarningType.update({
        where: { id },
        data
    });
};

// Deduction Type Operations
export const getDeductionTypes = async () => {
    return prisma.payrollDeductionType.findMany({
        orderBy: { name: 'asc' }
    });
};

export const createDeductionType = async (data) => {
    return prisma.payrollDeductionType.create({
        data
    });
};

export const updateDeductionType = async (id, data) => {
    return prisma.payrollDeductionType.update({
        where: { id },
        data
    });
};

// Employee Payroll Data Operations
export const getEmployeePayrollData = async (employeeId) => {
    const [employmentTerms, assignments, bankDetails, payslips] = await Promise.all([
        prisma.employmentTerms.findMany({
            where: { employeeId },
            orderBy: { effectiveFrom: 'desc' }
        }),
        prisma.payrollAssignment.findMany({
            where: { employeeId, isActive: true },
            include: {
                earningType: true,
                deductionType: true
            }
        }),
        prisma.bankDetail.findMany({
            where: { employeeId }
        }),
        prisma.payrollPayslip.findMany({
            where: { employeeId },
            include: {
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
            },
            orderBy: { created_at: 'desc' },
            take: 6 // Last 6 payslips
        })
    ]);

    return {
        employmentTerms,
        assignments,
        bankDetails,
        recentPayslips: payslips
    };
};

export const createEmploymentTerms = async (data) => {
    return prisma.employmentTerms.create({
        data
    });
};

export const createPayrollAssignment = async (data) => {
    return prisma.payrollAssignment.create({
        data,
        include: {
            earningType: true,
            deductionType: true
        }
    });
};

// Payslip Operations
export const getPayslips = async ({ page, limit, payrollRunId, employeeId }) => {
    const skip = (page - 1) * limit;
    const where = {};

    if (payrollRunId) where.payrollRunId = parseInt(payrollRunId);
    if (employeeId) where.employeeId = parseInt(employeeId);

    const [payslips, total] = await Promise.all([
        prisma.payrollPayslip.findMany({
            where,
            skip,
            take: parseInt(limit),
            orderBy: { created_at: 'desc' },
            include: {
                employee: {
                    select: { id: true, first_name: true, last_name: true, job_title: true }
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
        }),
        prisma.payrollPayslip.count({ where })
    ]);

    return {
        payslips,
        pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / limit)
        }
    };
};

export const getPayslipById = async (id) => {
    return prisma.payrollPayslip.findUnique({
        where: { id },
        include: {
            employee: {
                select: {
                    id: true,
                    first_name: true,
                    last_name: true,
                    job_title: true
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
};

export const distributePayslip = async (id) => {
    const payslip = await prisma.payrollPayslip.findUnique({
        where: { id }
    });

    if (!payslip) {
        throw new Error('Payslip not found');
    }

    if (payslip.status !== 'FINALIZED') {
        throw new Error('Only finalized payslips can be distributed');
    }

    const updatedPayslip = await prisma.payrollPayslip.update({
        where: { id },
        data: {
            status: 'DISTRIBUTED',
            distributedAt: new Date()
        }
    });

    // Create audit log
    await prisma.payrollAuditLog.create({
        data: {
            action: 'PAYSLIP_DISTRIBUTED',
            details: 'Payslip distributed to employee',
            payslipId: id,
            employeeId: payslip.employeeId
        }
    });

    return updatedPayslip;
};

export const getEmployeePayslips = async (employeeId, { page, limit }) => {
    const skip = (page - 1) * limit;

    const [payslips, total] = await Promise.all([
        prisma.payrollPayslip.findMany({
            where: { employeeId },
            skip,
            take: parseInt(limit),
            orderBy: { created_at: 'desc' },
            include: {
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
        }),
        prisma.payrollPayslip.count({ where: { employeeId } })
    ]);

    return {
        payslips,
        pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / limit)
        }
    };
};

// Tax Rate Operations
export const getTaxRates = async (countryCode) => {
    const where = countryCode ? { countryCode } : {};
    return prisma.taxRate.findMany({
        where,
        orderBy: { bracketMin: 'asc' }
    });
};

export const createTaxRate = async (data) => {
    return prisma.taxRate.create({
        data
    });
};

// Audit Log Operations
export const getAuditLogs = async ({ page, limit, payrollRunId, payslipId }) => {
    const skip = (page - 1) * limit;
    const where = {};

    if (payrollRunId) where.payrollRunId = parseInt(payrollRunId);
    if (payslipId) where.payslipId = parseInt(payslipId);

    const [auditLogs, total] = await Promise.all([
        prisma.payrollAuditLog.findMany({
            where,
            skip,
            take: parseInt(limit),
            orderBy: { created_at: 'desc' },
            include: {
                payrollRun: {
                    select: { id: true, periodStart: true, periodEnd: true }
                },
                payslip: {
                    select: { id: true, employeeId: true }
                },
                employee: {
                    select: { id: true, first_name: true, last_name: true }
                }
            }
        }),
        prisma.payrollAuditLog.count({ where })
    ]);

    return {
        auditLogs,
        pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / limit)
        }
    };
};

export default {
    getPayrollRuns,
    getPayrollRunById,
    createPayrollRun,
    processPayrollRun,
    finalizePayrollRun,
    cancelPayrollRun,
    getEarningTypes,
    createEarningType,
    updateEarningType,
    getDeductionTypes,
    createDeductionType,
    updateDeductionType,
    getEmployeePayrollData,
    createEmploymentTerms,
    createPayrollAssignment,
    getPayslips,
    getPayslipById,
    distributePayslip,
    getEmployeePayslips,
    getTaxRates,
    createTaxRate,
    getAuditLogs
};