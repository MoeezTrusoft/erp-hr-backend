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
process.env.HR_RECRUITMENT_AI = "true";
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const { enqueueCandidateResume } =
  await import("../../src/services/candidateResumeQueue.service.js");
const { runCandidateResumeParsing } =
  await import("../../src/services/candidateResumeWorker.service.js");
const { parseResumeWithRetry } =
  await import("../../src/services/resumeParsing.service.js");
const { anonymizeCandidate } =
  await import("../../src/services/candidatePrivacy.service.js");
const tenant = randomUUID(),
  otherTenant = randomUUID();
const as = (fn, t = tenant) => mcpCtx.run({ user: { tenantId: t } }, fn);
const tx = (fn) =>
  as(() =>
    tenantTransaction(db, fn, {
      tenantId: tenant,
      txOptions: { timeout: 30000 },
    }),
  );
const result = {
  contentHash: "a".repeat(64),
  model: "fictional-test",
  skills: [
    {
      name: "Editorial review",
      category: "skill",
      score: 80,
      level: "Advanced",
    },
  ],
  competencies: [],
  certifications: [],
  yearsOfExperience: 4,
};
async function candidate(consent = true) {
  return tx(async (q) => {
    const c = await q.candidate.create({
      data: {
        tenantId: tenant,
        firstName: "Fictional",
        email: randomUUID() + "@example.invalid",
        resumeMediaId: randomInt(10000000, 100000000),
      },
    });
    if (consent)
      await q.candidateConsent.create({
        data: {
          tenantId: tenant,
          candidateId: c.id,
          purpose: "PROCESSING",
          status: "GRANTED",
          policyVersion: "test",
          source: "SELF_SERVICE",
        },
      });
    return c;
  });
}
const enqueue = (c) =>
  tx((q) => enqueueCandidateResume(q, { tenantId: tenant, candidateId: c.id }));
const run = (parse, now = new Date()) =>
  as(() => runCandidateResumeParsing({ tenantId: tenant, parse, now }));
test("enqueue is idempotent, consent checked, asset owned and atomic", async () => {
  const c = await candidate();
  const a = await enqueue(c),
    b = await enqueue(c);
  assert.equal(a.jobId, b.jobId);
  assert.equal(a.status, "PENDING");
  await assert.rejects(
    tx((q) =>
      enqueueCandidateResume(q, {
        tenantId: tenant,
        candidateId: c.id,
        mediaId: c.resumeMediaId + 1,
      }),
    ),
    { status: 400 },
  );
  const blocked = await candidate(false);
  await assert.rejects(enqueue(blocked));
  assert.equal(
    await tx((q) =>
      q.candidateResumeParseJob.count({ where: { candidateId: blocked.id } }),
    ),
    0,
  );
  const rollback = await candidate();
  await assert.rejects(
    tx(async (q) => {
      await enqueueCandidateResume(q, {
        tenantId: tenant,
        candidateId: rollback.id,
      });
      throw new Error("rollback");
    }),
  );
  assert.equal(
    await tx((q) =>
      q.candidateResumeParseJob.count({ where: { candidateId: rollback.id } }),
    ),
    0,
  );
  await run(async () => result);
});
test("workers claim once, project atomically and preserve human skills", async () => {
  const c = await candidate();
  await enqueue(c);
  await tx((q) =>
    q.candidateSkill.create({
      data: {
        tenantId: tenant,
        candidateId: c.id,
        name: "Editorial review",
        source: "manual",
        score: 95,
      },
    }),
  );
  let begin, release;
  const started = new Promise((r) => (begin = r)),
    waiting = new Promise((r) => (release = r));
  let calls = 0;
  const first = run(async () => {
    calls++;
    begin();
    await waiting;
    return result;
  });
  await started;
  const second = await run(async () => {
    throw new Error("duplicate parse");
  });
  assert.equal(second.completed, 0);
  release();
  assert.equal((await first).completed, 1);
  assert.equal(calls, 1);
  const saved = await tx((q) =>
    q.candidate.findUnique({
      where: { id: c.id },
      include: { candidateSkills: true },
    }),
  );
  assert.equal(saved.parseStatus, "COMPLETED");
  assert.equal(saved.candidateSkills[0].score, 95);
  assert.equal(saved.parsedResume.yearsOfExperience, 4);
});
test("transient failures persist a due time; retries do not wait inside the request", async () => {
  const c = await candidate(),
    job = await enqueue(c),
    now = new Date();
  let calls = 0;
  const failed = await run(async () => {
    calls++;
    throw Object.assign(new Error("Transient test"), { status: 503 });
  }, now);
  assert.equal(failed.retried, 1);
  const retry = await tx((q) =>
    q.candidateResumeParseJob.findUnique({ where: { id: job.jobId } }),
  );
  assert.equal(retry.status, "RETRY");
  assert.equal(retry.attempts, 1);
  assert.ok(retry.dueAt > now);
  await run(async () => {
    calls++;
    return result;
  }, now);
  assert.equal(calls, 1);
  assert.equal(
    (
      await run(
        async () => {
          calls++;
          return result;
        },
        new Date(now.getTime() + 5000),
      )
    ).completed,
    1,
  );
  assert.equal(calls, 2);
});
test("erasure while parsing prevents late profile or skill restoration", async () => {
  const c = await candidate();
  await enqueue(c);
  await run(async () => {
    await anonymizeCandidate({
      tenantId: tenant,
      candidateId: c.id,
      reason: "Verified test erasure",
    });
    return result;
  });
  const saved = await tx((q) =>
    q.candidate.findUnique({
      where: { id: c.id },
      include: { candidateSkills: true, resumeParseJobs: true },
    }),
  );
  assert.ok(saved.anonymizedAt);
  assert.equal(saved.parsedResume, null);
  assert.equal(saved.candidateSkills.length, 0);
  assert.equal(saved.resumeParseJobs.length, 0);
});
test("disabled AI leaves durable work pending without contacting a provider", async () => {
  const c = await candidate(),
    job = await enqueue(c);
  process.env.HR_RECRUITMENT_AI = "false";
  try {
    assert.equal(
      (
        await run(async () => {
          throw new Error("must not call");
        })
      ).skipped,
      true,
    );
  } finally {
    process.env.HR_RECRUITMENT_AI = "true";
  }
  assert.equal(
    (
      await tx((q) =>
        q.candidateResumeParseJob.findUnique({ where: { id: job.jobId } }),
      )
    ).status,
    "PENDING",
  );
  await run(async () => result);
});
test("content cache is tenant scoped, shares one lease and returns completed evidence without another invocation", async () => {
  const bytes = Buffer.from("Fictional resume " + randomUUID());
  let calls = 0,
    release,
    begin;
  const started = new Promise((r) => (begin = r)),
    waiting = new Promise((r) => (release = r));
  const deps = {
    download: async () => ({
      buffer: bytes,
      fileName: "test.txt",
      mimeType: "text/plain",
    }),
    extract: async () => bytes.toString(),
    parseText: async () => {
      calls++;
      begin();
      await waiting;
      return result;
    },
  };
  const first = as(() => parseResumeWithRetry(1, { tenantId: tenant }, deps));
  await started;
  await assert.rejects(
    as(() => parseResumeWithRetry(1, { tenantId: tenant }, deps)),
    { code: "HR-RESUME-BACKOFF" },
  );
  release();
  await first;
  const cached = await as(() =>
    parseResumeWithRetry(2, { tenantId: tenant }, deps),
  );
  assert.equal(cached.fromCache, true);
  assert.equal(calls, 1);
  await as(
    () => parseResumeWithRetry(3, { tenantId: otherTenant }, deps),
    otherTenant,
  );
  assert.equal(calls, 2);
});
test("one failed provider attempt returns promptly and records a scheduled retry instead of looping", async () => {
  const bytes = Buffer.from("Fictional retry resume " + randomUUID());
  let calls = 0;
  const deps = {
    download: async () => ({ buffer: bytes }),
    extract: async () => bytes.toString(),
    parseText: async () => {
      calls++;
      throw Object.assign(new Error("fictional transient"), { status: 502 });
    },
  };
  await assert.rejects(
    as(() => parseResumeWithRetry(4, { tenantId: tenant }, deps)),
    { status: 502 },
  );
  assert.equal(calls, 1);
  const ledger = await tx((q) =>
    q.resumeParseAttempt.findFirst({ where: { tenantId: tenant, mediaId: 4 } }),
  );
  assert.equal(ledger.attemptCount, 1);
  assert.equal(ledger.status, "FAILED");
  assert.equal(ledger.leaseToken, null);
});
test.after(() => db.$disconnect());
