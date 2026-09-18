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

    // HR-ROSTER-01 auto-close — the previous OPEN schedule is closed the day
    // before the new one starts instead of hard-blocking with a 400. Effective
    // dating means closing the old row IS the historical record: the UI tells
    // HR this will happen (A2), the new pattern takes over from its start date,
    // and no window is left where the employee has NO roster in force (which
    // day-derivation would read as working-every-day). Overlaps with an already
    // CLOSED schedule (bad dates) still fail closed below.
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
        const newStart = new Date(effective_start_date);
        const prevOpen = overlappingSchedule.effective_end_date == null
            && overlappingSchedule.effective_start_date.getTime() <= newStart.getTime();
        if (prevOpen && !effective_end_date) {
            // Auto-close path: the previous roster runs up to the day BEFORE the
            // new one. Day-before is computed on UTC midnights — schedules are
            // day-granular (HR-ROSTER-01), never sub-day.
            const dayBefore = new Date(newStart.getTime() - 24 * 60 * 60 * 1000);
            await prisma.workSchedule.update({
                where: { id: overlappingSchedule.id },
                data: { effective_end_date: dayBefore },
            });
            await logAction({
                employeeId: Number(employeeId),
                type: "Update",
                module: "Attanace - Work Schedule",
                result: "SUCCESS",
                notes: `Auto-closed schedule "${overlappingSchedule.id}" on ${dayBefore.toISOString().slice(0, 10)} (superseded by a new roster from ${newStart.toISOString().slice(0, 10)})`,
                tenantId: typeof tenantId !== "undefined" ? tenantId : null,
            });
        } else {
            // A dated overlap that auto-close cannot express (e.g. a bounded
            // schedule overlapping a NEW bounded one) stays a hard error.
            throw new AppError('Work schedule overlaps with existing schedule', 400);
        }
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

// ROSTER-COVERAGE-01 — active employees with NO schedule in force as at a date.
//
// An employee with no schedule reads as working EVERY day (the safe direction
// for cutoff leniency, the dangerous direction for absence marking), so the
// gaps this reports are exactly the silent-absence risk. "Active" mirrors the
// employment-period truth (open period = active; closed period = terminated —
// never rely on employement_status alone; the sync script closes that loop).
// AS-AT semantics: a schedule effective from tomorrow does NOT cover today.
export const getRosterCoverage = async ({ tenantId, date }) => {
    const asOf = date ? new Date(`${date}T00:00:00.000Z`) : new Date();
    if (Number.isNaN(asOf.getTime())) {
        throw new AppError('Invalid date — use YYYY-MM-DD', 400);
    }

    // Employee rows are tenant-scoped by tenant_id; periods carry tenantId too.
    const employees = await prisma.employee.findMany({
        where: { tenant_id: tenantId },
        select: {
            id: true,
            employee_code: true,
            employee_name: true,
            first_name: true,
            last_name: true,
            employement_status: true,
            hire_date: true,
        },
        orderBy: { id: 'asc' },
    });

    const periods = await prisma.employmentPeriod.findMany({
        where: { tenantId, employeeId: { in: employees.map((e) => e.id) } },
        orderBy: [{ employeeId: 'asc' }, { startDate: 'asc' }],
        select: { employeeId: true, startDate: true, endDate: true },
    });
    const latestPeriod = new Map();
    for (const p of periods) latestPeriod.set(p.employeeId, p);

    // Schedules overlapping the AS-OF day (start ≤ day AND (open OR end ≥ day)).
    const inForce = await prisma.workSchedule.findMany({
        where: scopedWhere(tenantId, {
            effective_start_date: { lte: asOf },
            OR: [{ effective_end_date: null }, { effective_end_date: { gte: asOf } }],
        }),
        select: { employeeId: true, schedule_name: true, effective_start_date: true },
    });
    const covered = new Set(inForce.map((s) => s.employeeId));

    const active = [];
    const missing = [];
    for (const e of employees) {
        const period = latestPeriod.get(e.id);
        const isActive = period
            ? period.endDate == null || period.endDate.getTime() > asOf.getTime()
            : String(e.employement_status || 'Active').toLowerCase() === 'active';
        if (!isActive) continue;
        const name = e.employee_name || [e.first_name, e.last_name].filter(Boolean).join(' ') || `#${e.id}`;
        active.push({ id: e.id, name, code: e.employee_code });
        if (!covered.has(e.id)) {
            missing.push({
                id: e.id,
                name,
                code: e.employee_code,
                hireDate: e.hire_date ? e.hire_date.toISOString().slice(0, 10) : null,
            });
        }
    }

    return {
        date: asOf.toISOString().slice(0, 10),
        activeEmployees: active.length,
        withScheduleInForce: active.length - missing.length,
        missingCount: missing.length,
        missing,
    };
};