import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const url = new URL(process.env.RECRUITMENT_TEST_DATABASE_URL || "");
if (
  url.hostname !== "127.0.0.1" ||
  url.pathname !== "/hr_task_assessment_test" ||
  url.username !== "recruitment_test_user"
)
  throw new Error("Use isolated recruitment test database");
process.env.DATABASE_URL = url.href;
process.env.NODE_ENV = "test";
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 27).toString("base64");
process.env.HR_PORTAL_BASE_URL = "https://careers.example.invalid";
process.env.HR_PORTAL_PRIVACY_POLICY_VERSION = "source-test-1";
process.env.HR_PORTAL_PRIVACY_POLICY_URL =
  "https://careers.example.invalid/privacy";
process.env.HR_RECRUITMENT_PUBLIC_PORTAL = "true";
process.env.NOTIFICATION_HUB_URL = "http://127.0.0.1:1";
process.env.NOTIFICATION_HUB_TIMEOUT = "100";
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const service =
  await import("../../src/services/internalRecruitment.service.js");
const publication =
  await import("../../src/services/requisitionPublication.service.js");
const drafts = await import("../../src/services/applicationDraft.service.js");
const { getPublicJob } = await import("../../src/lib/publicPortal.js");
const { decryptString } = await import("../../src/lib/crypto.js");
const { CANDIDATE_EXPORT_SOURCES } =
  await import("../../src/services/candidateDataExport.catalog.js");
const tenant = randomUUID(),
  foreign = randomUUID();
const permissions = [
  "hr.self.read",
  "hr.recruitment.read",
  "hr.recruitment.update",
  "hr.recruitment.create",
];
const context = (who, tenantId = tenant) => ({
  actorVerified: true,
  user: { tenantId, userId: String(who.userId), roles: ["RECRUITER"] },
  permissions,
});
const as = (who, fn, tenantId = tenant) =>
  mcpCtx.run(context(who, tenantId), fn);
const publicAs = (fn) =>
  mcpCtx.run({ user: { tenantId: tenant }, publicPortal: true }, fn);
const tx = (fn, tenantId = tenant) =>
  mcpCtx.run({ user: { tenantId } }, () =>
    tenantTransaction(db, fn, { tenantId, txOptions: { timeout: 30000 } }),
  );
let employee,
  second,
  recruiter,
  foreignEmployee,
  job,
  closed,
  publicOnly,
  foreignJob,
  referralCandidate,
  referral;
async function contactLink(email) {
  return tx(async (q) => {
    const candidate = await q.candidate.findFirstOrThrow({
      where: { tenantId: tenant, email },
    });
    const draft = await q.applicationDraft.findFirstOrThrow({
      where: {
        tenantId: tenant,
        candidateId: candidate.id,
        requisitionId: job.id,
      },
    });
    const message = await q.candidateCommunication.findFirstOrThrow({
      where: {
        tenantId: tenant,
        candidateId: candidate.id,
        context: { path: ["tokenHash"], equals: draft.tokenHash },
      },
    });
    const payload = JSON.parse(decryptString(message.encryptedPayload));
    const token = new URL(payload.data.draftUrl).hash.slice("#token=".length);
    assert.equal(drafts.hashDraftToken(token), draft.tokenHash);
    assert.equal(payload.email, email);
    return { candidate, draft, token };
  });
}
async function finish(token) {
  const view = await publicAs(() =>
    drafts.loadApplicationDraft({ tenantId: tenant, token }),
  );
  assert.ok(view);
  await publicAs(() =>
    drafts.updateApplicationDraft({
      tenantId: tenant,
      token,
      expectedUpdatedAt: view.updatedAt,
      body: {
        firstName: view.payload.firstName || "Fictional",
        consent: true,
        policyVersion: "source-test-1",
        answers: {},
      },
    }),
  );
  return publicAs(() =>
    drafts.submitApplicationDraft({ tenantId: tenant, token }),
  );
}
const refer = (who, email, extra = {}) =>
  as(who, () =>
    service.referContact({
      requisitionId: job.id,
      requestKey: randomUUID(),
      email,
      firstName: "Consenting fictional contact",
      permissionToContact: true,
      ...extra,
    }),
  );
test("internal sourcing preserves company, employee and candidate ownership", async (t) => {
  await tx(async (q) => {
    async function person(name, userId) {
      return q.employee.create({
        data: {
          tenant_id: tenant,
          employee_code: "SOURCE-" + randomUUID().slice(0, 20).toUpperCase(),
          userId,
          first_name: name,
          work_email: randomUUID() + "@example.invalid",
          status: "Active",
          employement_status: "Active",
          employeeCategory: "EMPLOYEE",
        },
      });
    }
    employee = await person("Internal", 920001);
    second = await person("Referrer", 920002);
    recruiter = await person("Independent", 920003);
    job = await q.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Published internal role",
        requestedById: recruiter.id,
        status: "POSTED",
        jobContent: {
          summary: "Published summary",
          privateBudget: "Do not expose",
        },
      },
    });
    await q.jobPosting.createMany({
      data: ["INTERNAL", "REFERRAL"].map((channel) => ({
        tenantId: tenant,
        requisitionId: job.id,
        channel,
        isActive: true,
      })),
    });
    closed = await q.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Closed internal role",
        requestedById: recruiter.id,
        status: "POSTED",
        closesAt: new Date(0),
      },
    });
    await q.jobPosting.create({
      data: {
        tenantId: tenant,
        requisitionId: closed.id,
        channel: "INTERNAL",
        isActive: true,
      },
    });
    publicOnly = await q.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Public only",
        requestedById: recruiter.id,
        status: "POSTED",
      },
    });
    await q.jobPosting.create({
      data: {
        tenantId: tenant,
        requisitionId: publicOnly.id,
        channel: "CAREER_SITE",
        isActive: true,
      },
    });
  });
  await tx(async (q) => {
    foreignEmployee = await q.employee.create({
      data: {
        tenant_id: foreign,
        employeeCategory: "EMPLOYEE",
        employee_code: "SOURCE-" + randomUUID().slice(0, 20).toUpperCase(),
        userId: 920004,
        first_name: "Foreign",
        work_email: randomUUID() + "@example.invalid",
        status: "Active",
        employement_status: "Active",
      },
    });
    foreignJob = await q.jobRequisition.create({
      data: {
        tenantId: foreign,
        title: "Foreign internal role",
        requestedById: foreignEmployee.id,
        status: "POSTED",
      },
    });
    await q.jobPosting.create({
      data: {
        tenantId: foreign,
        requisitionId: foreignJob.id,
        channel: "INTERNAL",
        isActive: true,
      },
    });
  }, foreign);
  await t.test(
    "employee board shows only open published company jobs and anonymous visitors cannot see them",
    async () => {
      const view = await as(employee, () => service.listInternalJobs({}));
      assert.deepEqual(
        view.items.map((x) => x.id),
        [job.id],
      );
      assert.equal(view.total, 1);
      assert.equal(JSON.stringify(view).includes("privateBudget"), false);
      assert.equal(
        await publicAs(() =>
          getPublicJob({ tenantId: tenant, prisma: db, id: job.id }),
        ),
        null,
      );
      for (const id of [closed.id, publicOnly.id, foreignJob.id])
        await assert.rejects(
          as(employee, () =>
            service.getInternalJob({ requisitionId: id, channel: "INTERNAL" }),
          ),
          { status: 404 },
        );
      await assert.rejects(
        mcpCtx.run({ ...context(employee), actorVerified: false }, () =>
          service.listInternalJobs({}),
        ),
        { status: 403 },
      );
      await assert.rejects(
        mcpCtx.run({ ...context(employee), permissions: [] }, () =>
          service.listInternalJobs({}),
        ),
        { status: 403 },
      );
    },
  );
  await t.test(
    "caller cannot supply another employee or override source and replay sends only one encrypted link",
    async () => {
      const args = { requisitionId: job.id, requestKey: randomUUID() };
      await assert.rejects(
        as(employee, () =>
          service.applyInternally({ ...args, sourceEmployeeId: second.id }),
        ),
      );
      const results = await Promise.all([
        as(employee, () => service.applyInternally(args)),
        as(employee, () => service.applyInternally(args)),
      ]);
      assert.deepEqual(results, [{ received: true }, { received: true }]);
      const own = await contactLink(employee.work_email);
      assert.equal(own.candidate.consentStatus, "UNKNOWN");
      assert.equal(own.draft.source, "INTERNAL");
      assert.equal(own.draft.sourceEmployeeId, employee.id);
      assert.equal(
        await tx((q) =>
          q.application.count({
            where: { tenantId: tenant, candidateId: own.candidate.id },
          }),
        ),
        0,
      );
      assert.equal(
        await tx((q) =>
          q.candidateCommunication.count({
            where: { tenantId: tenant, candidateId: own.candidate.id },
          }),
        ),
        1,
      );
      await assert.rejects(
        as(second, () => service.applyInternally(args)),
        { status: 409 },
      );
      assert.equal(
        await mcpCtx.run(
          { user: { tenantId: foreign }, publicPortal: true },
          () =>
            drafts.loadApplicationDraft({
              tenantId: foreign,
              token: own.token,
            }),
        ),
        null,
      );
      await tx((q) =>
        q.employee.update({
          where: { id: employee.id },
          data: { status: "Inactive" },
        }),
      );
      assert.equal(
        await publicAs(() =>
          drafts.loadApplicationDraft({ tenantId: tenant, token: own.token }),
        ),
        null,
      );
      await tx((q) =>
        q.employee.update({
          where: { id: employee.id },
          data: { status: "Active" },
        }),
      );
      await finish(own.token);
      const app = await tx((q) =>
        q.application.findFirstOrThrow({
          where: {
            candidateId: own.candidate.id,
            jobRequisitionId: job.id,
            tenantId: tenant,
          },
        }),
      );
      assert.equal(app.source, "INTERNAL");
      assert.equal(app.sourceEmployeeId, employee.id);
      assert.equal(app.internalReferralId, null);
      const consents = await tx((q) =>
        q.candidateConsent.findMany({
          where: { candidateId: own.candidate.id, tenantId: tenant },
        }),
      );
      assert.deepEqual(
        consents.map((x) => [x.purpose, x.status]),
        [["PROCESSING", "GRANTED"]],
      );
    },
  );
  await t.test(
    "referral records the original referrer but cannot assert processing consent or expose candidate history",
    async () => {
      const email = randomUUID() + "@example.invalid",
        key = randomUUID();
      await Promise.all([
        refer(employee, email, { requestKey: key }),
        refer(employee, email, { requestKey: key }),
      ]);
      const own = await contactLink(email);
      referralCandidate = own.candidate;
      referral = await tx((q) =>
        q.internalReferral.findFirstOrThrow({
          where: { tenantId: tenant, candidateId: own.candidate.id },
        }),
      );
      assert.equal(own.candidate.consentStatus, "UNKNOWN");
      assert.equal(own.draft.source, "REFERRAL");
      assert.equal(own.draft.internalReferralId, referral.id);
      await assert.rejects(
        as(employee, () =>
          service.reviewReferralBonus({
            referralId: referral.id,
            expectedVersion: 0,
            bonusEligibility: "ELIGIBLE",
            reason: "Company policy",
          }),
        ),
        { status: 403 },
      );
      await assert.rejects(
        as(recruiter, () =>
          service.reviewReferralBonus({
            referralId: referral.id,
            expectedVersion: 0,
            bonusEligibility: "ELIGIBLE",
            reason: "Company policy",
          }),
        ),
        { status: 409 },
      );
      await refer(second, email);
      assert.equal(
        (await as(second, () => service.listInternalReferrals({}))).total,
        0,
      );
      assert.equal(
        await tx((q) =>
          q.candidateCommunication.count({
            where: { tenantId: tenant, candidateId: own.candidate.id },
          }),
        ),
        1,
      );
      const mine = await as(employee, () => service.listInternalReferrals({}));
      assert.equal(mine.total, 1);
      assert.equal(mine.items[0].suppliedName, "Consenting fictional contact");
      for (const field of [
        "candidateId",
        "email",
        "stage",
        "score",
        "referrerEmployeeId",
        "assessment",
      ])
        assert.equal(field in mine.items[0], false);
      await assert.rejects(
        as(employee, () =>
          service.referContact({
            requisitionId: job.id,
            requestKey: randomUUID(),
            email,
            firstName: "Contact",
            permissionToContact: false,
          }),
        ),
      );
      await assert.rejects(refer(employee, employee.work_email), {
        status: 422,
      });
      const view = await publicAs(() =>
        drafts.loadApplicationDraft({ tenantId: tenant, token: own.token }),
      );
      await publicAs(() =>
        drafts.updateApplicationDraft({
          tenantId: tenant,
          token: own.token,
          expectedUpdatedAt: view.updatedAt,
          body: { firstName: "Candidate", consent: false },
        }),
      );
      await assert.rejects(
        publicAs(() =>
          drafts.submitApplicationDraft({ tenantId: tenant, token: own.token }),
        ),
        { status: 400 },
      );
      await finish(own.token);
      const app = await tx((q) =>
        q.application.findFirstOrThrow({
          where: {
            candidateId: own.candidate.id,
            jobRequisitionId: job.id,
            tenantId: tenant,
          },
        }),
      );
      assert.equal(app.source, "REFERRAL");
      assert.equal(app.internalReferralId, referral.id);
      referral = await tx((q) =>
        q.internalReferral.findUniqueOrThrow({ where: { id: referral.id } }),
      );
      assert.equal(referral.state, "SUBMITTED");
      assert.equal(referral.version, 1);
    },
  );
  await t.test(
    "independent bonus review checks version, scope and immutable audit event",
    async () => {
      const args = {
        referralId: referral.id,
        expectedVersion: 1,
        bonusEligibility: "ELIGIBLE",
        reason: "Meets the published referral policy",
      };
      await assert.rejects(
        mcpCtx.run(
          {
            ...context(recruiter),
            user: { ...context(recruiter).user, roles: ["HIRING_MANAGER"] },
          },
          () => service.reviewReferralBonus(args),
        ),
        { status: 403 },
      );
      await assert.rejects(
        as(foreignEmployee, () => service.reviewReferralBonus(args), foreign),
        { status: 404 },
      );
      const result = await as(recruiter, () =>
        service.reviewReferralBonus(args),
      );
      assert.equal(result.bonusEligibility, "ELIGIBLE");
      assert.equal(result.version, 2);
      await assert.rejects(
        as(recruiter, () => service.reviewReferralBonus(args)),
        { status: 412 },
      );
      const mine = await as(employee, () => service.listInternalReferrals({}));
      assert.equal(mine.items[0].bonusReason, args.reason);
      const events = await tx((q) =>
        q.outboxEvent.findMany({
          where: {
            tenantId: tenant,
            eventName: "hr.recruitment.referral_changed.v1",
          },
        }),
      );
      assert.ok(events.length >= 3);
      assert.equal(JSON.stringify(events).includes(args.reason), false);
    },
  );
  await t.test(
    "database rejects forged or mutable source ownership and cross-company referrers",
    async () => {
      const candidate = await tx((q) =>
        q.candidate.create({
          data: {
            tenantId: tenant,
            firstName: "Other mailbox",
            email: randomUUID() + "@example.invalid",
          },
        }),
      );
      await assert.rejects(
        tx((q) =>
          q.application.create({
            data: {
              tenantId: tenant,
              candidateId: candidate.id,
              jobRequisitionId: job.id,
              source: "INTERNAL",
              sourceEmployeeId: employee.id,
            },
          }),
        ),
        /mailbox ownership/,
      );
      await assert.rejects(
        tx((q) =>
          q.application.create({
            data: {
              tenantId: tenant,
              candidateId: candidate.id,
              jobRequisitionId: job.id,
              source: "REFERRAL",
              internalReferralId: referral.id,
            },
          }),
        ),
        /referral identity/,
      );
      await assert.rejects(
        tx((q) =>
          q.internalReferral.create({
            data: {
              tenantId: tenant,
              candidateId: candidate.id,
              requisitionId: job.id,
              referrerEmployeeId: foreignEmployee.id,
              requestKey: randomUUID(),
              fingerprint: "a".repeat(64),
              suppliedName: "Forged",
              expiresAt: new Date(Date.now() + 86400000),
            },
          }),
        ),
      );
      const app = await tx((q) =>
        q.application.findFirstOrThrow({
          where: { tenantId: tenant, internalReferralId: referral.id },
        }),
      );
      await assert.rejects(
        tx((q) =>
          q.application.update({
            where: { id: app.id },
            data: { source: "PORTAL", internalReferralId: null },
          }),
        ),
        /immutable/,
      );
      await assert.rejects(
        tx((q) =>
          q.application.update({
            where: { id: app.id },
            data: { candidateId: candidate.id },
          }),
        ),
        /immutable/,
      );
    },
  );
  await t.test(
    "lost or expired invitation can be renewed only by its original referrer and cooldown avoids repeat contact",
    async () => {
      const email = randomUUID() + "@example.invalid";
      await refer(second, email);
      const initial = await contactLink(email);
      await refer(second, email);
      assert.equal((await contactLink(email)).token, initial.token);
      await tx(async (q) => {
        await q.applicationDraft.update({
          where: { id: initial.draft.id },
          data: {
            expiresAt: new Date(0),
            updated_at: new Date(0),
            payload: { firstName: "Candidate saved", answers: {} },
          },
        });
        await q.internalReferral.updateMany({
          where: { tenantId: tenant, candidateId: initial.candidate.id },
          data: { expiresAt: new Date(0), updatedAt: new Date(0) },
        });
      });
      assert.equal(
        await publicAs(() =>
          drafts.loadApplicationDraft({
            tenantId: tenant,
            token: initial.token,
          }),
        ),
        null,
      );
      await refer(employee, email);
      assert.equal((await contactLink(email)).token, initial.token);
      await refer(second, email);
      const renewed = await contactLink(email);
      assert.notEqual(renewed.token, initial.token);
      assert.equal(renewed.draft.payload.firstName, "Candidate saved");
      assert.equal(
        await publicAs(() =>
          drafts.loadApplicationDraft({
            tenantId: tenant,
            token: initial.token,
          }),
        ),
        null,
      );
      const r = await tx((q) =>
        q.internalReferral.findUniqueOrThrow({
          where: { id: initial.draft.internalReferralId },
        }),
      );
      assert.equal(r.referrerEmployeeId, second.id);
    },
  );
  await t.test(
    "DNC and expired retention return neutral receipts without contact or new drafts",
    async () => {
      const dnc = randomUUID() + "@example.invalid",
        expired = randomUUID() + "@example.invalid";
      await tx(async (q) => {
        await q.candidateDncEntry.create({
          data: {
            tenantId: tenant,
            email: dnc,
            reasonCode: "USER_REQUEST",
            reason: "Fictional contact opt-out",
          },
        });
        await q.candidate.create({
          data: {
            tenantId: tenant,
            firstName: "Expired",
            email: expired,
            status: "active",
            retentionUntil: new Date(0),
          },
        });
      });
      assert.deepEqual(await refer(employee, dnc), { received: true });
      assert.deepEqual(await refer(employee, expired), { received: true });
      assert.equal(
        await tx((q) =>
          q.candidateCommunication.count({
            where: {
              tenantId: tenant,
              Candidate: { email: { in: [dnc, expired] } },
            },
          }),
        ),
        0,
      );
    },
  );
  await t.test(
    "renewal and candidate submission serialize without duplicate applications or attribution changes",
    async () => {
      const email = randomUUID() + "@example.invalid";
      await refer(second, email);
      const own = await contactLink(email);
      const view = await publicAs(() =>
        drafts.loadApplicationDraft({ tenantId: tenant, token: own.token }),
      );
      await publicAs(() =>
        drafts.updateApplicationDraft({
          tenantId: tenant,
          token: own.token,
          expectedUpdatedAt: view.updatedAt,
          body: {
            firstName: "Candidate",
            consent: true,
            policyVersion: "source-test-1",
          },
        }),
      );
      await tx((q) =>
        q.applicationDraft.update({
          where: { id: own.draft.id },
          data: { updated_at: new Date(0) },
        }),
      );
      const results = await Promise.allSettled([
        publicAs(() =>
          drafts.submitApplicationDraft({ tenantId: tenant, token: own.token }),
        ),
        refer(second, email),
      ]);
      for (const r of results)
        if (r.status === "rejected") assert.equal(r.reason.code, "HR-5801");
      assert.ok(results.some((r) => r.status === "fulfilled"));
      const count = await tx((q) =>
        q.application.count({
          where: {
            tenantId: tenant,
            candidateId: own.candidate.id,
            jobRequisitionId: job.id,
          },
        }),
      );
      assert.ok(count <= 1);
      if (!count) await finish((await contactLink(email)).token);
      const app = await tx((q) =>
        q.application.findFirstOrThrow({
          where: { tenantId: tenant, candidateId: own.candidate.id },
        }),
      );
      assert.equal(app.internalReferralId, own.draft.internalReferralId);
    },
  );
  await t.test(
    "publication endpoints enforce native actor identity and managed ownership",
    async () => {
      const managed = {
        ...context(employee),
        user: { ...context(employee).user, roles: ["HIRING_MANAGER"] },
      };
      const agency = {
        ...context(employee),
        user: { ...context(employee).user, roles: ["AGENCY"] },
      };
      await assert.rejects(
        mcpCtx.run(managed, () =>
          publication.listRequisitionPostings(job.id, tenant),
        ),
        { status: 404 },
      );
      await assert.rejects(
        mcpCtx.run(agency, () =>
          publication.listRequisitionPostings(job.id, tenant),
        ),
        { status: 403 },
      );
      await assert.rejects(
        mcpCtx.run({ ...context(recruiter), actorVerified: false }, () =>
          publication.publishRequisition({
            id: job.id,
            tenantId: tenant,
            postingChannels: ["INTERNAL"],
          }),
        ),
        { status: 403 },
      );
      const result = await as(recruiter, () =>
        publication.publishRequisition({
          id: job.id,
          tenantId: tenant,
          actorId: employee.id,
          postingChannels: [
            {
              channel: "OTHER",
              externalUrl: "https://jobs.example.invalid/role",
            },
          ],
        }),
      );
      assert.equal(result.postings[0].postedById, recruiter.id);
      await assert.rejects(
        mcpCtx.run(managed, () =>
          publication.unpublishPosting({
            postingId: result.postings[0].id,
            reason: "EXPIRED",
            tenantId: tenant,
          }),
        ),
        { status: 404 },
      );
      const closedPosting = await as(recruiter, () =>
        publication.unpublishPosting({
          postingId: result.postings[0].id,
          reason: "OTHER",
          note: "Fictional board was retired",
          actorId: employee.id,
          tenantId: tenant,
        }),
      );
      assert.equal(closedPosting.closedById, recruiter.id);
      assert.equal(closedPosting.isActive, false);
      const saved = await as(recruiter, () =>
        publication.listRequisitionPostings(job.id, tenant),
      );
      assert.ok(saved.activeChannels.includes("INTERNAL"));
    },
  );
  await t.test(
    "candidate erasure deletes referral identity and command fingerprints while preserving aggregate source",
    async () => {
      for (const model of ["internalReferral", "recruitmentSourcingReceipt"])
        assert.ok(CANDIDATE_EXPORT_SOURCES.some((s) => s.model === model));
      const app = await tx((q) =>
        q.application.findFirstOrThrow({
          where: {
            tenantId: tenant,
            candidateId: referralCandidate.id,
            jobRequisitionId: job.id,
          },
        }),
      );
      await tx((q) =>
        q.candidate.update({
          where: { id: referralCandidate.id },
          data: { anonymizedAt: new Date(), firstName: "Erased", email: randomUUID() + "@erased.invalid" },
        }),
      );
      assert.equal(
        await tx((q) =>
          q.internalReferral.count({
            where: { tenantId: tenant, candidateId: referralCandidate.id },
          }),
        ),
        0,
      );
      assert.equal(
        await tx((q) =>
          q.recruitmentSourcingReceipt.count({
            where: { tenantId: tenant, candidateId: referralCandidate.id },
          }),
        ),
        0,
      );
      const erased = await tx((q) =>
        q.application.findUniqueOrThrow({ where: { id: app.id } }),
      );
      assert.equal(erased.internalReferralId, null);
      assert.equal(erased.source, "REFERRAL");
      assert.equal(
        await tx((q) =>
          q.applicationDraft.count({
            where: { tenantId: tenant, candidateId: referralCandidate.id },
          }),
        ),
        0,
      );
    },
  );
});
test.after(() => db.$disconnect());
