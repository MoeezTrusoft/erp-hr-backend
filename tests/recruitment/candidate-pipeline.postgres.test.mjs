import test from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:http";
const url = new URL(process.env.RECRUITMENT_TEST_DATABASE_URL || "");
if (
  url.hostname !== "127.0.0.1" ||
  url.pathname !== "/hr_task_assessment_test" ||
  url.username !== "recruitment_test_user"
)
  throw new Error("Use isolated recruitment database");
process.env.DATABASE_URL = url.href;
process.env.NODE_ENV = "test";
let department,
  hiddenDepartment,
  unavailable = false;
const rbac = createServer((req, res) => {
  req.resume();
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify(
      unavailable
        ? { error: { message: "Unavailable" } }
        : {
            result: {
              contents: [
                {
                  text: JSON.stringify({
                    departments: [
                      { id: department?.id, name: "Visible department" },
                      { id: hiddenDepartment?.id, name: "Private department" },
                    ],
                  }),
                },
              ],
            },
          },
    ),
  );
});
await new Promise((resolve) => rbac.listen(0, "127.0.0.1", resolve));
process.env.RBAC_SERVICE_URL = `http://127.0.0.1:${rbac.address().port}`;
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const { listPipelineCards, getPipelineBoard } =
  await import("../../src/services/candidatePipeline.service.js");
const { registerCandidatePipelineTools } =
  await import("../../src/mcp/tools/candidatePipelineTools.js");
const tenant = randomUUID(),
  foreign = randomUUID(),
  handlers = {};
let manager, other, job, hiddenJob, people, applications;
registerCandidatePipelineTools({
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
  as(() => listPipelineCards({ tenantId: tenant, ...args }), role);
test.before(async () => {
  await tx(async (q) => {
    const employee = () =>
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
    department = await q.businessUnit.create({
      data: { tenantId: tenant, name: "Local label is not authoritative" },
    });
    hiddenDepartment = await q.businessUnit.create({
      data: { tenantId: tenant, name: "Private" },
    });
    job = await q.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Visible role",
        requestedById: manager.id,
        departmentId: department.id,
      },
    });
    hiddenJob = await q.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Private role",
        requestedById: other.id,
        departmentId: hiddenDepartment.id,
      },
    });
    await q.candidate.createMany({
      data: Array.from({ length: 125 }, (_, i) => ({
        tenantId: tenant,
        firstName: "Person " + String(i).padStart(3, "0"),
        lastName: "Example",
        email: randomUUID() + "@example.invalid",
        source: i === 124 ? "Employee referral" : "Career site",
        notes: "Never project internal notes",
        parsedResume: { yearsOfExperience: i === 124 ? false : i / 10 },
        resumeMediaId: 100 + i,
      })),
    });
    people = await q.candidate.findMany({
      where: { tenantId: tenant },
      orderBy: { firstName: "asc" },
    });
    await q.application.createMany({
      data: people.map((c, i) => ({
        tenantId: tenant,
        candidateId: c.id,
        jobRequisitionId: i === 124 ? job.id : hiddenJob.id,
        stage: i === 124 ? "on_hold" : "applied",
        appliedAt: new Date("2026-10-01T00:00:00Z"),
      })),
    });
    applications = await q.application.findMany({
      where: { tenantId: tenant },
      orderBy: { id: "asc" },
    });
    await q.interview.create({
      data: {
        tenantId: tenant,
        applicationId: applications[123].id,
        interviewType: "VIDEO",
        scheduledAt: new Date("2026-12-01"),
        interviewers: { create: { tenantId: tenant, employeeId: manager.id } },
      },
    });
  });
  await tx(async (q) => {
    const candidate = await q.candidate.create({
      data: {
        tenantId: foreign,
        firstName: "Foreign",
        email: randomUUID() + "@example.invalid",
        source: "Foreign secret",
      },
    });
    const owner = await q.employee.create({
      data: {
        tenant_id: foreign,
        userId: randomInt(10000, 1000000000),
        employee_code: randomUUID().toUpperCase(),
        employeeCategory: "EMPLOYEE",
        status: "Active",
      },
    });
    const requisition = await q.jobRequisition.create({
      data: {
        tenantId: foreign,
        title: "Foreign role",
        requestedById: owner.id,
      },
    });
    await q.application.create({
      data: {
        tenantId: foreign,
        candidateId: candidate.id,
        jobRequisitionId: requisition.id,
      },
    });
  }, foreign);
});
test("stable global paging returns every application once, with full stage counts", async () => {
  const a = await list({ pageSize: 100 }),
    b = await list({ pageSize: 100, page: 2 });
  assert.equal(a.total, 125);
  assert.equal(a.items.length, 100);
  assert.equal(b.items.length, 25);
  assert.equal(
    new Set([...a.items, ...b.items].map((x) => x.applicationId)).size,
    125,
  );
  assert.equal(a.stageCounts.applied, 124);
  assert.equal(a.stageCounts.on_hold, 1);
  assert.deepEqual(a.facets.sources, ["Career site", "Employee referral"]);
  assert.ok(a.facets.departments.some((d) => d.name === "Visible department"));
  assert.ok(!JSON.stringify(a.items).includes("Never project"));
  assert.equal(a.items[0].email, undefined);
});
test("full-name, email, role and literal searches reach beyond the first page", async () => {
  for (const q of ["person 124 example", people[124].email, "visible role"]) {
    const result = await list({ q });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].candidateId, people[124].id);
  }
  for (const q of ["%' OR TRUE --", "%", "_"])
    assert.equal((await list({ q })).total, 0);
});
test("global source, department, requisition and stage filters compose before paging", async () => {
  const x = await list({
    source: "Employee referral",
    stage: "on_hold",
    departmentId: department.id,
    requisitionId: job.id,
  });
  assert.equal(x.total, 1);
  assert.equal(x.items[0].candidateId, people[124].id);
  assert.equal(x.stageCounts.applied, 0);
  assert.deepEqual(x.facets.sources, ["Career site", "Employee referral"]);
  assert.equal(
    (
      await list({
        departmentId: hiddenDepartment.id,
        source: "Employee referral",
      })
    ).total,
    0,
  );
});
test("experience sorting treats malformed JSON as unknown and keeps unknown last", async () => {
  assert.equal(
    (await list({ sort: "experience_desc" })).items[0].yearsExperience,
    12.3,
  );
  assert.equal(
    (await list({ sort: "experience_asc" })).items[0].yearsExperience,
    0,
  );
  for (const sort of ["experience_asc", "experience_desc"]) {
    const x = await list({ sort, pageSize: 100, page: 2 });
    assert.equal(x.items.at(-1).yearsExperience, null);
  }
  assert.equal(
    (await list({ sort: "name_asc" })).items[0].name,
    "Person 000 Example",
  );
});
test("manager and panel scopes use actual employee identity for rows and all facets", async () => {
  const managed = await list({}, "HIRING_MANAGER");
  assert.equal(managed.total, 1);
  assert.equal(managed.items[0].jobRequisitionId, job.id);
  assert.deepEqual(managed.facets.departments, [
    { id: department.id, name: "Visible department" },
  ]);
  assert.deepEqual(managed.facets.sources, ["Employee referral"]);
  assert.equal(
    (await list({ departmentId: hiddenDepartment.id }, "HIRING_MANAGER")).total,
    0,
  );
  const assigned = await list({}, "INTERVIEWER");
  assert.equal(assigned.total, 1);
  assert.equal(assigned.items[0].applicationId, applications[123].id);
  assert.equal((await list({ requisitionId: job.id }, "INTERVIEWER")).total, 0);
});
test("invalid queries, unverified actors and cross-tenant callers fail closed", async () => {
  for (const args of [
    { page: 1.5 },
    { pageSize: 101 },
    { page: true },
    { sort: "notes" },
    { stage: "NEW" },
    { departmentId: "1 OR TRUE" },
    { q: [] },
    { q: "x".repeat(201) },
  ])
    await assert.rejects(list(args), (e) => e.statusCode === 422);
  for (const role of ["AGENCY", "FINANCE", "UNVERIFIED", "UNKNOWN"])
    await assert.rejects(list({}, role), (e) => e.status === 403);
  await assert.rejects(list({ tenantId: foreign }), (e) => e.status === 403);
});
test("MCP metadata, board projection and RBAC failure retain safe department identities", async () => {
  const reply = await as(() =>
    handlers.hr_candidate_pipeline_list({
      page: 2,
      pageSize: 100,
      sort: "name_asc",
    }),
  );
  assert.equal(reply.isError, undefined);
  const data = JSON.parse(reply.content[0].text);
  assert.equal(data.total, 125);
  assert.equal(data.page, 2);
  assert.equal(data.items.length, 25);
  assert.equal(data.stageCounts.applied, 124);
  assert.equal(data.sort, "name");
  assert.equal(data.order, "asc");
  const board = await as(() =>
    getPipelineBoard({ tenantId: tenant, q: "visible role" }),
  );
  assert.equal(board.total, 1);
  assert.equal(
    board.columns.find((x) => x.stage === "on_hold").cards.length,
    1,
  );
  unavailable = true;
  try {
    const fallback = await list({}, "HIRING_MANAGER");
    assert.deepEqual(fallback.facets.departments, [
      { id: department.id, name: `Department #${department.id}` },
    ]);
  } finally {
    unavailable = false;
  }
});
test("anonymized identities disappear while archived application history remains visible", async () => {
  await tx((q) =>
    q.candidate.update({
      where: { id: people[124].id },
      data: { status: "archived", archivedAt: new Date() },
    }),
  );
  assert.equal((await list({ q: "person 124" })).total, 1);
  await tx((q) =>
    q.candidate.update({
      where: { id: people[124].id },
      data: { anonymizedAt: new Date() },
    }),
  );
  const x = await list();
  assert.equal(x.total, 124);
  assert.deepEqual(x.facets.sources, ["Career site"]);
});
test.after(async () => {
  for (const t of [tenant, foreign])
    await tx(async (q) => {
      await q.interviewInterviewer.deleteMany({ where: { tenantId: t } });
      await q.interview.deleteMany({ where: { tenantId: t } });
      await q.application.deleteMany({ where: { tenantId: t } });
      await q.candidate.deleteMany({ where: { tenantId: t } });
      await q.jobRequisition.deleteMany({ where: { tenantId: t } });
      await q.businessUnit.deleteMany({ where: { tenantId: t } });
      await q.employee.deleteMany({ where: { tenant_id: t } });
    }, t);
  await db.$disconnect();
  await new Promise((resolve) => rbac.close(resolve));
});
