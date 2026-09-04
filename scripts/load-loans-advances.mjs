// scripts/load-loans-advances.mjs — HR-PAYROLL-LOAN-LOAD-01
//
// Three staff loans and one salary advance, supplied by the operator.
//
//   Mola Bux   200,000 PKR  disbursed 11 May 2026  25,000/mo from June
//   Zahid       40,000 PKR  disbursed 17 Apr 2026   8,000/mo from May
//   Asghar      30,000 PKR  disbursed  8 Apr 2026   5,000/mo from May   (JOC)
//   Hakim Ali   10,000 PKR  salary advance, August payroll month
//
// Every one of these began repaying BEFORE this system ran payroll, so the
// principal is not the balance. What August must deduct against is the balance
// entering August, and the loan must stop at the right month rather than
// running on for its full original tenure.
//
// Installments already taken outside the system are written as LoanRepayment
// rows with no payrollRunId, so `principal - sum(repayments) == outstanding`
// reconciles instead of the opening balance appearing out of nowhere.
//
//   Mola Bux  Jun+Jul       = 50,000 paid   -> 150,000 outstanding
//   Zahid     May+Jun+Jul   = 24,000 paid   ->  16,000 outstanding
//   Asghar    May+Jun+Jul   = 15,000 paid   ->  15,000 outstanding
//   Hakim Ali advance taken for August itself, nothing repaid yet.
//
// PKR is a 2-decimal currency, so minor units are paisa.
//
// Dry run unless --write.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const WRITE = process.argv.includes("--write");
const PKR = (major) => Math.round(major * 100);

const TENANTS = {
  Homenet: "8ff0533b-62f6-4be9-a78e-69adf49e00bc",
  JOC: "8f4a526f-d45b-4da2-b772-d6682e849812",
  Trusoft: "40314ef4-0a81-4390-b631-b3ad3f21f523",
};

const PLAN = [
  {
    tenant: "Homenet",
    match: "Mola Bux",
    kind: "LOAN",
    principal: 200_000,
    installment: 25_000,
    disbursementDate: "2026-05-11",
    paidBeforeAugust: ["2026-06", "2026-07"],
    reason: "Staff loan — 200,000 PKR over 8 monthly installments from June 2026",
  },
  {
    tenant: "Homenet",
    match: "Zahid",
    kind: "LOAN",
    principal: 40_000,
    installment: 8_000,
    disbursementDate: "2026-04-17",
    paidBeforeAugust: ["2026-05", "2026-06", "2026-07"],
    reason: "Staff loan — 40,000 PKR over 5 monthly installments from May 2026",
  },
  {
    tenant: "JOC",
    match: "Asghar",
    kind: "LOAN",
    principal: 30_000,
    installment: 5_000,
    disbursementDate: "2026-04-08",
    paidBeforeAugust: ["2026-05", "2026-06", "2026-07"],
    reason: "Staff loan — 30,000 PKR over 6 monthly installments from May 2026",
  },
  {
    tenant: "Homenet",
    match: "Hakim Ali",
    kind: "ADVANCE",
    principal: 10_000,
    installment: 10_000,
    disbursementDate: "2026-08-01",
    paidBeforeAugust: [],
    reason: "Salary advance — 10,000 PKR recovered in the August 2026 payroll",
  },
];

const norm = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

let failures = 0;

for (const item of PLAN) {
  const tenantId = TENANTS[item.tenant];
  await mcpCtx.run({ user: { tenantId } }, async () => {
    const all = await prisma.employee.findMany({
      select: { id: true, employee_code: true, employee_name: true, first_name: true, last_name: true },
    });
    const want = norm(item.match);
    const hits = all.filter((e) => {
      const nm = norm(e.employee_name || `${e.first_name ?? ""} ${e.last_name ?? ""}`);
      return nm === want || nm.includes(want);
    });

    if (hits.length !== 1) {
      console.log(
        `  ! ${item.tenant}/${item.match}: ${hits.length} match(es)` +
          (hits.length ? ` -> ${hits.map((h) => `${h.employee_code} ${h.employee_name}`).join(" | ")}` : ""),
      );
      failures += 1;
      return;
    }
    const emp = hits[0];

    const paidMinor = PKR(item.installment) * item.paidBeforeAugust.length;
    const outstandingMinor = PKR(item.principal) - paidMinor;
    const tenureMonths = Math.ceil(item.principal / item.installment);

    // Never create the same loan twice: this script is re-runnable.
    const existing = await prisma.loan.findFirst({
      where: {
        employeeId: emp.id,
        kind: item.kind,
        disbursementDate: new Date(`${item.disbursementDate}T00:00:00.000Z`),
      },
      select: { id: true },
    });

    console.log(
      `  ${WRITE ? (existing ? "=" : "+") : "."} ${item.tenant.padEnd(8)} ${String(emp.employee_code).padEnd(8)} ` +
        `${String(emp.employee_name).slice(0, 20).padEnd(20)} ${item.kind.padEnd(7)} ` +
        `principal ${item.principal.toLocaleString().padStart(8)}  ` +
        `paid ${(paidMinor / 100).toLocaleString().padStart(7)}  ` +
        `outstanding ${(outstandingMinor / 100).toLocaleString().padStart(8)}  ` +
        `${item.installment.toLocaleString()}/mo x ${tenureMonths}` +
        `${existing ? "   (already present, skipped)" : ""}`,
    );

    if (!WRITE || existing) return;

    const loan = await prisma.loan.create({
      data: {
        tenantId,
        employeeId: emp.id,
        kind: item.kind,
        status: "ACTIVE",
        principalMinor: PKR(item.principal),
        outstandingMinor,
        monthlyInstallmentMinor: PKR(item.installment),
        interestRatePct: 0,
        tenureMonths,
        disbursementDate: new Date(`${item.disbursementDate}T00:00:00.000Z`),
        reason: item.reason,
      },
      select: { id: true },
    });

    // Installments already taken outside this system, so the ledger balances.
    for (const month of item.paidBeforeAugust) {
      await prisma.loanRepayment.create({
        data: {
          tenantId,
          loanId: loan.id,
          amountMinor: PKR(item.installment),
          deductedAt: new Date(`${month}-28T00:00:00.000Z`),
          note: `Installment recovered before this system ran payroll (${month})`,
        },
      });
    }
  });
}

console.log(
  failures
    ? `\n${failures} employee(s) unmatched — nothing written for those.`
    : WRITE
      ? "\nloans written"
      : "\nDry run. Re-run with --write to commit.",
);
await prisma.$disconnect().catch(() => {});
