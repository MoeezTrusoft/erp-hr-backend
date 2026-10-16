import assert from "node:assert/strict";
import { test, after } from "node:test";
import { randomUUID } from "node:crypto";
const url = process.env.ASSESSMENT_TEST_DATABASE_URL;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  !["/hr_task_assessment_test", "/attendance_enhancements_test"].includes(
    new URL(url).pathname,
  )
)
  throw new Error("Use an isolated local HR test database");
process.env.DATABASE_URL = url;
process.env.NODE_ENV = "test";
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
const { default: prisma } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const { createShiftTemplate, updateShiftTemplate, listShiftTemplates } =
  await import("../../src/services/shiftTemplateSwap.service.js");
const { createWorkSchedule } =
  await import("../../src/services/workScheduleService.js");
const { bulkAssignShifts } =
  await import("../../src/services/overtimeManager.service.js");
const { applyEvaluatedShifts } =
  await import("../../src/services/attendanceWriter.service.js");
const { listCheckInOuts } =
  await import("../../src/services/timesheetReport.service.js");
const { listRuleCases } =
  await import("../../src/services/attendanceRules.service.js");
const { civilNow } = await import("../../src/lib/attendanceClock.js");
const tenantId = randomUUID(),
  otherTenant = randomUUID();
const user = { tenantId, userId: 12345, roles: ["HR Manager"] };
const as = (fn) => mcpCtx.run({ user }, fn);
const db = (fn) =>
  as(() =>
    tenantTransaction(prisma, fn, { tenantId, txOptions: { timeout: 60000 } }),
  );
const today = civilNow(new Date(), "Asia/Karachi").toISOString().slice(0, 10);
const tomorrow = new Date(+new Date(today) + 86400000)
  .toISOString()
  .slice(0, 10);
const people = {};
let department, dayShift, nightShift;
after(() => prisma.$disconnect());

test("shift master, roster moves, audit and cutoff rollback use real PostgreSQL", async () => {
  await db(async (tx) => {
    department = await tx.businessUnit.create({
      data: { tenantId, name: "Fictional operations" },
    });
    for (const code of ["DAY", "NIGHT", "MEMBER", "CAPTURE"])
      people[code] = await tx.employee.create({
        data: {
          tenant_id: tenantId,
          employee_code: "EMP-" + code,
          employeeCategory: "EMPLOYEE",
          first_name: "Fictional",
          status: "Active",
          employement_status: "Active",
          businessUnitId: department.id,
          hire_date: new Date("2020-01-01"),
          payroll_included: true,
        },
      });
  });
  dayShift = await as(() =>
    createShiftTemplate(
      {
        name: "Day",
        fromTime: "09:00",
        toTime: "17:00",
        departmentId: department.id,
        supervisorCode: "EMP-DAY",
        checkoutCutoffTime: "21:00",
        checkoutCutoffDayOffset: 0,
      },
      tenantId,
    ),
  );
  nightShift = await as(() =>
    createShiftTemplate(
      {
        name: "Night",
        fromTime: "20:00",
        toTime: "05:00",
        departmentId: department.id,
        supervisorCode: "EMP-NIGHT",
        checkoutCutoffTime: "07:00",
        checkoutCutoffDayOffset: 1,
      },
      tenantId,
    ),
  );
  for (const code of ["MEMBER", "CAPTURE"])
    await as(() =>
      createWorkSchedule({
        tenantId,
        employeeId: people[code].id,
        schedule_name: "Day roster",
        effective_start_date: "2020-01-01",
        total_hours_per_week: 40,
        schedule_pattern: {
          shift: { from: "09:00", to: "17:00", templateId: dayShift.id },
          offDays: code === "CAPTURE" ? [7] : [],
        },
      }),
    );
  const proposedRoster={tenantId,employeeId:people.CAPTURE.id,schedule_name:'Preview only',effective_start_date:tomorrow,total_hours_per_week:40,schedule_pattern:{shift:{from:'09:00',to:'17:00',templateId:dayShift.id},offDays:[7]}};
  const beforePreview=await db(tx=>tx.workSchedule.count({where:{tenantId,employeeId:people.CAPTURE.id}}));
  const preview=await as(()=>createWorkSchedule({...proposedRoster,dryRun:true}));
  assert.equal(preview.employeeCode,'EMP-CAPTURE');
  assert.ok(preview.previewToken);
  assert.equal(await db(tx=>tx.workSchedule.count({where:{tenantId,employeeId:people.CAPTURE.id}})),beforePreview);
  await assert.rejects(as(()=>createWorkSchedule({...proposedRoster,schedule_name:'Changed since review',previewToken:preview.previewToken})),/after preview/);
  await as(() =>
    bulkAssignShifts(
      {
        assignments: [
          {
            employeeId: people.MEMBER.id,
            date: today,
            templateId: nightShift.id,
          },
        ],
      },
      tenantId,
    ),
  );
  const member = await db((tx) =>
    tx.employee.findFirst({ where: { id: people.MEMBER.id } }),
  );
  assert.equal(member.managerId, people.NIGHT.id);
  const audit = await db((tx) =>
    tx.attendanceRuleAudit.findMany({
      where: {
        tenantId,
        employeeId: member.id,
        action: "SHIFT_SUPERVISOR_REASSIGNED",
      },
    }),
  );
  assert.equal(audit.at(-1).data.supervisorCode, "EMP-NIGHT");
  assert.equal(audit.at(-1).data.employeeCode, "EMP-MEMBER");
  const early = await as(() =>
    createShiftTemplate(
      {
        name: "Early",
        fromTime: "06:00",
        toTime: "14:00",
        departmentId: department.id,
        supervisorCode: "EMP-DAY",
        checkoutCutoffTime: "18:00",
      },
      tenantId,
    ),
  );
  await assert.rejects(
    as(() =>
      bulkAssignShifts(
        {
          assignments: [
            { employeeId: member.id, date: tomorrow, templateId: early.id },
          ],
        },
        tenantId,
      ),
    ),
    /one hour/,
  );
  assert.equal(
    await db((tx) =>
      tx.shiftAssignment.count({
        where: { tenantId, employeeId: member.id, date: new Date(tomorrow) },
      }),
    ),
    0,
  );
  await assert.rejects(
    as(() =>
      updateShiftTemplate(
        { id: nightShift.id, checkoutCutoffTime: "08:01" },
        tenantId,
      ),
    ),
    /one hour/,
  );
  assert.equal(
    (
      await db((tx) =>
        tx.shiftTemplate.findFirst({ where: { id: nightShift.id } }),
      )
    ).checkoutCutoffTime,
    "07:00",
  );
  const list = await as(() => listShiftTemplates({}, tenantId));
  assert.ok(list.departments.some((d) => d.id === department.id));
  assert.ok(list.supervisors.some((e) => e.employee_code === "EMP-NIGHT"));
  await as(() =>
    bulkAssignShifts(
      {
        assignments: [
          {
            employeeId: member.id,
            date: today,
            fromTime: "10:00",
            toTime: "18:00",
          },
        ],
      },
      tenantId,
    ),
  );
  const custom = await db((tx) =>
    tx.shiftAssignment.findFirst({
      where: { tenantId, employeeId: member.id, date: new Date(today) },
    }),
  );
  assert.equal(custom.templateId, null);
  assert.equal(custom.checkoutCutoffTime, null);
  assert.equal(
    (await db((tx) => tx.employee.findFirst({ where: { id: member.id } })))
      .managerId,
    people.NIGHT.id,
  );
  // A newly created master must not introduce a bad cutoff to existing custom rosters.
  await as(() =>
    createWorkSchedule({
      tenantId,
      employeeId: people.DAY.id,
      schedule_name: "Custom",
      total_hours_per_week: 40,
      effective_start_date: today,
      schedule_pattern: { shift: { from: "06:30", to: "14:30" } },
    }),
  );
  await assert.rejects(
    as(() =>
      createShiftTemplate(
        {
          name: "Invalid matching master",
          fromTime: "06:30",
          toTime: "14:30",
          departmentId: department.id,
          checkoutCutoffTime: "06:00",
          checkoutCutoffDayOffset: 1,
        },
        tenantId,
      ),
    ),
    /one hour/,
  );
  assert.equal(
    await db((tx) =>
      tx.shiftTemplate.count({
        where: { tenantId, name: "Invalid matching master" },
      }),
    ),
    0,
  );
  const foreign = await mcpCtx.run(
    { user: { tenantId: otherTenant } },
    async () =>
      await prisma.shiftTemplate.findFirst({ where: { id: nightShift.id } }),
  );
  assert.equal(foreign, null);
});

test("recorded punches, absence, holiday rows, worked hours and case counts agree", async () => {
  const employee = people.CAPTURE;
  await db(async (tx) => {
    const schedule = await tx.workSchedule.findFirst({
      where: { tenantId, employeeId: employee.id },
    });
    const config = {
      version: 1,
      settings: {
        timeZone: "Asia/Karachi",
        defaultCalendarId: 1,
        profiles: [],
        assignments: [],
      },
      policy: {
        graceMinutes: 0,
        earlyLeaveGraceMin: 0,
        checkoutLeniencyMin: 240,
      },
      employees: [employee],
      periods: [],
      schedules: [schedule],
      calendars: [{ id: 1, year: 2026 }],
      holidays: [
        {
          holidayCalendarId: 1,
          date: "2026-10-13",
          name: "Fictional holiday",
          fullDay: true,
        },
      ],
      calendarAssignments: [],
    };
    await tx.attendanceSetupRelease.create({
      data: {
        tenantId,
        version: 1,
        effectiveFrom: new Date("2026-10-01"),
        coverageThrough: new Date("2026-10-31"),
        config: JSON.parse(JSON.stringify(config)),
        reason: "Isolated test fixture",
      },
    });
    for (const [date, time, status] of [
      ["2026-10-12", "09:00:01", 0],
      ["2026-10-12", "17:00:00", 1],
      ["2026-10-13", "09:00:00", 0],
      ["2026-10-13", "13:00:00", 1],
    ])
      await tx.attendanceDevicePunch.create({
        data: {
          tenantId,
          employeeId: employee.id,
          sn: "FICTIONAL",
          deviceUserId: "1",
          punchedAt: new Date(`${date}T${time}Z`),
          status,
          directionVerified: true,
        },
      });
    await applyEvaluatedShifts({
      tenantId,
      from: "2026-10-12",
      to: "2026-10-14",
      employeeIds: [employee.id],
      now: new Date("2026-10-16"),
      db: tx,
      dryRun: false,
    });
  });
  const result = await as(() =>
    listCheckInOuts({
      tenantId,
      employeeId: employee.id,
      from: "2026-10-12",
      to: "2026-10-18",
      pageSize: 100,
    }),
  );
  const rows = result.items,
    byDate = (date) =>
      rows.find((r) => String(r.date.toISOString()).startsWith(date));
  assert.equal(byDate("2026-10-12").status, "late");
  assert.equal(
    byDate("2026-10-12").checkIn.toISOString(),
    "2026-10-12T09:00:01.000Z",
  );
  assert.equal(byDate("2026-10-13").calendarStatus, "HOLIDAY");
  assert.equal(byDate("2026-10-13").status, "early-checkout");
  assert.equal(byDate("2026-10-13").totalHours, 4);
  assert.equal(byDate("2026-10-14").status, "absent");
  assert.equal(byDate("2026-10-18").status, "weekly-off");
  assert.equal(byDate("2026-10-18").employee.code, "EMP-CAPTURE");
  const cases = await as(() =>
    listRuleCases({
      user,
      employeeId: employee.id,
      from: "2026-10-12",
      to: "2026-10-18",
      pageSize: 100,
    }),
  );
  assert.equal(cases.total, cases.items.length);
  assert.equal(
    Object.entries(cases.summary)
      .filter(([key]) => key !== "total")
      .reduce((n, [, value]) => n + value, 0),
    cases.total,
  );
  assert.ok(cases.items.some((c) => c.type === "ABSENT"));
  assert.ok(cases.items.some((c) => c.type === "LATE_CHECKIN"));
});
