import { assertAttendancePeriodOpen, lockAttendancePeriod } from './attendancePeriod.service.js';
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

// ATT-EXPLICIT-OUT-01 — a biometric kiosk authenticates the key the employee
// pressed; the self-service check-in and check-out tools ARE that choice
// (one tool per direction). Both are explicit directions, never positional
// guesses, so the sessioniser and evaluator honour them as recorded.
const VERIFIED_DIRECTION_SOURCES = new Set(["BIOMETRIC", "MANUAL"]);

// Attempts after which an event stops retrying and is handed to a person.
const MAX_ATTEMPTS = 8;
const BUSY = Symbol("employee-busy");
// How many employees held by another worker one drain cycle steps over before it
// reports the queue as empty.
const MAX_BUSY_SKIPS = 10;

export async function assertCapturePeriodOpen(db, tenantId, days) {
  const ordered=[...days].sort();
  if(ordered.length)await assertAttendancePeriodOpen(db,tenantId,ordered[0],ordered.at(-1));
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
    const busyEmployees = [];
    for (let n = 0; n < limit; n++) {
      let candidate;
      try {
        const result = await tenantTransaction(
          db,
          async (tx) => {
            const rows =
              await tx.$queryRaw`SELECT * FROM attendance_capture_events WHERE state IN ('PENDING','FAILED') AND attempts < 8 AND "nextAttemptAt" <= ${now} AND ("employeeId" IS NULL OR "employeeId" <> ALL(${busyEmployees}::int[])) ORDER BY "nextAttemptAt", "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1`;
            candidate = rows[0];
            if (!candidate) return false;
            await lockAttendancePeriod(tx,candidate.tenantId);
            const [{ acquired }] =
              await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext(${`attendance:${candidate.tenantId}:${candidate.employeeId}`})) AS acquired`;
            if (!acquired) {
              // Another worker owns this employee. Step over them (bounded) so the
              // rest of the queue is not starved by one busy employee.
              busyEmployees.push(candidate.employeeId);
              candidate = null;
              return BUSY;
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
            if (!employee)
              throw captureError(
                "IDENTITY_REMOVED: employee no longer exists",
                409,
              );
            // One bad punch must not hold back the valid ones. Each event is
            // judged on its own: a failing one goes to review with its own reason
            // and leaves the batch; the rest are processed as usual.
            const allPunches = await tx.attendanceDevicePunch.findMany({
              where: {
                OR: batch.map((e) => ({
                  sn: e.sn,
                  deviceUserId: e.deviceUserId,
                  punchedAt: new Date(e.parsed.punchedAt),
                  status: e.parsed.status,
                })),
              },
            });
            const deviceCache = new Map();
            const valid = [];
            for (const event of batch) {
              const p = event.parsed;
              // ATT-DEVICE-PER-COMPANY-01: another company's attributed copy of
              // this punch was resolved independently and is not a competing
              // attribution. Unattributed legacy punches still route below.
              const existing = allPunches.filter(
                (r) =>
                  r.sn === event.sn &&
                  r.deviceUserId === event.deviceUserId &&
                  +r.punchedAt === +new Date(p.punchedAt) &&
                  r.status === p.status &&
                  !(r.employeeId && r.tenantId !== event.tenantId),
              );
              let problem = null;
              if (event.raw?.acceptanceMode === "SUPERVISED")
                problem = "ONSITE_SUPERVISED_REVIEW: attendance correction approval is required";
              else if (
                event.source === "BIOMETRIC" &&
                (!event.raw?.biometric?.matched ||
                  ((event.raw.biometric.pad !== "PASSED" ||
                    event.raw.biometric.delayedUpload) &&
                    !event.biometricApprovedBy))
              )
                problem = "BIOMETRIC_PAD_UNVERIFIED: explicit exception approval is required";
              else if (
                existing.some(
                  (r) =>
                    r.employeeId &&
                    (r.tenantId !== event.tenantId ||
                      r.employeeId !== event.employeeId),
                )
              )
                problem = "ATTRIBUTION_CONFLICT: historical punch belongs to another employee";
              else if (existing.length && existing[0].tenantId !== event.tenantId) {
                if (!deviceCache.has(event.sn))
                  deviceCache.set(
                    event.sn,
                    await tx.attendanceCaptureDevice.findUnique({
                      where: { sn: event.sn },
                    }),
                  );
                const device = deviceCache.get(event.sn);
                if (
                  !device?.active ||
                  !device.allowedTenantIds.includes(event.tenantId) ||
                  (existing[0].tenantId &&
                    !device.allowedTenantIds.includes(existing[0].tenantId))
                )
                  problem = "ATTRIBUTION_CONFLICT: legacy company is not authorized for this device";
              }
              if (problem) {
                await tx.attendanceCaptureEvent.update({
                  where: { id: event.id },
                  data: {
                    state: "NEEDS_REVIEW",
                    reason: problem,
                    attempts: { increment: 1 },
                    version: { increment: 1 },
                  },
                });
                await captureAudit(tx, {
                  tenantId: event.tenantId,
                  eventId: event.id,
                  action: "PROCESSING_FAILED",
                  reason: problem,
                  detail: { attempt: event.attempts + 1, exhausted: false, isolated: true },
                });
                continue;
              }
              valid.push({ event, existing });
            }
            if (!valid.length) return batch.length;
            const days = valid.map(({ event }) => new Date(event.parsed.punchedAt));
            for (const { event, existing } of valid) {
              const p = event.parsed;
              let adopted = false;
              if (existing.length) {
                if (existing[0].tenantId !== event.tenantId && existing[0].tenantId)
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
                // Adopt the unattributed legacy row only while it is still unattributed (or already ours). Two companies'
                // events for the same punch run in separate transactions; the second must create its own copy instead of
                // overwriting the first company's attribution.
                const adopt = await tx.attendanceDevicePunch.updateMany({
                  where: {
                    id: existing[0].id,
                    OR: [{ employeeId: null }, { tenantId: event.tenantId }],
                  },
                  data: {
                    tenantId: event.tenantId,
                    employeeId: event.employeeId,
                    enrolmentId: event.enrolmentId,
                    captureEventId: event.id,
                    occurredAt: new Date(p.occurredAt),
                    localTime: p.localTime,
                    timeZone: p.timeZone,
                    directionVerified: VERIFIED_DIRECTION_SOURCES.has(event.source),
                    assurance: jsonValue({source:event.source,modality:event.raw?.biometric?.modality,
                      pad:event.raw?.biometric?.pad,matched:event.raw?.biometric?.matched,
                      approvedBy:event.biometricApprovedBy,approvedAt:event.biometricApprovedAt}),
                  },
                });
                adopted = adopt.count > 0;
              }
              if (!adopted) {
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
                    directionVerified: VERIFIED_DIRECTION_SOURCES.has(event.source),
                    assurance: jsonValue({source:event.source,modality:event.raw?.biometric?.modality,
                      pad:event.raw?.biometric?.pad,matched:event.raw?.biometric?.matched,
                      approvedBy:event.biometricApprovedBy,approvedAt:event.biometricApprovedAt}),
                  },
                });
              }
            }
            const evaluated = await evaluate({
              tenantId: candidate.tenantId,
              employeeIds: [candidate.employeeId],
              days,
              evidenceIds: valid.map(({ event }) => event.id),
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
            for (const { event } of valid) {
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
                eventIds: valid.map(({ event }) => event.id),
                attendanceIds: attendance.map((r) => String(r.id)),
                needsReview: setupMissing,
              },
            });
            return batch.length;
          },
          { system: true, txOptions: { timeout: 60000, maxWait: 5000 } },
        );
        if (result === BUSY) {
          if (busyEmployees.length >= MAX_BUSY_SKIPS) break;
          n--; // a skip is not a processed event
          continue;
        }
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
            const exhausted = candidate.attempts + 1 >= MAX_ATTEMPTS;
            // A person handles what automatic retries could not: an event that ran
            // out of attempts is queued for review, not left FAILED and invisible.
            const review = err.status === 409 || exhausted;
            const changed = await tx.attendanceCaptureEvent.updateMany({
              where: {
                id: candidate.id,
                version: candidate.version,
                state: { in: ["PENDING", "FAILED"] },
              },
              data: {
                state: review ? "NEEDS_REVIEW" : "FAILED",
                reason:
                  err.status === 409
                    ? err.message
                    : exhausted
                      ? "RETRIES_EXHAUSTED"
                      : "PROCESSING_FAILED",
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
                reason:
                  err.status === 409
                    ? err.message
                    : exhausted
                      ? "Retries exhausted; queued for review"
                      : "Processing failed; retry scheduled",
                detail: {
                  attempt: candidate.attempts + 1,
                  exhausted,
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
