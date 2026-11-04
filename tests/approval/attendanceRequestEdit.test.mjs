// Issue 353 (operator, 2026-11-04) — HR edits the reason of a resolution request it raised on behalf,
// until the level after HR has acted. Only the filer and the HR approver may edit; the digest is
// sealed again so Management can still decide; everything is audited.
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

const { company, people, db, setup } = await import("./fixtures.mjs");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { applyEvaluatedShifts } = await import("../../src/services/attendanceWriter.service.js");
const { raiseRuleRequest, raiseRuleRequestOnBehalf } = await import("../../src/services/attendanceRules.service.js");
const { actApproval, editAttendanceRequestReason, readApproval } = await import("../../src/services/approval/service.js");

const ROLE_NAMES = { HR: ["hr"], MANAGEMENT: ["management"] };
const GRANTS = { EMPLOYEE: ["self"], HR: ["self", "verify", "read"], MANAGEMENT: ["self", "approve", "read"] };
const as = (role, fn) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: {
        tenantId: company,
        userId: people[role].userId,
        employeeId: people[role].id,
        roles: ROLE_NAMES[role] ?? [],
        isAdmin: false,
      },
      permissions: GRANTS[role].map((k) => "hr.approvals." + k),
    },
    fn,
  );
const userOf = (role) => ({ tenantId: company, userId: people[role].userId, employeeId: people[role].id, roles: ROLE_NAMES[role] ?? [] });
const readCase = (id) => db((tx) => tx.attendanceAnomaly.findUnique({ where: { id } }));
const edit = (role, record, reason, version = record.version) =>
  as(role, () => editAttendanceRequestReason({ approvalRef: record.approvalRef, expectedVersion: version, reason }));
const rejectsWith = (promise, status, text) =>
  assert.rejects(promise, (e) => {
    assert.equal(e.status ?? e.statusCode, status, e.message);
    if (text) assert.match(e.message, text);
    return true;
  });

let dayOffset = 5;
async function detectedCase() {
  const date = new Date(Date.UTC(2026, 9, dayOffset++));
  let anomaly;
  await db(async (tx) => {
    for (const [hour, minute, status] of [[9, 45, 0], [17, 0, 1]])
      await tx.attendanceDevicePunch.create({
        data: {
          tenantId: company, employeeId: people.EMPLOYEE.id, sn: "TEST-DEVICE", siteId: "HO", deviceUserId: "101",
          punchedAt: new Date(+date + (hour * 60 + minute) * 60000), status, directionVerified: true,
        },
      });
    const day = date.toISOString().slice(0, 10);
    await applyEvaluatedShifts({
      tenantId: company, from: day, to: day, employeeIds: [people.EMPLOYEE.id], db: tx, dryRun: false,
      now: new Date(+date + 3 * 86400000),
    });
    anomaly = await tx.attendanceAnomaly.findFirst({
      where: { tenantId: company, employeeId: people.EMPLOYEE.id, date, type: "LATE_CHECKIN", status: "PENDING" },
    });
  });
  assert.ok(anomaly, "the evaluator detected a late case");
  return anomaly;
}
const raiseOnBehalf = async (reason = "Filed from the gate register") => {
  const anomaly = await detectedCase();
  const record = await as("HR", () =>
    raiseRuleRequestOnBehalf({ user: userOf("HR"), anomalyId: anomaly.id, reason, requestKey: randomUUID() }),
  );
  return { anomaly, record };
};

test("HR edits an on-behalf request before Management acts", { timeout: 180000 }, async (t) => {
  await setup();

  await t.test("the filer edits the reason; the stage stays; both audit rows record old and new text", async () => {
    const { anomaly, record } = await raiseOnBehalf("first wording");
    assert.equal(record.stage, "MANAGEMENT");
    const out = await edit("HR", record, "corrected wording: the reader was down");
    assert.equal(out.record.stage, "MANAGEMENT", "still waiting for Management");
    assert.equal(out.record.version, record.version + 1);
    const stored = await readCase(anomaly.id);
    assert.equal(stored.reason, "corrected wording: the reader was down");
    assert.ok(stored.workflowVersion > anomaly.workflowVersion);
    const last = out.record.history.at(-1);
    assert.equal(last.action, "EDITED");
    assert.equal(last.reason, "corrected wording: the reader was down");
    const audits = await db((tx) => tx.attendanceRuleAudit.findMany({ where: { tenantId: company, anomalyId: anomaly.id, action: "REQUEST_EDITED" } }));
    assert.equal(audits.length, 1);
    assert.equal(audits[0].data.before, "first wording");
    assert.equal(audits[0].data.after, "corrected wording: the reader was down");
  });

  await t.test("Management can still approve after an edit (the digest was sealed again)", async () => {
    const { record } = await raiseOnBehalf("before edit");
    const out = await edit("HR", record, "after edit");
    const approved = await as("MANAGEMENT", () =>
      actApproval({ approvalRef: out.record.approvalRef, expectedVersion: out.record.version, action: "APPROVE", reason: "ok", requestKey: randomUUID() }),
    );
    assert.equal(approved.record.stage, "APPROVED");
  });

  await t.test("nobody else may edit: the employee concerned and Management are refused", async () => {
    const { record } = await raiseOnBehalf();
    await rejectsWith(edit("EMPLOYEE", record, "I want to change it"), 403, /filed this request or the HR approver/);
    await rejectsWith(edit("MANAGEMENT", record, "Management editing"), 403, /filed this request or the HR approver/);
  });

  await t.test("the record offers EDIT_REASON only to the people who may edit it, and only until the decision", async () => {
    const { record } = await raiseOnBehalf();
    const seen = (role, ref = record.approvalRef) => as(role, () => readApproval({ approvalRef: ref })).then((r) => r.record.actions);
    assert.ok((await seen("HR")).includes("EDIT_REASON"), "the filer is offered it");
    assert.ok(!(await seen("MANAGEMENT")).includes("EDIT_REASON"), "Management is not");
    const approved = await as("MANAGEMENT", () =>
      actApproval({ approvalRef: record.approvalRef, expectedVersion: record.version, action: "APPROVE", reason: "ok", requestKey: randomUUID() }),
    );
    assert.ok(!(await seen("HR", approved.record.approvalRef)).includes("EDIT_REASON"), "nobody once it is decided");
  });

  await t.test("refused after Management has decided", async () => {
    const { record } = await raiseOnBehalf();
    const approved = await as("MANAGEMENT", () =>
      actApproval({ approvalRef: record.approvalRef, expectedVersion: record.version, action: "APPROVE", reason: "ok", requestKey: randomUUID() }),
    );
    await rejectsWith(edit("HR", approved.record, "too late"), 409);
  });

  await t.test("refused on a request the employee raised themselves", async () => {
    const anomaly = await detectedCase();
    const record = await as("EMPLOYEE", () =>
      raiseRuleRequest({ user: userOf("EMPLOYEE"), anomalyId: anomaly.id, reason: "my own explanation", requestKey: randomUUID() }),
    );
    await rejectsWith(edit("HR", record, "HR rewriting it"), 409, /raised on behalf/);
  });

  await t.test("an unchanged, empty or stale edit is refused", async () => {
    const { record } = await raiseOnBehalf("same text");
    await rejectsWith(edit("HR", record, "same text"), 400, /unchanged/);
    await assert.rejects(edit("HR", record, "   "), /reason is required/);
    await rejectsWith(edit("HR", record, "new text", record.version + 5), 412);
    const ok = await edit("HR", record, "new text");
    await rejectsWith(edit("HR", record, "another", record.version), 412); // version moved by the first edit
    assert.equal(ok.record.version, record.version + 1);
  });
});
