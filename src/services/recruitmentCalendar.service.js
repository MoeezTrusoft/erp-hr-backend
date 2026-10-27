import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { getCtx } from "../mcp/context.js";
import { actor } from "./separation/base.js";
import { assertPermission } from "../lib/assertPermission.js";
import { resolveRecruitmentScope } from "../lib/recruitmentAccess.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { loadAttendanceRuntime } from "../lib/attendanceRuntime.js";
import { addDays, dateKey } from "../lib/attendanceDates.js";
const fail = (message, status = 422, details) => {
  throw Object.assign(new Error(message), { status, code: "HR-6101", details });
};
const partsCache = new Map();
function civilTime(instant, timeZone) {
  let formatter = partsCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    partsCache.set(timeZone, formatter);
  }
  const p = Object.fromEntries(
    formatter.formatToParts(instant).map((p) => [p.type, p.value]),
  );
  return new Date(
    p.year +
      "-" +
      p.month +
      "-" +
      p.day +
      "T" +
      p.hour +
      ":" +
      p.minute +
      ":" +
      p.second +
      ".000Z",
  );
}
const intersects = (a, b, c, d) => +a < +d && +b > +c;
export async function lockInterviewPanel(tx, tenantId, ids) {
  for (const id of [...new Set(ids)].sort((a, b) => a - b))
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtext($1),$2::int)",
      tenantId,
      id,
    );
}
export async function loadInterviewCalendar(
  tx,
  { tenantId, from, to, interviewerIds, excludeInterviewId, excludeSessionId },
) {
  const first = addDays(from, -2),
    last = addDays(to, 2);
  const [runtime, leaves, requests, busy, onboardingBusy] = await Promise.all([
    loadAttendanceRuntime({
      tenantId,
      from: first,
      to: last,
      db: tx,
      ignoreLeaves: true,
    }),
    tx.leave.findMany({
      where: {
        tenantId,
        employeeId: { in: interviewerIds },
        status: "APPROVED",
        start_date: { lte: last },
        end_date: { gte: first },
      },
      select: { employeeId: true, start_date: true, end_date: true },
    }),
    tx.leaveRequest.findMany({
      where: {
        tenantId,
        employeeId: { in: interviewerIds },
        status: "APPROVED",
        startDate: { lte: last },
        endDate: { gte: first },
      },
      select: { employeeId: true, startDate: true, endDate: true },
    }),
    tx.$queryRawUnsafe(
      `SELECT ii."employeeId",i.id,i."scheduledAt",i."durationMinutes" FROM interviews i JOIN interview_interviewers ii ON ii."interviewId"=i.id AND ii."tenantId"=i."tenantId" WHERE i."tenantId"=$1::uuid AND ii."employeeId"=ANY($2::int[]) AND i.status='SCHEDULED' AND i.id<>$3 AND i."scheduledAt"<$4 AND i."scheduledAt"+COALESCE(i."durationMinutes",60)*interval '1 minute'>$5`,
      tenantId,
      interviewerIds,
      excludeInterviewId ?? 0,
      new Date(to),
      new Date(from),
    ),
    tx.$queryRawUnsafe(
      'SELECT unnest("participantIds") AS "employeeId","sessionId" AS id,"scheduledAt","durationMinutes" FROM "OnboardingSessionCalendar" WHERE "tenantId"=$1::uuid AND state=\'SCHEDULED\' AND "participantIds" && $2::int[] AND "sessionId"<>$3 AND "scheduledAt"<$4 AND "scheduledAt"+"durationMinutes"*interval \'1 minute\'>$5',
      tenantId,
      interviewerIds,
      excludeSessionId ?? 0,
      new Date(to),
      new Date(from),
    ),
  ]);
  busy.push(...onboardingBusy);
  const approved = [
    ...leaves.map((l) => ({
      employeeId: l.employeeId,
      from: dateKey(l.start_date),
      to: dateKey(l.end_date),
    })),
    ...requests.map((l) => ({
      employeeId: l.employeeId,
      from: dateKey(l.startDate),
      to: dateKey(l.endDate),
    })),
  ];
  return {
    check(scheduledAt, durationMinutes) {
      const start = new Date(scheduledAt),
        end = new Date(+start + durationMinutes * 60000);
      const result = {
        blocked: [],
        nonWorkingDay: [],
        busy: [],
        unknown: [],
        calendarSource: "HR_ATTENDANCE",
        setupVersions: [],
      };
      const config = runtime.configOn(dateKey(start)),
        timeZone = config?.settings?.timeZone || "Asia/Karachi";
      const localStart = civilTime(start, timeZone),
        localEnd = civilTime(end, timeZone),
        startDay = dateKey(localStart),
        endDay = dateKey(civilTime(new Date(+end - 1), timeZone));
      for (const id of interviewerIds) {
        if (
          approved.some(
            (l) => l.employeeId === id && l.from <= endDay && l.to >= startDay,
          )
        ) {
          result.blocked.push(id);
          continue;
        }
        if (
          busy.some(
            (b) =>
              b.employeeId === id &&
              intersects(
                start,
                end,
                b.scheduledAt,
                new Date(
                  +new Date(b.scheduledAt) + (b.durationMinutes ?? 60) * 60000,
                ),
              ),
          )
        )
          result.busy.push(id);
        const current = runtime.resolve(id, startDay, localStart),
          previous = runtime.resolve(id, addDays(startDay, -1), localStart);
        const plans = [previous, current];
        for (const p of plans)
          if (p.setupVersion && !result.setupVersions.includes(p.setupVersion))
            result.setupVersions.push(p.setupVersion);
        const fits = plans.some(
          (p) =>
            p.working === true &&
            p.shift?.start &&
            p.shift?.end &&
            +localStart >= +new Date(p.shift.start) &&
            +localEnd <= +new Date(p.shift.end) &&
            !(p.shift.exclusions || []).some((x) =>
              intersects(localStart, localEnd, x.start, x.end),
            ),
        );
        if (!fits) {
          if (current.working === null || current.working === undefined)
            result.unknown.push(id);
          else result.nonWorkingDay.push(id);
        }
      }
      return { ...result, timeZone };
    },
  };
}
export async function readInterviewCalendarAvailability(tx, args) {
  const start = new Date(args.scheduledAt),
    duration = Number(args.durationMinutes ?? 60),
    ids = [...new Set((args.interviewerIds || []).map(Number))];
  if (
    !Number.isFinite(+start) ||
    !Number.isInteger(duration) ||
    duration < 5 ||
    duration > 480 ||
    !ids.length ||
    ids.length > 20 ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
  )
    fail("Use a valid interview time, duration and panel");
  const employees = await tx.employee.count({
    where: { tenant_id: args.tenantId, id: { in: ids } },
  });
  if (employees !== ids.length)
    fail("Every panelist must belong to this company", 404);
  const calendar = await loadInterviewCalendar(tx, {
    ...args,
    interviewerIds: ids,
    from: start,
    to: new Date(+start + duration * 60000),
  });
  return calendar.check(start, duration);
}
export function assertInterviewCalendarAvailable(result, overrideReason) {
  if (result.blocked.length)
    fail("Interviewer(s) on approved leave for the proposed slot", 409, {
      code: "HR-RECRUITMENT-SCHEDULE-LEAVE-BLOCK",
      blockedInterviewerIds: result.blocked,
    });
  if (result.busy.length)
    fail(
      "The panel already has a scheduled interview or onboarding session in this time slot",
      409,
      {
        code: "HR-6102",
        busyInterviewerIds: result.busy,
      },
    );
  if (
    (result.nonWorkingDay.length || result.unknown.length) &&
    !String(overrideReason || "").trim()
  )
    fail(
      result.unknown.length
        ? "HR calendar setup is missing for one or more panelists; verify availability and record an override reason"
        : "The slot is outside the panel’s HR working calendar; an override reason is required",
      409,
      {
        code: "HR-6103",
        nonWorkingDayInterviewerIds: result.nonWorkingDay,
        unverifiedInterviewerIds: result.unknown,
      },
    );
}

export async function suggestInterviewSlots(input) {
  const ctx = getCtx();
  if (!ctx.actorVerified || !ctx.user?.tenantId)
    fail("Verified company context required", 401);
  assertPermission(ctx.permissions, "GET", "hr:recruitment", false);
  if (!isRecruitmentFlagEnabled("calendar"))
    fail("HR interview calendar integration is disabled", 503);
  const tenantId = ctx.user.tenantId,
    from = new Date(input.from),
    to = new Date(input.to),
    duration = Number(input.durationMinutes ?? 60),
    ids = [...new Set(input.interviewerIds.map(Number))];
  if (
    !Number.isFinite(+from) ||
    !Number.isFinite(+to) ||
    to <= from ||
    +to - +from > 14 * 86400000 ||
    !Number.isInteger(duration) ||
    duration < 5 ||
    duration > 480 ||
    !ids.length ||
    ids.length > 20 ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
  )
    fail("Choose a panel and a positive search window up to fourteen days");
  return tenantTransaction(
    prisma,
    async (tx) => {
      const who = await actor(tx, ctx),
        scope = resolveRecruitmentScope({ ...ctx.user, employeeId: who.id });
      if (!["ORG", "MANAGED"].includes(scope.level))
        fail("Recruiter or hiring manager required", 403);
      if (
        (await tx.employee.count({
          where: { tenant_id: tenantId, id: { in: ids } },
        })) !== ids.length
      )
        fail("Every panelist must belong to this company", 404);
      const calendar = await loadInterviewCalendar(tx, {
        tenantId,
        from,
        to,
        interviewerIds: ids,
      });
      const slots = [],
        unknown = new Set();
      let timeZone = null;
      for (
        let t = Math.ceil(Math.max(+from, Date.now()) / 900000) * 900000;
        t + duration * 60000 <= +to && slots.length < 5;
        t += 900000
      ) {
        const result = calendar.check(new Date(t), duration);
        timeZone = result.timeZone;
        for (const id of result.unknown) unknown.add(id);
        if (
          !result.blocked.length &&
          !result.busy.length &&
          !result.nonWorkingDay.length &&
          !result.unknown.length
        ) {
          slots.push({
            scheduledAt: new Date(t).toISOString(),
            endsAt: new Date(t + duration * 60000).toISOString(),
            durationMinutes: duration,
          });
          t += Math.max(0, duration - 15) * 60000;
        }
      }
      return {
        slots,
        timeZone,
        calendarSource: "HR_ATTENDANCE",
        unverifiedInterviewerIds: [...unknown],
        requiresConfirmation: true,
      };
    },
    { tenantId },
  );
}
