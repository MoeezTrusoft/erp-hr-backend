// Roster changes end to end against PostgreSQL: HR files, the attendance route approves, the roster is written (and
// the affected past days re-queued) only on the final approval; direct writes no longer bypass it.
import test from "node:test";
import assert from "node:assert/strict";
import { company, people, db, as, ensure, publishRoute, decide, approvalOf, dayInfo } from "./route-fixture.mjs";
const { createWorkSchedule, updateWorkSchedule, deleteWorkSchedule } = await import("../../src/services/workScheduleService.js");

const base = (over = {}) => ({
  tenantId: company, employeeId: people.EMPLOYEE.id, requestedById: people.BOTH.id,
  schedule_name: "Late shift", effective_start_date: "2026-10-15", total_hours_per_week: 40,
  schedule_pattern: { shift: { from: "10:00", to: "18:00" }, offDays: [6, 7] }, changeReason: "Team moved to the late shift", ...over,
});
const hr = (fn) => as("BOTH", fn);
const schedules = () => db((tx) => tx.workSchedule.findMany({ where: { tenantId: company, employeeId: people.EMPLOYEE.id }, orderBy: { effective_start_date: "asc" } }));
const requests = (status) => db((tx) => tx.rosterChangeRequest.findMany({ where: { tenantId: company, ...(status ? { status } : {}) } }));
const prepareRoster = async () => {
  await ensure();
  if (!(await schedules()).length)
    await db((tx) => tx.workSchedule.create({ data: { tenantId: company, employeeId: people.EMPLOYEE.id, schedule_name: "Day shift",
      effective_start_date: new Date("2026-01-01"), total_hours_per_week: 40, schedule_pattern: { shift: { from: "09:00", to: "17:00" }, offDays: [6, 7] } } }));
};

test("a roster change needs the route, a reason and a signed-in employee; nothing is left behind", async () => {
  await prepareRoster();
  await assert.rejects(hr(() => createWorkSchedule(base())), /Publish the attendance approval route/);
  assert.equal((await requests()).length, 0);
  await publishRoute();
  await assert.rejects(hr(() => createWorkSchedule(base({ changeReason: " " }))), /reason/i);
  await assert.rejects(hr(() => createWorkSchedule(base({ requestedById: null }))), /employee account/);
  await assert.rejects(hr(() => createWorkSchedule(base({ schedule_pattern: { offDays: [9], shift: { from: "9", to: "17" } } }))), /offDays|invalid|schedule/i);
  assert.equal((await requests()).length, 0, "an impossible change is refused when filed, not at the last level");
});

test("the roster changes only on the final approval, then the past days are re-queued", async () => {
  await prepareRoster();
  const result = await hr(() => createWorkSchedule(base()));
  assert.equal(result.pendingApproval, true);
  const { listPendingRosterChanges } = await import("../../src/services/rosterChangeRequest.service.js");
  const waiting = await hr(() => listPendingRosterChanges({ tenantId: company }));
  assert.equal(waiting.length, 1);
  assert.ok(waiting[0].employee && waiting[0].requestedBy, "the codes stay for compatibility");
  assert.ok(waiting[0].employeeName && waiting[0].requestedByName, "and the people's names are there for the screen");
  assert.equal((await schedules()).length, 1, "the roster is untouched while the request waits");
  assert.equal((await dayInfo(people.EMPLOYEE.id, "2026-10-20")).shift.start.toISOString().slice(11, 16), "09:00");
  await assert.rejects(hr(() => createWorkSchedule(base({ effective_start_date: "2026-11-20" }))), /already has a roster change waiting/);

  assert.equal((await decide("ROSTER_CHANGE", result.requestId)).stage, "APPROVED");
  const rows = await schedules();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].effective_end_date.toISOString().slice(0, 10), "2026-10-14", "the old version closes the day before");
  assert.equal(rows[1].schedule_name, "Late shift");
  assert.equal((await dayInfo(people.EMPLOYEE.id, "2026-10-20")).shift.start.toISOString().slice(11, 16), "10:00", "a past day now follows the new roster");
  const queued = await db((tx) => tx.attendanceEvaluationJob.count({ where: { tenantId: company, employeeId: people.EMPLOYEE.id, state: "PENDING", date: { gte: new Date("2026-10-15T00:00:00Z") } } }));
  assert.ok(queued >= 20, `past days re-queued (${queued})`);
  assert.equal(await db((tx) => tx.payrollAuditLog.count({ where: { tenantId: company, action: "ROSTER_CHANGE_APPLIED" } })), 1);
});

test("a rejected roster change leaves the roster alone", async () => {
  await prepareRoster();
  const before = (await schedules()).length;
  const rejected = await hr(() => createWorkSchedule(base({ effective_start_date: "2026-11-25" })));
  assert.equal((await decide("ROSTER_CHANGE", rejected.requestId, "REJECT")).stage, "REJECTED");
  assert.equal((await schedules()).length, before);
  assert.equal((await requests("REJECTED")).length, 1);
});

test("an edit or a delete of an existing version is a request too; history cannot be deleted", async () => {
  await prepareRoster();
  const [first, second] = await schedules();
  await assert.rejects(hr(() => deleteWorkSchedule(first.id, people.BOTH.id, company, 'Cleanup')), /Historical rosters/);
  await assert.rejects(hr(() => updateWorkSchedule(999999, { schedule_name: "x", changeReason: "typo" }, people.BOTH.id, company)), /not found/i);
  const edit = await hr(() => updateWorkSchedule(second.id, { schedule_name: "Late shift (renamed)", changeReason: "Rename for clarity" }, people.BOTH.id, company));
  assert.equal(edit.action, "UPDATE");
  assert.equal((await schedules())[1].schedule_name, "Late shift", "not changed until approved");
  await decide("ROSTER_CHANGE", edit.requestId);
  assert.equal((await schedules())[1].schedule_name, "Late shift (renamed)");
});

test("a preview stays immediate and writes nothing", async () => {
  await prepareRoster();
  const before = (await schedules()).length;
  const preview = await hr(() => createWorkSchedule(base({ effective_start_date: "2026-12-05", dryRun: true })));
  assert.ok(preview.previewToken, "the preview carries its review token");
  assert.equal((await schedules()).length, before);
  assert.equal((await requests("PENDING")).length, 0);
});

test("a change touching a month with payroll is refused when filed and when approved", async () => {
  await prepareRoster();
  const waiting = await hr(() => createWorkSchedule(base({ effective_start_date: "2026-12-12" })));
  await db((tx) => tx.payrollRun.create({ data: { tenantId: company, processedBy: people.HR.id, periodStart: new Date("2026-12-01T00:00:00Z"),
    periodEnd: new Date("2026-12-31T00:00:00Z"), countryCode: "PK", currencyCode: "PKR", status: "COMPLETED", totalGross: 1, totalNet: 1 } }));
  await assert.rejects(decide("ROSTER_CHANGE", waiting.requestId), /Recall or cancel the affected payroll run/);
  assert.equal((await approvalOf("ROSTER_CHANGE", waiting.requestId)).stage, "LEVEL");
  await assert.rejects(hr(() => createWorkSchedule(base({ effective_start_date: "2026-12-20" }))), /already has a roster change waiting|Recall or cancel/);
});
