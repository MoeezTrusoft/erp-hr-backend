import { createHash } from "node:crypto";
import {
  runOnboardingManagement,
  managementChecklist,
} from "./onboardingManagement.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import {
  lockInterviewPanel,
  readInterviewCalendarAvailability,
} from "./recruitmentCalendar.service.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { sessionInstant, sessionLocal } from "../lib/onboardingSessionTime.js";
import { encryptString } from "../lib/crypto.js";
import { AppError } from "../utils/AppError.js";
const fail = (message, status = 422) => {
  throw new AppError(message, status);
};
const active = (e) =>
  e &&
  !/inactive|terminated|exited|offboard|separated/i.test(
    [e.status, e.employement_status].join(" "),
  );
export async function calendarRecord(
  tx,
  tenantId,
  sessionId,
  { create = false } = {},
) {
  if (create)
    await tx.$executeRawUnsafe(
      'INSERT INTO "OnboardingSessionCalendar" ("tenantId","sessionId") VALUES ($1::uuid,$2) ON CONFLICT ("sessionId") DO NOTHING',
      tenantId,
      sessionId,
    );
  return (
    (
      await tx.$queryRawUnsafe(
        'SELECT * FROM "OnboardingSessionCalendar" WHERE "tenantId"=$1::uuid AND "sessionId"=$2',
        tenantId,
        sessionId,
      )
    )[0] || null
  );
}
export const sessionCalendarView = (row) => ({
  version: row?.version || 0,
  state: row?.state || "DRAFT",
  scheduledAt: row?.scheduledAt || null,
  durationMinutes: row?.durationMinutes || null,
  timeZone: row?.timeZone || null,
  syncState: row?.syncState || "IDLE",
  syncedAt: row?.syncedAt || null,
  lastError: row?.lastError || null,
});
export async function calendarViews(tx, tenantId, ids) {
  if (!ids.length) return new Map();
  await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
  const rows = await tx.$queryRawUnsafe(
    'SELECT * FROM "OnboardingSessionCalendar" WHERE "tenantId"=$1::uuid AND "sessionId"=ANY($2::int[])',
    tenantId,
    ids,
  );
  return new Map(rows.map((r) => [r.sessionId, sessionCalendarView(r)]));
}
async function sessionContext(tx, env, sessionId, { write = false } = {}) {
  if (!Number.isSafeInteger(sessionId) || sessionId < 1)
    fail("Onboarding session not found", 404);
  const s = await tx.onboardingSession.findFirst({
    where: { id: sessionId, tenantId: env.tenantId },
  });
  if (!s) fail("Onboarding session not found", 404);
  const c = await managementChecklist(tx, env, s.checklistId, { lock: write });
  const employee = await tx.employee.findFirst({
    where: { id: c.employeeId, tenant_id: env.tenantId },
  });
  if (!employee) fail("Onboarding session not found", 404);
  if (write && (c.status === "COMPLETED" || !active(employee)))
    fail("This onboarding checklist is closed", 409);
  return {
    session: await tx.onboardingSession.findFirst({
      where: { id: sessionId, tenantId: env.tenantId },
    }),
    checklist: c,
    employee,
    calendar: await calendarRecord(tx, env.tenantId, sessionId, {
      create: write,
    }),
  };
}
function timing(input) {
  let start;
  try {
    start = sessionInstant(input.sessionDate, input.fromTime, input.timeZone);
  } catch (e) {
    fail(e.message);
  }
  const duration = input.durationMinutes;
  if (!Number.isInteger(duration) || duration < 5 || duration > 480)
    fail("Duration must be 5–480 whole minutes");
  if (start.getTime() <= Date.now()) fail("Choose a future session time");
  return { start, duration };
}
async function owner(tx, tenantId, id, employee) {
  if (!Number.isSafeInteger(id) || id <= 0 || id === employee.id)
    fail("Choose a different active employee to lead this session");
  const who = await tx.employee.findFirst({
    where: { id, tenant_id: tenantId },
  });
  if (!active(who)) fail("Session owner not found", 404);
  if (
    employee.userId === who.userId ||
    ![employee, who].every(
      (p) => Number.isSafeInteger(p.userId) && p.userId > 0,
    )
  )
    fail(
      "Both participants need linked ERP accounts before calendar booking",
      409,
    );
  return who;
}
async function availability(tx, env, row, input, { lock = false } = {}) {
  const { start, duration } = timing(input);
  const lead = await owner(tx, env.tenantId, input.assigneeId, row.employee);
  const ids = [row.employee.id, lead.id];
  if (lock)
    await lockInterviewPanel(tx, env.tenantId, [
      ...ids,
      ...(row.calendar?.participantIds || []),
    ]);
  const result = await readInterviewCalendarAvailability(tx, {
    tenantId: env.tenantId,
    scheduledAt: start,
    durationMinutes: duration,
    interviewerIds: ids,
    excludeSessionId: row.session.id,
  });
  return { start, duration, lead, ids, result };
}
export const checkSessionAvailability = (input, tenantId) =>
  runOnboardingManagement(tenantId, "GET", async (tx, env) => {
    const row = await sessionContext(tx, env, input.sessionId);
    const v = await availability(tx, env, row, input);
    return {
      scheduledAt: v.start.toISOString(),
      durationMinutes: v.duration,
      timeZone: input.timeZone,
      blocked: v.result.blocked,
      busy: v.result.busy,
      nonWorkingDay: v.result.nonWorkingDay,
      unknown: v.result.unknown,
      calendarSource: v.result.calendarSource,
      available:
        !v.result.blocked.length &&
        !v.result.busy.length &&
        !v.result.nonWorkingDay.length &&
        !v.result.unknown.length,
    };
  });
export async function sessionCalendarEvent(
  tx,
  tenantId,
  session,
  employeeId,
  actorId,
  action,
  version,
) {
  const e = await enqueueHrDomainEvent(tx, {
    tenantId,
    eventName: "hr.onboarding.session_changed.v1",
    aggregateType: "OnboardingChecklist",
    aggregateId: String(session.checklistId),
    ...(actorId ? { actorId: String(actorId), actorType: "user" } : {}),
    payload: {
      sessionId: String(session.id),
      checklistId: String(session.checklistId),
      employeeId: String(employeeId),
      action,
      version,
    },
  });
  if (!e) fail("Session change could not be saved", 503);
}
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function revision(row, input, hash, state) {
  if (
    row.version === input.expectedVersion + 1 &&
    row.sourceHash === hash &&
    row.state === state
  )
    return true;
  if (
    !Number.isInteger(input.expectedVersion) ||
    input.expectedVersion !== row.version
  )
    fail("This session changed. Reload and review before saving.", 412);
  return false;
}
export const scheduleOnboardingSession = (input, tenantId) =>
  runOnboardingManagement(tenantId, "PUT", async (tx, env) => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
    if (
      !isRecruitmentFlagEnabled("onboarding") ||
      !isRecruitmentFlagEnabled("calendar")
    )
      fail("Onboarding calendar automation is disabled", 503);
    if (input.confirmCalendar !== true)
      fail("Confirm the participants and calendar invitation");
    const row = await sessionContext(tx, env, input.sessionId, { write: true });
    const reason =
      typeof input.overrideReason === "string"
        ? input.overrideReason.trim()
        : "";
    if (reason.length > 1000)
      fail("Availability reason must be at most 1000 characters");
    const hash = digest({
      actorId: env.who.id,
      sessionDate: input.sessionDate,
      fromTime: input.fromTime,
      durationMinutes: input.durationMinutes,
      timeZone: input.timeZone,
      assigneeId: input.assigneeId,
      reason,
    });
    if (revision(row.calendar, input, hash, "SCHEDULED"))
      return sessionCalendarView(row.calendar);
    if (["CANCELLED", "COMPLETED"].includes(row.calendar.state))
      fail("Create a new session after cancellation or completion", 409);
    const v = await availability(tx, env, row, input, { lock: true });
    if (v.result.blocked.length)
      fail("A participant is on approved leave", 409);
    if (v.result.busy.length)
      fail(
        "A participant already has a scheduled interview or onboarding session at this time",
        409,
      );
    if ((v.result.nonWorkingDay.length || v.result.unknown.length) && !reason)
      fail(
        "Verify availability and record a reason for using a time outside the configured HR calendar",
        409,
      );
    const end = sessionLocal(
      new Date(v.start.getTime() + v.duration * 60000),
      input.timeZone,
    );
    await tx.onboardingSession.update({
      where: { id: row.session.id },
      data: {
        sessionDate: new Date(input.sessionDate + "T00:00:00.000Z"),
        fromTime: input.fromTime,
        toTime: end.time,
        assigneeId: v.lead.id,
      },
    });
    const [saved] = await tx.$queryRawUnsafe(
      `UPDATE "OnboardingSessionCalendar" SET version=version+1,state='SCHEDULED',"scheduledAt"=$3::timestamptz,"durationMinutes"=$4,"timeZone"=$5,"participantIds"=$6::int[],"participantUserIds"=$10::text[],"actorId"=$7,"reasonCipher"=$8,"sourceHash"=$9,"syncState"='PENDING',"dueAt"=now(),"leaseToken"=NULL,"leaseUntil"=NULL,attempts=0,"lastError"=NULL,"updatedAt"=now() WHERE "tenantId"=$1::uuid AND "sessionId"=$2 RETURNING *`,
      tenantId,
      row.session.id,
      v.start.toISOString(),
      v.duration,
      input.timeZone,
      [v.lead.id, row.employee.id],
      env.who.id,
      reason ? encryptString(JSON.stringify({ text: reason })) : null,
      hash,
      [String(v.lead.userId), String(row.employee.userId)],
    );
    await sessionCalendarEvent(
      tx,
      tenantId,
      row.session,
      row.employee.id,
      env.who.id,
      row.calendar.state === "SCHEDULED" ? "RESCHEDULED" : "SCHEDULED",
      saved.version,
    );
    return sessionCalendarView(saved);
  });
export const finishOnboardingSession = (input, tenantId) =>
  runOnboardingManagement(tenantId, "PUT", async (tx, env) => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
    if (!["CANCELLED", "COMPLETED"].includes(input.state))
      fail("Choose cancelled or completed");
    const row = await sessionContext(tx, env, input.sessionId, { write: true });
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (!reason || reason.length > 1000)
      fail(
        "A reason or completion reference is required (up to 1000 characters)",
      );
    const hash = digest({ state: input.state, actorId: env.who.id, reason });
    if (revision(row.calendar, input, hash, input.state))
      return sessionCalendarView(row.calendar);
    if (["CANCELLED", "COMPLETED"].includes(row.calendar.state))
      fail("This session is closed", 409);
    if (
      input.state === "COMPLETED" &&
      (row.calendar.state !== "SCHEDULED" ||
        new Date(row.calendar.scheduledAt).getTime() +
          row.calendar.durationMinutes * 60000 >
          Date.now())
    )
      fail(
        "Only a scheduled session that has ended can be confirmed complete",
        409,
      );
    await lockInterviewPanel(tx, tenantId, row.calendar.participantIds);
    const [saved] = await tx.$queryRawUnsafe(
      `UPDATE "OnboardingSessionCalendar" SET version=version+1,state=$3,"actorId"=$4,"reasonCipher"=$5,"sourceHash"=$6,"syncState"='PENDING',"dueAt"=now(),"leaseToken"=NULL,"leaseUntil"=NULL,attempts=0,"lastError"=NULL,"updatedAt"=now() WHERE "tenantId"=$1::uuid AND "sessionId"=$2 RETURNING *`,
      tenantId,
      row.session.id,
      input.state,
      env.who.id,
      encryptString(JSON.stringify({ text: reason })),
      hash,
    );
    await sessionCalendarEvent(
      tx,
      tenantId,
      row.session,
      row.employee.id,
      env.who.id,
      input.state,
      saved.version,
    );
    return sessionCalendarView(saved);
  });
export async function seedTemplateSessions(
  tx,
  tenantId,
  checklistId,
  definitions,
) {
  if (!definitions.some((d) => d.sessionType)) return;
  const tasks = await tx.onboardingTask.findMany({
    where: { tenantId, checklistId },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
  for (const [index, definition] of definitions.entries()) {
    if (!definition.sessionType) continue;
    const task = tasks.find((t) => t.sortOrder === index);
    if (!task) fail("Template task was not materialized", 409);
    const prior = await tx.$queryRawUnsafe(
      'SELECT "sessionId" FROM "OnboardingSessionCalendar" WHERE "tenantId"=$1::uuid AND "taskId"=$2',
      tenantId,
      task.id,
    );
    if (prior.length) continue;
    const session = await tx.onboardingSession.create({
      data: {
        tenantId,
        checklistId,
        title: definition.title,
        sessionDate: task.dueDate,
        sessionType: definition.sessionType,
        assigneeId:
          task.assigneeType === "MANAGER" ? undefined : task.assigneeId,
      },
    });
    await tx.$executeRawUnsafe(
      'INSERT INTO "OnboardingSessionCalendar" ("tenantId","sessionId","taskId") VALUES ($1::uuid,$2,$3)',
      tenantId,
      session.id,
      task.id,
    );
  }
}
