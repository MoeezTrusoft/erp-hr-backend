// HR-LEAVE-PARTIAL-01 (owner, 2026-11-23) — Management approves some days of a
// leave request and rejects others. The day rows (leave_request_days) carry each
// decision; totalDays becomes the approved count, the balance is charged for it
// and attendance is marked ON_LEAVE only on the approved dates. Runs against the
// isolated Postgres test database, so the RLS policies and the approval guard
// triggers (line guard on leave_request_days, source guard on leave_requests)
// are the real ones.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = process.env.ASSESSMENT_TEST_DATABASE_URL;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  new URL(url).pathname !== "/hr_task_assessment_test"
)
  throw new Error("Use the isolated local HR test database");
process.env.DATABASE_URL = url;
process.env.NODE_ENV = "test";
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");

const { company, people, db, setup, as, submit, act } = await import("./fixtures.mjs");
const { readApproval, listApprovals } = await import("../../src/services/approval/service.js");

const day = (d) => new Date(`${d}T00:00:00.000Z`);
const key = (d) => new Date(d).toISOString().slice(0, 10);

// A PENDING leave request over [from, to] with one PENDING day row per date
// (`withDays: false` makes a legacy request filed before day rows existed).
async function leave(from, to, { withDays = true } = {}) {
  const dates = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86400000) dates.push(new Date(t).toISOString().slice(0, 10));
  const row = await db(async (tx) => {
    const policy = await tx.leavePolicy.findFirst({ where: { tenantId: company } });
    return tx.leaveRequest.create({
      data: {
        tenantId: company,
        employeeId: people.EMPLOYEE.id,
        leavePolicyId: policy.id,
        startDate: day(from),
        endDate: day(to),
        totalDays: dates.length,
        reason: "Fictional partial leave",
        status: "PENDING",
        createdById: people.EMPLOYEE.id,
        ...(withDays
          ? { days: { create: dates.map((d) => ({ tenantId: company, date: day(d), decision: "PENDING" })) } }
          : {}),
      },
    });
  });
  return { kind: "LEAVE", ref: String(row.id), id: row.id };
}

// Submitted, recommended by the line manager and verified by HR: waiting for Management.
async function atManagement(s) {
  let a = await submit(s);
  a = await act("MANAGER", a, "RECOMMEND_APPROVAL");
  a = await act("HR", a, "VERIFY");
  assert.equal(a.stage, "MANAGEMENT");
  return a;
}

const daysOf = (id) =>
  db((tx) => tx.leaveRequestDay.findMany({ where: { leaveRequestId: id }, orderBy: { date: "asc" } })).then((rows) =>
    rows.map((r) => ({ date: key(r.date), decision: r.decision, decidedById: r.decidedById, decided: r.decidedAt !== null })),
  );
const requestOf = (id) => db((tx) => tx.leaveRequest.findFirst({ where: { id } }));

const rejectsWith = (promise, status, text) =>
  assert.rejects(promise, (e) => {
    assert.equal(e.status ?? e.statusCode, status, e.message);
    if (text) assert.match(e.message, text);
    return true;
  });

test("HR-LEAVE-PARTIAL-01 per-day leave decisions", { timeout: 300000 }, async (t) => {
  await setup();
  let partial, legacyRef;

  await t.test("management approves 20,21,22,24 Oct and rejects 23 Oct", async () => {
    const s = await leave("2026-10-20", "2026-10-24");
    const a = await atManagement(s);
    const out = await act("MANAGEMENT", a, "APPROVE", { rejectedDates: ["2026-10-23"] });
    partial = { s, record: out };
    assert.equal(out.stage, "APPROVED");
    assert.equal(out.execution, "APPLIED");

    const request = await requestOf(s.id);
    assert.equal(request.status, "APPROVED");
    // Written under the engine's finalizing context: the source guard freezes totalDays otherwise.
    assert.equal(request.totalDays, 4);

    const days = await daysOf(s.id);
    assert.deepEqual(
      days.map(({ date, decision }) => ({ date, decision })),
      [
        { date: "2026-10-20", decision: "APPROVED" },
        { date: "2026-10-21", decision: "APPROVED" },
        { date: "2026-10-22", decision: "APPROVED" },
        { date: "2026-10-23", decision: "REJECTED" },
        { date: "2026-10-24", decision: "APPROVED" },
      ],
    );
    for (const d of days) {
      assert.equal(d.decidedById, people.MANAGEMENT.id);
      assert.equal(d.decided, true);
    }

    const marked = await db((tx) =>
      tx.attendance.findMany({
        where: { tenantId: company, employeeId: people.EMPLOYEE.id, date: { gte: day("2026-10-20"), lte: day("2026-10-24") }, status: "ON_LEAVE" },
        orderBy: { date: "asc" },
      }),
    );
    assert.deepEqual(marked.map((r) => key(r.date)), ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-24"]);

    // deductApprovedLeave charged the approved count, not the requested five days.
    const ledger = await db((tx) => tx.leaveBalanceLedger.findFirst({ where: { tenantId: company, idempotencyKey: `LEAVE:${s.id}` } }));
    assert.equal(ledger.days, -4);

    const note = await db((tx) => tx.leaveRequestApproval.findFirst({ where: { leaveRequestId: s.id } }));
    assert.equal(note.decision, "APPROVED");
    assert.match(note.comments, / \(rejected: 2026-10-23\)$/);
  });

  await t.test("the decided days are frozen once the request is approved", async () => {
    await assert.rejects(
      db((tx) => tx.leaveRequestDay.updateMany({ where: { leaveRequestId: partial.s.id }, data: { decision: "APPROVED" } })),
      /HR-4204/,
    );
  });

  await t.test("rejecting every day is refused", async () => {
    const s = await leave("2026-10-26", "2026-10-27");
    const a = await atManagement(s);
    await rejectsWith(act("MANAGEMENT", a, "APPROVE", { rejectedDates: ["2026-10-26", "2026-10-27"] }), 400, /Reject the request instead/);
    assert.equal((await requestOf(s.id)).status, "PENDING");
    assert.ok((await daysOf(s.id)).every((d) => d.decision === "PENDING"), "nothing was decided");
  });

  await t.test("a date outside the request is refused", async () => {
    const s = await leave("2026-11-02", "2026-11-03");
    const a = await atManagement(s);
    await rejectsWith(act("MANAGEMENT", a, "APPROVE", { rejectedDates: ["2026-11-04"] }), 400, /Date 2026-11-04 is not part of this request/);
    // Shaped like a date but not one: never a PENDING day of the request.
    await rejectsWith(act("MANAGEMENT", a, "APPROVE", { rejectedDates: ["2026-13-45"] }), 400, /Date 2026-13-45 is not part of this request/);
    assert.equal((await requestOf(s.id)).status, "PENDING");
  });

  await t.test("HR (VERIFY) cannot send rejectedDates", async () => {
    const s = await leave("2026-11-05", "2026-11-06");
    let a = await submit(s);
    a = await act("MANAGER", a, "RECOMMEND_APPROVAL");
    assert.equal(a.stage, "HR");
    // An APPROVE carrying rejected days, sent at HR's stage, is not Management's decision.
    await rejectsWith(act("HR", a, "APPROVE", { rejectedDates: ["2026-11-05"] }), 400, /Only Management/);
    // VERIFY with rejected days never passes the contract.
    await assert.rejects(act("HR", a, "VERIFY", { rejectedDates: ["2026-11-05"] }), /rejectedDates requires action APPROVE/);
  });

  await t.test("full approval without rejectedDates marks all days APPROVED", async () => {
    const s = await leave("2026-11-09", "2026-11-11");
    const a = await atManagement(s);
    // An empty list is the same as no list.
    const out = await act("MANAGEMENT", a, "APPROVE", { rejectedDates: [] });
    assert.equal(out.stage, "APPROVED");
    assert.equal((await requestOf(s.id)).totalDays, 3);
    assert.deepEqual((await daysOf(s.id)).map((d) => d.decision), ["APPROVED", "APPROVED", "APPROVED"]);
    const note = await db((tx) => tx.leaveRequestApproval.findFirst({ where: { leaveRequestId: s.id } }));
    assert.doesNotMatch(note.comments, /rejected:/);
  });

  await t.test("a rejection marks all days REJECTED", async () => {
    const s = await leave("2026-11-12", "2026-11-13");
    const a = await atManagement(s);
    const out = await act("MANAGEMENT", a, "REJECT");
    assert.equal(out.stage, "REJECTED");
    assert.deepEqual((await daysOf(s.id)).map((d) => d.decision), ["REJECTED", "REJECTED"]);
    assert.equal((await requestOf(s.id)).totalDays, 2);
  });

  await t.test("a legacy request without day rows: rejectedDates materialises the working days first", async () => {
    const s = await leave("2026-11-16", "2026-11-18", { withDays: false });
    const a = await atManagement(s);
    await act("MANAGEMENT", a, "APPROVE", { rejectedDates: ["2026-11-17"] });
    assert.deepEqual(
      (await daysOf(s.id)).map(({ date, decision }) => ({ date, decision })),
      [
        { date: "2026-11-16", decision: "APPROVED" },
        { date: "2026-11-17", decision: "REJECTED" },
        { date: "2026-11-18", decision: "APPROVED" },
      ],
    );
    assert.equal((await requestOf(s.id)).totalDays, 2);
  });

  await t.test("a legacy request without day rows keeps none on a plain approval", async () => {
    const s = await leave("2026-11-19", "2026-11-20", { withDays: false });
    const a = await atManagement(s);
    legacyRef = (await act("MANAGEMENT", a, "APPROVE")).approvalRef;
    assert.deepEqual(await daysOf(s.id), []);
    assert.equal((await requestOf(s.id)).totalDays, 2);
  });

  await t.test("hr_approval_read exposes leaveDays", async () => {
    const read = await as("MANAGEMENT", () => readApproval({ approvalRef: partial.record.approvalRef }));
    assert.deepEqual(read.record.leaveDays, [
      { date: "2026-10-20", decision: "APPROVED" },
      { date: "2026-10-21", decision: "APPROVED" },
      { date: "2026-10-22", decision: "APPROVED" },
      { date: "2026-10-23", decision: "REJECTED" },
      { date: "2026-10-24", decision: "APPROVED" },
    ]);
    // Management cannot pick a policy but is told the name of the request's own one (not the whole list).
    const policy = await db((tx) => tx.leavePolicy.findFirst({ where: { tenantId: company } }));
    assert.deepEqual(read.record.leavePolicies, [{ ref: String(policy.id), label: policy.name }]);
    // A pending request shows its days as PENDING; the list carries them too.
    const s = await leave("2026-11-24", "2026-11-25");
    const pending = await atManagement(s);
    const list = await as("MANAGEMENT", () => listApprovals({ scope: "QUEUE", kind: "LEAVE" }));
    const row = list.items.find((i) => i.approvalRef === pending.approvalRef);
    assert.deepEqual(row.leaveDays, [
      { date: "2026-11-24", decision: "PENDING" },
      { date: "2026-11-25", decision: "PENDING" },
    ]);
    // A legacy request without day rows reads as an empty list (the screen shows the range).
    const legacy = await as("MANAGEMENT", () => readApproval({ approvalRef: legacyRef }));
    assert.deepEqual(legacy.record.leaveDays, []);
  });
});
