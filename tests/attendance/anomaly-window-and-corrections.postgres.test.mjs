// Anomalies and corrections against PostgreSQL: where a detected case stands (open, HR can still raise, charged by
// payroll, raised, decided) is derived and filterable; HR and the line manager can file a missing-time correction for
// an employee, and it follows the same approval stages as one the employee files.
import test from "node:test";
import pg from "pg";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup, db, as, people, company, other, act } from "../approval/fixtures.mjs";
import { saveCorrectionRequest, myCorrectionRequests } from "../../src/services/attendanceCorrectionRequest.service.js";
import { listRuleCases } from "../../src/services/attendanceRules.service.js";
import { legacySubmit } from "../../src/services/approval/legacy.js";
import { replayTenant } from "../../src/lib/attendanceReplay.js";

let ready;
const once = () => (ready ||= setup());
const hrUser = () => ({ tenantId: company, employeeId: people.HR.id, roles: ["HR Manager"] });
const day = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
const mkCase = (over) =>
  db((tx) => tx.attendanceAnomaly.create({ data: { tenantId: company, employeeId: people.EMPLOYEE.id, type: "LATE_CHECKIN", rulesVersion: 2, evidenceState: "ACTIVE", status: "PENDING", ...over } }));
const cases = (extra = {}) => as("HR", () => listRuleCases({ user: hrUser(), from: day(120), to: day(0), pageSize: 100, ...extra }));

test("a detected case says where it stands: open, HR can still raise, charged, raised or decided", async () => {
  await once();
  const open = await mkCase({ date: new Date(`${day(0)}T00:00:00Z`) });
  const lapsed = await mkCase({ date: new Date(`${day(40)}T00:00:00Z`) });
  const charged = await mkCase({ date: new Date(`${day(70)}T00:00:00Z`) });
  const raised = await mkCase({ date: new Date(`${day(41)}T00:00:00Z`), raisedById: people.EMPLOYEE.id, raisedByName: "Fictional" });
  // A decided case normally arrives through the approval engine; the table's guard is skipped to seed one.
  const decided = await mkCase({ date: new Date(`${day(42)}T00:00:00Z`), raisedById: people.EMPLOYEE.id });
  const admin = new pg.Client({ connectionString: process.env.ASSESSMENT_TEST_ADMIN_URL });
  await admin.connect();
  await admin.query("SET session_replication_role = replica");
  await admin.query("UPDATE attendance_anomalies SET status = 'APPROVED' WHERE id = $1", [decided.id]);
  await admin.end();
  // Payroll already covers the oldest day.
  const run = await db((tx) => tx.payrollRun.create({ data: { tenantId: company, processedBy: people.HR.id, periodStart: new Date(`${day(80)}T00:00:00Z`), periodEnd: new Date(`${day(60)}T00:00:00Z`), countryCode: "PK", currencyCode: "PKR", status: "COMPLETED", totalGross: 1, totalNet: 1 } }));
  try {
    const all = await cases();
    const stateOf = (c) => all.items.find((i) => i.id === c.id).window;
    assert.equal(stateOf(open), "OPEN", "inside the employee's two working days");
    assert.equal(stateOf(lapsed), "HR_ONLY", "the employee's window closed; HR can still raise it until payroll covers the day");
    assert.equal(stateOf(charged), "CHARGED", "payroll covers the day, so it has decided");
    assert.equal(stateOf(raised), "RAISED");
    assert.equal(stateOf(decided), "DECIDED");
    assert.deepEqual(all.summary.windowCounts, { OPEN: 1, HR_ONLY: 1, CHARGED: 1, RAISED: 1, DECIDED: 1 });

    for (const w of ["OPEN", "HR_ONLY", "CHARGED", "RAISED", "DECIDED"]) {
      const only = await cases({ window: w });
      assert.deepEqual(only.items.map((i) => i.window), [w], `filter ${w}`);
      assert.equal(only.total, 1);
      assert.equal(only.summary.total, all.summary.total, "the cards still count every case");
    }

    // A cancelled payroll run no longer decides the day.
    await db((tx) => tx.payrollRun.update({ where: { id: run.id }, data: { status: "CANCELLED" } }));
    assert.equal((await cases()).items.find((i) => i.id === charged.id).window, "HR_ONLY");
  } finally {
    await db((tx) => tx.payrollRun.delete({ where: { id: run.id } }));
  }
});

test("the employee sees the same states for their own cases, and nobody else's", async () => {
  await once();
  const mine = await as("EMPLOYEE", () => listRuleCases({ user: { tenantId: company, employeeId: people.EMPLOYEE.id, roles: [] }, from: day(120), to: day(0), pageSize: 100 }));
  assert.ok(mine.items.length > 0);
  assert.ok(mine.items.every((i) => i.employeeId === people.EMPLOYEE.id));
  assert.ok(mine.items.some((i) => i.window === "OPEN"));
  const theirs = await as("OTHER", () => listRuleCases({ user: { tenantId: company, employeeId: people.OTHER.id, roles: [] }, from: day(120), to: day(0), pageSize: 100 }));
  assert.ok(theirs.items.every((i) => i.employeeId === people.OTHER.id), "another employee never sees these cases");
});

// ── corrections filed for an employee ─────────────────────────────────────────────────────────────────────────────
const DATE = "2026-02-17";
const base = async () => {
  const [session] = await db((tx) => replayTenant({ tenantId: company, employeeIds: [people.EMPLOYEE.id], from: DATE, to: DATE, db: tx, includeEmpty: true }));
  return { id: randomUUID(), version: 0, date: DATE, sessionKey: session.sessionKey, checkIn: "09:02:00", checkOut: "17:00:00", reason: "Reader missed the recorded arrival", evidence: "TEST-REGISTER-017: supervised arrival record", reasonCategory: "MISSED_PUNCH", evidenceDate: DATE };
};

test("HR or the line manager can file a correction for an employee; anyone else cannot", async () => {
  await once();
  const input = await base();
  await assert.rejects(as("OTHER", () => saveCorrectionRequest({ ...input, employeeId: people.EMPLOYEE.id })), /line manager or HR/);
  await assert.rejects(as("HR", () => saveCorrectionRequest({ ...input, employeeId: 999999 })), /Employee not found/);

  const draft = await as("HR", () => saveCorrectionRequest({ ...input, employeeId: people.EMPLOYEE.id }));
  assert.equal(draft.employeeId, people.EMPLOYEE.id, "the request is the employee's");
  const row = await db((tx) => tx.attendanceCorrectionRequest.findUnique({ where: { id: draft.id } }));
  assert.equal(row.filedById, people.HR.id, "and the filer is on record");
  assert.equal((await as("EMPLOYEE", () => myCorrectionRequests({ date: DATE }))).items.length, 1, "the employee sees it among their own");
  assert.equal((await as("HR", () => myCorrectionRequests({ date: DATE, employeeId: people.EMPLOYEE.id }))).items.length, 1);
  await assert.rejects(as("OTHER", () => myCorrectionRequests({ date: DATE, employeeId: people.EMPLOYEE.id })), /line manager or HR/);
  const audit = await db((tx) => tx.attendanceRuleAudit.findFirst({ where: { tenantId: company, action: "CORRECTION_DRAFT_SAVED" }, orderBy: { id: "desc" } }));
  assert.equal(audit.data.filedBy, people.HR.employee_code);

  // The employee cannot take over the on-behalf draft under another id, and a second draft for the same shift is refused.
  await assert.rejects(as("MANAGER", () => saveCorrectionRequest({ ...input, id: randomUUID(), employeeId: people.EMPLOYEE.id })), /already exists/);
  await db((tx) => tx.attendanceCorrectionRequest.delete({ where: { id: draft.id } }));
});

test("a correction filed for an employee follows the same approval stages and is applied on the final approval", async () => {
  await once();
  const input = await base();
  const draft = await as("MANAGER", () => saveCorrectionRequest({ ...input, employeeId: people.EMPLOYEE.id }));
  assert.equal((await db((tx) => tx.attendanceCorrectionRequest.findUnique({ where: { id: draft.id } }))).filedById, people.MANAGER.id, "the line manager may file it");

  await assert.rejects(as("OTHER", () => legacySubmit("ATTENDANCE_CORRECTION", draft.id, "Filed for them", { onBehalf: true, managerMayFile: true })), /line manager or HR|not|403|permission/i);
  await as("MANAGER", () => legacySubmit("ATTENDANCE_CORRECTION", draft.id, "Raised by the line manager for the employee", { onBehalf: true, managerMayFile: true }));
  const approval = await db((tx) => tx.hrApprovalRequest.findFirst({ where: { tenantId: company, kind: "ATTENDANCE_CORRECTION", sourceRef: draft.id } }));
  assert.ok(approval, "it reached the Approval Centre");
  assert.equal(approval.employeeCode, people.EMPLOYEE.employee_code, "as the employee's request");
  assert.equal(await db((tx) => tx.attendanceManualTime.count({ where: { tenantId: company, date: new Date(DATE) } })), 0, "nothing changes while it is under review");

  assert.equal(approval.stage, "HR", "the line manager who filed it has already done the manager step");
  let rec = { approvalRef: approval.id, version: approval.version };
  rec = await act("HR", rec, "VERIFY");
  rec = await act("MANAGEMENT", rec, "APPROVE");
  assert.equal(rec.execution, "APPLIED");
  const marks = await db((tx) => tx.attendanceManualTime.findMany({ where: { tenantId: company, employeeId: people.EMPLOYEE.id, date: new Date(DATE) } }));
  assert.equal(marks.length, 2);
});

test("another company's employee cannot be filed for", async () => {
  await once();
  const input = await base();
  await assert.rejects(as("HR", () => saveCorrectionRequest({ ...input, id: randomUUID(), employeeId: 424242 })), /Employee not found/);
  await assert.rejects(as("HR", () => saveCorrectionRequest({ ...input, id: randomUUID() }), other), /linked employee|not found/i);
});
