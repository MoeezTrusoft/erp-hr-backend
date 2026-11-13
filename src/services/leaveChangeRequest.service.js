// Leave changes by approval (LEAVE_CHANGE). HR files; the company's published ATTENDANCE route approves; only the
// final approval changes anything:
//   POLICY_CREATE / POLICY_UPDATE / POLICY_DELETE   leave types and their rules
//   BALANCE_SET                                    sets one person's balance for one type (a ledger entry)
//   CANCEL_LEAVE                                   cancels approved leave, restores the days, re-checks attendance
// Also here: the balance deduction at the final approval of a leave request itself (deductApprovedLeave), where a
// request that needs more days than the balance can still be approved, but only with a note, or as an unpaid type.
import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import { tenantTransaction } from '../lib/rlsTenant.js';
import { badSetup, dateKey, dateOnly } from '../lib/attendanceDates.js';
import { legacySubmit } from './approval/legacy.js';
import { postLedger } from './leaveLedger.service.js';

const ACTIONS = ['POLICY_CREATE', 'POLICY_UPDATE', 'POLICY_DELETE', 'BALANCE_SET', 'CANCEL_LEAVE'];
const PERIODS = ['NONE', 'MONTHLY', 'QUARTERLY', 'ANNUAL'];
const UNPAID = ['UNPAID', 'LWP'];
const POLICY_FIELDS = ['name', 'description', 'leaveTypeCode', 'accrualRate', 'accrualPeriod', 'carryForwardAllowed', 'maxCarryForward', 'minServiceMonths', 'active'];
const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));
const day = (v) => new Date(v).toISOString().slice(0, 10);
const label = { name: 'name', description: 'description', leaveTypeCode: 'type code', accrualRate: 'days credited per period', accrualPeriod: 'credited', carryForwardAllowed: 'carry forward', maxCarryForward: 'carry-forward limit', minServiceMonths: 'months of service needed', active: 'in use' };
const show = (v) => (v === null || v === undefined || v === '' ? 'not set' : v === true ? 'yes' : v === false ? 'no' : String(v));

/** Whitelisted, validated policy fields (the old update spread whatever it was given into the row). */
export function cleanPolicy(input, existing = {}) {
  const merged = { ...existing };
  for (const key of POLICY_FIELDS) if (input?.[key] !== undefined) merged[key] = input[key];
  const name = String(merged.name ?? '').trim();
  if (!name || name.length > 120) throw badSetup('Give the leave type a name of up to 120 characters');
  const accrualPeriod = String(merged.accrualPeriod ?? 'NONE').toUpperCase();
  if (!PERIODS.includes(accrualPeriod)) throw badSetup('Credit period must be none, monthly, quarterly or annual');
  const accrualRate = num(merged.accrualRate ?? 0);
  if (!Number.isFinite(accrualRate) || accrualRate < 0 || accrualRate > 366) throw badSetup('Days credited must be between 0 and 366');
  const carryForwardAllowed = Boolean(merged.carryForwardAllowed);
  const maxCarryForward = num(merged.maxCarryForward ?? 0);
  if (!Number.isFinite(maxCarryForward) || maxCarryForward < 0 || maxCarryForward > 366) throw badSetup('Carry-forward limit must be between 0 and 366');
  if (carryForwardAllowed && maxCarryForward <= 0) throw badSetup('Set a carry-forward limit above 0, or turn carry forward off');
  if (!carryForwardAllowed && maxCarryForward > 0) throw badSetup('Carry-forward limit must be 0 when carry forward is off');
  const minServiceMonths = num(merged.minServiceMonths ?? 0);
  if (!Number.isInteger(minServiceMonths) || minServiceMonths < 0 || minServiceMonths > 600) throw badSetup('Months of service needed must be a whole number from 0 to 600');
  const code = merged.leaveTypeCode == null || merged.leaveTypeCode === '' ? null : String(merged.leaveTypeCode).trim().toUpperCase().slice(0, 30);
  return { name, description: merged.description ? String(merged.description).slice(0, 500) : null, leaveTypeCode: code, accrualRate, accrualPeriod, carryForwardAllowed, maxCarryForward, minServiceMonths, active: merged.active === undefined ? true : Boolean(merged.active) };
}

/** A payroll run that is not cancelled or failed and overlaps the dates makes cancelling leave unsafe. */
async function assertNoPayrollRun(tx, tenantId, from, to) {
  const run = await tx.payrollRun.findFirst({
    where: { tenantId, periodEnd: { gte: dateOnly(from) }, periodStart: { lte: dateOnly(to) }, status: { notIn: ['CANCELLED', 'FAILED'] } },
    select: { id: true },
  });
  if (run) throw badSetup('Recall or cancel the payroll run that covers these dates before cancelling this leave', 409);
}

async function file({ tenantId, requestedById, action, payload, reason, before, same }) {
  if (!tenantId) throw badSetup('Tenant is required', 403);
  if (!ACTIONS.includes(action)) throw badSetup('Unknown leave change');
  const actor = Number(requestedById);
  if (!Number.isInteger(actor) || actor < 1) throw badSetup('Sign in with an employee account to request a leave change', 403);
  const why = String(reason ?? '').trim();
  if (why.length < 3) throw badSetup('Give a reason for the leave change (at least 3 characters)');
  const row = await tenantTransaction(
    prisma,
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:leave-change`}))`;
      const pending = await tx.leaveChangeRequest.findMany({ where: { tenantId, status: 'PENDING' }, select: { action: true, payload: true } });
      if (pending.some((p) => same(p)))
        throw badSetup('This leave item already has a change waiting for approval', 409);
      const prepared = await before(tx);
      return tx.leaveChangeRequest.create({ data: { id: randomUUID(), tenantId, action, payload: { ...payload, ...prepared }, reason: why, requestedById: actor } });
    },
    { tenantId },
  );
  try {
    await legacySubmit('LEAVE_CHANGE', row.id, why, { onBehalf: true });
  } catch (error) {
    await prisma.leaveChangeRequest.deleteMany({ where: { id: row.id, tenantId, status: 'PENDING' } });
    throw error;
  }
  return { pendingApproval: true, requestId: row.id, action, status: 'PENDING', message: 'Sent for approval. The change applies when the approval route approves it.' };
}

const policyLines = (before, after) => POLICY_FIELDS.filter((k) => JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after[k] ?? null)).map((k) => `${label[k]}: ${show(before?.[k])} → ${show(after[k])}`);

export const requestPolicyCreate = ({ tenantId, requestedById, reason, ...input }) => {
  let clean;
  return file({
    tenantId, requestedById, reason, action: 'POLICY_CREATE', payload: {},
    same: (p) => p.action === 'POLICY_CREATE' && String(p.payload?.policy?.name).toLowerCase() === String(input.name ?? '').trim().toLowerCase(),
    before: async (tx) => {
      clean = cleanPolicy(input);
      if (await tx.leavePolicy.findFirst({ where: { tenantId, name: { equals: clean.name, mode: 'insensitive' } }, select: { id: true } })) throw badSetup('A leave type with this name already exists', 409);
      return { policy: clean, changes: policyLines({}, clean) };
    },
  });
};

export const requestPolicyUpdate = ({ tenantId, requestedById, reason, id, expectedVersion, ...input }) =>
  file({
    tenantId, requestedById, reason, action: 'POLICY_UPDATE', payload: { policyId: Number(id) },
    same: (p) => p.action === 'POLICY_UPDATE' && p.payload?.policyId === Number(id),
    before: async (tx) => {
      const old = await tx.leavePolicy.findFirst({ where: { id: Number(id), tenantId } });
      if (!old) throw badSetup('Leave type not found', 404);
      if (expectedVersion != null && Number(expectedVersion) !== old.version) throw badSetup('This leave type changed; refresh before saving', 409);
      const clean = cleanPolicy(input, old);
      if (clean.name.toLowerCase() !== old.name.toLowerCase() && (await tx.leavePolicy.findFirst({ where: { tenantId, name: { equals: clean.name, mode: 'insensitive' }, NOT: { id: old.id } }, select: { id: true } }))) throw badSetup('A leave type with this name already exists', 409);
      const changes = policyLines(old, clean);
      if (!changes.length) throw badSetup('Nothing changed');
      return { policy: clean, version: old.version, policyName: old.name, changes };
    },
  });

export const requestPolicyDelete = ({ tenantId, requestedById, reason, id }) =>
  file({
    tenantId, requestedById, reason, action: 'POLICY_DELETE', payload: { policyId: Number(id) },
    same: (p) => ['POLICY_DELETE', 'POLICY_UPDATE'].includes(p.action) && p.payload?.policyId === Number(id),
    before: async (tx) => {
      const old = await tx.leavePolicy.findFirst({ where: { id: Number(id), tenantId } });
      if (!old) throw badSetup('Leave type not found', 404);
      await assertPolicyUnused(tx, tenantId, old.id);
      return { policyName: old.name, changes: [`Remove leave type ${old.name}`] };
    },
  });

async function assertPolicyUnused(tx, tenantId, id) {
  if (await tx.leaveRequest.count({ where: { tenantId, leavePolicyId: id } })) throw badSetup('This leave type has leave requests; mark it not in use instead of removing it', 409);
  if (await tx.leaveBalance.count({ where: { tenantId, leavePolicyId: id } })) throw badSetup('This leave type has balances; mark it not in use instead of removing it', 409);
}

export const requestBalanceSet = ({ tenantId, requestedById, reason, employeeId, leavePolicyId, balance, carryOverBalance }) =>
  file({
    tenantId, requestedById, reason, action: 'BALANCE_SET',
    payload: { employeeId: Number(employeeId), leavePolicyId: Number(leavePolicyId), balance: num(balance), ...(carryOverBalance === undefined || carryOverBalance === null ? {} : { carryOverBalance: num(carryOverBalance) }) },
    same: (p) => p.action === 'BALANCE_SET' && p.payload?.employeeId === Number(employeeId) && p.payload?.leavePolicyId === Number(leavePolicyId),
    before: async (tx) => {
      const target = num(balance);
      if (!Number.isFinite(target) || target < -366 || target > 1000) throw badSetup('Balance must be a number of days between -366 and 1000');
      if (carryOverBalance !== undefined && carryOverBalance !== null && (!Number.isFinite(num(carryOverBalance)) || num(carryOverBalance) < 0 || num(carryOverBalance) > 366)) throw badSetup('Carry-over must be between 0 and 366 days');
      const [person, policy] = await Promise.all([
        tx.employee.findFirst({ where: { id: Number(employeeId), tenant_id: tenantId }, select: { id: true, employee_name: true, employee_code: true } }),
        tx.leavePolicy.findFirst({ where: { id: Number(leavePolicyId), tenantId }, select: { id: true, name: true } }),
      ]);
      if (!person) throw badSetup('Employee not found', 404);
      if (!policy) throw badSetup('Leave type not found', 404);
      const current = (await tx.leaveBalance.findUnique({ where: { employeeId_leavePolicyId: { employeeId: person.id, leavePolicyId: policy.id } } }))?.balance ?? 0;
      if (current === target && (carryOverBalance === undefined || carryOverBalance === null)) throw badSetup('The balance is already this value');
      return { balanceBefore: current, employeeName: person.employee_name ?? person.employee_code, policyName: policy.name, changes: [`${policy.name} balance for ${person.employee_name ?? person.employee_code}: ${current} → ${target} days`] };
    },
  });

export const requestCancelLeave = ({ tenantId, requestedById, reason, leaveRequestId }) =>
  file({
    tenantId, requestedById, reason, action: 'CANCEL_LEAVE', payload: { leaveRequestId: Number(leaveRequestId) },
    same: (p) => p.action === 'CANCEL_LEAVE' && p.payload?.leaveRequestId === Number(leaveRequestId),
    before: async (tx) => {
      const leave = await tx.leaveRequest.findFirst({ where: { id: Number(leaveRequestId), tenantId }, include: { employee: { select: { employee_name: true, employee_code: true } }, leavePolicy: { select: { name: true } } } });
      if (!leave) throw badSetup('Leave request not found', 404);
      if (leave.status !== 'APPROVED') throw badSetup('Only approved leave can be cancelled here; pending leave is withdrawn by the employee', 409);
      await assertNoPayrollRun(tx, tenantId, leave.startDate, leave.endDate);
      const who = leave.employee.employee_name ?? leave.employee.employee_code;
      return { employeeName: who, policyName: leave.leavePolicy?.name ?? null, from: day(leave.startDate), to: day(leave.endDate), days: leave.totalDays, changes: [`Cancel ${leave.leavePolicy?.name ?? 'leave'} for ${who}, ${day(leave.startDate)} to ${day(leave.endDate)} (${leave.totalDays} days); the days go back to the balance and attendance is re-checked`] };
    },
  });

/** At the final approval of a leave request: take the days off the balance, or refuse a shortfall that has no note. */
export async function deductApprovedLeave(tx, env, row, note) {
  const policy = await tx.leavePolicy.findFirst({ where: { id: row.leavePolicyId, tenantId: env.tenantId } });
  if (!policy) throw badSetup('Assign a leave type before approving', 409);
  // Unpaid leave has no balance; payroll recovers its days as unpaid leave.
  if (UNPAID.includes(String(policy.leaveTypeCode).toUpperCase())) return;
  const current = (await tx.leaveBalance.findUnique({ where: { employeeId_leavePolicyId: { employeeId: row.employeeId, leavePolicyId: policy.id } } }))?.balance ?? 0;
  const short = current < row.totalDays;
  const why = String(note ?? '').trim();
  if (short && why.length < 3)
    throw badSetup(`The balance is ${current} days and this leave needs ${row.totalDays}. Add a note to approve the shortfall as an overdraft, or change the leave type to an unpaid type.`, 409);
  await postLedger(tx, {
    tenantId: env.tenantId, employeeId: row.employeeId, leavePolicyId: policy.id, kind: short ? 'OVERDRAFT' : 'LEAVE_TAKEN', days: -row.totalDays,
    key: `LEAVE:${row.id}`, sourceRef: String(row.id), reason: short ? `Overdraft approved: ${why}` : `Leave ${day(row.startDate)} to ${day(row.endDate)}`, actorId: env.who?.id ?? null,
  });
}

const apply = {
  async POLICY_CREATE(tx, env, row) {
    await tx.leavePolicy.create({ data: { tenantId: env.tenantId, ...row.payload.policy, createdById: row.requestedById } });
  },
  async POLICY_UPDATE(tx, env, row) {
    const { count } = await tx.leavePolicy.updateMany({
      where: { id: row.payload.policyId, tenantId: env.tenantId, version: row.payload.version },
      data: { ...row.payload.policy, updatedById: row.requestedById, version: { increment: 1 } },
    });
    if (!count) throw badSetup('This leave type changed after the request was filed. Reject it and file a new request.', 409);
  },
  async POLICY_DELETE(tx, env, row) {
    await assertPolicyUnused(tx, env.tenantId, row.payload.policyId);
    await tx.leavePolicy.deleteMany({ where: { id: row.payload.policyId, tenantId: env.tenantId } });
  },
  async BALANCE_SET(tx, env, row) {
    const { employeeId, leavePolicyId, balance, carryOverBalance } = row.payload;
    const key = { employeeId_leavePolicyId: { employeeId, leavePolicyId } };
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${env.tenantId}:leave-balance:${employeeId}:${leavePolicyId}`}, 0))`;
    const current = (await tx.leaveBalance.findUnique({ where: key }))?.balance ?? 0;
    if (current !== row.payload.balanceBefore) throw badSetup(`The balance changed from ${row.payload.balanceBefore} to ${current} days after the request was filed. Reject it and file a new request.`, 409);
    await postLedger(tx, { tenantId: env.tenantId, employeeId, leavePolicyId, kind: 'ADJUSTMENT', days: balance - current, key: `ADJUST:${row.id}`, sourceRef: row.id, reason: row.reason, actorId: row.requestedById, carryOver: carryOverBalance });
  },
  async CANCEL_LEAVE(tx, env, row) {
    const leave = await tx.leaveRequest.findFirst({ where: { id: row.payload.leaveRequestId, tenantId: env.tenantId } });
    if (!leave || leave.status !== 'APPROVED') throw badSetup('This leave is no longer approved, so it cannot be cancelled. Reject this request.', 409);
    await assertNoPayrollRun(tx, env.tenantId, leave.startDate, leave.endDate);
    // The database lets approved leave be cancelled only inside an approved LEAVE_CHANGE for that leave.
    await tx.$executeRaw`SELECT set_config('app.hr_leave_cancel', ${`LEAVE_CANCEL:${leave.id}`}, true)`;
    await tx.leaveRequest.update({ where: { id: leave.id }, data: { status: 'CANCELLED', updatedById: row.requestedById } });
    // Give back exactly what was taken (nothing for unpaid leave, which never touched the balance).
    const taken = await tx.leaveBalanceLedger.findFirst({ where: { tenantId: env.tenantId, idempotencyKey: `LEAVE:${leave.id}` } });
    if (taken)
      await postLedger(tx, { tenantId: env.tenantId, employeeId: leave.employeeId, leavePolicyId: leave.leavePolicyId, kind: 'LEAVE_RESTORED', days: -taken.days, key: `LEAVE_RESTORE:${leave.id}`, sourceRef: String(leave.id), reason: `Leave cancelled: ${row.reason}`, actorId: row.requestedById });
    // The leave's own attendance marks go; a day with a real punch was never marked, so it stays.
    await tx.attendance.deleteMany({ where: { tenantId: env.tenantId, employeeId: leave.employeeId, date: { gte: dateOnly(leave.startDate), lte: dateOnly(leave.endDate) }, status: 'ON_LEAVE', check_in: null, check_out: null } });
    await tx.leave.deleteMany({ where: { tenantId: env.tenantId, employeeId: leave.employeeId, start_date: leave.startDate, end_date: leave.endDate } });
    // Loaded here so the approval path for ordinary leave does not pull in the attendance writer.
    const { enqueueEvaluationRange } = await import('./attendanceFinalization.service.js');
    await enqueueEvaluationRange({ tenantId: env.tenantId, from: leave.startDate, to: leave.endDate, employeeIds: [leave.employeeId] }, tx);
  },
};

/** Final approval: write inside the approval transaction, then record the decision on the request. */
export async function finalizeLeaveChange(tx, env, row, approved) {
  if (approved) {
    await apply[row.action](tx, env, row);
    await tx.payrollAuditLog.create({
      data: { tenantId: env.tenantId, action: 'LEAVE_CHANGE_APPLIED', details: `Leave change applied (${row.action}): ${row.reason}`, oldValues: null, newValues: { requestId: row.id, action: row.action } },
    });
  }
  await tx.leaveChangeRequest.update({ where: { id: row.id }, data: { status: approved ? 'APPROVED' : 'REJECTED' } });
}

/** Leave changes still waiting for the route, so the screens can show them. */
export async function listPendingLeaveChanges({ tenantId }) {
  const rows = await prisma.leaveChangeRequest.findMany({ where: { tenantId, status: 'PENDING' }, orderBy: { createdAt: 'asc' } });
  const people = await prisma.employee.findMany({
    where: { tenant_id: tenantId, id: { in: [...new Set(rows.map((r) => r.requestedById))] } },
    select: { id: true, employee_name: true, first_name: true, last_name: true },
  });
  const name = new Map(people.map((p) => [p.id, p.employee_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || null]));
  return rows.map((r) => ({ id: r.id, action: r.action, payload: r.payload, reason: r.reason, requestedByName: name.get(r.requestedById) ?? null, createdAt: r.createdAt }));
}
