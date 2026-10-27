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
process.env.HR_RECRUITMENT_EVALUATION_FORMS = "on";
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const c =
  await import("../../src/services/candidate-assessment/evaluation-catalog.js");
const { formGet, pinInterviewAssessment } =
  await import("../../src/services/candidate-assessment/forms.js");
const tenant = randomUUID(),
  other = randomUUID();
let author, reviewer, question, form, req, foreignReq, interview;
const grants = ["read", "create", "update", "publish", "admin"]
  .map((p) => "hr.recruitment.assessment." + p)
  .concat("hr.recruitment.read");
const as = (fn, who = author, permissions = grants) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: { tenantId: tenant, userId: who.userId, roles: ["HR_ADMIN"] },
      permissions,
    },
    fn,
  );
const tx = (fn, tenantId = tenant) =>
  mcpCtx.run({ user: { tenantId } }, () =>
    tenantTransaction(db, fn, { tenantId }),
  );
const definition = () => ({
  competencyKey: "EDIT",
  prompt: "How do you verify a factual claim?",
  followUps: ["Which primary source would you consult?"],
  goodAnswerGuide: "Checks primary sources and records any uncertainty.",
  level: "INTERMEDIATE",
});
const formDefinition = () => ({
  sections: [
    {
      key: "editing",
      title: "Editing",
      panelRoles: [],
      criteria: [
        {
          key: "accuracy",
          label: "Accuracy",
          description: "Verifies claims against source evidence",
          competencyKey: "EDIT",
          weight: 1,
          anchors: {
            1: "No source check",
            2: "Needs support",
            3: "Independent verification",
            4: "Finds conflicting evidence",
            5: "Resolves conflicting evidence",
          },
          questionIds: [question.id],
        },
      ],
    },
  ],
});
test.before(async () => {
  await tx(async (t) => {
    for (const name of ["author", "reviewer"]) {
      const row = await t.employee.create({
        data: {
          tenant_id: tenant,
          userId: randomInt(10000, 100000000),
          employee_code: (name + randomUUID()).toUpperCase(),
          employeeCategory: "EMPLOYEE",
          first_name: name,
          status: "Active",
          employement_status: "Active",
        },
      });
      if (name === "author") author = row;
      else reviewer = row;
    }
    req = await t.jobRequisition.create({
      data: { tenantId: tenant, title: "Editor", requestedById: author.id },
    });
  });
  await tx(async (t) => {
    const emp = await t.employee.create({
      data: {
        tenant_id: other,
        userId: randomInt(10000, 100000000),
        employee_code: randomUUID().toUpperCase(),
        employeeCategory: "EMPLOYEE",
        first_name: "Other",
        status: "Active",
        employement_status: "Active",
      },
    });
    foreignReq = await t.jobRequisition.create({
      data: { tenantId: other, title: "Private", requestedById: emp.id },
    });
  }, other);
});
test("question drafts enforce actual author, permissions and revision preconditions", async () => {
  question = await as(() => c.questionSave({ question: definition() }));
  assert.equal(question.revision, 0);
  assert.equal(question.createdById, author.id);
  await assert.rejects(
    as(
      () =>
        c.questionSave({
          id: question.id,
          expectedVersion: 0,
          question: definition(),
        }),
      reviewer,
    ),
    (e) => e.status === 403,
  );
  question = await as(() =>
    c.questionSave({
      id: question.id,
      expectedVersion: 0,
      question: {
        ...definition(),
        prompt: "How do you verify a contested factual claim?",
      },
    }),
  );
  assert.equal(question.revision, 1);
  await assert.rejects(
    as(() =>
      c.questionSave({
        id: question.id,
        expectedVersion: 0,
        question: definition(),
      }),
    ),
    (e) => e.status === 412,
  );
  await assert.rejects(
    as(() => c.catalogList("question"), author, []),
    (e) => e.status === 403,
  );
});
test("publication requires a different reviewer and published questions are immutable", async () => {
  await assert.rejects(
    as(() => c.publish("question", { id: question.id, expectedVersion: 1 })),
    (e) => e.status === 403,
  );
  question = await as(
    () => c.publish("question", { id: question.id, expectedVersion: 1 }),
    reviewer,
  );
  await assert.rejects(
    tx((t) =>
      t.interviewQuestion.update({
        where: { id: question.id },
        data: { prompt: "Altered after publication" },
      }),
    ),
    /HR-6006/,
  );
  const copy = await as(() =>
    c.questionSave({
      id: question.id,
      expectedVersion: question.revision,
      question: definition(),
    }),
  );
  assert.equal(copy.version, 2);
  assert.equal(copy.familyId, question.familyId);
  assert.notEqual(copy.id, question.id);
  assert.equal(copy.status, "DRAFT");
});
test("form publication validates linked question ownership, competency and publication", async () => {
  const bad = formDefinition();
  bad.sections[0].criteria[0].competencyKey = "FOREIGN";
  await assert.rejects(
    as(() => c.formCreate({ name: "Invalid", form: bad })),
    /matching/,
  );
  form = await as(() =>
    c.formCreate({ name: "Editor interview", form: formDefinition() }),
  );
  await assert.rejects(
    as(() =>
      c.publish("form", { id: form.id, expectedVersion: form.revision }),
    ),
    (e) => e.status === 403,
  );
  form = await as(
    () => c.publish("form", { id: form.id, expectedVersion: form.revision }),
    reviewer,
  );
  await assert.rejects(
    tx((t) =>
      t.scorecardTemplate.update({
        where: { id: form.id },
        data: { sections: [] },
      }),
    ),
    /HR-6006/,
  );
  await assert.rejects(
    tx((t) => t.scorecardTemplate.delete({ where: { id: form.id } })),
    /HR-6006/,
  );
});
test("form assignments reject foreign targets and replace the active scope without null-key upsert errors", async () => {
  await assert.rejects(
    as(() =>
      c.formLink({
        templateId: form.id,
        scopeType: "REQUISITION",
        scopeId: foreignReq.id,
      }),
    ),
    (e) => e.status === 404,
  );
  const input = {
    templateId: form.id,
    scopeType: "REQUISITION",
    scopeId: req.id,
  };
  const first = await as(() => c.formLink(input));
  const second = await as(() => c.formLink(input));
  assert.equal(first.id, second.id);
  const links = await tx((t) =>
    t.scorecardTemplateLink.findMany({
      where: {
        tenantId: tenant,
        isActive: true,
        scopeType: "REQUISITION",
        scopeId: req.id,
      },
    }),
  );
  assert.equal(links.length, 1);
});
test("scheduled forms retain retired question text and published template versions", async () => {
  await tx(async (t) => {
    const candidate = await t.candidate.create({
      data: {
        tenantId: tenant,
        firstName: "Example",
        email: randomUUID() + "@example.invalid",
      },
    });
    const application = await t.application.create({
      data: {
        tenantId: tenant,
        candidateId: candidate.id,
        jobRequisitionId: req.id,
      },
    });
    const pinned = await pinInterviewAssessment(
      t,
      tenant,
      application.id,
      "ONSITE",
      [{ employeeId: author.id }],
    );
    interview = await t.interview.create({
      data: {
        tenantId: tenant,
        applicationId: application.id,
        interviewType: "ONSITE",
        scheduledAt: new Date(Date.now() + 86400000),
        ...pinned,
        interviewers: { create: { tenantId: tenant, employeeId: author.id } },
      },
    });
  });
  question = await as(
    () =>
      c.retire("question", {
        id: question.id,
        expectedVersion: question.revision,
      }),
    reviewer,
  );
  const view = await as(() => formGet({ interviewId: interview.id }));
  assert.equal(view.questions[0].id, question.id);
  assert.match(view.questions[0].prompt, /contested/);
  assert.equal(view.templateVersion, form.version);
});
test("new form revisions never alter the scheduled snapshot or reuse a retired question", async () => {
  await assert.rejects(
    as(() =>
      c.formUpdate({
        templateId: form.id,
        expectedVersion: form.revision,
        form: formDefinition(),
      }),
    ),
    /matching/,
  );
  const revised = formDefinition();
  revised.sections[0].criteria[0].questionIds = [];
  const draft = await as(() =>
    c.formUpdate({
      templateId: form.id,
      expectedVersion: form.revision,
      form: revised,
    }),
  );
  assert.equal(draft.version, 2);
  assert.equal(draft.familyId, form.familyId);
  assert.equal(draft.status, "DRAFT");
  const pinned = await tx((t) =>
    t.interview.findFirst({ where: { tenantId: tenant, id: interview.id } }),
  );
  assert.equal(pinned.formTemplateId, form.id);
  assert.deepEqual(pinned.formSnapshot.sections[0].criteria[0].questionIds, [
    question.id,
  ]);
});
test("catalog pagination is bounded and company isolation applies to raw metadata reads", async () => {
  const one = await as(() => c.catalogList("question", { limit: 1 }));
  const two = await as(() =>
    c.catalogList("question", { limit: 1, cursor: one.nextCursor }),
  );
  assert.notEqual(one.items[0].id, two.items[0].id);
  const rows = await tx(
    (t) =>
      t.$queryRawUnsafe(
        'SELECT id FROM "InterviewQuestion" WHERE id=$1',
        question.id,
      ),
    other,
  );
  assert.deepEqual(rows, []);
  const foreign = await tx(
    (t) =>
      t.$queryRawUnsafe(
        "SELECT id FROM scorecard_templates WHERE id=$1",
        form.id,
      ),
    other,
  );
  assert.deepEqual(foreign, []);
});
test("training verification rejects self-certification and records an attributed audit", async () => {
  const training =
    await import("../../src/services/candidate-assessment/interviewer-training.js");
  await assert.rejects(
    as(() =>
      training.trainingSet({
        employeeId: author.id,
        trainedAt: new Date().toISOString(),
        reason: "Completed assessed interviewer training",
      }),
    ),
    (e) => e.status === 403,
  );
  const result = await as(() =>
    training.trainingSet({
      employeeId: reviewer.id,
      trainedAt: "2026-01-01T00:00:00Z",
      reason: "Completed assessed interviewer training",
    }),
  );
  assert.equal(result.employeeId, reviewer.id);
  const records = await as(() => training.trainingList({ q: "reviewer" }));
  assert.equal(records.items.length, 1);
  assert.equal(
    records.items[0].trainedAt.toISOString(),
    "2026-01-01T00:00:00.000Z",
  );
  const logs = await tx((t) =>
    t.log.findMany({
      where: {
        tenantId: tenant,
        module: "Interviewer training",
        employeeId: reviewer.id,
      },
    }),
  );
  assert.equal(logs.at(-1).actionById, author.id);
  await assert.rejects(
    as(() =>
      training.trainingSet({
        employeeId: reviewer.id,
        trainedAt: "2099-01-01T00:00:00Z",
        reason: "Invalid future completion date",
      }),
    ),
    /past date/,
  );
});
test("training revocation prevents new assignments to qualification-required forms", async () => {
  const training =
    await import("../../src/services/candidate-assessment/interviewer-training.js");
  const definition = formDefinition();
  definition.sections[0].criteria[0].questionIds = [];
  definition.requiresTraining = true;
  let trainedForm = await as(() =>
    c.formCreate({ name: "Qualified panel", form: definition }),
  );
  trainedForm = await as(
    () => c.publish("form", { id: trainedForm.id, expectedVersion: 0 }),
    reviewer,
  );
  await as(() =>
    c.formLink({
      templateId: trainedForm.id,
      scopeType: "REQUISITION",
      scopeId: req.id,
    }),
  );
  const pinned = await tx((t) =>
    pinInterviewAssessment(t, tenant, interview.applicationId, "ONSITE", [
      { employeeId: reviewer.id },
    ]),
  );
  assert.equal(pinned.formTemplateId, trainedForm.id);
  await as(() =>
    training.trainingSet({
      employeeId: reviewer.id,
      trainedAt: null,
      reason: "Qualification expired pending refresher training",
    }),
  );
  await assert.rejects(
    tx((t) =>
      pinInterviewAssessment(t, tenant, interview.applicationId, "ONSITE", [
        { employeeId: reviewer.id },
      ]),
    ),
    /training/,
  );
});
test("calibration compares peers for the same round and excludes unqualified viewers", async () => {
  const { raterCalibration } =
    await import("../../src/services/candidate-assessment/forms.js");
  await tx(async (t) => {
    await t.interviewInterviewer.create({
      data: {
        tenantId: tenant,
        interviewId: interview.id,
        employeeId: reviewer.id,
      },
    });
    for (const [who, score] of [
      [author, 60],
      [reviewer, 80],
    ])
      await t.interviewScorecard.create({
        data: {
          tenantId: tenant,
          interviewId: interview.id,
          reviewerId: who.id,
          templateVersion: interview.formTemplateVersion,
          scores: { accuracy: score / 20 },
          weightedScore: score,
          criterionScores: [
            {
              key: "accuracy",
              rating: score / 20,
              evidence: "Observed work sample",
            },
          ],
          coiDeclared: true,
          recommendation: "HIRE",
          status: "SUBMITTED",
          startedAt: new Date(Date.now() - 600000),
          submittedAt: new Date(),
        },
      });
  });
  const report = await as(() => raterCalibration());
  const row = report.items.find((r) => r.reviewerId === author.id);
  assert.equal(row.meanDifferenceFromPanel, -20);
  assert.equal(row.meanAbsolutePanelDifference, 20);
  assert.equal(row.peerComparisonCount, 1);
  assert.equal(row.lowSample, true);
  assert.ok(row.meanCompletionMinutes >= 10);
  await assert.rejects(
    mcpCtx.run(
      {
        actorVerified: true,
        user: { tenantId: tenant, userId: author.userId, roles: ["RECRUITER"] },
        permissions: grants,
      },
      () => raterCalibration(),
    ),
    (e) => e.status === 403,
  );
});
test("required and preferred role skills are pinned once, isolated and assigned to the technical panel", async () => {
  const base = formDefinition();
  base.sections[0].criteria[0].questionIds = [];
  let template = await as(() =>
    c.formCreate({ name: "Role skill fixture", form: base }),
  );
  template = await as(
    () =>
      c.publish("form", {
        id: template.id,
        expectedVersion: template.revision,
      }),
    reviewer,
  );
  await as(() =>
    c.formLink({
      templateId: template.id,
      scopeType: "REQUISITION",
      scopeId: req.id,
    }),
  );
  const names = [
    "Required skill " + randomUUID(),
    "Preferred skill " + randomUUID(),
    "Foreign skill " + randomUUID(),
  ];
  await tx(async (t) => {
    for (const name of names.slice(0, 2))
      await t.skill.create({ data: { name, tenantId: tenant } });
    await t.jobRequisition.update({
      where: { id: req.id },
      data: {
        version: { increment: 1 },
        jobContent: {
          skills: [
            { name: names[0], importance: "required" },
            { name: names[1], importance: "preferred" },
            { name: names[2], importance: "required" },
          ],
        },
      },
    });
  });
  await tx(async (t) => {
    await t.skill.create({ data: { name: names[2], tenantId: other } });
  }, other);
  const panels = [
    { employeeId: author.id, panelRole: "TECHNICAL" },
    { employeeId: reviewer.id, panelRole: "HR" },
  ];
  const pinned = await tx((t) =>
    pinInterviewAssessment(
      t,
      tenant,
      interview.applicationId,
      "ONSITE",
      panels,
    ),
  );
  const criteria = pinned.formSnapshot.sections.at(-1).criteria;
  assert.equal(criteria.length, 2);
  assert.equal(criteria[0].required, true);
  assert.equal(criteria[1].required, false);
  assert.deepEqual(pinned.formSnapshot.generation.unmappedSkills, [names[2]]);
  const saved = await tx((t) =>
    t.interview.create({
      data: {
        tenantId: tenant,
        applicationId: interview.applicationId,
        interviewType: "ONSITE",
        scheduledAt: new Date(),
        ...pinned,
        interviewers: {
          create: panels.map((p) => ({ ...p, tenantId: tenant })),
        },
      },
    }),
  );
  await tx((t) =>
    t.jobRequisition.update({
      where: { id: req.id },
      data: { version: { increment: 1 }, jobContent: { skills: [] } },
    }),
  );
  const authorView = await as(() => formGet({ interviewId: saved.id }));
  assert.equal(authorView.sections.at(-1).criteria.length, 2);
  assert.equal(authorView.generation.requisitionVersion, 1);
  const hrView = await as(() => formGet({ interviewId: saved.id }), reviewer);
  assert.equal(hrView.sections.length, 1);
  const next = await tx((t) =>
    pinInterviewAssessment(
      t,
      tenant,
      interview.applicationId,
      "ONSITE",
      panels,
    ),
  );
  assert.equal(next.formSnapshot.sections.length, 1);
});
test.after(async () => {
  await db.$disconnect();
});
