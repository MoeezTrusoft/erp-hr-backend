// Leave balances through a ledger. Every movement (accrual, leave taken, restore, adjustment, carry-over, expiry) is
// one append-only row with a reason and an optional idempotency key, so a balance can be explained and the same
// accrual or carry-over run twice credits once. The balance row is only ever changed here.
import prisma from '../lib/prisma.js';
import { tenantTransaction } from '../lib/rlsTenant.js';
import { badSetup, dateKey } from '../lib/attendanceDates.js';

const round = (n) => Math.round(n * 100) / 100;

/** Post one movement inside a transaction. Returns { applied:false } when the idempotency key was already used. */
export async function postLedger(tx, { tenantId, employeeId, leavePolicyId, kind, days, key = null, sourceRef = null, reason = null, actorId = null, carryOver }) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:leave-balance:${employeeId}:${leavePolicyId}`}, 0))`;
  if (key && (await tx.leaveBalanceLedger.findFirst({ where: { tenantId, idempotencyKey: key }, select: { id: true } }))) return { applied: false };
  const where = { employeeId_leavePolicyId: { employeeId, leavePolicyId } };
  const current = await tx.leaveBalance.findUnique({ where });
  const balanceAfter = round((current?.balance ?? 0) + days);
  const carry = carryOver === undefined ? {} : { carryOverBalance: carryOver };
  await tx.leaveBalance.upsert({
    where,
    create: { tenantId, employeeId, leavePolicyId, balance: balanceAfter, carryOverBalance: carryOver ?? 0, lastUpdated: new Date(), updatedById: actorId },
    update: { balance: balanceAfter, lastUpdated: new Date(), updatedById: actorId, ...carry },
  });
  await tx.leaveBalanceLedger.create({
    data: { tenantId, employeeId, leavePolicyId, kind, days: round(days), balanceAfter, idempotencyKey: key, sourceRef, reason, createdById: actorId },
  });
  return { applied: true, balanceAfter };
}

const parts = (value) => {
  const d = new Date(value);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate() };
};
const activeEmployee = { status: { equals: 'Active', mode: 'insensitive' } };

/** What one policy credits one employee for the period that contains `date`, and the key that makes it once-only. */
export function accrualFor(policy, hireDate, date) {
  const a = parts(date), h = parts(hireDate);
  if (new Date(hireDate) > new Date(date)) return null;
  const months = (a.y - h.y) * 12 + (a.m - h.m);
  if (months < (policy.minServiceMonths ?? 0)) return null;
  if (policy.accrualPeriod === 'MONTHLY') return { amount: policy.accrualRate, period: `${a.y}-${String(a.m + 1).padStart(2, '0')}` };
  if (policy.accrualPeriod === 'QUARTERLY') return { amount: policy.accrualRate * 3, period: `${a.y}-Q${Math.floor(a.m / 3) + 1}` };
  // shortcut: yearly credit lands in the month of the hire anniversary, not the exact day; fine because it is once-only per year.
  if (policy.accrualPeriod === 'ANNUAL' && a.m === h.m) return { amount: policy.accrualRate, period: String(a.y) };
  return null;
}

/**
 * Credit leave for the period containing `accrualDate`. A dry run (the default) lists who would be credited and
 * writes nothing; a real run credits each person once per policy and period, however often it is repeated.
 */
export async function runAccruals({ tenantId, accrualDate, policyIds = [], dryRun = true, actorId = null }) {
  const date = accrualDate ? new Date(`${dateKey(accrualDate)}T00:00:00Z`) : new Date(`${dateKey(new Date())}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw badSetup('Choose a valid accrual date');
  const ids = policyIds.map(Number).filter(Number.isInteger);
  return tenantTransaction(prisma, async (tx) => {
    const policies = await tx.leavePolicy.findMany({
      where: { tenantId, active: true, accrualPeriod: { not: 'NONE' }, ...(ids.length ? { id: { in: ids } } : {}) },
      orderBy: { id: 'asc' },
    });
    const people = await tx.employee.findMany({
      where: { tenant_id: tenantId, ...activeEmployee, hire_date: { lte: date } },
      select: { id: true, hire_date: true, employee_name: true, employee_code: true },
      orderBy: { id: 'asc' },
    });
    const details = [];
    for (const policy of policies)
      for (const person of people) {
        const due = accrualFor(policy, person.hire_date, date);
        if (!due || !(due.amount > 0)) continue;
        const key = `ACCRUAL:${policy.id}:${person.id}:${due.period}`;
        let credited = false;
        if (!dryRun) {
          const reason = `${policy.name} accrual for ${due.period}`;
          credited = (await postLedger(tx, { tenantId, employeeId: person.id, leavePolicyId: policy.id, kind: 'ACCRUAL', days: due.amount, key, reason, actorId })).applied;
        } else credited = !(await tx.leaveBalanceLedger.findFirst({ where: { tenantId, idempotencyKey: key }, select: { id: true } }));
        details.push({ employeeId: person.id, employee: person.employee_name ?? person.employee_code, policyId: policy.id, policy: policy.name, period: due.period, days: due.amount, credited });
      }
    return { dryRun, date: dateKey(date), credited: details.filter((d) => d.credited).length, alreadyCredited: details.filter((d) => !d.credited).length, details };
  }, { tenantId, txOptions: { timeout: 60000 } });
}

/**
 * Year-end carry-over: keep up to the policy's limit, expire the rest, each with a ledger row. Once per person,
 * policy and year. A dry run (the default) lists what would expire.
 */
export async function runCarryOver({ tenantId, effectiveDate, policyIds = [], dryRun = true, actorId = null }) {
  const date = effectiveDate ? new Date(`${dateKey(effectiveDate)}T00:00:00Z`) : new Date(`${dateKey(new Date())}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw badSetup('Choose a valid date');
  const ids = policyIds.map(Number).filter(Number.isInteger);
  const year = date.getUTCFullYear();
  return tenantTransaction(prisma, async (tx) => {
    const policies = await tx.leavePolicy.findMany({
      where: { tenantId, active: true, carryForwardAllowed: true, ...(ids.length ? { id: { in: ids } } : {}) },
      orderBy: { id: 'asc' },
    });
    const details = [];
    for (const policy of policies) {
      const rows = await tx.leaveBalance.findMany({
        where: { tenantId, leavePolicyId: policy.id, balance: { gt: 0 }, employee: activeEmployee },
        include: { employee: { select: { employee_name: true, employee_code: true } } },
        orderBy: { employeeId: 'asc' },
      });
      for (const row of rows) {
        const carried = round(Math.min(row.balance, policy.maxCarryForward));
        const expired = round(row.balance - carried);
        const key = `CARRY:${policy.id}:${row.employeeId}:${year}`;
        const done = await tx.leaveBalanceLedger.findFirst({ where: { tenantId, idempotencyKey: key }, select: { id: true } });
        if (!dryRun && !done)
          await postLedger(tx, { tenantId, employeeId: row.employeeId, leavePolicyId: policy.id, kind: expired > 0 ? 'EXPIRED' : 'CARRY_OVER', days: -expired, key, reason: `${policy.name} carry-over for ${year}: ${carried} kept, ${expired} expired`, actorId, carryOver: carried });
        details.push({ employeeId: row.employeeId, employee: row.employee.employee_name ?? row.employee.employee_code, policyId: policy.id, policy: policy.name, carried, expired, done: Boolean(done) });
      }
    }
    return { dryRun, year, details };
  }, { tenantId, txOptions: { timeout: 60000 } });
}

/** The movements behind one balance, newest first, so anyone can see how it got there. */
export async function balanceHistory({ tenantId, employeeId, leavePolicyId, limit = 100 }) {
  return tenantTransaction(prisma, (tx) =>
    tx.leaveBalanceLedger.findMany({
      where: { tenantId, employeeId: Number(employeeId), ...(leavePolicyId ? { leavePolicyId: Number(leavePolicyId) } : {}) },
      orderBy: { id: 'desc' },
      take: Math.min(Number(limit) || 100, 500),
    }).then((rows) => rows.map((r) => ({ ...r, id: Number(r.id) }))), { tenantId });
}
