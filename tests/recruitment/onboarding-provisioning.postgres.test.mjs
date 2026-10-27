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
process.env.HR_ONBOARDING_AUTOMATION = "on";
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const { listProvisioning, fulfillProvisioning, runOnboardingProvisioning } =
  await import("../../src/services/onboardingProvisioning.service.js");
const {
  createPortalTask,
  updatePortalTask,
  completePortalTask,
  deletePortalTask,
  getOnboardingPortal,
} = await import("../../src/services/onboardingPortalScreen.service.js");
const { userIdToUuid } = await import("@trusoft/contracts/identity");
const tenant = randomUUID(),
  foreign = randomUUID(),
  people = {};
let checklist, otherChecklist, task;
const tx = (fn, t = tenant) =>
  mcpCtx.run({ user: { tenantId: t } }, () =>
    tenantTransaction(db, fn, { tenantId: t }),
  );
const perms = {
  hr: [
    "hr.onboarding.read",
    "hr.onboarding.create",
    "hr.onboarding.update",
    "hr.onboarding.delete",
  ],
  it: ["hr.onboarding_provisioning.read", "hr.onboarding_provisioning.update"],
  other: [
    "hr.onboarding_provisioning.read",
    "hr.onboarding_provisioning.update",
  ],
  manager: ["hr.onboarding.read", "hr.onboarding.update"],
  self: ["hr.self.read"],
};
const as = (who, fn, extra = {}) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: {
        tenantId: tenant,
        userId: people[who].userId,
        employeeId: people.hr.id,
        roles: [
          who === "hr"
            ? "HR_ADMIN"
            : who === "manager"
              ? "MANAGER"
              : who === "self"
                ? "EMPLOYEE"
                : "IT",
        ],
      },
      permissions: perms[who],
      ...extra,
    },
    fn,
  );
const work = () =>
  mcpCtx.run({ system: true }, () =>
    runOnboardingProvisioning({ tenantId: tenant }),
  );
const rejects = (promise, status) =>
  assert.rejects(promise, (e) => (e.statusCode ?? e.status) === status);
test.before(async () => {
  await tx(async (t) => {
    for (const n of Object.keys(perms))
      people[n] = await t.employee.create({
        data: {
          tenant_id: tenant,
          employee_code: "OP-" + randomUUID().toUpperCase(),
          employeeCategory: "EMPLOYEE",
          first_name: n,
          userId: randomInt(10000, 1000000000),
          status: "Active",
        },
      });
    await t.employee.update({
      where: { id: people.self.id },
      data: { managerId: people.manager.id },
    });
    checklist = await t.onboardingChecklist.create({
      data: {
        tenantId: tenant,
        employeeId: people.self.id,
        startDate: new Date("2031-01-01"),
      },
    });
  });
  await tx(async (t) => {
    const p = await t.employee.create({
      data: {
        tenant_id: foreign,
        employee_code: "OP-" + randomUUID().toUpperCase(),
        employeeCategory: "EMPLOYEE",
      },
    });
    otherChecklist = await t.onboardingChecklist.create({
      data: {
        tenantId: foreign,
        employeeId: p.id,
        startDate: new Date("2031-01-01"),
      },
    });
  }, foreign);
});
test("task creation atomically creates an assigned request and ids-only notification", async () => {
  task = await as("hr", () =>
    createPortalTask({
      tenantId: tenant,
      checklistId: checklist.id,
      title: "Create ERP access",
      category: "IT_ACCESS_SETUP",
      stage: "equipment",
      assigneeType: "IT",
      responsibleId: people.it.id,
    }),
  );
  const rows = await as("it", () => listProvisioning({}, tenant));
  assert.equal(rows.total, 1);
  assert.equal(rows.items[0].taskId, task.id);
  assert.equal(rows.items[0].canAssign, false);
  assert.equal(rows.items[0].canFulfill, true);
  assert.equal(rows.items[0].employeeName, "self");
  assert.equal(rows.items[0].notifiedUserId, undefined);
  const ev = await tx((t) =>
    t.outboxEvent.findMany({
      where: {
        tenantId: tenant,
        eventName: "hr.onboarding.provisioning_requested.v1",
      },
    }),
  );
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].payload.payload.recipientUserIds, [
    userIdToUuid(tenant, people.it.userId),
  ]);
  assert.ok(!JSON.stringify(ev).includes("Create ERP access"));
});
test("row scope ignores claimed employee ID and requires a verified capability and role", async () => {
  assert.equal(
    (await as("other", () => listProvisioning({}, tenant))).total,
    0,
  );
  await rejects(
    as("self", () => listProvisioning({}, tenant)),
    403,
  );
  await rejects(
    as("it", () => listProvisioning({}, tenant), { permissions: [] }),
    403,
  );
  await rejects(
    as("it", () => listProvisioning({}, foreign)),
    401,
  );
  await rejects(
    as("it", () => listProvisioning({}, tenant), { actorVerified: false }),
    401,
  );
  await rejects(
    as("manager", () =>
      fulfillProvisioning(
        { taskId: task.id, expectedVersion: 0, reference: "bad" },
        tenant,
      ),
    ),
    403,
  );
  await rejects(
    as("other", () =>
      fulfillProvisioning(
        { taskId: task.id, expectedVersion: 0, reference: "bad" },
        tenant,
      ),
    ),
    404,
  );
  assert.equal(
    (await as("manager", () => listProvisioning({}, tenant))).total,
    1,
  );
});
test("concurrent sweeps deduplicate, assigned requests cannot bypass evidence, flag off preserves existing work", async () => {
  const results = await Promise.all([work(), work()]);
  assert.equal(
    results.reduce((n, r) => n + r.created + r.notified, 0),
    0,
  );
  await rejects(
    as("hr", () => completePortalTask({ tenantId: tenant, taskId: task.id })),
    409,
  );
  await rejects(
    as("hr", () =>
      updatePortalTask({ tenantId: tenant, taskId: task.id, done: true }),
    ),
    409,
  );
  await rejects(
    as("hr", () =>
      updatePortalTask({
        tenantId: tenant,
        taskId: task.id,
        category: "OTHER",
      }),
    ),
    409,
  );
  assert.equal(
    (await as("self", () => getOnboardingPortal({ tenantId: tenant }))).tasks[0]
      .canComplete,
    false,
  );
  process.env.HR_ONBOARDING_AUTOMATION = "off";
  assert.equal((await work()).skipped, true);
  await rejects(
    as("hr", () => completePortalTask({ tenantId: tenant, taskId: task.id })),
    409,
  );
  process.env.HR_ONBOARDING_AUTOMATION = "on";
});
test("assignment invalidates stale fulfillment and notifies the new owner exactly once", async () => {
  await as("hr", () =>
    updatePortalTask({
      tenantId: tenant,
      taskId: task.id,
      responsibleId: people.other.id,
    }),
  );
  assert.equal((await as("it", () => listProvisioning({}, tenant))).total, 0);
  const r = (await as("other", () => listProvisioning({}, tenant))).items[0];
  assert.equal(r.version, 1);
  await rejects(
    as("other", () =>
      fulfillProvisioning(
        { taskId: task.id, expectedVersion: 0, reference: "TICKET-1" },
        tenant,
      ),
    ),
    412,
  );
  await work();
  assert.equal(
    await tx((t) =>
      t.outboxEvent.count({
        where: {
          tenantId: tenant,
          eventName: "hr.onboarding.provisioning_requested.v1",
        },
      }),
    ),
    2,
  );
});
test("concurrent fulfillment replays return one result and immutable evidence", async () => {
  const input = {
    taskId: task.id,
    expectedVersion: 1,
    reference: "TICKET-1 / employee ERP account",
  };
  const results = await Promise.all([
    as("other", () => fulfillProvisioning(input, tenant)),
    as("other", () => fulfillProvisioning(input, tenant)),
  ]);
  assert.equal(results[0].version, 2);
  assert.equal(+results[0].fulfilledAt, +results[1].fulfilledAt);
  assert.equal(
    (
      await tx((t) =>
        t.onboardingTask.findFirst({
          where: { tenantId: tenant, id: task.id },
        }),
      )
    ).completed,
    true,
  );
  for (const mutation of [
    () =>
      completePortalTask({ tenantId: tenant, taskId: task.id, done: false }),
    () =>
      updatePortalTask({ tenantId: tenant, taskId: task.id, title: "Changed" }),
    () => deletePortalTask({ tenantId: tenant, taskId: task.id }),
  ])
    await rejects(as("hr", mutation), 409);
  const r = await as("hr", () =>
    listProvisioning({ status: "FULFILLED" }, tenant),
  );
  assert.equal(r.total, 1);
  assert.equal(r.items[0].canFulfill, false);
  assert.equal(r.items[0].reference, input.reference);
});
test("unassigned requests remain visible to HR, invalid filters and cross-company access fail closed", async () => {
  const unassigned = await as("hr", () =>
    createPortalTask({
      tenantId: tenant,
      checklistId: checklist.id,
      title: "Allocate laptop",
      category: "WORKSPACE_EQUIPMENT",
      assigneeType: "IT",
    }),
  );
  const r = await as("hr", () =>
    listProvisioning({ status: "PENDING", pageSize: 1 }, tenant),
  );
  assert.equal(r.items[0].taskId, unassigned.id);
  assert.equal(r.items[0].assigneeId, null);
  assert.equal(r.total, 1);
  await rejects(
    as("hr", () => listProvisioning({ category: "OTHER" }, tenant)),
    422,
  );
  await rejects(
    as("hr", () => listProvisioning({ page: 0 }, tenant)),
    422,
  );
  await rejects(
    as("hr", () =>
      createPortalTask({
        tenantId: tenant,
        checklistId: otherChecklist.id,
        title: "Bad",
        category: "IT_ACCESS_SETUP",
      }),
    ),
    404,
  );
  await rejects(
    as("hr", () => runOnboardingProvisioning({ tenantId: tenant })),
    403,
  );
  const rows = await tx(
    (t) => t.$queryRawUnsafe('SELECT * FROM "OnboardingProvisioning"'),
    foreign,
  );
  assert.equal(rows.length, 0);
  await as("hr", () =>
    deletePortalTask({ tenantId: tenant, taskId: unassigned.id }),
  );
  assert.equal(
    (await as("hr", () => listProvisioning({ status: "PENDING" }, tenant)))
      .total,
    0,
  );
});
test('employee access confirmation stays in self service instead of creating an IT work request',async()=>{const own=await as('hr',()=>createPortalTask({tenantId:tenant,checklistId:checklist.id,title:'Confirm my account access',category:'IT_ACCESS_SETUP',assigneeType:'NEW_HIRE'}));assert.equal((await as('hr',()=>listProvisioning({status:'PENDING'},tenant))).total,0);const result=await as('self',()=>completePortalTask({tenantId:tenant,taskId:own.id}));assert.equal(result.done,true);});
 test.after(async () => {
  for (const company of [tenant, foreign])
    await tx(async (t) => {
      await t.$executeRawUnsafe('DELETE FROM "OnboardingSessionCalendar" WHERE "tenantId"=$1::uuid',company);
      await t.onboardingChecklist.deleteMany({ where: { tenantId: company } });
      await t.employee.deleteMany({ where: { tenant_id: company } });
    }, company);
  await db.$disconnect();
});
