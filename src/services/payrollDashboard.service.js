// src/services/payrollDashboard.service.js — "Payroll This Month" company dashboard.
//
// Read/aggregate helpers that back the Payroll-This-Month screen (KPIs, variance,
// per-department cost, blocking issues, the employees table, bulk payslip actions
// and CSV export). All reads are fail-closed tenant-scoped via scopedWhere /
// scopedEmployeeWhere (../lib/tenancy.js); the single multi-write path
// (bulkPayslipAction) runs through tenantTransaction so it passes FORCE-RLS.
// pino only — no console.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { scopedWhere, scopedEmployeeWhere } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { resolvePayDate } from "./payrollCalendar.service.js";

// ── small helpers ──────────────────────────────────────────────────────────

// %change of a vs prev; 0 when there's no comparable previous value.
function pctChange(current, previous) {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  if (!p) return 0;
  return ((c - p) / Math.abs(p)) * 100;
}

// Employee display name from the snake_case columns.
function employeeName(e) {
  if (!e) return null;
  const joined = [e.first_name, e.last_name].filter(Boolean).join(" ").trim();
  return e.employee_name || joined || null;
}

// PayslipStatus enum → FE display label.
const STATUS_DISPLAY = {
  DRAFT: "pending",
  APPROVED: "approved",
  HOLD: "hold",
  DISTRIBUTED: "disbursed",
  FINALIZED: "approved",
};
// FE display → enum (for the employees-list status filter).
const DISPLAY_TO_STATUS = {
  pending: "DRAFT",
  approved: "APPROVED",
  hold: "HOLD",
  disbursed: "DISTRIBUTED",
};

// Bucket a deduction into a coarse category by its type's code/name.
function deductionBucket(code, name) {
  const hay = `${code || ""} ${name || ""}`.toUpperCase();
  if (hay.includes("TAX")) return "Tax";
  if (hay.includes("LOAN") || hay.includes("ADVANCE")) return "Loans";
  return "Other";
}

const BASIC_CODES = new Set(["BASIC", "SALARY"]);

// ── current-run resolution ───────────────────────────────────────────────────

/**
 * resolveCurrentRun — the PayrollRun for `runId`, else the LATEST run (max
 * periodEnd) for the tenant. Returns null when the tenant has no runs.
 */
export async function resolveCurrentRun({ tenantId, runId } = {}) {
  if (runId !== undefined && runId !== null && `${runId}` !== "") {
    const id = Number(runId);
    if (Number.isInteger(id)) {
      return prisma.payrollRun.findFirst({ where: scopedWhere(tenantId, { id }) });
    }
  }
  // Prefer the latest run that actually HAS payslips — a stray empty/PROCESSING
  // run (created but never processed) shouldn't shadow the real current payroll.
  // Fall back to the latest run of any kind if none have payslips yet.
  const withPayslips = await prisma.payrollRun.findFirst({
    where: scopedWhere(tenantId, { payslips: { some: {} } }),
    orderBy: { periodEnd: "desc" },
  });
  if (withPayslips) return withPayslips;
  return prisma.payrollRun.findFirst({
    where: scopedWhere(tenantId, {}),
    orderBy: { periodEnd: "desc" },
  });
}

// The run whose periodEnd immediately precedes the given run (for MoM compares).
async function resolvePreviousRun({ tenantId, run }) {
  if (!run) return null;
  return prisma.payrollRun.findFirst({
    where: scopedWhere(tenantId, { periodEnd: { lt: run.periodEnd } }),
    orderBy: { periodEnd: "desc" },
  });
}

// Load the scoped payslips for a run (light — no relations).
function loadRunPayslips(tenantId, runId, select) {
  return prisma.payrollPayslip.findMany({
    where: scopedWhere(tenantId, { payrollRunId: runId }),
    ...(select ? { select } : {}),
  });
}

// ── KPI card ─────────────────────────────────────────────────────────────────

/**
 * getPayrollThisMonth — the top KPI card + deduction breakdown for the run.
 */
export async function getPayrollThisMonth({ tenantId, runId } = {}) {
  const run = await resolveCurrentRun({ tenantId, runId });
  if (!run) return null;

  const [prevRun, payslips, deductions, calendar] = await Promise.all([
    resolvePreviousRun({ tenantId, run }),
    loadRunPayslips(tenantId, run.id, { id: true, status: true }),
    prisma.payrollDeduction.findMany({
      where: scopedWhere(tenantId, { payslip: { payrollRunId: run.id } }),
      select: { amount: true, deductionType: { select: { code: true, name: true } } },
    }),
    prisma.payrollCalendar.findFirst({ where: scopedWhere(tenantId, {}) }),
  ]);

  const netPayroll = Number(run.totalNet) || 0;
  const netPayrollMoMPct = pctChange(run.totalNet, prevRun ? prevRun.totalNet : 0);

  const total = payslips.length;
  const nonDraft = payslips.filter((p) => p.status !== "DRAFT").length;
  let processedPct;
  if (run.status === "COMPLETED") processedPct = 100;
  else processedPct = total ? Math.round((nonDraft / total) * 100) : 0;

  const pendingApprovals = payslips.filter((p) => p.status === "DRAFT").length;

  // Deduction breakdown, grouped into buckets.
  const buckets = new Map();
  for (const d of deductions) {
    const cat = deductionBucket(d.deductionType?.code, d.deductionType?.name);
    buckets.set(cat, (buckets.get(cat) || 0) + (Number(d.amount) || 0));
  }
  const deductionBreakdown = Array.from(buckets.entries())
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);

  // Days until this month's pay date (>= 0).
  const daysUntilPayDate = computeDaysUntilPayDate({ run, calendar });

  return {
    run: {
      id: run.id,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
      status: run.status,
    },
    netPayroll,
    netPayrollMoMPct,
    employeeCount: run.employeeCount ?? total,
    processedPct,
    daysUntilPayDate,
    gross: Number(run.totalGross) || 0,
    totalDeductions: Number(run.totalDeductions) || 0,
    deductionBreakdown,
    pendingApprovals,
  };
}

// Resolve the month's pay date from the calendar rule and diff against today.
function computeDaysUntilPayDate({ run, calendar }) {
  // Use the run's period-end month as the target month.
  const ref = new Date(run.periodEnd);
  const year = ref.getUTCFullYear();
  const month = ref.getUTCMonth() + 1; // 1-based
  let payDateIso;
  try {
    payDateIso = resolvePayDate({ year, month, calendar: calendar || undefined });
  } catch {
    return 0;
  }
  const pay = new Date(`${payDateIso}T00:00:00.000Z`);
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const diff = Math.ceil((pay.getTime() - today.getTime()) / 86400000);
  return diff > 0 ? diff : 0;
}

// ── variance vs last month ───────────────────────────────────────────────────

/**
 * getVarianceVsLastMonth — headcount/pay movements over the run's period.
 */
export async function getVarianceVsLastMonth({ tenantId, runId } = {}) {
  const run = await resolveCurrentRun({ tenantId, runId });
  if (!run) {
    return {
      newHires: { count: 0 },
      exits: { count: 0 },
      increments: { count: 0 },
      bonuses: { count: 0, amount: 0 },
    };
  }
  const period = { gte: run.periodStart, lte: run.periodEnd };

  const [newHires, exits, incrementEvents, incrementTerms, bonusEarnings] = await Promise.all([
    prisma.employee.count({
      where: scopedEmployeeWhere(tenantId, { joining_date: period }),
    }),
    prisma.employeeLifecycleEvent.count({
      where: scopedWhere(tenantId, {
        eventType: { in: ["TERMINATED", "RESIGNED"] },
        effectiveDate: period,
      }),
    }),
    prisma.employeeLifecycleEvent.findMany({
      where: scopedWhere(tenantId, { eventType: "SALARY_CHANGED", effectiveDate: period }),
      select: { employeeId: true },
    }),
    prisma.employmentTerms.findMany({
      where: scopedWhere(tenantId, { effectiveFrom: period }),
      select: { employeeId: true },
    }),
    prisma.payrollEarning.findMany({
      where: scopedWhere(tenantId, {
        payslip: { payrollRunId: run.id },
        earningType: { code: { contains: "BONUS", mode: "insensitive" } },
      }),
      select: { amount: true },
    }),
  ]);

  // Distinct employees with an increment (either a SALARY_CHANGED event or new terms).
  const incEmployees = new Set();
  for (const r of incrementEvents) incEmployees.add(r.employeeId);
  for (const r of incrementTerms) incEmployees.add(r.employeeId);

  const bonusAmount = bonusEarnings.reduce((s, e) => s + (Number(e.amount) || 0), 0);

  return {
    newHires: { count: newHires },
    exits: { count: exits },
    increments: { count: incEmployees.size },
    bonuses: { count: bonusEarnings.length, amount: bonusAmount },
  };
}

// ── per-department cost ──────────────────────────────────────────────────────

/**
 * getDeptPayrollCost — the run's net cost grouped by employee business unit,
 * sorted desc by amount.
 */
export async function getDeptPayrollCost({ tenantId, runId } = {}) {
  const run = await resolveCurrentRun({ tenantId, runId });
  if (!run) return [];

  const payslips = await loadRunPayslips(tenantId, run.id, {
    netAmount: true,
    employeeId: true,
  });
  if (!payslips.length) return [];

  const empIds = [...new Set(payslips.map((p) => p.employeeId))];
  const employees = await prisma.employee.findMany({
    where: scopedEmployeeWhere(tenantId, { id: { in: empIds } }),
    select: { id: true, businessUnitId: true },
  });
  const empBU = new Map(employees.map((e) => [e.id, e.businessUnitId ?? null]));

  const buIds = [...new Set(employees.map((e) => e.businessUnitId).filter((x) => x != null))];
  const businessUnits = buIds.length
    ? await prisma.businessUnit.findMany({
        where: scopedWhere(tenantId, { id: { in: buIds } }),
        select: { id: true, name: true },
      })
    : [];
  const buName = new Map(businessUnits.map((b) => [b.id, b.name]));

  // Group by business unit.
  const groups = new Map(); // buId(or "none") → { departmentId, department, amount, employeeCount, emps:Set }
  for (const p of payslips) {
    const buId = empBU.get(p.employeeId) ?? null;
    const key = buId == null ? "none" : buId;
    if (!groups.has(key)) {
      groups.set(key, {
        departmentId: buId,
        department: buId == null ? "Unassigned" : buName.get(buId) || `BU ${buId}`,
        amount: 0,
        emps: new Set(),
      });
    }
    const g = groups.get(key);
    g.amount += Number(p.netAmount) || 0;
    g.emps.add(p.employeeId);
  }

  return Array.from(groups.values())
    .map((g) => ({
      departmentId: g.departmentId,
      department: g.department,
      amount: g.amount,
      employeeCount: g.emps.size,
    }))
    .sort((a, b) => b.amount - a.amount);
}

// ── blocking issues ──────────────────────────────────────────────────────────

/**
 * getBlockingIssues — payroll-readiness blockers for the run. Only buckets with
 * count > 0 are returned.
 */
export async function getBlockingIssues({ tenantId, runId } = {}) {
  const run = await resolveCurrentRun({ tenantId, runId });
  if (!run) return [];

  const payslips = await loadRunPayslips(tenantId, run.id, { employeeId: true });
  const empIds = [...new Set(payslips.map((p) => p.employeeId))];

  const period = { gte: run.periodStart, lte: run.periodEnd };

  const [bankRows, negLeaveRows, otPending, activeTaxRate, termsRows] = await Promise.all([
    empIds.length
      ? prisma.bankDetail.findMany({
          where: scopedWhere(tenantId, { employeeId: { in: empIds }, isPrimary: true }),
          select: { employeeId: true },
        })
      : Promise.resolve([]),
    prisma.leaveBalance.findMany({
      where: scopedWhere(tenantId, {
        balance: { lt: 0 },
        ...(empIds.length ? { employeeId: { in: empIds } } : {}),
      }),
      select: { employeeId: true },
    }),
    prisma.overtimeRequest.count({
      where: scopedWhere(tenantId, {
        status: "PENDING",
        date: period,
        ...(empIds.length ? { employeeId: { in: empIds } } : {}),
      }),
    }),
    prisma.taxRate.findFirst({
      where: scopedWhere(tenantId, {
        status: "ACTIVE",
        countryCode: run.countryCode,
        effectiveFrom: { lte: run.periodEnd },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: run.periodStart } }],
      }),
      select: { id: true },
    }),
    empIds.length
      ? prisma.employmentTerms.findMany({
          where: scopedWhere(tenantId, {
            employeeId: { in: empIds },
            effectiveFrom: { lte: run.periodEnd },
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: run.periodStart } }],
          }),
          select: { employeeId: true },
        })
      : Promise.resolve([]),
  ]);

  const withBank = new Set(bankRows.map((r) => r.employeeId));
  const missingBank = empIds.filter((id) => !withBank.has(id)).length;

  const negLeave = new Set(negLeaveRows.map((r) => r.employeeId)).size;

  const withTerms = new Set(termsRows.map((r) => r.employeeId));
  const termsExpired = empIds.filter((id) => !withTerms.has(id)).length;

  const issues = [];
  if (missingBank > 0) {
    issues.push({
      type: "missingBankDetails",
      severity: "high",
      message: `${missingBank} employee(s) have no primary bank details`,
      count: missingBank,
    });
  }
  if (negLeave > 0) {
    issues.push({
      type: "negativeLeaveBalance",
      severity: "medium",
      message: `${negLeave} employee(s) have a negative leave balance`,
      count: negLeave,
    });
  }
  if (otPending > 0) {
    issues.push({
      type: "otPending",
      severity: "medium",
      message: `${otPending} overtime request(s) pending approval in this period`,
      count: otPending,
    });
  }
  if (!activeTaxRate) {
    issues.push({
      type: "taxSlabNotApplied",
      severity: "high",
      message: `No active tax slab is effective for ${run.countryCode} in this period`,
      count: 1,
    });
  }
  if (termsExpired > 0) {
    issues.push({
      type: "salaryTermsExpired",
      severity: "high",
      message: `${termsExpired} employee(s) have no salary terms effective for this period`,
      count: termsExpired,
    });
  }
  return issues;
}

// ── employees table ──────────────────────────────────────────────────────────

// basic = the BASIC/SALARY earning, else Number(baseSalary) fallback, else 0.
function computeBasic(earnings, terms) {
  const basicEarning = earnings.find((e) => BASIC_CODES.has((e.earningType?.code || "").toUpperCase()));
  if (basicEarning) return Number(basicEarning.amount) || 0;
  if (terms && terms.baseSalary != null) return Number(terms.baseSalary) || 0;
  return 0;
}

/**
 * listPayrollEmployees — the paginated employees table for a run.
 */
export async function listPayrollEmployees({
  tenantId,
  runId,
  q,
  department,
  status,
  sortBy,
  sortDir,
  page = 1,
  pageSize = 25,
} = {}) {
  const run = await resolveCurrentRun({ tenantId, runId });
  if (!run) return { items: [], total: 0, page: Number(page) || 1, pageSize: Number(pageSize) || 25 };

  const pageN = Math.max(1, Number(page) || 1);
  const sizeN = Math.max(1, Number(pageSize) || 25);
  const dir = String(sortDir || "asc").toLowerCase() === "desc" ? "desc" : "asc";

  // Load ALL of the run's payslips with earnings (the row set is one-per-employee).
  const payslips = await prisma.payrollPayslip.findMany({
    where: scopedWhere(tenantId, {
      payrollRunId: run.id,
      ...(status && DISPLAY_TO_STATUS[status] ? { status: DISPLAY_TO_STATUS[status] } : {}),
    }),
    select: {
      id: true,
      employeeId: true,
      netAmount: true,
      totalDeductions: true,
      status: true,
      earnings: {
        select: { amount: true, earningType: { select: { code: true } } },
      },
    },
  });
  if (!payslips.length) return { items: [], total: 0, page: pageN, pageSize: sizeN };

  const empIds = [...new Set(payslips.map((p) => p.employeeId))];

  // Batch-load employees (name / grade / dept), previous-run payslips (variance),
  // and the effective employment terms (basic fallback).
  const [employees, prevPayslips, terms] = await Promise.all([
    prisma.employee.findMany({
      where: scopedEmployeeWhere(tenantId, { id: { in: empIds } }),
      select: {
        id: true,
        first_name: true,
        last_name: true,
        employee_name: true,
        photo_url: true,
        businessUnitId: true,
        gradeLevelId: true,
        businessUnit: { select: { name: true } },
        gradeLevel: { select: { name: true } },
      },
    }),
    prisma.payrollPayslip.findMany({
      where: scopedWhere(tenantId, {
        employeeId: { in: empIds },
        payrollRun: { periodEnd: { lt: run.periodEnd } },
      }),
      select: { employeeId: true, netAmount: true, payrollRun: { select: { periodEnd: true } } },
      orderBy: { payrollRun: { periodEnd: "desc" } },
    }),
    prisma.employmentTerms.findMany({
      where: scopedWhere(tenantId, {
        employeeId: { in: empIds },
        effectiveFrom: { lte: run.periodEnd },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: run.periodStart } }],
      }),
      select: { employeeId: true, baseSalary: true, effectiveFrom: true },
      orderBy: { effectiveFrom: "desc" },
    }),
  ]);

  const empMap = new Map(employees.map((e) => [e.id, e]));

  // Previous-run net per employee (the most recent prior run — first seen wins).
  const prevNet = new Map();
  for (const p of prevPayslips) {
    if (!prevNet.has(p.employeeId)) prevNet.set(p.employeeId, Number(p.netAmount) || 0);
  }
  // Effective terms per employee (most recent effectiveFrom — first seen wins).
  const termsMap = new Map();
  for (const t of terms) {
    if (!termsMap.has(t.employeeId)) termsMap.set(t.employeeId, t);
  }

  let rows = payslips.map((p) => {
    const emp = empMap.get(p.employeeId);
    const earnings = p.earnings || [];
    const basic = computeBasic(earnings, termsMap.get(p.employeeId));
    const earningsTotal = earnings.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const allowances = earningsTotal - basic;
    const net = Number(p.netAmount) || 0;
    return {
      payslipId: p.id,
      employee: {
        id: p.employeeId,
        name: employeeName(emp),
        avatar: emp?.photo_url ?? null,
        department: emp?.businessUnit?.name ?? null,
        businessUnitId: emp?.businessUnitId ?? null,
      },
      payGrade: emp?.gradeLevel?.name ?? null,
      basic,
      allowances,
      deductions: Number(p.totalDeductions) || 0,
      net,
      variancePct: pctChange(net, prevNet.get(p.employeeId)),
      status: STATUS_DISPLAY[p.status] || String(p.status).toLowerCase(),
      _name: (employeeName(emp) || "").toLowerCase(),
      _statusEnum: p.status,
    };
  });

  // Filters: q (name), department (businessUnitId).
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((r) => r._name.includes(needle));
  }
  if (department !== undefined && department !== null && `${department}` !== "") {
    const buId = Number(department);
    rows = rows.filter((r) => r.employee.businessUnitId === buId);
  }

  // Sort by name / net / status.
  const key = String(sortBy || "name").toLowerCase();
  rows.sort((a, b) => {
    let cmp;
    if (key === "net") cmp = a.net - b.net;
    else if (key === "status") cmp = String(a._statusEnum).localeCompare(String(b._statusEnum));
    else cmp = a._name.localeCompare(b._name);
    return dir === "desc" ? -cmp : cmp;
  });

  const total = rows.length;
  const start = (pageN - 1) * sizeN;
  const items = rows.slice(start, start + sizeN).map((r) => {
    // Strip the internal sort/filter helpers and the businessUnitId scoping
    // key from the public row shape.
    const { _name, _statusEnum, employee, ...rest } = r;
    const { businessUnitId, ...pubEmployee } = employee;
    return { ...rest, employee: pubEmployee };
  });

  return { items, total, page: pageN, pageSize: sizeN };
}

// ── bulk payslip actions ─────────────────────────────────────────────────────

const BULK_ACTIONS = new Set(["approve", "hold", "disburse"]);

/**
 * bulkPayslipAction — approve / hold / disburse a set of payslips in ONE tenant
 * transaction. Only tenant-scoped payslips are touched. Returns { updated }.
 */
export async function bulkPayslipAction({ tenantId, payslipIds, action, reason, actorId } = {}) {
  if (!BULK_ACTIONS.has(action)) {
    throw Object.assign(new Error(`Unknown bulk action: ${action}`), { status: 400 });
  }
  const ids = (Array.isArray(payslipIds) ? payslipIds : [])
    .map((x) => Number(x))
    .filter((x) => Number.isInteger(x));
  if (!ids.length) return { updated: 0 };

  const now = new Date();
  let data;
  if (action === "approve") {
    data = {
      status: "APPROVED",
      approvedById: actorId != null ? Number(actorId) : null,
      approvedAt: now,
    };
  } else if (action === "hold") {
    data = { status: "HOLD", holdReason: reason ?? null };
  } else {
    data = { status: "DISTRIBUTED", distributedAt: now };
  }

  const result = await tenantTransaction(prisma, async (tx) => {
    const res = await tx.payrollPayslip.updateMany({
      where: scopedWhere(tenantId, { id: { in: ids } }),
      data,
    });
    return res.count;
  }, { tenantId });

  logger.info({ tenantId, action, requested: ids.length, updated: result }, "payroll bulk payslip action");
  return { updated: result };
}

// ── CSV export ───────────────────────────────────────────────────────────────

const CSV_HEADERS = [
  "Employee",
  "Department",
  "Pay Grade",
  "Basic",
  "Allowances",
  "Deductions",
  "Net",
  "Status",
];

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * exportPayrollCsv — the employees table for a run as a CSV artifact.
 */
export async function exportPayrollCsv({ tenantId, runId } = {}) {
  const run = await resolveCurrentRun({ tenantId, runId });
  const { items } = run
    ? await listPayrollEmployees({ tenantId, runId: run.id, pageSize: 100000, page: 1 })
    : { items: [] };

  const lines = [CSV_HEADERS.map(csvCell).join(",")];
  for (const row of items) {
    lines.push(
      [
        row.employee?.name,
        row.employee?.department,
        row.payGrade,
        row.basic,
        row.allowances,
        row.deductions,
        row.net,
        row.status,
      ]
        .map(csvCell)
        .join(",")
    );
  }
  const content = lines.join("\r\n");
  const filename = `payroll-this-month${run ? `-run-${run.id}` : ""}.csv`;
  return { format: "csv", filename, content };
}
