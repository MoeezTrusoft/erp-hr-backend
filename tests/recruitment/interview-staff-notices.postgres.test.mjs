import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
import { userIdToUuid } from "@trusoft/contracts/identity";
const url = new URL(process.env.RECRUITMENT_TEST_DATABASE_URL || "");
if (
  url.hostname !== "127.0.0.1" ||
  url.pathname !== "/hr_task_assessment_test" ||
  url.username !== "recruitment_test_user"
)
  throw Error("Use isolated recruitment database");
process.env.DATABASE_URL = url.href;
process.env.NODE_ENV = "test";
process.env.HR_RECRUITMENT_COMMUNICATIONS = "on";
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const { runInterviewStaffNotices: run } =
  await import("../../src/services/interviewStaffNotices.service.js");
const tenant = randomUUID(),
  other = randomUUID();
let panel, manager, recruiter, app, interview, req;
const tx = (fn) =>
  mcpCtx.run({ user: { tenantId: tenant } }, () =>
    tenantTransaction(db, fn, {
      tenantId: tenant,
      txOptions: { maxWait: 10000, timeout: 30000 },
    }),
  );
const sweep = (now) =>
  mcpCtx.run({ system: true }, () =>
    run({ tenantId: tenant, now: new Date(now) }),
  );
const notices = () =>
  tx((t) =>
    t.$queryRawUnsafe(
      'SELECT * FROM "InterviewStaffNotice" WHERE "tenantId"=$1::uuid ORDER BY id',
      tenant,
    ),
  );
const person = (name) => ({
  tenant_id: tenant,
  employee_code: randomUUID().toUpperCase(),
  employeeCategory: "EMPLOYEE",
  first_name: name,
  userId: randomInt(10000, 100000000),
  status: "Active",
  employement_status: "Active",
});
test.before(async () => {
  await tx(async (t) => {
    panel = await t.employee.create({ data: person("Panel") });
    manager = await t.employee.create({ data: person("Manager") });
    recruiter = await t.employee.create({ data: person("Recruiter") });
    req = await t.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Private role",
        requestedById: manager.id,
        recruiterId: recruiter.id,
      },
    });
    const candidate = await t.candidate.create({
      data: {
        tenantId: tenant,
        firstName: "Private Candidate",
        email: randomUUID() + "@example.invalid",
      },
    });
    app = await t.application.create({
      data: {
        tenantId: tenant,
        candidateId: candidate.id,
        jobRequisitionId: req.id,
        stage: "interview",
      },
    });
    interview = await t.interview.create({
      data: {
        tenantId: tenant,
        applicationId: app.id,
        interviewType: "VIDEO",
        scheduledAt: new Date("2030-01-07T04:00:00Z"),
        durationMinutes: 60,
        interviewers: { create: { tenantId: tenant, employeeId: panel.id } },
      },
    });
  });
});
test("scheduler authorization, flag and tenant isolation", async () => {
  await assert.rejects(run({ tenantId: tenant }), { status: 403 });
  process.env.HR_RECRUITMENT_COMMUNICATIONS = "off";
  assert.equal((await sweep("2030-01-06T04:00:00Z")).skipped, true);
  process.env.HR_RECRUITMENT_COMMUNICATIONS = "on";
  const hidden = await mcpCtx.run({ user: { tenantId: other } }, () =>
    tenantTransaction(
      db,
      (t) => t.$queryRawUnsafe('SELECT * FROM "InterviewStaffNotice"'),
      { tenantId: other },
    ),
  );
  assert.equal(hidden.length, 0);
});
test("concurrent sweeps create one notice and atomic routed event per panel member", async () => {
  await Promise.all([
    sweep("2030-01-06T04:00:00Z"),
    sweep("2030-01-06T04:00:00Z"),
  ]);
  await sweep("2030-01-06T05:00:00Z");
  assert.equal((await notices()).length, 1);
  assert.equal((await notices())[0].kind, "DAY_BEFORE");
  const events = await tx((t) =>
    t.outboxEvent.findMany({
      where: {
        tenantId: tenant,
        eventName: "hr.recruitment.interview_action_due.v1",
      },
    }),
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload.payload.recipientUserIds, [
    userIdToUuid(tenant, panel.userId),
  ]);
  assert.equal(JSON.stringify(events).includes("Private Candidate"), false);
});
test("reschedule requests pause staff reminders and a confirmation resumes them", async () => {
  await tx((t) =>
    t.interviewLifecycleEvent.create({
      data: {
        tenantId: tenant,
        interviewId: interview.id,
        eventType: "RESCHEDULE_REQUESTED",
        reasonCode: "CANDIDATE_REQUEST",
      },
    }),
  );
  assert.equal((await sweep("2030-01-07T03:00:00Z")).paused, 1);
  assert.equal((await notices()).length, 1);
  await tx((t) =>
    t.interviewLifecycleEvent.create({
      data: {
        tenantId: tenant,
        interviewId: interview.id,
        eventType: "RESCHEDULED",
        reasonCode: "CANDIDATE_REQUEST",
      },
    }),
  );
  await sweep("2030-01-07T03:00:00Z");
  assert.equal((await notices()).at(-1).kind, "ONE_HOUR");
});
test("feedback due at end plus two hours, escalation after 24 hours goes to the assigned recruiter", async () => {
  await sweep("2030-01-07T06:59:59Z");
  assert.equal((await notices()).length, 2);
  await sweep("2030-01-07T07:00:00Z");
  let rows = await notices();
  assert.equal(rows.at(-1).kind, "FEEDBACK_DUE");
  assert.equal(rows.at(-1).recipientUserId, panel.userId);
  await sweep("2030-01-08T04:59:59Z");
  assert.equal((await notices()).length, 3);
  await sweep("2030-01-08T05:00:00Z");
  rows = await notices();
  assert.equal(rows.at(-1).kind, "FEEDBACK_OVERDUE");
  assert.equal(rows.at(-1).recipientUserId, recruiter.userId);
});
test("submitted panel feedback stops nudges and prompts only the owning manager once", async () => {
  await tx((t) =>
    t.interviewScorecard.create({
      data: {
        tenantId: tenant,
        interviewId: interview.id,
        reviewerId: panel.id,
        scores: {},
        submittedAt: new Date("2030-01-08T06:00:00Z"),
      },
    }),
  );
  await sweep("2030-01-08T06:00:00Z");
  await sweep("2030-01-08T07:00:00Z");
  const rows = await notices();
  assert.equal(rows.length, 5);
  assert.equal(rows.at(-1).kind, "DECISION_DUE");
  assert.equal(rows.at(-1).recipientUserId, manager.userId);
  await tx((t) =>
    t.interview.update({
      where: { id: interview.id },
      data: { decision: "HOLD" },
    }),
  );
  await sweep("2030-01-08T08:00:00Z");
  assert.equal((await notices()).length, 5);
});
test("no-show review is routed, missing recruiter remains retryable, terminal applications stop notices", async () => {
  await tx((t) =>
    t.interview.update({
      where: { id: interview.id },
      data: { status: "NO_SHOW" },
    }),
  );
  await tx((t) =>
    t.jobRequisition.update({
      where: { id: req.id },
      data: { recruiterId: null },
    }),
  );
  assert.equal((await sweep("2030-01-08T09:00:00Z")).unroutable, 1);
  assert.equal((await notices()).length, 5);
  await tx((t) =>
    t.jobRequisition.update({
      where: { id: req.id },
      data: { recruiterId: recruiter.id },
    }),
  );
  await sweep("2030-01-08T09:01:00Z");
  assert.equal((await notices()).at(-1).kind, "NO_SHOW_REVIEW");
  await tx((t) =>
    t.application.update({
      where: { id: app.id },
      data: { stage: "withdrawn" },
    }),
  );
  await sweep("2030-01-08T10:00:00Z");
  assert.equal((await notices()).length, 6);
  const hidden = await mcpCtx.run({ user: { tenantId: other } }, () =>
    tenantTransaction(
      db,
      (t) => t.$queryRawUnsafe('SELECT * FROM "InterviewStaffNotice"'),
      { tenantId: other },
    ),
  );
  assert.equal(hidden.length, 0);
});
test.after(() => db.$disconnect());
