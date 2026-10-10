import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma.js";
import { mcpCtx } from "../mcp/context.js";
import {
  dateRange,
  dateKey,
  dateOnly,
  addDays,
} from "../lib/attendanceDates.js";
import { civilNow } from "../lib/attendanceClock.js";
import {
  attendanceTransaction,
  lockAttendancePeriod,
  assertAttendancePeriodOpen,
} from "./attendancePeriod.service.js";
import { loadAttendanceRuntime } from "./attendanceSetup.service.js";
import { applyEvaluatedShifts } from "./attendanceWriter.service.js";
const shiftDate = (day, n) => dateKey(addDays(day, n));

export async function enqueueEvaluationRange(
  { tenantId, from, to, employeeIds, now = new Date() },
  db = prisma,
) {
  const data = dateRange(from, to, 370).flatMap((day) =>
    employeeIds.map((employeeId) => ({
      tenantId,
      employeeId,
      date: dateOnly(day),
      state: "PENDING",
      nextAttemptAt: now,
    })),
  );
  for (let i = 0; i < data.length; i += 500)
    await db.attendanceEvaluationJob.createMany({
      data: data.slice(i, i + 500),
      skipDuplicates: true,
    });
}
export async function planAttendanceFinalization(
  { now = new Date() } = {},
  db = prisma,
) {
  return mcpCtx.run({ system: true }, async () => {
    const tenants = await db.attendanceSetupRelease.findMany({
      distinct: ["tenantId"],
      select: { tenantId: true },
    });
    const failures = [];
    for (const { tenantId } of tenants)
      try {
        await attendanceTransaction(db, tenantId, async (tx) => {
          if (tx.$executeRaw)
            await tx.$executeRaw(
              Prisma.sql(
                ["SELECT pg_advisory_xact_lock(hashtext(", "))"],
                tenantId + ":attendance-planner",
              ),
            );
          const latest = await tx.attendanceSetupRelease.findFirst({
            where: { tenantId, effectiveFrom: { lte: now } },
            orderBy: { effectiveFrom: "desc" },
          });
          if (!latest) return;
          const today = dateKey(
            civilNow(now, latest.config.settings?.timeZone || "Asia/Karachi"),
          );
          const cursor = await tx.attendanceEvaluationCursor.findFirst({
            where: { tenantId },
          });
          const from = cursor
            ? shiftDate(cursor.plannedThrough, 1)
            : [shiftDate(today, -1), dateKey(latest.effectiveFrom)]
                .sort()
                .at(-1);
          // Bound catch-up per tick, and remember the exact work dates across restarts.
          const to = [today, shiftDate(from, 6)].sort()[0];
          if (from > to) return;
          const runtime = await loadAttendanceRuntime({
            tenantId,
            from,
            to,
            db: tx,
          });
          await enqueueEvaluationRange(
            { tenantId, from, to, employeeIds: runtime.employeeIds, now },
            tx,
          );
          if (cursor)
            await tx.attendanceEvaluationCursor.update({
              where: { tenantId },
              data: { plannedThrough: dateOnly(to) },
            });
          else
            await tx.attendanceEvaluationCursor.create({
              data: { tenantId, plannedThrough: dateOnly(to) },
            });
        });
      } catch (e) {
        failures.push({ tenantId, error: e.message });
      }
    return { failures };
  });
}
export async function drainAttendanceFinalization(
  { now = new Date(), limit = 20 } = {},
  db = prisma,
) {
  return mcpCtx.run({ system: true }, async () => {
    let completed = 0,
      failed = 0;
    const candidates = await db.attendanceEvaluationJob.findMany({
      where: {
        state: { in: ["PENDING", "FAILED"] },
        nextAttemptAt: { lte: now },
      },
      orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
      take: limit,
    });
    for (const candidate of candidates) {
      try {
        const done = await attendanceTransaction(
          db,
          candidate.tenantId,
          async (tx) => {
            await lockAttendancePeriod(tx, candidate.tenantId);
            if (tx.$queryRaw) {
              const [lock] = await tx.$queryRaw(
                Prisma.sql(
                  [
                    "SELECT pg_try_advisory_xact_lock(hashtext(",
                    ")) AS acquired",
                  ],
                  "attendance:" +
                    candidate.tenantId +
                    ":" +
                    candidate.employeeId,
                ),
              );
              if (!lock?.acquired) return false;
            }
            const job = await tx.attendanceEvaluationJob.findFirst({
              where: {
                id: candidate.id,
                tenantId: candidate.tenantId,
                state: { in: ["PENDING", "FAILED"] },
                nextAttemptAt: { lte: now },
              },
            });
            if (!job) return false;
            const day = dateKey(job.date);
            await applyEvaluatedShifts({
              tenantId: job.tenantId,
              from: day,
              to: day,
              employeeIds: [job.employeeId],
              now,
              db: tx,
              dryRun: false,
              trigger: "DEADLINE",
            });
            // Manual corrections and excluded employees intentionally have no automatic rewrite.
            const remaining = await tx.attendanceEvaluationJob.findFirst({
              where: { id: job.id },
            });
            if (
              remaining?.state === "PENDING" &&
              remaining.nextAttemptAt <= now
            )
              await tx.attendanceEvaluationJob.update({
                where: { id: job.id },
                data: { state: "DONE", completedAt: now },
              });
            return true;
          },
        );
        if (done) completed++;
      } catch (error) {
        failed++;
        await db.attendanceEvaluationJob.updateMany({
          where: {
            id: candidate.id,
            tenantId: candidate.tenantId,
            updatedAt: candidate.updatedAt,
          },
          data: {
            state: error.message.startsWith("PERIOD_PROTECTED")
              ? "PROTECTED"
              : "FAILED",
            attempts: { increment: 1 },
            lastError: error.message,
            nextAttemptAt: new Date(
              +now +
                Math.min(3600000, 60000 * 2 ** Math.min(candidate.attempts, 6)),
            ),
          },
        });
      }
    }
    return { completed, failed };
  });
}

// HR backfills are durable per-employee/date jobs, not a fleet-sized transaction.
export async function queueAttendanceEvaluation(
  { tenantId, from, to, employeeIds },
  db = prisma,
) {
  dateRange(from, to, 370);
  return attendanceTransaction(db, tenantId, async (tx) => {
    await assertAttendancePeriodOpen(tx, tenantId, from, to);
    const employees = await tx.employee.findMany({
      where: {
        tenant_id: tenantId,
        NOT: { payroll_included: false },
        ...(employeeIds ? { id: { in: employeeIds } } : {}),
      },
      select: { id: true },
    });
    const ids = employees.map((e) => e.id),
      now = new Date();
    await enqueueEvaluationRange(
      { tenantId, from, to, employeeIds: ids, now },
      tx,
    );
    await tx.attendanceEvaluationJob.updateMany({
      where: {
        tenantId,
        employeeId: { in: ids },
        date: { gte: dateOnly(from), lte: dateOnly(to) },
      },
      data: {
        state: "PENDING",
        attempts: 0,
        nextAttemptAt: now,
        lastError: null,
        completedAt: null,
      },
    });
    return { queued: ids.length * dateRange(from, to).length, from, to };
  });
}
