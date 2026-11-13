import { legacyDecision, legacySubmit } from "./approval/legacy.js";
import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import { AppError } from '../utils/AppError.js';
import { scopedWhere, scopedData } from "../lib/tenancy.js";

// C.2 — verified tenant (T-P2.1) threaded in as `tenantId` on the args object /
// trailing param; folded into timesheet reads and stamped on creates,
// fail-closed so tenant B never reads/mutates tenant A's timesheets/approvals.

export const getTimesheets = async ({ employeeId, periodStart, periodEnd, status, tenantId }) => {
    // REQ-HR-004: `parseInt(undefined)` / `parseInt(null)` is NaN, and a NaN in
    // an Int filter makes Prisma reject the whole query with
    // "Argument `employeeId` is missing" — which reached the browser verbatim.
    // A caller with no resolvable employee (an operator account) asked for the
    // tenant's list, so scope by tenant only instead of building a broken
    // filter. Tenancy is still enforced by scopedWhere + RLS.
    const employeeFilter = Number.parseInt(employeeId, 10);
    const where = scopedWhere(
        tenantId,
        Number.isInteger(employeeFilter) ? { employeeId: employeeFilter } : {},
    );

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

export const getTimesheetById = async (id, employeeId, tenantId) => {
    const timesheet = await prisma.timesheet.findFirst({
        where: scopedWhere(tenantId, { id: parseInt(id) }),
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
    if (timesheet.employeeId !== employeeId) {
        throw new AppError('Not authorized to view this timesheet', 403);
    }

    return timesheet;
};

export const createTimesheet = async (data) => {
    const { employeeId, period_start, period_end, tenantId } = data;

    // Check for existing timesheet for the same period
    const existingTimesheet = await prisma.timesheet.findFirst({
        where: scopedWhere(tenantId, {
            employeeId: parseInt(employeeId),
            OR: [
                {
                    period_start: { lte: new Date(period_end) },
                    period_end: { gte: new Date(period_start) }
                }
            ]
        })
    });

    if (existingTimesheet) {
        throw new AppError('Timesheet already exists for this period', 400);
    }

    // Get time entries for the period
    const timeEntries = await prisma.timeEntry.findMany({
        where: scopedWhere(tenantId, {
            employeeId: parseInt(employeeId),
            work_date: {
                gte: new Date(period_start),
                lte: new Date(period_end)
            },
            timesheetId: null
        })
    });

    // Calculate total hours
    const totalHours = timeEntries.reduce((total, entry) => {
        return total + (entry.duration_minutes || 0) / 60;
    }, 0);

    const timesheet = await prisma.timesheet.create({
        data: scopedData(tenantId, {
            employeeId: parseInt(employeeId),
            period_start: new Date(period_start),
            period_end: new Date(period_end),
            total_hours: parseFloat(totalHours.toFixed(2)),
            status: 'DRAFT'
        }),
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
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

    return getTimesheetById(timesheet.id, parseInt(employeeId), tenantId);
};

export const submitTimesheet = async (id, employeeId, tenantId) => {
  return legacySubmit('TIMESHEET',id);
};

export const approveTimesheet = async (id, approverId, comments = '', tenantId) => {
  return legacyDecision('TIMESHEET',id);
};

export const rejectTimesheet = async (id, approverId, comments = '', tenantId) => {
  return legacyDecision('TIMESHEET',id);
};
