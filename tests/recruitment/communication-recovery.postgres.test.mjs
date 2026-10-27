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
const { enqueueHrDomainEvent } =
  await import("../../src/services/hrDomainEvent.service.js");
const {
  runCandidateCommunicationProjection,
  projectCandidateCommunicationEvent,
} = await import("../../src/services/candidateCommunicationEvents.service.js");
const recovery =
  await import("../../src/services/candidateCommunicationRecovery.service.js");
const tenant = randomUUID(),
  foreign = randomUUID();
let employee, candidate, application, bad;
const tx = (fn, t = tenant) =>
  mcpCtx.run({ user: { tenantId: t } }, () =>
    tenantTransaction(db, fn, { tenantId: t }),
  );
const as = (fn, role = "HR_ADMIN") =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: {
        tenantId: tenant,
        userId: employee.userId,
        employeeId: 9999999,
        roles: [role],
      },
      permissions: ["hr.recruitment.read", "hr.recruitment.update"],
    },
    fn,
  );
const work = (args) =>
  mcpCtx.run({ system: true }, () =>
    runCandidateCommunicationProjection({ tenantId: tenant, ...args }),
  );
const event = () =>
  tx((q) =>
    enqueueHrDomainEvent(q, {
      tenantId: tenant,
      eventName: "hr.recruitment.application_stage_changed.v1",
      aggregateType: "Application",
      aggregateId: application.id,
      payload: {
        applicationId: String(application.id),
        candidateId: String(candidate.id),
        jobRequisitionId: String(application.jobRequisitionId),
        fromStage: "applied",
        toStage: "screening",
        applicationVersion: 1,
        reason: null,
        status: "open",
        requestedById: String(employee.id),
      },
    }),
  );
const row = (id) => tx((q) => q.outboxEvent.findUnique({ where: { id } }));
test.before(async () => {
  await tx(async (q) => {
    employee = await q.employee.create({
      data: {
        tenant_id: tenant,
        userId: randomInt(10000, 1000000000),
        employee_code: "RECOVERY-" + randomUUID().toUpperCase(),
        employeeCategory: "EMPLOYEE",
        first_name: "Fictional",
        status: "Active",
        employement_status: "Active",
      },
    });
    candidate = await q.candidate.create({
      data: {
        tenantId: tenant,
        firstName: "Fictional",
        email: randomUUID() + "@example.invalid",
      },
    });
    const job = await q.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Recovery fixture",
        requestedById: employee.id,
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
});
test("malformed head event is quarantined and a one-row batch reaches the next valid event", async () => {
  bad = await tx((q) =>
    q.outboxEvent.create({
      data: {
        tenantId: tenant,
        eventName: "hr.recruitment.application_stage_changed.v1",
        aggregateType: "Application",
        aggregateId: String(application.id),
        payload: { private: "MALFORMED_PAYLOAD_SECRET" },
        createdAt: new Date(0),
      },
    }),
  );
  const good = await event();
  const first = await work({ limit: 1 });
  assert.equal(first.failed, 1);
  assert.equal(first.unavailable, 0);
  assert.equal(
    (await row(bad.id)).communicationLastError,
    "EVENT_CONTRACT_INVALID",
  );
  const second = await work({ limit: 1 });
  assert.equal(second.queued, 1);
  assert.ok((await row(good.id)).communicationProcessedAt);
  assert.equal((await row(bad.id)).communicationProcessedAt, null);
});
test("a database error rolls back partial messages but preserves retry state and does not stop later events", async () => {
  const delayed = await event(),
    good = await event(),
    now = new Date();
  const result = await work({
    now,
    project: async (q, r, opts) => {
      const count = await projectCandidateCommunicationEvent(q, r, opts);
      if (r.id === delayed.id) await q.$queryRawUnsafe("SELECT 1/0");
      return count;
    },
  });
  assert.equal(result.retried, 1);
  assert.equal(result.queued, 1);
  assert.equal(result.unavailable, 0);
  assert.ok((await row(good.id)).communicationProcessedAt);
  const failed = await row(delayed.id);
  assert.equal(failed.communicationAttempts, 1);
  assert.equal(failed.communicationProcessedAt, null);
  assert.ok(failed.communicationNextAttemptAt > now);
  const count = () =>
    tx((q) =>
      q.candidateCommunication.count({
        where: { sourceEventId: delayed.payload.id },
      }),
    );
  assert.equal(await count(), 0);
  assert.equal(
    (await work({ now: new Date(now.getTime() + 59000) })).queued,
    0,
  );
  assert.equal(
    (await work({ now: new Date(now.getTime() + 61000) })).queued,
    1,
  );
  assert.equal(await count(), 1);
  assert.equal((await row(delayed.id)).communicationLastError, null);
  assert.equal(
    (await work({ now: new Date(now.getTime() + 120000) })).queued,
    0,
  );
  assert.equal(await count(), 1);
});
test("five transient failures stop automatic processing; reviewed retry is audited and stale writes are denied", async () => {
  const target = await event();
  let now = new Date();
  for (let n = 1; n <= 5; n++) {
    const result = await work({
      now,
      project: async () => {
        throw new Error("SECRET_UPSTREAM_DIAGNOSTIC");
      },
    });
    assert.equal(n === 5 ? result.failed : result.retried, 1);
    const r = await row(target.id);
    assert.equal(r.communicationAttempts, n);
    now = r.communicationNextAttemptAt || now;
  }
  const ended = await row(target.id);
  assert.ok(ended.communicationFailedAt);
  assert.equal(ended.communicationLastError, "PROJECTION_ATTEMPTS_EXHAUSTED");
  const list = await as(() => recovery.communicationFailuresList());
  assert.ok(list.items.some((r) => r.id === target.id));
  assert.equal(JSON.stringify(list).includes("SECRET_"), false);
  assert.equal(list.items[0].payload, undefined);
  await assert.rejects(
    as(() =>
      recovery.communicationEventRetry({
        id: target.id,
        expectedAttempts: 4,
        reason: "Underlying service has recovered",
      }),
    ),
    (e) => e.status === 412,
  );
  const updated = await as(() =>
    recovery.communicationEventRetry({
      id: target.id,
      expectedAttempts: 5,
      reason: "Underlying service has recovered",
    }),
  );
  assert.equal(updated.communicationAttempts, 0);
  assert.equal(updated.communicationFailedAt, null);
  assert.equal((await work()).queued, 1);
  const logs = await tx((q) =>
    q.log.findMany({
      where: {
        tenantId: tenant,
        action_type: "CANDIDATE_COMMUNICATION_EVENT_RETRY",
      },
    }),
  );
  assert.ok(
    logs.some(
      (l) => l.actionById === employee.id && l.notes.includes(target.id),
    ),
  );
});
test("recovery tools require a verified HR administrator and cannot inspect or reset foreign events", async () => {
  for (const role of [
    "RECRUITER",
    "HIRING_MANAGER",
    "INTERVIEWER",
    "FINANCE",
  ]) {
    await assert.rejects(
      as(() => recovery.communicationFailuresList(), role),
      (e) => e.status === 403,
    );
    await assert.rejects(
      as(
        () =>
          recovery.communicationEventRetry({
            id: bad.id,
            expectedAttempts: 1,
            reason: "Review and retry failed event",
          }),
        role,
      ),
      (e) => e.status === 403,
    );
  }
  const other = await tx(
    (q) =>
      q.outboxEvent.create({
        data: {
          tenantId: foreign,
          eventName: "hr.recruitment.application_stage_changed.v1",
          aggregateType: "Application",
          aggregateId: "1",
          payload: {},
          communicationFailedAt: new Date(),
          communicationLastError: "EVENT_CONTRACT_INVALID",
        },
      }),
    foreign,
  );
  await assert.rejects(
    as(() =>
      recovery.communicationEventRetry({
        id: other.id,
        expectedAttempts: 0,
        reason: "Review and retry failed event",
      }),
    ),
    (e) => e.status === 404,
  );
  assert.equal(
    (await as(() => recovery.communicationFailuresList())).items.some(
      (r) => r.id === other.id,
    ),
    false,
  );
});
test.after(async () => db.$disconnect());
