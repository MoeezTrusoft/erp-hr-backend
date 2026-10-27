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
const { listRequisitionReferences: list } =
  await import("../../src/services/requisitionReference.service.js");
const tenant = randomUUID(),
  other = randomUUID();
let manager, report, unrelated, foreign, position, grade;
const scoped = (tid, fn) =>
  mcpCtx.run({ user: { tenantId: tid } }, async () => await fn());
const as = (fn, role = "RECRUITER", permissions = ["hr.recruitment.read"]) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: { tenantId: tenant, userId: manager.userId, roles: [role] },
      permissions,
    },
    fn,
  );
const employee = (tid, name, managerId) => ({
  tenant_id: tid,
  userId: randomInt(10000, 100000000),
  employee_code: name.toUpperCase() + "-" + randomUUID().toUpperCase(),
  employeeCategory: "EMPLOYEE",
  first_name: name,
  email: name + "@example.invalid",
  status: "Active",
  employement_status: "Active",
  managerId,
});
test.before(async () => {
  await scoped(tenant, async () => {
    manager = await db.employee.create({ data: employee(tenant, "Manager") });
    report = await db.employee.create({
      data: employee(tenant, "Report", manager.id),
    });
    unrelated = await db.employee.create({
      data: employee(tenant, "Unrelated"),
    });
    position = await db.position.create({
      data: { tenantId: tenant, title: "Editorial Designer" },
    });
    await db.position.create({
      data: { tenantId: tenant, title: "Inactive role", isActive: false },
    });
    grade = await db.gradeLevel.create({
      data: { tenantId: tenant, name: "G5", minSalary: 90000 },
    });
  });
  foreign = await scoped(other, () =>
    db.employee.create({ data: employee(other, "Foreign") }),
  );
});
test("verified read access is required and foreign tenant claims are denied", async () => {
  const args = { tenantId: tenant, kind: "EMPLOYEE" };
  await assert.rejects(
    as(() => list(args), "INTERVIEWER"),
    (e) => e.status === 403,
  );
  await assert.rejects(
    as(() => list(args), "RECRUITER", []),
    (e) => e.status === 403,
  );
  await assert.rejects(
    as(() => list({ ...args, tenantId: other })),
    (e) => e.status === 403,
  );
  await assert.rejects(
    scoped(tenant, () => list(args)),
    (e) => e.status === 403,
  );
});
test("employee choices are paged and only contain labels and ids", async () => {
  const first = await as(() =>
    list({ tenantId: tenant, kind: "EMPLOYEE", pageSize: 2 }),
  );
  const second = await as(() =>
    list({
      tenantId: tenant,
      kind: "EMPLOYEE",
      pageSize: 2,
      page: 2,
      selectedId: manager.id,
    }),
  );
  assert.equal(first.total, 3);
  assert.equal(first.items.length, 2);
  assert.equal(second.items.length, 1);
  assert.deepEqual(
    new Set([...first.items, ...second.items].map((r) => r.id)),
    new Set([manager.id, report.id, unrelated.id]),
  );
  assert.deepEqual(Object.keys(first.items[0]).sort(), ["id", "label"]);
  assert.equal(second.selected.id, manager.id);
  assert.equal(first.actorEmployeeId, manager.id);
});
test("manager choices and selected ids obey reporting scope and tenant boundaries", async () => {
  const page = await as(
    () =>
      list({ tenantId: tenant, kind: "EMPLOYEE", selectedId: unrelated.id }),
    "HIRING_MANAGER",
  );
  assert.deepEqual(
    page.items.map((r) => r.id),
    [manager.id, report.id],
  );
  assert.equal(page.selected, null);
  const foreignPage = await as(() =>
    list({ tenantId: tenant, kind: "EMPLOYEE", selectedId: foreign.id }),
  );
  assert.equal(foreignPage.selected, null);
});
test("code search and reference labels do not expose compensation", async () => {
  const employees = await as(() =>
    list({ tenantId: tenant, kind: "EMPLOYEE", q: "Report-" }),
  );
  assert.deepEqual(
    employees.items.map((r) => r.id),
    [report.id],
  );
  const positions = await as(() =>
    list({ tenantId: tenant, kind: "POSITION", q: "editorial" }),
  );
  assert.deepEqual(positions.items, [
    { id: position.id, label: "Editorial Designer" },
  ]);
  const grades = await as(() => list({ tenantId: tenant, kind: "GRADE" }));
  assert.deepEqual(grades.items, [{ id: grade.id, label: "G5" }]);
});
test.after(async () => {
  await scoped(tenant, async () => {
    await db.employee.deleteMany({ where: { tenant_id: tenant } });
    await db.position.deleteMany({ where: { tenantId: tenant } });
    await db.gradeLevel.deleteMany({ where: { tenantId: tenant } });
  });
  await scoped(other, () =>
    db.employee.deleteMany({ where: { tenant_id: other } }),
  );
  await db.$disconnect();
});
