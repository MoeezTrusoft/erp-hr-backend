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
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 29).toString("base64");
process.env.HR_PORTAL_BASE_URL = "https://careers.example.invalid";
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const settings = await import("../../src/services/recruitmentSettings.service.js");
const { issueStatusLink } = await import("../../src/services/candidateVerification.service.js");
const { enqueueCandidateCommunication } =
  await import("../../src/services/candidateCommunicationQueue.service.js");
const { runCandidateCommunicationDelivery } =
  await import("../../src/services/candidateCommunicationDelivery.service.js");
const { runCandidateCommunicationProjection } =
  await import("../../src/services/candidateCommunicationEvents.service.js");
const { enqueueHrDomainEvent } = await import("../../src/services/hrDomainEvent.service.js");
const tenant = randomUUID();
let employee, candidate, job, application, token;
const tx = (fn) =>
  mcpCtx.run({ user: { tenantId: tenant } }, () => tenantTransaction(db, fn, { tenantId: tenant }));
const as = (fn, roles = ["HR_ADMIN"]) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: { tenantId: tenant, userId: employee.userId, roles },
      permissions: ["hr.recruitment.read", "hr.recruitment.update"],
    },
    fn,
  );
const work = (args = {}) =>
  mcpCtx.run({ system: true }, () =>
    runCandidateCommunicationDelivery({ tenantId: tenant, ...args }),
  );
test.before(async () => {
  await tx(async (q) => {
    employee = await q.employee.create({
      data: {
        tenant_id: tenant,
        userId: randomInt(10000, 100000000),
        employee_code: "COMMS-" + randomUUID().toUpperCase(),
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
        consentStatus: "GRANTED",
      },
    });
    await q.candidateConsent.create({
      data: {
        tenantId: tenant,
        candidateId: candidate.id,
        purpose: "PROCESSING",
        status: "GRANTED",
        policyVersion: "test-policy",
        source: "SELF_SERVICE",
      },
    });
    job = await q.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Fictional editor",
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
test("tenant settings are permissioned, versioned and immutable", async () => {
  const current = await as(() => settings.recruitmentSettingsGet());
  assert.equal(current.version, 0);
  const policy = {
    ...current.policy,
    rejectionDelayHours: 2,
    shortlistThreshold: 85,
  };
  await assert.rejects(
    as(
      () =>
        settings.recruitmentSettingsSet({
          policy,
          expectedVersion: 0,
          reason: "Approved candidate experience policy",
        }),
      ["RECRUITER"],
    ),
    { status: 403 },
  );
  const updated = await as(() =>
    settings.recruitmentSettingsSet({
      policy,
      expectedVersion: 0,
      reason: "Approved candidate experience policy",
    }),
  );
  assert.equal(updated.version, 1);
  await assert.rejects(
    as(() =>
      settings.recruitmentSettingsSet({
        policy,
        expectedVersion: 0,
        reason: "Approved candidate experience policy",
      }),
    ),
    { status: 412 },
  );
  await assert.rejects(
    tx((q) =>
      q.recruitmentPolicyVersion.updateMany({
        where: { tenantId: tenant },
        data: { reason: "tamper" },
      }),
    ),
  );
});
test("mailbox intent commits atomically and raw tokens are encrypted", async () => {
  token = (await tx((q) => issueStatusLink(q, { tenantId: tenant, candidate }))).token;
  const queued = await tx((q) =>
    q.candidateCommunication.findFirst({
      where: { tenantId: tenant, templateKey: "portal_status_link" },
    }),
  );
  assert.ok(queued.encryptedPayload.startsWith("c4.v1:"));
  assert.equal(queued.encryptedPayload.includes(token), false);
  const before = await tx((q) => q.candidateCommunication.count());
  await assert.rejects(
    tx(async (q) => {
      await issueStatusLink(q, { tenantId: tenant, candidate });
      throw new Error("rollback");
    }),
    /rollback/,
  );
  assert.equal(await tx((q) => q.candidateCommunication.count()), before);
  const tokenRow = await tx((q) =>
    q.candidateEmailVerification.findFirst({
      where: { candidateId: candidate.id, consumedAt: null },
    }),
  );
  assert.ok(tokenRow);
});
test("provider failure remains durable and retries the same dedupe key", async () => {
  const calls = [],
    start = new Date();
  const first = await work({
    now: start,
    send: async (message) => {
      calls.push(message);
      return { sent: false };
    },
  });
  assert.equal(first.retried, 1);
  const pending = await tx((q) =>
    q.candidateCommunication.findFirst({
      where: { templateKey: "portal_status_link" },
    }),
  );
  assert.equal(pending.status, "PENDING");
  assert.equal(pending.attempts, 1);
  assert.ok(pending.encryptedPayload);
  const second = await work({
    now: new Date(start.getTime() + 130000),
    send: async (message) => {
      calls.push(message);
      return { sent: true, notificationId: randomUUID() };
    },
  });
  assert.equal(second.sent, 1);
  assert.equal(calls[0].dedupeKey, calls[1].dedupeKey);
  assert.ok(calls[1].data.statusUrl.endsWith(token));
  const sent = await tx((q) => q.candidateCommunication.findUnique({ where: { id: pending.id } }));
  assert.equal(sent.status, "SENT");
  assert.equal(sent.encryptedPayload, null);
});
test("delayed rejection is cancelled if the application is reopened", async () => {
  const now = new Date();
  await tx(async (q) => {
    await q.application.update({
      where: { id: application.id },
      data: {
        stage: "rejected",
        status: "rejected",
        version: { increment: 1 },
      },
    });
    await enqueueHrDomainEvent(q, {
      tenantId: tenant,
      eventName: "hr.recruitment.application_stage_changed.v1",
      aggregateType: "Application",
      aggregateId: application.id,
      occurredAt: now.toISOString(),
      payload: {
        applicationId: String(application.id),
        candidateId: String(candidate.id),
        toStage: "rejected",
        fromStage: "applied",
        jobRequisitionId: String(job.id),
        applicationVersion: 1,
        status: "rejected",
        reason: "NOT_SELECTED",
        requestedById: String(employee.id),
      },
    });
  });
  await mcpCtx.run({ system: true }, () =>
    runCandidateCommunicationProjection({ tenantId: tenant }),
  );
  const row = await tx((q) =>
    q.candidateCommunication.findFirst({
      where: { templateKey: "application_rejected" },
    }),
  );
  assert.equal(row.scheduledAt.getTime(), now.getTime() + 7200000);
  let sent = 0;
  await work({
    now,
    send: async () => {
      sent++;
      return { sent: true };
    },
  });
  assert.equal(sent, 0);
  await tx((q) =>
    q.application.update({
      where: { id: application.id },
      data: { stage: "screening", status: "open", version: { increment: 1 } },
    }),
  );
  await work({
    now: new Date(now.getTime() + 7200001),
    send: async () => {
      sent++;
      return { sent: true };
    },
  });
  assert.equal(sent, 0);
  assert.equal(
    (await tx((q) => q.candidateCommunication.findUnique({ where: { id: row.id } }))).status,
    "CANCELLED",
  );
});
test("a late Hub response cannot count a cancelled communication as sent", async () => {
  const now = new Date();
  const row = await tx((q) =>
    enqueueCandidateCommunication(q, {
      tenantId: tenant,
      candidateId: candidate.id,
      applicationId: application.id,
      templateKey: "application_stage_changed",
      dedupeKey: "late-cancelled-response",
      scheduledAt: now,
    }),
  );
  const counts = await work({
    now,
    send: async (message) => {
      if (message.dedupeKey === "recruitment:" + row.id)
        await tx((q) =>
          q.candidateCommunication.update({
            where: { id: row.id },
            data: {
              status: "CANCELLED",
              leaseToken: null,
              leaseUntil: null,
              encryptedPayload: null,
            },
          }),
        );
      return { sent: true };
    },
  });
  assert.equal(counts.sent, 0);
  assert.equal(
    (await tx((q) => q.candidateCommunication.findUnique({ where: { id: row.id } }))).status,
    "CANCELLED",
  );
});
test("parallel workers claim one message and DNC is rechecked before send", async () => {
  const now = new Date(),
    row = await tx((q) =>
      enqueueCandidateCommunication(q, {
        tenantId: tenant,
        candidateId: candidate.id,
        applicationId: application.id,
        templateKey: "application_stage_changed",
        dedupeKey: "parallel",
        context: { expectedStage: "screening" },
        scheduledAt: now,
      }),
    );
  let calls = 0;
  const send = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { sent: true };
  };
  await Promise.all([work({ now, send }), work({ now, send })]);
  assert.equal(calls, 1);
  assert.equal(
    (await tx((q) => q.candidateCommunication.findUnique({ where: { id: row.id } }))).status,
    "SENT",
  );
  const blocked = await tx((q) =>
    enqueueCandidateCommunication(q, {
      tenantId: tenant,
      candidateId: candidate.id,
      applicationId: application.id,
      templateKey: "application_stage_changed",
      dedupeKey: "blocked",
      scheduledAt: now,
    }),
  );
  await tx((q) =>
    q.candidateDncEntry.create({
      data: {
        tenantId: tenant,
        email: candidate.email,
        status: "ACTIVE",
        reasonCode: "CANDIDATE_REQUEST",
        reason: "Fictional candidate requested no contact",
      },
    }),
  );
  await work({ now, send });
  assert.equal(calls, 1);
  assert.equal(
    (await tx((q) => q.candidateCommunication.findUnique({ where: { id: blocked.id } }))).status,
    "SUPPRESSED",
  );
});
test("message operations enforce row scope and do not return mailbox payloads", async () => {
  const ops = await import("../../src/services/candidateCommunication.service.js");
  await assert.rejects(
    as(() => ops.candidateCommunicationsList({ candidateId: candidate.id }), ["INTERVIEWER"]),
    { status: 403 },
  );
  const list = await as(() => ops.candidateCommunicationsList({ candidateId: candidate.id }));
  assert.ok(list.total);
  assert.equal(JSON.stringify(list).includes("encryptedPayload"), false);
  assert.equal(JSON.stringify(list).includes("tokenHash"), false);
  const sent = list.items.find((row) => row.status === "SENT");
  await assert.rejects(
    as(() =>
      ops.candidateCommunicationCancel({
        id: sent.id,
        reason: "Attempt to cancel an accepted message",
      }),
    ),
    { status: 409 },
  );
  const failed = await tx((q) =>
    enqueueCandidateCommunication(q, {
      tenantId: tenant,
      candidateId: candidate.id,
      applicationId: application.id,
      templateKey: "application_stage_changed",
      dedupeKey: "manual-retry",
    }),
  );
  await tx((q) =>
    q.candidateCommunication.update({
      where: { id: failed.id },
      data: { status: "FAILED" },
    }),
  );
  assert.equal(
    (
      await as(() =>
        ops.candidateCommunicationRetry({
          id: failed.id,
          reason: "Provider configuration corrected by operator",
        }),
      )
    ).status,
    "PENDING",
  );
});
test("notification erasure keeps retry state until Hub cancellation is confirmed", async () => {
  const { runCandidateCommunicationErasure } =
    await import("../../src/services/candidateCommunicationErasure.service.js");
  await tx(async (q) => {
    await q.candidate.update({
      where: { id: candidate.id },
      data: { anonymizedAt: new Date() },
    });
    await q.candidateCommunication.updateMany({
      where: { candidateId: candidate.id },
      data: {
        status: "CANCELLED",
        encryptedPayload: null,
        context: { hubCleanup: "PENDING" },
      },
    });
  });
  const first = await mcpCtx.run({ system: true }, () =>
    runCandidateCommunicationErasure({
      tenantId: tenant,
      cancel: async () => ({ ok: false }),
    }),
  );
  assert.ok(first.failed > 0);
  const second = await mcpCtx.run({ system: true }, () =>
    runCandidateCommunicationErasure({
      tenantId: tenant,
      cancel: async () => ({ ok: true }),
    }),
  );
  assert.ok(second.erased > 0);
  assert.equal(
    await tx((q) =>
      q.candidateCommunication.count({
        where: { context: { path: ["hubCleanup"], equals: "PENDING" } },
      }),
    ),
    0,
  );
});
test.after(() => db.$disconnect());
