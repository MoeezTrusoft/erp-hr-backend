import { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/AppError.js';

const prisma = new PrismaClient();

export const getOvertimeRules = async () => {
    return await prisma.overtimeRule.findMany({
        orderBy: { name: 'asc' }
    });
};

export const createOvertimeRule = async (data) => {
    return await prisma.overtimeRule.create({
        data
    });
};

export const updateOvertimeRule = async (id, data) => {
    const rule = await prisma.overtimeRule.findUnique({
        where: { id: parseInt(id) }
    });

    if (!rule) {
        throw new AppError('Overtime rule not found', 404);
    }

    return await prisma.overtimeRule.update({
        where: { id: parseInt(id) },
        data
    });
};

export const deleteOvertimeRule = async (id) => {
    const rule = await prisma.overtimeRule.findUnique({
        where: { id: parseInt(id) }
    });

    if (!rule) {
        throw new AppError('Overtime rule not found', 404);
    }

    // Check if rule is being used by any work schedules
    const scheduleCount = await prisma.workSchedule.count({
        where: { overtimeRuleId: parseInt(id) }
    });

    if (scheduleCount > 0) {
        throw new AppError('Cannot delete overtime rule that is in use by work schedules', 400);
    }

    await prisma.overtimeRule.delete({
        where: { id: parseInt(id) }
    });
};

export const calculateOvertime = async ({ employeeId, periodStart, periodEnd }) => {
    const timeEntries = await prisma.timeEntry.findMany({
        where: {
            employeeId: parseInt(employeeId),
            work_date: {
                gte: new Date(periodStart),
                lte: new Date(periodEnd)
            },
            work_type: 'REGULAR'
        },
        orderBy: { work_date: 'asc' }
    });

    // Group entries by day
    const dailyHours = {};
    timeEntries.forEach(entry => {
        const date = entry.work_date.toISOString().split('T')[0];
        const hours = (entry.duration_minutes || 0) / 60;

        if (!dailyHours[date]) {
            dailyHours[date] = 0;
        }
        dailyHours[date] += hours;
    });

    // Get employee's work schedule and overtime rules
    const workSchedule = await prisma.workSchedule.findFirst({
        where: {
            employeeId: parseInt(employeeId),
            effective_start_date: { lte: new Date(periodEnd) },
            OR: [
                { effective_end_date: null },
                { effective_end_date: { gte: new Date(periodStart) } }
            ]
        },
        include: { overtimeRule: true },
        orderBy: { effective_start_date: 'desc' }
    });

    if (!workSchedule || !workSchedule.overtimeRule) {
        throw new AppError('No overtime rules configured for employee', 400);
    }

    const rule = workSchedule.overtimeRule;
    let totalRegularHours = 0;
    let totalOvertimeHours = 0;
    let dailyOvertime = [];
    let weeklyOvertime = 0;

    // Calculate daily overtime
    Object.entries(dailyHours).forEach(([date, hours]) => {
        const dailyOvertimeThreshold = rule.daily_hours_threshold || 8;
        const dailyOvertimeRate = rule.daily_overtime_rate || 1.5;

        let regular = Math.min(hours, dailyOvertimeThreshold);
        let overtime = Math.max(0, hours - dailyOvertimeThreshold);

        totalRegularHours += regular;
        totalOvertimeHours += overtime;

        dailyOvertime.push({
            date,
            total_hours: hours,
            regular_hours: regular,
            overtime_hours: overtime,
            overtime_rate: overtime > 0 ? dailyOvertimeRate : 1
        });
    });

    // Calculate weekly overtime
    const weeklyOvertimeThreshold = rule.weekly_hours_threshold || 40;
    const weeklyOvertimeRate = rule.weekly_overtime_rate || 1.5;

    const totalHours = totalRegularHours + totalOvertimeHours;
    if (totalHours > weeklyOvertimeThreshold) {
        weeklyOvertime = totalHours - weeklyOvertimeThreshold;
        // Adjust regular and overtime hours based on weekly calculation
        totalRegularHours = weeklyOvertimeThreshold;
        totalOvertimeHours = weeklyOvertime;
    }

    return {
        employeeId: parseInt(employeeId),
        period: { start: periodStart, end: periodEnd },
        overtime_rule: rule,
        summary: {
            total_hours: parseFloat(totalHours.toFixed(2)),
            regular_hours: parseFloat(totalRegularHours.toFixed(2)),
            overtime_hours: parseFloat(totalOvertimeHours.toFixed(2)),
            weekly_overtime: parseFloat(weeklyOvertime.toFixed(2))
        },
        daily_breakdown: dailyOvertime,
        compliance: {
            max_daily_hours: rule.max_hours_per_day,
            max_weekly_hours: rule.max_hours_per_week,
            daily_violations: dailyOvertime.filter(day =>
                rule.max_hours_per_day && day.total_hours > rule.max_hours_per_day
            ),
            weekly_violation: rule.max_hours_per_week && totalHours > rule.max_hours_per_week
        }
    };
};