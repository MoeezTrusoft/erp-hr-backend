import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
import { Client } from "pg";
const url = new URL(process.env.RECRUITMENT_TEST_DATABASE_URL || "");
if (
  url.hostname !== "127.0.0.1" ||
  !["5432", "55471"].includes(url.port) ||
  url.pathname !== "/hr_task_assessment_test" ||
  url.username !== "recruitment_test_user"
)
  throw new Error("Use isolated recruitment database");
process.env.DATABASE_URL = url.href;
process.env.NODE_ENV = "test";
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const { mergeCandidates } =
  await import("../../src/services/candidateMerge.service.js");
const tenant = randomUUID(),
  foreign = randomUUID();
let employee, job, foreignCandidate;
const tx = (fn, t = tenant) =>
  mcpCtx.run({ user: { tenantId: t } }, () =>
    tenantTransaction(db, fn, {
      tenantId: t,
      txOptions: { timeout: 30000, maxWait: 10000 },
    }),
  );
const as = (fn, role = "HR_ADMIN", extra = {}) =>
  mcpCtx.run(
    {
      actorVerified: role !== "UNVERIFIED",
      user: {
        tenantId: tenant,
        userId: employee.userId,
        employeeId: 999999,
        roles: [role],
        isAdmin: true,
        ...extra,
      },
      permissions: ["hr.recruitment.read", "hr.recruitment.update"],
    },
    fn,
  );
const call = (pair, input = {}, role, extra) =>
  as(
    () =>
      mergeCandidates({
        tenantId: tenant,
        sourceId: pair.source.id,
        targetId: pair.target.id,
        ...input,
      }),
    role,
    extra,
  );
const pair = () =>
  tx(async (q) => {
    const create = (firstName) =>
      q.candidate.create({
        data: {
          tenantId: tenant,
          firstName,
          email: randomUUID() + "@example.invalid",
          notes: "Keep original identity notes",
          phone: firstName === "Source" ? "synthetic-phone" : null,
        },
      });
    return { source: await create("Source"), target: await create("Target") };
  });
const apply = async (p, extra = {}) =>
  call(p, {
    mode: "APPLY",
    confirmed: true,
    previewHash: (await call(p)).previewHash,
    ...extra,
  });
test.before(async () => {
  await tx(async (q) => {
    employee = await q.employee.create({
      data: {
        tenant_id: tenant,
        userId: randomInt(10000, 1000000000),
        employee_code: randomUUID().toUpperCase(),
        employeeCategory: "EMPLOYEE",
        first_name: "Fictional",
        status: "Active",
      },
    });
    job = await q.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Synthetic merge role",
        requestedById: employee.id,
      },
    });
  });
  foreignCandidate = await tx(
    (q) =>
      q.candidate.create({
        data: {
          tenantId: foreign,
          firstName: "Foreign",
          email: randomUUID() + "@example.invalid",
        },
      }),
    foreign,
  );
});
test("preview and writes require actual human ORG actor and hide foreign identities", async () => {
  const p = await pair();
  for (const role of [
    "HIRING_MANAGER",
    "INTERVIEWER",
    "FINANCE",
    "AGENCY",
    "UNVERIFIED",
  ])
    await assert.rejects(call(p, {}, role), (e) => e.status === 403);
  await assert.rejects(
    call(p, {}, "HR_ADMIN", { isAutomation: true }),
    (e) => e.status === 403,
  );
  await assert.rejects(
    call(p, { targetId: foreignCandidate.id }),
    (e) => e.status === 404,
  );
  const preview = await call(p);
  assert.equal(preview.mode, "PREVIEW");
  assert.equal(preview.source.email, p.source.email);
  assert.equal(
    (await tx((q) => q.candidate.findUnique({ where: { id: p.source.id } })))
      .status,
    "active",
  );
});
test("explicit current preview required; concurrent retries create one archive, receipt and event", async () => {
  const p = await pair(),
    preview = await call(p);
  await assert.rejects(call(p, { mode: "APPLY" }), (e) => e.status === 428);
  const args = {
    mode: "APPLY",
    confirmed: true,
    previewHash: preview.previewHash,
    actorId: 999999,
  };
  const results = await Promise.all([call(p, args), call(p, args)]);
  assert.equal(results.filter((x) => x.replayed).length, 1);
  assert.ok(results.every((x) => x.actorId === employee.id));
  assert.equal(
    await tx((q) =>
      q.log.count({
        where: {
          tenantId: tenant,
          module: "Candidate Merge",
          notes: { startsWith: `candidate-merge:v2:${p.source.id}:` },
        },
      }),
    ),
    1,
  );
  assert.equal(
    await tx((q) =>
      q.outboxEvent.count({
        where: {
          tenantId: tenant,
          eventName: "hr.recruitment.candidate_merged.v1",
          aggregateId: String(p.target.id),
        },
      }),
    ),
    1,
  );
});
test("identity-bound consent, overlapping pools/skills and both token purposes remain attached to source", async () => {
  const p = await pair();
  await tx(async (q) => {
    for (const c of [p.source, p.target]) {
      await q.talentPool.create({
        data: { tenantId: tenant, candidateId: c.id, poolName: "General" },
      });
      await q.candidateSkill.create({
        data: { tenantId: tenant, candidateId: c.id, name: "Typesetting" },
      });
    }
    await q.candidateConsent.create({
      data: {
        tenantId: tenant,
        candidateId: p.source.id,
        purpose: "PROCESSING",
        status: "GRANTED",
        policyVersion: "test-v1",
      },
    });
    for (const purpose of ["STATUS_LINK", "APPLY_VERIFICATION"])
      await q.candidateEmailVerification.create({
        data: {
          tenantId: tenant,
          candidateId: p.source.id,
          email: p.source.email,
          purpose,
          tokenHash: randomUUID(),
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
  });
  await apply(p);
  await tx(async (q) => {
    assert.equal(
      await q.candidateConsent.count({
        where: { candidateId: p.target.id, tenantId: tenant },
      }),
      0,
    );
    assert.equal(
      await q.candidateConsent.count({
        where: { candidateId: p.source.id, tenantId: tenant },
      }),
      1,
    );
    assert.equal(
      await q.candidateEmailVerification.count({
        where: {
          candidateId: p.source.id,
          tenantId: tenant,
          consumedAt: { not: null },
        },
      }),
      2,
    );
    assert.equal(
      await q.candidateEmailVerification.count({
        where: { candidateId: p.target.id, tenantId: tenant },
      }),
      0,
    );
    for (const model of ["talentPool", "candidateSkill"])
      assert.equal(
        await q[model].count({
          where: { tenantId: tenant, candidateId: p.source.id },
        }),
        1,
      );
    const survivor = await q.candidate.findUnique({
      where: { id: p.target.id },
    });
    assert.equal(survivor.phone, null);
    assert.equal(survivor.email, p.target.email);
    assert.equal(survivor.notes, p.target.notes);
  });
});
test("unprotected application transfer is versioned and survives unchanged repeat", async () => {
  const p = await pair();
  const a = await tx((q) =>
    q.application.create({
      data: {
        tenantId: tenant,
        candidateId: p.source.id,
        jobRequisitionId: job.id,
      },
    }),
  );
  const preview = await call(p);
  assert.deepEqual(preview.transferredApplicationIds, [a.id]);
  const args = {
    mode: "APPLY",
    confirmed: true,
    previewHash: preview.previewHash,
  };
  await call(p, args);
  await call(p, args);
  const actual = await tx((q) =>
    q.application.findUnique({ where: { id: a.id } }),
  );
  assert.equal(actual.candidateId, p.target.id);
  assert.equal(actual.version, 1);
});
test("new applications and candidate edits invalidate a stale preview", async () => {
  const p = await pair(),
    old = await call(p);
  await tx((q) =>
    q.application.create({
      data: {
        tenantId: tenant,
        candidateId: p.source.id,
        jobRequisitionId: job.id,
      },
    }),
  );
  await assert.rejects(
    call(p, { mode: "APPLY", confirmed: true, previewHash: old.previewHash }),
    (e) => e.status === 412,
  );
  const current = await call(p);
  await tx((q) =>
    q.candidate.update({
      where: { id: p.target.id },
      data: { version: { increment: 1 } },
    }),
  );
  await assert.rejects(
    call(p, {
      mode: "APPLY",
      confirmed: true,
      previewHash: current.previewHash,
    }),
    (e) => e.status === 412,
  );
});
test("live conflicts are blocked and terminal conflicts require a separate explicit acknowledgement", async () => {
  const p = await pair();
  await tx(async (q) => {
    for (const c of [p.source, p.target])
      await q.application.create({
        data: { tenantId: tenant, candidateId: c.id, jobRequisitionId: job.id },
      });
  });
  const pre = await call(p);
  assert.equal(pre.canMerge, false);
  await assert.rejects(
    apply(p, { keepTargetOnConflict: true }),
    /Resolve active/,
  );
  // Terminal fixture starts terminal rather than bypassing the application's workflow trigger.
  const terminal = await pair();
  await tx(async (q) => {
    await q.application.create({
      data: {
        tenantId: tenant,
        candidateId: terminal.source.id,
        jobRequisitionId: job.id,
        stage: "rejected",
        status: "closed",
      },
    });
    await q.application.create({
      data: {
        tenantId: tenant,
        candidateId: terminal.target.id,
        jobRequisitionId: job.id,
      },
    });
  });
  await assert.rejects(apply(terminal), /Explicitly confirm/);
  const result = await apply(terminal, { keepTargetOnConflict: true });
  assert.equal(result.keptOnSourceApplicationIds.length, 1);
});
test("interview history is never re-parented and a live protected application prevents archive", async () => {
  const p = await pair();
  const a = await tx((q) =>
    q.application.create({
      data: {
        tenantId: tenant,
        candidateId: p.source.id,
        jobRequisitionId: job.id,
      },
    }),
  );
  await tx((q) =>
    q.interview.create({
      data: {
        tenantId: tenant,
        applicationId: a.id,
        interviewType: "VIDEO",
        scheduledAt: new Date(Date.now() + 3600000),
      },
    }),
  );
  const preview = await call(p);
  assert.deepEqual(preview.blockedApplicationIds, [a.id]);
  await assert.rejects(apply(p), /Resolve active/);
  assert.equal(
    (await tx((q) => q.candidate.findUnique({ where: { id: p.source.id } })))
      .status,
    "active",
  );
});
test("audit persistence failure rolls back application ownership and candidate archive", async () => {
  const p = await pair();
  const application = await tx((q) =>
    q.application.create({
      data: {
        tenantId: tenant,
        candidateId: p.source.id,
        jobRequisitionId: job.id,
      },
    }),
  );
  const preview = await call(p);
  assert.ok(process.env.ASSESSMENT_TEST_ADMIN_URL, "Isolated fixture owner URL is required");
  const owner = new Client({
    connectionString:
      process.env.ASSESSMENT_TEST_ADMIN_URL,
  });
  await owner.connect();
  const suffix = randomUUID().replaceAll("-", "");
  const trigger = "merge_audit_test_" + suffix;
  try {
    await owner.query(
      `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."tenantId"='${tenant}'::uuid AND NEW."aggregateId"='${p.target.id}' AND NEW."eventName"='hr.recruitment.candidate_merged.v1' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`,
    );
    await owner.query(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
    );
    await assert.rejects(
      call(p, {
        mode: "APPLY",
        confirmed: true,
        previewHash: preview.previewHash,
      }),
      /synthetic audit failure/,
    );
    assert.equal(
      (await tx((q) => q.candidate.findUnique({ where: { id: p.source.id } })))
        .status,
      "active",
    );
    const unchanged = await tx((q) =>
      q.application.findUnique({ where: { id: application.id } }),
    );
    assert.equal(unchanged.candidateId, p.source.id);
    assert.equal(unchanged.version, 0);
    assert.equal(
      await tx((q) =>
        q.log.count({
          where: {
            tenantId: tenant,
            module: "Candidate Merge",
            notes: { startsWith: `candidate-merge:v2:${p.source.id}:` },
          },
        }),
      ),
      0,
    );
  } finally {
    await owner.query(`DROP TRIGGER IF EXISTS ${trigger} ON outbox_events`);
    await owner.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
    await owner.end();
  }
});
test.after(async () => {
  for (const t of [tenant, foreign])
    await tx(async (q) => {
      await q.outboxEvent.deleteMany({ where: { tenantId: t } });
      await q.log.deleteMany({ where: { tenantId: t } });
      await q.interview.deleteMany({ where: { tenantId: t } });
      await q.application.deleteMany({ where: { tenantId: t } });
      await q.candidateEmailVerification.deleteMany({ where: { tenantId: t } });
      await q.candidateConsent.deleteMany({ where: { tenantId: t } });
      await q.candidateSkill.deleteMany({ where: { tenantId: t } });
      await q.talentPool.deleteMany({ where: { tenantId: t } });
      await q.candidate.deleteMany({ where: { tenantId: t } });
      await q.jobRequisition.deleteMany({ where: { tenantId: t } });
      await q.employee.deleteMany({ where: { tenant_id: t } });
    }, t);
  await db.$disconnect();
});
