import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { conflict, notFound } from "../lib/performance-errors.js";
import {
  calibrationAdjustSchema,
  calibrationCreateSchema,
  parsePerformancePayload,
} from "../validators/performance.schema.js";

// C.2 — verified tenant (T-P2.1) threaded in as a trailing `tenantId`; folded
// into calibration reads and stamped on creates, fail-closed when present.
//
// PERF-P0 (E-01 / D6): a rating adjustment is now ONE transaction that
//   * refuses a stale `old_rating` (the client's view must match the stored
//     rating, so two calibrators cannot silently overwrite each other),
//   * links the adjustment to an open calibration session for the review's
//     cycle (explicit `calibrationSessionId`, else the newest open session),
//   * refuses to adjust a FINALIZED review or to use a COMPLETED session,
//   * writes the adjustment row and the new rating atomically.

const RATING_EPSILON = 1e-6;

// 🟢 Create calibration session
export const createCalibrationSessionService = async (data, createdBy, tenantId) => {
  const { name, cycleId } = parsePerformancePayload(calibrationCreateSchema, data);

  const cycle = await prisma.performanceCycle.findFirst({
    where: scopedWhere(tenantId, { id: cycleId, archivedAt: null }),
    select: { id: true, status: true },
  });
  if (!cycle) throw notFound("Performance cycle");
  if (cycle.status === "CLOSED") throw conflict("The performance cycle is closed");

  const create = await prisma.calibrationSession.create({
    data: scopedData(tenantId, { name, cycleId }),
  });
  await logAction({
    employeeId: Number(createdBy),
    type: "CREATE",
    module: "Calibration",
    result: "SUCCESS",
    notes: `Calibration session ${create.id} created for cycle ${cycleId}`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return create;
};

// 🟢 Add rating adjustment
export const adjustRatingService = async (data, calibrated_by_employee_id, tenantId) => {
  const input = parsePerformancePayload(calibrationAdjustSchema, data);
  const { reviewId, old_rating, new_rating, justification, calibrationSessionId } = input;

  const adjustment = await tenantTransaction(
    prisma,
    async (tx) => {
      const review = await tx.performanceReview.findFirst({
        where: scopedWhere(tenantId, { id: reviewId }),
        select: { id: true, cycleId: true, status: true, overall_rating: true },
      });
      if (!review) throw notFound("Review");
      if (review.status === "FINALIZED")
        throw conflict("A finalized review cannot be calibrated; open a correction through the Approval Centre");

      // The caller's `old_rating` must be the rating actually stored — a stale
      // value means another calibrator moved it first.
      const stored = review.overall_rating;
      if (stored == null || Math.abs(Number(stored) - Number(old_rating)) > RATING_EPSILON)
        throw conflict(
          `Rating changed since it was read (stored ${stored ?? "none"}, sent ${old_rating}); refresh and retry`
        );

      const session = calibrationSessionId
        ? await tx.calibrationSession.findFirst({
            where: scopedWhere(tenantId, { id: calibrationSessionId }),
          })
        : await tx.calibrationSession.findFirst({
            where: scopedWhere(tenantId, {
              cycleId: review.cycleId ?? -1,
              status: { not: "COMPLETED" },
            }),
            orderBy: { id: "desc" },
          });
      if (!session) throw notFound("Open calibration session for this review's cycle");
      if (session.status === "COMPLETED") throw conflict("The calibration session is completed");
      if (review.cycleId != null && session.cycleId != null && session.cycleId !== review.cycleId)
        throw conflict("The calibration session belongs to a different performance cycle");

      const created = await tx.ratingAdjustment.create({
        data: scopedData(tenantId, {
          reviewId,
          calibrationSessionId: session.id,
          old_rating: Number(old_rating),
          new_rating: Number(new_rating),
          justification: justification ?? null,
          calibrated_by_employee_id: calibrated_by_employee_id
            ? Number(calibrated_by_employee_id)
            : null,
        }),
      });

      await tx.performanceReview.update({
        where: { id: reviewId },
        data: { overall_rating: Number(new_rating), calibrationSessionId: session.id },
      });
      if (session.status === "PENDING")
        await tx.calibrationSession.update({ where: { id: session.id }, data: { status: "IN_PROGRESS" } });

      return created;
    },
    { tenantId }
  );

  await logAction({
    employeeId: Number(calibrated_by_employee_id),
    type: "UPDATE",
    module: "Calibration",
    result: "SUCCESS",
    notes: `Rating of review ${reviewId} adjusted ${old_rating} → ${new_rating} (adjustment ${adjustment.id})`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return adjustment;
};

// 🟢 Get all calibration sessions
export const getAllCalibrationSessionsService = async (tenantId) => {
  return prisma.calibrationSession.findMany({
    where: scopedWhere(tenantId, {}),
    include: {
      ratingAdjustments: true,
      cycle: true,
    },
    orderBy: { created_at: "desc" },
  });
};

// 🟢 Finalize a calibration session
export const finalizeCalibrationService = async (id, finalizedBy, tenantId) => {
  const session = await prisma.calibrationSession.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
  });
  if (!session) throw notFound("Calibration session");
  if (session.status === "COMPLETED") throw conflict("The calibration session is already completed");

  const update = await prisma.calibrationSession.update({
    where: { id: Number(id) },
    data: {
      status: "COMPLETED",
      completed_at: new Date(),
    },
  });

  // Appraisal finalization is exclusively performed by the shared approval workflow.
  await logAction({
    employeeId: Number(finalizedBy),
    type: "UPDATE",
    module: "Calibration",
    result: "SUCCESS",
    notes: `Calibration session ${id} completed`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return update;
};
