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
const { exposureMonth, withPeriodExposure, reserveExposure } =
  await import("../../src/services/candidate-assessment/exposure.js");
const tenant = randomUUID(),
  other = randomUUID();
let item, skill, actor, reviewer;
const scope = (tid, fn) =>
  mcpCtx.run({ user: { tenantId: tid } }, async () => await fn());
const transaction = (now, fn, tid = tenant) =>
  scope(tid, () =>
    tenantTransaction(db, (tx) => fn(tx, { tenantId: tid, now }), {
      tenantId: tid,
    }),
  );
const october = new Date("2026-10-31T23:59:59.999Z"),
  november = new Date("2026-11-01T00:00:00Z");
test.before(async () => {
  await scope(tenant, async () => {
    actor = await db.employee.create({
      data: {
        tenant_id: tenant,
        userId: randomInt(1000, 100000000),
        employee_code: "EXPOSURE-" + randomUUID().toUpperCase(),
        employeeCategory: "EMPLOYEE",
        first_name: "Exposure",
        status: "Active",
        employement_status: "Active",
      },
    });
    reviewer = await db.employee.create({ data: { tenant_id:tenant, userId:randomInt(1000,100000000), employee_code:"REVIEW-"+randomUUID().toUpperCase(), employeeCategory:"EMPLOYEE", first_name:"Reviewer", status:"Active", employement_status:"Active" } });
    skill = await db.skill.create({
      data: { tenantId: tenant, name: "Exposure " + randomUUID() },
    });
    item = await db.candidateTestItem.create({
      data: {
        tenantId: tenant,
        itemCode: "EXPOSURE",
        status: "PUBLISHED",
        type: "SINGLE",
        stem: "A test question",
        options: [
          { key: "A", text: "First" },
          { key: "B", text: "Second" },
        ],
        answerKey: "test-not-used",
        difficulty: "EASY",
        competencyKey: "TEST",
        skillId: skill.id,
        jobFamily: "Test",
        gradeLevelIds: [],
        rationale: "For exposure tests",
        authorId: actor.id,
        reviewerId: reviewer.id,
        reviewComment: "Independently reviewed exposure fixture",
        exposureCount: 500,
        exposureCap: 2,
      },
    });
  });
});
test("period boundary is UTC and lifetime counts do not permanently exhaust the bank", async () => {
  assert.equal(
    exposureMonth(october).toISOString(),
    "2026-10-01T00:00:00.000Z",
  );
  assert.equal(
    exposureMonth(november).toISOString(),
    "2026-11-01T00:00:00.000Z",
  );
  const pool = await transaction(october, (tx, env) =>
    withPeriodExposure(tx, env, [item]),
  );
  assert.equal(pool[0].exposureCount, 0);
  assert.equal(item.exposureCount, 500);
});
test("monthly cap is enforced and next month resets eligibility without losing lifetime totals", async () => {
  await transaction(october, (tx, env) => reserveExposure(tx, env, item));
  await transaction(october, (tx, env) => reserveExposure(tx, env, item));
  await assert.rejects(
    transaction(october, (tx, env) => reserveExposure(tx, env, item)),
    (e) => e.code === "HR-6004",
  );
  assert.equal(
    (
      await transaction(october, (tx, env) =>
        withPeriodExposure(tx, env, [item]),
      )
    )[0].exposureCount,
    2,
  );
  await transaction(november, (tx, env) => reserveExposure(tx, env, item));
  assert.equal(
    (
      await transaction(november, (tx, env) =>
        withPeriodExposure(tx, env, [item]),
      )
    )[0].exposureCount,
    1,
  );
  assert.equal(
    (
      await scope(tenant, () =>
        db.candidateTestItem.findUnique({ where: { id: item.id } }),
      )
    ).exposureCount,
    503,
  );
});
test("concurrent reservations cannot overrun the remaining monthly allowance", async () => {
  const outcomes = await Promise.allSettled([
    transaction(november, (tx, env) => reserveExposure(tx, env, item)),
    transaction(november, (tx, env) => reserveExposure(tx, env, item)),
  ]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((r) => r.status === "rejected").length, 1);
  assert.equal(
    (
      await transaction(november, (tx, env) =>
        withPeriodExposure(tx, env, [item]),
      )
    )[0].exposureCount,
    2,
  );
});
test("failed assembly rolls back exposure and tenant RLS hides other company counts", async () => {
  const december = new Date("2026-12-01T00:00:00Z");
  await assert.rejects(
    transaction(december, async (tx, env) => {
      await reserveExposure(tx, env, item);
      throw Error("Assembly failed");
    }),
    /Assembly failed/,
  );
  assert.equal(
    (
      await transaction(december, (tx, env) =>
        withPeriodExposure(tx, env, [item]),
      )
    )[0].exposureCount,
    0,
  );
  const rows = await scope(other, () =>
    db.$queryRawUnsafe(
      'SELECT * FROM "CandidateTestItemExposure" WHERE "itemId"=$1',
      item.id,
    ),
  );
  assert.equal(rows.length, 0);
});
test.after(async () => {
  await scope(tenant, async () => {
    await db.candidateTestItem.deleteMany({ where: { tenantId: tenant } });
    await db.skill.deleteMany({ where: { tenantId: tenant } });
    await db.employee.deleteMany({ where: { tenant_id: tenant } });
  });
  await db.$disconnect();
});
