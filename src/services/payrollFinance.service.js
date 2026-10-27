import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { HrPayrollFinanceSummaryV1, PAYROLL_FINANCE_EVENT, PayrollMoney, payrollMinor } from '@trusoft/contracts/payroll-finance';
import { tenantTransaction } from '../lib/rlsTenant.js';
import { enqueueHrDomainEvent } from './hrDomainEvent.service.js';

const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const decimal = value => PayrollMoney.parse(String(value).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
const wire = cents => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
const day = value => new Date(value).toISOString().slice(0, 10);
const actor = ctx => {
  if (!ctx?.user?.tenantId || !Number.isSafeInteger(Number(ctx.user.userId)) || Number(ctx.user.userId) <= 0) fail('Verified tenant and RBAC user are required', 403);
  return String(Number(ctx.user.userId));
};

// Derive from finalized slips, verify cached run totals, and keep all
// employee-level information inside HR. No rounding at the module boundary.
export async function payrollFinanceSource(tx, tenantId, runId) {
  const run = await tx.payrollRun.findFirst({ where: { tenantId, id: runId } });
  if (!run) fail('Payroll run not found', 404);
  if (run.status !== 'FINALIZED' || !run.approvedBy || run.approvedBy === run.processedBy) fail('Independently approved, finalized payroll required');
  const month = day(run.periodStart).slice(0, 7);
  const end = new Date(`${month}-01T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
  if (day(run.periodStart) !== `${month}-01` || day(run.periodEnd) !== day(end)) fail('Finance summary requires one complete calendar month');
  const slips = await tx.payrollPayslip.findMany({ where: { tenantId, payrollRunId: runId }, include: { deductions: { include: { deductionType: true } } }, orderBy: { id: 'asc' } });
  if (!slips.length || slips.some(s => !['FINALIZED', 'DISTRIBUTED', 'PAID'].includes(s.status))) fail('Every payslip must be finalized');
  const total = field => wire(slips.reduce((n, s) => n + payrollMinor(decimal(s[field])), 0n));
  const gross = total('grossAmount'), deductions = total('totalDeductions'), netPay = total('netAmount');
  for (const [actual, cached] of [[gross, run.totalGross], [deductions, run.totalDeductions], [netPay, run.totalNet]]) if (payrollMinor(actual) !== payrollMinor(decimal(cached))) fail('Run totals differ from finalized payslips');
  const codes = new Map();
  for (const slip of slips) {
    if (payrollMinor(decimal(slip.grossAmount)) - payrollMinor(decimal(slip.totalDeductions)) !== payrollMinor(decimal(slip.netAmount))) fail('Unbalanced payslip');
    let deductionTotal = 0n;
    for (const line of slip.deductions) {
      const code = line.deductionType?.code;
      if (!code) fail('Every deduction must have an authoritative code');
      const cents = payrollMinor(decimal(line.amount));
      deductionTotal += cents; codes.set(code, (codes.get(code) || 0n) + cents);
    }
    if (deductionTotal !== payrollMinor(decimal(slip.totalDeductions))) fail('Payslip deductions differ from detail');
  }
  const result = { runId, month, currency: run.currencyCode, headcount: new Set(slips.map(s => s.employeeId)).size,
    gross, deductions, netPay,
    deductionLines: [...codes].filter(([,n]) => n > 0n).sort(([a],[b]) => a.localeCompare(b)).map(([code, n]) => ({ code, amount: wire(n) })) };
  return { ...result, sourceHash: digest({ ...result, sourceSlips: slips.map(s => [s.id, s.employeeId, decimal(s.grossAmount), decimal(s.totalDeductions), decimal(s.netAmount)]) }) };
}

export function createPayrollFinanceService(db) {
  const transact = (ctx, fn) => tenantTransaction(db, fn, { tenantId: ctx.user.tenantId });
  const lock = (tx, tenantId) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`hr-finance:${tenantId}`},0))`;
  return {
    async prepare(ctx, input) {
      const preparedBy = actor(ctx), tenantId = ctx.user.tenantId;
      return transact(ctx, async tx => {
        await lock(tx, tenantId);
        const inputHash = digest(input);
        const retry = await tx.payrollFinanceSummary.findFirst({ where: { tenantId, requestId: input.requestId } });
        if (retry) { if (retry.inputHash !== inputHash || retry.preparedBy !== preparedBy) fail('Request ID reused with different content or actor'); return retry; }
        const source = await payrollFinanceSource(tx, tenantId, input.runId);
        const prior = await tx.payrollFinanceSummary.findFirst({ where: { tenantId, month: source.month }, orderBy: { revision: 'desc' } });
        if (prior?.status === 'DRAFT') fail('Approve the pending summary before preparing a later revision');
        const approvedPrior = await tx.payrollFinanceSummary.findFirst({ where: { tenantId, month: source.month, status: 'APPROVED' }, orderBy: { revision: 'desc' } });
        for (const [items, key] of [['payments', 'reference'], ['advances', 'id']]) for (const old of approvedPrior?.payload?.[items] || []) {
          // PostgreSQL JSONB reorders object keys. Compare evidence values while
          // preserving the existing request/source hashes and approval history.
          if (!input[items].some(x => x[key] === old[key] && isDeepStrictEqual(x, old))) fail('Revisions must retain previously approved payments and advances unchanged');
        }
        const paid = [...input.payments, ...input.advances].reduce((n,x) => n + payrollMinor(x.amount), 0n);
        const id = randomUUID(), revision = (prior?.revision || 0) + 1;
        const payload = { ...source, tenantId, summaryId: id, revision, preparedBy,
          employerContribution: input.employerContribution,
          ...(input.employerContributionEvidenceAssetId ? { employerContributionEvidenceAssetId: input.employerContributionEvidenceAssetId } : {}),
          payments: input.payments, advances: input.advances,
          paymentStatus: paid === 0n ? 'UNPAID' : paid === payrollMinor(source.netPay) ? 'PAID' : 'PARTIAL' };
        HrPayrollFinanceSummaryV1.parse({ ...payload, approvedBy: 'pending-independent-approval' });
        return tx.payrollFinanceSummary.create({ data: { id, tenantId, month: source.month, runId: input.runId, revision, requestId: input.requestId, inputHash, preparedBy, reason: input.reason, payload } });
      });
    },
    async approve(ctx, input) {
      const approvedBy = actor(ctx), tenantId = ctx.user.tenantId;
      return transact(ctx, async tx => {
        await lock(tx, tenantId);
        const row = await tx.payrollFinanceSummary.findFirst({ where: { tenantId, id: input.id } });
        if (!row) fail('Summary not found', 404);
        if (row.preparedBy === approvedBy) fail('Independent HR approval required', 403);
        if (row.status === 'APPROVED' && row.approvedBy === approvedBy && input.expectedVersion === row.version - 1) return row;
        if (row.version !== input.expectedVersion) fail('Summary version changed', 412);
        if (row.status !== 'DRAFT') fail('Draft summary required');
        const source = await payrollFinanceSource(tx, tenantId, row.runId);
        if (source.sourceHash !== row.payload.sourceHash) fail('Finalized payroll changed after preparation');
        const payload = HrPayrollFinanceSummaryV1.parse({ ...row.payload, approvedBy });
        const event = await enqueueHrDomainEvent(tx, { eventName: PAYROLL_FINANCE_EVENT, tenantId, actorId: approvedBy, actorType: 'user', correlationId: ctx.correlationId,
          aggregateType: 'PayrollFinanceSummary', aggregateId: row.id, payload });
        if (!event) fail('Payroll summary outbox is unavailable', 503);
        return tx.payrollFinanceSummary.update({ where: { id: row.id, tenantId }, data: { status: 'APPROVED', approvedBy, approvedAt: new Date(), version: { increment: 1 }, payload } });
      });
    },
    async cancel(ctx, input) {
      const cancelledBy = actor(ctx), tenantId = ctx.user.tenantId;
      return transact(ctx, async tx => {
        await lock(tx, tenantId);
        const row = await tx.payrollFinanceSummary.findFirst({ where: { tenantId, id: input.id } });
        if (!row) fail('Summary not found', 404);
        if (row.status !== 'DRAFT' || row.version !== input.expectedVersion) fail('Current draft summary required', 412);
        await tx.payrollAuditLog.create({ data: { tenantId, payrollRunId: row.runId, action: 'FINANCE_SUMMARY_CANCELLED', details: `Summary ${row.id}; RBAC user ${cancelledBy}; ${input.reason}` } });
        return tx.payrollFinanceSummary.update({ where: { id: row.id, tenantId }, data: { status: 'CANCELLED', version: { increment: 1 } } });
      });
    },
    async republish(ctx, input) {
      actor(ctx); const tenantId = ctx.user.tenantId;
      return transact(ctx, async tx => {
        await lock(tx, tenantId);
        const row = await tx.payrollFinanceSummary.findFirst({ where: { tenantId, id: input.id } });
        if (!row) fail('Summary not found', 404);
        if (row.status !== 'APPROVED' || row.version !== input.expectedVersion) fail('Current approved summary required', 412);
        const event = await enqueueHrDomainEvent(tx, { eventName: PAYROLL_FINANCE_EVENT, tenantId,
          actorId: row.approvedBy, actorType:'user', correlationId:ctx.correlationId,
          aggregateType:'PayrollFinanceSummary', aggregateId:row.id,
          payload:HrPayrollFinanceSummaryV1.parse(row.payload) });
        if (!event) fail('Payroll summary outbox is unavailable',503);
        await tx.payrollAuditLog.create({data:{tenantId, payrollRunId:row.runId,action:'FINANCE_SUMMARY_REPUBLISHED',details:`Summary ${row.id}; requested by RBAC user ${actor(ctx)}`}});
        return {summaryId:row.id,republished:true};
      });
    },
    async list(ctx, input) { actor(ctx); return transact(ctx, async tx => ({ items: await tx.payrollFinanceSummary.findMany({ where: { tenantId: ctx.user.tenantId, month: input.month }, orderBy: { revision: 'desc' }, take: 100 }) })); },
  };
}
