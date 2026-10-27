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
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const scores =
  await import("../../src/services/applicationFitScore.service.js");
const tenant = randomUUID(),
  other = randomUUID();
let employee, job, application, candidate, globalSkill;
const context = (
  role = "RECRUITER",
  permissions = ["hr.recruitment.read", "hr.recruitment.update"],
) => ({
  actorVerified: true,
  user: { tenantId: tenant, userId: employee.userId, roles: [role] },
  permissions,
});
const as = (fn, role, permissions) =>
  mcpCtx.run(context(role, permissions), fn);
const tx = (fn) =>
  mcpCtx.run({ user: { tenantId: tenant } }, () =>
    tenantTransaction(db, fn, { tenantId: tenant }),
  );
test("fit scores are tenant scoped, immutable and hidden from interviewers", async (t) => {
  await mcpCtx.run({ system: true }, () =>
    tenantTransaction(
      db,
      async (q) => {
        globalSkill = await q.skill.create({
          data: { name: "Global-" + randomUUID(), tenantId: null },
        });
      },
      { system: true },
    ),
  );
  await tx(async (q) => {
    employee = await q.employee.create({
      data: {
        tenant_id: tenant,
        userId: randomInt(10000, 100000000),
        employee_code: "SCORE-" + randomUUID().toUpperCase(),
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
        jobContent: { skills: [globalSkill.name], minimumExperienceYears: 2 },
      },
    });
    candidate = await q.candidate.create({
      data: {
        tenantId: tenant,
        firstName: "Fictional",
        consentStatus: "GRANTED",
        email: randomUUID() + "@example.invalid",
        parsedResume: { skills: [globalSkill.name], yearsOfExperience: 2 },
      },
    });
    await q.candidateConsent.create({
      data: {
        tenantId: tenant,
        candidateId: candidate.id,
        purpose: "PROCESSING",
        status: "GRANTED",
        policyVersion: "test-policy",
      },
    });
    application = await q.application.create({
      data: {
        tenantId: tenant,
        candidateId: candidate.id,
        jobRequisitionId: job.id,
      },
    });
  });
  await t.test(
    "global taxonomy is readable but another tenant's skill is hidden",
    async () => {
      const foreign = await mcpCtx.run(
        { user: { tenantId: other } },
        async () =>
          await db.skill.create({
            data: { tenantId: other, name: "Private-" + randomUUID() },
          }),
      );
      assert.ok(
        await tx((q) => q.skill.findFirst({ where: { id: globalSkill.id } })),
      );
      assert.equal(
        await tx((q) => q.skill.findFirst({ where: { id: foreign.id } })),
        null,
      );
    },
  );
  let first;
  await t.test(
    "refresh persists exact evidence and repeats are idempotent",
    async () => {
      first = await as(() =>
        scores.applicationScoreRefresh({ applicationId: application.id }),
      );
      assert.equal(first.scorePct, 100);
      assert.equal(
        (
          await as(() =>
            scores.applicationScoreRefresh({ applicationId: application.id }),
          )
        ).id,
        first.id,
      );
      await assert.rejects(
        tx((q) =>
          q.applicationScore.update({
            where: { id: first.id },
            data: { scorePct: 1 },
          }),
        ),
      );
    },
  );
  await t.test(
    "changed and reverted evidence append history and ranking uses latest",
    async () => {
      await tx((q) =>
        q.candidate.update({
          where: { id: candidate.id },
          data: { parsedResume: { skills: [], yearsOfExperience: 2 } },
        }),
      );
      assert.equal(
        (
          await as(() =>
            scores.applicationScoreRefresh({ applicationId: application.id }),
          )
        ).scorePct,
        25,
      );
      await tx((q) =>
        q.candidate.update({
          where: { id: candidate.id },
          data: {
            parsedResume: { skills: [globalSkill.name], yearsOfExperience: 2 },
          },
        }),
      );
      const latest = await as(() =>
        scores.applicationScoreRefresh({ applicationId: application.id }),
      );
      assert.notEqual(latest.id, first.id);
      assert.equal(latest.scorePct, 100);
      assert.equal(
        await tx((q) =>
          q.applicationScore.count({
            where: { applicationId: application.id },
          }),
        ),
        3,
      );
      const ranked = await as(() =>
        scores.requisitionRankList({
          requisitionId: job.id,
          page: 1,
          pageSize: 25,
        }),
      );
      assert.equal(ranked.items[0].scoreId, latest.id);
      assert.equal(ranked.items[0].rank, 1);
      const proposed = await as(() =>
        scores.requisitionShortlistPropose({ requisitionId: job.id }),
      );
      assert.equal(proposed.total, 1);
      assert.equal(
        await tx((q) =>
          q.shortlistEntry.count({ where: { applicationId: application.id } }),
        ),
        0,
      );
      assert.equal(
        (
          await tx((q) =>
            q.application.findUnique({ where: { id: application.id } }),
          )
        ).stage,
        "applied",
      );
    },
  );
  await t.test(
    "interviewer and ungranted admin cannot read pre-interview rankings",
    async () => {
      await assert.rejects(
        as(
          () => scores.applicationScoreGet({ applicationId: application.id }),
          "INTERVIEWER",
        ),
        { status: 403 },
      );
      await assert.rejects(
        as(
          () => scores.applicationScoreGet({ applicationId: application.id }),
          "HR_ADMIN",
          [],
        ),
        { status: 403 },
      );
      assert.equal(
        (
          await as(
            () => scores.applicationScoreGet({ applicationId: application.id }),
            "HIRING_MANAGER",
          )
        ).score.scorePct,
        100,
      );
    },
  );
});
test("question snapshot preserves missing knockouts and the original threshold", async () => {
  const question = await tx((q) =>
    q.applicationQuestion.create({
      data: {
        tenantId: tenant,
        requisitionId: job.id,
        type: "BOOLEAN",
        prompt: "Job-related required qualification",
        required: true,
        knockout: true,
        minimumScore: 1,
        maxScore: 2,
        weights: { true: 1, false: 0 },
      },
    }),
  );
  await tx((q) =>
    q.application.update({
      where: { id: application.id },
      data: {
        questionSnapshot: [
          {
            questionId: question.id,
            questionVersion: 1,
            knockout: true,
            minimumScore: 1,
          },
        ],
      },
    }),
  );
  const missing = await as(() =>
    scores.applicationScoreRefresh({ applicationId: application.id }),
  );
  assert.equal(missing.scorePct, null);
  assert.ok(
    missing.explanation.warnings.includes("A knockout answer is missing."),
  );
  await tx(async (q) => {
    await q.applicationAnswer.create({
      data: {
        applicationId: application.id,
        questionId: question.id,
        value: true,
        score: 1,
      },
    });
    await q.applicationQuestion.update({
      where: { id: question.id },
      data: { minimumScore: 2 },
    });
  });
  const frozen = await as(() =>
    scores.applicationScoreRefresh({ applicationId: application.id }),
  );
  assert.equal(frozen.scorePct, 100);
  assert.equal(frozen.explanation.features.knockouts[0].minimumScore, 1);
});
test("shortlist confirmation enforces ownership and explicit permission", async () => {
  const { addToShortlist, removeFromShortlist } =
    await import("../../src/services/applicationScreening.service.js");
  await assert.rejects(
    as(
      () => addToShortlist({ applicationId: application.id, tenantId: tenant }),
      "INTERVIEWER",
    ),
    { status: 403 },
  );
  await assert.rejects(
    as(
      () => addToShortlist({ applicationId: application.id, tenantId: tenant }),
      "HR_ADMIN",
      [],
    ),
    { status: 403 },
  );
  const otherManager = await tx((q) =>
    q.employee.create({
      data: {
        tenant_id: tenant,
        userId: randomInt(10000, 100000000),
        employee_code: "SCORE-" + randomUUID().toUpperCase(),
        employeeCategory: "EMPLOYEE",
        first_name: "Fictional manager",
        status: "Active",
        employement_status: "Active",
      },
    }),
  );
  const foreignJob = await tx((q) =>
    q.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Another team",
        requestedById: otherManager.id,
      },
    }),
  );
  const foreignApp = await tx((q) =>
    q.application.create({
      data: {
        tenantId: tenant,
        candidateId: candidate.id,
        jobRequisitionId: foreignJob.id,
      },
    }),
  );
  await assert.rejects(
    as(
      () => addToShortlist({ applicationId: foreignApp.id, tenantId: tenant }),
      "HIRING_MANAGER",
    ),
    { status: 403 },
  );
  await assert.rejects(
    as(
      () => addToShortlist({ applicationId: application.id, tenantId: tenant }),
      "HIRING_MANAGER",
    ),
    { status: 403 },
  );
  const added = await as(
    () =>
      addToShortlist({
        applicationId: application.id,
        tenantId: tenant,
        note: "Verified relevant job criteria",
      }),
    "RECRUITER",
  );
  assert.equal(added.addedById, employee.id);
  await assert.rejects(
    as(
      () =>
        removeFromShortlist({
          applicationId: application.id,
          tenantId: tenant,
        }),
      "INTERVIEWER",
    ),
    { status: 403 },
  );
  assert.equal(
    (
      await as(() =>
        removeFromShortlist({
          applicationId: application.id,
          tenantId: tenant,
        }),
      )
    ).removed,
    true,
  );
});
test("scoring sweep refreshes changed evidence without automatic decisions", async () => {
  const { runApplicationScoring } =
    await import("../../src/services/applicationScoringWorker.service.js");
  await tx(async (q) => {
    await q.candidate.update({
      where: { id: candidate.id },
      data: { parsedResume: { skills: [], yearsOfExperience: 2 } },
    });
    await q.$executeRaw`UPDATE "Application" SET "fitScoreCheckedAt"=NULL WHERE id=${application.id}`;
  });
  const counts = await mcpCtx.run({ system: true }, () =>
    runApplicationScoring({ limit: 500, tenantId: tenant }),
  );
  assert.ok(counts.scored > 0);
  assert.equal(counts.failed, 0);
  const score = await as(() =>
    scores.applicationScoreGet({ applicationId: application.id }),
  );
  assert.equal(score.score.scorePct, 25);
  const app = await tx((q) =>
    q.application.findUnique({ where: { id: application.id } }),
  );
  assert.ok(app.fitScoreCheckedAt);
  assert.equal(app.stage, "applied");
  assert.equal(
    await tx((q) =>
      q.shortlistEntry.count({ where: { applicationId: application.id } }),
    ),
    0,
  );
});
test("advisory matching and score writes enforce ownership, role and current processing consent", async () => {
  const { matchCandidateToRequisitionAdvisory: match } =
    await import("../../src/services/candidateMatch.service.js");
  const args = {
    tenantId: tenant,
    candidateId: candidate.id,
    requisitionId: job.id,
  };
  assert.equal((await as(() => match(args), "HIRING_MANAGER")).advisory, true);
  await assert.rejects(
    as(() => match(args), "INTERVIEWER"),
    (e) => e.status === 403,
  );
  const otherJob = await tx((q) =>
    q.jobRequisition.findFirst({
      where: { tenantId: tenant, title: "Another team" },
    }),
  );
  await assert.rejects(
    as(() => match({ ...args, requisitionId: otherJob.id }), "HIRING_MANAGER"),
    (e) => e.status === 404,
  );
  await assert.rejects(
    as(
      () => scores.applicationScoreRefresh({ applicationId: application.id }),
      "HIRING_MANAGER",
    ),
    (e) => e.status === 403,
  );
  await assert.rejects(
    as(
      () => scores.requisitionShortlistPropose({ requisitionId: job.id }),
      "HIRING_MANAGER",
    ),
    (e) => e.status === 403,
  );
  const { recordConsent } =
    await import("../../src/services/candidatePrivacy.service.js");
  await tx((q) =>
    recordConsent(
      {
        tenantId: tenant,
        candidateId: candidate.id,
        purpose: "PROCESSING",
        status: "WITHDRAWN",
      },
      { db: q },
    ),
  );
  await assert.rejects(
    as(() => match(args)),
    (e) => e.status === 409,
  );
  await assert.rejects(
    as(() => scores.applicationScoreRefresh({ applicationId: application.id })),
    (e) => e.status === 409,
  );
  await assert.rejects(
    as(() => scores.applicationScoreGet({ applicationId: application.id })),
    (e) => e.status === 409,
  );
  assert.equal(
    (await as(() => scores.requisitionRankList({ requisitionId: job.id })))
      .total,
    0,
  );
  assert.equal(
    (
      await as(() =>
        scores.requisitionShortlistPropose({ requisitionId: job.id }),
      )
    ).total,
    0,
  );
  await tx((q) =>
    recordConsent(
      {
        tenantId: tenant,
        candidateId: candidate.id,
        purpose: "PROCESSING",
        status: "GRANTED",
        policyVersion: "test-policy-v2",
      },
      { db: q },
    ),
  );
});
test("erasure holds the candidate lock so scoring cannot recreate deleted evidence", async () => {
  let release, ready;
  const barrier = new Promise((r) => (release = r)),
    started = new Promise((r) => (ready = r));
  const erasing = tx(async (q) => {
    await q.candidate.update({
      where: { id: candidate.id },
      data: { anonymizedAt: new Date(), parsedResume: null },
    });
    await q.applicationScore.deleteMany({
      where: { tenantId: tenant, applicationId: application.id },
    });
    ready();
    await barrier;
  });
  await started;
  let outcome;
  const scoring = as(() =>
    scores.applicationScoreRefresh({ applicationId: application.id }),
  ).then(
    (value) => {
      outcome = { value };
    },
    (error) => {
      outcome = { error };
    },
  );
  try {
    let blocked = false;
    for (let n = 0; n < 100; n++) {
      const rows = await tx((q) =>
        q.$queryRawUnsafe(
          `SELECT pid FROM pg_stat_activity WHERE usename=current_user AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM "Candidate"%'`,
        ),
      );
      if (rows.length) {
        blocked = true;
        break;
      }
      if (outcome) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(
      blocked,
      true,
      "scoring must wait on candidate erasure before taking the application lock",
    );
  } finally {
    release();
    await erasing;
    await scoring;
  }
  assert.equal(outcome.error?.status, 404);
  assert.equal(
    await tx((q) =>
      q.applicationScore.count({
        where: { tenantId: tenant, applicationId: application.id },
      }),
    ),
    0,
  );
});
test.after(() => db.$disconnect());
