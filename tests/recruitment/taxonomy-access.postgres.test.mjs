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
const {
  createAliasSuggestions: approve,
  reconcileParsedSkillsPreview: preview,
} = await import("../../src/services/skillTaxonomy.service.js");
const tenant = randomUUID(),
  other = randomUUID();
let employee, candidate, skill, foreign;
const tx = (fn) =>
  mcpCtx.run({ user: { tenantId: tenant } }, () =>
    tenantTransaction(db, fn, { tenantId: tenant }),
  );
const as = (
  fn,
  role = "HR_ADMIN",
  permissions = ["hr.recruitment.create", "hr.recruitment.read"],
) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: { tenantId: tenant, userId: employee.userId, roles: [role] },
      permissions,
    },
    fn,
  );
test.before(async () => {
  await tx(async (q) => {
    employee = await q.employee.create({
      data: {
        tenant_id: tenant,
        userId: randomInt(10000, 100000000),
        employee_code: "TAX-" + randomUUID().toUpperCase(),
        employeeCategory: "EMPLOYEE",
        first_name: "Fictional",
        status: "Active",
        employement_status: "Active",
      },
    });
    skill = await q.skill.create({
      data: { name: "Canonical " + randomUUID(), tenantId: tenant },
    });
    candidate = await q.candidate.create({
      data: {
        tenantId: tenant,
        firstName: "Fictional",
        email: randomUUID() + "@example.invalid",
        consentStatus: "GRANTED",
        parsedResume: { skills: [{ name: "Example alias" }] },
      },
    });
    await q.candidateConsent.create({
      data: {
        tenantId: tenant,
        candidateId: candidate.id,
        purpose: "PROCESSING",
        status: "GRANTED",
        policyVersion: "test",
      },
    });
    const job = await q.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Fictional role",
        requestedById: employee.id,
      },
    });
    await q.application.create({
      data: {
        tenantId: tenant,
        candidateId: candidate.id,
        jobRequisitionId: job.id,
      },
    });
  });
  foreign = await mcpCtx.run(
    { user: { tenantId: other } },
    async () =>
      await db.skill.create({
        data: { tenantId: other, name: "Foreign " + randomUUID() },
      }),
  );
});
test("taxonomy approval requires verified HR administrator and explicit permission", async () => {
  const args = {
    tenantId: tenant,
    suggestions: [{ alias: "Unapproved", skillId: skill.id }],
  };
  for (const role of ["RECRUITER", "HIRING_MANAGER", "INTERVIEWER"])
    await assert.rejects(
      as(() => approve(args), role),
      (e) => e.status === 403,
    );
  await assert.rejects(
    as(() => approve(args), "HR_ADMIN", []),
    (e) => e.status === 403,
  );
  await assert.rejects(
    mcpCtx.run({ user: { tenantId: tenant } }, () => approve(args)),
    (e) => e.status === 403,
  );
  assert.equal(
    await tx((q) => q.skillAlias.count({ where: { tenantId: tenant } })),
    0,
  );
});
test("a foreign canonical target cannot create a cross-tenant alias, even in a mixed batch", async () => {
  await assert.rejects(
    as(() =>
      approve({
        tenantId: tenant,
        suggestions: [
          { alias: "First valid", skillId: skill.id },
          { alias: "Foreign", skillId: foreign.id },
        ],
      }),
    ),
    (e) => e.status === 404,
  );
  assert.equal(
    await tx((q) => q.skillAlias.count({ where: { tenantId: tenant } })),
    0,
  );
});
test("reviewed mapping is active, repeat-safe and attributed in an atomic audit", async () => {
  const args = {
    tenantId: tenant,
    suggestions: [{ alias: "Example alias", skillId: skill.id }],
  };
  assert.equal((await as(() => approve(args))).created, 1);
  await as(() => approve(args));
  assert.equal(
    await tx((q) =>
      q.skillAlias.count({
        where: { tenantId: tenant, alias: "Example alias" },
      }),
    ),
    1,
  );
  const audit = await tx((q) =>
    q.log.findFirst({
      where: { tenantId: tenant, action_type: "SKILL_ALIAS_APPROVED" },
      orderBy: { id: "desc" },
    }),
  );
  assert.equal(audit.employeeId, employee.id);
  assert.equal(audit.actionById, employee.id);
  const result = await as(
    () => preview({ tenantId: tenant, candidateId: candidate.id }),
    "HIRING_MANAGER",
  );
  assert.equal(result.mapped[0].skillId, skill.id);
});
test("reconciliation denies an unrelated manager and withdrawn processing consent", async () => {
  await assert.rejects(
    as(
      () => preview({ tenantId: tenant, candidateId: candidate.id }),
      "INTERVIEWER",
    ),
    (e) => e.status === 403,
  );
  const stranger = await tx((q) =>
    q.employee.create({
      data: {
        tenant_id: tenant,
        userId: randomInt(10000, 100000000),
        employee_code: "TAX-" + randomUUID().toUpperCase(),
        employeeCategory: "EMPLOYEE",
        first_name: "Other",
        status: "Active",
        employement_status: "Active",
      },
    }),
  );
  await assert.rejects(
    mcpCtx.run(
      {
        actorVerified: true,
        user: {
          tenantId: tenant,
          userId: stranger.userId,
          roles: ["HIRING_MANAGER"],
        },
        permissions: ["hr.recruitment.read"],
      },
      () => preview({ tenantId: tenant, candidateId: candidate.id }),
    ),
    (e) => e.status === 404,
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
    as(() => preview({ tenantId: tenant, candidateId: candidate.id })),
    (e) => e.status === 409,
  );
});
test.after(() => db.$disconnect());
