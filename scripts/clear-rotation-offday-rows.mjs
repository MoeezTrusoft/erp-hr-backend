// scripts/clear-rotation-offday-rows.mjs — HR-ATT-ROTATING-03 (data repair)
//
// Removes August attendance rows that sit on a rotation REST day.
//
// Writing the rotation phase stops new ones being created, but it does not
// clean what is already there: the evaluator only writes rows for shifts it
// evaluates, and a rest day now produces no shift at all, so the old row simply
// survives untouched ("unchanged: 280, created: 0, updated: 0").
//
// Those rows are artifacts. Their "check-in" is the previous night shift's
// closing scan, which the sessioniser pulled onto the following morning because
// the device stamped it IN — hence rows like `in=11:27 out=null` on a day HR
// marks weekly off, and `in=10:02 out=10:02` zero-length days.
//
// Only days the roster now calls ROTATION_OFF are touched, and only where HR has
// not hand-corrected the row. The underlying punches are never deleted: they
// still belong to the previous day's shift and are re-read from
// attendance_device_punches on any future evaluation.
//
// Dry run unless --write.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
import { resolveWorkingDays } from "../src/services/workingDay.service.js";

const WRITE = process.argv.includes("--write");
const EMG = "61b7eb53-ab6e-413f-9d9a-1ecf4e071e73";
const CODES = ["EMP161", "EMP162", "EMP164", "EMP165", "EMP167", "EMP172"];
const FROM = "2026-08-01";
const TO = "2026-08-31";
const key = (d) => new Date(d).toISOString().slice(0, 10);

await mcpCtx.run({ user: { tenantId: EMG } }, async () => {
  const emps = await prisma.employee.findMany({
    where: { employee_code: { in: CODES } },
    select: { id: true, employee_code: true, employee_name: true },
  });

  let removed = 0;
  let kept = 0;
  for (const e of emps) {
    const working = await resolveWorkingDays({ employeeId: e.id, from: FROM, to: TO });
    const rows = await prisma.attendance.findMany({
      where: {
        employeeId: e.id,
        date: { gte: new Date(`${FROM}T00:00:00.000Z`), lte: new Date(`${TO}T23:59:59.999Z`) },
      },
      select: {
        id: true, date: true, status: true, check_in: true,
        check_out: true, manually_corrected: true,
      },
      orderBy: { date: "asc" },
    });

    const doomed = [];
    for (const r of rows) {
      const info = working.get(key(r.date));
      if (info?.reason !== "ROTATION_OFF") continue;
      if (r.manually_corrected) {
        kept += 1;
        console.log(`      = ${e.employee_code} ${key(r.date)} ${r.status} kept (hand-corrected)`);
        continue;
      }
      doomed.push(r);
    }

    if (doomed.length) {
      console.log(
        `  ${WRITE ? "-" : "."} ${e.employee_code} ${String(e.employee_name).slice(0, 20).padEnd(20)} ` +
          `${doomed.length} rest-day row(s): ` +
          doomed.map((d) => `${key(d.date).slice(5)}/${d.status}`).join(" "),
      );
    }
    if (WRITE && doomed.length) {
      await prisma.attendance.deleteMany({ where: { id: { in: doomed.map((d) => d.id) } } });
    }
    removed += doomed.length;
  }

  console.log(`\n${WRITE ? "removed" : "would remove"} ${removed}   kept (hand-corrected) ${kept}`);
});

if (!WRITE) console.log("\nDry run. Re-run with --write to commit.");
await prisma.$disconnect().catch(() => {});
