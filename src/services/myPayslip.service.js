// src/services/myPayslip.service.js — My Payslip (employee self-service).
//
// Read/query surface for the employee-facing "My Payslip" screen: the employee
// views their OWN payslip (self-scoped on employeeId), the earning/deduction
// pie split, a 6-month net-pay trend, their past-slip list, and can raise a
// question against a slip (which fans out an hr.payslip.question_raised.v1
// domain event via the transactional outbox).
//
// TENANCY: every read is folded through scopedWhere(tenantId, where) — the
// FORCE-RLS extension additionally sets app.tenant_id, but the app-level scope
// is the primary fence (fail-closed on a null/absent tenant). The self-scope
// (employeeId) is applied on TOP so an authenticated employee can only ever
// reach their own rows. questionPayslip runs inside a tenantTransaction so the
// PayslipQuestion write + outbox enqueue share one RLS-bound connection.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { scopedWhere } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { payslipQuestionRaisedEvent } from "./hrEvents.js";

const DEFAULT_TOTAL_WORKING_DAYS = 26;

// Statuses considered "official" for YTD aggregation. We prefer FINALIZED /
// DISTRIBUTED slips, but fall back to ALL of the employee's slips when the year
// has no finalized/distributed slip yet (e.g. mid-run previews).
const YTD_OFFICIAL_STATUSES = ["FINALIZED", "DISTRIBUTED"];

function notFound(message) {
  return Object.assign(new Error(message), { status: 404, code: "HR-4004" });
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

function yearBounds(date) {
  const d = new Date(date);
  const year = d.getUTCFullYear();
  return {
    year,
    start: new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0)),
    // exclusive upper bound = Jan 1 of the next year
    end: new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0)),
  };
}

const PAYSLIP_INCLUDE = {
  payrollRun: { select: { id: true, periodStart: true, periodEnd: true } },
  earnings: {
    include: { earningType: { select: { code: true, name: true, isTaxable: true } } },
  },
  deductions: {
    include: { deductionType: { select: { code: true, name: true } } },
  },
};

// Resolve the target payslip: explicit payslipId (self-scoped) else the LATEST
// slip by payrollRun.periodEnd for the employee. Returns null if none.
async function resolvePayslip({ tenantId, employeeId, payslipId }) {
  const where = scopedWhere(tenantId, { employeeId: Number(employeeId) });
  if (payslipId != null) where.id = Number(payslipId);
  return prisma.payrollPayslip.findFirst({
    where,
    include: PAYSLIP_INCLUDE,
    orderBy: { payrollRun: { periodEnd: "desc" } },
  });
}

function isTaxDeduction(d) {
  const code = d?.deductionType?.code || "";
  return String(code).toUpperCase().includes("TAX");
}

async function computeYtd({ tenantId, employeeId, periodEnd }) {
  const { start, end } = yearBounds(periodEnd);
  const baseWhere = scopedWhere(tenantId, {
    employeeId: Number(employeeId),
    payrollRun: { periodEnd: { gte: start, lt: end } },
  });

  // Prefer official (FINALIZED/DISTRIBUTED) slips; fall back to all when the
  // calendar year has no official slip yet.
  const officialWhere = { ...baseWhere, status: { in: YTD_OFFICIAL_STATUSES } };
  let slips = await prisma.payrollPayslip.findMany({
    where: officialWhere,
    include: {
      deductions: { include: { deductionType: { select: { code: true } } } },
    },
  });
  if (slips.length === 0) {
    slips = await prisma.payrollPayslip.findMany({
      where: baseWhere,
      include: {
        deductions: { include: { deductionType: { select: { code: true } } } },
      },
    });
  }

  let gross = 0;
  let net = 0;
  let tax = 0;
  for (const s of slips) {
    gross += Number(s.grossAmount) || 0;
    net += Number(s.netAmount) || 0;
    for (const d of s.deductions || []) {
      if (isTaxDeduction(d)) tax += Number(d.amount) || 0;
    }
  }
  return { gross, tax, net };
}

// Leave days taken by the employee that OVERLAP the payslip period (APPROVED).
async function computeLeaveTaken({ tenantId, employeeId, periodStart, periodEnd }) {
  const rows = await prisma.leaveRequest.findMany({
    where: scopedWhere(tenantId, {
      employeeId: Number(employeeId),
      status: "APPROVED",
      // overlap: startDate <= periodEnd AND endDate >= periodStart
      startDate: { lte: periodEnd },
      endDate: { gte: periodStart },
    }),
    select: { totalDays: true },
  });
  return rows.reduce((sum, r) => sum + (Number(r.totalDays) || 0), 0);
}

// Approved overtime hours with a date inside the payslip period.
async function computeOvertimeHours({ tenantId, employeeId, periodStart, periodEnd }) {
  const rows = await prisma.overtimeRequest.findMany({
    where: scopedWhere(tenantId, {
      employeeId: Number(employeeId),
      status: "APPROVED",
      date: { gte: periodStart, lte: periodEnd },
    }),
    select: { hours: true },
  });
  return rows.reduce((sum, r) => sum + (Number(r.hours) || 0), 0);
}

/**
 * The employee's payslip (explicit payslipId, else the latest by period end),
 * enriched with YTD figures + working-day / leave / overtime accounting.
 */
export async function getMyPayslip({ tenantId, employeeId, payslipId }) {
  const slip = await resolvePayslip({ tenantId, employeeId, payslipId });
  if (!slip) throw notFound("No payslip found for this employee");

  const periodStart = slip.payrollRun?.periodStart ?? null;
  const periodEnd = slip.payrollRun?.periodEnd ?? null;

  const [ytd, leaveTaken, overtimeHours] = await Promise.all([
    computeYtd({ tenantId, employeeId, periodEnd: periodEnd ?? slip.created_at }),
    periodStart && periodEnd
      ? computeLeaveTaken({ tenantId, employeeId, periodStart, periodEnd })
      : Promise.resolve(0),
    periodStart && periodEnd
      ? computeOvertimeHours({ tenantId, employeeId, periodStart, periodEnd })
      : Promise.resolve(0),
  ]);

  const totalWorkingDays = DEFAULT_TOTAL_WORKING_DAYS;
  const daysPaid = Math.max(0, totalWorkingDays - leaveTaken);
  const workingDays = daysPaid;

  return {
    payslipId: slip.id,
    period: { from: periodStart, to: periodEnd },
    status: slip.status,
    netPay: Number(slip.netAmount) || 0,
    receivedOn: slip.distributedAt ?? null,
    gross: Number(slip.grossAmount) || 0,
    totalDeductions: Number(slip.totalDeductions) || 0,
    ytd: { gross: ytd.gross, tax: ytd.tax, net: ytd.net },
    workingDays,
    totalWorkingDays,
    daysPaid,
    leaveTaken,
    overtimeHours,
    earnings: (slip.earnings || []).map((e) => ({
      code: e.earningType?.code ?? null,
      name: e.earningType?.name ?? null,
      amount: Number(e.amount) || 0,
      taxable: e.earningType?.isTaxable ?? null,
    })),
    deductions: (slip.deductions || []).map((d) => ({
      code: d.deductionType?.code ?? null,
      name: d.deductionType?.name ?? null,
      amount: Number(d.amount) || 0,
    })),
  };
}

/**
 * Pie-chart split for the payslip: earnings as a pct of gross, deductions as a
 * pct of total deductions (1dp).
 */
export async function getPayslipDistribution({ tenantId, employeeId, payslipId }) {
  const slip = await resolvePayslip({ tenantId, employeeId, payslipId });
  if (!slip) throw notFound("No payslip found for this employee");

  const gross = Number(slip.grossAmount) || 0;
  const totalDeductions = Number(slip.totalDeductions) || 0;

  const earnings = (slip.earnings || []).map((e) => {
    const amount = Number(e.amount) || 0;
    return {
      name: e.earningType?.name ?? null,
      amount,
      pct: gross > 0 ? round1((amount / gross) * 100) : 0,
    };
  });
  const deductions = (slip.deductions || []).map((d) => {
    const amount = Number(d.amount) || 0;
    return {
      name: d.deductionType?.name ?? null,
      amount,
      pct: totalDeductions > 0 ? round1((amount / totalDeductions) * 100) : 0,
    };
  });

  return { earnings, deductions };
}

/**
 * Net paid for the last 6 months keyed by payrollRun.periodEnd month, 0-filled
 * for months with no payslip. Newest month LAST (chronological ascending).
 */
export async function getEarningTrend6mo({ tenantId, employeeId }) {
  const now = new Date();
  // First day (UTC) of the month 5 months ago → 6-month inclusive window.
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1, 0, 0, 0, 0));

  const slips = await prisma.payrollPayslip.findMany({
    where: scopedWhere(tenantId, {
      employeeId: Number(employeeId),
      payrollRun: { periodEnd: { gte: windowStart } },
    }),
    include: { payrollRun: { select: { periodEnd: true } } },
  });

  // Seed the 6 month buckets (YYYY-MM) with 0.
  const buckets = new Map();
  const order = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5 + i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    buckets.set(key, 0);
    order.push(key);
  }

  for (const s of slips) {
    const pe = s.payrollRun?.periodEnd;
    if (!pe) continue;
    const d = new Date(pe);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (buckets.has(key)) buckets.set(key, buckets.get(key) + (Number(s.netAmount) || 0));
  }

  return { months: order.map((month) => ({ month, amount: buckets.get(month) })) };
}

/**
 * Paginated list of the employee's past payslip references (newest first).
 */
export async function listMyPayslips({ tenantId, employeeId, page = 1, pageSize = 20 }) {
  const take = Math.max(1, Number(pageSize) || 20);
  const currentPage = Math.max(1, Number(page) || 1);
  const skip = (currentPage - 1) * take;

  const where = scopedWhere(tenantId, { employeeId: Number(employeeId) });

  const [rows, total] = await Promise.all([
    prisma.payrollPayslip.findMany({
      where,
      include: { payrollRun: { select: { periodStart: true, periodEnd: true } } },
      orderBy: { payrollRun: { periodEnd: "desc" } },
      skip,
      take,
    }),
    prisma.payrollPayslip.count({ where }),
  ]);

  const items = rows.map((s) => ({
    id: s.id,
    period: { from: s.payrollRun?.periodStart ?? null, to: s.payrollRun?.periodEnd ?? null },
    net: Number(s.netAmount) || 0,
    status: s.status,
    receivedOn: s.distributedAt ?? null,
  }));

  return { items, total, page: currentPage, pageSize: take };
}

/**
 * Raise a question against the employee's OWN payslip. Verifies ownership
 * (scoped findFirst; 404), creates a PayslipQuestion (OPEN), and enqueues the
 * hr.payslip.question_raised.v1 outbox event — all inside one RLS-bound tx.
 */
export async function questionPayslip({ tenantId, employeeId, payslipId, question, ctx = {} }) {
  const empId = Number(employeeId);
  const slipId = Number(payslipId);

  return tenantTransaction(prisma, async (tx) => {
    const slip = await tx.payrollPayslip.findFirst({
      where: scopedWhere(tenantId, { id: slipId, employeeId: empId }),
      select: { id: true },
    });
    if (!slip) throw notFound("No payslip found for this employee");

    const row = await tx.payslipQuestion.create({
      data: {
        payslipId: slipId,
        employeeId: empId,
        question,
        status: "OPEN",
        tenantId: tenantId ?? null,
      },
    });

    const event = payslipQuestionRaisedEvent(row, ctx);
    if (event) await enqueueHrDomainEvent(tx, event);
    else logger.warn({ payslipQuestionId: row.id }, "payslip question raised event skipped (no tenant)");

    return row;
  }, { tenantId });
}
