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
const {runCandidateCommunicationDelivery}=await import("../../src/services/candidateCommunicationDelivery.service.js");
process.env.HR_RECRUITMENT_COMMUNICATIONS="on";
const slots=await import("../../src/services/interviewSlots.service.js");
const own=await import("../../src/services/candidateInterviews.service.js");
const {issueStatusLink}=await import("../../src/services/candidateVerification.service.js");
const {requestReschedule}=await import("../../src/services/interviewSchedule.service.js");
process.env.HR_PORTAL_BASE_URL="https://careers.example.invalid";
process.env.HR_RECRUITMENT_ONSITE_TEST="off";
process.env.HR_RECRUITMENT_EVALUATION_FORMS="off";
let token,candidate;
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
  test.mock.timers.enable({apis:["Date"],now:new Date("2030-01-01T00:00:00Z")});
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
        stage:"interview",
      },
    });
    candidate=newCandidate;
    await t.candidateConsent.create({data:{tenantId:tenant,candidateId:candidate.id,purpose:"PROCESSING",status:"GRANTED",policyVersion:"test-policy",source:"SELF_SERVICE"}});
    token=(await issueStatusLink(t,{tenantId:tenant,candidate})).token;
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

const offerArgs=(overrides={})=>({applicationId:application.id,interviewType:"VIDEO",durationMinutes:60,location:"Fictional room",interviewerIds:[person.id],panelRoles:{[person.id]:"TECHNICAL"},slots:[at(7,"04:00"),at(7,"06:00"),at(7,"08:00")],expiresAt:at(6),...overrides});
const candidateCall=fn=>mcpCtx.run({user:{tenantId:tenant},publicPortal:true},fn);
let first,booked;
test("only a recruiter or owning manager can issue valid, calendar-checked slots",async()=>{
 await assert.rejects(as(()=>slots.createSlotOffer(offerArgs()),"EMPLOYEE"),{status:403});
 await assert.rejects(as(()=>slots.createSlotOffer(offerArgs({interviewerIds:[foreign.id],panelRoles:{}}))),/company/);
 await assert.rejects(as(()=>slots.createSlotOffer(offerArgs({slots:[at(10),at(10,"06:00"),at(10,"08:00")]}))),/leave/);
 await assert.rejects(as(()=>slots.createSlotOffer(offerArgs({slots:[at(7),at(7),at(7)]}))),/non-overlapping/);
 first=await as(()=>slots.createSlotOffer(offerArgs()));
 assert.equal(first.status,"OPEN");
 const queued=await tx(t=>t.candidateCommunication.findFirst({where:{tenantId:tenant,templateKey:"interview_slots_offered"}}));
 assert.equal(queued.context.slotOfferId,first.id);
 const messages=[];await mcpCtx.run({system:true},()=>runCandidateCommunicationDelivery({tenantId:tenant,send:async msg=>{messages.push(msg);return {sent:true};}}));
 const invitation=messages.find(m=>m.templateId.endsWith("interview_slots_offered"));assert.ok(invitation);assert.equal(invitation.data.jobTitle,"Calendar test");assert.equal(invitation.data.portalUrl,"https://careers.example.invalid/status");
});
test("new offers replace old offers; ownership, expiry and selected time are rechecked",async()=>{
 const replacement=await as(()=>slots.createSlotOffer(offerArgs()));
 assert.equal((await as(()=>slots.listSlotOffers({applicationId:application.id}))).items.find(o=>o.id===first.id).status,"WITHDRAWN");
 await assert.rejects(candidateCall(()=>slots.bookOwnSlot({tenantId:tenant,token,id:first.id,scheduledAt:at(7)})),{status:409});
 await assert.rejects(candidateCall(()=>slots.bookOwnSlot({tenantId:tenant,token:"x".repeat(43),id:replacement.id,scheduledAt:at(7)})),{status:404});
 await assert.rejects(candidateCall(()=>slots.bookOwnSlot({tenantId:other,token,id:replacement.id,scheduledAt:at(7)})),{status:404});
 await assert.rejects(candidateCall(()=>slots.bookOwnSlot({tenantId:tenant,token,id:replacement.id,scheduledAt:at(9)})),{status:409});
 const publicOffers=await candidateCall(()=>slots.listOwnSlotOffers({tenantId:tenant,token}));
 assert.equal(publicOffers.items.length,1);assert.equal(publicOffers.items[0].jobTitle,"Calendar test");
 assert.equal(JSON.stringify(publicOffers).includes('createdById'),false);
 const pair=await Promise.all([1,2].map(()=>candidateCall(()=>slots.bookOwnSlot({tenantId:tenant,token,id:replacement.id,scheduledAt:at(7)}))));
 assert.equal(pair[0].interviewId,pair[1].interviewId);assert.deepEqual(pair.map(x=>x.replayed).sort(),[false,true]);booked=pair[0].interviewId;
 const row=await tx(t=>t.interview.findFirst({where:{tenantId:tenant,id:booked},include:{interviewers:true}}));
 assert.equal(row.interviewers.length,1);assert.equal(row.interviewers[0].panelRole,"TECHNICAL");assert.equal(row.calendarSyncStatus,"PENDING");
 assert.equal((await candidateCall(()=>slots.listOwnSlotOffers({tenantId:tenant,token}))).items.length,0);
});
test("calendar race blocks candidate booking and leaves the offer open",async()=>{
 const offer=await as(()=>slots.createSlotOffer(offerArgs({slots:[at(11,"06:00"),at(11,"08:00"),at(11,"10:00")]})));
 await tx(t=>t.interview.create({data:{tenantId:tenant,applicationId:application.id,scheduledAt:new Date(at(11,"06:00")),interviewType:"VIDEO",interviewers:{create:{tenantId:tenant,employeeId:person.id}}}}));
 await assert.rejects(candidateCall(()=>slots.bookOwnSlot({tenantId:tenant,token,id:offer.id,scheduledAt:at(11,"06:00")})),{ status: 409 });
 assert.equal((await as(()=>slots.listSlotOffers({applicationId:application.id}))).items[0].status,"OPEN");
 await as(()=>slots.withdrawSlotOffer({id:offer.id}));
 await assert.rejects(candidateCall(()=>slots.bookOwnSlot({tenantId:tenant,token,id:offer.id,scheduledAt:at(11,"08:00")})),{status:409});
});
test("candidate interview projection hides feedback and reschedule requests are idempotent",async()=>{
 const listed=await candidateCall(()=>own.listOwnInterviews({tenantId:tenant,token}));
 assert.ok(listed.items.some(i=>i.id===booked));assert.equal(JSON.stringify(listed).includes('notes'),false);assert.equal(JSON.stringify(listed).includes('candidateId'),false);
 const calendar=await candidateCall(()=>own.downloadOwnInterviewCalendar({tenantId:tenant,token,interviewId:booked}));
 assert.match(calendar,/BEGIN:VCALENDAR\r\n/);assert.match(calendar,/DTSTART:20300107T040000Z/);assert.equal(calendar.includes(token),false);assert.equal(calendar.includes(candidate.email),false);
 const one=await candidateCall(()=>own.requestOwnInterviewReschedule({tenantId:tenant,token,interviewId:booked,notes:"Please offer another time"}));
 const two=await candidateCall(()=>own.requestOwnInterviewReschedule({tenantId:tenant,token,interviewId:booked,notes:"Please offer another time"}));
 assert.equal(one.eventId,two.eventId);
 assert.equal((await candidateCall(()=>own.listOwnInterviews({tenantId:tenant,token}))).items.find(i=>i.id===booked).reschedulePending,true);
 const row=await tx(t=>t.interview.findFirst({where:{tenantId:tenant,id:booked}}));assert.equal(row.scheduledAt.toISOString(),at(7));
 await assert.rejects(candidateCall(()=>own.downloadOwnInterviewCalendar({tenantId:tenant,token,interviewId:99999999})),{status:404});
});
test("booked or withdrawn slot notifications are cancelled before delivery",async()=>{
 const messages=[];const result=await mcpCtx.run({system:true},()=>runCandidateCommunicationDelivery({tenantId:tenant,send:async msg=>{messages.push(msg);return {sent:true};}}));
 assert.equal(messages.filter(m=>m.templateId.endsWith("interview_slots_offered")).length,0);assert.ok(result.suppressed>=2);
});
test("closed applications, expired offers, revoked links and tenant RLS fail closed",async()=>{
 const offer=await as(()=>slots.createSlotOffer(offerArgs({slots:[at(12),at(12,"06:00"),at(12,"08:00")]})));
 test.mock.timers.setTime(new Date(at(6)).getTime());
 await assert.rejects(candidateCall(()=>slots.bookOwnSlot({tenantId:tenant,token,id:offer.id,scheduledAt:at(12)})),{status:409});
 test.mock.timers.setTime(new Date("2030-01-01T00:00:00Z").getTime());
 await tx(t=>t.application.update({where:{id:application.id},data:{stage:"withdrawn"}}));
 await assert.rejects(candidateCall(()=>slots.bookOwnSlot({tenantId:tenant,token,id:offer.id,scheduledAt:at(12)})),/no longer/);
 await tx(t=>t.candidateEmailVerification.updateMany({where:{tenantId:tenant,candidateId:candidate.id,purpose:"STATUS_LINK"},data:{consumedAt:new Date()}}));
 await assert.rejects(candidateCall(()=>slots.listOwnSlotOffers({tenantId:tenant,token})),{status:404});
 const hidden=await mcpCtx.run({user:{tenantId:other}},()=>tenantTransaction(db,t=>t.$queryRawUnsafe('SELECT id FROM "InterviewSlotOffer"'),{tenantId:other}));assert.equal(hidden.length,0);
 await assert.rejects(tx(t=>t.$executeRawUnsafe('UPDATE "InterviewSlotOffer" SET location=$2 WHERE id=$1',offer.id,"Changed after approval")),/immutable/);
});
test.after(async()=>{test.mock.timers.reset();await db.$disconnect();});
