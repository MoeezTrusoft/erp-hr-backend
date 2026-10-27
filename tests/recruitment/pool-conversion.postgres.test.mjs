import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, randomInt } from "node:crypto";
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
process.env.HR_PORTAL_BASE_URL = "https://careers.example.invalid";
process.env.HR_PORTAL_PRIVACY_POLICY_VERSION = "test-policy";
process.env.HR_PORTAL_PRIVACY_POLICY_URL = "https://example.invalid/privacy";
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const drafts = await import("../../src/services/applicationDraft.service.js");
const { submitPublicApplication } =
  await import("../../src/services/publicPortal.service.js");
const tenant = randomUUID();
const as = (fn) =>
  mcpCtx.run({ user: { tenantId: tenant }, publicPortal: true }, fn);
const tx = (fn) =>
  as(() =>
    tenantTransaction(db, fn, {
      tenantId: tenant,
      txOptions: { timeout: 30000 },
    }),
  );
let employee;
test.before(async () => {
  employee = await tx((q) =>
    q.employee.create({
      data: {
        tenant_id: tenant,
        userId: randomInt(10000, 100000000),
        employee_code: "POOL-" + randomUUID().toUpperCase(),
        employeeCategory: "EMPLOYEE",
        first_name: "Fictional",
        status: "Active",
        employement_status: "Active",
      },
    }),
  );
});
async function fixture(status = "ACCEPTED") {
  const token = randomBytes(32).toString("base64url");
  return tx(async (q) => {
    const job = await q.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Fictional opportunity",
        requestedById: employee.id,
        status: "POSTED",
      },
    });
    await q.jobPosting.create({
      data: {
        tenantId: tenant,
        requisitionId: job.id,
        channel: "CAREER_SITE",
        isActive: true,
      },
    });
    const c = await q.candidate.create({
      data: {
        tenantId: tenant,
        firstName: "Fictional",
        email: randomUUID() + "@example.invalid",
      },
    });
    const question = await q.applicationQuestion.create({
      data: {
        tenantId: tenant,
        requisitionId: job.id,
        type: "BOOLEAN",
        prompt: "Can you meet the published requirement?",
        required: true,
        knockout: true,
        weights: { true: 1, false: 0 },
        maxScore: 1,
        minimumScore: 1,
      },
    });
    const invitation = await q.talentPoolInvitation.create({
      data: {
        tenantId: tenant,
        candidateId: c.id,
        jobRequisitionId: job.id,
        status,
        respondedAt: status === "INVITED" ? null : new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        invitedById: employee.id,
      },
    });
    const payload = {
      firstName: "Fictional",
      consent: true,
      policyVersion: "test-policy",
      answers: { [question.id]: true },
    };
    const draft = await q.applicationDraft.create({
      data: {
        tenantId: tenant,
        candidateId: c.id,
        requisitionId: job.id,
        payload,
        tokenHash: drafts.hashDraftToken(token),
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    return { c, job, question, invitation, draft, token, payload };
  });
}
test("accepted invitation becomes a screening application only after verified consent and questions, with canonical history", async () => {
  const f = await fixture();
  const result = await as(() =>
    drafts.submitApplicationDraft({ tenantId: tenant, token: f.token }),
  );
  const app = await tx((q) =>
    q.application.findUnique({
      where: { id: result.applicationId },
      include: { stageHistory: true, screenings: true, answers: true },
    }),
  );
  assert.equal(app.stage, "screening");
  assert.equal(app.version, 1);
  assert.equal(app.talentPoolInvitationId, f.invitation.id);
  assert.equal(app.screenings.length, 0);
  assert.equal(app.answers[0].value, true);
  assert.deepEqual(
    app.stageHistory.map((h) => h.toStage),
    ["applied", "screening"],
  );
  assert.equal(app.stageHistory[1].source, "talent-pool-invitation");
  assert.equal(
    await tx((q) =>
      q.candidateConsent.count({
        where: {
          candidateId: f.c.id,
          purpose: "PROCESSING",
          status: "GRANTED",
        },
      }),
    ),
    1,
  );
  await assert.rejects(
    as(() =>
      drafts.submitApplicationDraft({ tenantId: tenant, token: f.token }),
    ),
    { status: 400 },
  );
  assert.equal(
    await tx((q) =>
      q.application.count({
        where: { candidateId: f.c.id, jobRequisitionId: f.job.id },
      }),
    ),
    1,
  );
});
test("missing consent or required answers rolls back draft consumption and every application write", async () => {
  for (const patch of [{ consent: false }, { answers: {} }]) {
    const f = await fixture();
    await tx((q) =>
      q.applicationDraft.update({
        where: { id: f.draft.id },
        data: { payload: { ...f.payload, ...patch } },
      }),
    );
    await assert.rejects(
      as(() =>
        drafts.submitApplicationDraft({ tenantId: tenant, token: f.token }),
      ),
      { status: 400 },
    );
    assert.equal(
      await tx((q) => q.application.count({ where: { candidateId: f.c.id } })),
      0,
    );
    assert.equal(
      (
        await tx((q) =>
          q.applicationDraft.findUnique({ where: { id: f.draft.id } }),
        )
      ).submittedAt,
      null,
    );
  }
});
test("an anonymous email submission cannot attach or advance an accepted invitation", async () => {
  const f = await fixture();
  const result = await as(() =>
    submitPublicApplication({
      tenantId: tenant,
      requisitionId: f.job.id,
      body: { ...f.payload, email: f.c.email },
    }),
  );
  const app = await tx((q) =>
    q.application.findUnique({ where: { id: result.applicationId } }),
  );
  assert.equal(app.stage, "applied");
  assert.equal(app.talentPoolInvitationId, null);
});
test("unaccepted invitations stay outside the conversion path", async () => {
  for (const status of ["INVITED", "DECLINED", "EXPIRED"]) {
    const f = await fixture(status);
    const result = await as(() =>
      drafts.submitApplicationDraft({ tenantId: tenant, token: f.token }),
    );
    const app = await tx((q) =>
      q.application.findUnique({ where: { id: result.applicationId } }),
    );
    assert.equal(app.stage, "applied");
    assert.equal(app.talentPoolInvitationId, null);
  }
});
test("database rejects another candidate invitation and privacy deletion clears the link", async () => {
  const f = await fixture(),
    other = await fixture();
  const result = await as(() =>
    drafts.submitApplicationDraft({ tenantId: tenant, token: f.token }),
  );
  await assert.rejects(
    tx((q) =>
      q.application.update({
        where: { id: result.applicationId },
        data: { talentPoolInvitationId: other.invitation.id },
      }),
    ),
    /invitation does not match/,
  );
  await tx((q) =>
    q.talentPoolInvitation.delete({ where: { id: f.invitation.id } }),
  );
  assert.equal(
    (
      await tx((q) =>
        q.application.findUnique({ where: { id: result.applicationId } }),
      )
    ).talentPoolInvitationId,
    null,
  );
});
test("staff intake uses verified identity, checks consent and deduplicates concurrent creation", async () => {
  const { createApplication } =
    await import("../../src/services/applicationService.js");
  const f = await fixture();
  const staff = (fn, role = "RECRUITER") =>
    mcpCtx.run(
      {
        actorVerified: true,
        user: { tenantId: tenant, userId: employee.userId, roles: [role] },
        permissions: ["hr.recruitment.create"],
      },
      fn,
    );
  const args = {
    tenantId: tenant,
    candidateId: f.c.id,
    jobRequisitionId: f.job.id,
    createdById: 999999,
  };
  await assert.rejects(
    staff(() => createApplication(args), "HIRING_MANAGER"),
    { status: 403 },
  );
  await assert.rejects(staff(() => createApplication(args)));
  await tx((q) =>
    q.candidateConsent.create({
      data: {
        tenantId: tenant,
        candidateId: f.c.id,
        purpose: "PROCESSING",
        status: "GRANTED",
        policyVersion: "test",
        source: "RECORDED",
      },
    }),
  );
  await assert.rejects(
    staff(() => createApplication({ ...args, status: "hired" })),
    { status: 409 },
  );
  const [a, b] = await Promise.all([
    staff(() => createApplication(args)),
    staff(() => createApplication({ ...args, candidateId: String(f.c.id) })),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(a.createdById, employee.id);
  assert.equal(a.stage, "applied");
  assert.equal(a.status, "open");
  assert.equal(
    await tx((q) =>
      q.applicationStageHistory.count({ where: { applicationId: a.id } }),
    ),
    1,
  );
});
test("verified resubmission links an existing applied application once without changing its answers", async () => {
  const f = await fixture();
  const initial = await as(() =>
    submitPublicApplication({
      tenantId: tenant,
      requisitionId: f.job.id,
      body: { ...f.payload, email: f.c.email },
    }),
  );
  const before = await tx((q) =>
    q.application.findUnique({
      where: { id: initial.applicationId },
      include: { answers: true },
    }),
  );
  const result = await as(() =>
    drafts.submitApplicationDraft({ tenantId: tenant, token: f.token }),
  );
  assert.equal(result.applicationId, initial.applicationId);
  const current = await tx((q) =>
    q.application.findUnique({
      where: { id: initial.applicationId },
      include: { answers: true, stageHistory: true },
    }),
  );
  assert.equal(current.stage, "screening");
  assert.equal(current.talentPoolInvitationId, f.invitation.id);
  assert.deepEqual(current.answers, before.answers);
  assert.equal(current.stageHistory.length, 2);
  const { convertAcceptedPoolInvitation } =
    await import("../../src/services/talentPoolConversion.service.js");
  await tx((q) => convertAcceptedPoolInvitation(q, current));
  assert.equal(
    await tx((q) =>
      q.applicationStageHistory.count({ where: { applicationId: current.id } }),
    ),
    2,
  );
});
test("verified invitation follow-through cannot reopen a withdrawn or rejected application", async () => {
  for (const stage of ["withdrawn", "rejected"]) {
    const f = await fixture();
    const initial = await as(() =>
      submitPublicApplication({
        tenantId: tenant,
        requisitionId: f.job.id,
        body: { ...f.payload, email: f.c.email },
      }),
    );
    await tx((q) =>
      q.application.update({
        where: { id: initial.applicationId },
        data: { stage, status: stage },
      }),
    );
    const result = await as(() =>
      drafts.submitApplicationDraft({ tenantId: tenant, token: f.token }),
    );
    assert.equal(result.applicationId, initial.applicationId);
    const current = await tx((q) =>
      q.application.findUnique({ where: { id: initial.applicationId } }),
    );
    assert.equal(current.stage, stage);
    assert.equal(current.talentPoolInvitationId, null);
  }
});
test.after(() => db.$disconnect());
