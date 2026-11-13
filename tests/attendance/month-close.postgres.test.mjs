// Month close against PostgreSQL: the overview says plainly what blocks a month, submitting creates the pending payroll run and
// locks the month's attendance, reopening needs a reason and works only while the run is still pending, an early submit needs a
// reason and a month that has ended, repeated and parallel submits make one run, and another company never sees ours.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { ensure, company, other, people, db, as } from "./route-fixture.mjs";
const { getMonthCloseOverview } = await import("../../src/services/monthClose.service.js");
const { submitTimesheet, unsubmitTimesheet } = await import("../../src/services/timesheetSubmission.service.js");
const { assertAttendancePeriodOpen } = await import("../../src/services/attendancePeriod.service.js");

const hr = (fn) => as("HR", fn);
const setCutoff = (rule) =>
  db(async (tx) => {
    await tx.payrollCalendar.deleteMany({ where: { tenantId: company } });
    await tx.payrollCalendar.create({ data: { tenantId: company, attendanceCutoff: new Date(rule) } });
  });
const submit = (month, extra = {}) => hr(() => submitTimesheet({ tenantId: company, month, actorEmployeeId: people.HR.id, ...extra }));
const reopen = (month, reason = "Late correction needed") => hr(() => unsubmitTimesheet({ tenantId: company, month, actorEmployeeId: people.HR.id, reason }));
const overview = (month, tenantId = company) => as("HR", () => getMonthCloseOverview({ tenantId, month }), tenantId);
const next = (month) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1));
};
const live = (month) => db((tx) => tx.payrollRun.findMany({ where: { tenantId: company, periodStart: { gte: new Date(`${month}-01T00:00:00Z`), lt: next(month) }, status: { notIn: ["CANCELLED", "FAILED"] } } }));
const day = (iso) => db((tx) => assertAttendancePeriodOpen(tx, company, new Date(iso), new Date(iso)));
const check = (o, code) => o.checks.find((c) => c.code === code);
const admin = async (sql, args = []) => {
  const c = new pg.Client({ connectionString: process.env.ASSESSMENT_TEST_ADMIN_URL });
  await c.connect();
  try {
    await c.query("SET session_replication_role = replica");
    return (await c.query(sql, args)).rows;
  } finally {
    await c.end();
  }
};

test("a month must be a real YYYY-MM", async () => {
  await ensure();
  for (const month of ["2026-13", "2026-00", "2026-9", "26-09", "", null, "2026-09-01"]) await assert.rejects(overview(month), /Choose a month/);
});

test("the overview names each gate and agrees with what the submit enforces", async () => {
  await ensure();
  await setCutoff("2026-01-02T23:59:00Z"); // a month's cutoff is the 2nd of the next month
  const o = await overview("2026-03");
  assert.equal(o.submitted, false);
  assert.equal(o.monthEnded, true);
  assert.deepEqual(o.checks.map((c) => c.code), ["CUTOFF", "OPEN_REQUESTS", "ATTENDANCE_COMPLETE", "MONTHLY_INPUTS", "PAYROLL_RUN", "LONG_ABSENCES"]);
  assert.equal(check(o, "CUTOFF").status, "OK");
  assert.equal(check(o, "PAYROLL_RUN").status, "OK");
  const blockers = o.checks.filter((c) => c.status === "BLOCKING");
  assert.equal(o.canSubmit, blockers.length === 0, "the screen enables Submit exactly when nothing blocks");
  const running = await overview("2099-01");
  assert.equal(running.monthEnded, false);
  assert.equal(check(running, "CUTOFF").status, "BLOCKING");
  assert.equal(check(running, "CUTOFF").overridable, false, "a month that has not ended cannot be submitted early");
  assert.equal(running.canSubmit, false);
});

const payrollFor = (included) => db((tx) => tx.employee.updateMany({ where: { tenant_id: company }, data: { payroll_included: included } }));

test("a month with uncalculated attendance is blocked in the overview and refused by the submit, leaving nothing behind", async () => {
  await ensure();
  await setCutoff("2026-01-02T23:59:00Z");
  const o = await overview("2026-03");
  assert.equal(check(o, "ATTENDANCE_COMPLETE").status, "BLOCKING");
  assert.ok(check(o, "ATTENDANCE_COMPLETE").count > 0);
  assert.equal(o.canSubmit, false);
  await assert.rejects(submit("2026-03"), /Attendance is incomplete/);
  assert.equal((await live("2026-03")).length, 0);
  await payrollFor(false); // nobody on payroll: nothing left to calculate, so the next tests can close months
});

test("submitting makes one pending run and locks the month; reopening needs a reason and unlocks it", async () => {
  await ensure();
  await setCutoff("2026-01-02T23:59:00Z");
  const month = "2026-04";
  const first = await submit(month);
  assert.equal(first.created, true);
  assert.equal((await submit(month)).created, false, "a second submit does not stack another run");
  assert.equal((await live(month)).length, 1);
  const o = await overview(month);
  assert.equal(o.submitted, true);
  assert.equal(o.canSubmit, false);
  assert.equal(o.canReopen, true);

  await assert.rejects(day("2026-04-10"), /PERIOD_PROTECTED/, "the month is locked");

  await assert.rejects(reopen(month, " "), /Give a reason/);
  await assert.rejects(reopen(month, "ab"), /Give a reason/);
  assert.equal((await live(month)).length, 1, "a refused reopen changes nothing");
  assert.equal((await reopen(month)).unsubmitted, true);
  assert.equal((await live(month)).length, 0);
  const audit = await db((tx) => tx.payrollAuditLog.findFirst({ where: { tenantId: company, action: "TIMESHEET_UNSUBMITTED" }, orderBy: { id: "desc" } }));
  assert.match(audit.details, /Reason: Late correction needed/);
  await day("2026-04-10");
  assert.equal((await submit(month)).created, true, "the month can be submitted again after the fix");
  await reopen(month, "Cleaning up after the test");
});

test("once payroll is processed the month cannot be reopened or submitted again", async () => {
  await ensure();
  await setCutoff("2026-01-02T23:59:00Z");
  const month = "2026-05";
  const { run } = await submit(month);
  await admin("UPDATE payroll_runs SET status = 'COMPLETED' WHERE id = $1", [run.id]);
  await assert.rejects(reopen(month), /only an unprocessed PENDING run may be unsubmitted/);
  const o = await overview(month);
  assert.equal(check(o, "PAYROLL_RUN").status, "BLOCKING");
  assert.equal(o.canReopen, false);
  assert.equal(o.canSubmit, false);
  await admin("UPDATE payroll_runs SET status = 'CANCELLED' WHERE id = $1", [run.id]);
  assert.equal((await submit(month)).created, true, "a cancelled run no longer blocks a fresh submit");
  await reopen(month, "Cleaning up after the test");
});

test("an early submit needs a reason and a month that has ended, and the reason is kept", async (t) => {
  await ensure();
  const now = new Date();
  // The month just ended, with its cutoff on the 28th of this month: still in the future unless today is the 28th or later.
  if (now.getUTCDate() >= 28) return t.skip("needs a date before the 28th so the cutoff is still ahead");
  await setCutoff("2026-01-28T23:59:00Z");
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const o = await overview(month);
  assert.equal(check(o, "CUTOFF").status, "BLOCKING");
  assert.equal(check(o, "CUTOFF").overridable, true, "an ended month can still be submitted early");
  await assert.rejects(submit(month), /not locked yet/);
  await assert.rejects(submit(month, { force: true }), /Give a reason/);
  await assert.rejects(submit(month, { force: true, reason: "  " }), /Give a reason/);
  await assert.rejects(submit("2099-02", { force: true, reason: "Too early" }), /has not ended yet/);
  assert.equal((await live(month)).length, 0, "refusals leave nothing behind");
  const done = await submit(month, { force: true, reason: "Payroll must run today" });
  assert.equal(done.forced, true);
  const audit = await db((tx) => tx.payrollAuditLog.findFirst({ where: { tenantId: company, action: "TIMESHEET_SUBMITTED", payrollRunId: done.run.id } }));
  assert.match(audit.details, /Reason: Payroll must run today/);
  await reopen(month, "Cleaning up after the test");
});

test("two submits at the same moment make one run, and another company sees none of it", async () => {
  await ensure();
  await setCutoff("2026-01-02T23:59:00Z");
  const month = "2026-07";
  const both = await Promise.allSettled([submit(month), submit(month)]);
  assert.ok(both.every((r) => r.status === "fulfilled"), "neither call fails");
  assert.equal(both.filter((r) => r.value.created).length, 1, "exactly one created it: " + JSON.stringify(both.map((r) => r.value?.created)));
  assert.equal((await live(month)).length, 1);
  const foreign = await overview(month, other);
  assert.equal(foreign.submitted, false, "the other company's month is its own");
  assert.equal(foreign.canReopen, false);
  await reopen(month, "Cleaning up after the test");
});

test.after(() => payrollFor(true));
