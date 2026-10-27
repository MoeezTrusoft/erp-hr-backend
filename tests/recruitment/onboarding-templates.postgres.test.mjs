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
const { mcpCtx } = await import("../../src/mcp/context.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const {
  listTemplates,
  upsertTemplate,
  deactivateTemplate,
  resolveTasksForProvisioning,
} = await import("../../src/services/onboardingTemplate.service.js");
const tenant = randomUUID(),
  foreign = randomUUID();
let person, primary, secondary;
const task = {
  title: "Company orientation",
  description: null,
  stage: "first_week",
  category: "ORIENTATION_TRAINING",
  assigneeType: "HR",
  dueInDays: 0,
};
const tx = (fn, t = tenant) =>
  mcpCtx.run({ user: { tenantId: t } }, () =>
    tenantTransaction(db, fn, {
      tenantId: t,
      txOptions: { timeout: 30000, maxWait: 10000 },
    }),
  );
const as = (fn, overrides = {}) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: {
        tenantId: tenant,
        userId: person.userId,
        employeeId: 999999,
        roles: ["HR_ADMIN"],
        ...overrides.user,
      },
      permissions: overrides.permissions ?? [
        "hr.recruitment.read",
        "hr.recruitment.update",
      ],
      ...Object.fromEntries(
        Object.entries(overrides).filter(([k]) => k !== "user"),
      ),
    },
    fn,
  );
const rejects = (promise, status) =>
  assert.rejects(promise, (e) => (e.statusCode ?? e.status) === status);
const save = (args) =>
  as(() => upsertTemplate({ tenantId: tenant, tasks: [task], ...args }));
test.before(async () => {
  person = await tx((t) =>
    t.employee.create({
      data: {
        tenant_id: tenant,
        employee_code: "OT-" + randomUUID().toUpperCase(),
        employeeCategory: "EMPLOYEE",
        first_name: "Template administrator",
        userId: randomInt(10000, 1000000000),
        status: "Active",
      },
    }),
  );
});
test("template administration requires a real active human and company-wide HR authority", async () => {
  await rejects(
    as(() => listTemplates({ tenantId: tenant }), { actorVerified: false }),
    401,
  );
  await rejects(
    as(() => listTemplates({ tenantId: foreign })),
    401,
  );
  await rejects(
    as(() => listTemplates({ tenantId: tenant }), { permissions: [] }),
    403,
  );
  for (const roles of [["MANAGER"], ["FINANCE"], ["EMPLOYEE"], ["UNKNOWN"]])
    await rejects(
      as(() => listTemplates({ tenantId: tenant }), { user: { roles } }),
      403,
    );
  await rejects(
    as(() => listTemplates({ tenantId: tenant }), {
      user: { isAutomation: true },
    }),
    403,
  );
  await rejects(
    as(() => listTemplates({ tenantId: tenant }), {
      user: { userId: randomInt(10000, 1000000000) },
    }),
    403,
  );
});
test("invalid task data is rejected and first creation is attributed to the actual employee", async () => {
  for (const patch of [
    { dueInDays: null },
    { dueInDays: "1" },
    { category: "UNKNOWN" },
    { assigneeType: "VENDOR" },
    { dueInDays: 366 },
    { extra: true },
  ])
    await rejects(
      save({ name: "Invalid", tasks: [{ ...task, ...patch }] }),
      422,
    );
  primary = await save({ name: "Standard", actorId: 999999 });
  assert.equal(primary.createdById, person.id);
  assert.equal(primary.isDefault, true);
  assert.equal(primary.tasks.length, 1);
});
test("concurrent promotions serialize to exactly one default, protected by the database index", async () => {
  const rows = await Promise.all([
    save({ name: "Alternate A", makeDefault: true }),
    save({ name: "Alternate B", makeDefault: true }),
  ]);
  const list = await as(() => listTemplates({ tenantId: tenant }));
  assert.equal(list.filter((r) => r.isDefault).length, 1);
  secondary = list.find((r) => r.isDefault);
  assert.ok(rows.some((r) => r.id === secondary.id));
  await assert.rejects(
    tx((t) =>
      t.onboardingChecklistTemplate.update({
        where: { id: primary.id },
        data: { isDefault: true },
      }),
    ),
  );
});
test("updates require the observed revision and cannot silently overwrite another editor", async () => {
  primary = (await as(() => listTemplates({ tenantId: tenant }))).find(
    (r) => r.id === primary.id,
  );
  await rejects(save({ name: primary.name }), 412);
  const original = primary.updated_at.toISOString();
  primary = await save({
    name: primary.name,
    description: "Reviewed by HR",
    expectedUpdatedAt: original,
  });
  await rejects(
    save({
      name: primary.name,
      description: "Stale overwrite",
      expectedUpdatedAt: original,
    }),
    412,
  );
  assert.equal(primary.description, "Reviewed by HR");
  assert.ok(primary.updated_at.toISOString() !== original);
});
test("handoff snapshots the selected template and deactivation returns later hires to the baseline", async () => {
  const before = await tx((t) => resolveTasksForProvisioning(t, tenant));
  assert.equal(before.templateId, secondary.id);
  assert.equal(before.tasks.length, 1);
  const saved = await as(() =>
    deactivateTemplate({
      tenantId: tenant,
      templateId: secondary.id,
      expectedUpdatedAt: secondary.updated_at.toISOString(),
    }),
  );
  assert.equal(saved.isDefault, false);
  assert.equal(saved.isActive, false);
  const after = await tx((t) => resolveTasksForProvisioning(t, tenant));
  assert.equal(after.source, "DEFAULT");
  assert.equal(after.tasks.length, 12);
  assert.equal(before.tasks.length, 1);
  await rejects(
    as(() =>
      deactivateTemplate({
        tenantId: tenant,
        templateId: primary.id,
        expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
      }),
    ),
    412,
  );
});
test("cross-company access fails closed, inactive rows are explicit and audit events contain only IDs and revisions", async () => {
  const foreignRow = await tx(
    (t) =>
      t.onboardingChecklistTemplate.create({
        data: { tenantId: foreign, name: "Foreign", tasks: [task] },
      }),
    foreign,
  );
  await rejects(
    as(() =>
      deactivateTemplate({
        tenantId: tenant,
        templateId: foreignRow.id,
        expectedUpdatedAt: foreignRow.updated_at.toISOString(),
      }),
    ),
    404,
  );
  const active = await as(() => listTemplates({ tenantId: tenant })),
    all = await as(() =>
      listTemplates({ tenantId: tenant, includeInactive: true }),
    );
  assert.equal(all.length, active.length + 1);
  const events = await tx((t) =>
    t.outboxEvent.findMany({
      where: {
        tenantId: tenant,
        eventName: "hr.onboarding.template_changed.v1",
      },
    }),
  );
  assert.equal(events.length, 5);
  for (const row of events) {
    assert.deepEqual(Object.keys(row.payload.payload).sort(), [
      "action",
      "actorId",
      "revision",
      "templateId",
    ]);
    assert.equal(row.payload.payload.actorId, String(person.id));
  }
  const foreignRows = await tx(
    (t) => t.$queryRawUnsafe("SELECT * FROM onboarding_checklist_templates"),
    foreign,
  );
  assert.equal(foreignRows.length, 1);
});
test.after(async () => {
  for (const company of [tenant, foreign])
    await tx(async (t) => {
      await t.onboardingChecklistTemplate.deleteMany({
        where: { tenantId: company },
      });
      await t.employee.deleteMany({ where: { tenant_id: company } });
    }, company);
  await db.$disconnect();
});
