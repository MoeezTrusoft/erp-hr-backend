// HR-LEAVE-DATES-01 (owner, 2026-11-24) — a leave request may name individual dates (ranges and gaps, e.g. 1-3, 6,
// 12-14) instead of one range. Only those dates are requested, approved, marked ON_LEAVE and given back on cancel;
// two requests may sit in each other's gaps. Runs on the isolated Postgres test database.
import test from "node:test";
import assert from "node:assert/strict";
import { f, company, people, db, as, act, ensure, publishRoute, decide } from "./route-fixture.mjs";
const svc = await import("../../src/services/leaveChangeRequest.service.js");
const leave = await import("../../src/services/leave.service.js");

const key = (d) => new Date(d).toISOString().slice(0, 10);
const day = (d) => new Date(`${d}T00:00:00.000Z`);
const create = (dates) =>
  as("EMPLOYEE", () => leave.createLeaveRequest({ employeeId: people.EMPLOYEE.id, dates, allowPastDates: true, reason: "Picked dates" }, people.EMPLOYEE.id, company));
const daysOf = (id) => db((tx) => tx.leaveRequestDay.findMany({ where: { leaveRequestId: id }, orderBy: { date: "asc" } })).then((r) => r.map((x) => key(x.date)));
const marks = (from, to) =>
  db((tx) => tx.attendance.findMany({ where: { tenantId: company, employeeId: people.EMPLOYEE.id, date: { gte: day(from), lte: day(to) }, status: "ON_LEAVE" }, orderBy: { date: "asc" } })).then((r) => r.map((x) => key(x.date)));

async function approve(row, policyId) {
  await db((tx) => tx.leaveRequest.update({ where: { id: row.id }, data: { leavePolicyId: policyId } }));
  const s = { kind: "LEAVE", ref: String(row.id), id: row.id };
  let a = await f.submit(s);
  a = await act("MANAGER", a, "RECOMMEND_APPROVAL");
  a = await act("HR", a, "VERIFY");
  return act("MANAGEMENT", a, "APPROVE");
}

test("HR-LEAVE-DATES-01 selected dates", { timeout: 300000 }, async (t) => {
  await ensure();
  await publishRoute();
  const paid = await db((tx) => tx.leavePolicy.findFirst({ where: { tenantId: company, name: "Annual" } }));
  await db((tx) => tx.leaveBalance.upsert({ where: { employeeId_leavePolicyId: { employeeId: people.EMPLOYEE.id, leavePolicyId: paid.id } }, create: { tenantId: company, employeeId: people.EMPLOYEE.id, leavePolicyId: paid.id, balance: 20 }, update: { balance: 20 } }));
  let a, b;

  await t.test("a range with gaps is one request holding only the picked dates", async () => {
    // Mon 7, Tue 8, Wed 9, Fri 11, Mon 14 December 2026
    a = await create(["2026-12-14", "2026-12-07", "2026-12-08", "2026-12-09", "2026-12-11", "2026-12-08"]);
    assert.equal(key(a.startDate), "2026-12-07");
    assert.equal(key(a.endDate), "2026-12-14");
    assert.equal(a.totalDays, 5);
    assert.deepEqual(await daysOf(a.id), ["2026-12-07", "2026-12-08", "2026-12-09", "2026-12-11", "2026-12-14"]);
  });

  await t.test("a request for the gap is allowed; a shared date or a malformed date is not", async () => {
    b = await create(["2026-12-10"]);
    assert.equal(b.totalDays, 1);
    await assert.rejects(create(["2026-12-11"]), /overlapping/);
    await assert.rejects(create(["2026-12-1"]), (e) => e.status === 400);
  });

  await t.test("approval marks ON_LEAVE only on the picked dates", async () => {
    assert.equal((await approve(a, paid.id)).stage, "APPROVED");
    assert.deepEqual(await marks("2026-12-01", "2026-12-20"), ["2026-12-07", "2026-12-08", "2026-12-09", "2026-12-11", "2026-12-14"]);
    const ledger = await db((tx) => tx.leaveBalanceLedger.findFirst({ where: { tenantId: company, idempotencyKey: `LEAVE:${a.id}` } }));
    assert.equal(ledger.days, -5, "charged for the picked days, not the whole span");
  });

  await t.test("cancelling one request leaves the other's mark in its gap", async () => {
    await approve(b, paid.id);
    assert.ok((await marks("2026-12-10", "2026-12-10")).length === 1);
    const filed = await as("BOTH", () => svc.requestCancelLeave({ tenantId: company, requestedById: people.BOTH.id, leaveRequestId: a.id, reason: "Plans changed" }));
    assert.equal((await decide("LEAVE_CHANGE", filed.requestId)).stage, "APPROVED");
    assert.deepEqual(await marks("2026-12-01", "2026-12-20"), ["2026-12-10"], "only the other request's day stays");
  });
});
