import logger from "../lib/logger.js";
import prisma from "../lib/prisma.js";
import { mcpCtx } from "../mcp/context.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import {
  affectedDays,
  captureError,
  jsonValue,
  retryAt,
} from "../lib/attendanceCapture.js";
import { applyEvaluatedShiftsForDays } from "./attendanceWriter.service.js";
import { captureAudit } from "./attendanceCapture.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";

export async function assertCapturePeriodOpen(db, tenantId, days) {
  const ranges = days.map((d) => ({
    periodStart: { lte: new Date(`${d}T23:59:59.999Z`) },
    periodEnd: { gte: new Date(`${d}T00:00:00Z`) },
  }));
  if (!ranges.length) return;
  const locked = await db.payrollRun.findFirst({
    where: { tenantId, status: { notIn: ["CANCELLED", "FAILED"] }, OR: ranges },
    select: { id: true },
  });
  if (locked)
    throw captureError(
      "PERIOD_PROTECTED: recall or cancel payroll before changing attendance",
      409,
    );
}

// PostgreSQL row locks recover automatically if a process dies. All evidence
// projection, evaluation, completion and notification intent share one tx.
export async function drainCapture(
  { limit = 10, now = new Date(), evaluate = applyEvaluatedShiftsForDays } = {},
  db = prisma,
) {
  return mcpCtx.run({ system: true }, async () => {
    let processed = 0,
      failed = 0;
    for (let n = 0; n < limit; n++) {
      let candidate;
      try {
        const result = await tenantTransaction(
          db,
          async (tx) => {
            const rows =
              await tx.$queryRaw`SELECT * FROM attendance_capture_events WHERE state IN ('PENDING','FAILED') AND attempts < 8 AND "nextAttemptAt" <= ${now} ORDER BY "nextAttemptAt", "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1`;
            candidate = rows[0];
            if (!candidate) return false;
            const [{ acquired }] =
              await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext(${`attendance:${candidate.tenantId}:${candidate.employeeId}`})) AS acquired`;
            if (!acquired) {
              candidate = null;
              return false;
            }
            const related = await tx.attendanceCaptureEvent.findMany({
              where: {
                tenantId: candidate.tenantId,
                employeeId: candidate.employeeId,
                state: { in: ["PENDING", "FAILED"] },
                attempts: { lt: 8 },
                nextAttemptAt: { lte: now },
              },
              orderBy: { createdAt: "asc" },
              take: candidate.attempts ? 1 : 100,
            });
            const batch = [
              candidate,
              ...related.filter(
                (e) =>
                  e.id !== candidate.id &&
                  e.parsed?.punchedAt?.slice(0, 10) ===
                    candidate.parsed?.punchedAt?.slice(0, 10),
              ),
            ];
            const employee = await tx.employee.findFirst({
              where: {
                id: candidate.employeeId,
                tenant_id: candidate.tenantId,
              },
            });
            for (const event of batch) {
              if (
                event.source === "BIOMETRIC" &&
                (!event.raw?.biometric?.matched ||
                  ((event.raw.biometric.pad !== "PASSED" ||
                    event.raw.biometric.delayedUpload) &&
                    !event.biometricApprovedBy))
              )
                throw captureError(
                  "BIOMETRIC_PAD_UNVERIFIED: explicit exception approval is required",
                  409,
                );
            }
            if (!employee)
              throw captureError(
                "IDENTITY_REMOVED: employee no longer exists",
                409,
              );
            const days = batch.map((e) => new Date(e.parsed.punchedAt));
            await assertCapturePeriodOpen(
              tx,
              candidate.tenantId,
              affectedDays(days),
            );
            for (const event of batch) {
              const p = event.parsed;
              const existing = await tx.attendanceDevicePunch.findMany({
                where: {
                  sn: event.sn,
                  deviceUserId: event.deviceUserId,
                  punchedAt: new Date(p.punchedAt),
                  status: p.status,
                },
              });
              if (
                existing.some(
                  (r) =>
                    r.employeeId &&
                    (r.tenantId !== event.tenantId ||
                      r.employeeId !== event.employeeId),
                )
              )
                throw captureError(
                  "ATTRIBUTION_CONFLICT: historical punch belongs to another employee",
                  409,
                );
              if (existing.length) {
                if (existing[0].tenantId !== event.tenantId) {
                  const device = await tx.attendanceCaptureDevice.findUnique({
                    where: { sn: event.sn },
                  });
                  if (
                    !device?.active ||
                    !device.allowedTenantIds.includes(event.tenantId) ||
                    (existing[0].tenantId &&
                      !device.allowedTenantIds.includes(existing[0].tenantId))
                  )
                    throw captureError(
                      "ATTRIBUTION_CONFLICT: legacy company is not authorized for this device",
                      409,
                    );
                  if (existing[0].tenantId)
                    await captureAudit(tx, {
                      tenantId: existing[0].tenantId,
                      eventId: event.id,
                      action: "LEGACY_IDENTITY_ROUTED",
                      reason:
                        "Unassigned legacy punch resolved using dated enrolment",
                      detail: {
                        punchId: existing[0].id,
                        destinationTenantId: event.tenantId,
                      },
                    });
                }
                await tx.attendanceDevicePunch.update({
                  where: { id: existing[0].id },
                  data: {
                    tenantId: event.tenantId,
                    employeeId: event.employeeId,
                    enrolmentId: event.enrolmentId,
                    captureEventId: event.id,
                    occurredAt: new Date(p.occurredAt),
                    localTime: p.localTime,
                    timeZone: p.timeZone,
                    directionVerified: event.source === "BIOMETRIC",
                  },
                });
              } else {
                await tx.attendanceDevicePunch.create({
                  data: {
                    tenantId: event.tenantId,
                    sn: event.sn,
                    deviceUserId: event.deviceUserId,
                    employeeId: event.employeeId,
                    enrolmentId: event.enrolmentId,
                    captureEventId: event.id,
                    punchedAt: new Date(p.punchedAt),
                    occurredAt: new Date(p.occurredAt),
                    localTime: p.localTime,
                    timeZone: p.timeZone,
                    status: p.status,
                    verifyMode: p.verifyMode,
                    workCode: p.workCode,
                    rawLine: p.rawLine,
                    directionVerified: event.source === "BIOMETRIC",
                  },
                });
              }
            }
            const evaluated = await evaluate({
              tenantId: candidate.tenantId,
              employeeIds: [candidate.employeeId],
              days,
              now,
              db: tx,
            });
            const attendance = await tx.attendance.findMany({
              where: {
                tenantId: candidate.tenantId,
                employeeId: candidate.employeeId,
                date: {
                  in: affectedDays(days).map((d) => new Date(`${d}T00:00:00Z`)),
                },
              },
              select: {
                id: true,
                date: true,
                status: true,
                setupVersion: true,
                setupSnapshot: true,
                manually_corrected: true,
              },
            });
            const setupMissing = attendance.some(
              (r) => r.status === "SETUP_REQUIRED",
            );
            for (const event of batch) {
              await tx.attendanceCaptureEvent.update({
                where: { id: event.id },
                data: {
                  state: setupMissing ? "NEEDS_REVIEW" : "PROCESSED",
                  reason: setupMissing ? "SETUP_REQUIRED" : null,
                  attempts: { increment: 1 },
                  processedAt: now,
                  result: jsonValue({ attendance, evaluated }),
                  version: { increment: 1 },
                },
              });
              await captureAudit(tx, {
                tenantId: event.tenantId,
                eventId: event.id,
                action: "CAPTURE_EVALUATED",
                reason: setupMissing
                  ? "Published setup is required"
                  : "Evaluated against published configuration",
                detail: {
                  attendanceIds: attendance.map((r) => r.id),
                  enrolmentId: event.enrolmentId,
                },
              });
            }
            await enqueueHrDomainEvent(tx, {
              tenantId: candidate.tenantId,
              eventName: "hr.attendance.capture_processed.v1",
              actorId: "attendance-capture",
              aggregateType: "AttendanceCapture",
              aggregateId: candidate.id,
              payload: {
                employeeId: String(candidate.employeeId),
                eventIds: batch.map((e) => e.id),
                attendanceIds: attendance.map((r) => String(r.id)),
                needsReview: setupMissing,
              },
            });
            return batch.length;
          },
          { system: true, txOptions: { timeout: 60000, maxWait: 5000 } },
        );
        if (!result) break;
        processed += result;
      } catch (err) {
        if (!candidate) throw err;
        logger.error(
          { err, eventId: candidate.id, tenantId: candidate.tenantId },
          "Attendance capture evaluation failed",
        );
        failed++;
        await tenantTransaction(
          db,
          async (tx) => {
            const review = err.status === 409;
            const changed = await tx.attendanceCaptureEvent.updateMany({
              where: {
                id: candidate.id,
                version: candidate.version,
                state: { in: ["PENDING", "FAILED"] },
              },
              data: {
                state: review ? "NEEDS_REVIEW" : "FAILED",
                reason: review ? err.message : "PROCESSING_FAILED",
                attempts: { increment: 1 },
                nextAttemptAt: retryAt(candidate.attempts + 1, now),
                version: { increment: 1 },
              },
            });
            if (changed.count)
              await captureAudit(tx, {
                tenantId: candidate.tenantId,
                eventId: candidate.id,
                action: "PROCESSING_FAILED",
                reason: review
                  ? err.message
                  : "Processing failed; retry scheduled",
                detail: {
                  attempt: candidate.attempts + 1,
                  exhausted: candidate.attempts + 1 >= 8,
                },
              });
          },
          { system: true },
        );
      }
    }
    return { processed, failed };
  });
}
