import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
const url = new URL(process.env.RECRUITMENT_TEST_DATABASE_URL || "");
if (
  url.hostname !== "127.0.0.1" ||
  url.pathname !== "/hr_task_assessment_test" ||
  url.username !== "recruitment_test_user"
)
  throw Error("Use isolated recruitment database");
process.env.DATABASE_URL = url.href;
process.env.NODE_ENV = "test";
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const { talentPoolCampaign } =
  await import("../../src/services/talentPoolCampaign.service.js");
const { segmentTalentPool } =
  await import("../../src/services/talentPoolInvitation.service.js");
const tenant = randomUUID();
let employee, job;
const tx = (fn) =>
  mcpCtx.run({ user: { tenantId: tenant } }, () =>
    tenantTransaction(db, fn, {
      tenantId: tenant,
      txOptions: { timeout: 30000, maxWait: 10000 },
    }),
  );
const as = (fn, role = "RECRUITER", over = {}) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: {
        tenantId: tenant,
        userId: employee.userId,
        roles: [role],
        ...over,
      },
      permissions: ["hr.recruitment.read", "hr.recruitment.update"],
    },
    fn,
  );
const candidate = async (pool, { consent = true, experience = 3 } = {}) =>
  tx(async (q) => {
    const c = await q.candidate.create({
      data: {
        tenantId: tenant,
        firstName: "Synthetic",
        email: randomUUID() + "@example.invalid",
        location: "Lahore",
        parsedResume: { totalExperienceYears: experience },
      },
    });
    await q.talentPool.create({
      data: { tenantId: tenant, candidateId: c.id, poolName: pool },
    });
    await q.candidateSkill.create({
      data: { tenantId: tenant, candidateId: c.id, name: "Node.js" },
    });
    if (consent)
      await q.candidateConsent.create({
        data: {
          tenantId: tenant,
          candidateId: c.id,
          purpose: "TALENT_POOL",
          status: "GRANTED",
          policyVersion: "test",
          source: "SELF_SERVICE",
        },
      });
    return c;
  });
const preview = (pool) =>
  as(() =>
    talentPoolCampaign({
      tenantId: tenant,
      jobRequisitionId: job.id,
      filters: { poolNames: [pool], hasOpenInvitation: false },
    }),
  );
const approve = (p) =>
  as(() =>
    talentPoolCampaign({
      tenantId: tenant,
      mode: "APPROVE",
      previewId: p.previewId,
      confirmed: true,
    }),
  );
test.before(async () => {
  await tx(async (q) => {
    employee = await q.employee.create({
      data: {
        tenant_id: tenant,
        userId: randomInt(10000, 100000000),
        employee_code: "CAMPAIGN-" + randomUUID().toUpperCase(),
        employeeCategory: "EMPLOYEE",
        first_name: "Synthetic",
        status: "Active",
        employement_status: "Active",
      },
    });
    job = await q.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Synthetic posted role",
        requestedById: employee.id,
        status: "POSTED",
        location: "Lahore",
        jobContent: { skills: ["Node.js"] },
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
test("job suggestion is a review only and excludes missing consent", async () => {
  const c = await candidate("default");
  await candidate("default", { consent: false });
  const p = await as(() =>
    talentPoolCampaign({ tenantId: tenant, jobRequisitionId: job.id }),
  );
  assert.deepEqual(p.filters.skills, ["Node.js"]);
  assert.deepEqual(p.filters.locations, ["Lahore"]);
  assert.equal(p.excludedCount, 1);
  assert.ok(p.candidates.some((x) => x.candidateId === c.id));
  assert.equal(
    await tx((q) =>
      q.talentPoolInvitation.count({ where: { tenantId: tenant } }),
    ),
    0,
  );
  await assert.rejects(
    as(() =>
      talentPoolCampaign({
        tenantId: tenant,
        mode: "APPROVE",
        previewId: p.previewId,
      }),
    ),
    { status: 428 },
  );
});
test("concurrent explicit approvals create one invitation and outbox per recipient with replay evidence", async () => {
  const a = await candidate("batch"),
    b = await candidate("batch");
  const p = await preview("batch");
  const [one, two] = await Promise.all([approve(p), approve(p)]);
  assert.equal(one.actorId, employee.id);
  assert.deepEqual(one.invitationIds, two.invitationIds);
  assert.equal([one, two].filter((x) => x.replayed).length, 1);
  const rows = await tx((q) =>
    q.talentPoolInvitation.findMany({
      where: { tenantId: tenant, candidateId: { in: [a.id, b.id] } },
    }),
  );
  assert.equal(rows.length, 2);
  assert.ok(
    rows.every(
      (r) =>
        r.invitedById === employee.id &&
        Math.abs((r.expiresAt - r.invitedAt) / 86400000 - 30) < 0.01,
    ),
  );
  assert.equal(
    await tx((q) =>
      q.candidateCommunication.count({
        where: { tenantId: tenant, candidateId: { in: [a.id, b.id] } },
      }),
    ),
    2,
  );
});
test("a changed candidate or consent requires fresh review without partial invitations", async () => {
  const c = await candidate("stale"),
    other = await candidate("stale");
  const p = await preview("stale");
  await tx((q) =>
    q.candidateConsent.create({
      data: {
        tenantId: tenant,
        candidateId: c.id,
        purpose: "TALENT_POOL",
        status: "WITHDRAWN",
        policyVersion: "test",
        source: "SELF_SERVICE",
        occurredAt: new Date(Date.now() + 1000),
      },
    }),
  );
  await assert.rejects(approve(p), { status: 412 });
  assert.equal(
    await tx((q) =>
      q.talentPoolInvitation.count({
        where: { tenantId: tenant, candidateId: { in: [c.id, other.id] } },
      }),
    ),
    0,
  );
});
test("archived and expired-retention pool candidates never enter a segment", async () => {
  const a = await candidate("inactive"),
    b = await candidate("inactive");
  await tx(async (q) => {
    await q.candidate.update({
      where: { id: a.id },
      data: { status: "archived" },
    });
    await q.candidate.update({
      where: { id: b.id },
      data: { retentionUntil: new Date(Date.now() - 1000) },
    });
  });
  const p = await preview("inactive");
  assert.equal(p.canApprove, false);
  assert.equal(p.previewId, null);
});
test("manager, automation, foreign tenant and fabricated previews cannot approve", async () => {
  await candidate("denied");
  const p = await preview("denied");
  for (const [role, extra] of [
    ["HIRING_MANAGER", {}],
    ["RECRUITER", { isAutomation: true }],
    ["RECRUITER", { tenantId: randomUUID() }],
  ])
    await assert.rejects(
      as(
        () =>
          talentPoolCampaign({
            tenantId: tenant,
            mode: "APPROVE",
            previewId: p.previewId,
            confirmed: true,
          }),
        role,
        extra,
      ),
      (e) => [403, 404].includes(e.status),
    );
  await assert.rejects(approve({ previewId: randomUUID() }), { status: 404 });
});
test("a changed posted job invalidates its reviewed segment", async () => {
  await candidate("job-change");
  const p = await preview("job-change");
  await tx((q) =>
    q.jobRequisition.update({
      where: { id: job.id },
      data: { title: "Changed synthetic role", version: { increment: 1 } },
    }),
  );
  await assert.rejects(approve(p), { status: 412 });
});
test("unknown experience is excluded from zero-experience matches on real PostgreSQL", async () => {
  const unknown = await candidate("unknown", { experience: null });
  const zero = await candidate("unknown", { experience: 0 });
  const p = await as(() =>
    segmentTalentPool({
      tenantId: tenant,
      filters: { poolNames: ["unknown"], maxExperienceYears: 0 },
    }),
  );
  assert.deepEqual(
    p.matched.map((x) => x.candidateId),
    [zero.id],
  );
  assert.ok(!p.matched.some((x) => x.candidateId === unknown.id));
});
test("posted jobs generate one recruiter review notice under concurrent scheduler retries and no candidate mail", async () => {
  const { runTalentCampaignSuggestions } =
    await import("../../src/services/talentCampaignSuggestions.service.js");
  await tx((q) =>
    q.jobRequisition.update({
      where: { id: job.id },
      data: { recruiterId: employee.id },
    }),
  );
  const before = await tx((q) =>
    q.candidateCommunication.count({ where: { tenantId: tenant } }),
  );
  const run = () =>
    mcpCtx.run({ system: true }, () =>
      runTalentCampaignSuggestions({ tenantId: tenant }),
    );
  const results = await Promise.all([run(), run()]);
  assert.equal(
    results.reduce((n, r) => n + r.suggested, 0),
    1,
  );
  const events = await tx((q) =>
    q.outboxEvent.findMany({
      where: {
        tenantId: tenant,
        eventName: "hr.recruitment.talent_campaign_suggested.v1",
      },
    }),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.payload.requisitionId, String(job.id));
  assert.ok(events[0].payload.payload.matchedCount > 0);
  assert.deepEqual(Object.keys(events[0].payload.payload).sort(), [
    "matchedCount",
    "postingId",
    "recipientUserIds",
    "requisitionId",
  ]);
  assert.equal(
    await tx((q) =>
      q.candidateCommunication.count({ where: { tenantId: tenant } }),
    ),
    before,
  );
  assert.equal((await run()).suggested, 0);
  await assert.rejects(
    as(() => runTalentCampaignSuggestions({ tenantId: tenant })),
    { status: 403 },
  );
  process.env.HR_RECRUITMENT_WORKFLOW_ENFORCEMENT = "off";
  assert.equal((await run()).skipped, true);
  delete process.env.HR_RECRUITMENT_WORKFLOW_ENFORCEMENT;
  await tx((q) =>
    q.jobRequisition.update({
      where: { id: job.id },
      data: { closesAt: new Date(Date.now() - 1000) },
    }),
  );
  assert.equal((await run()).suggested, 0);
  await tx((q) =>
    q.jobRequisition.update({
      where: { id: job.id },
      data: { closesAt: null },
    }),
  );
});
test.after(async () => {
  await db.$disconnect();
});

test("DNC registration after preview blocks the entire reviewed batch", async () => {
  const c = await candidate("dnc-change"),
    other = await candidate("dnc-change");
  const p = await preview("dnc-change");
  await tx((q) =>
    q.candidateDncEntry.create({
      data: {
        tenantId: tenant,
        candidateId: c.id,
        email: c.email,
        status: "ACTIVE",
        reasonCode: "CANDIDATE_REQUEST",
        reason: "Synthetic test",
      },
    }),
  );
  await assert.rejects(approve(p), { status: 412 });
  assert.equal(
    await tx((q) =>
      q.candidateCommunication.count({
        where: { tenantId: tenant, candidateId: { in: [c.id, other.id] } },
      }),
    ),
    0,
  );
});
test("a segment larger than the approval bound requires narrowing without creating a preview receipt", async () => {
  await tx(async (q) => {
    const rows = Array.from({ length: 101 }, (_, i) => ({
      tenantId: tenant,
      firstName: "Bound " + i,
      email: randomUUID() + "@example.invalid",
    }));
    await q.candidate.createMany({ data: rows });
    const cs = await q.candidate.findMany({
      where: { tenantId: tenant, email: { in: rows.map((c) => c.email) } },
      select: { id: true },
    });
    await q.talentPool.createMany({
      data: cs.map((c) => ({
        tenantId: tenant,
        candidateId: c.id,
        poolName: "large",
      })),
    });
  });
  const p = await preview("large");
  assert.equal(p.matchedCount, 101);
  assert.equal(p.canApprove, false);
  assert.equal(p.previewId, null);
  assert.deepEqual(p.candidates, []);
});
