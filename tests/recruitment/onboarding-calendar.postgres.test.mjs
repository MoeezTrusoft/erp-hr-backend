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
process.env.HR_RECRUITMENT_CALENDAR_SYNC = "on";
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const { createSession, updateSession, listSchedule } =
  await import("../../src/services/onboardingSchedule.service.js");
const {
  scheduleOnboardingSession: schedule,
  finishOnboardingSession: finish,
  checkSessionAvailability: availability,
  seedTemplateSessions,
} = await import("../../src/services/onboardingCalendar.service.js");
const { runOnboardingCalendarSync: sync } =
  await import("../../src/services/onboardingCalendarSync.service.js");
const { readInterviewCalendarAvailability } =
  await import("../../src/services/recruitmentCalendar.service.js");
const { materializeOnboardingTaskRows } =
  await import("../../src/lib/onboardingDefaults.js");
const tenant = randomUUID(),
  foreign = randomUUID(),
  p = {};
let checklist, otherChecklist, foreignSession, one, two;
const sent = [];
let broken = false;
const tx = (fn, t = tenant) =>
  mcpCtx.run({ user: { tenantId: t } }, () =>
    tenantTransaction(
      db,
      async (q) => {
        await q.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
        return fn(q);
      },
      { tenantId: t, txOptions: { timeout: 30000, maxWait: 10000 } },
    ),
  );
const as = (
  fn,
  who = "hr",
  permissions = [
    "hr.onboarding.read",
    "hr.onboarding.create",
    "hr.onboarding.update",
  ],
) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: {
        tenantId: tenant,
        userId: p[who].userId,
        employeeId: p.hr.id,
        roles: [
          who === "hr"
            ? "HR_ADMIN"
            : who === "manager"
              ? "MANAGER"
              : "EMPLOYEE",
        ],
      },
      permissions,
    },
    fn,
  );
const input = (sessionId, extra = {}) => ({
  sessionId,
  expectedVersion: 0,
  sessionDate: "2030-01-07",
  fromTime: "09:00",
  timeZone: "Asia/Karachi",
  durationMinutes: 60,
  assigneeId: p.owner.id,
  confirmCalendar: true,
  ...extra,
});
const rejects = (promise, status) =>
  assert.rejects(promise, (e) => (e.statusCode ?? e.status) === status);
const send = async ({ tenantId, intent }) => {
  if (broken) throw Error("temporary upstream failure");
  sent.push({ tenantId, intent });
  return {
    sessionId: intent.sessionId,
    revision: intent.revision,
    state: intent.state,
    provider: "communication-meetings",
    eventId:
      intent.state === "CANCELLED"
        ? null
        : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  };
};
const work = (extra = {}) =>
  mcpCtx.run({ system: true }, () =>
    sync({
      tenantId: tenant,
      send,
      now: new Date("2030-01-06T00:00:00Z"),
      ...extra,
    }),
  );
const record = (id) =>
  tx((t) =>
    t.$queryRawUnsafe(
      'SELECT * FROM "OnboardingSessionCalendar" WHERE "tenantId"=$1::uuid AND "sessionId"=$2',
      tenant,
      id,
    ),
  ).then((r) => r[0]);
test.before(async () => {
  test.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2030-01-06T00:00:00Z"),
  });
  await tx(async (t) => {
    for (const name of ["hr", "owner", "hire", "hire2", "manager", "unknown"])
      p[name] = await t.employee.create({
        data: {
          tenant_id: tenant,
          employee_code: "OC-" + randomUUID().toUpperCase(),
          employeeCategory: "EMPLOYEE",
          first_name: name,
          userId: randomInt(10000, 1000000000),
          status: "Active",
        },
      });
    await t.employee.update({
      where: { id: p.hire.id },
      data: { managerId: p.manager.id },
    });
    checklist = await t.onboardingChecklist.create({
      data: {
        tenantId: tenant,
        employeeId: p.hire.id,
        startDate: new Date("2030-01-07"),
      },
    });
    otherChecklist = await t.onboardingChecklist.create({
      data: {
        tenantId: tenant,
        employeeId: p.hire2.id,
        startDate: new Date("2030-01-07"),
      },
    });
    const employees = [p.owner, p.hire, p.hire2];
    await t.attendanceSetupRelease.create({
      data: {
        tenantId: tenant,
        version: 1,
        effectiveFrom: new Date("2030-01-01"),
        coverageThrough: new Date("2030-02-01"),
        reason: "Onboarding calendar fixture",
        config: {
          version: 1,
          settings: { timeZone: "Asia/Karachi", defaultCalendarId: 1 },
          policy: {},
          employees: employees.map((e) => ({
            id: e.id,
            status: "Active",
            hire_date: "2029-01-01",
            payroll_included: true,
          })),
          periods: [],
          schedules: employees.map((e, i) => ({
            id: i + 1,
            employeeId: e.id,
            effective_start_date: "2030-01-01",
            effective_end_date: null,
            schedule_pattern: {
              shift: { from: "09:00", to: "17:00" },
              offDays: [7],
            },
          })),
          calendarAssignments: [],
          calendars: [{ id: 1, year: 2030 }],
          holidays: [
            {
              holidayCalendarId: 1,
              date: "2030-01-08",
              name: "Holiday",
              fullDay: true,
            },
          ],
        },
      },
    });
    await t.leave.create({
      data: {
        tenantId: tenant,
        employeeId: p.owner.id,
        type: "Annual",
        start_date: new Date("2030-01-10"),
        end_date: new Date("2030-01-10"),
        total_days: 1,
        status: "APPROVED",
        approved_by: p.hr.id,
      },
    });
  });
  await tx(async (t) => {
    const employee = await t.employee.create({
      data: {
        tenant_id: foreign,
        employee_code: "OC-" + randomUUID().toUpperCase(),
        employeeCategory: "EMPLOYEE",
      },
    });
    const c = await t.onboardingChecklist.create({
      data: {
        tenantId: foreign,
        employeeId: employee.id,
        startDate: new Date("2030-01-07"),
      },
    });
    foreignSession = await t.onboardingSession.create({
      data: { tenantId: foreign, checklistId: c.id, title: "Foreign" },
    });
  }, foreign);
  one = await as(() =>
    createSession(
      {
        checklistId: checklist.id,
        title: "Orientation",
        sessionType: "orientation",
      },
      tenant,
    ),
  );
  two = await as(() =>
    createSession(
      {
        checklistId: otherChecklist.id,
        title: "Induction",
        sessionType: "training",
      },
      tenant,
    ),
  );
});
test("template handoff creates one draft session per selected task and preserves due dates", async () => {
  const tasks = [
    {
      title: "Training",
      description: null,
      stage: "first_week",
      category: "COMPLIANCE_POLICY",
      assigneeType: "HR",
      dueInDays: 3,
      sessionType: "compliance",
    },
  ];
  await tx(async (t) => {
    await t.onboardingTask.createMany({
      data: materializeOnboardingTaskRows({
        tasks,
        checklistId: checklist.id,
        tenantId: tenant,
        startDate: "2030-01-07",
      }),
    });
    await seedTemplateSessions(t, tenant, checklist.id, tasks);
    await seedTemplateSessions(t, tenant, checklist.id, tasks);
  });
  const list = await as(() => listSchedule(checklist.id, tenant));
  assert.equal(list.filter((s) => s.title === "Training").length, 1);
  const training = list.find((s) => s.title === "Training");
  assert.equal(training.calendar.state, "DRAFT");
  assert.equal(training.sessionDate.toISOString().slice(0, 10), "2030-01-10");
});
test("draft creation retries return one session and reject changed payloads", async () => {
  const command = {
    checklistId: checklist.id,
    title: "Retry-safe draft",
    requestKey: randomUUID(),
  };
  const a = await as(() => createSession(command, tenant));
  const b = await as(() => createSession(command, tenant));
  assert.equal(a.id, b.id);
  await rejects(
    as(() => createSession({ ...command, title: "Different" }, tenant)),
    409,
  );
});
test("owned read and HR write boundaries reject other employees, managers, foreign sessions and flags off", async () => {
  await rejects(
    as(() => schedule(input(one.id), tenant), "hire"),
    403,
  );
  await rejects(
    as(() => schedule(input(one.id), tenant), "manager"),
    403,
  );
  await rejects(
    as(() => schedule(input(foreignSession.id), tenant)),
    404,
  );
  await rejects(
    as(() => availability(input(two.id), tenant), "manager"),
    404,
  );
  assert.ok(
    (await as(() => availability(input(one.id), tenant), "manager")).available,
  );
  await rejects(
    as(() => schedule({ ...input(one.id), confirmCalendar: false }, tenant)),
    422,
  );
  process.env.HR_RECRUITMENT_CALENDAR_SYNC = "off";
  await rejects(
    as(() => schedule(input(one.id), tenant)),
    503,
  );
  process.env.HR_RECRUITMENT_CALENDAR_SYNC = "on";
});
test("leave cannot be overridden; unknown or nonworking time requires an attributed explanation", async () => {
  await rejects(
    as(() =>
      schedule(
        input(one.id, {
          sessionDate: "2030-01-10",
          overrideReason: "Requested",
        }),
        tenant,
      ),
    ),
    409,
  );
  await rejects(
    as(() => schedule(input(one.id, { sessionDate: "2030-01-08" }), tenant)),
    409,
  );
  const result = await as(() =>
    availability(input(one.id, { assigneeId: p.unknown.id }), tenant),
  );
  assert.ok(result.unknown.includes(p.unknown.id));
  await rejects(
    as(() => schedule(input(one.id, { assigneeId: p.unknown.id }), tenant)),
    409,
  );
});
test("simultaneous bookings serialize shared employees and also block interview availability", async () => {
  const settled = await Promise.allSettled([
    as(() => schedule(input(one.id), tenant)),
    as(() => schedule(input(two.id), tenant)),
  ]);
  assert.equal(settled.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    settled.filter(
      (x) =>
        x.status === "rejected" &&
        (x.reason.statusCode ?? x.reason.status) === 409,
    ).length,
    1,
  );
  if (settled[1].status === "fulfilled") [one, two] = [two, one];
  const busy = await tx((t) =>
    readInterviewCalendarAvailability(t, {
      tenantId: tenant,
      scheduledAt: "2030-01-07T04:30:00Z",
      durationMinutes: 30,
      interviewerIds: [p.owner.id],
    }),
  );
  assert.deepEqual(busy.busy, [p.owner.id]);
  assert.equal((await as(() => schedule(input(one.id), tenant))).version, 1);
  await rejects(
    as(() => schedule(input(one.id, { fromTime: "11:00" }), tenant)),
    412,
  );
  await rejects(
    as(() => updateSession(one.id, { title: "Bypass calendar" }, tenant)),
    409,
  );
});
test("rescheduling excludes itself, retries deliver one frozen revision and refuse invalid receipts", async () => {
  await as(() =>
    schedule(input(one.id, { expectedVersion: 1, fromTime: "10:00" }), tenant),
  );
  broken = true;
  assert.equal((await work()).retried, 1);
  let row = await record(one.id);
  assert.equal(row.syncState, "FAILED");
  assert.equal(row.lastError, "HR-5906");
  broken = false;
  assert.equal(
    (await work({ now: new Date("2030-01-06T00:02:00Z") })).synced,
    1,
  );
  row = await record(one.id);
  assert.equal(row.syncState, "SYNCED");
  assert.equal(sent.at(-1).intent.revision, 2);
  assert.deepEqual(sent.at(-1).intent.participantUserIds, [
    String(p.owner.userId),
    String((one.checklistId === checklist.id ? p.hire : p.hire2).userId),
  ]);
  assert.equal(
    (await work({ now: new Date("2030-01-06T00:03:00Z") })).synced,
    0,
  );
  assert.ok(!JSON.stringify(sent).includes("Orientation"));
});
test("a late calendar receipt cannot mark a new source revision synchronized", async () => {
  await as(() =>
    schedule(input(one.id, { expectedVersion: 2, fromTime: "11:00" }), tenant),
  );
  const result = await work({
    now: new Date("2030-01-06T00:04:00Z"),
    send: async (request) => {
      await as(() =>
        schedule(
          input(one.id, { expectedVersion: 3, fromTime: "12:00" }),
          tenant,
        ),
      );
      return send(request);
    },
  });
  assert.equal(result.superseded, 1);
  assert.equal((await record(one.id)).syncState, "PENDING");
  assert.equal((await record(one.id)).version, 4);
});
test("cancellation has a reason, keeps a tombstone and reconciles with automation disabled", async () => {
  await rejects(
    as(() =>
      finish(
        {
          sessionId: one.id,
          expectedVersion: 4,
          state: "CANCELLED",
          reason: "",
        },
        tenant,
      ),
    ),
    422,
  );
  const value = await as(() =>
    finish(
      {
        sessionId: one.id,
        expectedVersion: 4,
        state: "CANCELLED",
        reason: "Orientation rescheduled separately",
      },
      tenant,
    ),
  );
  assert.equal(value.version, 5);
  process.env.HR_ONBOARDING_AUTOMATION = "off";
  process.env.HR_RECRUITMENT_CALENDAR_SYNC = "off";
  assert.equal(
    (await work({ now: new Date("2030-01-06T00:05:00Z") })).synced,
    1,
  );
  assert.equal(sent.at(-1).intent.state, "CANCELLED");
  assert.equal(sent.at(-1).intent.participantUserIds, undefined);
  await rejects(
    as(() =>
      finish(
        {
          sessionId: one.id,
          expectedVersion: 5,
          state: "COMPLETED",
          reason: "Cannot rewrite cancellation",
        },
        tenant,
      ),
    ),
    409,
  );
  process.env.HR_ONBOARDING_AUTOMATION = "on";
  process.env.HR_RECRUITMENT_CALENDAR_SYNC = "on";
});
test("completed sessions require ended time and preserve an attendance reference", async () => {
  const draft = await as(() =>
    createSession({ checklistId: checklist.id, title: "Attendance" }, tenant),
  );
  await as(() =>
    schedule(
      input(draft.id, { sessionDate: "2030-01-09", fromTime: "14:00" }),
      tenant,
    ),
  );
  const finishInput = {
    sessionId: draft.id,
    expectedVersion: 1,
    state: "COMPLETED",
    reason: "Attendance register HR-204",
  };
  await rejects(
    as(() => finish(finishInput, tenant)),
    409,
  );
  test.mock.timers.setTime(new Date("2030-01-09T11:00:00Z").getTime());
  const result = await as(() => finish(finishInput, tenant));
  assert.equal(result.state, "COMPLETED");
  assert.equal((await as(() => finish(finishInput, tenant))).version, 2);
  assert.ok((await record(draft.id)).reasonCipher);
  await work({ now: new Date("2030-01-09T11:00:00Z") });
  assert.equal(sent.at(-1).intent.state, "COMPLETED");
  test.mock.timers.setTime(new Date("2030-01-06T00:00:00Z").getTime());
});
test("inactive account cleanup runs with flags off and system worker rejects human invocation", async () => {
  await as(() => schedule(input(two.id, { fromTime: "13:00" }), tenant));
  await work({ now: new Date("2030-01-06T00:06:00Z") });
  await tx((t) =>
    t.employee.update({
      where: { id: p.owner.id },
      data: { status: "Inactive" },
    }),
  );
  process.env.HR_ONBOARDING_AUTOMATION = "off";
  process.env.HR_RECRUITMENT_CALENDAR_SYNC = "off";
  const result = await work({ now: new Date("2030-01-06T02:00:00Z") });
  assert.equal(result.cancelled, 1);
  assert.equal((await record(two.id)).state, "CANCELLED");
  await rejects(
    as(() => sync({ tenantId: tenant })),
    403,
  );
  const foreignRows = await tx(
    (t) => t.$queryRawUnsafe('SELECT * FROM "OnboardingSessionCalendar"'),
    foreign,
  );
  assert.equal(foreignRows.length, 0);
  const events = await tx((t) =>
    t.outboxEvent.findMany({
      where: {
        tenantId: tenant,
        eventName: "hr.onboarding.session_changed.v1",
      },
    }),
  );
  for (const e of events)
    assert.deepEqual(Object.keys(e.payload.payload).sort(), [
      "action",
      "checklistId",
      "employeeId",
      "sessionId",
      "version",
    ]);
});
test("invalid preparation backs off without monopolizing the calendar queue", async () => {
  const draft = await as(() =>
    createSession(
      { checklistId: checklist.id, title: "Legacy malformed calendar fixture" },
      tenant,
    ),
  );
  await tx((t) =>
    t.$executeRawUnsafe(
      'UPDATE "OnboardingSessionCalendar" SET "syncState"=\'PENDING\' WHERE "tenantId"=$1::uuid AND "sessionId"=$2',
      tenant,
      draft.id,
    ),
  );
  const count = sent.length;
  assert.equal((await work()).retried, 1);
  const row = await record(draft.id);
  assert.equal(row.syncState, "FAILED");
  assert.equal(row.lastError, "HR-5906");
  assert.equal(row.attempts, 1);
  assert.equal(sent.length, count);
  assert.equal(
    (await work({ now: new Date("2030-01-06T00:00:30Z") })).retried,
    0,
  );
});
test.after(async () => {
  test.mock.timers.reset();
  for (const company of [tenant, foreign])
    await tx(async (t) => {
      await t.$executeRawUnsafe(
        'DELETE FROM "OnboardingSessionCalendar" WHERE "tenantId"=$1::uuid',
        company,
      );
      await t.onboardingChecklist.deleteMany({ where: { tenantId: company } });
      await t.leave.deleteMany({ where: { tenantId: company } });
      await t.attendanceSetupRelease.deleteMany({
        where: { tenantId: company },
      });
      await t.employee.deleteMany({ where: { tenant_id: company } });
    }, company);
  await db.$disconnect();
});
