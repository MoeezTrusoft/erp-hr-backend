// scripts/revert-colour-verdicts.mjs — undo HR-ATT-COLOUR-RECONCILE-01.
//
// That change trusted the colour classifications in HR's AttendanceRecord
// workbooks and rewrote 141 days accordingly — 112 of them from LATE to
// PRESENT. The operator has since confirmed those classifications are not
// reliable: HR under-records lateness. Checking the rosters bears that out —
//
//   Chetan Maheshwry  shift 12:00, arrives 12:39 12:31 12:13 12:18 12:23
//   Syed Samar Abbas  shift 10:00, arrives 10:32 10:10 10:12 10:09 10:13
//   Noor Hassan       shift 10:00, arrives 10:27 10:04 10:20 10:11 10:28
//
// — and the grace period was already being applied correctly (Noor Hassan's
// 10:04 and 10:11 were never counted; his 10:27 and 10:28 were). The lateness
// our evaluator found was real. Overwriting it made the data worse.
//
// Recovery does not need the previous values: every Attendance row is derived
// from attendance_device_punches, which no correction ever touched. Clearing
// manually_corrected lets the evaluator re-derive the truth from the punches.
//
// The 63 punch-TIME fills from HR-ATT-SHEET-RECONCILE-01 are kept — filling a
// gap the device missed is the one thing HR's data is good for. They stay
// manually_corrected, so the evaluator skips them. Exactly one day carries both
// corrections (EMP221 2026-08-31); it is re-filled at the end.
//
// Dry run unless --write.
import { readFileSync } from "node:fs";
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
import { applyEvaluatedShiftsForDays } from "../src/services/attendanceWriter.service.js";
import { correctAttendanceDay } from "../src/services/attendanceCorrection.service.js";

const WRITE = process.argv.includes("--write");
const COLOUR = JSON.parse(readFileSync("/tmp/colour_fix.json", "utf8"));
const PUNCH = JSON.parse(readFileSync("/tmp/mp_fix.json", "utf8")).filter(
  (r) => r.checkIn !== "00:00" && r.checkOut !== "00:00",
);

const TENANTS = {
  Trusoft: "40314ef4-0a81-4390-b631-b3ad3f21f523",
  Homenet: "8ff0533b-62f6-4be9-a78e-69adf49e00bc",
  EMG: "61b7eb53-ab6e-413f-9d9a-1ecf4e071e73",
  JOC: "8f4a526f-d45b-4da2-b772-d6682e849812",
  BOC: "14d8c7b1-194d-4e35-b058-b9cb9aa9fba2",
};

const punchKeys = new Set(PUNCH.map((p) => `${p.code}|${p.date}`));
const overlap = COLOUR.filter((c) => punchKeys.has(`${c.code}|${c.date}`));

const tally = { cleared: 0, rebuiltDays: 0, refilled: 0, failed: [] };

for (const [tenantName, tenantId] of Object.entries(TENANTS)) {
  const mine = COLOUR.filter((r) => r.tenant === tenantName);
  if (!mine.length) continue;

  await mcpCtx.run({ user: { tenantId } }, async () => {
    const codes = [...new Set(mine.map((r) => r.code))];
    const emps = await prisma.employee.findMany({
      where: { employee_code: { in: codes } },
      select: { id: true, employee_code: true },
    });
    const byCode = new Map(emps.map((e) => [e.employee_code, e.id]));

    // 1. Unfreeze the days this change froze.
    for (const r of mine) {
      const id = byCode.get(r.code);
      if (!id) {
        tally.failed.push(`${r.code} not found`);
        continue;
      }
      const day = new Date(`${r.date}T00:00:00.000Z`);
      if (WRITE) {
        await prisma.attendance.updateMany({
          where: { employeeId: id, date: day },
          data: { manually_corrected: false },
        });
      }
      tally.cleared++;
    }

    // 2. Re-derive those days from the raw punches. Days still flagged
    //    manually_corrected — the punch fills — are skipped by the writer.
    const days = [...new Set(mine.map((r) => r.date))].map((d) => new Date(`${d}T00:00:00.000Z`));
    console.log(
      `  ${tenantName}: cleared ${mine.length} day(s) across ${codes.length} employee(s), re-deriving ${days.length} date(s)`,
    );
    if (WRITE) {
      const res = await applyEvaluatedShiftsForDays({ tenantId, days });
      tally.rebuiltDays += res?.updated ?? 0;
      console.log(`    evaluator: ${JSON.stringify(res)}`);
    }
  });
}

// 3. The single day that carried both corrections needs HR's times back.
for (const o of overlap) {
  const tenantId = TENANTS[o.tenant];
  const fill = PUNCH.find((p) => p.code === o.code && p.date === o.date);
  console.log(`  re-applying punch fill: ${o.code} ${o.date} ${fill.checkIn} -> ${fill.checkOut}`);
  if (!WRITE) continue;
  await mcpCtx.run({ user: { tenantId } }, async () => {
    const emp = await prisma.employee.findFirst({
      where: { employee_code: o.code },
      select: { id: true },
    });
    if (!emp) return;
    await correctAttendanceDay({
      tenantId,
      employeeId: emp.id,
      date: o.date,
      checkIn: fill.checkIn,
      checkOut: fill.checkOut,
      reason:
        "Missing punch resolved from HR AttendanceRecord_Aug2026 (HR-ATT-SHEET-RECONCILE-01, re-applied after colour revert)",
      actorEmployeeId: emp.id,
    });
    tally.refilled++;
  });
}

console.log(
  `\ncleared ${tally.cleared}   re-derived ${tally.rebuiltDays}   punch fills re-applied ${tally.refilled}   failed ${tally.failed.length}`,
);
tally.failed.forEach((f) => console.log(`  ! ${f}`));
if (!WRITE) console.log("\nDry run. Re-run with --write to commit.");

await prisma.$disconnect().catch(() => {});
process.exit(0);
