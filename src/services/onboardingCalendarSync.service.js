import { randomUUID } from "node:crypto";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import {
  currentRequestContext,
  runWithRequestContext,
} from "../lib/requestContext.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { syncOnboardingCalendar } from "../lib/onboardingCalendarClient.js";
import {
  OnboardingCalendarIntent,
  OnboardingCalendarReceipt,
} from "@trusoft/contracts/recruitment-calendar";
import {
  calendarRecord,
  sessionCalendarEvent,
} from "./onboardingCalendar.service.js";
const txFor = (tenantId, fn) =>
  runWithRequestContext({ system: false, user: { tenantId } }, () =>
    tenantTransaction(
      prisma,
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
        return fn(tx);
      },
      { tenantId, txOptions: { timeout: 30000, maxWait: 10000 } },
    ),
  );
const active = (e) =>
  e &&
  !/inactive|terminated|exited|offboard|separated/i.test(
    [e.status, e.employement_status].join(" "),
  );
export async function runOnboardingCalendarSync({
  now = new Date(),
  limit = 50,
  tenantId,
  send = syncOnboardingCalendar,
} = {}) {
  if (!currentRequestContext()?.system)
    throw Object.assign(new Error("Scheduler identity required"), {
      status: 403,
    });
  const refs = await tenantTransaction(
    prisma,
    (tx) =>
      tx.$queryRawUnsafe(
        'SELECT "tenantId","sessionId",version FROM "OnboardingSessionCalendar" WHERE "syncState"<>\'IDLE\' AND "dueAt"<=$1::timestamptz AND ("leaseUntil" IS NULL OR "leaseUntil"<$1::timestamptz) AND ($2::uuid IS NULL OR "tenantId"=$2::uuid) ORDER BY "dueAt","sessionId" LIMIT $3',
        now.toISOString(),
        tenantId || null,
        Math.max(1, Math.min(100, limit)),
      ),
    { system: true },
  );
  const counts = { synced: 0, retried: 0, superseded: 0, cancelled: 0 };
  for (const ref of refs) {
    const lease = randomUUID();
    let job;
    try {
      job = await txFor(ref.tenantId, async (tx) => {
        const s = await tx.onboardingSession.findFirst({
          where: { tenantId: ref.tenantId, id: ref.sessionId },
        });
        if (!s) return null;
        await tx.$queryRawUnsafe(
          'SELECT id FROM onboarding_checklists WHERE "tenantId"=$1::uuid AND id=$2 FOR UPDATE',
          ref.tenantId,
          s.checklistId,
        );
        let row = await calendarRecord(tx, ref.tenantId, ref.sessionId);
        if (
          !row ||
          row.syncState === "IDLE" ||
          new Date(row.dueAt) > now ||
          (row.leaseUntil && new Date(row.leaseUntil) >= now)
        )
          return null;
        const c = await tx.onboardingChecklist.findFirst({
          where: { tenantId: ref.tenantId, id: s.checklistId },
        });
        if (!c) return null;
        const people = await tx.employee.findMany({
          where: { tenant_id: ref.tenantId, id: { in: row.participantIds } },
        });
        if (
          row.state === "SCHEDULED" &&
          (c.status === "COMPLETED" ||
            row.participantIds.length !== 2 ||
            !row.participantIds.includes(c.employeeId) ||
            row.participantIds.some((id, i) => {
              const p = people.find((e) => e.id === id);
              return (
                !active(p) || String(p.userId) !== row.participantUserIds[i]
              );
            }))
        ) {
          [row] = await tx.$queryRawUnsafe(
            'UPDATE "OnboardingSessionCalendar" SET version=version+1,state=\'CANCELLED\',"syncState"=\'PENDING\',"leaseToken"=NULL,"leaseUntil"=NULL,"sourceHash"=NULL,"updatedAt"=now() WHERE "tenantId"=$1::uuid AND "sessionId"=$2 RETURNING *',
            ref.tenantId,
            ref.sessionId,
          );
          await sessionCalendarEvent(
            tx,
            ref.tenantId,
            s,
            c.employeeId,
            null,
            "CANCELLED",
            row.version,
          );
          counts.cancelled++;
        }
        if (
          row.syncState === "SYNCED" ||
          (row.state === "SCHEDULED" &&
            (!isRecruitmentFlagEnabled("onboarding") ||
              !isRecruitmentFlagEnabled("calendar")))
        ) {
          await tx.$executeRawUnsafe(
            'UPDATE "OnboardingSessionCalendar" SET "dueAt"=$3::timestamptz WHERE "tenantId"=$1::uuid AND "sessionId"=$2',
            ref.tenantId,
            ref.sessionId,
            new Date(
              now.getTime() + (row.syncState === "SYNCED" ? 3600000 : 60000),
            ).toISOString(),
          );
          return null;
        }
        const payload = OnboardingCalendarIntent.parse({
          sessionId: row.sessionId,
          revision: row.version,
          state: row.state,
          ...(row.state === "CANCELLED"
            ? {}
            : {
                scheduledAt: row.scheduledAt.toISOString(),
                durationMinutes: row.durationMinutes,
                participantUserIds: row.participantUserIds,
              }),
        });
        await tx.$executeRawUnsafe(
          'UPDATE "OnboardingSessionCalendar" SET "syncState"=\'RUNNING\',"leaseToken"=$3::uuid,"leaseUntil"=$4::timestamptz,attempts=attempts+1 WHERE "tenantId"=$1::uuid AND "sessionId"=$2',
          ref.tenantId,
          ref.sessionId,
          lease,
          new Date(now.getTime() + 60000).toISOString(),
        );
        return { ...row, payload, session: s, employeeId: c.employeeId };
      });
      if (!job) continue;
      const result = OnboardingCalendarReceipt.parse(
        await send({ tenantId: ref.tenantId, intent: job.payload }),
      );
      if (
        result.sessionId !== job.sessionId ||
        result.revision !== job.version ||
        result.state !== job.state ||
        (result.state !== "CANCELLED" && !result.eventId)
      )
        throw Error("Receipt identity mismatch");
      const n = await txFor(ref.tenantId, async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT id FROM onboarding_checklists WHERE "tenantId"=$1::uuid AND id=$2 FOR UPDATE',
          ref.tenantId,
          job.session.checklistId,
        );
        const changed = await tx.$executeRawUnsafe(
          'UPDATE "OnboardingSessionCalendar" SET "syncState"=\'SYNCED\',"calendarEventId"=$5,"syncedAt"=$6::timestamptz,"dueAt"=$7::timestamptz,"leaseToken"=NULL,"leaseUntil"=NULL,"lastError"=NULL,"updatedAt"=now() WHERE "tenantId"=$1::uuid AND "sessionId"=$2 AND version=$3 AND "leaseToken"=$4::uuid',
          ref.tenantId,
          job.sessionId,
          job.version,
          lease,
          result.eventId,
          now.toISOString(),
          new Date(now.getTime() + 3600000).toISOString(),
        );
        if (changed)
          await sessionCalendarEvent(
            tx,
            ref.tenantId,
            job.session,
            job.employeeId,
            null,
            "CALENDAR_SYNCED",
            job.version,
          );
        return changed;
      });
      if (n) counts.synced++;
      else counts.superseded++;
    } catch {
      if (!job) {
        // Invalid legacy data or preparation errors must not monopolize the due queue.
        // Version and lease predicates leave concurrent edits and claims untouched.
        const n = await txFor(ref.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            'UPDATE "OnboardingSessionCalendar" SET "syncState"=\'FAILED\',"dueAt"=$4::timestamptz,attempts=attempts+1,"lastError"=\'HR-5906\',"updatedAt"=now() WHERE "tenantId"=$1::uuid AND "sessionId"=$2 AND version=$3 AND "syncState"<>\'IDLE\' AND "dueAt"<=$5::timestamptz AND ("leaseUntil" IS NULL OR "leaseUntil"<$5::timestamptz)',
            ref.tenantId,
            ref.sessionId,
            ref.version,
            new Date(now.getTime() + 60000).toISOString(),
            now.toISOString(),
          ),
        );
        if (n) counts.retried++;
        else counts.superseded++;
        continue;
      }
      const n = await txFor(ref.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          'UPDATE "OnboardingSessionCalendar" SET "syncState"=\'FAILED\',"dueAt"=$5::timestamptz,"leaseToken"=NULL,"leaseUntil"=NULL,"lastError"=\'HR-5906\',"updatedAt"=now() WHERE "tenantId"=$1::uuid AND "sessionId"=$2 AND version=$3 AND "leaseToken"=$4::uuid',
          ref.tenantId,
          job.sessionId,
          job.version,
          lease,
          new Date(
            now.getTime() +
              Math.min(3600000, 30000 * 2 ** Math.min(job.attempts, 7)),
          ).toISOString(),
        ),
      );
      if (n) counts.retried++;
      else counts.superseded++;
    }
  }
  return counts;
}
