import prisma from "../lib/prisma.js";
import { employeeCode } from "../lib/payrollConfiguration.js";

export async function payrollReadiness({
  tenantId,
  run,
  employees,
  db = prisma,
}) {
  const ids = employees.map((e) => e.id),
    issues = [];
  const [banks, negativeLeave, pendingOt, snapshot] = await Promise.all([
    db.bankDetail.findMany({
      where: { tenantId, employeeId: { in: ids }, isPrimary: true },
    }),
    db.leaveBalance.findMany({
      where: { tenantId, employeeId: { in: ids }, balance: { lt: 0 } },
      select: { employeeId: true },
    }),
    db.overtimeRequest.findMany({
      where: {
        tenantId,
        employeeId: { in: ids },
        status: "PENDING",
        date: { gte: run.periodStart, lte: run.periodEnd },
      },
      select: { employeeId: true },
    }),
    db.payrollConfigSnapshot.findFirst({
      where: {
        tenantId,
        ...(run.calculationConfigVersion
          ? { version: run.calculationConfigVersion }
          : {}),
      },
      orderBy: { version: "desc" },
    }),
  ]);
  const add = (code, message, employee) =>
    issues.push({
      code,
      type: code,
      severity: "high",
      count: 1,
      message: employee ? `${employeeCode(employee)}: ${message}` : message,
      employeeCode: employee ? employeeCode(employee) : null,
    });
  if (!employees.length)
    add("NO_EMPLOYEES", "No eligible employees in this period");
  if (!snapshot)
    add("CONFIG_REQUIRED", "Publish Payroll Setup before calculation");
  const rates = snapshot?.config?.taxSlabs || [];
  const effective = rates
    .filter(
      (r) =>
        r.countryCode === run.countryCode &&
        r.status === "ACTIVE" &&
        +new Date(r.effectiveFrom) <= +run.periodEnd &&
        (!r.effectiveTo || +new Date(r.effectiveTo) >= +run.periodEnd),
    )
    .sort((a, b) => Number(a.bracketMin) - Number(b.bracketMin));
  let ceiling = 0;
  for (const r of effective) {
    if (
      Number(r.bracketMin) !== ceiling ||
      Number(r.rate) < 0 ||
      Number(r.rate) > 1 ||
      (r.bracketMax != null && Number(r.bracketMax) <= Number(r.bracketMin))
    ) {
      add(
        "TAX_BRACKETS_INVALID",
        "Effective tax brackets must be contiguous, non-overlapping and use rates between 0 and 1",
      );
      break;
    }
    ceiling = r.bracketMax == null ? Infinity : Number(r.bracketMax);
  }
  if (effective.length && ceiling !== Infinity)
    add("TAX_BRACKETS_INVALID", "The final tax bracket must be open-ended");
  if (
    !rates.some(
      (r) =>
        r.countryCode === run.countryCode &&
        r.status === "ACTIVE" &&
        +new Date(r.effectiveFrom) <= +run.periodEnd &&
        (!r.effectiveTo || +new Date(r.effectiveTo) >= +run.periodEnd),
    )
  )
    add(
      "TAX_REQUIRED",
      "Publish tax brackets effective at the payroll period end",
    );
  for (const e of employees) {
    if (!e.employee_code)
      add(
        "EMPLOYEE_CODE_REQUIRED",
        "Assign an employee code before payroll",
        e,
      );
    if (!e.employmentTerms?.length)
      add("SALARY_REQUIRED", "Effective salary terms are missing", e);
    if (e.employmentTerms?.some((t) => t.currency !== run.currencyCode))
      add(
        "CURRENCY_MISMATCH",
        "Salary currency differs from payroll currency",
        e,
      );
    const bank = banks.find((b) => b.employeeId === e.id);
    if (!bank?.accountNumber || !bank?.routingNumber)
      add(
        "BANK_REQUIRED",
        "Primary bank account and routing details are required",
        e,
      );
    if (negativeLeave.some((r) => r.employeeId === e.id))
      add("NEGATIVE_LEAVE", "Resolve the negative leave balance", e);
    if (pendingOt.some((r) => r.employeeId === e.id))
      add("OVERTIME_PENDING", "Complete the pending overtime review", e);
  }
  return { issues, snapshot };
}

export function assertReady(issues) {
  if (issues.length)
    throw Object.assign(
      new Error("HR-4302: " + issues.map((i) => i.message).join("; ")),
      { status: 409, code: "HR-4302", details: { issues } },
    );
}
