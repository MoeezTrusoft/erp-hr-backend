import prisma from "../lib/prisma.js";
import { AppError } from '../utils/AppError.js';


export const getTimeEntries = async ({ employeeId, startDate, endDate }) => {
    const where = { employeeId: parseInt(employeeId) };

    if (startDate && endDate) {
        where.work_date = {
            gte: new Date(startDate),
            lte: new Date(endDate)
        };
    }

    return await prisma.timeEntry.findMany({
        where,
        include: {
            employee: {
                select: {
                    id: true,
                    first_name: true,
                    last_name: true
                }
            },
            source: true,
            timesheet: true
        },
        orderBy: { start_time: 'desc' }
    });
};

export const createTimeEntry = async (data) => {
    const { employeeId, start_time, end_time, work_type, note, sourceId } = data;

    // Validate time range
    if (end_time && new Date(end_time) <= new Date(start_time)) {
        throw new AppError('End time must be after start time', 400);
    }

    const create =  await prisma.timeEntry.create({
        data: {
            employeeId: parseInt(employeeId),
            start_time: new Date(start_time),
            end_time: end_time ? new Date(end_time) : null,
            work_date: new Date(start_time),
            work_type,
            entry_type: 'MANUAL_ENTRY',
            note,
            sourceId: sourceId ? parseInt(sourceId) : null,
            duration_minutes: end_time
                ? Math.round((new Date(end_time) - new Date(start_time)) / (1000 * 60))
                : null
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

      await logAction({
    employeeId: Number(employeeId),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Attanace - Time Entry",
    result: "SUCCESS",
    notes: `Time Entry "${create.id}" Created successfully`,
  });
    return create;
};

export const updateTimeEntry = async (id, data, userId) => {
    const entry = await prisma.timeEntry.findFirst({
        where: { id: parseInt(id) },
        include: { employee: true }
    });

    if (!entry) {
        throw new AppError('Time entry not found', 404);
    }

    // Check permission
    if (entry.employeeId !== userId) {
        throw new AppError('Not authorized to update this time entry', 403);
    }

    const updateData = { ...data };

    // Recalculate duration if times are updated
    if (data.start_time || data.end_time) {
        const startTime = data.start_time ? new Date(data.start_time) : entry.start_time;
        const endTime = data.end_time ? new Date(data.end_time) : entry.end_time;

        if (endTime && startTime >= endTime) {
            throw new AppError('End time must be after start time', 400);
        }

        updateData.duration_minutes = endTime
            ? Math.round((endTime - startTime) / (1000 * 60))
            : null;
    }

    const update =  await prisma.timeEntry.update({
        where: { id: parseInt(id) },
        data: updateData,
        include: {
            employee: {
                select: {
                    first_name: true,
                    last_name: true
                }
            }
        }
    });

      await logAction({
    employeeId: Number(userId),
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Attanace - Time Entry",
    result: "SUCCESS",
    notes: `Time Entry "${id}" Updated successfully`,
  });
    return update;
};

export const deleteTimeEntry = async (id, userId) => {
    const entry = await prisma.timeEntry.findFirst({
        where: { id: parseInt(id) },
        include: { employee: true }
    });

    if (!entry) {
        throw new AppError('Time entry not found', 404);
    }

    if (entry.employeeId !== userId) {
        throw new AppError('Not authorized to delete this time entry', 403);
    }

    const deleted =  prisma.timeEntry.delete({
        where: { id: parseInt(id) }
    });
    
      await logAction({
    employeeId: Number(userId),
    type: "Deleted", // 👈 changed from CREATE to UPDATE
    module: "Attanace - Time Entry",
    result: "SUCCESS",
    notes: `Time Entry "${id}" Deleted successfully`,
  });

    return deleted
};

export const clockIn = async ({ employeeId, location, note, sourceId }) => {
    // Check if already clocked in
    const activeEntry = await prisma.timeEntry.findFirst({
        where: {
            employeeId: parseInt(employeeId),
            end_time: null,
            entry_type: 'CLOCK_IN'
        }
    });

    if (activeEntry) {
        throw new AppError('Already clocked in. Please clock out first.', 400);
    }

    const now = new Date();

    const create =  await prisma.timeEntry.create({
        data: {
            employeeId: parseInt(employeeId),
            start_time: now,
            work_date: now,
            entry_type: 'CLOCK_IN',
            work_type: 'REGULAR',
            note,
            sourceId: sourceId ? parseInt(sourceId) : null
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

    
      await logAction({
    employeeId: Number(employeeId),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Attanace - Time Entry",
    result: "SUCCESS",
    notes: `Clock In "${create.id}" Created successfully`,
  });
    return create;
};

export const clockOut = async ({ employeeId, location, note, sourceId }) => {
    // Find active clock-in entry
    const activeEntry = await prisma.timeEntry.findFirst({
        where: {
            employeeId: parseInt(employeeId),
            end_time: null,
            entry_type: 'CLOCK_IN'
        }
    });

    if (!activeEntry) {
        throw new AppError('No active clock-in found', 400);
    }

    const now = new Date();
    const durationMinutes = Math.round((now - activeEntry.start_time) / (1000 * 60));

    const clockOut = await prisma.timeEntry.update({
        where: { id: activeEntry.id },
        data: {
            end_time: now,
            duration_minutes: durationMinutes,
            note: note || activeEntry.note
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

      await logAction({
    employeeId: Number(employeeId),
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Attanace - Time Entry",
    result: "SUCCESS",
    notes: `Clock Out "${activeEntry.id}" Updated successfully`,
  });

    return clockOut;
};

export const startBreak = async ({ employeeId, note, sourceId }) => {
    const now = new Date();

    const breakStart = await prisma.timeEntry.create({
        data: {
            employeeId: parseInt(employeeId),
            start_time: now,
            work_date: now,
            entry_type: 'BREAK_START',
            work_type: 'REGULAR',
            note,
            sourceId: sourceId ? parseInt(sourceId) : null
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


      await logAction({
    employeeId: Number(employeeId),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Attanace - Time Entry",
    result: "SUCCESS",
    notes: `Break Started "${breakStart.id}" Created successfully`,
  });
    return breakStart;
};

export const endBreak = async ({ employeeId, note, sourceId }) => {
    const activeBreak = await prisma.timeEntry.findFirst({
        where: {
            employeeId: parseInt(employeeId),
            end_time: null,
            entry_type: 'BREAK_START'
        }
    });

    if (!activeBreak) {
        throw new AppError('No active break found', 400);
    }

    const now = new Date();
    const durationMinutes = Math.round((now - activeBreak.start_time) / (1000 * 60));

    const endBreak = await prisma.timeEntry.update({
        where: { id: activeBreak.id },
        data: {
            end_time: now,
            duration_minutes: durationMinutes,
            note: note || activeBreak.note
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

      await logAction({
    employeeId: Number(employeeId),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Attanace - Time Entry",
    result: "SUCCESS",
    notes: `End Break "${activeBreak.id}" Created successfully`,
  });
    return endBreak;
};

export const getCurrentStatus = async (employeeId) => {
    const activeEntry = await prisma.timeEntry.findFirst({
        where: {
            employeeId: parseInt(employeeId),
            end_time: null
        },
        orderBy: { start_time: 'desc' },
        include: {
            employee: {
                select: {
                    first_name: true,
                    last_name: true
                }
            }
        }
    });

    const todayEntries = await prisma.timeEntry.findMany({
        where: {
            employeeId: parseInt(employeeId),
            work_date: {
                gte: new Date().setHours(0, 0, 0, 0),
                lte: new Date().setHours(23, 59, 59, 999)
            }
        },
        orderBy: { start_time: 'asc' }
    });

    const totalMinutes = todayEntries.reduce((total, entry) => {
        return total + (entry.duration_minutes || 0);
    }, 0);

    return {
        currentStatus: activeEntry ? activeEntry.entry_type : 'CLOCKED_OUT',
        activeEntry,
        todayEntries,
        totalHoursToday: (totalMinutes / 60).toFixed(2)
    };
};