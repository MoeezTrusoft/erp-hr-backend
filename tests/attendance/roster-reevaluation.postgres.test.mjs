// HR-ROSTER-REEVAL-02 (owner, 2026-11-24) — changing a work schedule from a PAST effective date re-evaluates that
// employee's past attendance: the queued jobs, once they run, rewrite the old records to follow the new roster.
import test from "node:test";
import assert from "node:assert/strict";
import { company, people, db, as, ensure, publishRoute, decide } from "./route-fixture.mjs";
const { createWorkSchedule } = await import("../../src/services/workScheduleService.js");
const { drainAttendanceFinalization } = await import("../../src/services/attendanceFinalization.service.js");

const hr = (fn) => as("BOTH", fn);
const day = (d) => new Date(`${d}T00:00:00.000Z`);
const recordOn = (d) =>
  db((tx) => tx.attendance.findUnique({ where: { tenantId_employeeId_date: { tenantId: company, employeeId: people.EMPLOYEE.id, date: day(d) } } }));

test("a roster change from a past date re-evaluates the old attendance records", { timeout: 300000 }, async () => {
  await ensure();
  await publishRoute();
  await db((tx) =>
    tx.workSchedule.create({ data: { tenantId: company, employeeId: people.EMPLOYEE.id, schedule_name: "Day shift", effective_start_date: day("2026-01-01"),
      total_hours_per_week: 40, schedule_pattern: { shift: { from: "09:00", to: "17:00" }, offDays: [6, 7] } } }),
  );
  // Friday 23 Oct 2026 was a working day with no punches, so it was recorded as an absence.
  await db((tx) =>
    tx.attendance.upsert({ where: { tenantId_employeeId_date: { tenantId: company, employeeId: people.EMPLOYEE.id, date: day("2026-10-23") } },
      create: { tenantId: company, employeeId: people.EMPLOYEE.id, date: day("2026-10-23"), status: "ABSENT", day_credit: 0 },
      update: { status: "ABSENT", day_credit: 0, check_in: null, check_out: null } }),
  );
  assert.equal((await recordOn("2026-10-23")).status, "ABSENT");

  // HR moves the employee to a Fri-Sat-Sun-off roster effective 22 Oct (in the past).
  const filed = await hr(() =>
    createWorkSchedule({ tenantId: company, employeeId: people.EMPLOYEE.id, requestedById: people.BOTH.id, schedule_name: "Four-day week",
      effective_start_date: "2026-10-22", total_hours_per_week: 32, schedule_pattern: { shift: { from: "09:00", to: "17:00" }, offDays: [5, 6, 7] },
      changeReason: "Moved to a four-day week from last month" }),
  );
  assert.equal((await decide("ROSTER_CHANGE", filed.requestId)).stage, "APPROVED");

  const queued = await db((tx) =>
    tx.attendanceEvaluationJob.count({ where: { tenantId: company, employeeId: people.EMPLOYEE.id, state: "PENDING", date: day("2026-10-23") } }),
  );
  assert.equal(queued, 1, "the past day is queued for re-evaluation");

  for (let i = 0; i < 20; i++) if (!(await drainAttendanceFinalization({ limit: 500 })).completed) break;
  const after = await recordOn("2026-10-23");
  assert.equal(after.status, "WEEKLY_OFF", "the old absence now follows the new roster");
});
