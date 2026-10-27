import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
import pg from "pg";
const url = new URL(process.env.RECRUITMENT_TEST_DATABASE_URL || "");
if (
  url.hostname !== "127.0.0.1" ||
  url.pathname !== "/hr_task_assessment_test" ||
  url.username !== "recruitment_test_user"
)
  throw new Error("Use isolated recruitment database");
process.env.DATABASE_URL = url.href;
process.env.NODE_ENV = "test";
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
process.env.HR_RECRUITMENT_ONSITE_TEST = "on";
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");
const catalog =
  await import("../../src/services/candidate-assessment/catalog.js");
const tenant = randomUUID(),
  other = randomUUID();
let author,
  reviewer,
  skill,
  globalSkill,
  foreignSkill,
  grade,
  foreignGrade,
  item;
const scoped = (tid, fn) =>
  mcpCtx.run({ user: { tenantId: tid } }, async () => await fn());
const as = (fn, who = author) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: { tenantId: tenant, userId: who.userId, roles: ["HR_ADMIN"] },
      permissions: ["read", "create", "update", "publish", "approve"].map(
        (p) => "hr.recruitment.assessment." + p,
      ),
    },
    fn,
  );
const staff = (name) => ({
  tenant_id: tenant,
  userId: randomInt(10000, 100000000),
  employee_code: name + "-" + randomUUID().toUpperCase(),
  employeeCategory: "EMPLOYEE",
  first_name: name,
  status: "Active",
  employement_status: "Active",
});
const adminUrl = new URL(process.env.ASSESSMENT_TEST_ADMIN_URL || "http://invalid");
if (adminUrl.hostname !== url.hostname || adminUrl.port !== url.port ||
    adminUrl.pathname !== url.pathname || adminUrl.username !== "postgres" || !adminUrl.password)
  throw new Error("Explicit isolated fixture owner connection required");
const admin = new pg.Client({ connectionString: adminUrl.href });
const definition = () => ({
  itemCode: "EDITORIAL-1",
  type: "SINGLE",
  stem: "Which proof mark indicates deletion?",
  options: [
    { key: "A", text: "Delete mark" },
    { key: "B", text: "Insert mark" },
  ],
  answerKey: { keys: ["A"] },
  difficulty: "EASY",
  competencyKey: "PROOFREADING",
  skillId: globalSkill,
  jobFamily: "Editorial",
  gradeLevelIds: [grade.id],
  rationale: "The deletion mark removes the indicated text.",
});
const blueprint = (n) => ({
  name: "Editorial " + n,
  jobFamily: "Editorial",
  sections: ["PROOFREADING", "LAYOUT"].map((key) => ({
    key,
    competencyKey: key,
    itemCount: 1,
    weight: 1,
    difficultyMix: { EASY: 100, MEDIUM: 0, HARD: 0 },
  })),
});
test.before(async () => {
  await admin.connect();
  globalSkill = (
    await admin.query("INSERT INTO skills (name) VALUES ($1) RETURNING id", [
      "Global " + randomUUID(),
    ])
  ).rows[0].id;
  await scoped(tenant, async () => {
    author = await db.employee.create({ data: staff("AUTHOR") });
    reviewer = await db.employee.create({ data: staff("REVIEWER") });
    skill = await db.skill.create({
      data: { tenantId: tenant, name: "Local " + randomUUID() },
    });
    grade = await db.gradeLevel.create({
      data: { tenantId: tenant, name: "G5", minSalary: 100000 },
    });
  });
  await scoped(other, async () => {
    foreignSkill = await db.skill.create({
      data: { tenantId: other, name: "Foreign " + randomUUID() },
    });
    foreignGrade = await db.gradeLevel.create({
      data: { tenantId: other, name: "Foreign G5" },
    });
  });
});
test("reference choices include canonical skills while excluding foreign grades and compensation", async () => {
  const refs = await as(() =>
    catalog.referencesList({ kind: "SKILL", limit: 100 }),
  );
  assert.ok(refs.items.some((r) => r.id === globalSkill));
  assert.ok(refs.items.some((r) => r.id === skill.id));
  assert.ok(!refs.items.some((r) => r.id === foreignSkill.id));
  const grades = await as(() =>
    catalog.referencesList({ kind: "GRADE", limit: 100 }),
  );
  assert.deepEqual(grades.items, [{ id: grade.id, name: "G5" }]);
  const selected = await as(() =>
    catalog.referencesList({
      kind: "GRADE",
      q: "nonmatching",
      selectedId: grade.id,
      limit: 1,
    }),
  );
  assert.deepEqual(selected.selected, { id: grade.id, name: "G5" });
  assert.equal(
    (
      await as(() =>
        catalog.referencesList({ kind: "GRADE", selectedId: foreignGrade.id }),
      )
    ).selected,
    null,
  );
});
test("item create accepts canonical taxonomy and rejects foreign skill references", async () => {
  item = await as(() => catalog.itemCreate({ item: definition() }));
  assert.equal(item.answerKey, undefined);
  await assert.rejects(
    as(() =>
      catalog.itemCreate({
        item: {
          ...definition(),
          itemCode: "FOREIGN",
          skillId: foreignSkill.id,
        },
      }),
    ),
    (e) => e.status >= 400,
  );
});
test("draft revisions validate every grade and preserve the original on failure", async () => {
  await assert.rejects(
    as(() =>
      catalog.itemUpdate({
        id: item.id,
        expectedVersion: item.revision,
        item: { ...definition(), gradeLevelIds: [grade.id, foreignGrade.id] },
      }),
    ),
    (e) => e.status >= 400,
  );
  const unchanged = await as(() => catalog.itemGet({ id: item.id }));
  assert.equal(unchanged.revision, item.revision);
  assert.deepEqual(unchanged.gradeLevelIds, [grade.id]);
  await assert.rejects(
    as(
      () =>
        catalog.itemUpdate({
          id: item.id,
          expectedVersion: item.revision,
          item: definition(),
        }),
      reviewer,
    ),
    (e) => e.status === 403,
  );
});
test("item and blueprint cursors produce disjoint pages and drafts retain author ownership", async () => {
  for (let n = 2; n <= 5; n++)
    await as(() =>
      catalog.itemCreate({
        item: { ...definition(), itemCode: "EDITORIAL-" + n },
      }),
    );
  const one = await as(() => catalog.itemsList({ limit: 2 }));
  const two = await as(() =>
    catalog.itemsList({ limit: 2, cursor: one.nextCursor }),
  );
  assert.equal(one.items.length, 2);
  assert.equal(two.items.length, 2);
  assert.ok(two.items.every((r) => !one.items.some((a) => a.id === r.id)));
  assert.ok(two.items.every((r) => r.answerKey === undefined));
  const b1 = await as(() =>
    catalog.blueprintCreate({ blueprint: blueprint(1) }),
  );
  await as(() => catalog.blueprintCreate({ blueprint: blueprint(2) }));
  const first = await as(() => catalog.blueprintList({ limit: 1 }));
  const second = await as(() =>
    catalog.blueprintList({ limit: 1, cursor: first.nextCursor }),
  );
  assert.notEqual(first.items[0].id, second.items[0].id);
  assert.equal(second.nextCursor, null);
  await assert.rejects(
    as(
      () =>
        catalog.blueprintUpdate({
          id: b1.id,
          expectedVersion: b1.revision,
          blueprint: blueprint(1),
        }),
      reviewer,
    ),
    (e) => e.status === 403,
  );
});
test("imports are atomic, reject duplicate codes and never return answer keys", async () => {
  const before = await scoped(tenant, () =>
    db.candidateTestItem.count({ where: { tenantId: tenant } }),
  );
  await assert.rejects(
    as(() =>
      catalog.itemsImport({
        items: [
          { ...definition(), itemCode: "BATCH-1" },
          { ...definition(), itemCode: "BATCH-2", skillId: foreignSkill.id },
        ],
      }),
    ),
  );
  assert.equal(
    await scoped(tenant, () =>
      db.candidateTestItem.count({ where: { tenantId: tenant } }),
    ),
    before,
  );
  await assert.rejects(
    as(() => catalog.itemsImport({ items: [definition(), definition()] })),
    /only once/,
  );
  const imported = await as(() =>
    catalog.itemsImport({
      items: [
        { ...definition(), itemCode: "BATCH-1" },
        { ...definition(), itemCode: "BATCH-2" },
      ],
    }),
  );
  assert.equal(imported.items.length, 2);
  assert.ok(
    imported.items.every(
      (row) => row.status === "DRAFT" && row.answerKey === undefined,
    ),
  );
});
test("database guards reject foreign references and reference ownership changes", async () => {
  await assert.rejects(
    admin.query(
      'UPDATE "CandidateTestItem" SET "gradeLevelIds"=$1 WHERE id=$2',
      [[foreignGrade.id], item.id],
    ),
    /HR-6006/,
  );
  await assert.rejects(
    admin.query('UPDATE skills SET "tenantId"=$1 WHERE id=$2', [
      other,
      globalSkill,
    ]),
    /HR-6006/,
  );
  await assert.rejects(
    admin.query('UPDATE "GradeLevel" SET "tenantId"=$1 WHERE id=$2', [
      other,
      grade.id,
    ]),
    /HR-6006/,
  );
  await assert.rejects(
    admin.query('DELETE FROM "GradeLevel" WHERE id=$1', [grade.id]),
    /HR-6006/,
  );
});
test.after(async () => {
  await scoped(tenant, async () => {
    await db.candidateTestBlueprint.deleteMany({ where: { tenantId: tenant } });
    await db.candidateTestItem.deleteMany({ where: { tenantId: tenant } });
    await db.skill.deleteMany({ where: { tenantId: tenant } });
    await db.gradeLevel.deleteMany({ where: { tenantId: tenant } });
    await db.employee.deleteMany({ where: { tenant_id: tenant } });
  });
  await scoped(other, async () => {
    await db.skill.deleteMany({ where: { tenantId: other } });
    await db.gradeLevel.deleteMany({ where: { tenantId: other } });
  });
  if (globalSkill)
    await admin.query("DELETE FROM skills WHERE id=$1", [globalSkill]);
  await admin.end();
  await db.$disconnect();
});
