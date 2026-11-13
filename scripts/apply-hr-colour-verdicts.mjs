// scripts/apply-hr-colour-verdicts.mjs — HR-ATT-COLOUR-RECONCILE-01
//
// HR's AttendanceRecord workbooks colour-code every employee-day against a
// legend: weekly off, Late, Ch/in-out missing, Early Ch/out, Absent, Not join,
// Joined but not enrolled, Approved. That is HR's own ruling on each day, and
// our evaluator had been re-deriving status from punch times instead, without a
// weekly-off calendar and against shift starts that make ordinary arrivals look
// late.
//
// The divergence is not marginal. Of ~153 days we charged a deduction for, HR's
// sheet supports 14:
//    LATE               115 charged, HR marks 3
//    MISSING_PUNCH       29 charged, 22 of them fall on a WEEKLY OFF
//    DISAPPROVED_LEAVE    9 charged, HR marks 4 absent, 1 was APPROVED
//
// This applies HR's verdict for August, and only to days we actually charge —
// 141 of them — rather than rewriting every row.
//
//   SET_PRESENT  a day we called LATE that HR marks as ordinary
//   EXCUSE       a weekly off, an approved day, or a day the person was not
//                enrolled/not joined. Punched days are corrected to PRESENT;
//                days with no punch at all have their row DELETED, because an
//                ABSENT on somebody's day off is a fabrication that also costs
//                them day-credit.
//
// Every change goes through correctAttendanceDay, so each one is attributable
// and marked manually_corrected — which also stops countViolationDays counting
// it and stops device sync overwriting it.
//
// Dry run unless --write.
import { readFileSync } from "node:fs";
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
import { correctAttendanceDay } from "../src/services/attendanceCorrection.service.js";

const WRITE = process.argv.includes("--write");
const SRC = process.argv.find((a) => a.endsWith(".json")) || "/tmp/colour_fix.json";

const TENANTS = {
  Trusoft: "40314ef4-0a81-4390-b631-b3ad3f21f523",
  Homenet: "8ff0533b-62f6-4be9-a78e-69adf49e00bc",
  EMG: "61b7eb53-ab6e-413f-9d9a-1ecf4e071e73",
  JOC: "8f4a526f-d45b-4da2-b772-d6682e849812",
  BOC: "14d8c7b1-194d-4e35-b058-b9cb9aa9fba2",
};

const hhmm = (d) =>
  d
    ? `${String(new Date(d).getUTCHours()).padStart(2, "0")}:${String(new Date(d).getUTCMinutes()).padStart(2, "0")}`
    : null;

const rows = JSON.parse(readFileSync(SRC, "utf8"));
const tally = { present: 0, excusedKept: 0, deleted: 0, missing: 0, failed: [] };

for (const [tenantName, tenantId] of Object.entries(TENANTS)) {
  const mine = rows.filter((r) => r.tenant === tenantName);
  if (!mine.length) continue;

  await mcpCtx.run({ user: { tenantId } }, async () => {
    console.log(`-- ${tenantName} (${mine.length}) --`);
    for (const r of mine) {
      const emp = await prisma.employee.findFirst({
        where: { employee_code: r.code },
        select: { id: true },
      });
      if (!emp) {
        tally.failed.push(`${r.code} not found`);
        continue;
      }

      const day = new Date(`${r.date}T00:00:00.000Z`);
      const att = await prisma.attendance.findFirst({
        where: { employeeId: emp.id, date: day },
        select: { id: true, status: true, check_in: true, check_out: true },
      });
      if (!att) {
        tally.missing++;
        continue;
      }

      const cin = hhmm(att.check_in);
      const cout = hhmm(att.check_out);
      const hasPunch = Boolean(cin || cout);

      // A weekly off with no punch at all should not exist as an attendance row.
      if (r.action === "EXCUSE" && !hasPunch) {
        console.log(`  x ${r.code} ${r.date}  ${r.hr.padEnd(12)} delete (${att.status}, no punches)`);
        if (WRITE) {
          await prisma.attendance
            .delete({ where: { id: att.id } })
            .catch((e) => tally.failed.push(`${r.code} ${r.date}: ${e.message}`));
        }
        tally.deleted++;
        continue;
      }

      const reason =
        r.action === "SET_PRESENT"
          ? "HR AttendanceRecord marks this day as ordinary, not late (HR-ATT-COLOUR-RECONCILE-01)"
          : `HR AttendanceRecord marks this day ${r.hr} (HR-ATT-COLOUR-RECONCILE-01)`;

      console.log(
        `  ${r.action === "SET_PRESENT" ? ">" : "~"} ${r.code} ${r.date}  ${r.hr.padEnd(12)} ` +
          `${att.status} -> PRESENT  ${cin ?? "--:--"}/${cout ?? "--:--"}`,
      );

      if (!WRITE) continue;
      try {
        await correctAttendanceDay({
          tenantId,
          employeeId: emp.id,
          date: r.date,
          checkIn: cin,
          checkOut: cout,
          status: "PRESENT",
          reason,
          actorEmployeeId: emp.id,
        });
        if (r.action === "SET_PRESENT") tally.present++;
        else tally.excusedKept++;
      } catch (err) {
        tally.failed.push(`${r.code} ${r.date}: ${err.message}`);
      }
    }
  });
}

console.log(
  `\nlate->present ${tally.present}   excused(kept punches) ${tally.excusedKept}   ` +
    `deleted(day off, no punch) ${tally.deleted}   no attendance row ${tally.missing}   failed ${tally.failed.length}`,
);
tally.failed.slice(0, 10).forEach((f) => console.log(`  ! ${f}`));
if (!WRITE) console.log("\nDry run. Re-run with --write to commit.");

await prisma.$disconnect().catch(() => {});
process.exit(0);
