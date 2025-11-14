import { PrismaClient } from '@prisma/client';
import { logAction } from "../utils/logs.js";
import { AppError } from '../utils/AppError.js';

const prisma = new PrismaClient();

export const getWorkSchedules = async ({ employeeId }) => {
    return await prisma.workSchedule.findMany({
        where: { employeeId: parseInt(employeeId) },
        include: {
            employee: {
                select: {
                    first_name: true,
                    last_name: true
                }
            },
            overtimeRule: true
        },
        orderBy: { effective_start_date: 'desc' }
    });
};

export const createWorkSchedule = async (data) => {
    const { employeeId, effective_start_date, effective_end_date, overtimeRuleId } = data;

    // Check for overlapping schedules
    const overlappingSchedule = await prisma.workSchedule.findFirst({
        where: {
            employeeId: parseInt(employeeId),
            OR: [
                {
                    effective_start_date: { lte: new Date(effective_end_date || '2100-01-01') },
                    effective_end_date: { gte: new Date(effective_start_date) }
                },
                {
                    effective_start_date: { lte: new Date(effective_start_date) },
                    effective_end_date: null
                }
            ]
        }
    });

    if (overlappingSchedule) {
        throw new AppError('Work schedule overlaps with existing schedule', 400);
    }

    // Validate overtime rule if provided
    if (overtimeRuleId) {
        const overtimeRule = await prisma.overtimeRule.findUnique({
            where: { id: parseInt(overtimeRuleId) }
        });

        if (!overtimeRule) {
            throw new AppError('Overtime rule not found', 404);
        }
    }

    const create = await prisma.workSchedule.create({
        data: {
            employeeId: parseInt(employeeId),
            schedule_name: data.schedule_name,
            effective_start_date: new Date(effective_start_date),
            effective_end_date: effective_end_date ? new Date(effective_end_date) : null,
            total_hours_per_week: data.total_hours_per_week,
            schedule_pattern: data.schedule_pattern,
            overtimeRuleId: overtimeRuleId ? parseInt(overtimeRuleId) : null
        },
        include: {
            employee: {
                select: {
                    first_name: true,
                    last_name: true
                }
            },
            overtimeRule: true
        }
    });

        await logAction({
    employeeId: Number(employeeId),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Attanace - Work Schedule",
    result: "SUCCESS",
    notes: `Work Schedule "${create.id}" Created successfully`,
  });

    return create;
};

export const updateWorkSchedule = async (id, data,updatedBy) => {
    const schedule = await prisma.workSchedule.findUnique({
        where: { id: parseInt(id) }
    });

    if (!schedule) {
        throw new AppError('Work schedule not found', 404);
    }

    // Validate overtime rule if provided
    if (data.overtimeRuleId) {
        const overtimeRule = await prisma.overtimeRule.findUnique({
            where: { id: parseInt(data.overtimeRuleId) }
        });

        if (!overtimeRule) {
            throw new AppError('Overtime rule not found', 404);
        }
    }

    const update =  await prisma.workSchedule.update({
        where: { id: parseInt(id) },
        data: {
            ...data,
            effective_start_date: data.effective_start_date ? new Date(data.effective_start_date) : undefined,
            effective_end_date: data.effective_end_date ? new Date(data.effective_end_date) : undefined,
            overtimeRuleId: data.overtimeRuleId ? parseInt(data.overtimeRuleId) : undefined
        },
        include: {
            employee: {
                select: {
                    first_name: true,
                    last_name: true
                }
            },
            overtimeRule: true
        }
    });

    await logAction({
    employeeId: Number(createdBy),
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Attanace - Work Scheduler ",
    result: "SUCCESS",
    notes: `Work Schedule "${id}" Updated successfully`,
  });

    return update;
};

export const deleteWorkSchedule = async (id,deletedBy) => {
    const schedule = await prisma.workSchedule.findUnique({
        where: { id: parseInt(id) }
    });

    if (!schedule) {
        throw new AppError('Work schedule not found', 404);
    }

    const deleted = await prisma.workSchedule.delete({
        where: { id: parseInt(id) }
    });
  await logAction({
    employeeId: Number(createdBy), 
    type: "Deleted", // 👈 changed from CREATE to UPDATE
    module: "Attanace - Work Scheduler ",
    result: "SUCCESS",
    notes: `Work Schedule "${id}" Deleted successfully`,
  });

    return deleted;
};