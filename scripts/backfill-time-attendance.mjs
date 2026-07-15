// scripts/backfill-time-attendance.mjs — enrich the EXISTING time & attendance
// dataset in place. Idempotent: only fills attendance rows that have no
// check_in, only creates time entries for timesheets that have none, and only
// creates a work schedule / overtime rule where none exist. Does NOT wipe.
//
// Convention: check_in/out are stored as naive-local-as-UTC clock times (same
// as the check-in tool, which parses "09:00" → 09:00Z), so a 9am start reads
// as 09:00. Anchored to the live tenant (RBAC Company 1 "Default Company").
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const TENANT = "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007";
const rnd = (n) => Math.floor(Math.random() * n);
const round2 = (n) => Math.round(n * 100) / 100;

// Build a Date on the same calendar day as `d` at h:m:s UTC.
const atClock = (d, h, m) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m, 0));
const addHours = (d, hrs) => new Date(d.getTime() + Math.round(hrs * 3600) * 1000);
const isWeekday = (d) => { const w = d.getUTCDay(); return w !== 0 && w !== 6; };

async function main() {
  const log = (m) => console.log(`[ta-backfill] ${m}`);

  // ---------- 1. Overtime rule (tenant-level, create if none) ----------
  let otRule = await prisma.overtimeRule.findFirst({ where: { tenantId: TENANT } });
  if (!otRule) {
    otRule = await prisma.overtimeRule.create({ data: {
      name: "Standard Overtime Policy",
      description: "1.5x after 8h/day or 40h/week",
      daily_hours_threshold: 8, weekly_hours_threshold: 40,
      daily_overtime_rate: 1.5, weekly_overtime_rate: 1.5,
      max_hours_per_day: 12, max_hours_per_week: 60, is_active: true, tenantId: TENANT,
    } });
    log("created overtime rule");
  } else log("overtime rule already present");

  const emps = await prisma.employee.findMany({
    select: { id: true, hire_date: true, joining_date: true },
  });
  log(`${emps.length} employees loaded`);

  // ---------- 2. Attendance check_in/out/remarks (only rows missing check_in) ----------
  let attPatched = 0;
  const attRows = await prisma.attendance.findMany({
    where: { tenantId: TENANT, check_in: null },
    select: { id: true, date: true, status: true, total_hours: true },
  });
  for (const a of attRows) {
    const data = {};
    if (a.status === "ABSENT") {
      data.total_hours = 0;
      data.remarks = "Absent — no attendance recorded";
    } else {
      const late = a.status === "LATE";
      const baseH = late ? 9 : 9, baseM = late ? 45 + rnd(70) : rnd(18); // late ~09:45-10:55, on-time ~09:00-09:18
      const ci = atClock(a.date, baseH, baseM);
      const hours = round2(a.total_hours && a.total_hours > 0 ? a.total_hours : 8 + Math.random() * 1.5);
      data.check_in = ci;
      data.check_out = addHours(ci, hours);
      data.total_hours = hours;
      data.remarks = late ? "Late arrival" : "On time";
    }
    await prisma.attendance.update({ where: { id: a.id }, data });
    attPatched++;
  }
  log(`attendance rows patched: ${attPatched} (of ${attRows.length} missing check_in)`);

  // ---------- 3. Work schedule per employee (create if none) ----------
  const pattern = {
    monday: "09:00-17:00", tuesday: "09:00-17:00", wednesday: "09:00-17:00",
    thursday: "09:00-17:00", friday: "09:00-17:00", saturday: "off", sunday: "off",
  };
  let wsCreated = 0;
  for (const e of emps) {
    const has = await prisma.workSchedule.count({ where: { employeeId: e.id } });
    if (has > 0) continue;
    const start = e.joining_date || e.hire_date || new Date(Date.now() - 365 * 86400000);
    await prisma.workSchedule.create({ data: {
      employeeId: e.id, schedule_name: "Standard 40h Week",
      effective_start_date: start, total_hours_per_week: 40,
      schedule_pattern: pattern, overtimeRuleId: otRule.id, tenantId: TENANT,
    } });
    wsCreated++;
  }
  log(`work schedules created: ${wsCreated}`);

  // ---------- 4. Time entries for empty timesheets ----------
  const timesheets = await prisma.timesheet.findMany({
    where: { tenantId: TENANT },
    select: { id: true, employeeId: true, period_start: true, period_end: true, total_hours: true },
  });
  let tsFilled = 0, teCreated = 0;
  for (const ts of timesheets) {
    const has = await prisma.timeEntry.count({ where: { timesheetId: ts.id } });
    if (has > 0) continue;
    const entries = [];
    const day = new Date(Date.UTC(ts.period_start.getUTCFullYear(), ts.period_start.getUTCMonth(), ts.period_start.getUTCDate()));
    const end = ts.period_end;
    while (day <= end) {
      if (isWeekday(day)) {
        const start = atClock(day, 9, rnd(15));
        const dur = 8 * 60 + rnd(60); // 8-9h
        entries.push({
          employeeId: ts.employeeId, timesheetId: ts.id,
          work_date: new Date(day), start_time: start, end_time: new Date(start.getTime() + dur * 60000),
          duration_minutes: dur, work_type: "REGULAR", entry_type: "MANUAL_ENTRY",
          note: "Regular working day", tenantId: TENANT,
        });
      }
      day.setUTCDate(day.getUTCDate() + 1);
    }
    if (entries.length) {
      await prisma.timeEntry.createMany({ data: entries });
      teCreated += entries.length; tsFilled++;
    }
  }
  log(`timesheets filled: ${tsFilled}, time entries created: ${teCreated}`);

  log("DONE.");
}

mcpCtx.run({ user: { tenantId: TENANT } }, () => {
  main().then(() => prisma.$disconnect()).then(() => process.exit(0)).catch(async (e) => {
    console.error("TA-BACKFILL ERROR:", e); await prisma.$disconnect(); process.exit(1);
  });
});
