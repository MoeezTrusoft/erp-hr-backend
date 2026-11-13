// scripts/reconciliation-report.mjs — HR-RECON-01
//
// Month-end reconciliation for every tenant, printed as a table or as CSV for
// HR to open.
//
//   node scripts/reconciliation-report.mjs 2026-08-01 2026-08-31 [--csv]
//
// Replaces the scratchpad comparison scripts used to close August. Read-only.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
import { buildMonthlyReconciliation } from "../src/services/attendanceReconciliation.service.js";

const args = process.argv.slice(2);
const dates = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const FROM = dates[0] ?? "2026-08-01";
const TO = dates[1] ?? "2026-08-31";
const CSV = args.includes("--csv");

const TENANTS = {
  Trusoft: "40314ef4-0a81-4390-b631-b3ad3f21f523",
  Homenet: "8ff0533b-62f6-4be9-a78e-69adf49e00bc",
  EMG: "61b7eb53-ab6e-413f-9d9a-1ecf4e071e73",
  JOC: "8f4a526f-d45b-4da2-b772-d6682e849812",
  BOC: "14d8c7b1-194d-4e35-b058-b9cb9aa9fba2",
};

const COLS = [
  ["present", "pres"], ["late", "late"], ["halfDay", "half"], ["absent", "abs"],
  ["missingCheckin", "m-in"], ["missingCheckout", "m-out"],
  ["weeklyOff", "off"], ["holiday", "hol"], ["onLeave", "leave"],
  ["corrected", "corr"], ["expectedDays", "exp"], ["attendancePct", "att%"],
];

if (CSV) {
  console.log(["tenant", "code", "name", ...COLS.map(([k]) => k), "needsReview", "noData"].join(","));
}

const grand = { employees: 0, needsReview: 0, noData: 0 };

await mcpCtx.run({ system: true }, async () => {
  for (const [name, tenantId] of Object.entries(TENANTS)) {
    const res = await mcpCtx.run({ user: { tenantId } }, () =>
      buildMonthlyReconciliation({ tenantId, from: FROM, to: TO }),
    );

    if (CSV) {
      for (const e of res.employees) {
        console.log([
          name, e.employeeCode, `"${String(e.employeeName).replace(/"/g, '""')}"`,
          ...COLS.map(([k]) => e[k]), e.needsReview, e.noData,
        ].join(","));
      }
      continue;
    }

    console.log(`\n=== ${name}  ${FROM} .. ${TO} ===`);
    console.log(
      `${"code".padEnd(8)}${"name".padEnd(22)}` +
      COLS.map(([, h]) => h.padStart(6)).join("") + "  review",
    );
    const sorted = [...res.employees].sort(
      (a, b) => b.needsReview - a.needsReview
        || String(a.employeeCode).localeCompare(String(b.employeeCode)),
    );
    for (const e of sorted) {
      const flag = e.noData ? "  <-- NO DATA" : "";
      console.log(
        `${String(e.employeeCode).padEnd(8)}${String(e.employeeName).slice(0, 20).padEnd(22)}` +
        COLS.map(([k]) => String(e[k]).padStart(6)).join("") +
        `${String(e.needsReview).padStart(8)}${flag}`,
      );
    }
    const t = res.totals;
    console.log(
      `TOTAL   employees=${t.employees}  attended=${t.attendedDays}/${t.expectedDays} ` +
      `(${t.attendancePct}%)  absent=${t.absent}  needsReview=${t.needsReview}  noData=${t.noData}`,
    );
    grand.employees += t.employees;
    grand.needsReview += t.needsReview;
    grand.noData += t.noData;
  }

  if (!CSV) {
    console.log(
      `\nFLEET  employees=${grand.employees}  needsReview=${grand.needsReview}  noData=${grand.noData}`,
    );
    console.log("needsReview = days payroll is holding: incomplete shifts awaiting a ruling.");
  }
});

await prisma.$disconnect().catch(() => {});
