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
const { mirrorEditReason } = await import("../../src/services/attendanceRequestMirror.service.js");
const { default: prisma } = await import("../../src/lib/prisma.js");
const OTHER = randomUUID();

const ROLE_NAMES = { HR: ["hr"], MANAGEMENT: ["management"], MANAGER: ["manager"] };
const GRANTS = {
  EMPLOYEE: ["self"],
  MANAGER: ["self", "manager", "read"],
  HR: ["self", "verify", "read"],
  MANAGEMENT: ["self", "approve", "read"],
};
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

  await t.test("on an on-behalf request the employee concerned and Management are refused", async () => {
    const { record } = await raiseOnBehalf();
    await rejectsWith(edit("EMPLOYEE", record, "I want to change it"), 403, /employee's line manager can edit it/);
    // These fixtures carry the legacy fixed stages (no sealed route), so the
    // final approver cannot be told apart by code; on a sealed route the refusal
    // names the rule ("Management decides this request").
    await rejectsWith(edit("MANAGEMENT", record, "Management editing"), 403, /employee's line manager can edit it/);
  });

  await t.test("the employee's line manager may edit the request HR raised on their behalf", async () => {
    const { anomaly, record } = await raiseOnBehalf("filed for a colleague");
    const out = await edit("MANAGER", record, "the manager's wording");
    assert.equal(out.record.stage, "MANAGEMENT");
    assert.equal((await readCase(anomaly.id)).reason, "the manager's wording");
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

  await t.test("the employee edits their own request and HR may correct it too, until it is decided", async () => {
    const anomaly = await detectedCase();
    const record = await as("EMPLOYEE", () =>
      raiseRuleRequest({ user: userOf("EMPLOYEE"), anomalyId: anomaly.id, reason: "my own explanation", requestKey: randomUUID() }),
    );
    const seenByEmployee = await as("EMPLOYEE", () => readApproval({ approvalRef: record.approvalRef }));
    assert.ok(seenByEmployee.record.actions.includes("EDIT_REASON"), "the employee is offered Edit on their own request");
    // Operator, 2026-11-05: HR corrects any open request, the employee's own note included.
    const seenByHr = await as("HR", () => readApproval({ approvalRef: record.approvalRef }));
    assert.ok(seenByHr.record.actions.includes("EDIT_REASON"), "HR is offered Edit on an employee's own request");
    const byHr = await edit("HR", record, "my own explanation (HR added the gate name)");
    assert.equal((await readCase(anomaly.id)).reason, "my own explanation (HR added the gate name)");
    assert.equal(byHr.record.history.at(-1).action, "EDITED");
    const out = await edit("EMPLOYEE", byHr.record, "my own explanation, corrected");
    assert.equal((await readCase(anomaly.id)).reason, "my own explanation, corrected");
    const audits = await db((tx) =>
      tx.attendanceRuleAudit.findMany({ where: { tenantId: company, anomalyId: anomaly.id, action: "REQUEST_EDITED" } }),
    );
    assert.equal(audits.at(-1).data.after, "my own explanation, corrected");
    // The first approver's act ends the employee's edit.
    const approved = await as("HR", () =>
      actApproval({ approvalRef: out.record.approvalRef, expectedVersion: out.record.version, action: "VERIFY", reason: "verified", requestKey: randomUUID() }),
    );
    await rejectsWith(edit("EMPLOYEE", approved.record, "one more change", approved.record.version), 409, /already decided/);
    // HR keeps correcting the wording while Management still has to decide.
    const late = await edit("HR", approved.record, "HR's final wording");
    assert.equal(late.record.stage, "MANAGEMENT");
    assert.equal((await readCase(anomaly.id)).reason, "HR's final wording");
    // Management still cannot edit (here told that the employee's own request is
    // past editing), and a decided request is closed to everyone.
    await rejectsWith(edit("MANAGEMENT", late.record, "Management wording"), 409);
    const decided = await as("MANAGEMENT", () =>
      actApproval({ approvalRef: late.record.approvalRef, expectedVersion: late.record.version, action: "APPROVE", reason: "ok", requestKey: randomUUID() }),
    );
    await rejectsWith(edit("HR", decided.record, "after the decision"), 409);
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

  await t.test("an edit follows the case into the employee's other company", async () => {
    const anomaly = await detectedCase();
    const record = await as("EMPLOYEE", () =>
      raiseRuleRequest({ user: userOf("EMPLOYEE"), anomalyId: anomaly.id, reason: "reader down at the gate", requestKey: randomUUID() }),
    );
    // The twin the mirror would have raised in the employee's other company.
    const origin = await readCase(anomaly.id);
    const group = randomUUID();
    let twin;
    await db((tx) =>
      tx.attendanceAnomaly.update({ where: { id: origin.id }, data: { mirrorGroupId: group } }),
    );
    await mcpCtx.run({ system: true }, async () => {
      const { id, ...copy } = origin;
      twin = await prisma.attendanceAnomaly.create({
        data: {
          ...copy,
          tenantId: OTHER,
          mirrorGroupId: group,
          originAnomalyId: origin.id,
          originTenantId: company,
          originRaisedByName: "Claude",
          reason:
            "reader down at the gate\n\nRaised in TruSoft and mirrored to Hometest automatically (same person, device and shift).",
        },
      });
    });
    const out = await edit("EMPLOYEE", record, "reader down 09:00-09:30");
    assert.equal((await readCase(anomaly.id)).reason, "reader down 09:00-09:30");
    const mirrored = await mcpCtx.run({ system: true }, async () =>
      prisma.attendanceAnomaly.findUnique({ where: { id: twin.id } }),
    );
    assert.equal(
      mirrored.reason,
      "reader down 09:00-09:30\n\nRaised in TruSoft and mirrored to Hometest automatically (same person, device and shift).",
      "the twin keeps its clause and takes the new text",
    );
    const audits = await mcpCtx.run({ system: true }, async () =>
      prisma.attendanceRuleAudit.findMany({ where: { tenantId: OTHER, anomalyId: twin.id, action: "REQUEST_EDITED" } }),
    );
    assert.equal(audits.length, 1);
    assert.equal(audits[0].data.mirroredFrom, company);
    assert.equal(out.record.version, record.version + 1);
    void mirrorEditReason;
  });
});
