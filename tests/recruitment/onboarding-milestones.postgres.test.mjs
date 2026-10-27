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
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
process.env.HR_ONBOARDING_AUTOMATION = "on";
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const { runOnboardingAutomation } =
  await import("../../src/services/onboardingAutomation.service.js");
const { getOnboardingPortal, submitPortalMilestone } =
  await import("../../src/services/onboardingPortalScreen.service.js");
const { submitSurvey } =
  await import("../../src/services/onboarding.service.js");
const { ONBOARDING_FEEDBACK_QUESTIONS } =
  await import("../../src/lib/onboardingTaxonomy.js");
const { userIdToUuid } = await import("@trusoft/contracts/identity");
const tenant = randomUUID(),
  foreign = randomUUID(),
  people = {};
const now = new Date("2030-03-01T00:00:00Z");
let checklist, prejoining, otherChecklist, task;
const tx = (fn, t = tenant) =>
  mcpCtx.run({ user: { tenantId: t } }, () =>
    tenantTransaction(db, fn, {
      tenantId: t,
      txOptions: { timeout: 30000, maxWait: 10000 },
    }),
  );
const ctx = (who = "self", permissions = ["hr.self.read"]) => ({
  actorVerified: true,
  user: {
    tenantId: tenant,
    userId: people[who].userId,
    employeeId: people.hr.id,
    roles: [
      who === "hr" ? "HR_ADMIN" : who === "manager" ? "MANAGER" : "EMPLOYEE",
    ],
  },
  permissions,
});
const as = (fn, who, permissions) => mcpCtx.run(ctx(who, permissions), fn);
const work = () =>
  mcpCtx.run({ system: true }, () =>
    runOnboardingAutomation({ tenantId: tenant, now }),
  );
const answers = ONBOARDING_FEEDBACK_QUESTIONS.map((q) => ({
  questionId: q.id,
  answer: q.options[0],
}));
test.before(async () => {
  test.mock.timers.enable({ apis: ["Date"], now });
  await tx(async (t) => {
    for (const name of ["self", "newHire", "hr", "manager"])
      people[name] = await t.employee.create({
        data: {
          tenant_id: tenant,
          employee_code: "OM-" + randomUUID().toUpperCase(),
          userId: randomInt(10000, 1000000000),
          employeeCategory: "EMPLOYEE",
          first_name: name,
          status: "Active",
          employement_status: "Active",
        },
      });
    await t.employee.update({
      where: { id: people.newHire.id },
      data: { managerId: people.manager.id },
    });
    checklist = await t.onboardingChecklist.create({
      data: {
        tenantId: tenant,
        employeeId: people.self.id,
        startDate: new Date("2030-01-30T00:00:00Z"),
      },
    });
    prejoining = await t.onboardingChecklist.create({
      data: {
        tenantId: tenant,
        employeeId: people.newHire.id,
        startDate: new Date("2030-03-03T00:00:00Z"),
      },
    });
    task = await t.onboardingTask.create({
      data: {
        tenantId: tenant,
        checklistId: prejoining.id,
        title: "Verify documents",
        category: "HR_DOCUMENTATION",
        stage: "pre_joining",
        assigneeType: "HR",
      },
    });
    const r = await t.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Fictional role",
        requestedById: people.manager.id,
        recruiterId: people.hr.id,
      },
    });
    const c = await t.candidate.create({
      data: {
        tenantId: tenant,
        firstName: "Fictional",
        email: randomUUID() + "@example.invalid",
      },
    });
    const a = await t.application.create({
      data: { tenantId: tenant, candidateId: c.id, jobRequisitionId: r.id },
    });
    const o = await t.offer.create({
      data: {
        tenantId: tenant,
        applicationId: a.id,
        candidateId: c.id,
        jobRequisitionId: r.id,
        salary: 1,
      },
    });
    await t.offerHandoff.create({
      data: {
        tenantId: tenant,
        offerId: o.id,
        checklistId: prejoining.id,
        employeeId: people.newHire.id,
        status: "COMPLETED",
      },
    });
  });
  await tx(async (t) => {
    const p = await t.employee.create({
      data: {
        tenant_id: foreign,
        employee_code: "OM-" + randomUUID().toUpperCase(),
        employeeCategory: "EMPLOYEE",
        first_name: "Foreign",
      },
    });
    otherChecklist = await t.onboardingChecklist.create({
      data: {
        tenantId: foreign,
        employeeId: p.id,
        startDate: new Date("2030-01-01"),
      },
    });
  }, foreign);
});
test("staff cannot invoke the scheduler and flag off performs no writes", async () => {
  await assert.rejects(
    as(() => runOnboardingAutomation({ tenantId: tenant, now })),
    (e) => e.status === 403,
  );
  process.env.HR_ONBOARDING_AUTOMATION = "off";
  assert.equal((await work()).skipped, true);
  process.env.HR_ONBOARDING_AUTOMATION = "on";
});
test("concurrent sweeps create one due survey and exactly three routed notices", async () => {
  const results = await Promise.all([work(), work()]);
  assert.equal(
    results.reduce((n, r) => n + r.surveysCreated, 0),
    1,
  );
  assert.equal(
    results.reduce((n, r) => n + r.enqueued, 0),
    3,
  );
  const surveys = await tx((t) =>
    t.onboardingSurvey.findMany({ where: { tenantId: tenant } }),
  );
  assert.equal(surveys.length, 1);
  assert.equal(surveys[0].type, "DAY_30");
  assert.equal(surveys[0].employeeId, people.self.id);
  assert.equal(surveys[0].submittedAt, null);
});
test("readiness alerts reach the recruiter and manager, surveys reach only the new hire", async () => {
  const events = await tx((t) =>
    t.outboxEvent.findMany({
      where: { tenantId: tenant, eventName: "hr.onboarding.action_due.v1" },
    }),
  );
  const ready = events.filter((e) => e.payload.payload.kind === "READINESS");
  assert.equal(ready.length, 2);
  assert.deepEqual(
    ready.flatMap((e) => e.payload.payload.recipientUserIds).sort(),
    [
      userIdToUuid(tenant, people.hr.userId),
      userIdToUuid(tenant, people.manager.userId),
    ].sort(),
  );
  assert.equal(
    events.find((e) => e.payload.payload.kind === "DAY_30").payload.payload
      .recipientUserIds[0],
    userIdToUuid(tenant, people.self.userId),
  );
  assert.ok(
    events.every((e) => !JSON.stringify(e.payload.payload).includes("@")),
  );
});
test("portal exposes exact due dates and only permits a due owned survey", async () => {
  const p = await as(() => getOnboardingPortal({ tenantId: tenant }));
  assert.equal(p.employee.id, people.self.id);
  assert.equal(p.milestones.items[0].canSubmit, true);
  assert.equal(+p.milestones.items[0].dueAt, +now);
  assert.equal(p.milestones.items[1].canSubmit, false);
  await assert.rejects(
    as(() =>
      submitPortalMilestone({
        tenantId: tenant,
        checklistId: checklist.id,
        type: "DAY_60",
        answers,
      }),
    ),
    (e) => e.statusCode === 409,
  );
  await assert.rejects(
    as(() =>
      submitPortalMilestone({
        tenantId: tenant,
        checklistId: prejoining.id,
        type: "DAY_30",
        answers,
      }),
    ),
    (e) => e.statusCode === 404,
  );
  await assert.rejects(
    as(() =>
      submitPortalMilestone({
        tenantId: tenant,
        checklistId: otherChecklist.id,
        type: "DAY_30",
        answers,
      }),
    ),
    (e) => e.statusCode === 404,
  );
});
test("survey requires complete canonical answers and HR cannot impersonate a new hire", async () => {
  await assert.rejects(
    as(() =>
      submitPortalMilestone({
        tenantId: tenant,
        checklistId: checklist.id,
        type: "DAY_30",
        answers: answers.slice(1),
      }),
    ),
    (e) => e.status === 422,
  );
  await assert.rejects(
    as(
      () =>
        submitPortalMilestone({
          tenantId: tenant,
          checklistId: checklist.id,
          type: "DAY_30",
          answers,
        }),
      "hr",
      ["hr.onboarding.create"],
    ),
    (e) => e.statusCode === 404,
  );
});
test("submission replays are idempotent and the old adapter enforces the same ownership", async () => {
  const input = {
    tenantId: tenant,
    checklistId: checklist.id,
    type: "DAY_30",
    answers,
    comments: "Useful onboarding",
  };
  const a = await as(() => submitPortalMilestone(input)),
    b = await as(() => submitPortalMilestone(input));
  assert.equal(a.id, b.id);
  assert.equal(+a.submittedAt, +b.submittedAt);
  const events = await tx((t) =>
    t.outboxEvent.findMany({
      where: {
        tenantId: tenant,
        eventName: "hr.onboarding.survey_submitted.v1",
      },
    }),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.payload.employeeId, String(people.self.id));
  assert.ok(!JSON.stringify(events[0].payload).includes("Useful onboarding"));
  await assert.rejects(
    as(() =>
      submitSurvey({
        tenantId: tenant,
        employeeId: people.newHire.id,
        surveyType: "30_DAY",
        responses: { answers },
      }),
    ),
    (e) => e.statusCode === 404,
  );
  assert.equal((await work()).enqueued, 0);
});
test("completed readiness tasks suppress a later start-date revision notice", async () => {
  await tx(async (t) => {
    await t.onboardingTask.update({
      where: { id: task.id },
      data: { completed: true },
    });
    await t.onboardingChecklist.update({
      where: { id: prejoining.id },
      data: { startDate: new Date("2030-03-02T00:00:00Z") },
    });
  });
  assert.equal((await work()).enqueued, 0);
});
test("notice ledger is isolated by forced RLS", async () => {
  const rows = await tx(
    (t) =>
      t.$queryRawUnsafe(
        'SELECT id FROM "OnboardingNotice" WHERE "tenantId"=$1::uuid',
        tenant,
      ),
    foreign,
  );
  assert.equal(rows.length, 0);
});

const {
  getOnboardingDashboard,
  getOnboardingExportRows,
  getQuickProgress,
  addNewHire,
} = await import("../../src/services/onboardingDashboard.service.js");
test("dashboard uses whole scoped cohorts and database paging with genuine due denominators", async () => {
  const report = await as(
    () =>
      getOnboardingDashboard({ pageSize: 1, page: 2, order: "asc" }, tenant),
    "hr",
    ["hr.onboarding.read"],
  );
  assert.equal(report.total, 2);
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0].id, prejoining.id);
  assert.equal(report.summary.total, 2);
  const jan = report.cohorts.find((c) => c.cohort === "2030-01");
  assert.equal(jan.total, 1);
  assert.equal(jan.surveys[0].due, 1);
  assert.equal(jan.surveys[0].submitted, 1);
  assert.equal(jan.surveys[0].completionRatePct, 100);
  assert.equal(jan.surveys[1].completionRatePct, null);
  assert.equal(
    report.cohorts.find((c) => c.cohort === "2030-03").surveys[0].due,
    0,
  );
  const filtered = await as(
    () =>
      getOnboardingDashboard(
        { startFrom: "2030-03-01", startTo: "2030-03-31" },
        tenant,
      ),
    "hr",
    ["hr.onboarding.read"],
  );
  assert.equal(filtered.total, 1);
  assert.equal(filtered.cohorts.length, 1);
  assert.equal(filtered.cohorts[0].cohort, "2030-03");
});
test("manager dashboard and export use verified employee ownership and separate export grants", async () => {
  const r = await as(() => getOnboardingDashboard({}, tenant), "manager", [
    "hr.onboarding.read",
  ]);
  assert.deepEqual(
    r.items.map((i) => i.id),
    [prejoining.id],
  );
  await assert.rejects(
    as(() => getQuickProgress(checklist.id, tenant), "manager", [
      "hr.onboarding.read",
    ]),
    (e) => e.statusCode === 404,
  );
  await assert.rejects(
    as(() => getOnboardingExportRows({}, tenant), "manager", [
      "hr.onboarding.read",
    ]),
    (e) => e.status === 403,
  );
  const rows = await as(() => getOnboardingExportRows({}, tenant), "manager", [
    "hr.onboarding.export",
  ]);
  assert.deepEqual(
    rows.map((r) => r.id),
    [prejoining.id],
  );
  await assert.rejects(
    as(() => getOnboardingDashboard({}, tenant), "self", [
      "hr.onboarding.read",
    ]),
    (e) => e.statusCode === 403,
  );
  await assert.rejects(
    as(() => getOnboardingDashboard({}, foreign), "hr", ["hr.onboarding.read"]),
    (e) => e.statusCode === 401,
  );
});
test("dashboard rejects invalid dates and pages without widening filters", async () => {
  for (const query of [
    { startFrom: "2030-02-30" },
    { startTo: "tomorrow" },
    { startFrom: "2030-02-01", startTo: "2030-01-01" },
    { status: "NEW" },
    { pageSize: 101 },
  ])
    await assert.rejects(
      as(() => getOnboardingDashboard(query, tenant), "hr", [
        "hr.onboarding.read",
      ]),
      (e) => e.statusCode === 422,
    );
});
test("manual onboarding is atomic, tenant-bound and unique by employee and start date", async () => {
  const input = {
    employeeId: people.hr.id,
    startDate: "2030-03-05",
    buddyId: people.manager.id,
  };
  const results = await Promise.allSettled([
    as(() => addNewHire(input, tenant), "hr", ["hr.onboarding.create"]),
    as(() => addNewHire(input, tenant), "hr", ["hr.onboarding.create"]),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.find((r) => r.status === "rejected").reason.statusCode,
    409,
  );
  const result = results.find((r) => r.status === "fulfilled").value;
  assert.equal(result.tasksCreated, 12);
  const row = await tx((t) =>
    t.onboardingChecklist.findFirst({
      where: { tenantId: tenant, id: result.id },
      include: { tasks: true, buddy: true },
    }),
  );
  assert.equal(row.buddy.buddyId, people.manager.id);
  assert.equal(row.tasks.length, 12);
  assert.ok(row.tasks.every((t) => t.tenantId === tenant));
  assert.equal(
    await tx((t) =>
      t.outboxEvent.count({
        where: {
          tenantId: tenant,
          eventName: "hr.onboarding.checklist_created.v1",
        },
      }),
    ),
    1,
  );
  await assert.rejects(
    as(
      () =>
        addNewHire({ ...input, employeeId: otherChecklist.employeeId }, tenant),
      "hr",
      ["hr.onboarding.create"],
    ),
    (e) => e.statusCode === 404,
  );
  await assert.rejects(
    as(
      () =>
        addNewHire(
          {
            ...input,
            startDate: "2030-04-05",
            buddyId: otherChecklist.employeeId,
          },
          tenant,
        ),
      "hr",
      ["hr.onboarding.create"],
    ),
    (e) => e.statusCode === 404,
  );
  await assert.rejects(
    as(
      () =>
        addNewHire(
          { ...input, startDate: "2030-04-05", templateId: 99999999 },
          tenant,
        ),
      "hr",
      ["hr.onboarding.create"],
    ),
    (e) => e.statusCode === 404,
  );
  assert.equal(
    await tx((t) =>
      t.onboardingChecklist.count({
        where: { tenantId: tenant, employeeId: people.hr.id },
      }),
    ),
    1,
  );
});

const { submitFeedback: legacyFeedback } =
  await import("../../src/services/onboardingPortal.service.js");
test("legacy general feedback cannot overwrite or impersonate a milestone survey", async () => {
  await assert.rejects(
    as(() =>
      legacyFeedback(
        { checklistId: checklist.id, ratings: { roleClarity: 5 } },
        tenant,
      ),
    ),
    (e) => e.status === 400,
  );
  await assert.rejects(
    as(
      () => legacyFeedback({ checklistId: checklist.id, answers }, tenant),
      "hr",
      ["hr.onboarding.create"],
    ),
    (e) => e.statusCode === 404,
  );
  const saved = await as(() =>
    legacyFeedback(
      { checklistId: checklist.id, answers, comments: "General feedback" },
      tenant,
    ),
  );
  assert.equal(saved.checklistId, checklist.id);
  const milestone = await tx((t) =>
    t.onboardingSurvey.findFirst({
      where: { tenantId: tenant, checklistId: checklist.id, type: "DAY_30" },
    }),
  );
  assert.equal(milestone.responses.comments, "Useful onboarding");
  assert.notEqual(milestone.responses.comments, "General feedback");
});

const { getOnboardingDetail, createOnboardingTask, sendOnboardingReminder } =
  await import("../../src/services/onboardingDetail.service.js");
const {
  getPreboarding,
  updatePreboarding,
  addNote,
  listActivity,
  viewFeedback,
} = await import("../../src/services/onboardingPortal.service.js");
const {
  listSchedule,
  createSession,
  updateSession,
  listDocuments,
  addDocument,
} = await import("../../src/services/onboardingSchedule.service.js");
const hrRead = (fn) => as(fn, "hr", ["hr.onboarding.read"]);
const hrWrite = (fn) =>
  as(fn, "hr", ["hr.onboarding.create", "hr.onboarding.update"]);
test("detail tabs deny unrelated managers and foreign companies consistently", async () => {
  for (const fn of [
    getOnboardingDetail,
    getPreboarding,
    listSchedule,
    listDocuments,
    listActivity,
    viewFeedback,
  ]) {
    await assert.rejects(
      as(() => fn(checklist.id, tenant), "manager", ["hr.onboarding.read"]),
      (e) => e.statusCode === 404,
    );
    await assert.rejects(
      hrRead(() => fn(otherChecklist.id, tenant)),
      (e) => e.statusCode === 404,
    );
    await as(() => fn(prejoining.id, tenant), "manager", [
      "hr.onboarding.read",
    ]);
  }
  const detail = await hrRead(() => getOnboardingDetail(prejoining.id, tenant));
  assert.equal(detail.employeeId, people.newHire.id);
  assert.equal(detail.checklist.pre_joining[0].id, task.id);
  await assert.rejects(
    as(() => getOnboardingDetail(prejoining.id, tenant), "self", [
      "hr.onboarding.read",
    ]),
    (e) => e.statusCode === 403,
  );
});
test("notes serialize concurrent writers, use verified actors and replay without duplication", async () => {
  const inputs = ["First note", "Second note"].map((text) => ({
    checklistId: checklist.id,
    text,
    actor: "spoofed",
    idempotencyKey: randomUUID(),
  }));
  await Promise.all(inputs.map((i) => hrWrite(() => addNote(i, tenant))));
  await hrWrite(() => addNote(inputs[0], tenant));
  const data = await hrRead(() => listActivity(checklist.id, tenant));
  assert.equal(data.entries.length, 2);
  assert.ok(
    data.entries.every(
      (e) => e.actor === String(people.hr.id) && !e.requestKey,
    ),
  );
  await assert.rejects(
    hrWrite(() => addNote({ ...inputs[0], text: "Different" }, tenant)),
    (e) => e.statusCode === 409,
  );
  const payloads = await tx((t) =>
    t.outboxEvent.findMany({
      where: {
        tenantId: tenant,
        eventName: "hr.onboarding.checklist_changed.v1",
      },
    }),
  );
  assert.ok(
    payloads.every((e) => !JSON.stringify(e.payload).includes("First note")),
  );
});
test("feedback read separates general and timed submissions and rejects manager impersonation", async () => {
  const r = await hrRead(() => viewFeedback(checklist.id, tenant));
  assert.deepEqual(r.submissions.map((s) => s.type).sort(), [
    "DAY_30",
    "GENERAL",
  ]);
  assert.equal(r.submissions[0].answers.length, 7);
  assert.equal(r.submissions[0].comments, "General feedback");
  await assert.rejects(
    as(
      () =>
        updatePreboarding(
          {
            id: prejoining.id,
            group: "workspace",
            key: "laptopAssigned",
            value: true,
          },
          tenant,
        ),
      "manager",
      ["hr.onboarding.update"],
    ),
    (e) => e.statusCode === 403,
  );
  await assert.rejects(
    hrWrite(() =>
      updatePreboarding(
        {
          id: checklist.id,
          preboarding: { workspace: { laptopAssigned: "true" } },
        },
        tenant,
      ),
    ),
    (e) => e.status === 400,
  );
  await Promise.all(
    ["laptopAssigned", "deskAllocated"].map((key) =>
      hrWrite(() =>
        updatePreboarding(
          { id: checklist.id, group: "workspace", key, value: true },
          tenant,
        ),
      ),
    ),
  );
  const board = await hrRead(() => getPreboarding(checklist.id, tenant));
  assert.equal(board.preboarding.workspace.laptopAssigned, true);
  assert.equal(board.preboarding.workspace.deskAllocated, true);
  assert.equal(board.readyToCollect, false);
});
test("task creation validates company assignees, dates and preserves responsibility", async () => {
  const input = {
    checklistId: checklist.id,
    title: "Collect equipment",
    stage: "equipment",
    category: "WORKSPACE_EQUIPMENT",
    assigneeType: "NEW_HIRE",
    assigneeId: people.self.id,
    startDate: "2030-03-02",
  };
  await assert.rejects(
    hrWrite(() =>
      createOnboardingTask(
        { ...input, assigneeId: otherChecklist.employeeId },
        tenant,
      ),
    ),
    (e) => e.statusCode === 404,
  );
  await assert.rejects(
    hrWrite(() =>
      createOnboardingTask({ ...input, startDate: "2030-02-30" }, tenant),
    ),
    (e) => e.statusCode === 422,
  );
  const created = await hrWrite(() => createOnboardingTask(input, tenant));
  assert.equal(created.assigneeType, "NEW_HIRE");
  assert.equal(created.responsible.id, people.self.id);
});
test("reminders queue one in-app event across concurrent retries and fail for unlinked accounts", async () => {
  const input = { checklistId: checklist.id, idempotencyKey: randomUUID() };
  const r = await Promise.all([
    hrWrite(() => sendOnboardingReminder(input, tenant)),
    hrWrite(() => sendOnboardingReminder(input, tenant)),
  ]);
  assert.deepEqual(r[0], r[1]);
  assert.equal(r[0].channel, "in_app");
  const events = await tx((t) =>
    t.outboxEvent.findMany({
      where: {
        tenantId: tenant,
        eventName: "hr.onboarding.reminder_requested.v1",
      },
    }),
  );
  assert.equal(events.length, 1);
  assert.equal(
    events[0].payload.payload.recipientUserId,
    userIdToUuid(tenant, people.self.userId),
  );
  await assert.rejects(
    hrWrite(() =>
      sendOnboardingReminder(
        {
          ...input,
          idempotencyKey: randomUUID(),
          sendTo: "other@example.invalid",
        },
        tenant,
      ),
    ),
    (e) => e.statusCode === 422,
  );
  await tx((t) =>
    t.employee.update({
      where: { id: people.self.id },
      data: { userId: null },
    }),
  );
  await assert.rejects(
    hrWrite(() =>
      sendOnboardingReminder(
        { ...input, idempotencyKey: randomUUID() },
        tenant,
      ),
    ),
    (e) => e.statusCode === 409,
  );
  await tx((t) =>
    t.employee.update({
      where: { id: people.self.id },
      data: { userId: people.self.userId },
    }),
  );
});
test("sessions reject invalid times and foreign owners and document records match their employee", async () => {
  const input = {
    checklistId: checklist.id,
    title: "Orientation",
    sessionDate: "2030-03-02",
    fromTime: "09:00",
    toTime: "10:00",
    sessionType: "orientation",
    assigneeId: people.manager.id,
  };
  for (const patch of [
    { fromTime: "25:00" },
    { toTime: "08:00" },
    { sessionDate: "2030-02-30" },
  ])
    await assert.rejects(
      hrWrite(() => createSession({ ...input, ...patch }, tenant)),
      (e) => e.status === 400,
    );
  await assert.rejects(
    hrWrite(() =>
      createSession(
        { ...input, assigneeId: otherChecklist.employeeId },
        tenant,
      ),
    ),
    (e) => e.status === 404,
  );
  const row = await hrWrite(() => createSession(input, tenant));
  await hrWrite(() =>
    updateSession(
      row.id,
      { location: "Training room", assigneeId: null },
      tenant,
    ),
  );
  const sessions = await hrRead(() => listSchedule(checklist.id, tenant));
  assert.equal(sessions[0].location, "Training room");
  assert.equal(sessions[0].assigneeId, null);
  await assert.rejects(
    hrWrite(() =>
      addDocument(
        {
          checklistId: checklist.id,
          employeeId: people.newHire.id,
          title: "Wrong owner",
          mediaId: 1,
        },
        tenant,
      ),
    ),
    (e) => e.status === 404,
  );
});
const legacy = await import("../../src/services/onboarding.service.js");
const { listOnboarding } =
  await import("../../src/services/onboardingMgmt.service.js");
test("legacy checklist resources enforce verified manager scope and deny absent actor context", async () => {
  const r = await as(
    () => legacy.listChecklists({ tenantId: tenant }),
    "manager",
    ["hr.onboarding.read"],
  );
  assert.ok(r.items.every((c) => c.employeeId === people.newHire.id));
  const m = await as(() => listOnboarding({}, tenant), "manager", [
    "hr.onboarding.read",
  ]);
  assert.ok(m.items.every((c) => c.employeeId === people.newHire.id));
  await assert.rejects(
    as(() => legacy.getChecklist(checklist.id, tenant), "manager", [
      "hr.onboarding.read",
    ]),
    (e) => e.statusCode === 404,
  );
  await assert.rejects(
    legacy.listChecklists({ tenantId: tenant }),
    (e) => e.statusCode === 401,
  );
  await assert.rejects(
    hrRead(() => legacy.getChecklist(otherChecklist.id, tenant)),
    (e) => e.statusCode === 404,
  );
});
test("legacy task writes cannot reparent tasks or use unchecked company assignees", async () => {
  await assert.rejects(
    hrWrite(() =>
      legacy.addTask({
        tenantId: tenant,
        checklistId: otherChecklist.id,
        title: "Foreign",
      }),
    ),
    (e) => e.statusCode === 404,
  );
  await assert.rejects(
    hrWrite(() =>
      legacy.updateTask(
        task.id,
        { tenantId: foreign, checklistId: otherChecklist.id },
        tenant,
      ),
    ),
    (e) => e.statusCode === 422,
  );
  await assert.rejects(
    hrWrite(() =>
      legacy.updateTask(
        task.id,
        { assigneeId: otherChecklist.employeeId },
        tenant,
      ),
    ),
    (e) => e.statusCode === 404,
  );
  const created = await hrWrite(() =>
    legacy.addTask({
      tenantId: tenant,
      checklistId: checklist.id,
      title: "New hire task",
      assigneeType: "NEW_HIRE",
      assigneeId: people.self.id,
    }),
  );
  const saved = await hrWrite(() =>
    legacy.updateTask(
      created.id,
      { status: "COMPLETED", notes: "Reviewed" },
      tenant,
    ),
  );
  assert.equal(saved.completed, true);
  assert.equal(saved.responsible.id, people.self.id);
  await assert.rejects(
    hrWrite(() =>
      legacy.updateTask(created.id, { completed: "false" }, tenant),
    ),
    (e) => e.statusCode === 422,
  );
  await as(() => legacy.deleteTask(created.id, tenant), "hr", [
    "hr.onboarding.delete",
  ]);
});
test("legacy checklist updates reject mass assignment and unfinished completion", async () => {
  await assert.rejects(
    hrWrite(() =>
      legacy.updateChecklist(
        checklist.id,
        { employeeId: people.hr.id },
        tenant,
      ),
    ),
    (e) => e.statusCode === 422,
  );
  await assert.rejects(
    hrWrite(() =>
      legacy.updateChecklist(checklist.id, { status: "COMPLETED" }, tenant),
    ),
    (e) => e.statusCode === 409,
  );
  await assert.rejects(
    hrWrite(() =>
      legacy.assignBuddy({
        tenantId: tenant,
        checklistId: checklist.id,
        buddyId: otherChecklist.employeeId,
      }),
    ),
    (e) => e.statusCode === 404,
  );
  const buddy = await hrWrite(() =>
    legacy.assignBuddy({
      tenantId: tenant,
      checklistId: checklist.id,
      buddyId: people.manager.id,
    }),
  );
  assert.equal(buddy.buddy.id, people.manager.id);
});
test("manual signature endpoints cannot manufacture a verified signing result", async () => {
  const doc = await tx((t) =>
    t.onboardingDocument.create({
      data: {
        tenantId: tenant,
        checklistId: checklist.id,
        employeeId: people.self.id,
        title: "Fixture signature required",
        mediaId: 1,
        requiresSign: true,
      },
    }),
  );
  await assert.rejects(
    hrWrite(() =>
      legacy.signDocument(doc.id, {
        tenantId: tenant,
        signedBy: people.self.id,
      }),
    ),
    (e) => e.statusCode === 409,
  );
  const stored = await tx((t) =>
    t.onboardingDocument.findFirst({ where: { id: doc.id, tenantId: tenant } }),
  );
  assert.equal(stored.signedAt, null);
  assert.equal(stored.signedByEmpId, null);
});
test("legacy controller uses the verified company and materializes the actual default template", async () => {
  const { runController } =
    await import("../../src/mcp/controllers/_runner.js");
  const controller =
    await import("../../src/controllers/onboarding.controller.js");
  const created = await as(
    () =>
      runController(controller.createChecklist, {
        user: ctx("hr").user,
        body: {
          tenantId: foreign,
          employeeId: people.hr.id,
          startDate: "2030-03-10",
        },
        headers: { "x-employee-id": String(people.self.id) },
      }),
    "hr",
    ["hr.onboarding.create"],
  );
  assert.equal(created.data.tasksCreated, 12);
  const row = await tx((t) =>
    t.onboardingChecklist.findFirst({
      where: { id: created.data.id, tenantId: tenant },
      include: { tasks: true },
    }),
  );
  assert.equal(row.employeeId, people.hr.id);
  assert.equal(row.tasks.length, 12);
  assert.ok(row.tasks.every((t) => t.tenantId === tenant));
  await assert.rejects(
    as(
      () =>
        runController(controller.updateChecklist, {
          user: ctx("hr").user,
          params: { id: row.id },
          body: { employeeId: people.self.id },
        }),
      "hr",
      ["hr.onboarding.update"],
    ),
    (e) => e.status === 422 || e.statusCode === 422,
  );
});
test("legacy foreign relations and mismatched feedback cannot leak through the employee portal", async () => {
  const { getFeedbackQuestions, submitPortalFeedback } =
    await import("../../src/services/onboardingPortalScreen.service.js");
  await tx(async (t) => {
    await t.employee.update({
      where: { id: people.newHire.id },
      data: { managerId: otherChecklist.employeeId },
    });
    await t.onboardingTask.update({
      where: { id: task.id },
      data: { assigneeId: otherChecklist.employeeId },
    });
    await t.onboardingBuddy.create({
      data: {
        tenantId: tenant,
        checklistId: prejoining.id,
        buddyId: otherChecklist.employeeId,
      },
    });
    await t.onboardingFeedback.create({
      data: {
        tenantId: tenant,
        checklistId: prejoining.id,
        employeeId: people.self.id,
        responses: answers,
        comments: "Unrelated private feedback",
      },
    });
  });
  const p = await as(
    () => getOnboardingPortal({ tenantId: tenant, checklistId: prejoining.id }),
    "newHire",
  );
  assert.equal(p.manager, null);
  assert.equal(p.buddy, null);
  assert.equal(p.tasks[0].responsible, null);
  assert.equal(p.feedbackSubmitted, false);
  const q = await as(
    () =>
      getFeedbackQuestions({ tenantId: tenant, checklistId: prejoining.id }),
    "newHire",
  );
  assert.equal(q.responses, null);
  assert.equal(q.comments, null);
  await assert.rejects(
    as(
      () =>
        submitPortalFeedback({
          tenantId: tenant,
          checklistId: prejoining.id,
          answers,
        }),
      "newHire",
    ),
    (e) => e.statusCode === 409,
  );
});
test.after(async () => {
  for (const company of [tenant, foreign])
    await tx(async (t) => {
      await t.offerHandoff.deleteMany({ where: { tenantId: company } });
      await t.offer.deleteMany({ where: { tenantId: company } });
      await t.application.deleteMany({ where: { tenantId: company } });
      await t.candidate.deleteMany({ where: { tenantId: company } });
      await t.jobRequisition.deleteMany({ where: { tenantId: company } });
      await t.$executeRawUnsafe(
        'DELETE FROM "OnboardingSessionCalendar" WHERE "tenantId"=$1::uuid',
        company,
      );
      await t.onboardingChecklist.deleteMany({ where: { tenantId: company } });
      await t.employee.deleteMany({ where: { tenant_id: company } });
    }, company);
  await db.$disconnect();
});
