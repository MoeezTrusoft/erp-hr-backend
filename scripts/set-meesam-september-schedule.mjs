// HR-ATT-SCHEDULE-2026-09-07 — Meesam rehire roster correction.
// Dry run unless --write. The previous schedule is closed the day before the
// rehire schedule starts; attendance history is never rewritten here.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const TENANT = "40314ef4-0a81-4390-b631-b3ad3f21f523";
const WRITE = process.argv.includes("--write");
const START = new Date("2026-09-07T00:00:00.000Z");
const PREVIOUS_END = new Date("2026-09-06T00:00:00.000Z");
const PATTERN = {
  type: "weekly",
  shift: { from: "09:00", to: "17:00" },
  offDays: [6, 7],
  shiftHours: 8,
  crossesMidnight: false,
  source: "HR instruction: Meesam re-hired 2026-09-07; Monday-Friday 09:00-17:00",
};

await mcpCtx.run({ user: { tenantId: TENANT }, system: true }, async () => {
  const employees = await prisma.employee.findMany({
    where: { tenant_id: TENANT },
    select: { id: true, employee_code: true, employee_name: true, first_name: true, last_name: true },
  });
  const matches = employees.filter((e) => /meesam/i.test(e.employee_name || `${e.first_name || ""} ${e.last_name || ""}`));
  if (matches.length !== 1) throw new Error(`Expected exactly one Trusoft Meesam, found ${matches.length}`);
  const employee = matches[0];
  const schedules = await prisma.workSchedule.findMany({
    where: { tenantId: TENANT, employeeId: employee.id },
    orderBy: { effective_start_date: "asc" },
  });
  console.log(`${WRITE ? "Writing" : "Would write"} schedule for ${employee.employee_name || employee.first_name} (${employee.id})`);
  console.log(`Existing schedules: ${schedules.map((s) => `#${s.id} ${s.effective_start_date.toISOString().slice(0, 10)}..${s.effective_end_date?.toISOString().slice(0, 10) || "open"}`).join(", ") || "none"}`);
  if (!WRITE) return;

  const current = schedules.find((s) => s.effective_start_date <= START && (s.effective_end_date == null || s.effective_end_date >= START));
  if (current) {
    await prisma.workSchedule.update({
      where: { id: current.id },
      data: { effective_end_date: PREVIOUS_END },
    });
  }
  const existing = schedules.find((s) => s.effective_start_date.getTime() === START.getTime());
  if (existing) {
    await prisma.workSchedule.update({
      where: { id: existing.id },
      data: { schedule_name: "Meesam Rehire 09:00-17:00", effective_end_date: null, total_hours_per_week: 40, schedule_pattern: PATTERN },
    });
  } else {
    await prisma.workSchedule.create({
      data: { tenantId: TENANT, employeeId: employee.id, schedule_name: "Meesam Rehire 09:00-17:00", effective_start_date: START, effective_end_date: null, total_hours_per_week: 40, schedule_pattern: PATTERN },
    });
  }
  console.log("Meesam schedule written: 2026-09-07 onward, Mon-Fri, 09:00-17:00 PKT");
});
await prisma.$disconnect().catch(() => {});
