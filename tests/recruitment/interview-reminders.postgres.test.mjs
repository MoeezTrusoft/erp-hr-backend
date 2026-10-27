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
process.env.HR_RECRUITMENT_CALENDAR_SYNC = "on";
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const {
  readInterviewCalendarAvailability: availability,
  assertInterviewCalendarAvailable: assertAvailable,
  suggestInterviewSlots,
  lockInterviewPanel,
} = await import("../../src/services/recruitmentCalendar.service.js");
const { runCandidateCommunicationDelivery } =
  await import("../../src/services/candidateCommunicationDelivery.service.js");
process.env.HR_RECRUITMENT_COMMUNICATIONS = "on";
const slots = await import("../../src/services/interviewSlots.service.js");
const own = await import("../../src/services/candidateInterviews.service.js");
const { issueStatusLink } =
  await import("../../src/services/candidateVerification.service.js");
const { requestReschedule } =
  await import("../../src/services/interviewSchedule.service.js");
process.env.HR_PORTAL_BASE_URL = "https://careers.example.invalid";
process.env.HR_RECRUITMENT_ONSITE_TEST = "off";
process.env.HR_RECRUITMENT_EVALUATION_FORMS = "off";
let token, candidate;
const tenant = randomUUID(),
  other = randomUUID();
let person, night, unknown, foreign, application, busy;
const tx = (fn) =>
  mcpCtx.run({ user: { tenantId: tenant } }, () =>
    tenantTransaction(db, fn, {
      tenantId: tenant,
      txOptions: { maxWait: 10000, timeout: 30000 },
    }),
  );
const as = (fn, role = "RECRUITER", who = person) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: { tenantId: tenant, userId: who.userId, roles: [role] },
      permissions: [
        "hr.recruitment.read",
        "hr.recruitment.create",
        "hr.recruitment.update",
      ],
    },
    fn,
  );
const employee = (name) => ({
  tenant_id: tenant,
  employee_code: name + "-" + randomUUID().toUpperCase(),
  employeeCategory: "EMPLOYEE",
  first_name: name,
  userId: randomInt(10000, 100000000),
  status: "Active",
  employement_status: "Active",
});
const at = (day, clock = "04:00") =>
  "2030-01-" + String(day).padStart(2, "0") + "T" + clock + ":00.000Z";
const check = (day, clock = "04:00", ids, extra = {}) =>
  tx((t) =>
    availability(t, {
      tenantId: tenant,
      scheduledAt: at(day, clock),
      durationMinutes: 60,
      interviewerIds: ids || [person.id],
      ...extra,
    }),
  );
test.before(async () => {
  test.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2030-01-01T00:00:00Z"),
  });
  await tx(async (t) => {
    person = await t.employee.create({ data: employee("DAY") });
    night = await t.employee.create({ data: employee("NIGHT") });
    unknown = await t.employee.create({ data: employee("UNPUBLISHED") });
    const config = {
      version: 1,
      settings: { timeZone: "Asia/Karachi", defaultCalendarId: 1 },
      policy: {},
      employees: [person, night].map((p) => ({
        id: p.id,
        status: "Active",
        hire_date: "2029-01-01",
        payroll_included: true,
      })),
      periods: [],
      schedules: [person, night].map((p, i) => ({
        id: i + 1,
        employeeId: p.id,
        effective_start_date: "2030-01-01",
        effective_end_date: null,
        schedule_pattern: {
          shift: i
            ? { from: "22:00", to: "06:00" }
            : { from: "09:00", to: "17:00" },
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
        {
          holidayCalendarId: 1,
          date: "2030-01-09",
          name: "Partial holiday",
          fullDay: false,
          startTime: "12:00",
          endTime: "13:00",
        },
      ],
    };
    await t.attendanceSetupRelease.create({
      data: {
        tenantId: tenant,
        version: 1,
        effectiveFrom: new Date("2030-01-01"),
        coverageThrough: new Date("2030-01-31"),
        config,
        reason: "Calendar integration fixture",
      },
    });
    await t.leave.create({
      data: {
        tenantId: tenant,
        employeeId: person.id,
        type: "Annual leave",
        start_date: new Date("2030-01-10"),
        end_date: new Date("2030-01-10"),
        total_days: 1,
        status: "APPROVED",
        approved_by: person.id,
      },
    });
    const req = await t.jobRequisition.create({
        data: {
          tenantId: tenant,
          title: "Calendar test",
          requestedById: person.id,
        },
      }),
      newCandidate = await t.candidate.create({
        data: {
          tenantId: tenant,
          firstName: "Calendar test",
          email: randomUUID() + "@example.invalid",
        },
      });
    application = await t.application.create({
      data: {
        tenantId: tenant,
        jobRequisitionId: req.id,
        candidateId: newCandidate.id,
        stage: "interview",
      },
    });
    candidate = newCandidate;
    await t.candidateConsent.create({
      data: {
        tenantId: tenant,
        candidateId: candidate.id,
        purpose: "PROCESSING",
        status: "GRANTED",
        policyVersion: "test-policy",
        source: "SELF_SERVICE",
      },
    });
    token = (await issueStatusLink(t, { tenantId: tenant, candidate })).token;
    busy = await t.interview.create({
      data: {
        tenantId: tenant,
        applicationId: application.id,
        interviewType: "ONSITE",
        scheduledAt: new Date(at(11, "05:00")),
        durationMinutes: 60,
        interviewers: { create: { tenantId: tenant, employeeId: person.id } },
      },
    });
  });
  await mcpCtx.run({ user: { tenantId: other } }, async () => {
    foreign = await db.employee.create({
      data: { ...employee("FOREIGN"), tenant_id: other },
    });
  });
});

const { isRecruitmentCalendarFile } =
  await import("@trusoft/contracts/recruitment-communications");
const reminders =
  await import("../../src/services/interviewReminders.service.js");
const { confirmReschedule } =
  await import("../../src/services/interviewSchedule.service.js");
const sweep = (now) =>
  mcpCtx.run({ system: true }, () =>
    reminders.runInterviewReminders({ tenantId: tenant, now: new Date(now) }),
  );
const messages = [];
const deliver = (now) =>
  mcpCtx.run({ system: true }, () =>
    runCandidateCommunicationDelivery({
      tenantId: tenant,
      now: new Date(now),
      send: async (message) => {
        messages.push(message);
        return { sent: true };
      },
    }),
  );
const queued = () =>
  tx((t) =>
    t.candidateCommunication.findMany({
      where: { tenantId: tenant, templateKey: "interview_reminder" },
      orderBy: { createdAt: "asc" },
    }),
  );
test("reminder boundaries select one kind and never send after start", () => {
  const when = new Date(at(11, "05:00"));
  assert.equal(
    reminders.interviewReminderKind(when, new Date(+when - 24 * 3600000)),
    "DAY_BEFORE",
  );
  assert.equal(
    reminders.interviewReminderKind(when, new Date(+when - 24 * 3600000 - 1)),
    null,
  );
  assert.equal(
    reminders.interviewReminderKind(when, new Date(+when - 3600000)),
    "ONE_HOUR",
  );
  assert.equal(reminders.interviewReminderKind(when, when), null);
});
test("only a scheduler can enqueue reminders and the rollout flag is honored", async () => {
  await assert.rejects(
    as(() => reminders.runInterviewReminders({ tenantId: tenant })),
    { status: 403 },
  );
  process.env.HR_RECRUITMENT_COMMUNICATIONS = "off";
  assert.equal((await sweep(at(10, "05:00"))).skipped, true);
  process.env.HR_RECRUITMENT_COMMUNICATIONS = "on";
});
test("parallel sweeps and repeated delivery produce one day-before reminder", async () => {
  await Promise.all([sweep(at(10, "05:00")), sweep(at(10, "05:00"))]);
  assert.equal((await queued()).length, 1);
  assert.equal((await queued())[0].context.reminderKind, "DAY_BEFORE");
  await deliver(at(10, "05:00"));
  await sweep(at(10, "06:00"));
  await deliver(at(10, "06:00"));
  const sent = messages.filter((m) =>
    m.templateId.endsWith("interview_reminder"),
  );
  assert.equal(sent.length, 1);
  assert.ok(sent[0].data.interviewTime.includes("Asia/Karachi"));
  assert.equal(sent[0].data.jobTitle, "Calendar test");
  assert.equal(isRecruitmentCalendarFile(sent[0].data.calendarFile), true);
  assert.match(sent[0].data.calendarFile, /DTSTART:20300111T050000Z/);
  assert.equal(sent[0].data.calendarFile.includes(candidate.email), false);
  assert.equal(sent[0].data.calendarFile.includes(token), false);
});
test("a candidate reschedule request pauses queued reminders; recruiter confirmation creates a fresh reminder", async () => {
  await sweep(at(11, "04:00"));
  const before = (await queued()).find(
    (r) => r.context.reminderKind === "ONE_HOUR",
  );
  assert.equal(before.status, "PENDING");
  await mcpCtx.run({ user: { tenantId: tenant }, publicPortal: true }, () =>
    own.requestOwnInterviewReschedule({
      tenantId: tenant,
      token,
      interviewId: busy.id,
      notes: "Please review the timing with me",
    }),
  );
  assert.equal((await sweep(at(11, "04:05"))).paused, 1);
  await deliver(at(11, "04:05"));
  assert.equal(
    (await queued()).find((r) => r.id === before.id).status,
    "CANCELLED",
  );
  const count = messages.length;
  await as(() =>
    confirmReschedule({
      tenantId: tenant,
      interviewId: busy.id,
      scheduledAt: at(11, "05:00"),
      reasonCode: "CANDIDATE_REQUEST",
      notes: "Candidate confirmed the original time",
    }),
  );
  await sweep(at(11, "04:10"));
  await deliver(at(11, "04:10"));
  assert.equal(messages.length, count + 1);
  assert.match(messages.at(-1).data.calendarFile, /SEQUENCE:1/);
  const hourly = (await queued()).filter(
    (r) => r.context.reminderKind === "ONE_HOUR",
  );
  assert.equal(hourly.length, 2);
  assert.equal(hourly.filter((r) => r.status === "SENT").length, 1);
  assert.notEqual(
    hourly[0].context.interviewLifecycleId,
    hourly[1].context.interviewLifecycleId,
  );
});
test("superseded, expired and closed-application reminders cannot deliver", async () => {
  await as(() =>
    confirmReschedule({
      tenantId: tenant,
      interviewId: busy.id,
      scheduledAt: at(12, "05:00"),
      reasonCode: "CANDIDATE_REQUEST",
      notes: "Candidate requested a new day",
    }),
  );
  await sweep(at(11, "05:00"));
  const row = (await queued()).find((r) => r.status === "PENDING");
  assert.ok(row);
  await as(() =>
    confirmReschedule({
      tenantId: tenant,
      interviewId: busy.id,
      scheduledAt: at(12, "06:00"),
      reasonCode: "CANDIDATE_REQUEST",
      notes: "Candidate requested a later time",
    }),
  );
  const count = messages.length;
  await deliver(at(11, "05:00"));
  assert.equal(messages.length, count);
  assert.equal(
    (await queued()).find((r) => r.id === row.id).status,
    "CANCELLED",
  );
  await sweep(at(11, "06:00"));
  const late = (await queued()).find((r) => r.status === "PENDING");
  await deliver(at(12, "05:00"));
  assert.equal(messages.length, count);
  assert.equal(
    (await queued()).find((r) => r.id === late.id).status,
    "CANCELLED",
  );
  await tx((t) =>
    t.application.update({
      where: { id: application.id },
      data: { stage: "withdrawn" },
    }),
  );
  const number = (await queued()).length;
  await sweep(at(12, "05:00"));
  assert.equal((await queued()).length, number);
});
test.after(async () => {
  test.mock.timers.reset();
  await db.$disconnect();
});
