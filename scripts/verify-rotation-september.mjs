// scripts/verify-rotation-september.mjs — HR-ATT-ROTATING-03 (read-only)
//
// Does the 3-day rotation carry on across the month boundary, or reset?
//
// The phase was derived from HR's AUGUST workbook and anchored at 2026-08-01.
// Extending it into September is an assumption until it is checked, and the
// cost of being wrong is deleting real attendance from a day somebody worked.
//
// The test: on the days the cycle predicts as REST, did the employee punch?
// A rest day should be quiet. A predicted rest day full of punches means the
// rotation slipped and the phase must be re-derived, not extended.
//
// Read-only. Nothing here writes.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const EMG = "61b7eb53-ab6e-413f-9d9a-1ecf4e071e73";
const CODES = ["EMP161", "EMP162", "EMP164", "EMP165", "EMP167", "EMP172"];
const ANCHOR = Date.UTC(2026, 7, 1); // 2026-08-01
const DAY = 86_400_000;
const from = process.argv[2] ?? "2026-09-01";
const to = process.argv[3] ?? "2026-09-30";

const phaseOf = (iso) => {
  const d = new Date(`${iso}T00:00:00.000Z`);
  const diff = Math.round(
    (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ANCHOR) / DAY,
  );
  return ((diff % 3) + 3) % 3;
};

await mcpCtx.run({ user: { tenantId: EMG } }, async () => {
  const emps = await prisma.employee.findMany({
    where: { employee_code: { in: CODES } },
    select: {
      id: true, employee_code: true, employee_name: true,
      WorkSchedule: {
        select: { schedule_pattern: true, effective_start_date: true },
        orderBy: { effective_start_date: "desc" },
        take: 1,
      },
    },
  });

  for (const e of emps) {
    const cycle = e.WorkSchedule?.[0]?.schedule_pattern?.cycle;
    if (!cycle) {
      console.log(`  ${e.employee_code} no cycle on file — skipped`);
      continue;
    }
    const punches = await prisma.attendanceDevicePunch.findMany({
      where: {
        employeeId: e.id,
        punchedAt: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T23:59:59.999Z`) },
      },
      select: { punchedAt: true },
    });

    // Discriminator: a rest day may carry the TAIL of the previous night's
    // shift (a scan around 10:00), but it cannot contain an arrival. So count
    // punches from noon onward — a day shift arrives at 10:00 and leaves at
    // 22:00, a night shift arrives at 22:00; both put a punch after noon.
    // Attributing pre-noon punches to "yesterday" instead does not work: a
    // 10:00 punch is either a night shift closing or a day shift opening, and
    // that is the very ambiguity under investigation.
    const eveningByDay = new Map();
    for (const p of punches) {
      const t = new Date(p.punchedAt);
      if (t.getUTCHours() < 12) continue;
      const k = t.toISOString().slice(0, 10);
      eveningByDay.set(k, (eveningByDay.get(k) ?? 0) + 1);
    }

    const restWorked = [];
    const restQuiet = [];
    const workDaysWithEvening = [];
    for (
      let d = new Date(`${from}T00:00:00.000Z`);
      d <= new Date(`${to}T00:00:00.000Z`);
      d = new Date(d.getTime() + DAY)
    ) {
      const k = d.toISOString().slice(0, 10);
      const isRest = phaseOf(k) === Number(cycle.offIndex);
      const evening = eveningByDay.get(k) ?? 0;
      if (isRest) (evening ? restWorked : restQuiet).push(k.slice(5));
      else if (evening) workDaysWithEvening.push(k);
    }

    const verdict = restWorked.length === 0 ? "HOLDS" : "SLIPPED";
    console.log(
      `  ${e.employee_code} ${String(e.employee_name).slice(0, 20).padEnd(20)} phase=${cycle.offIndex} ` +
        `${verdict}  rest_quiet=${restQuiet.length} rest_with_evening_punch=${restWorked.length} ` +
        `work_days_with_evening=${workDaysWithEvening.length}` +
        `${restWorked.length ? `  -> ${restWorked.join(" ")}` : ""}`,
    );
  }
});

await prisma.$disconnect().catch(() => {});
