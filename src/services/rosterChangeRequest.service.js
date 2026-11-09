// Roster changes by approval (ROSTER_CHANGE). HR files the change; the company's published ATTENDANCE route approves
// it; only the final approval writes the roster, and that write re-queues attendance evaluation from the effective date
// (writeRoster does both inside the approval's own transaction, so a change can never commit without its re-evaluation).
import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import { tenantTransaction } from '../lib/rlsTenant.js';
import { badSetup, dateKey } from '../lib/attendanceDates.js';
import { todayInZone } from '../lib/holidayDates.js';
import { legacySubmit } from './approval/legacy.js';
import { writeRoster } from './workScheduleService.js';
import { emitWorkScheduleChanged } from './hrConfigEvents.js';

const ACTIONS = ['CREATE', 'UPDATE', 'DELETE'];
const NOT_PREVIEW = ['dryRun', 'previewToken', 'tenantId', 'requestedById', 'employeeId', 'id'];

export async function requestRosterChange({ tenantId, requestedById, action, employeeId, scheduleId, data = {} }) {
  if (!tenantId) throw badSetup('Tenant is required', 403);
  if (!ACTIONS.includes(action)) throw badSetup('Unknown roster action');
  const actor = Number(requestedById);
  if (!Number.isInteger(actor) || actor < 1)
    throw badSetup('Sign in with an employee account to request a roster change', 403);
  const reason = String(data.changeReason ?? data.correctionReason ?? data.reason ?? '').trim();
  if (reason.length < 3) throw badSetup('Give a reason for the roster change (at least 3 characters)');
  const payload = Object.fromEntries(
    Object.entries(data).filter(([k]) => !NOT_PREVIEW.includes(k) && k !== 'changeReason' && k !== 'reason'),
  );

  const row = await tenantTransaction(
    prisma,
    async (tx) => {
      let eid = Number(employeeId);
      if (action !== 'CREATE') {
        const existing = await tx.workSchedule.findFirst({ where: { id: Number(scheduleId), tenantId } });
        if (!existing) throw badSetup('Work schedule not found', 404);
        eid = existing.employeeId;
        if (action === 'DELETE' && dateKey(existing.effective_start_date) <= dateKey(todayInZone()))
          throw badSetup('Historical rosters must be retired or corrected, not deleted', 409);
      }
      if (!Number.isInteger(eid) || eid < 1) throw badSetup('Valid employee is required');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:roster-change:${eid}`}))`;
      const pending = await tx.rosterChangeRequest.findFirst({
        where: { tenantId, employeeId: eid, status: 'PENDING' },
        select: { id: true },
      });
      if (pending) throw badSetup('This employee already has a roster change waiting for approval', 409);
      // Refuse an impossible change now (overlaps, bad pattern, locked payroll period) instead of at the last level.
      if (action !== 'DELETE')
        await writeRoster({
          tenantId, employeeId: eid, id: action === 'UPDATE' ? scheduleId : undefined,
          action: action.toLowerCase(), dryRun: true, tx,
          data: { ...payload, correctionReason: reason },
        });
      return tx.rosterChangeRequest.create({
        data: { id: randomUUID(), tenantId, employeeId: eid, action, scheduleId: action === 'CREATE' ? null : Number(scheduleId),
          payload, reason, requestedById: actor },
      });
    },
    { tenantId },
  );

  try {
    await legacySubmit('ROSTER_CHANGE', row.id, reason, { onBehalf: true });
  } catch (error) {
    await prisma.rosterChangeRequest.deleteMany({ where: { id: row.id, tenantId, status: 'PENDING' } });
    throw error;
  }
  return {
    pendingApproval: true,
    requestId: row.id,
    employeeId: row.employeeId,
    action,
    status: 'PENDING',
    message: 'Sent for approval. The roster changes when the approval route approves it.',
  };
}

/** Final approval: write the roster inside the approval transaction, then record the decision on the request. */
export async function finalizeRosterChange(tx, env, row, approved) {
  if (approved) {
    const saved = await writeRoster({
      tenantId: env.tenantId, employeeId: row.employeeId, id: row.scheduleId ?? undefined,
      action: row.action.toLowerCase(), tx,
      data: { ...row.payload, correctionReason: row.reason },
    });
    await tx.payrollAuditLog.create({
      data: {
        tenantId: env.tenantId,
        action: 'ROSTER_CHANGE_APPLIED',
        details: `Roster ${row.action.toLowerCase()} applied for employee #${row.employeeId}: ${row.reason}`,
        oldValues: null,
        newValues: { requestId: row.id, scheduleId: saved?.id ?? row.scheduleId, action: row.action, reevaluation: saved?.reevaluation ?? null },
      },
    });
    emitWorkScheduleChanged({
      tenantId: env.tenantId, actorId: env.ctx?.user?.userId, scheduleId: saved?.id ?? row.scheduleId,
      action: row.action === 'CREATE' ? 'created' : row.action === 'DELETE' ? 'deleted' : 'updated',
    })?.catch?.(() => {});
  }
  await tx.rosterChangeRequest.update({ where: { id: row.id }, data: { status: approved ? 'APPROVED' : 'REJECTED' } });
}

/** Roster changes still waiting for the route, with the employee and what is proposed. */
export async function listPendingRosterChanges({ tenantId, employeeId }) {
  const rows = await prisma.rosterChangeRequest.findMany({
    where: { tenantId, status: 'PENDING', ...(employeeId ? { employeeId: Number(employeeId) } : {}) },
    orderBy: { createdAt: 'asc' },
  });
  const people = await prisma.employee.findMany({
    where: { tenant_id: tenantId, id: { in: [...new Set(rows.flatMap((r) => [r.employeeId, r.requestedById]))] } },
    select: { id: true, employee_code: true, employee_name: true, first_name: true, last_name: true },
  });
  const code = new Map(people.map((p) => [p.id, p.employee_code]));
  const name = new Map(people.map((p) => [p.id, p.employee_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || null]));
  return rows.map((r) => ({
    id: r.id, employeeId: r.employeeId, employee: code.get(r.employeeId) ?? null, employeeName: name.get(r.employeeId) ?? null, action: r.action, scheduleId: r.scheduleId,
    effectiveFrom: r.payload?.effective_start_date ?? null, scheduleName: r.payload?.schedule_name ?? null,
    reason: r.reason, requestedBy: code.get(r.requestedById) ?? null, requestedByName: name.get(r.requestedById) ?? null, createdAt: r.createdAt,
  }));
}
