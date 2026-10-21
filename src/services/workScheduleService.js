import prisma from '../lib/prisma.js';
import { createHash } from 'node:crypto';
import { tenantTransaction } from '../lib/rlsTenant.js';
import { assertSchedulePattern } from '../lib/schedulePattern.js';
import { bindRosterShifts, validateEmployeeShiftSequence, syncCurrentShiftSupervisors, previewShiftSupervisor } from './shiftGovernance.service.js';
import { civilNow } from '../lib/attendanceClock.js';
import {
  addDays,
  badSetup,
  covers,
  dateKey,
  dateOnly,
  dateRange,
  employedOn,
  overlaps,
} from '../lib/attendanceDates.js';

const include = {
  employee: { select: { employee_code: true } },
  overtimeRule: true,
};
const scope = (tenantId) => {
  if (!tenantId) throw badSetup('Tenant is required', 403);
  return tenantId;
};
const scheduleCovers = (r, d) =>
  covers(r, d, 'effective_start_date', 'effective_end_date');
const scheduleOverlaps = (a, b) =>
  overlaps(a, b, 'effective_start_date', 'effective_end_date');

// ROSTER-REEVAL-01 — a roster write re-queues attendance evaluation for the
// employee from the change's effective date. The horizon is the union of the
// previous and new coverage, capped at operating "today": future days are not
// evaluated yet and the daily planner owns them when they arrive. A horizon
// reaching further back than the 370-day evaluation range guard allows is
// bounded to its newest 369 days; older days keep the pre-change record.
export function reevaluationHorizon({ action, previous, row, today }) {
  if (action === 'delete') return null;
  const start = [previous?.effective_start_date, row.effective_start_date]
    .filter(Boolean)
    .map(dateKey)
    .sort()[0];
  const end = [previous?.effective_end_date, row.effective_end_date, today]
    .filter(Boolean)
    .map(dateKey)
    .sort()
    .at(-1);
  // A future-effective change touches no evaluated day; the planner enqueues
  // that employee/day pair as usual once the date arrives.
  if (start > end) return null;
  // Numeric comparator: Date's default sort is by toString() (day names),
  // which is not chronological and once leaked a 2020 start through the cap.
  const bounded = [dateOnly(start), addDays(end, -369)].sort((a, b) => a - b).at(-1);
  return { from: dateKey(bounded), to: end };
}

export const getWorkSchedules = ({ employeeId, tenantId }) =>
  prisma.workSchedule.findMany({
    where: {
      tenantId: scope(tenantId),
      ...(employeeId ? { employeeId: Number(employeeId) } : {}),
    },
    include,
    orderBy: [{ effective_start_date: 'desc' }, { id: 'desc' }],
  });

export async function assertRosterPeriodEditable(tx, tenantId, from, to) {
  const run = await tx.payrollRun.findFirst({
    where: {
      tenantId,
      periodEnd: { gte: dateOnly(from) },
      ...(to ? { periodStart: { lte: dateOnly(to) } } : {}),
      status: { notIn: ['CANCELLED', 'FAILED'] },
    },
    select: { id: true },
  });
  if (run)
    throw badSetup(
      'Recall or cancel the affected payroll run before changing its roster',
      409,
    );
}

function validated(data, previous = {}) {
  const end =
    data.effective_end_date === null
      ? null
      : (data.effective_end_date ?? previous.effective_end_date);
  const overtime =
    data.overtimeRuleId === null
      ? null
      : (data.overtimeRuleId ?? previous.overtimeRuleId);
  const row = {
    schedule_name: String(
      data.schedule_name ?? previous.schedule_name ?? '',
    ).trim(),
    effective_start_date: dateOnly(
      data.effective_start_date ?? previous.effective_start_date,
    ),
    effective_end_date: end ? dateOnly(end) : null,
    total_hours_per_week: Number(
      data.total_hours_per_week ?? previous.total_hours_per_week,
    ),
    schedule_pattern:
      data.schedule_pattern === undefined
        ? previous.schedule_pattern
        : data.schedule_pattern,
    overtimeRuleId: overtime ? Number(overtime) : null,
  };
  if (!row.schedule_name) throw badSetup('Schedule name is required');
  if (
    !Number.isFinite(row.total_hours_per_week) ||
    row.total_hours_per_week <= 0 ||
    row.total_hours_per_week > 168
  )
    throw badSetup('Weekly hours must be greater than zero and at most 168');
  if (
    row.effective_end_date &&
    row.effective_end_date < row.effective_start_date
  )
    throw badSetup('Schedule end must be on or after its start');
  assertSchedulePattern(row.schedule_pattern);
  return row;
}

// All roster writers share this lock and transaction. Validate the entire
// replacement before closing the old version; failed inserts roll back both.
export async function writeRoster({
  tenantId,
  employeeId,
  id,
  data,
  action = 'create',
  dryRun = false,
}) {
  scope(tenantId);
  return tenantTransaction(
    prisma,
    async (tx) => {
      const previous = id
        ? await tx.workSchedule.findFirst({
            where: { id: Number(id), tenantId },
          })
        : null;
      if (id && !previous) throw badSetup('Work schedule not found', 404);
      const eid = previous?.employeeId ?? Number(employeeId);
      if (!Number.isInteger(eid) || eid < 1)
        throw badSetup('Valid employee is required');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:roster:${eid}`}))`;
      const employee = await tx.employee.findFirst({
        where: { id: eid, tenant_id: tenantId },
        select: { id: true, businessUnitId: true, managerId: true, employee_code: true },
      });
      if (!employee) throw badSetup('Employee not found in tenant', 404);
      const rows = await tx.workSchedule.findMany({
        where: { tenantId, employeeId: eid },
        orderBy: { effective_start_date: 'asc' },
      });
      if (action === 'delete') {
        if (dateKey(previous.effective_start_date) <= dateKey(new Date()))
          throw badSetup(
            'Historical rosters must be retired or corrected, not deleted',
            409,
          );
        await assertRosterPeriodEditable(
          tx,
          tenantId,
          previous.effective_start_date,
          previous.effective_end_date,
        );
        return tx.workSchedule.delete({ where: { id: previous.id } });
      }
      const row = validated(data, previous || {});
      row.schedule_pattern = await bindRosterShifts(tx,tenantId,employee,row.schedule_pattern);
      assertSchedulePattern(row.schedule_pattern);
      if (
        row.overtimeRuleId &&
        !(await tx.overtimeRule.findFirst({
          where: { id: row.overtimeRuleId, tenantId, is_active: true },
        }))
      )
        throw badSetup('Active overtime rule not found in tenant', 404);
      const from = row.effective_start_date;
      const other = rows.filter((r) => r.id !== previous?.id);
      let close = null;
      if (action === 'create') {
        const hits = other.filter((r) => scheduleOverlaps(r, row));
        if (
          hits.length === 1 &&
          !hits[0].effective_end_date &&
          hits[0].effective_start_date < from &&
          !row.effective_end_date
        )
          close = hits[0];
        else if (hits.length)
          throw badSetup('Work schedule overlaps an existing version', 409);
      } else {
        if (other.some((r) => scheduleOverlaps(r, row)))
          throw badSetup('Work schedule overlaps an existing version', 409);
        if (
          dateKey(previous.effective_start_date) <= dateKey(new Date()) &&
          !data.correctionReason?.trim()
        )
          throw badSetup(
            'Provide a reason for a historical correction; otherwise create a change from a new date',
          );
        if (dateKey(previous.effective_start_date) !== dateKey(from))
          throw badSetup(
            'Keep the original start when correcting; create a new version to change dates',
          );
        row.schedule_pattern = {
          ...row.schedule_pattern,
          changeReason: data.correctionReason || data.reason || null,
          supersedes: previous.schedule_pattern,
          correctedAt: new Date().toISOString(),
        };
      }
      await assertRosterPeriodEditable(
        tx,
        tenantId,
        from,
        previous && (!previous.effective_end_date || !row.effective_end_date)
          ? null
          : previous?.effective_end_date > row.effective_end_date
            ? previous.effective_end_date
            : row.effective_end_date,
      );
      const assignments = await tx.shiftAssignment.findMany({where:{tenantId,employeeId:eid},orderBy:{id:'asc'}});
      const proposed = other.map(r=>close?.id===r.id ? {...r,effective_end_date:addDays(from,-1)}:r);
      validateEmployeeShiftSequence([...proposed,row],assignments);
      const windows = [row.schedule_pattern.shift, ...(row.schedule_pattern.rotatingShifts || []), ...Object.values(row.schedule_pattern.shiftByDay || {})].filter(Boolean);
      const impacts = await Promise.all(windows.map(window => previewShiftSupervisor(tx,tenantId,employee,window)));
      const reviewed = {...row,schedule_pattern:{...row.schedule_pattern,correctedAt:undefined}};
      const previewToken = createHash('sha256').update(JSON.stringify({rows,assignments,employee,impacts,reviewed})).digest('hex');
      if (data.previewToken && data.previewToken !== previewToken) throw badSetup('Roster or supervisor changed after preview. Review the new impact before saving.',409);
      const draft=await tx.attendanceSetupDraft.findUnique({where:{tenantId}});
      const today=dateKey(civilNow(new Date(),draft?.settings?.timeZone || 'Asia/Karachi'));
      const horizon=reevaluationHorizon({action,previous:action==='update'?previous:null,row,today});
      if (dryRun) {
        // Impact preview only — projection of the re-evaluation horizon; no
        // jobs are written until the reviewed save commits.
        const reevaluation = horizon
          ? { ...horizon, employeeId: eid,
              affectedDays: await tx.attendance.count({ where: { tenantId, employeeId: eid, date: { gte: dateOnly(horizon.from), lte: dateOnly(horizon.to) } } }) }
          : null;
        return {
          action,
          employeeId: eid,
          employeeCode: employee.employee_code,
          previewToken,
          impacts,
          closes: close?.id ?? null,
          proposed: row,
          reevaluation,
        };
      }
      if (close)
        await tx.workSchedule.update({
          where: { id: close.id },
          data: { effective_end_date: addDays(from, -1) },
        });
      const saved = previous
        ? await tx.workSchedule.update({
            where: { id: previous.id },
            data: row,
            include,
          })
        : await tx.workSchedule.create({
            data: { ...row, tenantId, employeeId: eid },
            include,
          });
      // ROSTER-REEVAL-01 — inside the same transaction as the roster write so
      // a queued job can never describe a change that did not commit, and the
      // change can never commit without its re-evaluation queue entries.
      let reevaluation = null;
      if (horizon) {
        const { enqueueEvaluationRange } = await import('./attendanceFinalization.service.js');
        await enqueueEvaluationRange({ tenantId, from: horizon.from, to: horizon.to, employeeIds: [eid] }, tx);
        await tx.attendanceEvaluationJob.updateMany({
          where: { tenantId, employeeId: eid, date: { gte: dateOnly(horizon.from), lte: dateOnly(horizon.to) } },
          data: { state: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null, completedAt: null },
        });
        reevaluation = { ...horizon, employeeId: eid };
      }
      await syncCurrentShiftSupervisors(tx,tenantId,today,{employeeIds:[eid]});
      return reevaluation ? { ...saved, reevaluation } : saved;
    },
    { tenantId, txOptions: { isolationLevel: 'Serializable' } },
  );
}

export const createWorkSchedule = (data) =>
  writeRoster({ tenantId: data.tenantId, employeeId: data.employeeId, data, dryRun: data.dryRun === true });
export const updateWorkSchedule = (id, data, updatedBy, tenantId) =>
  writeRoster({ tenantId, id, data, action: 'update', dryRun: data.dryRun === true });
export const deleteWorkSchedule = (id, deletedBy, tenantId) =>
  writeRoster({ tenantId, id, data: {}, action: 'delete' });

export async function getRosterCoverage({
  tenantId,
  date,
  from = date || dateKey(new Date()),
  to = from,
}) {
  scope(tenantId);
  const days = dateRange(from, to);
  const [employees, periods, schedules] = await Promise.all([
    prisma.employee.findMany({
      where: {
        tenant_id: tenantId,
        payroll_included: true,
        attendanceInputMode: { not: 'MANUAL_MONTHLY' },
      },
      select: {
        id: true,
        employee_code: true,
        employee_name: true,
        first_name: true,
        last_name: true,
        hire_date: true,
        joining_date: true,
        employement_status: true,
        status: true,
      },
    }),
    prisma.employmentPeriod.findMany({ where: { tenantId } }),
    prisma.workSchedule.findMany({
      where: {
        tenantId,
        effective_start_date: { lte: dateOnly(to) },
        OR: [
          { effective_end_date: null },
          { effective_end_date: { gte: dateOnly(from) } },
        ],
      },
    }),
  ]);
  const active = employees.filter((e) =>
    days.some((d) => employedOn(e, periods, d)),
  );
  const missing = [],
    conflicts = [];
  for (const e of active) {
    const roster = schedules.filter((s) => s.employeeId === e.id),
      absent = [],
      overlapping = [];
    for (const day of days) {
      if (!employedOn(e, periods, day)) continue;
      const hits = roster.filter((r) => scheduleCovers(r, day));
      if (!hits.length) absent.push(day);
      if (hits.length > 1) overlapping.push(day);
    }
    const identity = {
      id: e.id,
      code: e.employee_code,
      name:
        e.employee_name ||
        [e.first_name, e.last_name].filter(Boolean).join(' '),
      hireDate: e.hire_date,
    };
    if (absent.length) missing.push({ ...identity, dates: absent });
    if (overlapping.length) conflicts.push({ ...identity, dates: overlapping });
  }
  return {
    date: days[0],
    from: days[0],
    to: days.at(-1),
    activeEmployees: active.length,
    withScheduleInForce: active.length - missing.length,
    missingCount: missing.length,
    missing,
    conflicts,
  };
}
