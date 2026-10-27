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
      candidate = await t.candidate.create({
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
        candidateId: candidate.id,
      },
    });
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
test("uses published HR shifts and tenant timezone, including overnight shifts", async () => {
  assert.deepEqual((await check(7)).nonWorkingDay, []);
  assert.deepEqual((await check(7, "03:00")).nonWorkingDay, [person.id]);
  assert.deepEqual((await check(12, "20:00", [night.id])).nonWorkingDay, []);
});
test("honors full and partial holidays from the assigned HR calendar", async () => {
  assert.deepEqual((await check(8)).nonWorkingDay, [person.id]);
  assert.deepEqual((await check(9, "07:30")).nonWorkingDay, [person.id]);
  assert.deepEqual((await check(9, "08:00")).nonWorkingDay, []);
});
test("approved leave blocks at local midnight and cannot be overridden", async () => {
  const result = await check(9, "19:00");
  assert.deepEqual(result.blocked, [person.id]);
  assert.throws(
    () => assertAvailable(result, "Recruiter approved"),
    /approved leave/,
  );
  assert.deepEqual((await check(10, "19:00")).blocked, []);
});
test("busy intervals are half-open and rescheduling excludes only its own interview", async () => {
  const result = await check(11, "05:30");
  assert.deepEqual(result.busy, [person.id]);
  assert.throws(
    () => assertAvailable(result, "Recruiter approved"),
    /already has a scheduled interview/,
  );
  assert.deepEqual((await check(11, "06:00")).busy, []);
  assert.deepEqual(
    (await check(11, "05:30", undefined, { excludeInterviewId: busy.id })).busy,
    [],
  );
});
test("reschedule availability excludes only an interview the caller can access", async () => {
  const { checkInterviewerAvailability } =
    await import("../../src/services/interviewSchedule.service.js");
  const input = {
    tenantId: tenant,
    scheduledAt: at(11, "05:30"),
    interviewerIds: [person.id],
    interviewId: busy.id,
  };
  assert.deepEqual(
    (await as(() => checkInterviewerAvailability(input))).busy,
    [],
  );
  await assert.rejects(
    as(() => checkInterviewerAvailability(input), "HIRING_MANAGER", night),
    (e) => e.status === 404,
  );
  await assert.rejects(
    as(() =>
      checkInterviewerAvailability({ ...input, interviewId: 2147483647 }),
    ),
    (e) => e.status === 404,
  );
});
test("missing published setup is disclosed, foreign panels and unrelated roles are denied", async () => {
  const result = await check(7, "04:00", [unknown.id]);
  assert.deepEqual(result.unknown, [unknown.id]);
  assert.throws(() => assertAvailable(result), /setup is missing/);
  assert.doesNotThrow(() =>
    assertAvailable(result, "Verified directly with the panelist"),
  );
  await assert.rejects(check(7, "04:00", [foreign.id]), /company/);
  await assert.rejects(
    as(
      () =>
        suggestInterviewSlots({
          from: at(7),
          to: at(7, "12:00"),
          interviewerIds: [person.id],
        }),
      "EMPLOYEE",
    ),
    /Recruiter|manager/,
  );
});
test("common slots skip holidays, partial closures and unverified calendars", async () => {
  const result = await as(() =>
    suggestInterviewSlots({
      from: at(8),
      to: at(9, "12:00"),
      durationMinutes: 60,
      interviewerIds: [person.id],
    }),
  );
  assert.equal(result.calendarSource, "HR_ATTENDANCE");
  assert.equal(result.timeZone, "Asia/Karachi");
  assert.equal(result.slots.length, 5);
  assert.equal(result.slots[0].scheduledAt, at(9));
  assert.ok(
    result.slots.every(
      (s) =>
        !s.scheduledAt.startsWith("2030-01-08") &&
        s.scheduledAt !== at(9, "07:00"),
    ),
  );
  assert.equal(
    (
      await as(() =>
        suggestInterviewSlots({
          from: at(7),
          to: at(7, "12:00"),
          interviewerIds: [unknown.id],
        }),
      )
    ).slots.length,
    0,
  );
});
test("panel lock prevents simultaneous booking of the same HR calendar slot", async () => {
  const book = () =>
    tx(async (t) => {
      await lockInterviewPanel(t, tenant, [person.id]);
      const result = await availability(t, {
        tenantId: tenant,
        scheduledAt: at(14),
        durationMinutes: 60,
        interviewerIds: [person.id],
      });
      assertAvailable(result);
      return t.interview.create({
        data: {
          tenantId: tenant,
          applicationId: application.id,
          interviewType: "ONSITE",
          scheduledAt: new Date(at(14)),
          interviewers: { create: { tenantId: tenant, employeeId: person.id } },
        },
      });
    });
  const outcomes = await Promise.allSettled([book(), book()]);
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  assert.match(
    outcomes.find((x) => x.status === "rejected").reason.message,
    /already has a scheduled interview/,
  );
});
test("lifecycle mutations reject unrelated managers and ignore spoofed actor IDs", async () => {
  const lifecycle =
    await import("../../src/services/interviewSchedule.service.js");
  const input = {
    tenantId: tenant,
    interviewId: busy.id,
    reasonCode: "BUSINESS_REQUEST",
    actorId: person.id,
  };
  for (const operation of [
    () => lifecycle.cancelInterview(input),
    () => lifecycle.requestReschedule({ ...input, requestedFor: at(15) }),
    () => lifecycle.confirmReschedule({ ...input, scheduledAt: at(15) }),
    () =>
      lifecycle.markCalendarSync({
        ...input,
        provider: "HR",
        calendarEventId: "calendar-test",
        status: "SYNCED",
      }),
  ])
    await assert.rejects(
      as(operation, "HIRING_MANAGER", night),
      (e) => e.status === 404,
    );
  await as(
    () =>
      lifecycle.requestReschedule({
        ...input,
        actorId: 999999,
        requestedFor: at(15),
      }),
    "HIRING_MANAGER",
  );
  const event = await tx((t) =>
    t.interviewLifecycleEvent.findFirst({
      where: {
        tenantId: tenant,
        interviewId: busy.id,
        eventType: "RESCHEDULE_REQUESTED",
      },
    }),
  );
  assert.equal(event.actorId, person.id);
  const { getInterviewManaged } =
    await import("../../src/services/interviewMgmt.service.js");
  const { resolveRecruitmentScope } =
    await import("../../src/lib/recruitmentAccess.js");
  const detail = await as(() =>
    getInterviewManaged({
      id: busy.id,
      tenantId: tenant,
      scope: resolveRecruitmentScope({
        roles: ["RECRUITER"],
        employeeId: person.id,
      }),
    }),
  );
  assert.equal(
    +new Date(detail.rescheduleRequest.requestedFor),
    +new Date(at(15)),
  );
  const panelDetail = await as(() =>
    getInterviewManaged({
      id: busy.id,
      tenantId: tenant,
      scope: resolveRecruitmentScope({
        roles: ["INTERVIEWER"],
        employeeId: person.id,
      }),
    }),
  );
  assert.equal(panelDetail.rescheduleRequest, null);
  await assert.rejects(
    as(
      () =>
        lifecycle.checkInterviewerAvailability({
          tenantId: tenant,
          scheduledAt: at(15),
          interviewerIds: [person.id],
        }),
      "INTERVIEWER",
      night,
    ),
    (e) => e.status === 403,
  );
  await as(
    () => lifecycle.cancelInterview({ ...input, actorId: 999999 }),
    "HIRING_MANAGER",
  );
  const row = await tx((t) =>
    t.interview.findUnique({ where: { id: busy.id } }),
  );
  assert.equal(row.calendarSyncStatus, "PENDING");
  const cancelled = await tx((t) =>
    t.interviewLifecycleEvent.findFirst({
      where: { tenantId: tenant, interviewId: busy.id, eventType: "CANCELLED" },
    }),
  );
  assert.equal(cancelled.actorId, person.id);
});
test.after(async () => {
  try {
    await tx(async (t) => {
      await t.interview.deleteMany({ where: { tenantId: tenant } });
      await t.application.deleteMany({ where: { tenantId: tenant } });
      await t.candidate.deleteMany({ where: { tenantId: tenant } });
      await t.jobRequisition.deleteMany({ where: { tenantId: tenant } });
      await t.leave.deleteMany({ where: { tenantId: tenant } });
      await t.attendanceSetupRelease.deleteMany({
        where: { tenantId: tenant },
      });
      await t.employee.deleteMany({ where: { tenant_id: tenant } });
    });
    await mcpCtx.run(
      { user: { tenantId: other } },
      async () => await db.employee.deleteMany({ where: { tenant_id: other } }),
    );
  } catch (e) {
    console.error("Calendar fixture cleanup failed:", e);
    throw e;
  } finally {
    await db.$disconnect();
  }
});
