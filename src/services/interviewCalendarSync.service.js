import { randomUUID } from "node:crypto";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import {
  currentRequestContext,
  runWithRequestContext,
} from "../lib/requestContext.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { syncRecruitmentCalendar } from "../lib/recruitmentCalendarClient.js";
import {
  RecruitmentCalendarIntent,
  RecruitmentCalendarReceipt,
} from "@trusoft/contracts/recruitment-calendar";

const txFor = (tenantId, fn) =>
  runWithRequestContext({ system: false, user: { tenantId } }, () =>
    tenantTransaction(
      prisma,
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
        return fn(tx);
      },
      { tenantId },
    ),
  );
const fail = (message, code) => Object.assign(new Error(message), { code });

async function prepare(tx, job) {
  if (job.legacyEventId && job.legacyProvider !== "communication-meetings")
    throw fail("Existing calendar provider needs reconciliation", "HR-5908");
  const base = {
    interviewId: job.interviewId,
    revision: job.revision,
    ...(job.legacyEventId ? { legacyEventId: job.legacyEventId } : {}),
  };
  if (job.action === "CANCEL") return { ...base, state: "CANCELLED" };
  const interview = await tx.interview.findFirst({
    where: { tenantId: job.tenantId, id: job.interviewId },
    include: {
      application: {
        select: {
          tenantId: true,
          stage: true,
          candidate: {
            select: {
              tenantId: true,
              anonymizedAt: true,
              consentStatus: true,
              status: true,
            },
          },
        },
      },
      interviewers: {
        include: { employee: { select: { tenant_id: true, userId: true } } },
      },
    },
  });
  const candidate = interview?.application?.candidate;
  if (
    !interview ||
    !candidate ||
    candidate.tenantId !== job.tenantId ||
    interview.application.tenantId !== job.tenantId ||
    candidate.anonymizedAt ||
    candidate.consentStatus !== "GRANTED" ||
    candidate.status !== "active" ||
    interview.status === "CANCELLED" ||
    (interview.status === "SCHEDULED" &&
      ["withdrawn", "rejected", "hired"].includes(interview.application.stage))
  )
    return { ...base, state: "CANCELLED" };
  const panel = interview.interviewers
    .filter((p) => p.status !== "declined")
    .sort((a, b) => a.employeeId - b.employeeId);
  if (
    !panel.length ||
    panel.some(
      (p) =>
        p.tenantId !== job.tenantId ||
        p.employee?.tenant_id !== job.tenantId ||
        !Number.isSafeInteger(p.employee?.userId) ||
        p.employee.userId < 1,
    )
  )
    throw fail("Panel calendar accounts need configuration", "HR-5905");
  return RecruitmentCalendarIntent.parse({
    ...base,
    state: interview.status,
    scheduledAt: interview.scheduledAt.toISOString(),
    durationMinutes: interview.durationMinutes,
    panelUserIds: panel.map((p) => String(p.employee.userId)),
  });
}

export async function runInterviewCalendarSync({
  now = new Date(),
  limit = 50,
  tenantId,
  send = syncRecruitmentCalendar,
} = {}) {
  if (!currentRequestContext().system)
    throw Object.assign(new Error("Scheduler identity required"), {
      status: 403,
      code: "HR-5304",
    });
  const refs = await tenantTransaction(
    prisma,
    (tx) =>
      tx.$queryRawUnsafe(
        `SELECT "tenantId","interviewId" FROM interview_calendar_jobs WHERE state<>'SYNCED' AND "dueAt"<=$1::timestamptz AND ("leaseUntil" IS NULL OR "leaseUntil"<$1::timestamptz) AND ($2::uuid IS NULL OR "tenantId"=$2::uuid) AND ($3::boolean OR action='CANCEL') ORDER BY "dueAt","interviewId" LIMIT $4`,
        now.toISOString(),
        tenantId ?? null,
        isRecruitmentFlagEnabled("calendar"),
        Math.max(1, Math.min(200, limit)),
      ),
    { system: true },
  );
  const counts = { synced: 0, retried: 0, superseded: 0 };
  for (const ref of refs) {
    const lease = randomUUID();
    const job = await txFor(ref.tenantId, async (tx) => {
      const [row] = await tx.$queryRawUnsafe(
        `UPDATE interview_calendar_jobs SET state='RUNNING',"leaseToken"=$3::uuid,"leaseUntil"=$4::timestamptz,attempts=attempts+1 WHERE "tenantId"=$1::uuid AND "interviewId"=$2 AND state<>'SYNCED' AND "dueAt"<=$5::timestamptz AND ("leaseUntil" IS NULL OR "leaseUntil"<$5::timestamptz) RETURNING *`,
        ref.tenantId,
        ref.interviewId,
        lease,
        new Date(now.getTime() + 60000).toISOString(),
        now.toISOString(),
      );
      return row;
    });
    if (!job) continue;
    try {
      const intent = await txFor(ref.tenantId, async (tx) => {
        const [current] = await tx.$queryRawUnsafe(
          `SELECT * FROM interview_calendar_jobs WHERE "tenantId"=$1::uuid AND "interviewId"=$2 AND revision=$3 AND "leaseToken"=$4::uuid FOR UPDATE`,
          ref.tenantId,
          ref.interviewId,
          job.revision,
          lease,
        );
        if (!current) return null;
        const payload = current.payload ?? (await prepare(tx, current));
        await tx.$executeRawUnsafe(
          `UPDATE interview_calendar_jobs SET payload=$3::jsonb WHERE "tenantId"=$1::uuid AND "interviewId"=$2`,
          ref.tenantId,
          ref.interviewId,
          JSON.stringify(payload),
        );
        return payload;
      });
      if (!intent) {
        counts.superseded++;
        continue;
      }
      const result = RecruitmentCalendarReceipt.parse(
        await send({ tenantId: ref.tenantId, intent }),
      );
      if (
        result.interviewId !== job.interviewId ||
        result.revision !== job.revision ||
        result.state !== intent.state ||
        (result.state !== "CANCELLED" && !result.eventId)
      )
        throw fail("Calendar receipt identity mismatch", "HR-5904");
      const changed = await txFor(ref.tenantId, async (tx) => {
        // Same lock order as lifecycle mutations: interview before queue. A late
        // response cannot mark a newer schedule/cancellation as synchronized.
        await tx.$queryRawUnsafe(
          `SELECT id FROM interviews WHERE "tenantId"=$1::uuid AND id=$2 FOR UPDATE`,
          ref.tenantId,
          ref.interviewId,
        );
        const n = await tx.$executeRawUnsafe(
          `UPDATE interview_calendar_jobs SET state='SYNCED',"leaseToken"=NULL,"leaseUntil"=NULL,"lastError"=NULL,"updatedAt"=now() WHERE "tenantId"=$1::uuid AND "interviewId"=$2 AND revision=$3 AND "leaseToken"=$4::uuid`,
          ref.tenantId,
          ref.interviewId,
          job.revision,
          lease,
        );
        if (n)
          await tx.interview.updateMany({
            where: { tenantId: ref.tenantId, id: ref.interviewId },
            data: {
              calendarProvider: result.provider,
              calendarEventId: result.eventId,
              calendarSyncedAt: now,
              calendarSyncStatus: "SYNCED",
            },
          });
        return n;
      });
      if (changed) counts.synced++;
      else counts.superseded++;
    } catch (error) {
      const changed = await txFor(ref.tenantId, async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT id FROM interviews WHERE "tenantId"=$1::uuid AND id=$2 FOR UPDATE`,
          ref.tenantId,
          ref.interviewId,
        );
        const dueAt = new Date(
          now.getTime() +
            Math.min(3600000, 30000 * 2 ** Math.min(job.attempts, 7)),
        );
        const code = /^HR-59\d{2}$/.test(error.code ?? "")
          ? error.code
          : "HR-5906";
        const n = await tx.$executeRawUnsafe(
          `UPDATE interview_calendar_jobs SET state='FAILED',"dueAt"=$5::timestamptz,"leaseToken"=NULL,"leaseUntil"=NULL,"lastError"=$6,"updatedAt"=now() WHERE "tenantId"=$1::uuid AND "interviewId"=$2 AND revision=$3 AND "leaseToken"=$4::uuid`,
          ref.tenantId,
          ref.interviewId,
          job.revision,
          lease,
          dueAt.toISOString(),
          code,
        );
        if (n)
          await tx.interview.updateMany({
            where: { tenantId: ref.tenantId, id: ref.interviewId },
            data: { calendarSyncStatus: "FAILED" },
          });
        return n;
      });
      if (changed) counts.retried++;
      else counts.superseded++;
    }
  }
  return counts;
}
