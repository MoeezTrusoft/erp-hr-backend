// Manual attendance punches by approval (CAPTURE_CHANGE, action MANUAL_PUNCH). HR files a punch for an employee with
// a reason; the company's published ATTENDANCE route approves it; only the final approval records it, as ordinary
// capture evidence (source MANUAL) that the normal capture pipeline then evaluates. Future times are refused.
import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import { tenantTransaction } from '../lib/rlsTenant.js';
import { badSetup, dateOnly } from '../lib/attendanceDates.js';
import { parseCaptureTimestamp, wallAt } from '../lib/attendanceCapture.js';
import { legacySubmit } from './approval/legacy.js';

const FUTURE_GRACE_MS = 2 * 60 * 1000; // a clock a couple of minutes ahead is not a future punch
const DIRECTIONS = { IN: 0, OUT: 1 };

async function companyZone(tx, tenantId) {
  const release = await tx.attendanceSetupRelease.findFirst({ where: { tenantId }, orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }] });
  const zone = release?.config?.settings?.timeZone;
  if (!zone) throw badSetup('Publish the attendance configuration before adding manual punches', 409);
  return zone;
}

async function assertNoPayrollRun(tx, tenantId, day) {
  const run = await tx.payrollRun.findFirst({
    where: { tenantId, periodStart: { lte: dateOnly(day) }, periodEnd: { gte: dateOnly(day) }, status: { notIn: ['CANCELLED', 'FAILED'] } },
    select: { id: true },
  });
  if (run) throw badSetup('Recall or cancel the payroll run that covers this day before adding a punch to it', 409);
}

/** The punch as the company's wall clock reads it, validated and not in the future. */
function readPunch(timestamp, zone, now = new Date()) {
  let parsed;
  try {
    parsed = parseCaptureTimestamp(String(timestamp ?? '').trim().replace(/Z$/, ''), zone);
  } catch {
    throw badSetup('Enter the time as YYYY-MM-DD HH:mm:ss in company time');
  }
  if (+parsed.occurredAt - +now > FUTURE_GRACE_MS) throw badSetup('A punch cannot be in the future');
  return parsed;
}

export async function requestManualPunch({ tenantId, requestedById, employeeId, direction, timestamp, reason }) {
  if (!tenantId) throw badSetup('Tenant is required', 403);
  const actor = Number(requestedById);
  if (!Number.isInteger(actor) || actor < 1) throw badSetup('Sign in with an employee account to add a manual punch', 403);
  if (!Object.hasOwn(DIRECTIONS, direction)) throw badSetup('Choose check-in or check-out');
  const why = String(reason ?? '').trim();
  if (why.length < 3) throw badSetup('Give a reason for the manual punch (at least 3 characters)');
  const target = Number(employeeId);
  if (!Number.isInteger(target) || target < 1) throw badSetup('Choose an employee');

  const row = await tenantTransaction(
    prisma,
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:capture-change`}))`;
      const person = await tx.employee.findFirst({ where: { id: target, tenant_id: tenantId }, select: { id: true, employee_name: true, employee_code: true } });
      if (!person) throw badSetup('Employee not found', 404);
      const zone = await companyZone(tx, tenantId);
      // No time given means now, in company time.
      const punch = readPunch(timestamp ?? wallAt(new Date(), zone), zone);
      await assertNoPayrollRun(tx, tenantId, punch.localTime.slice(0, 10));
      const localTime = punch.localTime.slice(0, 19).replace('T', ' ');
      const pending = await tx.captureChangeRequest.findMany({ where: { tenantId, status: 'PENDING' }, select: { payload: true } });
      if (pending.some((p) => p.payload?.employeeId === target && p.payload?.localTime === localTime && p.payload?.direction === direction))
        throw badSetup('This punch already has a request waiting for approval', 409);
      const who = person.employee_name ?? person.employee_code;
      return tx.captureChangeRequest.create({
        data: {
          id: randomUUID(), tenantId, action: 'MANUAL_PUNCH', reason: why, requestedById: actor,
          payload: { employeeId: target, employeeName: who, direction, localTime, timeZone: zone, changes: [`Add a ${direction === 'IN' ? 'check-in' : 'check-out'} for ${who} at ${localTime} (${zone})`] },
        },
      });
    },
    { tenantId },
  );
  try {
    await legacySubmit('CAPTURE_CHANGE', row.id, why, { onBehalf: true });
  } catch (error) {
    await prisma.captureChangeRequest.deleteMany({ where: { id: row.id, tenantId, status: 'PENDING' } });
    throw error;
  }
  return { pendingApproval: true, requestId: row.id, action: 'MANUAL_PUNCH', status: 'PENDING', message: 'Sent for approval. The punch is recorded when the approval route approves it.' };
}

/** Final approval: record the punch as evidence, then mark the request. A repeat approval replays, never duplicates. */
export async function finalizeCaptureChange(tx, env, row, approved) {
  if (approved) {
    const p = row.payload;
    const parsed = readPunch(p.localTime, p.timeZone);
    await assertNoPayrollRun(tx, env.tenantId, p.localTime.slice(0, 10));
    const { receiveCapture } = await import('./attendanceCapture.service.js');
    await receiveCapture({
      source: 'MANUAL', tenantId: env.tenantId, actorId: row.requestedById, manualEmployeeId: p.employeeId,
      requestKey: `CAPTURE:${row.id}`, notes: `Manual punch approved: ${row.reason}`,
      rows: [`${p.employeeId}\t${p.localTime}\t${DIRECTIONS[p.direction]}\t0\t0`],
    });
    await tx.payrollAuditLog.create({
      data: { tenantId: env.tenantId, action: 'CAPTURE_CHANGE_APPLIED', details: `Manual punch applied: ${row.reason}`, oldValues: null, newValues: { requestId: row.id, employeeId: p.employeeId, at: parsed.localTime } },
    });
  }
  await tx.captureChangeRequest.update({ where: { id: row.id }, data: { status: approved ? 'APPROVED' : 'REJECTED' } });
}

export async function listPendingCaptureChanges({ tenantId }) {
  const rows = await prisma.captureChangeRequest.findMany({ where: { tenantId, status: 'PENDING' }, orderBy: { createdAt: 'asc' } });
  const people = await prisma.employee.findMany({
    where: { tenant_id: tenantId, id: { in: [...new Set(rows.map((r) => r.requestedById))] } },
    select: { id: true, employee_name: true, first_name: true, last_name: true },
  });
  const name = new Map(people.map((x) => [x.id, x.employee_name || [x.first_name, x.last_name].filter(Boolean).join(' ') || null]));
  return rows.map((r) => ({ id: r.id, action: r.action, payload: r.payload, reason: r.reason, requestedByName: name.get(r.requestedById) ?? null, createdAt: r.createdAt }));
}
