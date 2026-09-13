import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import { AppError } from '../utils/AppError.js';
import { scopedWhere, scopedData, scopedEmployeeWhere } from "../lib/tenancy.js";
import { assertSchedulePattern } from "../lib/schedulePattern.js";

// C.2 — verified tenant (T-P2.1) threaded in as `tenantId` on the args object /
// trailing param; folded into work-schedule reads and stamped on creates,
// fail-closed when present.

export const getWorkSchedules = async ({ employeeId, tenantId }) => {
    // T-FIX: parseInt(undefined) is NaN — a tenant-wide list call (no
    // employeeId filter) used to hand Prisma an invalid Int and crash instead
    // of listing. Filter only when a real id arrives.
    const parsedEmployeeId = parseInt(employeeId, 10);
    return await prisma.workSchedule.findMany({
        where: scopedWhere(tenantId, {
            ...(Number.isFinite(parsedEmployeeId) ? { employeeId: parsedEmployeeId } : {}),
        }),
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
    const { employeeId, effective_start_date, effective_end_date, overtimeRuleId, tenantId } = data;

    // Check for overlapping schedules
    // Check for overlapping schedules
    const overlappingSchedule = await prisma.workSchedule.findFirst({
        where: scopedWhere(tenantId, {
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
        })
    });

    if (overlappingSchedule) {
        throw new AppError('Work schedule overlaps with existing schedule', 400);
    }

    // Validate overtime rule if provided — tenant-scoped, so a rule from another
    // tenant cannot be attached (matches update).
    if (overtimeRuleId) {
        const overtimeRule = await prisma.overtimeRule.findFirst({
            where: scopedWhere(tenantId, { id: parseInt(overtimeRuleId) })
        });

        if (!overtimeRule) {
            throw new AppError('Overtime rule not found', 404);
        }
    }

    // HR-ROSTER-03 — validate the pattern at the write boundary. Every consumer
    // degrades quietly on nonsense (offDays [8] = never off, bad HH:MM = every
    // scan unrostered); a wrong roster written today is a wrong payslip on
    // payday. Collects ALL problems in one shot rather than the first.
    if (data.schedule_pattern !== undefined && data.schedule_pattern !== null) {
        assertSchedulePattern(data.schedule_pattern);
    }
    const targetEmployee = await prisma.employee.findFirst({
        where: scopedEmployeeWhere(tenantId, { id: parseInt(employeeId, 10) }),
        select: { id: true },
    });
    if (!targetEmployee) {
        throw new AppError('Employee not found in tenant', 404);
    }

    const create = await prisma.workSchedule.create({
        data: scopedData(tenantId, {
            employeeId: parseInt(employeeId),
            schedule_name: data.schedule_name,
            effective_start_date: new Date(effective_start_date),
            effective_end_date: effective_end_date ? new Date(effective_end_date) : null,
            total_hours_per_week: data.total_hours_per_week,
            schedule_pattern: data.schedule_pattern,
            overtimeRuleId: overtimeRuleId ? parseInt(overtimeRuleId) : null
        }),
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
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

    return create;
};

export const updateWorkSchedule = async (id, data, updatedBy, tenantId) => {
    // T-FIX (tenant fail-open): resolve the row WITH the verified tenant scope —
    // scopedWhere(undefined) applied no tenant filter, so a bare-id lookup could
    // hit another tenant's schedule. (Controllers now always thread tenantId;
    // the undefined branch stays for legacy migration callers.)
    const schedule = await prisma.workSchedule.findFirst({
        where: scopedWhere(tenantId, { id: parseInt(id) })
    });

    if (!schedule) {
        throw new AppError('Work schedule not found', 404);
    }

    // Validate overtime rule if provided — tenant-scoped, so a rule from another
    // tenant cannot be attached.
    if (data.overtimeRuleId) {
        const overtimeRule = await prisma.overtimeRule.findFirst({
            where: scopedWhere(tenantId, { id: parseInt(data.overtimeRuleId) })
        });

        if (!overtimeRule) {
            throw new AppError('Overtime rule not found', 404);
        }
    }

    // HR-ROSTER-03 — same write-boundary validation as create (see above).
    if (data.schedule_pattern !== undefined && data.schedule_pattern !== null) {
        assertSchedulePattern(data.schedule_pattern);
    }

    // T-FIX: field allowlist instead of `...data` spread — a caller-supplied
    // employeeId (cross-tenant move) or tenantId (scope escape) in the body
    // used to overwrite the protected columns verbatim.
    const update =  await prisma.workSchedule.update({
        where: { id: schedule.id },
        data: {
            schedule_name: data.schedule_name !== undefined ? data.schedule_name : undefined,
            effective_start_date: data.effective_start_date ? new Date(data.effective_start_date) : undefined,
            effective_end_date: data.effective_end_date ? new Date(data.effective_end_date) : undefined,
            total_hours_per_week: data.total_hours_per_week !== undefined ? data.total_hours_per_week : undefined,
            schedule_pattern: data.schedule_pattern !== undefined ? data.schedule_pattern : undefined,
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
    employeeId: Number(updatedBy),
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Attanace - Work Scheduler ",
    result: "SUCCESS",
    notes: `Work Schedule "${id}" Updated successfully`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

    return update;
};

export const deleteWorkSchedule = async (id,deletedBy,tenantId) => {
    const schedule = await prisma.workSchedule.findFirst({
        where: scopedWhere(tenantId, { id: parseInt(id) })
    });

    if (!schedule) {
        throw new AppError('Work schedule not found', 404);
    }

    const deleted = await prisma.workSchedule.delete({
        where: { id: parseInt(id) }
    });
  await logAction({
    employeeId: Number(deletedBy),
    type: "Deleted", // 👈 changed from CREATE to UPDATE
    module: "Attanace - Work Scheduler ",
    result: "SUCCESS",
    notes: `Work Schedule "${id}" Deleted successfully`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

    return deleted;
};