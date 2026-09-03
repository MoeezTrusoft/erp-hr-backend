// scripts/apply-hr-sheet-punches.mjs — HR-ATT-SHEET-RECONCILE-01
//
// Our records flagged 100 missing-punch occurrences in August. Cross-checked
// against HR's own AttendanceRecord sheets, only 6 are genuinely one-sided; 66
// have BOTH punches recorded and 28 have no row at all. The deduction engine
// was charging people for data we had, in a sheet, the whole time.
//
// This writes HR's times onto those days through correctAttendanceDay — the
// same audited path used for the paper anomaly forms. Each corrected day is
// marked manually_corrected, which also means device sync will never overwrite
// it, and the MISSING_* status disappears, so the violation stops being counted
// at source rather than being subtracted afterwards.
//
// Deliberately NOT applied:
//   * 28 dates with no row in HR's sheet — a day HR did not record is not a
//     missed punch, and inventing one would be worse than the bug.
//   * 3 dates whose check-out reads 00:00 (all one employee). 00:00 appears
//     nowhere else as a real punch in that sheet; they are empty cells.
//
// Dry run unless --write.
import { readFileSync } from "node:fs";
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
import { correctAttendanceDay } from "../src/services/attendanceCorrection.service.js";

const WRITE = process.argv.includes("--write");
const SRC = process.argv.find((a) => a.endsWith(".json")) || "/tmp/mp_fix.json";

const TENANTS = {
  Trusoft: "40314ef4-0a81-4390-b631-b3ad3f21f523",
  Homenet: "8ff0533b-62f6-4be9-a78e-69adf49e00bc",
  EMG: "61b7eb53-ab6e-413f-9d9a-1ecf4e071e73",
  JOC: "8f4a526f-d45b-4da2-b772-d6682e849812",
  BOC: "14d8c7b1-194d-4e35-b058-b9cb9aa9fba2",
};

const REASON =
  "Missing punch resolved from HR AttendanceRecord_Aug2026 — both punches present in the HR sheet (HR-ATT-SHEET-RECONCILE-01)";

const rows = JSON.parse(readFileSync(SRC, "utf8")).filter(
  (r) => r.checkIn !== "00:00" && r.checkOut !== "00:00",
);

const summary = { applied: 0, skipped: 0, failed: [] };

for (const [tenantName, tenantId] of Object.entries(TENANTS)) {
  const mine = rows.filter((r) => r.tenant === tenantName);
  if (!mine.length) continue;

  await mcpCtx.run({ user: { tenantId } }, async () => {
    console.log(`-- ${tenantName} --`);
    for (const r of mine) {
      const emp = await prisma.employee.findFirst({
        where: { employee_code: r.code },
        select: { id: true, employee_code: true },
      });
      if (!emp) {
        summary.failed.push(`${r.code} not found`);
        continue;
      }

      const before = await prisma.attendance.findFirst({
        where: { employeeId: emp.id, date: new Date(`${r.date}T00:00:00.000Z`) },
        select: { status: true, manually_corrected: true },
      });

      // Never overwrite a day HR has already corrected by hand.
      if (before?.manually_corrected) {
        summary.skipped++;
        console.log(`  = ${r.code} ${r.date}  already HR-corrected, left alone`);
        continue;
      }

      console.log(
        `  ${WRITE ? "+" : "."} ${r.code} ${r.name.slice(0, 18).padEnd(18)} ${r.date}  ` +
          `${r.checkIn} -> ${r.checkOut}   was ${before?.status ?? "(no row)"}`,
      );

      if (!WRITE) continue;
      try {
        await correctAttendanceDay({
          tenantId,
          employeeId: emp.id,
          date: r.date,
          checkIn: r.checkIn,
          checkOut: r.checkOut,
          reason: REASON,
          actorEmployeeId: emp.id,
        });
        summary.applied++;
      } catch (err) {
        summary.failed.push(`${r.code} ${r.date}: ${err.message}`);
      }
    }
  });
}

console.log(
  `\napplied ${summary.applied}   skipped(already corrected) ${summary.skipped}   failed ${summary.failed.length}`,
);
summary.failed.forEach((f) => console.log(`  ! ${f}`));
if (!WRITE) console.log("\nDry run. Re-run with --write to commit.");

await prisma.$disconnect().catch(() => {});
process.exit(0);
