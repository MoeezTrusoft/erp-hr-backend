import * as money from "../lib/money.js";
import { ruleDeductions } from "../lib/attendanceAnomalyRules.js";
import { lockAttendancePeriod } from "./attendancePeriod.service.js";

export const RULE_DEDUCTION_CODE = "ATTENDANCE_RULES_V2";
export const ADJUSTMENT_CODE = "ATTENDANCE_RULES_ADJUSTMENT";
export const LEGACY_ATTENDANCE_CODES = [
  "ATTENDANCE_DEDUCTION",
  "ABSENCE_RECOVERY",
  "MANAGEMENT_ATTENDANCE_DEDUCTION",
];
export function priceRuleDays(days, basisMinor, periodDays, currency = "PKR") {
  if (
    !Number.isFinite(days) ||
    days < 0 ||
    !Number.isInteger(days * 2) ||
    !Number.isInteger(periodDays) ||
    periodDays <= 0 ||
    BigInt(basisMinor) < 0n
  )
    throw new Error("Invalid attendance pricing basis");
  const minor =
    (BigInt(basisMinor) * BigInt(Math.round(days * 2))) /
    (2n * BigInt(periodDays));
  // Match the existing payroll line rounding (whole currency unit).
  const unit = 10n ** BigInt(money.CURRENCY_EXPONENT[currency] ?? 2);
  return ((minor + unit / 2n) / unit) * unit;
}
export async function releaseFailedCarry(db, { tenantId, employeeId }) {
  const failed = await db.payrollRun.findMany({
    where: { tenantId, status: { in: ["CANCELLED", "FAILED"] } },
    select: { id: true },
  });
  if (!failed.length) return;
  const slips = await db.payrollPayslip.findMany({
    where: {
      tenantId,
      employeeId,
      payrollRunId: { in: failed.map((r) => r.id) },
      status: { not: "DISTRIBUTED" },
      distributedAt: null,
    },
    select: { id: true },
  });
  if (!slips.length) return;
  const released = await db.attendancePayrollAdjustment.findMany({
    where: {
      tenantId,
      employeeId,
      appliedPayslipId: { in: slips.map((s) => s.id) },
    },
  });
  if (!released.length) return;
  await db.attendancePayrollAdjustment.updateMany({
    where: { tenantId, id: { in: released.map((a) => a.id) } },
    data: { appliedPayslipId: null },
  });
  await db.attendanceRuleAudit.create({
    data: {
      tenantId,
      employeeId,
      action: "CARRY_RELEASED_FROM_FAILED_RUN",
      actorId: "attendance-rules",
      data: { adjustments: JSON.parse(JSON.stringify(released)) },
    },
  });
}
export async function applyCarryToNextPayroll(
  db,
  { tenantId, employeeId, after, currency, actorId },
) {
  await releaseFailedCarry(db, { tenantId, employeeId });
  const runs = await db.payrollRun.findMany({
    where: {
      tenantId,
      currencyCode: currency,
      periodStart: { gt: after },
      status: { notIn: ["CANCELLED", "FAILED"] },
    },
    orderBy: [{ periodStart: "asc" }, { id: "asc" }],
  });
  for (const run of runs) {
    const slip = await db.payrollPayslip.findFirst({
      where: { tenantId, payrollRunId: run.id, employeeId },
    });
    if (slip?.status === "DISTRIBUTED" || slip?.distributedAt) continue;
    if (run.status === "PROCESSING")
      throw Object.assign(
        new Error(
          "The next payroll is processing; retry the attendance decision",
        ),
        { status: 409 },
      );
    // A run without this employee's slip will claim the adjustments when processed.
    if (!slip) return;
    const adjustments = await db.attendancePayrollAdjustment.findMany({
      where: {
        tenantId,
        employeeId,
        currencyCode: currency,
        appliedPayslipId: null,
        sourcePeriodEnd: { lt: run.periodStart },
      },
    });
    if (!adjustments.length) return;
    let type = await db.payrollDeductionType.findFirst({
      where: { tenantId, code: ADJUSTMENT_CODE },
    });
    if (!type)
      type = await db.payrollDeductionType.create({
        data: {
          tenantId,
          code: ADJUSTMENT_CODE,
          name: "Prior-period attendance adjustment",
        },
      });
    let delta = 0n;
    for (const a of adjustments) {
      delta += BigInt(a.amountMinor);
      await db.payrollDeduction.create({
        data: {
          tenantId,
          payslipId: slip.id,
          deductionTypeId: type.id,
          amount: money.minorToDecimal(BigInt(a.amountMinor), currency),
          description: `Prior-period attendance adjustment #${a.id} from payslip ${a.sourcePayslipId}`,
        },
      });
      await db.attendancePayrollAdjustment.update({
        where: { id: a.id, tenantId, appliedPayslipId: null },
        data: { appliedPayslipId: slip.id },
      });
    }
    await db.payrollPayslip.update({
      where: { id: slip.id, tenantId },
      data: {
        totalDeductions: money.minorToDecimal(
          money.decimalToMinor(slip.totalDeductions, currency) + delta,
          currency,
        ),
        netAmount: money.minorToDecimal(
          money.decimalToMinor(slip.netAmount, currency) - delta,
          currency,
        ),
      },
    });
    await db.payrollRun.update({
      where: { id: run.id, tenantId },
      data: {
        totalDeductions: money.minorToDecimal(
          money.decimalToMinor(run.totalDeductions, currency) + delta,
          currency,
        ),
        totalNet: money.minorToDecimal(
          money.decimalToMinor(run.totalNet, currency) - delta,
          currency,
        ),
      },
    });
    await db.payrollAuditLog.create({
      data: {
        tenantId,
        employeeId,
        payslipId: slip.id,
        payrollRunId: run.id,
        action: "ATTENDANCE_CARRY_APPLIED",
        details: `Prior-period attendance adjustments applied by ${actorId}`,
        newValues: {
          adjustmentIds: adjustments.map((a) => a.id),
          amountMinor: String(delta),
        },
      },
    });
    return;
  }
}
export async function reconcileRulePayroll(
  db,
  { tenantId, employeeId, date, actorId = "attendance-rules" },
) {
  await lockAttendancePeriod(db, tenantId, true);
  const runs = await db.payrollRun.findMany({
    where: {
      tenantId,
      periodStart: { lte: date },
      periodEnd: { gte: date },
      status: { notIn: ["CANCELLED", "FAILED"] },
    },
  });
  for (const run of runs) {
    if (run.status === "PROCESSING")
      throw Object.assign(
        new Error("Payroll is processing; retry the attendance decision"),
        { status: 409 },
      );
    const slip = await db.payrollPayslip.findFirst({
      where: { tenantId, payrollRunId: run.id, employeeId },
      include: { deductions: { include: { deductionType: true } } },
    });
    if (!slip) continue;
    if (slip.attendanceBasisMinor == null || !slip.attendancePeriodDays) {
      throw Object.assign(
        new Error(
          "This historical payslip needs an audited attendance pricing baseline before recalculation",
        ),
        { status: 409 },
      );
    }
    const cases = await db.attendanceAnomaly.findMany({
      where: {
        tenantId,
        employeeId,
        date: { gte: run.periodStart, lte: run.periodEnd },
        rulesVersion: 2,
      },
    });
    const assessment = ruleDeductions(cases, {
      from: run.periodStart,
      to: run.periodEnd,
    });
    const desired = priceRuleDays(
      assessment.days,
      slip.attendanceBasisMinor,
      slip.attendancePeriodDays,
      run.currencyCode,
    );
    const adoption = await db.payrollAuditLog.findFirst({
      where: {
        tenantId,
        payslipId: slip.id,
        action: "ATTENDANCE_PRICING_ADOPTED",
      },
      orderBy: { id: "desc" },
    });
    const originalLines = slip.deductions.filter(
      (d) =>
        d.deductionType?.code === RULE_DEDUCTION_CODE ||
        adoption?.newValues?.deductionIds?.includes(d.id),
    );
    const original = originalLines.reduce(
      (n, d) => n + money.decimalToMinor(d.amount, run.currencyCode),
      0n,
    );
    const originalDays = originalLines.reduce(
      (sum, line) =>
        sum +
        Number(String(line.description || "").match(/([\d.]+) day/)?.[1] || 0),
      0,
    );
    const prior = await db.attendancePayrollAdjustment.findMany({
      where: { tenantId, sourcePayslipId: slip.id },
      orderBy: { revision: "desc" },
    });
    const accounted =
      original + prior.reduce((n, a) => n + BigInt(a.amountMinor), 0n);
    if (slip.status === "DISTRIBUTED" || slip.distributedAt) {
      const delta = desired - accounted;
      if (delta === 0n) continue;
      const adjustment = await db.attendancePayrollAdjustment.create({
        data: {
          tenantId,
          employeeId,
          sourcePayslipId: slip.id,
          sourcePeriodEnd: run.periodEnd,
          currencyCode: run.currencyCode,
          amountMinor: String(delta),
          revision: (prior[0]?.revision || 0) + 1,
        },
      });
      await db.attendanceRuleAudit.create({
        data: {
          tenantId,
          employeeId,
          action: "PAYROLL_CARRY_FORWARD",
          actorId: String(actorId),
          data: {
            sourcePayslipId: slip.id,
            adjustmentId: adjustment.id,
            amountMinor: String(delta),
            assessment,
          },
        },
      });
      await applyCarryToNextPayroll(db, {
        tenantId,
        employeeId,
        after: run.periodEnd,
        currency: run.currencyCode,
        actorId,
      });
      continue;
    }
    const delta = desired - original;
    if (delta === 0n && originalDays === assessment.days) continue;
    let type = await db.payrollDeductionType.findFirst({
      where: { tenantId, code: RULE_DEDUCTION_CODE },
    });
    if (!type)
      type = await db.payrollDeductionType.create({
        data: {
          tenantId,
          code: RULE_DEDUCTION_CODE,
          name: "Management-disapproved attendance",
        },
      });
    await db.payrollDeduction.deleteMany({
      where: {
        tenantId,
        payslipId: slip.id,
        OR: [
          { deductionTypeId: type.id },
          { id: { in: adoption?.newValues?.deductionIds || [] } },
        ],
      },
    });
    await db.payrollDeduction.create({
      data: {
        tenantId,
        payslipId: slip.id,
        deductionTypeId: type.id,
        amount: money.minorToDecimal(desired, run.currencyCode),
        description: `Management-disapproved attendance: ${assessment.days} day(s)`,
      },
    });
    const total = money.minorToDecimal(
      money.decimalToMinor(slip.totalDeductions, run.currencyCode) + delta,
      run.currencyCode,
    );
    const net = money.minorToDecimal(
      money.decimalToMinor(slip.netAmount, run.currencyCode) - delta,
      run.currencyCode,
    );
    await db.payrollPayslip.update({
      where: { id: slip.id, tenantId },
      data: {
        totalDeductions: total,
        netAmount: net,
        payableDays:
          slip.payableDays == null
            ? null
            : Math.max(
                0,
                Number(slip.payableDays) + originalDays - assessment.days,
              ),
      },
    });
    await db.payrollRun.update({
      where: { id: run.id, tenantId },
      data: {
        totalDeductions: money.minorToDecimal(
          money.decimalToMinor(run.totalDeductions, run.currencyCode) + delta,
          run.currencyCode,
        ),
        totalNet: money.minorToDecimal(
          money.decimalToMinor(run.totalNet, run.currencyCode) - delta,
          run.currencyCode,
        ),
      },
    });
    await db.payrollAuditLog.create({
      data: {
        tenantId,
        employeeId,
        payrollRunId: run.id,
        payslipId: slip.id,
        action: "ATTENDANCE_RULES_RECALCULATED",
        details: `Attendance rules revision by ${actorId}; finalized but undistributed payroll recalculated in place`,
        oldValues: {
          totalDeductions: String(slip.totalDeductions),
          netAmount: String(slip.netAmount),
        },
        newValues: { totalDeductions: total, netAmount: net, assessment },
      },
    });
  }
}
