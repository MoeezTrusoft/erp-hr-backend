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
      txOptions: { timeout: 30000 },
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
        consentStatus: "GRANTED",
        email: randomUUID() + "@example.invalid",
      },
    });
    await q.candidateConsent.create({
      data: {
        tenantId: tenant,
        candidateId: c.id,
        purpose: "PROCESSING",
        status: "GRANTED",
        policyVersion: "test",
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

const staffCall = (fn) => mcpCtx.run({ actorVerified: true, user: { tenantId: tenant, userId: people.HR.userId, roles: ["HR_HEAD"] }, permissions: ["hr.recruitment.read", "hr.recruitment.update", "hr.recruitment.create"] }, fn);

const { sendOffer, respondOffer } =
  await import("../../src/services/offer.service.js");
const { runOfferHandoff } =
  await import("../../src/services/recruitmentHandoff.service.js");
async function readyOffer() {
  const f = await fixture("OFFER");
  const offer = await tx((q) => q.offer.findUnique({ where: { id: f.id } }));
  let req = await submit({ kind: "REQUISITION", id: offer.jobRequisitionId });
  for (const role of ["MANAGER", "HR", "FINANCE"]) req = await act(role, req);
  const { postRequisition } =
    await import("../../src/services/requisition.service.js");
  await staffCall(() =>
    postRequisition(
      offer.jobRequisitionId,
      "https://careers.example.invalid/jobs/" + offer.jobRequisitionId,
      people.REQUESTER.id,
      tenant,
    ),
  );
  let row = await submit(f);
  for (const role of ["MANAGER", "HR", "FINANCE"]) row = await act(role, row);
  await ctx(() => sendOffer(f.id, tenant, { actorId: people.REQUESTER.id }));
  return offer;
}
test("concurrent accepted-offer handoffs allocate one employee, payroll base and onboarding checklist", async () => {
  const offer = await readyOffer();
  // Both responses start before acceptance; the handoff lock must serialize retries.
  const results = await Promise.all(
    [1, 2].map(() =>
      ctx(() =>
        respondOffer(offer.id, true, tenant, { actorId: people.REQUESTER.id }),
      ),
    ),
  );
  const handoff = await tx((q) =>
    q.offerHandoff.findUnique({ where: { offerId: offer.id } }),
  );
  assert.equal(handoff.status, "COMPLETED");
  assert.ok(handoff.employeeId);
  const employee = await tx((q) =>
    q.employee.findUnique({ where: { id: handoff.employeeId } }),
  );
  assert.equal(employee.employeeCategory, "EMPLOYEE");
  assert.match(employee.employee_code, /^EMP-[0-9]+$/);
  assert.equal(
    await tx((q) =>
      q.employee.count({ where: { tenant_id: tenant, email: employee.email } }),
    ),
    1,
  );
  assert.equal(
    await tx((q) =>
      q.employmentTerms.count({
        where: { tenantId: tenant, employeeId: employee.id },
      }),
    ),
    1,
  );
  assert.equal(
    await tx((q) =>
      q.payrollAssignment.count({
        where: { tenantId: tenant, employeeId: employee.id },
      }),
    ),
    0,
  );
  assert.equal(
    await tx((q) =>
      q.onboardingChecklist.count({
        where: { tenantId: tenant, employeeId: employee.id },
      }),
    ),
    1,
  );
  assert.ok(
    (await tx((q) =>
      q.onboardingTask.count({
        where: { tenantId: tenant, checklistId: handoff.checklistId },
      }),
    )) > 0,
  );
  const replay = await ctx(() =>
    runOfferHandoff({
      offerId: offer.id,
      tenantId: tenant,
      actorId: people.REQUESTER.id,
    }),
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.handoff.employeeId, employee.id);
  assert.ok(results.every((x) => x.offer.status === "ACCEPTED"));
  assert.equal(
    await tx((q) =>
      q.outboxEvent.count({
        where: {
          tenantId: tenant,
          eventName: "hr.recruitment.candidate_hired.v1",
          aggregateId: String(offer.candidateId),
        },
      }),
    ),
    1,
  );
});
test("erased candidate cannot be copied into an employee by a delayed handoff", async () => {
  const offer = await readyOffer();
  // Persisted acceptance may be recovered asynchronously after a worker outage.
  await tx((q) =>
    q.offer.update({
      where: { id: offer.id },
      data: { status: "ACCEPTED", respondedAt: new Date() },
    }),
  );
  const before = await tx((q) =>
    q.employee.count({ where: { tenant_id: tenant } }),
  );
  await tx((q) =>
    q.candidate.update({
      where: { id: offer.candidateId },
      data: {
        anonymizedAt: new Date(),
        firstName: "Erased",
        email: "erased-" + randomUUID() + "@example.invalid",
      },
    }),
  );
  await assert.rejects(
    ctx(() => runOfferHandoff({ offerId: offer.id, tenantId: tenant })),
    (e) => e.code === "HR-5701",
  );
  assert.equal(
    await tx((q) => q.employee.count({ where: { tenant_id: tenant } })),
    before,
  );
  const handoff = await tx((q) =>
    q.offerHandoff.findUnique({ where: { offerId: offer.id } }),
  );
  assert.equal(handoff.status, "FAILED");
  assert.equal(handoff.employeeId, null);
});
test("staff intake waits for erasure before inserting any application child data", async () => {
  const offer = await readyOffer();
  const c = await tx(async (q) => {
    const c = await q.candidate.create({
      data: {
        tenantId: tenant,
        firstName: "Fictional intake",
        email: randomUUID() + "@example.invalid",
        consentStatus: "GRANTED",
      },
    });
    await q.candidateConsent.create({
      data: {
        tenantId: tenant,
        candidateId: c.id,
        purpose: "PROCESSING",
        status: "GRANTED",
        policyVersion: "test",
      },
    });
    return c;
  });
  let release, started;
  const hold = new Promise((r) => (release = r)),
    ready = new Promise((r) => (started = r));
  const erasing = tx(async (q) => {
    await q.candidate.update({
      where: { id: c.id },
      data: { anonymizedAt: new Date(), firstName: "Erased" },
    });
    started();
    await hold;
  });
  await ready;
  const { createApplication } =
    await import("../../src/services/applicationService.js");
  let result;
  const intake = mcpCtx
    .run(
      {
        actorVerified: true,
        user: {
          tenantId: tenant,
          userId: people.REQUESTER.userId,
          roles: ["RECRUITER"],
        },
        permissions: ["hr.recruitment.create"],
      },
      () =>
        createApplication({
          tenantId: tenant,
          candidateId: c.id,
          jobRequisitionId: offer.jobRequisitionId,
        }),
    )
    .then(
      (value) => (result = { value }),
      (error) => (result = { error }),
    );
  try {
    let blocked = false;
    for (let n = 0; n < 100; n++) {
      const waiting = await tx((q) =>
        q.$queryRawUnsafe(
          "SELECT pid FROM pg_stat_activity WHERE usename=current_user AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM \"Candidate\"%'",
        ),
      );
      if (waiting.length) {
        blocked = true;
        break;
      }
      if (result) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(blocked, true);
  } finally {
    release();
    await erasing;
    await intake;
  }
  assert.equal(result.error?.status, 404);
  assert.equal(
    await tx((q) =>
      q.application.count({ where: { tenantId: tenant, candidateId: c.id } }),
    ),
    0,
  );
});
test.after(() => db.$disconnect());
