import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const url = new URL(process.env.RECRUITMENT_TEST_DATABASE_URL || "");
const redis = new URL(process.env.REDIS_URL || "");
if (
  url.hostname !== "127.0.0.1" ||
  url.pathname !== "/hr_task_assessment_test" ||
  url.username !== "recruitment_test_user" ||
  redis.hostname !== "127.0.0.1"
)
  throw new Error("Use isolated same-pod PostgreSQL and Redis fixtures");
process.env.DATABASE_URL = url.href;
process.env.NODE_ENV = "test";
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 27).toString("base64");
process.env.HR_PORTAL_BASE_URL = "https://careers.example.invalid";
process.env.HR_PORTAL_PRIVACY_POLICY_VERSION = "agency-test-1";
process.env.HR_PORTAL_PRIVACY_POLICY_URL = "https://careers.example.invalid/privacy";
process.env.HR_RECRUITMENT_PUBLIC_PORTAL = "true";
process.env.HR_RECRUITMENT_AGENCY = "true";
process.env.NOTIFICATION_HUB_URL = "http://127.0.0.1:1";
process.env.NOTIFICATION_HUB_TIMEOUT = "100";
const { closeRecruitmentRateLimit } = await import("../../src/lib/recruitmentRateLimit.js");
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const service = await import("../../src/services/agencyRecruitment.service.js");
const drafts = await import("../../src/services/applicationDraft.service.js");
const publication = await import("../../src/services/requisitionPublication.service.js");
const { getPublicJob } = await import("../../src/lib/publicPortal.js");
const { transitionApplicationStageInTransaction } =
  await import("../../src/services/applicationWorkflow.service.js");
const { decryptString } = await import("../../src/lib/crypto.js");
const { resolveRecruitmentScope, candidateScopeWhere } =
  await import("../../src/lib/recruitmentAccess.js");
const { exportCandidateDataRequest } =
  await import("../../src/services/candidateDataExport.service.js");
const { CANDIDATE_EXPORT_SOURCES } =
  await import("../../src/services/candidateDataExport.catalog.js");
const tenant = randomUUID(),
  foreign = randomUUID();
const permissions = ["hr.recruitment.read", "hr.recruitment.create", "hr.recruitment.update"];
const agencyUser = {
  userId: "930001",
  email: randomUUID() + "@example.invalid",
  roles: ["AGENCY"],
};
const otherAgency = {
  userId: "930002",
  email: randomUUID() + "@example.invalid",
  roles: ["AGENCY"],
};
const foreignUser = {
  userId: "930003",
  email: randomUUID() + "@example.invalid",
  roles: ["AGENCY"],
};
const recruiterUser = {
  userId: "930004",
  email: randomUUID() + "@example.invalid",
  roles: ["RECRUITER"],
};
const context = (user, tenantId = tenant) => ({
  actorVerified: true,
  user: { ...user, tenantId },
  permissions,
});
const as = (user, fn, tenantId = tenant) => mcpCtx.run(context(user, tenantId), fn);
const tx = (fn, tenantId = tenant) =>
  mcpCtx.run({ user: { tenantId } }, () =>
    tenantTransaction(db, fn, { tenantId, txOptions: { timeout: 30000 } }),
  );
const publicAs = (fn) => mcpCtx.run({ user: { tenantId: tenant }, publicPortal: true }, fn);
const email = () => randomUUID() + "@example.invalid";
let agency, second, foreignAgency, recruiter, job, unassigned, expired, accepted;
async function invite(address = email(), user = agencyUser, extra = {}) {
  const args = {
    requisitionId: job.id,
    requestKey: randomUUID(),
    email: address,
    firstName: "Fictional contact",
    permissionToContact: true,
    ...extra,
  };
  const result = await as(user, () => service.createAgencySubmission(args));
  return { args, result };
}
async function link(address) {
  return tx(async (q) => {
    const candidate = await q.candidate.findFirstOrThrow({
      where: { tenantId: tenant, email: address },
    });
    const draft = await q.applicationDraft.findFirstOrThrow({
      where: { tenantId: tenant, candidateId: candidate.id, requisitionId: job.id },
    });
    const message = await q.candidateCommunication.findFirstOrThrow({
      where: {
        tenantId: tenant,
        candidateId: candidate.id,
        context: { path: ["tokenHash"], equals: draft.tokenHash },
      },
    });
    const token = new URL(
      JSON.parse(decryptString(message.encryptedPayload)).data.draftUrl,
    ).hash.slice("#token=".length);
    assert.equal(drafts.hashDraftToken(token), draft.tokenHash);
    const submission = await q.agencySubmission.findFirstOrThrow({
      where: { tenantId: tenant, id: draft.agencySubmissionId },
    });
    return { candidate, draft, submission, token };
  });
}
async function prepare(token, consent = true) {
  const view = await publicAs(() => drafts.loadApplicationDraft({ tenantId: tenant, token }));
  assert.ok(view);
  await publicAs(() =>
    drafts.updateApplicationDraft({
      tenantId: tenant,
      token,
      expectedUpdatedAt: view.updatedAt,
      body: {
        firstName: "Candidate supplied",
        consent,
        policyVersion: "agency-test-1",
        answers: {},
      },
    }),
  );
}
async function finish(token) {
  await prepare(token);
  return publicAs(() => drafts.submitApplicationDraft({ tenantId: tenant, token }));
}
const applicationFor = (own) =>
  tx((q) =>
    q.application.findFirstOrThrow({
      where: { tenantId: tenant, agencySubmissionId: own.submission.id },
    }),
  );
const move = (app, stage) =>
  as(recruiterUser, () =>
    tx((q) =>
      transitionApplicationStageInTransaction(
        {
          id: app.id,
          tenantId: tenant,
          actorId: recruiter.id,
          expectedVersion: app.version,
          targetStage: stage,
          reason: "Fictional review",
          source: "agency-test",
        },
        q,
      ),
    ),
  );
const decision = (own, version, state = "ACCEPTED") =>
  as(recruiterUser, () =>
    service.reviewAgencySubmission({
      submissionId: own.submission.id,
      expectedVersion: version,
      decision: state,
      reason: "Published recruitment criteria reviewed",
    }),
  );

test("agency recruitment preserves candidate consent and company ownership", async (t) => {
  await tx(async (q) => {
    recruiter = await q.employee.create({
      data: {
        tenant_id: tenant,
        employee_code: "AGENCY-" + randomUUID().toUpperCase().slice(0, 20),
        userId: Number(recruiterUser.userId),
        first_name: "Recruiter",
        status: "Active",
        employement_status: "Active",
        employeeCategory: "EMPLOYEE",
      },
    });
    const makeJob = async (title, closesAt = null) => {
      const row = await q.jobRequisition.create({
        data: {
          tenantId: tenant,
          title,
          requestedById: recruiter.id,
          status: "POSTED",
          closesAt,
          jobContent: {
            summary: "Published vacancy",
            privateBudget: "Do not disclose",
            skills: [{ name: "Editing", importance: "required" }],
          },
        },
      });
      await q.jobPosting.create({
        data: { tenantId: tenant, requisitionId: row.id, channel: "AGENCY", isActive: true },
      });
      return row;
    };
    job = await makeJob("Assigned agency role");
    unassigned = await makeJob("Unassigned role");
    expired = await makeJob("Expired role", new Date(0));
  });
  await t.test(
    "verified agency registration needs no fabricated Employee and rejects identity injection",
    async () => {
      assert.deepEqual(await as(agencyUser, () => service.getAgencyProfile({})), { profile: null });
      agency = await as(agencyUser, () =>
        service.saveAgencyProfile({ displayName: "Fictional agency A" }),
      );
      second = await as(otherAgency, () =>
        service.saveAgencyProfile({ displayName: "Fictional agency B" }),
      );
      foreignAgency = await as(
        foreignUser,
        () => service.saveAgencyProfile({ displayName: "Foreign agency" }),
        foreign,
      );
      assert.equal(agency.contactEmail, agencyUser.email);
      assert.equal(
        await tx((q) =>
          q.employee.count({ where: { tenant_id: tenant, userId: Number(agencyUser.userId) } }),
        ),
        0,
      );
      await assert.rejects(
        as(agencyUser, () => service.saveAgencyProfile({ displayName: "Hijack", userId: 930002 })),
      );
      await assert.rejects(
        mcpCtx.run({ ...context(agencyUser), actorVerified: false }, () =>
          service.getAgencyProfile(),
        ),
        { status: 403 },
      );
      await assert.rejects(
        mcpCtx.run({ ...context(agencyUser), permissions: [] }, () => service.getAgencyProfile()),
        { status: 403 },
      );
      await assert.rejects(
        as(recruiterUser, () => service.getAgencyProfile()),
        { status: 403 },
      );
    },
  );
  await t.test(
    "only assigned published jobs are visible and agency roles cannot use internal recruiter reads",
    async () => {
      assert.equal((await as(agencyUser, () => service.listAgencyJobs())).total, 0);
      for (const profile of [agency, second])
        await as(recruiterUser, () =>
          service.setAgencyAssignment({
            agencyId: profile.id,
            requisitionId: job.id,
            active: true,
            expectedVersion: 0,
          }),
        );
      await as(recruiterUser, () =>
        service.setAgencyAssignment({
          agencyId: agency.id,
          requisitionId: expired.id,
          active: true,
          expectedVersion: 0,
        }),
      );
      const jobs = await as(agencyUser, () => service.listAgencyJobs());
      assert.deepEqual(jobs.items[0].jobContent.skills, ["Editing"]);
      assert.deepEqual(
        jobs.items.map((row) => row.id),
        [job.id],
      );
      assert.equal(JSON.stringify(jobs).includes("privateBudget"), false);
      for (const id of [expired.id, unassigned.id])
        await assert.rejects(
          as(agencyUser, () => service.getAgencyJob({ requisitionId: id })),
          { status: 404 },
        );
      assert.equal(
        await publicAs(() => getPublicJob({ tenantId: tenant, prisma: db, id: job.id })),
        null,
      );
      await assert.rejects(
        as(agencyUser, () => service.listAgencyAccounts()),
        { status: 403 },
      );
      await assert.rejects(
        as(agencyUser, () => publication.listRequisitionPostings(job.id, tenant)),
        { status: 403 },
      );
      await assert.rejects(
        as(agencyUser, () => exportCandidateDataRequest({ tenantId: tenant, id: 1 })),
        { status: 403 },
      );
      const mixed = { ...agencyUser, roles: ["AGENCY", "HR_ADMIN"] };
      assert.equal(resolveRecruitmentScope(mixed).level, "AGENCY");
      assert.deepEqual(candidateScopeWhere(resolveRecruitmentScope(mixed)), { id: { in: [] } });
      await assert.rejects(
        as(mixed, () => service.listAgencySubmissions({ mode: "REVIEW" })),
        { status: 403 },
      );
      assert.equal(
        (await tx((q) => q.recruitmentAgency.findMany())).some(
          (row) => row.id === foreignAgency.id,
        ),
        false,
      );
      await assert.rejects(
        as(recruiterUser, () =>
          service.setAgencyAssignment({
            agencyId: foreignAgency.id,
            requisitionId: job.id,
            active: true,
            expectedVersion: 0,
          }),
        ),
        { status: 404 },
      );
    },
  );
  await t.test(
    "concurrent invitation retries preserve first ownership and return no mailbox-existence signal",
    async () => {
      const address = email(),
        args = {
          requisitionId: job.id,
          requestKey: randomUUID(),
          email: address,
          firstName: "Fictional contact",
          permissionToContact: true,
        };
      const results = await Promise.all([
        as(agencyUser, () => service.createAgencySubmission(args)),
        as(agencyUser, () => service.createAgencySubmission(args)),
      ]);
      assert.deepEqual(results, [{ received: true }, { received: true }]);
      accepted = await link(address);
      assert.equal(accepted.candidate.ownerAgencyId, agency.id);
      assert.equal(accepted.candidate.consentStatus, "UNKNOWN");
      assert.equal(accepted.draft.source, "AGENCY");
      assert.equal(
        await tx((q) =>
          q.application.count({ where: { tenantId: tenant, candidateId: accepted.candidate.id } }),
        ),
        0,
      );
      assert.equal(
        await tx((q) =>
          q.candidateCommunication.count({
            where: { tenantId: tenant, candidateId: accepted.candidate.id },
          }),
        ),
        1,
      );
      assert.deepEqual((await invite(address, otherAgency)).result, { received: true });
      assert.equal((await as(otherAgency, () => service.listAgencySubmissions())).total, 0);
      await assert.rejects(
        as(otherAgency, () => service.createAgencySubmission(args)),
        { status: 409 },
      );
      await assert.rejects(
        as(agencyUser, () => service.createAgencySubmission({ ...args, firstName: "Changed" })),
        { status: 409 },
      );
      await invite(address);
      assert.equal(
        await tx((q) =>
          q.candidateCommunication.count({
            where: { tenantId: tenant, candidateId: accepted.candidate.id },
          }),
        ),
        1,
      );
      const existing = email();
      await tx((q) =>
        q.candidate.create({
          data: { tenantId: tenant, email: existing, firstName: "Public", source: "PORTAL" },
        }),
      );
      assert.deepEqual((await invite(existing)).result, { received: true });
      const mine = await as(agencyUser, () => service.listAgencySubmissions());
      for (const field of [
        "candidateId",
        "email",
        "assessment",
        "score",
        "applicationId",
        "agencyId",
      ])
        assert.equal(field in mine.items[0], false);
      await assert.rejects(
        as(agencyUser, () =>
          service.createAgencySubmission({
            ...args,
            requestKey: randomUUID(),
            permissionToContact: false,
          }),
        ),
      );
      await assert.rejects(
        as(agencyUser, () =>
          service.createAgencySubmission({ ...args, requestKey: randomUUID(), consent: true }),
        ),
      );
    },
  );
  await t.test(
    "only candidate-owned consent submits the application; agency cannot accept it",
    async () => {
      await assert.rejects(decision(accepted, 0), { status: 409 });
      await prepare(accepted.token, false);
      await assert.rejects(
        publicAs(() => drafts.submitApplicationDraft({ tenantId: tenant, token: accepted.token })),
        { code: "HR-5803" },
      );
      await finish(accepted.token);
      const app = await applicationFor(accepted);
      assert.equal(app.ownerAgencyId, agency.id);
      assert.equal(app.source, "AGENCY");
      const own = await link(accepted.candidate.email);
      assert.equal(own.candidate.consentStatus, "GRANTED");
      assert.equal(own.submission.state, "SUBMITTED");
      await assert.rejects(
        as(agencyUser, () =>
          service.reviewAgencySubmission({
            submissionId: own.submission.id,
            expectedVersion: 1,
            decision: "ACCEPTED",
            reason: "Self approval",
          }),
        ),
        { status: 403 },
      );
      await assert.rejects(move(app, "screening"), { code: "HR-5306" });
      await assert.rejects(
        tx((q) => q.application.update({ where: { id: app.id }, data: { stage: "screening" } })),
        /HR-5306/,
      );
    },
  );
  await t.test(
    "versioned recruiter acceptance opens screening and ownership cannot be rewritten",
    async () => {
      await assert.rejects(decision(accepted, 0), { status: 412 });
      const row = await decision(accepted, 1);
      assert.equal(row.state, "ACCEPTED");
      assert.equal(row.version, 2);
      await assert.rejects(decision(accepted, 2), { status: 409 });
      const app = await applicationFor(accepted);
      await move(app, "screening");
      assert.equal((await applicationFor(accepted)).stage, "screening");
      await assert.rejects(
        tx((q) =>
          q.candidate.update({
            where: { id: accepted.candidate.id },
            data: { ownerAgencyId: second.id },
          }),
        ),
        /HR-5306/,
      );
      await assert.rejects(
        tx((q) =>
          q.agencySubmission.update({
            where: { id: accepted.submission.id },
            data: { agencyId: second.id, version: { increment: 1 } },
          }),
        ),
        /HR-5306/,
      );
      await assert.rejects(
        tx((q) =>
          q.application.update({
            where: { id: app.id },
            data: { jobRequisitionId: unassigned.id },
          }),
        ),
        /HR-5306/,
      );
      await assert.rejects(
        tx((q) =>
          q.recruitmentAgency.update({
            where: { id: agency.id },
            data: { userId: Number(otherAgency.userId) + 1000 },
          }),
        ),
        /HR-5306/,
      );
    },
  );
  await t.test(
    "rejection is atomic with canonical stage history and cannot resurrect a withdrawn application",
    async () => {
      const address = email();
      await invite(address);
      const own = await link(address);
      await finish(own.token);
      const result = await decision(own, 1, "REJECTED");
      assert.equal(result.state, "REJECTED");
      const app = await applicationFor(own);
      assert.equal(app.stage, "rejected");
      assert.equal(
        await tx((q) =>
          q.applicationStageHistory.count({
            where: {
              tenantId: tenant,
              applicationId: app.id,
              toStage: "rejected",
              source: "agency-review",
            },
          }),
        ),
        1,
      );
      const withdrawn = email();
      await invite(withdrawn);
      const next = await link(withdrawn);
      await finish(next.token);
      await move(await applicationFor(next), "withdrawn");
      await assert.rejects(decision(next, 1), { status: 409 });
    },
  );
  await t.test(
    "revocation closes unsubmitted links and submissions disappear from the agency view",
    async () => {
      const address = email();
      await invite(address);
      const own = await link(address);
      const assignment = (
        await as(recruiterUser, () => service.listAgencyAssignments({ requisitionId: job.id }))
      ).items.find((row) => row.agencyId === agency.id);
      await as(recruiterUser, () =>
        service.setAgencyAssignment({
          agencyId: agency.id,
          requisitionId: job.id,
          active: false,
          expectedVersion: assignment.version,
        }),
      );
      assert.equal(
        await publicAs(() => drafts.loadApplicationDraft({ tenantId: tenant, token: own.token })),
        null,
      );
      assert.equal((await as(agencyUser, () => service.listAgencySubmissions())).total, 0);
      await assert.rejects(invite(email()), { status: 404 });
      await assert.rejects(
        as(recruiterUser, () =>
          service.setAgencyAssignment({
            agencyId: agency.id,
            requisitionId: job.id,
            active: true,
            expectedVersion: assignment.version,
          }),
        ),
        { status: 412 },
      );
      await as(recruiterUser, () =>
        service.setAgencyAssignment({
          agencyId: agency.id,
          requisitionId: job.id,
          active: true,
          expectedVersion: assignment.version + 1,
        }),
      );
    },
  );
  await t.test("expired invitations renew without changing agency ownership", async () => {
    const address = email();
    await invite(address);
    const own = await link(address);
    await tx(async (q) => {
      await q.agencySubmission.update({
        where: { id: own.submission.id },
        data: { expiresAt: new Date(0), version: { increment: 1 } },
      });
      await q.applicationDraft.update({
        where: { id: own.draft.id },
        data: { expiresAt: new Date(0), updated_at: new Date(0) },
      });
    });
    await invite(address);
    const renewed = await link(address);
    assert.notEqual(renewed.token, own.token);
    assert.equal(renewed.submission.id, own.submission.id);
    assert.equal(renewed.candidate.ownerAgencyId, agency.id);
    assert.equal(
      await publicAs(() => drafts.loadApplicationDraft({ tenantId: tenant, token: own.token })),
      null,
    );
    await finish(renewed.token);
    assert.equal((await applicationFor(renewed)).ownerAgencyId, agency.id);
  });
  await t.test(
    "concurrent revocation and intake serialize without orphan applications",
    async () => {
      const address = email();
      await invite(address);
      const own = await link(address);
      await prepare(own.token);
      const assignment = (
        await as(recruiterUser, () => service.listAgencyAssignments({ requisitionId: job.id }))
      ).items.find((row) => row.agencyId === agency.id);
      const results = await Promise.allSettled([
        as(recruiterUser, () =>
          service.setAgencyAssignment({
            agencyId: agency.id,
            requisitionId: job.id,
            active: false,
            expectedVersion: assignment.version,
          }),
        ),
        publicAs(() => drafts.submitApplicationDraft({ tenantId: tenant, token: own.token })),
      ]);
      assert.equal(results[0].status, "fulfilled");
      if (results[1].status === "rejected") assert.equal(results[1].reason.code, "HR-5801");
      const apps = await tx((q) =>
        q.application.findMany({
          where: { tenantId: tenant, agencySubmissionId: own.submission.id },
        }),
      );
      assert.equal(apps.length, results[1].status === "fulfilled" ? 1 : 0);
      if (apps.length) assert.equal(apps[0].ownerAgencyId, agency.id);
      assert.equal((await as(agencyUser, () => service.listAgencySubmissions())).total, 0);
      await as(recruiterUser, () =>
        service.setAgencyAssignment({
          agencyId: agency.id,
          requisitionId: job.id,
          active: true,
          expectedVersion: assignment.version + 1,
        }),
      );
    },
  );
  await t.test(
    "DNC and expired retention suppress contact without leaking a different response",
    async () => {
      const blocked = email(),
        stale = email();
      await tx(async (q) => {
        await q.candidateDncEntry.create({
          data: { tenantId: tenant, email: blocked, reasonCode: "CANDIDATE_REQUEST", reason: "Fictional opt-out" },
        });
        await q.candidate.create({
          data: {
            tenantId: tenant,
            email: stale,
            firstName: "Expired",
            ownerAgencyId: agency.id,
            source: "AGENCY",
            retentionUntil: new Date(0),
          },
        });
      });
      for (const address of [blocked, stale])
        assert.deepEqual((await invite(address)).result, { received: true });
      assert.equal(
        await tx((q) =>
          q.candidateCommunication.count({
            where: { tenantId: tenant, Candidate: { email: { in: [blocked, stale] } } },
          }),
        ),
        0,
      );
    },
  );
  await t.test(
    "concurrent review decisions commit once and never contradict application rejection",
    async () => {
      const address = email();
      await invite(address);
      const own = await link(address);
      await finish(own.token);
      const results = await Promise.allSettled([
        decision(own, 1, "ACCEPTED"),
        decision(own, 1, "REJECTED"),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const rejected = results.find((r) => r.status === "rejected");
      assert.ok([409, 412].includes(rejected.reason.status));
      const row = await tx((q) =>
        q.agencySubmission.findUniqueOrThrow({ where: { id: own.submission.id } }),
      );
      const app = await applicationFor(own);
      assert.equal(app.stage, row.state === "REJECTED" ? "rejected" : "applied");
    },
  );
  await t.test(
    "candidate erasure removes agency identifiers and receipts while preserving aggregate source",
    async () => {
      for (const model of ["agencySubmission", "agencyCommandReceipt"])
        assert.ok(CANDIDATE_EXPORT_SOURCES.some((row) => row.model === model));
      const app = await applicationFor(accepted);
      await tx((q) =>
        q.candidate.update({
          where: { id: accepted.candidate.id },
          data: { anonymizedAt: new Date(), firstName: "Erased", email: `anon-${accepted.candidate.id}@anonymized.invalid` },
        }),
      );
      for (const model of ["agencySubmission", "agencyCommandReceipt", "applicationDraft"])
        assert.equal(
          await tx((q) =>
            q[model].count({ where: { tenantId: tenant, candidateId: accepted.candidate.id } }),
          ),
          0,
        );
      const erased = await tx((q) => q.application.findUniqueOrThrow({ where: { id: app.id } }));
      assert.equal(erased.ownerAgencyId, null);
      assert.equal(erased.agencySubmissionId, null);
      assert.equal(erased.source, "AGENCY");
      assert.equal(
        (await tx((q) => q.candidate.findUniqueOrThrow({ where: { id: accepted.candidate.id } })))
          .ownerAgencyId,
        null,
      );
    },
  );
});
test.after(async () => {
  closeRecruitmentRateLimit();
  await db.$disconnect();
});
