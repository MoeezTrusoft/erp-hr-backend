import { PrismaClient } from '@prisma/client';
import { logAction } from "../utils/logs.js";
import { AppError } from '../utils/AppError.js';

const prisma = new PrismaClient();

export const getTimesheets = async ({ employeeId, periodStart, periodEnd, status }) => {
    const where = { employeeId: parseInt(employeeId) };

    if (periodStart && periodEnd) {
        where.OR = [
            {
                period_start: { lte: new Date(periodEnd) },
                period_end: { gte: new Date(periodStart) }
            }
        ];
    }

    if (status) {
        where.status = status;
    }

    return await prisma.timesheet.findMany({
        where,
        include: {
            employee: {
                select: {
                    id: true,
                    first_name: true,
                    last_name: true,
                    job_title: true
                }
            },
            timeEntries: {
                include: {
                    source: true
                }
            },
            approvals: {
                include: {
                    approver: {
                        select: {
                            first_name: true,
                            last_name: true
                        }
                    }
                }
            }
        },
        orderBy: { period_start: 'desc' }
    });
};

export const getTimesheetById = async (id, userId) => {
    const timesheet = await prisma.timesheet.findFirst({
        where: { id: parseInt(id) },
        include: {
            employee: {
                select: {
                    id: true,
                    first_name: true,
                    last_name: true,
                    job_title: true
                }
            },
            timeEntries: {
                include: {
                    source: true
                },
                orderBy: { start_time: 'asc' }
            },
            approvals: {
                include: {
                    approver: {
                        select: {
                            first_name: true,
                            last_name: true
                        }
                    }
                },
                orderBy: { decided_at: 'desc' }
            }
        }
    });

    if (!timesheet) {
        throw new AppError('Timesheet not found', 404);
    }

    // Check permission
    if (timesheet.employeeId !== userId) {
        throw new AppError('Not authorized to view this timesheet', 403);
    }

    return timesheet;
};

export const createTimesheet = async (data) => {
    const { employeeId, period_start, period_end } = data;

    // Check for existing timesheet for the same period
    const existingTimesheet = await prisma.timesheet.findFirst({
        where: {
            employeeId: parseInt(employeeId),
            OR: [
                {
                    period_start: { lte: new Date(period_end) },
                    period_end: { gte: new Date(period_start) }
                }
            ]
        }
    });

    if (existingTimesheet) {
        throw new AppError('Timesheet already exists for this period', 400);
    }

    // Get time entries for the period
    const timeEntries = await prisma.timeEntry.findMany({
        where: {
            employeeId: parseInt(employeeId),
            work_date: {
                gte: new Date(period_start),
                lte: new Date(period_end)
            },
            timesheetId: null
        }
    });

    // Calculate total hours
    const totalHours = timeEntries.reduce((total, entry) => {
        return total + (entry.duration_minutes || 0) / 60;
    }, 0);

    const timesheet = await prisma.timesheet.create({
        data: {
            employeeId: parseInt(employeeId),
            period_start: new Date(period_start),
            period_end: new Date(period_end),
            total_hours: parseFloat(totalHours.toFixed(2)),
            status: 'DRAFT'
        },
        include: {
            employee: {
                select: {
                    first_name: true,
                    last_name: true
                }
            }
        }
    });

    // Associate time entries with timesheet
    if (timeEntries.length > 0) {
        await prisma.timeEntry.updateMany({
            where: {
                id: { in: timeEntries.map(entry => entry.id) }
            },
            data: { timesheetId: timesheet.id }
        });
    }
    
      await logAction({
    employeeId: Number(employeeId),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Attanace - Time Sheet",
    result: "SUCCESS",
    notes: `Time Sheet "${timesheet.id}" Created successfully`,
  });

    return getTimesheetById(timesheet.id, parseInt(employeeId));
};

export const submitTimesheet = async (id, userId) => {
    const timesheet = await prisma.timesheet.findFirst({
        where: { id: parseInt(id) },
        include: { employee: true }
    });

    if (!timesheet) {
        throw new AppError('Timesheet not found', 404);
    }

    if (timesheet.employeeId !== userId) {
        throw new AppError('Not authorized to submit this timesheet', 403);
    }

    if (timesheet.status !== 'DRAFT') {
        throw new AppError('Timesheet can only be submitted from draft status', 400);
    }

    // Validate timesheet has entries
    const entryCount = await prisma.timeEntry.count({
        where: { timesheetId: parseInt(id) }
    });

    if (entryCount === 0) {
        throw new AppError('Cannot submit empty timesheet', 400);
    }

    const update = await prisma.timesheet.update({
        where: { id: parseInt(id) },
        data: {
            status: 'SUBMITTED',
            submitted_at: new Date()
        },
        include: {
            employee: {
                select: {
                    first_name: true,
                    last_name: true
                }
            },
            timeEntries: true
        }
    });

      await logAction({
    employeeId: Number(userId),
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Attanace - Time Sheet",
    result: "SUCCESS",
    notes: `Time Sheet "${id}" Submitted successfully`,
  });
    return update;
};

export const approveTimesheet = async (id, approverId, comments = '') => {
    const timesheet = await prisma.timesheet.findFirst({
        where: { id: parseInt(id) },
        include: { employee: true }
    });

    if (!timesheet) {
        throw new AppError('Timesheet not found', 404);
    }

    if (timesheet.status !== 'SUBMITTED') {
        throw new AppError('Timesheet must be in submitted status to approve', 400);
    }

    // Create approval record
    await prisma.timeApproval.create({
        data: {
            timesheetId: parseInt(id),
            approverId: parseInt(approverId),
            decision: 'APPROVED',
            comments
        }
    });

    const update =  await prisma.timesheet.update({
        where: { id: parseInt(id) },
        data: {
            status: 'APPROVED',
            approved_at: new Date()
        },
        include: {
            employee: {
                select: {
                    first_name: true,
                    last_name: true
                }
            },
            approvals: {
                include: {
                    approver: {
                        select: {
                            first_name: true,
                            last_name: true
                        }
                    }
                }
            }
        }
    });


      await logAction({
    employeeId: Number(approverId),
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Attanace - Time Sheet",
    result: "SUCCESS",
    notes: `Time Sheet "${id}" Approved successfully`,
  });
    return update;
};

export const rejectTimesheet = async (id, approverId, comments = '') => {
    const timesheet = await prisma.timesheet.findFirst({
        where: { id: parseInt(id) },
        include: { employee: true }
    });

    if (!timesheet) {
        throw new AppError('Timesheet not found', 404);
    }

    if (timesheet.status !== 'SUBMITTED') {
        throw new AppError('Timesheet must be in submitted status to reject', 400);
    }

    if (!comments) {
        throw new AppError('Comments are required when rejecting a timesheet', 400);
    }

    // Create approval record
    await prisma.timeApproval.create({
        data: {
            timesheetId: parseInt(id),
            approverId: parseInt(approverId),
            decision: 'REJECTED',
            comments
        }
    });

    const reject = await prisma.timesheet.update({
        where: { id: parseInt(id) },
        data: {
            status: 'REJECTED'
        },
        include: {
            employee: {
                select: {
                    first_name: true,
                    last_name: true
                }
            },
            approvals: {
                include: {
                    approver: {
                        select: {
                            first_name: true,
                            last_name: true
                        }
                    }
                }
            }
        }
    });


      await logAction({
    employeeId: Number(employeeId),
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Attanace - Time Sheet",
    result: "SUCCESS",
    notes: `Time Sheet "${id}" Rejected successfully`,
  });
    return reject;
};