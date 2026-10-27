import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
const url = new URL(process.env.RECRUITMENT_TEST_DATABASE_URL || "");
if (
  url.hostname !== "127.0.0.1" ||
  url.pathname !== "/hr_task_assessment_test" ||
  url.username !== "recruitment_test_user"
)
  throw new Error("Use isolated recruitment database");
process.env.DATABASE_URL = url.href;
process.env.NODE_ENV = "test";
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
process.env.HR_RECRUITMENT_WORKFLOW_ENFORCEMENT = "true";
process.env.HR_RECRUITMENT_OFFER_HANDOFF = "true";
delete process.env.FINANCE_SERVICE_URL;
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const { submitApproval, actApproval, listApprovals } =
  await import("../../src/services/approval/service.js");
const { consumeApproval } =
  await import("../../src/services/approval/adapters.js");
const { legacyDecision } =
  await import("../../src/services/approval/legacy.js");
const tenant = randomUUID(),
  people = {};
let department;
const ctx = (fn) => mcpCtx.run({ user: { tenantId: tenant } }, fn);
const tx = (fn) =>
  ctx(() =>
    tenantTransaction(db, fn, {
      tenantId: tenant,
      txOptions: { timeout: 30000, maxWait: 10000 },
    }),
  );
const grants = {
  REQUESTER: ["self"],
  MANAGER: ["self", "manager"],
  HR: ["self", "verify", "read"],
  FINANCE: ["self", "approve", "read"],
  DUAL: ["self", "manager", "verify", "approve", "read"],
};
const roles = {
  REQUESTER: ["RECRUITER"],
  MANAGER: ["HIRING_MANAGER"],
  HR: ["HR_HEAD"],
  FINANCE: ["FINANCE"],
  DUAL: ["HIRING_MANAGER", "HR_HEAD", "FINANCE"],
};
const as = (role, fn) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: {
        tenantId: tenant,
        userId: people[role].userId,
        roles: roles[role],
      },
      permissions: grants[role].map((x) => "hr.approvals." + x),
    },
    fn,
  );
test.before(async () => {
  await tx(async (q) => {
    department = await q.businessUnit.create({
      data: { tenantId: tenant, name: "Fictional editorial" },
    });
    for (const role of Object.keys(grants))
      people[role] = await q.employee.create({
        data: {
          tenant_id: tenant,
          userId: randomInt(10000, 1000000000),
          employee_code: "RA-" + randomUUID().toUpperCase(),
          employeeCategory: "EMPLOYEE",
          first_name: "Fictional " + role,
          status: "Active",
          employement_status: "Active",
        },
      });
    await q.requisitionApprovalRule.createMany({
      data: [
        { stepOrder: 1, role: "HIRING_MANAGER" },
        { stepOrder: 2, role: "HR_HEAD" },
        { stepOrder: 3, role: "FINANCE", minAmount: 100000 },
      ].map((x) => ({
        tenantId: tenant,
        requiresDistinctApprover: true,
        isActive: true,
        ...x,
      })),
    });
  });
});
async function fixture(kind = "REQUISITION", extra = {}) {
  return tx(async (q) => {
    const job = await q.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Fictional editor",
        departmentId: department.id,
        requestedById: people.REQUESTER.id,
        status: "DRAFT",
        location: "Karachi",
        employmentType: "FULL_TIME",
        openings: 1,
        costCenterRef: "TEST-CENTER",
        budgetedAmount: 250000,
        hiringReason: "NEW_HIRE",
        ...extra,
      },
    });
    if (kind === "REQUISITION") return { kind, id: job.id };
    const c = await q.candidate.create({
      data: {
        tenantId: tenant,
        firstName: "Fictional",
        email: randomUUID() + "@example.invalid",
      },
    });
    const a = await q.application.create({
      data: {
        tenantId: tenant,
        candidateId: c.id,
        jobRequisitionId: job.id,
        stage: "offer",
        status: "open",
      },
    });
    const o = await q.offer.create({
      data: {
        tenantId: tenant,
        applicationId: a.id,
        candidateId: c.id,
        jobRequisitionId: job.id,
        createdById: people.REQUESTER.id,
        status: "DRAFT",
        salary: 250000,
        currency: "PKR",
        employeeCategory: "EMPLOYEE",
      },
    });
    return { kind, id: o.id };
  });
}
const submit = (f, expectedVersion = 0) =>
  as("REQUESTER", () =>
    submitApproval({
      kind: f.kind,
      sourceRef: String(f.id),
      employeeCode: people.REQUESTER.employee_code,
      expectedVersion,
      reason: "Recruiter submits complete evidence for independent review",
      requestKey: randomUUID(),
    }),
  ).then((x) => x.record);
const act = (role, row, action = "APPROVE", extra = {}) =>
  as(role, () =>
    actApproval({
      approvalRef: row.approvalRef,
      expectedVersion: row.version,
      action,
      reason: "Reviewed headcount, budget and role requirements",
      requestKey: randomUUID(),
      ...extra,
    }),
  ).then((x) => x.record);
test("requisition policy enforces ordered independent roles, freezes the chain, and mirrors each decision", async () => {
  const f = await fixture();
  let row = await submit(f);
  assert.equal(row.stage, "MANAGEMENT");
  await assert.rejects(act("HR", row), { status: 403 });
  await assert.rejects(act("REQUESTER", row), { status: 403 });
  const queue = await as("MANAGER", () =>
    listApprovals({ scope: "QUEUE", kind: "REQUISITION" }),
  );
  assert.ok(queue.items.some((x) => x.approvalRef === row.approvalRef));
  row = await act("DUAL", row);
  assert.equal(row.stage, "MANAGEMENT");
  await assert.rejects(act("DUAL", row), { status: 403 });
  await tx((q) =>
    q.requisitionApprovalRule.updateMany({
      where: { tenantId: tenant, role: "FINANCE" },
      data: { minAmount: 9000000 },
    }),
  );
  row = await act("HR", row);
  assert.equal(row.stage, "MANAGEMENT");
  assert.equal(
    (await tx((q) => q.jobRequisition.findUnique({ where: { id: f.id } })))
      .status,
    "PENDING_APPROVAL",
  );
  row = await act("FINANCE", row);
  assert.equal(row.stage, "APPROVED");
  const source = await tx((q) =>
    q.jobRequisition.findUnique({
      where: { id: f.id },
      include: { approvals: true },
    }),
  );
  assert.equal(source.status, "APPROVED");
  assert.equal(source.approvalChainSnapshot.length, 3);
  assert.deepEqual(source.approvals.map((x) => x.stepOrder).sort(), [1, 2, 3]);
  assert.equal(row.history.length, 4);
  await tx((q) =>
    q.requisitionApprovalRule.updateMany({
      where: { tenantId: tenant, role: "FINANCE" },
      data: { minAmount: 100000 },
    }),
  );
});
test("changed source facts block decisions, return and resubmit start a fresh round, and rejection is terminal", async () => {
  const f = await fixture();
  let row = await submit(f);
  row = await act("MANAGER", row);
  await tx((q) =>
    q.jobRequisition.update({
      where: { id: f.id },
      data: { budgetedAmount: 300000 },
    }),
  );
  await assert.rejects(act("HR", row), /source changed/);
  row = await act("HR", row, "REVERT");
  assert.equal(row.stage, "INITIATOR");
  assert.equal(
    (await tx((q) => q.jobRequisition.findUnique({ where: { id: f.id } })))
      .status,
    "DRAFT",
  );
  row = await submit(f, row.version);
  assert.equal(row.round, 2);
  row = await act("MANAGER", row);
  row = await act("HR", row, "REJECT");
  assert.equal(row.stage, "REJECTED");
  assert.equal(
    (await tx((q) => q.jobRequisition.findUnique({ where: { id: f.id } })))
      .status,
    "REJECTED",
  );
  await assert.rejects(act("FINANCE", row), { status: 403 });
});
test("offer default policy requires three ordered roles, mirrors approvals and binds consumption to approved facts", async () => {
  const f = await fixture("OFFER");
  let row = await submit(f);
  await assert.rejects(act("FINANCE", row), { status: 403 });
  row = await act("MANAGER", row);
  row = await act("HR", row);
  row = await act("FINANCE", row);
  assert.equal(row.stage, "APPROVED");
  const offer = await tx((q) =>
    q.offer.findUnique({
      where: { id: f.id },
      include: { approvalRecords: true },
    }),
  );
  assert.equal(offer.approvalStatus, "APPROVED");
  assert.equal(offer.status, "DRAFT");
  assert.equal(offer.approvalRecords.length, 3);
  await tx((q) => consumeApproval(q, tenant, "OFFER", String(f.id)));
  await assert.rejects(
    tx((q) =>
      q.offer.update({ where: { id: f.id }, data: { salary: 300001 } }),
    ),
    /HR-4204/,
  );
  const changed = await fixture("OFFER");
  const pending = await submit(changed);
  await tx((q) =>
    q.offer.update({ where: { id: changed.id }, data: { salary: 300001 } }),
  );
  await assert.rejects(act("MANAGER", pending), /source changed/);
});
test("legacy decisions and direct final status writes cannot bypass the Approval Centre", async () => {
  for (const kind of ["REQUISITION", "OFFER"]) {
    const f = await fixture(kind);
    await submit(f);
    await assert.rejects(
      as("HR", () => legacyDecision(kind, f.id)),
      { status: 409, code: "HR-4201" },
    );
    await assert.rejects(
      tx((q) =>
        kind === "REQUISITION"
          ? q.jobRequisition.update({
              where: { id: f.id },
              data: { status: "APPROVED" },
            })
          : q.offer.update({ where: { id: f.id }, data: { status: "SENT" } }),
      ),
      /HR-4201/,
    );
  }
});
test("policy refuses a requester pinned as their own independent approver before submission writes", async () => {
  await tx((q) =>
    q.requisitionApprovalRule.updateMany({
      where: { tenantId: tenant, stepOrder: 1 },
      data: { approverId: people.REQUESTER.id },
    }),
  );
  const f = await fixture();
  await assert.rejects(submit(f), /could never be decided/);
  assert.equal(
    (await tx((q) => q.jobRequisition.findUnique({ where: { id: f.id } })))
      .status,
    "DRAFT",
  );
  assert.equal(
    await tx((q) =>
      q.hrApprovalRequest.count({
        where: {
          tenantId: tenant,
          sourceRef: String(f.id),
          kind: "REQUISITION",
        },
      }),
    ),
    0,
  );
});
test("generic edits and direct SQL cannot strand a requisition outside the Approval Centre", async () => {
  await tx((q) =>
    q.requisitionApprovalRule.updateMany({
      where: { tenantId: tenant },
      data: { approverId: null },
    }),
  );
  const f = await fixture();
  const { updateRequisition } =
    await import("../../src/services/requisition.service.js");
  await assert.rejects(
    ctx(() =>
      updateRequisition(
        f.id,
        { status: "PENDING_APPROVAL" },
        people.REQUESTER.id,
        tenant,
      ),
    ),
    (e) => e.code === "HR-4201",
  );
  await assert.rejects(
    tx((q) =>
      q.jobRequisition.update({
        where: { id: f.id },
        data: { status: "PENDING_APPROVAL" },
      }),
    ),
    /HR-4201/,
  );
  assert.equal(
    (await tx((q) => q.jobRequisition.findUnique({ where: { id: f.id } })))
      .status,
    "DRAFT",
  );
  const pending = await submit(f);
  await assert.rejects(
    tx((q) =>
      q.jobRequisition.update({
        where: { id: f.id },
        data: { status: "DRAFT" },
      }),
    ),
    /HR-4201/,
  );
  const returnCommand = {
    approvalRef: pending.approvalRef,
    expectedVersion: pending.version,
    action: "REVERT",
    reason: "Return the source for corrected role details",
    requestKey: randomUUID(),
  };
  const returned = (await as("MANAGER", () => actApproval(returnCommand)))
    .record;
  assert.equal(returned.stage, "INITIATOR");
  assert.equal(
    (await as("MANAGER", () => actApproval(returnCommand))).record.version,
    returned.version,
  );
  const { readApproval } =
    await import("../../src/services/approval/service.js");
  assert.equal(
    (
      await as("MANAGER", () =>
        readApproval({ approvalRef: pending.approvalRef }),
      )
    ).record.stage,
    "INITIATOR",
  );
  const outsider = await tx((q) =>
    q.employee.create({
      data: {
        tenant_id: tenant,
        userId: randomInt(10000, 1000000000),
        employee_code: "RA-" + randomUUID().toUpperCase(),
        employeeCategory: "EMPLOYEE",
        first_name: "Unrelated manager",
        status: "Active",
        employement_status: "Active",
      },
    }),
  );
  await assert.rejects(
    mcpCtx.run(
      {
        actorVerified: true,
        user: {
          tenantId: tenant,
          userId: outsider.userId,
          roles: ["HIRING_MANAGER"],
        },
        permissions: ["hr.approvals.manager"],
      },
      () => readApproval({ approvalRef: pending.approvalRef }),
    ),
    (e) => e.status === 404,
  );
  assert.equal((await submit(f, returned.version)).round, 2);
});
test("central submission enforces complete fields, hiring freeze and approver-routed events", async () => {
  const missing = await fixture("REQUISITION", { costCenterRef: null });
  await assert.rejects(submit(missing), /cannot be submitted/i);
  const frozen = await fixture();
  const freeze = await tx((q) =>
    q.recruitmentHiringFreeze.create({
      data: {
        tenantId: tenant,
        scope: "COMPANY",
        reason: "Fictional budget review",
        isActive: true,
      },
    }),
  );
  await assert.rejects(submit(frozen), /hiring freeze/i);
  const { legacySubmit } =
    await import("../../src/services/approval/legacy.js");
  await assert.rejects(
    as("REQUESTER", () => legacySubmit("REQUISITION", frozen.id)),
    /hiring freeze/i,
  );
  assert.equal(
    await tx((q) =>
      q.hrApprovalRequest.count({
        where: {
          tenantId: tenant,
          kind: "REQUISITION",
          sourceRef: String(frozen.id),
        },
      }),
    ),
    0,
  );
  await tx((q) =>
    q.recruitmentHiringFreeze.update({
      where: { id: freeze.id },
      data: { isActive: false },
    }),
  );
  await tx((q) =>
    q.requisitionApprovalRule.updateMany({
      where: { tenantId: tenant, stepOrder: 1 },
      data: { approverId: people.MANAGER.id },
    }),
  );
  await submit(frozen);
  const events = await tx((q) =>
    q.outboxEvent.findMany({
      where: {
        tenantId: tenant,
        eventName: "hr.recruitment.requisition_submitted.v1",
        aggregateId: String(frozen.id),
      },
    }),
  );
  assert.equal(events.length, 1);
  assert.equal(
    events[0].payload.payload.pendingApproverId,
    String(people.MANAGER.id),
  );
  assert.equal(events[0].payload.payload.pendingStepOrder, 1);
});
test.after(() => db.$disconnect());
