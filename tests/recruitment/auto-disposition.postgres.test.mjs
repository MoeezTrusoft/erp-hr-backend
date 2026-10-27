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
process.env.HR_RECRUITMENT_COMMUNICATIONS = "true";
process.env.HR_PORTAL_BASE_URL = "https://careers.example.invalid";
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const settings =
  await import("../../src/services/recruitmentSettings.service.js");
const scores =
  await import("../../src/services/applicationFitScore.service.js");
const auto =
  await import("../../src/services/applicationAutoDisposition.service.js");
const { runApplicationScoring } =
  await import("../../src/services/applicationScoringWorker.service.js");
const { transitionApplicationStage } =
  await import("../../src/services/applicationWorkflow.service.js");
const { runCandidateCommunicationProjection } =
  await import("../../src/services/candidateCommunicationEvents.service.js");
const { runCandidateCommunicationDelivery } =
  await import("../../src/services/candidateCommunicationDelivery.service.js");
const tenant = randomUUID();
let employee, job, question;
const tx = (fn) =>
  mcpCtx.run({ user: { tenantId: tenant } }, () =>
    tenantTransaction(db, fn, { tenantId: tenant }),
  );
const as = (
  fn,
  role = "RECRUITER",
  permissions = ["hr.recruitment.read", "hr.recruitment.update"],
) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: { tenantId: tenant, userId: employee.userId, roles: [role] },
      permissions,
    },
    fn,
  );
const system = (fn) => mcpCtx.run({ system: true }, fn);
async function fixture(answer = false) {
  return tx(async (q) => {
    const c = await q.candidate.create({
      data: {
        tenantId: tenant,
        firstName: "Fictional",
        email: randomUUID() + "@example.invalid",
        consentStatus: "GRANTED",
      },
    });
    await q.candidateConsent.create({data:{tenantId:tenant,candidateId:c.id,purpose:'PROCESSING',status:'GRANTED',policyVersion:'test-policy',source:'SELF_SERVICE'}});
    const a = await q.application.create({
      data: {
        tenantId: tenant,
        candidateId: c.id,
        jobRequisitionId: job.id,
        questionSnapshot: [
          {
            questionId: question.id,
            questionVersion: 1,
            knockout: true,
            minimumScore: 1,
          },
        ],
      },
    });
    if (answer !== null)
      await q.applicationAnswer.create({
        data: {
          applicationId: a.id,
          questionId: question.id,
          value: answer,
          score: answer ? 1 : 0,
        },
      });
    return a;
  });
}
async function changePolicy(values) {
  const current = await as(() => settings.recruitmentSettingsGet(), "HR_ADMIN");
  return as(
    () =>
      settings.recruitmentSettingsSet({
        policy: { ...current.policy, ...values },
        expectedVersion: current.version,
        reason: "Approved explicit job requirement policy",
      }),
    "HR_ADMIN",
  );
}
async function apply(app, now = new Date()) {
  return tx(async (q) => {
    const score = await scores.refreshFitScore(q, {
      tenantId: tenant,
      applicationId: app.id,
    });
    return auto.applyAutomaticKnockout(q, {
      tenantId: tenant,
      applicationId: app.id,
      score,
      now,
    });
  });
}
const state = (a) =>
  tx((q) => q.application.findUnique({ where: { id: a.id } }));
const projection = () =>
  system(() => runCandidateCommunicationProjection({ tenantId: tenant }));
test.before(async () => {
  await tx(async (q) => {
    employee = await q.employee.create({
      data: {
        tenant_id: tenant,
        userId: randomInt(10000, 100000000),
        employee_code: "KO-" + randomUUID().toUpperCase(),
        employeeCategory: "EMPLOYEE",
        first_name: "Fictional",
        status: "Active",
        employement_status: "Active",
      },
    });
    job = await q.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Fictional editor",
        requestedById: employee.id,
        status: "POSTED",
      },
    });
    question = await q.applicationQuestion.create({
      data: {
        tenantId: tenant,
        requisitionId: job.id,
        type: "BOOLEAN",
        prompt: "Job-related required certification",
        required: true,
        knockout: true,
        minimumScore: 1,
        maxScore: 1,
        weights: { true: 1, false: 0 },
      },
    });
  });
});
test("automatic rejection is opt-in and missing answers are never treated as failures", async () => {
  const a = await fixture();
  assert.equal(await apply(a), null);
  assert.equal((await state(a)).stage, "applied");
  await changePolicy({ autoRejectKnockouts: true, rejectionDelayHours: 2 });
  const missing = await fixture(null);
  assert.equal(await apply(missing), null);
  assert.equal((await state(missing)).stage, "applied");
  const passed = await fixture(true);
  assert.equal(await apply(passed), null);
});
test("worker rejects once with frozen evidence, history and delayed notice; low advisory score alone cannot reject", async () => {
  const a = await fixture();
  await system(() => runApplicationScoring({ tenantId: tenant }));
  const current = await state(a);
  assert.equal(current.stage, "rejected");
  assert.equal(current.dispositionReason, "MINIMUM_REQUIREMENTS_NOT_MET");
  const row = await tx((q) =>
    q.applicationAutoDisposition.findUnique({ where: { applicationId: a.id } }),
  );
  assert.equal(row.rejectionVersion, current.version);
  assert.equal(row.policyVersion, 1);
  assert.equal(await apply(a), null);
  assert.equal(
    await tx((q) =>
      q.applicationStageHistory.count({ where: { applicationId: a.id } }),
    ),
    1,
  );
  await changePolicy({ rejectionDelayHours: 4 });
  await projection();
  const notice = await tx((q) =>
    q.candidateCommunication.findFirst({
      where: { applicationId: a.id, templateKey: "application_rejected" },
    }),
  );
  assert.equal(notice.scheduledAt.getTime(), row.noticeDueAt.getTime());
  assert.equal(notice.context.expectedApplicationVersion, row.rejectionVersion);
  await assert.rejects(
    tx((q) =>
      q.applicationAutoDisposition.update({
        where: { id: row.id },
        data: { noticeDueAt: new Date(Date.now() + 86400000) },
      }),
    ),
  );
  const good = await fixture(true);
  await tx(async (q) => {
    const score = await scores.refreshFitScore(q, {
      tenantId: tenant,
      applicationId: good.id,
    });
    assert.equal(
      await auto.applyAutomaticKnockout(q, {
        tenantId: tenant,
        applicationId: good.id,
        score: { ...score, scorePct: 0, knockoutFailed: false },
      }),
      null,
    );
  });
});
test("authorized human reversal restores applied, cancels the delayed notice and cannot auto-reject again", async () => {
  const a = await fixture();
  const row = await apply(a);
  await projection();
  const result = await as(() =>
    auto.reverseAutomaticKnockout({
      applicationId: a.id,
      expectedVersion: row.rejectionVersion,
      reason: "Verified alternate equivalent certification",
    }),
  );
  assert.equal(result.stage, "applied");
  assert.equal((await state(a)).dispositionReason, null);
  assert.equal(await apply(a), null);
  assert.equal(
    await tx((q) =>
      q.candidateCommunication.count({
        where: {
          applicationId: a.id,
          templateKey: "application_rejected",
          status: "CANCELLED",
        },
      }),
    ),
    1,
  );
  const saved = await tx((q) =>
    q.applicationAutoDisposition.findUnique({ where: { applicationId: a.id } }),
  );
  assert.equal(saved.reversedById, employee.id);
  assert.ok(saved.reversedAt);
  await assert.rejects(
    tx((q) =>
      q.applicationAutoDisposition.update({
        where: { id: row.id },
        data: { reversalReason: "Rewrite the original decision" },
      }),
    ),
  );
  await assert.rejects(
    as(() =>
      auto.reverseAutomaticKnockout({
        applicationId: a.id,
        expectedVersion: result.version,
        reason: "Try a second reversal operation",
      }),
    ),
    { status: 409 },
  );
});
test("interviewer, missing permission and another tenant cannot reverse; stale versions fail", async () => {
  const a = await fixture(),
    row = await apply(a),
    args = {
      applicationId: a.id,
      expectedVersion: row.rejectionVersion,
      reason: "Review verified certification evidence",
    };
  await assert.rejects(
    as(() => auto.reverseAutomaticKnockout(args), "INTERVIEWER"),
    { status: 403 },
  );
  await assert.rejects(
    as(() => auto.reverseAutomaticKnockout(args), "HR_ADMIN", []),
    { status: 403 },
  );
  await assert.rejects(
    mcpCtx.run(
      {
        actorVerified: true,
        user: {
          tenantId: randomUUID(),
          userId: employee.userId,
          roles: ["RECRUITER"],
        },
        permissions: ["hr.recruitment.update"],
      },
      () => auto.reverseAutomaticKnockout(args),
    ),
  );
  await assert.rejects(
    as(() =>
      auto.reverseAutomaticKnockout({
        ...args,
        expectedVersion: row.rejectionVersion + 1,
      }),
    ),
    { status: 412 },
  );
  assert.equal((await state(a)).stage, "rejected");
});
test("ordinary rejected applications stay terminal and expired automatic reversals are refused", async () => {
  const a = await fixture();
  await tx((q) =>
    transitionApplicationStage({
      db: q,
      id: a.id,
      tenantId: tenant,
      targetStage: "rejected",
      reason: "Human review decision",
    }),
  );
  await assert.rejects(
    as(() =>
      auto.reverseAutomaticKnockout({
        applicationId: a.id,
        expectedVersion: a.version + 1,
        reason: "Try to bypass terminal workflow",
      }),
    ),
    { status: 409 },
  );
  const expired = await fixture(),
    row = await apply(expired, new Date(Date.now() - 8 * 3600000));
  await assert.rejects(
    as(() =>
      auto.reverseAutomaticKnockout({
        applicationId: expired.id,
        expectedVersion: row.rejectionVersion,
        reason: "Try after the notification window",
      }),
    ),
    { status: 409 },
  );
});
test("late event projection cannot send a reversed rejection and a current due rejection sends once", async () => {
  const reversed = await fixture(),
    row = await apply(reversed);
  await as(() =>
    auto.reverseAutomaticKnockout({
      applicationId: reversed.id,
      expectedVersion: row.rejectionVersion,
      reason: "Certification independently verified",
    }),
  );
  await projection();
  const active = await fixture(),
    due = await apply(active, new Date(Date.now() - 8 * 3600000));
  await projection();
  const sent = [];
  const send = async (message) => {
    sent.push(message);
    return { sent: true, notificationId: randomUUID() };
  };
  await system(() =>
    runCandidateCommunicationDelivery({
      tenantId: tenant,
      now: new Date(Date.now() + 5 * 3600000),
      send,
    }),
  );
  const oldNotice = await tx((q) =>
    q.candidateCommunication.findFirst({
      where: {
        applicationId: reversed.id,
        templateKey: "application_rejected",
      },
    }),
  );
  assert.equal(oldNotice.status, "CANCELLED");
  const notice = await tx((q) =>
    q.candidateCommunication.findFirst({
      where: { applicationId: active.id, templateKey: "application_rejected" },
    }),
  );
  assert.equal(notice.status, "SENT");
  assert.equal(notice.scheduledAt >= due.noticeDueAt, true);
  assert.equal(
    sent.filter((m) => m.dedupeKey === "recruitment:" + notice.id).length,
    1,
  );
});
test.after(() => db.$disconnect());
