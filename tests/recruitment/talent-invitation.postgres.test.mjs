import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt, randomBytes, createHash } from "node:crypto";
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
const { inviteCandidate } =
  await import("../../src/services/talentPoolMgmt.service.js");
const {
  inviteToApply,
  respondToInvitation,
  withdrawInvitation,
  listInvitations,
  respondToOwnInvitation,
  listOwnInvitations,
  expireInvitations,
} = await import("../../src/services/talentPoolInvitation.service.js");
const { runCandidateCommunicationDelivery } =
  await import("../../src/services/candidateCommunicationDelivery.service.js");
const tenant = randomUUID();
let employee, job;
const tx = (fn) =>
  mcpCtx.run({ user: { tenantId: tenant } }, () =>
    tenantTransaction(db, fn, {
      tenantId: tenant,
      txOptions: { timeout: 20000, maxWait: 10000 },
    }),
  );
const as = (fn, role = "RECRUITER") =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: { tenantId: tenant, userId: employee.userId, roles: [role] },
      permissions: [
        "hr.recruitment.read",
        "hr.recruitment.update",
        "hr.recruitment.create",
      ],
    },
    fn,
  );
const candidate = async (consent = true) =>
  tx(async (q) => {
    const c = await q.candidate.create({
      data: {
        tenantId: tenant,
        firstName: "Fictional",
        email: randomUUID() + "@example.invalid",
        notes: "Original evidence",
      },
    });
    if (consent)
      await q.candidateConsent.create({
        data: {
          tenantId: tenant,
          candidateId: c.id,
          purpose: "TALENT_POOL",
          status: "GRANTED",
          policyVersion: "test-policy",
          source: "SELF_SERVICE",
        },
      });
    return c;
  });
test.before(async () => {
  await tx(async (q) => {
    employee = await q.employee.create({
      data: {
        tenant_id: tenant,
        userId: randomInt(10000, 100000000),
        employee_code: "INVITE-" + randomUUID().toUpperCase(),
        employeeCategory: "EMPLOYEE",
        first_name: "Fictional",
        status: "Active",
        employement_status: "Active",
      },
    });
    job = await q.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Public editorial opportunity",
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
  });
});
test("parallel invites reuse one open invitation and durable message without applying or rewriting notes", async () => {
  const c = await candidate();
  const args = {
    tenantId: tenant,
    candidateId: c.id,
    jobRequisitionId: job.id,
  };
  const [one, two] = await Promise.all([
    as(() => inviteCandidate(args)),
    as(() => inviteCandidate(args)),
  ]);
  assert.equal(one.invitation.id, two.invitation.id);
  assert.equal(one.invitation.invitedById, employee.id);
  assert.equal(
    await tx((q) =>
      q.candidateCommunication.count({
        where: {
          tenantId: tenant,
          candidateId: c.id,
          templateKey: "talent_invitation",
        },
      }),
    ),
    1,
  );
  assert.equal(
    await tx((q) =>
      q.application.count({ where: { tenantId: tenant, candidateId: c.id } }),
    ),
    0,
  );
  assert.equal(
    (await tx((q) => q.candidate.findUnique({ where: { id: c.id } }))).notes,
    "Original evidence",
  );
});
test("missing consent, unauthorized manager and closed or unpublished jobs do not queue invitations", async () => {
  const c = await candidate(false);
  await assert.rejects(
    as(() =>
      inviteCandidate({
        tenantId: tenant,
        candidateId: c.id,
        jobRequisitionId: job.id,
      }),
    ),
  );
  const granted = await candidate();
  await assert.rejects(
    as(
      () =>
        inviteCandidate({
          tenantId: tenant,
          candidateId: granted.id,
          jobRequisitionId: job.id,
        }),
      "HIRING_MANAGER",
    ),
    { status: 403 },
  );
  const draft = await tx((q) =>
    q.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Not published",
        requestedById: employee.id,
      },
    }),
  );
  await assert.rejects(
    as(() =>
      inviteCandidate({
        tenantId: tenant,
        candidateId: granted.id,
        jobRequisitionId: draft.id,
      }),
    ),
    { status: 409 },
  );
  assert.equal(
    await tx((q) =>
      q.talentPoolInvitation.count({ where: { candidateId: granted.id } }),
    ),
    0,
  );
});
test("an outer transaction rollback removes both invitation and queued message", async () => {
  const c = await candidate();
  await assert.rejects(
    tx(async (q) => {
      await inviteToApply({
        tenantId: tenant,
        candidateId: c.id,
        jobRequisitionId: job.id,
        actorId: employee.id,
        db: q,
      });
      throw new Error("Intentional rollback");
    }),
  );
  assert.equal(
    await tx((q) =>
      q.talentPoolInvitation.count({ where: { candidateId: c.id } }),
    ),
    0,
  );
  assert.equal(
    await tx((q) =>
      q.candidateCommunication.count({ where: { candidateId: c.id } }),
    ),
    0,
  );
});
test("delivery resolves the current invitation and job; withdrawn invitations never send", async () => {
  const c = await candidate(),
    inv = await as(() =>
      inviteCandidate({
        tenantId: tenant,
        candidateId: c.id,
        jobRequisitionId: job.id,
      }),
    );
  await tx((q) =>
    q.talentPoolInvitation.update({
      where: { id: inv.invitation.id },
      data: { status: "WITHDRAWN", respondedAt: new Date() },
    }),
  );
  const sent = [];
  await mcpCtx.run({ system: true }, () =>
    runCandidateCommunicationDelivery({
      tenantId: tenant,
      send: async (m) => {
        sent.push(m);
        return { sent: true, notificationId: randomUUID() };
      },
    }),
  );
  const notice = await tx((q) =>
    q.candidateCommunication.findFirst({ where: { candidateId: c.id } }),
  );
  assert.equal(notice.status, "CANCELLED");
  assert.ok(
    sent.some(
      (m) =>
        m.templateId === "hr.recruitment.candidate.talent_invitation" &&
        m.data.portalUrl === "https://careers.example.invalid/jobs/" + job.id,
    ),
  );
  assert.equal(
    sent.some((m) => m.email === c.email),
    false,
  );
});
test("verified candidate ownership and recruiter roles protect invitation responses", async () => {
  const c = await candidate(),
    other = await candidate(),
    inv = await as(() =>
      inviteCandidate({
        tenantId: tenant,
        candidateId: c.id,
        jobRequisitionId: job.id,
      }),
    ),
    wrong = await as(() =>
      inviteCandidate({
        tenantId: tenant,
        candidateId: other.id,
        jobRequisitionId: job.id,
      }),
    );
  const token = randomBytes(32).toString("base64url");
  await tx((q) =>
    q.candidateEmailVerification.create({
      data: {
        tenantId: tenant,
        candidateId: c.id,
        email: c.email,
        purpose: "STATUS_LINK",
        tokenHash: createHash("sha256").update(token).digest("hex"),
        expiresAt: new Date(Date.now() + 3600000),
      },
    }),
  );
  const own = (fn) =>
    mcpCtx.run({ user: { tenantId: tenant }, publicPortal: true }, fn);
  const list = await own(() => listOwnInvitations({ tenantId: tenant, token }));
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].id, inv.invitation.id);
  assert.equal("responseNote" in list.items[0], false);
  await assert.rejects(
    own(() =>
      respondToOwnInvitation({
        tenantId: tenant,
        token,
        invitationId: wrong.invitation.id,
        response: "ACCEPTED",
      }),
    ),
    { status: 404 },
  );
  await assert.rejects(
    as(
      () =>
        respondToInvitation({
          tenantId: tenant,
          invitationId: inv.invitation.id,
          response: "ACCEPTED",
        }),
      "HIRING_MANAGER",
    ),
    { status: 403 },
  );
  const accepted = await own(() =>
    respondToOwnInvitation({
      tenantId: tenant,
      token,
      invitationId: inv.invitation.id,
      response: "ACCEPTED",
    }),
  );
  assert.equal(accepted.status, "ACCEPTED");
  assert.equal(
    (
      await own(() =>
        respondToOwnInvitation({
          tenantId: tenant,
          token,
          invitationId: inv.invitation.id,
          response: "ACCEPTED",
        }),
      )
    ).status,
    "ACCEPTED",
  );
  await assert.rejects(
    as(() =>
      withdrawInvitation({ tenantId: tenant, invitationId: inv.invitation.id }),
    ),
    { status: 409 },
  );
  const notice = await tx((q) =>
    q.candidateCommunication.findFirst({
      where: {
        tenantId: tenant,
        dedupeKey: "talent-invitation:" + inv.invitation.id,
      },
    }),
  );
  assert.equal(notice.status, "CANCELLED");
  assert.equal(
    (await as(() => listInvitations({ tenantId: tenant }), "HIRING_MANAGER"))
      .items.length,
    0,
  );
});
test("late responses become expired and due-only sweeps cannot be blocked by earlier open invitations", async () => {
  const c = await candidate(),
    c2 = await candidate();
  const expired = await tx((q) =>
    q.talentPoolInvitation.create({
      data: {
        tenantId: tenant,
        candidateId: c.id,
        jobRequisitionId: job.id,
        status: "INVITED",
        invitedAt: new Date(Date.now() - 86400000 * 4),
        expiresAt: new Date(Date.now() - 86400000),
      },
    }),
  );
  assert.equal(
    (
      await as(() =>
        respondToInvitation({
          tenantId: tenant,
          invitationId: expired.id,
          response: "ACCEPTED",
        }),
      )
    ).status,
    "EXPIRED",
  );
  const due = await tx((q) =>
    q.talentPoolInvitation.create({
      data: {
        tenantId: tenant,
        candidateId: c2.id,
        status: "INVITED",
        invitedAt: new Date(Date.now() - 86400000 * 4),
        expiresAt: new Date(Date.now() - 86400000),
      },
    }),
  );
  const sweep = await mcpCtx.run({ system: true }, () =>
    expireInvitations({ tenantId: tenant, dryRun: false, limit: 1 }),
  );
  assert.deepEqual(sweep.expired, [due.id]);
});
test("database prevents changing invitation identity and reopening a final answer", async () => {
  const c = await candidate(),
    inv = await as(() =>
      inviteCandidate({ tenantId: tenant, candidateId: c.id }),
    );
  await as(() =>
    withdrawInvitation({ tenantId: tenant, invitationId: inv.invitation.id }),
  );
  await assert.rejects(
    tx((q) =>
      q.talentPoolInvitation.update({
        where: { id: inv.invitation.id },
        data: { status: "INVITED", respondedAt: null },
      }),
    ),
  );
  await assert.rejects(
    tx((q) =>
      q.talentPoolInvitation.update({
        where: { id: inv.invitation.id },
        data: { jobRequisitionId: job.id },
      }),
    ),
  );
});
test("scheduled expiry enters scoped tenant context and cannot be invoked by a staff identity", async () => {
  const { runRecruitmentAutomation } =
    await import("../../src/services/recruitment-automation.service.js");
  const c = await candidate();
  const due = await tx((q) =>
    q.talentPoolInvitation.create({
      data: {
        tenantId: tenant,
        candidateId: c.id,
        status: "INVITED",
        invitedAt: new Date("1900-01-01"),
        expiresAt: new Date("1900-01-02"),
      },
    }),
  );
  await assert.rejects(
    as(() =>
      runRecruitmentAutomation({
        kind: "talent-pool-invitation-expiry",
        now: new Date("1900-01-03"),
      }),
    ),
    { status: 403 },
  );
  assert.equal(
    (
      await tx((q) =>
        q.talentPoolInvitation.findUnique({ where: { id: due.id } }),
      )
    ).status,
    "INVITED",
  );
  const result = await mcpCtx.run({ system: true }, () =>
    runRecruitmentAutomation({
      kind: "talent-pool-invitation-expiry",
      now: new Date("1900-01-03"),
    }),
  );
  assert.ok(
    result.results.find((x) => x.tenantId === tenant).expired.includes(due.id),
  );
  assert.equal(
    (
      await tx((q) =>
        q.talentPoolInvitation.findUnique({ where: { id: due.id } }),
      )
    ).status,
    "EXPIRED",
  );
});
test.after(() => db.$disconnect());
