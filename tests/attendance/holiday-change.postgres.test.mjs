// Holiday changes and exemptions end to end against PostgreSQL: filed for approval, written only on the final approval,
// effective for past days, re-evaluated, and per-employee exemptions.
import test from "node:test";
import assert from "node:assert/strict";
import { prisma, company, other, people, db, as, ensure, publishRoute, decide, approvalOf, foreignEmployee, dayInfo } from "./route-fixture.mjs";
const { createHoliday, updateHoliday, deleteHoliday, importHolidays, updateHolidayCalendar, updateRegion } =
  await import("../../src/services/holiday.service.js");
const { requestHolidayExemption, listHolidayExemptions } = await import("../../src/services/holidayChangeRequest.service.js");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");

let cal;
const PAST = "2026-10-21"; // a day already evaluated: a holiday must still apply to it
const hr = (fn) => as("BOTH", fn); // the filer is not on the route, so the route still has its two approvers
const file = (args) => hr(() => createHoliday({ holidayCalendarId: cal.id, reason: "Public holiday", ...args }, people.BOTH.id));
const rows = () => db((tx) => tx.holiday.findMany({ where: { tenantId: company, holidayCalendarId: cal.id }, orderBy: { date: "asc" } }));
const jobs = (date) => db((tx) => tx.attendanceEvaluationJob.findMany({ where: { tenantId: company, state: "PENDING", date: new Date(`${date}T00:00:00Z`) } }));
const sourceOf = async (result) => result.requestId;

test("a holiday needs the published attendance route and leaves nothing behind without it", async () => {
  ({ calendar: cal } = await ensure());
  await assert.rejects(file({ name: "Test day", date: PAST }), /Publish the attendance approval route/);
  assert.equal((await rows()).length, 0);
  assert.equal(await db((tx) => tx.holidayChangeRequest.count({ where: { tenantId: company } })), 0, "no orphan request");
  await publishRoute();
});

test("filing rules: reason, names, times, calendar year, duplicates, other companies", async () => {
  await ensure();
  await assert.rejects(file({ name: "Test day", date: PAST, reason: "x" }), /reason/i);
  await assert.rejects(file({ name: " ", date: PAST }), /needs a name/);
  await assert.rejects(file({ name: "Half", date: PAST, fullDay: false }), /Partial holidays require/);
  await assert.rejects(file({ name: "Wrong year", date: "2027-01-05" }), /outside the calendar year/);
  await assert.rejects(as("BOTH", () => createHoliday({ holidayCalendarId: cal.id, name: "No actor", date: PAST, reason: "r" }, undefined)), /employee account/);
  const foreign = await foreignEmployee("EMP-HF");
  const foreignCal = await mcpCtx.run({ user: { tenantId: other } }, () =>
    tenantTransaction(prisma, (tx) => tx.holidayCalendar.create({ data: { tenantId: other, name: "Foreign", year: 2026, createdById: foreign.id } }), { tenantId: other }));
  await assert.rejects(file({ holidayCalendarId: foreignCal.id, name: "Spy", date: PAST }), /calendar not found/i);
  assert.equal((await rows()).length, 0);
});

test("an approved holiday applies to a past day, re-queues evaluation, audits, and stamps the company", async () => {
  await ensure();
  assert.equal((await dayInfo(people.EMPLOYEE.id, PAST)).working, true, "a normal working day before the holiday");
  const result = await file({ name: "Test day", date: PAST });
  assert.equal(result.status, "PENDING");
  assert.equal((await rows()).length, 0, "nothing written while the request waits");
  const { listPendingHolidayRequests } = await import("../../src/services/holidayChangeRequest.service.js");
  const waiting = await hr(() => listPendingHolidayRequests({ tenantId: company }));
  assert.ok(waiting.length >= 1 && waiting.every((w) => w.requestedBy && w.requestedByName), "the asker shows by name as well as code");
  assert.equal((await dayInfo(people.EMPLOYEE.id, PAST)).working, true);
  await assert.rejects(file({ name: "Same day again", date: PAST }), /already a pending holiday request for 2026-10-21/);

  const rec = await decide("HOLIDAY_CHANGE", await sourceOf(result));
  assert.equal(rec.stage, "APPROVED");
  const [holiday] = await rows();
  assert.equal(holiday.tenantId, company);
  assert.equal(holiday.name, "Test day");
  const info = await dayInfo(people.EMPLOYEE.id, PAST);
  assert.deepEqual([info.working, info.reason], [false, "HOLIDAY"], "the past day is now a holiday");
  assert.ok((await jobs(PAST)).length >= 2, "both employees' past day is queued for re-evaluation");
  assert.equal(await db((tx) => tx.payrollAuditLog.count({ where: { tenantId: company, action: "HOLIDAY_CHANGE_APPLIED" } })), 1);
  await assert.rejects(file({ name: "Duplicate", date: PAST }), /already a holiday/);
});

test("a rejected holiday changes nothing", async () => {
  await ensure();
  const before = (await rows()).length;
  const result = await file({ name: "Rejected day", date: "2026-10-23" });
  const rec = await decide("HOLIDAY_CHANGE", await sourceOf(result), "REJECT");
  assert.equal(rec.stage, "REJECTED");
  assert.equal((await rows()).length, before);
  assert.equal((await dayInfo(people.EMPLOYEE.id, "2026-10-23")).working, true);
});

test("an exemption makes one employee work the holiday; restoring brings the holiday back", async () => {
  await ensure();
  const [holiday] = await rows();
  const ask = (employeeIds, mode) => hr(() => requestHolidayExemption({ tenantId: company, requestedById: people.BOTH.id,
    holidayId: holiday.id, employeeIds, mode, reason: "Needed on site" }));
  await assert.rejects(ask([people.EMPLOYEE.id, 99999999]), /belong to this company/);
  await assert.rejects(ask([people.EMPLOYEE.id], "RESTORE"), /Only employees who are exempt/);
  const result = await ask([people.EMPLOYEE.id]);
  const { readApproval } = await import("../../src/services/approval/service.js");
  const waiting = await approvalOf("HOLIDAY_EXEMPTION", result.requestId);
  const shown = await as("HR", () => readApproval({ approvalRef: waiting.id }));
  assert.equal((shown.record ?? shown).title, "Holiday exemption: Test day for 1 employee", "approvers read a title with names");
  assert.equal((await as("HR", () => listHolidayExemptions({ tenantId: company, holidayId: holiday.id }))).length, 0);
  assert.equal((await dayInfo(people.EMPLOYEE.id, PAST)).working, false, "still a holiday while the request waits");
  await decide("HOLIDAY_EXEMPTION", await sourceOf(result));
  assert.equal((await dayInfo(people.EMPLOYEE.id, PAST)).working, true, "exempt employee works the day");
  assert.equal((await dayInfo(people.OTHER.id, PAST)).working, false, "everyone else still has the holiday");
  await assert.rejects(ask([people.EMPLOYEE.id]), /already exempt/);
  assert.ok((await jobs(PAST)).length >= 1);
  const listed = await as("HR", () => listHolidayExemptions({ tenantId: company, holidayId: holiday.id }));
  assert.deepEqual(listed.map((r) => r.code), ["EMP-EMPLOYEE"]);

  const restore = await ask([people.EMPLOYEE.id], "RESTORE");
  await decide("HOLIDAY_EXEMPTION", await sourceOf(restore));
  assert.equal((await dayInfo(people.EMPLOYEE.id, PAST)).working, false, "restored to the holiday");
});

test("changing and removing a holiday; removal waits for pending exemptions", async () => {
  await ensure();
  const [holiday] = await rows();
  const moved = await hr(() => updateHoliday(cal.id, PAST, { date: "2026-10-22", name: "Moved day", reason: "Moved by the government" }, people.BOTH.id));
  await decide("HOLIDAY_CHANGE", await sourceOf(moved));
  assert.equal((await dayInfo(people.EMPLOYEE.id, PAST)).working, true, "the old date is a working day again");
  assert.equal((await dayInfo(people.EMPLOYEE.id, "2026-10-22")).working, false, "the new date is the holiday");

  const pendingExemption = await hr(() => requestHolidayExemption({ tenantId: company, requestedById: people.BOTH.id,
    holidayId: holiday.id, employeeIds: [people.EMPLOYEE.id], reason: "Needed" }));
  const removal = await hr(() => deleteHoliday(cal.id, "2026-10-22", people.BOTH.id, "No longer a holiday"));
  await assert.rejects(decide("HOLIDAY_CHANGE", await sourceOf(removal)), /pending exemption requests/);
  await decide("HOLIDAY_EXEMPTION", await sourceOf(pendingExemption), "REJECT");
  // The refused approval left the removal undecided, still waiting at the deciding level.
  const ar = await approvalOf("HOLIDAY_CHANGE", await sourceOf(removal));
  assert.equal(ar.stage, "LEVEL");
});

test("an import is one request, written once on approval, and refuses clashes", async () => {
  await ensure();
  const result = await hr(() => importHolidays(cal.id, [
    { name: "A", date: "2026-11-02" }, { name: "B", date: "2026-11-03" }, { name: "C", date: "2026-11-04", fullDay: false, startTime: "09:00", endTime: "12:00" },
  ], people.BOTH.id, "Annual import"));
  assert.equal(await db((tx) => tx.holidayChangeRequest.count({ where: { tenantId: company, status: "PENDING", action: "CREATE" } })), 1);
  await decide("HOLIDAY_CHANGE", await sourceOf(result));
  assert.equal((await rows()).filter((r) => ["A", "B", "C"].includes(r.name)).length, 3);
  await assert.rejects(hr(() => importHolidays(cal.id, [{ name: "Again", date: "2026-11-02" }], people.BOTH.id)), /already a holiday/);
  await assert.rejects(hr(() => importHolidays(cal.id, [{ name: "X", date: "2026-11-09" }, { name: "Y", date: "2026-11-09" }], people.BOTH.id)), /already a holiday/);
});

test("a holiday in a month with payroll cannot be changed; calendar and region edits still work", async () => {
  await ensure();
  await db((tx) => tx.payrollRun.create({ data: { tenantId: company, processedBy: people.HR.id, periodStart: new Date("2026-12-01T00:00:00Z"),
    periodEnd: new Date("2026-12-31T00:00:00Z"), countryCode: "PK", currencyCode: "PKR", status: "COMPLETED", totalGross: 1, totalNet: 1 } }));
  await assert.rejects(file({ name: "December day", date: "2026-12-10" }), /Recall or cancel the affected payroll run/);
  // Calendar edits are plain configuration (they used to throw "assignBy is not defined" after writing).
  const updated = await as("HR", () => updateHolidayCalendar(cal.id, { description: "2026 calendar" }, people.HR.id));
  assert.equal(updated.description, "2026 calendar");
  assert.equal(typeof updateRegion, "function");
});
