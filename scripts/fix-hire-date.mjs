// scripts/fix-hire-date.mjs — HR-PAYROLL-EMPLOYMENT-PERIOD-01 (data repair)
//
// Abdul Moiz Ahmed (EMP227) carried hire_date 2026-10-02 — a month in the
// FUTURE — while appearing in HR's August attendance sheets as "Moeez 2" with
// real punches. A day/month transposition of 2026-02-04, confirmed by the
// operator.
//
// Left alone he prorates to 0% and is paid nothing for August or September:
// his only employment period was backfilled from the bad date, so it starts
// after both runs end.
//
// The period backfilled FROM hire_date is corrected with it. A period that was
// set deliberately (a termination or re-hire) is never moved — only one whose
// start still equals the wrong hire date, i.e. one this system derived.
//
// Dry run unless --write.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const WRITE = process.argv.includes("--write");
const day = (d) => new Date(`${d}T00:00:00.000Z`);
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "null");

const FIXES = [
  {
    code: "EMP227",
    tenantId: "40314ef4-0a81-4390-b631-b3ad3f21f523", // Trusoft
    wrong: "2026-10-02",
    correct: "2026-02-04",
    note: "hire_date was a day/month transposition; confirmed by the operator",
  },
];

for (const f of FIXES) {
  await mcpCtx.run({ user: { tenantId: f.tenantId } }, async () => {
    const emp = await prisma.employee.findFirst({
      where: { employee_code: f.code },
      select: {
        id: true, employee_code: true, employee_name: true,
        hire_date: true, joining_date: true,
        employmentPeriods: {
          select: { id: true, startDate: true, endDate: true, reason: true },
          orderBy: { startDate: "asc" },
        },
      },
    });
    if (!emp) {
      console.log(`  ! ${f.code} not found`);
      return;
    }

    console.log(
      `  ${WRITE ? "+" : "."} ${emp.employee_code} ${String(emp.employee_name).slice(0, 22).padEnd(22)} ` +
        `hire ${iso(emp.hire_date)} -> ${f.correct}`,
    );
    for (const p of emp.employmentPeriods) {
      const derived = iso(p.startDate) === f.wrong;
      console.log(
        `      period #${p.id} ${iso(p.startDate)} -> ${iso(p.endDate)}` +
          `${derived ? `   (derived from the bad hire date; start -> ${f.correct})` : "   (left alone)"}`,
      );
    }

    if (!WRITE) return;

    await prisma.employee.updateMany({
      where: { id: emp.id },
      data: { hire_date: day(f.correct), joining_date: day(f.correct) },
    });

    for (const p of emp.employmentPeriods) {
      if (iso(p.startDate) !== f.wrong) continue; // not ours to move
      await prisma.employmentPeriod.update({
        where: { id: p.id },
        data: { startDate: day(f.correct), note: f.note },
      });
    }
  });
}

console.log(WRITE ? "\nhire dates corrected" : "\nDry run. Re-run with --write to commit.");
await prisma.$disconnect().catch(() => {});
