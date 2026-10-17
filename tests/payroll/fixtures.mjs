import {
  setup,
  prisma,
  company,
  other,
  people,
  db,
  as,
  submit,
  act,
} from "../approval/fixtures.mjs";
import { createPayrollRun } from "../../src/services/payrollService.js";
import { publishConfig } from "../../src/services/payrollConfigActions.service.js";
process.env.HR_C4_BLIND_INDEX_KEY = Buffer.alloc(32, 19).toString("base64");
export async function setupPayroll() {
  await setup();
  let loan;
  await db(async (tx) => {
    await tx.employee.updateMany({
      where: { tenant_id: company },
      data: { payroll_included: false },
    });
    await tx.employee.update({
      where: { id: people.EMPLOYEE.id },
      data: { payroll_included: true },
    });
    await tx.employmentTerms.create({
      data: {
        tenantId: company,
        employeeId: people.EMPLOYEE.id,
        baseSalary: "100000",
        currency: "PKR",
        payFrequency: "MONTHLY",
        effectiveFrom: new Date("2026-01-01"),
      },
    });
    await tx.bankDetail.create({
      data: {
        tenantId: company,
        employeeId: people.EMPLOYEE.id,
        bankName: "TEST BANK",
        accountNumber: "TEST-ACCOUNT-0001",
        routingNumber: "TEST-ROUTING",
        isPrimary: true,
      },
    });
    await tx.payrollRuleConfig.create({
      data: {
        tenantId: company,
        garnishmentRecovery: true,
        garnishmentCapPct: 33,
      },
    });
    await tx.salaryComponent.create({
      data: {
        tenantId: company,
        code: "HOUSING",
        name: "Housing",
        type: "EARNING",
        active: true,
        computation: "PERCENTAGE",
        value: 10,
        sortOrder: 1,
      },
    });
    await tx.taxRate.create({
      data: {
        tenantId: company,
        countryCode: "PK",
        bracketMin: 0,
        bracketMax: null,
        rate: 0.1,
        status: "ACTIVE",
        effectiveFrom: new Date("2026-01-01"),
      },
    });
    loan = await tx.loan.create({
      data: {
        tenantId: company,
        employeeId: people.EMPLOYEE.id,
        status: "PENDING",
        principalMinor: 500000,
        outstandingMinor: 500000,
        monthlyInstallmentMinor: 1000000,
        tenureMonths: 1,
        disbursementDate: new Date("2026-01-01"),
      },
    });
    await tx.payrollAuditLog.create({
      data: {
        tenantId: company,
        action: "TIMESHEET_SUBMITTED",
        details: "Fictional verified timesheet 2026-09",
      },
    });
  });
  await as("EMPLOYEE", () =>
    publishConfig({ tenantId: company, publishedById: String(people.EMPLOYEE.id) }),
  );
  let loanReview = await submit({ kind: "LOAN", ref: String(loan.id) });
  loanReview = await act("MANAGER", loanReview, "RECOMMEND_APPROVAL");
  loanReview = await act("HR", loanReview, "VERIFY");
  await act("MANAGEMENT", loanReview, "APPROVE");
  const run = await as("EMPLOYEE", () =>
    createPayrollRun(
      {
        periodStart: "2026-09-01",
        periodEnd: "2026-09-30",
        countryCode: "PK",
        currencyCode: "PKR",
      },
      people.EMPLOYEE.id,
      company,
    ),
  );
  return { run, loan };
}
export { prisma, company, other, people, db, as, submit, act };
