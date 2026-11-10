// Income-tax slabs by approval (TAX_SLAB_CHANGE, action REPLACE_SET). HR files a country's whole slab set with the date
// it starts; the company's published PAYROLL route approves it; only the final approval changes tax_rates. Slabs that
// were in force are ended the day before the new set starts, so payroll already run keeps the slabs it used. A date that
// a non-cancelled payroll run already covers is refused, both when filing and again at the final approval.
import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import { tenantTransaction } from '../lib/rlsTenant.js';
import { badSetup, dateOnly } from '../lib/attendanceDates.js';
import { legacySubmit } from './approval/legacy.js';

const MAX_SLABS = 12;
const MAX_AMOUNT = 1e12;
const round4 = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;
const text = (n) => round4(n).toFixed(4);
const money = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

/**
 * The slab set as the payroll tax table stores it. The person gives each slab's upper limit and its rate; the lower
 * limit is the previous upper limit, and the base tax (tax owed up to the lower limit) is worked out here.
 */
export function cleanSlabSet(input) {
  const slabs = Array.isArray(input) ? input : [];
  if (!slabs.length) throw badSetup('Add at least one tax slab');
  if (slabs.length > MAX_SLABS) throw badSetup(`A slab set can have up to ${MAX_SLABS} slabs`);
  const out = [];
  let from = 0;
  let base = 0;
  slabs.forEach((slab, i) => {
    const last = i === slabs.length - 1;
    const rawUpto = slab?.upto;
    const hasUpto = rawUpto !== null && rawUpto !== undefined && rawUpto !== '';
    if (last && hasUpto) throw badSetup('The last slab has no upper limit; leave "up to" empty');
    if (!last && !hasUpto) throw badSetup(`Slab ${i + 1} needs an upper limit; only the last slab is open-ended`);
    const upto = hasUpto ? Number(rawUpto) : null;
    if (hasUpto && (!Number.isFinite(upto) || upto <= from)) throw badSetup(`Slab ${i + 1}: the upper limit must be above ${money(from)}`);
    if (hasUpto && upto > MAX_AMOUNT) throw badSetup(`Slab ${i + 1}: the upper limit is too large`);
    const pct = Number(slab?.ratePct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw badSetup(`Slab ${i + 1}: the rate must be between 0 and 100 percent`);
    const rate = Math.round(pct * 10000) / 1000000; // the column keeps 6 decimals of the fraction
    out.push({ bracketMin: text(from), bracketMax: hasUpto ? text(upto) : null, rate, ratePct: Math.round(pct * 10000) / 10000, baseTax: text(base) });
    if (hasUpto) {
      base += (upto - from) * rate;
      from = upto;
    }
  });
  return out;
}

async function assertNoPayrollRun(tx, tenantId, from) {
  const run = await tx.payrollRun.findFirst({
    where: { tenantId, periodEnd: { gte: dateOnly(from) }, status: { notIn: ['CANCELLED', 'FAILED'] } },
    select: { id: true },
  });
  if (run) throw badSetup('A payroll run already covers this date. Choose a date after the last payroll run, or cancel that run first', 409);
}

const describe = (rows) =>
  rows.map((r) => `${money(r.bracketMin)} to ${r.bracketMax == null ? 'no limit' : money(r.bracketMax)}: ${Math.round(Number(r.rate) * 10000) / 100}%`);

export async function requestTaxSlabSet({ tenantId, requestedById, countryCode = 'PK', effectiveFrom, slabs, reason }) {
  if (!tenantId) throw badSetup('Tenant is required', 403);
  const actor = Number(requestedById);
  if (!Number.isInteger(actor) || actor < 1) throw badSetup('Sign in with an employee account to change tax slabs', 403);
  const why = String(reason ?? '').trim();
  if (why.length < 3) throw badSetup('Give a reason for the tax slab change (at least 3 characters)');
  const country = String(countryCode ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw badSetup('Choose a country');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effectiveFrom ?? '')) || Number.isNaN(new Date(`${effectiveFrom}T00:00:00Z`).getTime()))
    throw badSetup('Choose the date the new slabs start (YYYY-MM-DD)');
  const clean = cleanSlabSet(slabs);
  const row = await tenantTransaction(
    prisma,
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:tax-slab-change`}))`;
      const pending = await tx.taxSlabChangeRequest.findMany({ where: { tenantId, status: 'PENDING' }, select: { payload: true } });
      if (pending.some((p) => p.payload?.countryCode === country))
        throw badSetup('This country already has a tax slab change waiting for approval', 409);
      await assertNoPayrollRun(tx, tenantId, effectiveFrom);
      const current = await tx.taxRate.findMany({
        where: { tenantId, countryCode: country, status: 'ACTIVE', OR: [{ effectiveTo: null }, { effectiveTo: { gte: dateOnly(effectiveFrom) } }] },
        orderBy: { bracketMin: 'asc' },
      });
      const same =
        current.length === clean.length &&
        current.every((r, i) => Number(r.bracketMin) === Number(clean[i].bracketMin) && (r.bracketMax == null ? null : Number(r.bracketMax)) === (clean[i].bracketMax == null ? null : Number(clean[i].bracketMax)) && Math.abs(Number(r.rate) - clean[i].rate) < 1e-9);
      if (same) throw badSetup('These are the slabs already in force; nothing changes');
      return tx.taxSlabChangeRequest.create({
        data: {
          id: randomUUID(), tenantId, action: 'REPLACE_SET', reason: why, requestedById: actor,
          payload: {
            countryCode: country, effectiveFrom, slabs: clean,
            before: describe(current), after: describe(clean),
            changes: [`${country} income-tax slabs from ${effectiveFrom}`, ...describe(clean)],
          },
        },
      });
    },
    { tenantId },
  );
  try {
    await legacySubmit('TAX_SLAB_CHANGE', row.id, why);
  } catch (error) {
    await prisma.taxSlabChangeRequest.deleteMany({ where: { id: row.id, tenantId, status: 'PENDING' } });
    throw error;
  }
  const decided = await prisma.taxSlabChangeRequest.findFirst({ where: { id: row.id, tenantId, status: 'APPROVED' }, select: { id: true } });
  if (decided) return { pendingApproval: false, requestId: row.id, action: 'REPLACE_SET', status: 'APPROVED', message: `Done. Filed by Management, so no further approval is needed. The new slabs apply from ${effectiveFrom}.` };
  return { pendingApproval: true, requestId: row.id, action: 'REPLACE_SET', status: 'PENDING', message: 'Sent for approval. The new slabs apply from the chosen date when the approval route approves them.' };
}

/** Final approval: end the slabs in force the day before, add the new set. A repeat approval never duplicates it. */
export async function finalizeTaxSlabChange(tx, env, row, approved) {
  if (approved) {
    const p = row.payload;
    await assertNoPayrollRun(tx, env.tenantId, p.effectiveFrom);
    const start = dateOnly(p.effectiveFrom);
    const dayBefore = new Date(+start - 86400000);
    const open = await tx.taxRate.findMany({ where: { tenantId: env.tenantId, countryCode: p.countryCode, status: 'ACTIVE', OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }] } });
    for (const old of open) {
      if (+new Date(old.effectiveFrom) >= +start) await tx.taxRate.update({ where: { id: old.id }, data: { status: 'INACTIVE' } });
      else await tx.taxRate.update({ where: { id: old.id }, data: { effectiveTo: dayBefore } });
    }
    for (const s of p.slabs)
      await tx.taxRate.create({
        data: { tenantId: env.tenantId, countryCode: p.countryCode, bracketMin: s.bracketMin, bracketMax: s.bracketMax, rate: s.rate, baseTax: s.baseTax, status: 'ACTIVE', effectiveFrom: start },
      });
    await tx.payrollAuditLog.create({
      data: { tenantId: env.tenantId, action: 'TAX_SLAB_CHANGE_APPLIED', details: `Tax slabs replaced from ${p.effectiveFrom}: ${row.reason}`, oldValues: { slabs: p.before }, newValues: { requestId: row.id, countryCode: p.countryCode, slabs: p.after } },
    });
  }
  await tx.taxSlabChangeRequest.update({ where: { id: row.id }, data: { status: approved ? 'APPROVED' : 'REJECTED' } });
}

export async function listPendingTaxSlabChanges({ tenantId }) {
  const rows = await prisma.taxSlabChangeRequest.findMany({ where: { tenantId, status: 'PENDING' }, orderBy: { createdAt: 'asc' } });
  const people = await prisma.employee.findMany({
    where: { tenant_id: tenantId, id: { in: [...new Set(rows.map((r) => r.requestedById))] } },
    select: { id: true, employee_name: true, first_name: true, last_name: true },
  });
  const name = new Map(people.map((x) => [x.id, x.employee_name || [x.first_name, x.last_name].filter(Boolean).join(' ') || null]));
  return rows.map((r) => ({ id: r.id, action: r.action, payload: r.payload, reason: r.reason, requestedByName: name.get(r.requestedById) ?? null, createdAt: r.createdAt }));
}
