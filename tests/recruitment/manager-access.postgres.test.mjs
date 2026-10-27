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
const talent = await import("../../src/services/talentPoolMgmt.service.js");
const screening =
  await import("../../src/services/applicationScreening.service.js");
const applications=await import('../../src/services/applicationService.js');
const tenant = randomUUID();
let employee, other, job, candidate, app, foreign;
const tx = (fn) =>
  mcpCtx.run({ user: { tenantId: tenant } }, () =>
    tenantTransaction(db, fn, {
      tenantId: tenant,
      txOptions: { timeout: 20000, maxWait: 10000 },
    }),
  );
const as = (fn, role = "HIRING_MANAGER") =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: { tenantId: tenant, userId: employee.userId, roles: [role] },
      permissions: [
        "hr.recruitment.read",
        "hr.recruitment.update",
        "hr.recruitment.create",
        "hr.recruitment.delete",
      ],
    },
    fn,
  );
const emp = (q) =>
  q.employee.create({
    data: {
      tenant_id: tenant,
      userId: randomInt(10000, 100000000),
      employee_code: "SCOPE-" + randomUUID().toUpperCase(),
      employeeCategory: "EMPLOYEE",
      first_name: "Fictional",
      status: "Active",
      employement_status: "Active",
    },
  });
test.before(async () => {
  await tx(async (q) => {
    employee = await emp(q);
    other = await emp(q);
    job = await q.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Owned requisition",
        requestedById: other.id,
        recruiterId: employee.id,
      },
    });
    const outside = await q.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Private other requisition",
        requestedById: other.id,
      },
    });
    candidate = await q.candidate.create({
      data: {
        tenantId: tenant,
        firstName: "Fictional owned",
        email: randomUUID() + "@example.invalid",
        notes: "Recruiter-only confidential note",
      },
    });
    foreign = await q.candidate.create({
      data: {
        tenantId: tenant,
        firstName: "Fictional private",
        email: randomUUID() + "@example.invalid",
      },
    });
    app = await q.application.create({
      data: {
        tenantId: tenant,
        candidateId: candidate.id,
        jobRequisitionId: job.id,
        appliedAt: new Date("2026-01-01"),
      },
    });
    await q.application.create({
      data: {
        tenantId: tenant,
        candidateId: candidate.id,
        jobRequisitionId: outside.id,
      },
    });
    await q.application.create({
      data: {
        tenantId: tenant,
        candidateId: foreign.id,
        jobRequisitionId: outside.id,
      },
    });
    for (const c of [candidate, foreign])
      await q.talentPool.create({
        data: {
          tenantId: tenant,
          candidateId: c.id,
          poolName: "Editorial",
          notes: "Private pool note",
          addedById: employee.id,
        },
      });
  });
});
test("manager pool rows and profile include only owned requisitions and mask recruiter notes", async () => {
  const list = await as(() =>
    talent.listManagedPool({ tenantId: tenant, limit: 100 }),
  );
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].candidateId, candidate.id);
  assert.equal(list.items[0].role, job.title);
  assert.equal(list.items[0].notes, null);
  const profile = await as(() =>
    talent.getPoolProfile({ tenantId: tenant, candidateId: candidate.id }),
  );
  assert.deepEqual(profile.previousRolesApplied, [job.title]);
  assert.deepEqual(profile.notes, []);
  assert.equal(profile.notesRedacted, true);
  await assert.rejects(
    as(() =>
      talent.getPoolProfile({ tenantId: tenant, candidateId: foreign.id }),
    ),
    { status: 404 },
  );
});
test("recruiter sees pool history while interviewer and unverified callers are denied", async () => {
  const profile = await as(
    () =>
      talent.getPoolProfile({ tenantId: tenant, candidateId: candidate.id }),
    "RECRUITER",
  );
  assert.equal(profile.previousRolesApplied.length, 2);
  assert.ok(profile.notes.includes("Recruiter-only confidential note"));
  await assert.rejects(
    as(() => talent.listManagedPool({ tenantId: tenant }), "INTERVIEWER"),
    { status: 403 },
  );
  await assert.rejects(
    mcpCtx.run(
      {
        user: {
          tenantId: tenant,
          userId: employee.userId,
          roles: ["HR_ADMIN"],
        },
        permissions: ["hr.recruitment.read"],
      },
      () =>
        talent.getPoolProfile({ tenantId: tenant, candidateId: candidate.id }),
    ),
    { status: 403 },
  );
});
test("screening decisions are recruiter-owned and managers review scoped results without notes", async () => {
  const args = {
    tenantId: tenant,
    applicationId: app.id,
    outcome: "ADVANCE",
    notes: "Private recruitment review evidence",
  };
  const review = await as(() =>
    screening.recordScreening({
      ...args,
      criteria: [
        {
          criterion: "Experience",
          result: "PASS",
          note: "Private criterion note",
        },
      ],
    }),
  );
  assert.equal(review.recordKind, "REVIEW");
  const saved = await as(
    () => screening.recordScreening({ ...args, actorId: other.id }),
    "RECRUITER",
  );
  assert.equal(saved.reviewedById, employee.id);
  assert.equal(saved.recordKind, "DECISION");
  const rows = await as(() => screening.listScreenings(app.id, tenant));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.notes === null));
  assert.ok(
    rows
      .filter((r) => Array.isArray(r.criteria))
      .every((r) => r.criteria.every((c) => c.note === undefined)),
  );
  assert.equal(rows[0].notes, null);
  assert.equal(rows[0].notesRedacted, true);
  await assert.rejects(
    as(() => screening.listScreenings(app.id, tenant), "INTERVIEWER"),
    { status: 403 },
  );
  await assert.rejects(
    as(
      () => screening.deactivateDispositionReason(tenant, "OTHER"),
      "RECRUITER",
    ),
    { status: 403 },
  );
});
test("pool admission needs granted talent consent, verified attribution and recruiter permission", async () => {
  const pools = await import("../../src/services/talentPool.service.js");
  const args = {
    tenantId: tenant,
    candidateId: candidate.id,
    poolName: "Future roles",
    addedById: other.id,
  };
  await assert.rejects(as(() => pools.addToPool(args), "RECRUITER"));
  assert.equal(
    await tx((q) =>
      q.talentPool.count({
        where: {
          tenantId: tenant,
          candidateId: candidate.id,
          poolName: "Future roles",
        },
      }),
    ),
    0,
  );
  await tx((q) =>
    q.candidateConsent.create({
      data: {
        tenantId: tenant,
        candidateId: candidate.id,
        purpose: "TALENT_POOL",
        status: "GRANTED",
        policyVersion: "test-policy",
        source: "SELF_SERVICE",
      },
    }),
  );
  await assert.rejects(
    as(() => pools.addToPool(args)),
    { status: 403 },
  );
  const added = await as(() => pools.addToPool(args), "RECRUITER");
  assert.equal(added.addedById, employee.id);
  assert.equal(
    (await as(() => pools.addToPool(args), "RECRUITER")).id,
    added.id,
  );
  await assert.rejects(
    as(() => pools.removeFromPool(added.id, tenant)),
    { status: 403 },
  );
  assert.equal(
    (await as(() => pools.removeFromPool(added.id, tenant), "RECRUITER"))
      .removed,
    true,
  );
});
test("required numeric rubric cannot be bypassed and its evidence is frozen", async () => {
  const template = await tx((q) =>
    q.scorecardTemplate.create({
      data: {
        tenantId: tenant,
        name: "Required screening",
        criteria: [
          {
            key: "experience",
            label: "Experience",
            required: true,
            numeric: true,
          },
        ],
        createdById: employee.id,
      },
    }),
  );
  await tx((q) =>
    q.scorecardTemplateLink.create({
      data: {
        tenantId: tenant,
        templateId: template.id,
        scopeType: "REQUISITION",
        scopeId: job.id,
      },
    }),
  );
  const args = { tenantId: tenant, applicationId: app.id, outcome: "ADVANCE" };
  await assert.rejects(
    as(() => screening.recordScreening(args), "RECRUITER"),
    { status: 400 },
  );
  await assert.rejects(
    as(
      () =>
        screening.recordScreening({
          ...args,
          criteria: [{ criterion: "experience", result: "PASS" }],
        }),
      "RECRUITER",
    ),
    { status: 400 },
  );
  await assert.rejects(
    as(
      () =>
        screening.recordScreening({
          ...args,
          criteria: [
            { criterion: "experience", result: "PASS", score: 4 },
            { criterion: "unlisted", result: "PASS" },
          ],
        }),
      "RECRUITER",
    ),
    { status: 400 },
  );
  const form = await as(() => screening.getScreeningForm(app.id, tenant));
  assert.equal(form.recordKind, "REVIEW");
  assert.equal(form.template.id, template.id);
  const saved = await as(
    () =>
      screening.recordScreening({
        ...args,
        expectedTemplateId: template.id,
        criteria: [{ criterion: "experience", result: "PASS", score: 4 }],
      }),
    "RECRUITER",
  );
  assert.equal(saved.scoreOverall, 4);
  assert.equal(saved.templateSnapshot.criteria[0].key, "experience");
  await assert.rejects(
    as(
      () =>
        screening.recordScreening({
          ...args,
          expectedTemplateId: null,
          criteria: [{ criterion: "experience", result: "PASS", score: 4 }],
        }),
      "RECRUITER",
    ),
    { status: 409 },
  );
});
test('application reads mask nested notes and managers cannot mutate the pipeline',async()=>{
 const visible=await as(()=>applications.getApplication({id:app.id,tenantId:tenant,scope:{unrestricted:true}}));assert.equal(visible.candidate.notes,null);assert.equal(visible.candidate.notesRedacted,true);
 const recruiter=await as(()=>applications.getApplication({id:app.id,tenantId:tenant}),'RECRUITER');assert.equal(recruiter.candidate.notes,'Recruiter-only confidential note');
 const page=await as(()=>applications.listApplications({tenantId:tenant,limit:100}));assert.equal(page.items.length,1);assert.equal(page.items[0].candidate.notes,null);
 await assert.rejects(as(()=>applications.updateApplicationStage({id:app.id,tenantId:tenant,stage:'screening',updatedById:other.id})),{status:403});
 await assert.rejects(as(()=>applications.deleteApplication({id:app.id,tenantId:tenant})),{status:403});
});
test.after(() => db.$disconnect());
