// scripts/load-missing-rosters.mjs — HR-ATT-ROTATING-01
//
// Eight employees had no shift start on file, so the evaluator measured them
// against the 09:00 default. Seven are the EMG rotating team, whose 22:00 night
// starts therefore read as thirteen hours late every time.
//
//   EMP161 Asad Hussain   EMP162 Ghulam Rasool   EMP164 Imran Hussain
//   EMP165 Khurram        EMP167 M. Imran Khan   EMP168 M. Zubair
//   EMP172 S. Wajahat Ali
//
// Their workbook rows say "10am/pm - 10am/pm, off after every two days of
// shift" — a 12-hour shift alternating between a 10:00 and a 22:00 start. That
// is stored as rotatingShifts; the arrival decides which applies on the day.
//
// No off-days are set for them. The workbook says the rest day follows the
// rotation rather than the calendar, and inventing a weekday would fabricate
// absences. Days with no punch are simply left without a violation.
//
// EMP206 Akash Nanu (JOC) is a plain fixed roster taken from the workbook.
//
// Dry run unless --write.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const WRITE = process.argv.includes("--write");

const EMG = "61b7eb53-ab6e-413f-9d9a-1ecf4e071e73";
const JOC = "8f4a526f-d45b-4da2-b772-d6682e849812";

const ROTATING = {
  type: "rotating",
  rotatingShifts: [
    { from: "10:00", to: "22:00" },
    { from: "22:00", to: "10:00" },
  ],
  offDays: [],
  shiftHours: 12,
  crossesMidnight: true,
  source: "Employees Workbook.xlsx — '10am/pm - 10am/pm, off after every two days of shift'",
};

const PLAN = [
  { tenantId: EMG, code: "EMP161", pattern: ROTATING },
  { tenantId: EMG, code: "EMP162", pattern: ROTATING },
  { tenantId: EMG, code: "EMP164", pattern: ROTATING },
  { tenantId: EMG, code: "EMP165", pattern: ROTATING },
  { tenantId: EMG, code: "EMP167", pattern: ROTATING },
  { tenantId: EMG, code: "EMP168", pattern: ROTATING },
  { tenantId: EMG, code: "EMP172", pattern: ROTATING },
  {
    tenantId: JOC,
    code: "EMP206",
    pattern: {
      type: "weekly",
      shift: { from: "10:00", to: "22:00" },
      offDays: [7],
      shiftHours: 12,
      crossesMidnight: false,
      source: "Employees Workbook.xlsx",
    },
  },
];

for (const item of PLAN) {
  await mcpCtx.run({ user: { tenantId: item.tenantId } }, async () => {
    const emp = await prisma.employee.findFirst({
      where: { employee_code: item.code },
      select: { id: true, employee_code: true, employee_name: true, first_name: true },
    });
    if (!emp) {
      console.log(`  ! ${item.code} not found`);
      return;
    }
    const sched = await prisma.workSchedule.findFirst({
      where: { employeeId: emp.id },
      orderBy: { effective_start_date: "desc" },
      select: { id: true, schedule_pattern: true },
    });
    const nm = emp.employee_name || emp.first_name || emp.employee_code;
    const kind = item.pattern.rotatingShifts
      ? "rotating 10:00/22:00"
      : `${item.pattern.shift.from}-${item.pattern.shift.to}`;
    console.log(
      `  ${WRITE ? "+" : "."} ${item.code} ${nm.slice(0, 22).padEnd(22)} ${kind}` +
        `${sched ? "" : "   (no work_schedule row — will create)"}`,
    );

    if (!WRITE) return;
    if (sched) {
      await prisma.workSchedule.update({
        where: { id: sched.id },
        data: { schedule_pattern: item.pattern },
      });
    } else {
      await prisma.workSchedule.create({
        data: {
          tenantId: item.tenantId,
          employeeId: emp.id,
          schedule_name: item.pattern.rotatingShifts ? "Rotating 12h" : "Standard",
          effective_start_date: new Date("2026-08-01T00:00:00.000Z"),
          total_hours_per_week: 48,
          schedule_pattern: item.pattern,
        },
      });
    }
  });
}

console.log(WRITE ? "\nrosters written" : "\nDry run. Re-run with --write to commit.");
await prisma.$disconnect().catch(() => {});
process.exit(0);
