// scripts/profile-bank-roundtrip.mjs — mock-data round-trip for the consolidated
// employee profile + bank/ntn create/update wiring.
//
// Exercises the REAL service functions:
//   createEmployee (with ntn + bank)  →  getEmployeeConsolidatedProfile  →
//   updateEmployee (patch bank + ntn) →  re-read profile  →  CLEAN UP everything.
//
// It also seeds a realistic payroll/tax fixture (GradeLevel, EmploymentTerms,
// TaxRate PK brackets, a PayrollRun + Payslip with EOBI / Provident Fund /
// Income Tax deductions) so the profile's derived fields (pay grade, tax slab,
// EOBI/PF, monthly + YTD tax, pay date, disbursement, compensation) are asserted
// against known values — then deletes all of it.
//
// Run against an EPHEMERAL/TEST database only (never prod). Requires:
//   DATABASE_URL, HR_C4_ENCRYPTION_KEY, HR_C4_BLIND_INDEX_KEY.
import { randomUUID } from "node:crypto";
import prisma from "../src/lib/prisma.js";
import { createEmployee, updateEmployee } from "../src/services/hrContract.service.js";
import { getEmployeeConsolidatedProfile } from "../src/services/employeeProfile.service.js";

const TENANT = randomUUID();
let PASS = 0;
let FAIL = 0;
const ok = (cond, label, detail = "") => {
  if (cond) {
    PASS += 1;
    console.log(`  ✓ ${label}`);
  } else {
    FAIL += 1;
    console.error(`  ✗ ${label}  ${detail}`);
  }
};

const created = { employeeId: null, gradeLevelId: null, runIds: [], payslipId: null, dedTypeIds: [] };

async function main() {
  console.log(`\n[round-trip] tenant=${TENANT}\n`);

  // ---- 1. CREATE employee with ntn + bank via the real service ----
  const createResult = await createEmployee(
    {
      firstName: "Roundtrip",
      middleName: "Q",
      lastName: "Tester",
      workEmail: `rt.${Date.now()}@example.com`,
      jobTitle: "QA Engineer",
      ntn: "1234567-8",
      bankName: "Meezan Bank",
      accountTitle: "Roundtrip Q Tester",
      accountNumber: "01234567890123",
      iban: "PK36MEZN0001234567890123",
      branch: "Gulberg III, Lahore",
      disbursementMethod: "Bank Transfer",
      accountType: "SAVINGS",
    },
    /* actorId */ null,
    { tenantId: TENANT }
  );
  const employeeId = createResult?.summary?.id;
  created.employeeId = employeeId;
  console.log(`[create] employeeId=${employeeId}`);
  ok(Number.isFinite(employeeId), "employee created");
  ok(createResult?.ntn === "****67-8", "ntn masked in contract profile", JSON.stringify(createResult?.ntn));
  ok(createResult?.banking?.bankName === "Meezan Bank", "bank row created (bankName)", JSON.stringify(createResult?.banking));
  ok(createResult?.banking?.accountNumber?.startsWith("****"), "account masked in contract profile");

  // ---- 2. Seed payroll / tax fixture (direct prisma) ----
  const grade = await prisma.gradeLevel.create({ data: { name: "G7 (Senior)", tenantId: TENANT } });
  created.gradeLevelId = grade.id;
  await prisma.employee.update({ where: { id: employeeId }, data: { gradeLevelId: grade.id } });

  await prisma.employmentTerms.create({
    data: {
      tenantId: TENANT,
      employeeId,
      baseSalary: 400000, // monthly PKR (C4-encrypted on write)
      currency: "PKR",
      payFrequency: "MONTHLY",
      effectiveFrom: new Date("2025-07-01T00:00:00Z"),
    },
  });

  // PK FY26 tax brackets (annual). 4.8M annual → lands in the 2.4M–4.8M bracket.
  await prisma.taxRate.createMany({
    data: [
      { tenantId: TENANT, countryCode: "PK", bracketMin: 0, bracketMax: 600000, rate: 0, effectiveFrom: new Date("2025-07-01T00:00:00Z") },
      { tenantId: TENANT, countryCode: "PK", bracketMin: 600000, bracketMax: 1200000, rate: 0.05, effectiveFrom: new Date("2025-07-01T00:00:00Z") },
      { tenantId: TENANT, countryCode: "PK", bracketMin: 1200000, bracketMax: 2400000, rate: 0.15, effectiveFrom: new Date("2025-07-01T00:00:00Z") },
      { tenantId: TENANT, countryCode: "PK", bracketMin: 2400000, bracketMax: 4800000, rate: 0.25, effectiveFrom: new Date("2025-07-01T00:00:00Z") },
      { tenantId: TENANT, countryCode: "PK", bracketMin: 4800000, bracketMax: null, rate: 0.35, effectiveFrom: new Date("2025-07-01T00:00:00Z") },
    ],
  });

  const mkType = async (code, name) => {
    const t = await prisma.payrollDeductionType.create({ data: { tenantId: TENANT, code: `${code}_${Date.now()}`, name } });
    created.dedTypeIds.push(t.id);
    return t;
  };
  const incomeTaxType = await mkType("INCOME_TAX", "Income Tax");
  const eobiType = await mkType("EOBI", "EOBI");
  const pfType = await mkType("PF", "Provident Fund");

  // Two payslips within FY26 (one per run — payslips are unique per run+employee)
  // so YTD income tax = sum of both.
  const mkRunPayslip = async (period, processedAt, net, tax, eobi, pf) => {
    const run = await prisma.payrollRun.create({
      data: {
        tenantId: TENANT,
        periodStart: new Date(period[0]),
        periodEnd: new Date(period[1]),
        countryCode: "PK",
        currencyCode: "PKR",
        status: "COMPLETED",
        processedAt: new Date(processedAt),
      },
    });
    created.runIds.push(run.id);
    const ps = await prisma.payrollPayslip.create({
      data: {
        tenantId: TENANT,
        payrollRunId: run.id,
        employeeId,
        grossAmount: 400000,
        totalDeductions: tax + eobi + pf,
        netAmount: net,
        status: "DRAFT",
        deductions: {
          create: [
            { tenantId: TENANT, deductionTypeId: incomeTaxType.id, amount: tax, description: "Income Tax" },
            { tenantId: TENANT, deductionTypeId: eobiType.id, amount: eobi, description: "EOBI" },
            { tenantId: TENANT, deductionTypeId: pfType.id, amount: pf, description: "Provident Fund" },
          ],
        },
      },
    });
    return ps;
  };
  // Older payslip (July, created first → lower created_at), then the latest (August).
  await mkRunPayslip(["2025-07-01", "2025-07-31"], "2025-08-01", 340000, 55000, 250, 20000);
  const latest = await mkRunPayslip(["2025-08-01", "2025-08-31"], "2025-09-01", 348000, 52000, 250, 20000);
  created.payslipId = latest.id;

  // ---- 3. READ consolidated profile (sensitive view) ----
  const profile = await getEmployeeConsolidatedProfile(employeeId, TENANT, { showSensitive: true, taxFiscalYear: "FY26" });
  console.log("\n[profile]", JSON.stringify(profile, null, 2), "\n");

  ok(profile.middleName === "Q", "middle name surfaced");
  ok(profile.payGrade === "G7 (Senior)", "pay grade from GradeLevel");
  ok(profile.ntn === "1234567-8", "ntn DECRYPTED (sensitive view)", JSON.stringify(profile.ntn));
  ok(profile.bank?.accountNumber === "01234567890123", "account # DECRYPTED", JSON.stringify(profile.bank?.accountNumber));
  ok(profile.bank?.iban === "PK36MEZN0001234567890123", "IBAN DECRYPTED", JSON.stringify(profile.bank?.iban));
  ok(profile.bank?.accountTitle === "Roundtrip Q Tester", "A/C title");
  ok(profile.bank?.branch === "Gulberg III, Lahore", "branch");
  ok(profile.disbursement?.method === "Bank Transfer", "disbursement method (from BankDetail)");
  ok(profile.disbursement?.netPaid === 348000, "disbursement netPaid (latest payslip)", JSON.stringify(profile.disbursement?.netPaid));
  ok(profile.payDate && new Date(profile.payDate).toISOString().startsWith("2025-09-01"), "pay date = latest run processedAt", String(profile.payDate));
  ok(profile.compensation?.current?.baseSalary === 400000, "compensation baseSalary DECRYPTED", JSON.stringify(profile.compensation?.current?.baseSalary));
  ok(profile.eobi?.monthlyAmount === 250, "EOBI monthly amount", JSON.stringify(profile.eobi));
  ok(profile.providentFund?.monthlyAmount === 20000, "Provident Fund monthly amount", JSON.stringify(profile.providentFund));
  ok(profile.tax?.monthlyTaxPaid === 52000, "monthly tax = latest payslip income tax", JSON.stringify(profile.tax?.monthlyTaxPaid));
  ok(profile.tax?.ytdTaxPaid === 107000, "YTD tax = sum over FY26 (55000+52000)", JSON.stringify(profile.tax?.ytdTaxPaid));
  ok(profile.tax?.fiscalYear === "FY26", "fiscal year label FY26");
  ok(profile.taxSlab?.matchedBracket?.rate === 0.25, "tax slab matched (4.8M annual → 25% bracket)", JSON.stringify(profile.taxSlab?.matchedBracket));

  // ---- 4. UPDATE employee (patch bank + ntn) via the real service ----
  await updateEmployee(
    employeeId,
    { ntn: "9876543-2", branch: "DHA Phase 5, Karachi", disbursementMethod: "Cheque", accountNumber: "09998887776665" },
    /* actorId */ null
  );
  const after = await getEmployeeConsolidatedProfile(employeeId, TENANT, { showSensitive: true, taxFiscalYear: "FY26" });
  ok(after.ntn === "9876543-2", "ntn updated + re-decrypted", JSON.stringify(after.ntn));
  ok(after.bank?.branch === "DHA Phase 5, Karachi", "branch updated");
  ok(after.bank?.accountNumber === "09998887776665", "account # updated + re-decrypted", JSON.stringify(after.bank?.accountNumber));
  ok(after.disbursement?.method === "Cheque", "disbursement method updated");
  ok(after.bank?.bankName === "Meezan Bank", "un-patched bank field preserved (bankName)");

  console.log(`\n[result] PASS=${PASS} FAIL=${FAIL}\n`);
}

async function cleanup() {
  console.log("[cleanup] removing mock data…");
  try {
    const empId = created.employeeId;
    if (empId) {
      await prisma.payrollDeduction.deleteMany({ where: { payslip: { employeeId: empId } } });
      await prisma.payrollPayslip.deleteMany({ where: { employeeId: empId } });
      if (created.runIds.length) await prisma.payrollRun.deleteMany({ where: { id: { in: created.runIds } } });
      if (created.dedTypeIds.length) await prisma.payrollDeductionType.deleteMany({ where: { id: { in: created.dedTypeIds } } });
      await prisma.taxRate.deleteMany({ where: { tenantId: TENANT } });
      await prisma.employmentTerms.deleteMany({ where: { employeeId: empId } });
      await prisma.bankDetail.deleteMany({ where: { employeeId: empId } });
      await prisma.log.deleteMany({ where: { OR: [{ employeeId: empId }, { actionById: empId }] } }).catch(() => {});
      await prisma.outboxEvent.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
      await prisma.employee.update({ where: { id: empId }, data: { gradeLevelId: null } }).catch(() => {});
      if (created.gradeLevelId) await prisma.gradeLevel.deleteMany({ where: { id: created.gradeLevelId } });
      await prisma.employee.deleteMany({ where: { id: empId } });
    }
    // Verify gone.
    const remaining = empId ? await prisma.employee.count({ where: { id: empId } }) : 0;
    console.log(`[cleanup] employee rows remaining: ${remaining}`);
  } catch (e) {
    console.error("[cleanup] error:", e.message);
  }
}

let exitCode = 0;
try {
  await main();
  if (FAIL > 0) exitCode = 1;
} catch (e) {
  console.error("[round-trip] ERROR:", e);
  exitCode = 1;
} finally {
  await cleanup();
  await prisma.$disconnect();
}
process.exit(exitCode);
