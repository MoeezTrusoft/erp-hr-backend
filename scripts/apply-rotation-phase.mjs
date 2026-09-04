// scripts/apply-rotation-phase.mjs — HR-ATT-ROTATING-03
//
// Writes the rotation PHASE for the six EMG rotating staff, then re-evaluates
// August so their rest days stop reading as absences and missing check-outs.
//
// The phase comes from HR's final August workbook. Their "weekly off" colour,
// read per employee, falls on a clean 3-day cycle — each of the six has exactly
// ONE residue mod 3 and no other, which is the "2 days on, 1 off" the operator
// described:
//
//   G Rasool, Khurram   off 01 04 07 10 13 16 19 22 25 28 31   phase 0
//   Wajahat             off 02 05 08 11 14 17 20 23 26 29      phase 1
//   Asad, Imran H,      off 03 06 09 12 15 18 21 24 27 30      phase 2
//   M. Imran
//
// This reads HR's sheet for a ROSTER FACT — which days the person was scheduled
// — not for a verdict. Their late/absent judgements stay ours to derive; an
// earlier pass that trusted those had to be reverted.
//
// M. Zubair (EMP168) appears on no grid in the workbook, so his phase is
// unknown and he is deliberately left without a cycle: HR-ATT-ROTATING-02's
// suppression keeps him from being marked absent on a rest day.
//
// Dry run unless --write.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
import { applyEvaluatedShiftsForDays } from "../src/services/attendanceWriter.service.js";

const WRITE = process.argv.includes("--write");
const EMG = "61b7eb53-ab6e-413f-9d9a-1ecf4e071e73";

const PHASE = {
  EMP162: 0, // Ghulam Rasool
  EMP165: 0, // Khurram
  EMP172: 1, // S. Wajahat Ali
  EMP161: 2, // Asad Hussain
  EMP164: 2, // Imran Hussain
  EMP167: 2, // M. Imran Khan
};

const CYCLE = { days: 3, anchor: "2026-08-01" };
const ROTATING_SHIFTS = [
  { from: "10:00", to: "22:00" },
  { from: "22:00", to: "10:00" },
];

await mcpCtx.run({ user: { tenantId: EMG } }, async () => {
  const codes = Object.keys(PHASE);
  const emps = await prisma.employee.findMany({
    where: { employee_code: { in: codes } },
    select: { id: true, employee_code: true, employee_name: true },
  });
  const byCode = new Map(emps.map((e) => [e.employee_code, e]));

  for (const [code, offIndex] of Object.entries(PHASE)) {
    const emp = byCode.get(code);
    if (!emp) {
      console.log(`  ! ${code} not found`);
      continue;
    }
    const sched = await prisma.workSchedule.findFirst({
      where: { employeeId: emp.id },
      orderBy: { effective_start_date: "desc" },
      select: { id: true, schedule_pattern: true },
    });

    const pattern = {
      ...(sched?.schedule_pattern ?? {}),
      type: "rotating",
      rotatingShifts: sched?.schedule_pattern?.rotatingShifts ?? ROTATING_SHIFTS,
      offDays: [],
      shiftHours: 12,
      crossesMidnight: true,
      cycle: { ...CYCLE, offIndex },
      source:
        "Rotation phase derived from AttendanceRecord_Aug2026.xlsx 'weekly off' marks (HR-ATT-ROTATING-03)",
    };

    console.log(
      `  ${WRITE ? "+" : "."} ${code} ${(emp.employee_name ?? "").slice(0, 22).padEnd(22)} ` +
        `phase ${offIndex} (off when (day - 1 Aug) % 3 == ${offIndex})` +
        `${sched ? "" : "   (no work_schedule row — will create)"}`,
    );
    if (!WRITE) continue;

    if (sched) {
      await prisma.workSchedule.update({
        where: { id: sched.id },
        data: { schedule_pattern: pattern },
      });
    } else {
      await prisma.workSchedule.create({
        data: {
          tenantId: EMG,
          employeeId: emp.id,
          schedule_name: "Rotating 12h (2 on, 1 off)",
          effective_start_date: new Date("2026-08-01T00:00:00.000Z"),
          total_hours_per_week: 48,
          schedule_pattern: pattern,
        },
      });
    }
  }

  if (WRITE) {
    // Re-derive August: the rest days must stop producing a verdict at all.
    const days = [];
    for (let d = 1; d <= 31; d += 1) {
      days.push(new Date(Date.UTC(2026, 7, d)));
    }
    const res = await applyEvaluatedShiftsForDays({ tenantId: EMG, days });
    console.log(`\nevaluator re-run for August: ${JSON.stringify(res)}`);
  }
});

console.log(WRITE ? "\nphases written" : "\nDry run. Re-run with --write to commit.");
await prisma.$disconnect().catch(() => {});
