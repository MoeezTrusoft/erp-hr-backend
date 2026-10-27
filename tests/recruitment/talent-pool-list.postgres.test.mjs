import test from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
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
const { listManagedPool, poolExperienceYears } =
  await import("../../src/services/talentPoolList.service.js");
const { registerTalentPoolMgmtTools } =
  await import("../../src/mcp/tools/talentPoolMgmtTools.js");
const tenant = randomUUID(),
  foreign = randomUUID(),
  handlers = {};
let manager, other, dept, job, hiddenJob, people;
registerTalentPoolMgmtTools({
  tool: (name, _description, _schema, fn) => {
    handlers[name] = fn;
  },
});
const tx = (fn, t = tenant) =>
  mcpCtx.run({ user: { tenantId: t } }, () =>
    tenantTransaction(db, fn, {
      tenantId: t,
      txOptions: { timeout: 30000, maxWait: 10000 },
    }),
  );
const as = (fn, role = "HR_ADMIN") =>
  mcpCtx.run(
    {
      actorVerified: role !== "UNVERIFIED",
      user: {
        tenantId: tenant,
        userId: manager.userId,
        employeeId: other.id,
        roles: [role],
        isAdmin: true,
      },
      permissions: ["hr.recruitment.read"],
    },
    fn,
  );
const list = (args = {}, role) =>
  as(() => listManagedPool({ tenantId: tenant, ...args }), role);
test.before(async () => {
  await tx(async (q) => {
    const employee = async () =>
      q.employee.create({
        data: {
          tenant_id: tenant,
          userId: randomInt(10000, 1000000000),
          employee_code: randomUUID().toUpperCase(),
          employeeCategory: "EMPLOYEE",
          status: "Active",
          first_name: "Fictional",
        },
      });
    manager = await employee();
    other = await employee();
    dept = await q.businessUnit.create({
      data: { tenantId: tenant, name: "Engineering" },
    });
    job = await q.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Visible role",
        requestedById: manager.id,
        departmentId: dept.id,
      },
    });
    hiddenJob = await q.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Private role",
        requestedById: other.id,
      },
    });
    await q.candidate.createMany({
      data: Array.from({ length: 125 }, (_, i) => ({
        tenantId: tenant,
        firstName: "Person " + String(i).padStart(3, "0"),
        email: randomUUID() + "@example.invalid",
        parsedResume:
          i === 124
            ? { yearsOfExperience: null }
            : i === 123
              ? { yearsOfExperience: false }
              : { yearsOfExperience: i / 10 },
      })),
    });
    people = await q.candidate.findMany({
      where: { tenantId: tenant },
      orderBy: { firstName: "asc" },
    });
    await q.talentPool.createMany({
      data: people.map((p, i) => ({
        tenantId: tenant,
        candidateId: p.id,
        poolName: i === 124 ? "Specialists" : "General",
        notes: "Internal only",
        addedAt: new Date("2026-10-01T00:00:00Z"),
      })),
    });
    await q.candidateSkill.create({
      data: {
        tenantId: tenant,
        candidateId: people[124].id,
        name: "Beyond first page",
      },
    });
    await q.application.create({
      data: {
        tenantId: tenant,
        candidateId: people[124].id,
        jobRequisitionId: job.id,
        appliedAt: new Date("2026-10-01"),
      },
    });
    await q.application.create({
      data: {
        tenantId: tenant,
        candidateId: people[124].id,
        jobRequisitionId: hiddenJob.id,
        appliedAt: new Date("2026-10-02"),
      },
    });
    await q.application.create({
      data: {
        tenantId: tenant,
        candidateId: people[123].id,
        jobRequisitionId: hiddenJob.id,
      },
    });
  });
  await tx(async (q) => {
    const c = await q.candidate.create({
      data: {
        tenantId: foreign,
        firstName: "Foreign",
        email: randomUUID() + "@example.invalid",
      },
    });
    await q.talentPool.create({
      data: {
        tenantId: foreign,
        candidateId: c.id,
        poolName: "Foreign secret",
      },
    });
  }, foreign);
});
test("global sorting, stable ties and counts page across more than 100 members", async () => {
  const first = await list({ limit: 100, sort: "name", order: "desc" }),
    second = await list({ limit: 100, page: 2, sort: "name", order: "desc" });
  assert.equal(first.total, 125);
  assert.equal(first.items[0].name, "Person 124");
  assert.equal(second.items.length, 25);
  assert.equal(
    new Set([...first.items, ...second.items].map((x) => x.membershipId)).size,
    125,
  );
  const a = await list({ limit: 100 }),
    b = await list({ limit: 100, page: 2 });
  assert.equal(
    new Set([...a.items, ...b.items].map((x) => x.membershipId)).size,
    125,
  );
});
test("skill/pool/search filters and global facets include records beyond page one", async () => {
  const x = await list({
    skill: "Beyond first page",
    poolName: "Specialists",
    q: "person 124",
  });
  assert.equal(x.total, 1);
  assert.equal(x.items[0].candidateId, people[124].id);
  assert.deepEqual(x.facets.pools, ["General", "Specialists"]);
  assert.deepEqual(x.facets.skills, ["Beyond first page"]);
  assert.equal((await list({ q: "%' OR TRUE --" })).total, 0);
});
test("experience sorting keeps unknown values last in both directions", async () => {
  assert.equal(
    (await list({ sort: "experienceYears", order: "desc" })).items[0]
      .experienceYears,
    12.2,
  );
  assert.equal(
    (await list({ sort: "experienceYears", order: "asc" })).items[0]
      .experienceYears,
    0,
  );
  assert.equal(
    (
      await list({ sort: "experienceYears", order: "asc", page: 7, limit: 20 })
    ).items.at(-1).experienceYears,
    null,
  );
  for (const value of [null, false, "", {}, "not known"])
    assert.equal(poolExperienceYears({ yearsOfExperience: value }), null);
  assert.equal(poolExperienceYears({ yearsOfExperience: "4.5" }), 4.5);
});
test("manager scope uses actual employee identity, latest permitted role and redacts notes/facets", async () => {
  const x = await list({}, "HIRING_MANAGER");
  assert.equal(x.total, 1);
  assert.equal(x.items[0].role, "Visible role");
  assert.equal(x.items[0].department, "Engineering");
  assert.equal(x.items[0].notes, null);
  assert.deepEqual(x.facets.pools, ["Specialists"]);
  assert.deepEqual(x.facets.departments, ["Engineering"]);
  assert.equal(
    (await list({ department: "Engineering" }, "HIRING_MANAGER")).total,
    1,
  );
  assert.equal((await list({ department: "Engineering" })).total, 0);
});
test("invalid paging/sort and unauthorized scopes fail closed", async () => {
  for (const args of [
    { page: 1.5 },
    { page: Infinity },
    { limit: 101 },
    { sort: "notes" },
    { order: "DROP TABLE" },
    { q: [] },
  ])
    await assert.rejects(list(args), (e) => e.statusCode === 422);
  for (const role of ["INTERVIEWER", "FINANCE", "AGENCY", "UNVERIFIED"])
    await assert.rejects(list({}, role), (e) => e.status === 403);
  await assert.rejects(list({ tenantId: foreign }), (e) => e.status === 403);
});
test("MCP envelope retains validated pagination and global facet contract", async () => {
  const result = await as(() =>
    handlers.hr_talent_pool_manage_list({
      page: 2,
      pageSize: 100,
      sort: "name",
      order: "asc",
    }),
  );
  assert.equal(result.isError, undefined);
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.page, 2);
  assert.equal(data.pageSize, 100);
  assert.equal(data.total, 125);
  assert.equal(data.items.length, 25);
  assert.ok(data.facets.pools.includes("Specialists"));
});
test("archived/anonymized candidates disappear from rows, counts and facets", async () => {
  await tx((q) =>
    q.candidate.update({
      where: { id: people[124].id },
      data: { status: "archived", archivedAt: new Date() },
    }),
  );
  await tx((q) =>
    q.candidate.update({
      where: { id: people[123].id },
      data: { anonymizedAt: new Date() },
    }),
  );
  const x = await list();
  assert.equal(x.total, 123);
  assert.deepEqual(x.facets.pools, ["General"]);
  assert.deepEqual(x.facets.skills, []);
});
test.after(async () => {
  for (const t of [tenant, foreign])
    await tx(async (q) => {
      await q.application.deleteMany({ where: { tenantId: t } });
      await q.talentPool.deleteMany({ where: { tenantId: t } });
      await q.candidateSkill.deleteMany({ where: { tenantId: t } });
      await q.candidate.deleteMany({ where: { tenantId: t } });
      await q.jobRequisition.deleteMany({ where: { tenantId: t } });
      await q.businessUnit.deleteMany({ where: { tenantId: t } });
      await q.employee.deleteMany({ where: { tenant_id: t } });
    }, t);
  await db.$disconnect();
});
