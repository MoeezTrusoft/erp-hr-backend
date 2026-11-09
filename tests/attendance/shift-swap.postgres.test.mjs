// Shift swaps end to end against PostgreSQL: filed by the employee (or by HR for them), routed through the
// company's published ATTENDANCE approval route, applied to the roster only on the final approval, then re-evaluated.
import test from "node:test";
import assert from "node:assert/strict";

const url = process.env.ASSESSMENT_TEST_DATABASE_URL;
if (!url || new URL(url).hostname !== "127.0.0.1" || new URL(url).pathname !== "/hr_task_assessment_test")
  throw new Error("Use the isolated local HR test database");
process.env.DATABASE_URL = url;
process.env.NODE_ENV = "test";
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");

const { prisma, company, other, people, db, as, act, setup } = await import("../approval/fixtures.mjs");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const matrix = await import("../../src/services/approvalMatrix.service.js");
const { createShiftSwap } = await import("../../src/services/shiftTemplateSwap.service.js");

let ready;
const ensure = () => (ready ||= prepare());
const PAST = "2026-10-20"; // a past day: finishing the swap must re-queue attendance evaluation
const tenant = (fn) => mcpCtx.run({ user: { tenantId: company } }, fn);
const level = (name, action, who) => ({ name, action, approverMode: "NAMED", approverIds: [people[who].id] });

async function prepare() {
  await setup();
  // A second rostered employee on a later shift, and a third who is off on the weekend day used by the two-day test.
  await db(async (tx) => {
    const v1 = await tx.attendanceSetupRelease.findFirst({ where: { tenantId: company, version: 1 } });
    const config = structuredClone(v1.config);
    config.version = 2;
    config.employees.push({ id: people.OTHER.id, payroll_included: true, hire_date: "2026-01-01" });
    config.schedules.push({
      employeeId: people.OTHER.id,
      effective_start_date: "2026-01-01",
      schedule_pattern: { shift: { from: "17:00", to: "23:00" }, offDays: [] },
    });
    await tx.attendanceSetupRelease.create({
      data: { tenantId: company, version: 2, effectiveFrom: new Date("2026-01-01"),
        coverageThrough: new Date("2027-12-31"), reason: "Swap fixture", config },
    });
  });
}
const file = (who, args, opts = {}) =>
  as(who, () => createShiftSwap({ targetId: people.OTHER.id, ...args }, company, { today: new Date("2026-10-01"), ...opts }));
const approvalOf = (swapId) =>
  db((tx) => tx.hrApprovalRequest.findFirst({ where: { tenantId: company, kind: "SHIFT_SWAP", sourceRef: String(swapId) } }));
const assignments = () => db((tx) => tx.shiftAssignment.findMany({ where: { tenantId: company }, orderBy: { id: "asc" } }));
const swapRows = () => db((tx) => tx.shiftSwapRequest.findMany({ where: { tenantId: company } }));

test("a swap needs the published attendance route, and leaves nothing behind without it", async () => {
  await ensure();
  await assert.rejects(file("EMPLOYEE", { requesterId: people.EMPLOYEE.id, fromDate: PAST }), /Publish the attendance approval route/);
  assert.equal((await swapRows()).length, 0, "no orphan request after a refused submission");
  await tenant(() => matrix.saveApprovalMatrixDraft({ tenantId: company, actorId: "t", kind: "ATTENDANCE",
    levels: [level("HR check", "VERIFY", "HR"), level("Management", "APPROVE", "MANAGEMENT")] }));
  await tenant(() => matrix.publishApprovalMatrix({ tenantId: company, actorId: "t", kind: "ATTENDANCE", reason: "swap tests" }));
});

test("filing rules: self, colleague, dates, duplicates, other companies", async () => {
  await ensure();
  const base = { requesterId: people.EMPLOYEE.id, fromDate: PAST };
  await assert.rejects(file("EMPLOYEE", { ...base, targetId: people.EMPLOYEE.id }), /yourself/);
  await assert.rejects(file("EMPLOYEE", { ...base, targetId: "" }), /Choose the colleague/);
  await assert.rejects(file("EMPLOYEE", { ...base, targetId: "", targetCode: "EMP-NOBODY" }), /No active employee with that code/);
  await assert.rejects(file("EMPLOYEE", { ...base, fromDate: "nope" }), /Valid fromDate/);
  await assert.rejects(file("EMPLOYEE", { ...base, toDate: "2026-12-30" }), /within 31 days/);
  await assert.rejects(file("EMPLOYEE", { ...base, fromDate: "2026-09-01" }, { today: new Date("2026-10-01") }), /cannot start in the past/);
  // Created inside the OTHER company's own context (a company-bound write would be stamped with this company).
  const foreign = await mcpCtx.run({ user: { tenantId: other } }, () =>
    tenantTransaction(prisma, (tx) => tx.employee.create({ data: { tenant_id: other, employee_code: "EMP-F",
      employeeCategory: "EMPLOYEE", userId: 100000 + Math.floor(Math.random() * 1e8), first_name: "Fictional",
      status: "Active", employement_status: "Active", hire_date: new Date("2026-01-01") } }), { tenantId: other }));
  await assert.rejects(file("EMPLOYEE", { ...base, targetId: foreign.id }), /belong to this company/);
  assert.equal((await swapRows()).length, 0);
});

test("a swap changes the roster only at final approval, then re-evaluates the days", async () => {
  await ensure();
  const swap = await file("EMPLOYEE", { requesterId: people.EMPLOYEE.id, fromDate: PAST, reason: "Family event" });
  assert.equal(swap.status, "PENDING");
  assert.equal(swap.requester, "EMP-EMPLOYEE", "the code stays for compatibility");
  assert.equal(swap.requesterName, "Fictional", "and the person's name is there for the screen");
  assert.equal((await assignments()).length, 0, "nothing on the roster while the request is pending");
  await assert.rejects(file("EMPLOYEE", { requesterId: people.EMPLOYEE.id, fromDate: PAST }), /already has a pending swap/);

  const ar = await approvalOf(swap.id);
  assert.ok(ar?.route?.levels?.length === 2, "the request sealed the published attendance route");
  let rec = await act("HR", { approvalRef: ar.id, version: ar.version }, "VERIFY");
  assert.equal((await assignments()).length, 0, "still nothing after the verification level");
  rec = await act("MANAGEMENT", rec, "APPROVE");
  assert.equal(rec.stage, "APPROVED");

  const rows = await assignments();
  const of = (id) => rows.find((r) => r.employeeId === id);
  assert.deepEqual([of(people.EMPLOYEE.id)?.fromTime, of(people.EMPLOYEE.id)?.toTime], ["17:00", "23:00"]);
  assert.deepEqual([of(people.OTHER.id)?.fromTime, of(people.OTHER.id)?.toTime], ["09:00", "17:00"]);
  assert.equal((await swapRows())[0].status, "APPROVED");
  const jobs = await db((tx) => tx.attendanceEvaluationJob.findMany({ where: { tenantId: company, state: "PENDING" } }));
  assert.equal(jobs.length, 2, "both employees' past day is queued for re-evaluation");
  const audit = await db((tx) => tx.payrollAuditLog.findMany({ where: { tenantId: company, action: "SHIFT_SWAP_APPLIED" } }));
  assert.equal(audit.length, 1);
});

test("a rejected swap changes nothing; a stale swap cannot be approved", async () => {
  await ensure();
  const before = (await assignments()).length;
  const rejected = await file("EMPLOYEE", { requesterId: people.EMPLOYEE.id, fromDate: "2026-10-21" });
  let ar = await approvalOf(rejected.id);
  let rec = await act("HR", { approvalRef: ar.id, version: ar.version }, "VERIFY");
  rec = await act("MANAGEMENT", rec, "REJECT");
  assert.equal(rec.stage, "REJECTED");
  assert.equal((await swapRows()).find((r) => r.id === rejected.id).status, "REJECTED");
  assert.equal((await assignments()).length, before);

  // Filed on a day both work different shifts, then the roster moves so both have the same shift before approval.
  const stale = await file("EMPLOYEE", { requesterId: people.EMPLOYEE.id, fromDate: "2026-10-22" });
  await db(async (tx) => {
    for (const id of [people.EMPLOYEE.id, people.OTHER.id])
      await tx.shiftAssignment.create({ data: { tenantId: company, employeeId: id, date: new Date("2026-10-22T00:00:00Z"),
        status: "on_shift", fromTime: "10:00", toTime: "18:00" } });
  });
  ar = await approvalOf(stale.id);
  rec = await act("HR", { approvalRef: ar.id, version: ar.version }, "VERIFY");
  await assert.rejects(act("MANAGEMENT", rec, "APPROVE"), /same shift/);
  assert.equal((await swapRows()).find((r) => r.id === stale.id).status, "PENDING", "a refused approval leaves the request undecided");
});

test("a past swap is refused once payroll has a run for that period", async () => {
  await ensure();
  const swap = await file("EMPLOYEE", { requesterId: people.EMPLOYEE.id, fromDate: "2026-10-23" });
  await db((tx) => tx.payrollRun.create({ data: { tenantId: company, processedBy: people.HR.id,
    periodStart: new Date("2026-10-01T00:00:00Z"), periodEnd: new Date("2026-10-31T00:00:00Z"), countryCode: "PK",
    currencyCode: "PKR", status: "COMPLETED", totalGross: 1, totalNet: 1 } }));
  const ar = await approvalOf(swap.id);
  const rec = await act("HR", { approvalRef: ar.id, version: ar.version }, "VERIFY");
  await assert.rejects(act("MANAGEMENT", rec, "APPROVE"), /Recall or cancel the affected payroll run/);
});

test("HR may file for an employee, including for a past day (a filer who is not on the route)", async () => {
  await ensure();
  const swap = await file("BOTH", { requesterId: people.EMPLOYEE.id, fromDate: "2026-09-02" }, { onBehalf: true });
  assert.equal(swap.status, "PENDING");
  assert.equal(swap.requester, "EMP-EMPLOYEE");
});
