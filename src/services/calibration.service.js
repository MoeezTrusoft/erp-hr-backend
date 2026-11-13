import { z } from "zod";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { getCtx } from "../mcp/context.js";
import { actor } from "./separation/base.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

// C.2 — verified tenant (T-P2.1) threaded in as a trailing `tenantId`; folded
// into calibration reads and stamped on creates, fail-closed when present.

// 🟢 Create calibration session
export const createCalibrationSessionService = async (data, createdBy, tenantId) => {
  const { name, cycleId } = data;
  if (!name || !cycleId) throw new Error("name and cycleId are required");

  const create = await prisma.calibrationSession.create({
    data: scopedData(tenantId, { name, cycleId: Number(cycleId) }),
  });
  await logAction({
    employeeId: Number(createdBy),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Calibiration",
    result: "SUCCESS",
    notes: `Calibiration "${create.id}" Created successfully`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return create
};

// 🟢 Add rating adjustment
export const adjustRatingService = async (data, calibratedBy, tenantId) => {
  const input = z.object({ reviewId: z.coerce.number().int().positive(),
    calibrationSessionId: z.coerce.number().int().positive(),
    old_rating: z.number().min(0).max(5), new_rating: z.number().min(0).max(5),
    justification: z.string().trim().min(1).max(4000) }).strict().parse(data);
  const ctx = getCtx();
  if (!ctx.actorVerified || !ctx.user?.tenantId)
    throw Object.assign(new Error('Verified calibration identity required'), { status: 401 });
  if (tenantId && tenantId !== ctx.user.tenantId)
    throw Object.assign(new Error('Company mismatch'), { status: 403 });
  return tenantTransaction(prisma, async tx => {
    const who = await actor(tx, ctx);
    const tid = ctx.user.tenantId;
    await tx.$queryRaw`SELECT id FROM "PerformanceReview" WHERE "tenantId"=${tid}::uuid AND id=${input.reviewId} FOR UPDATE`;
    const review = await tx.performanceReview.findFirst({ where: { id: input.reviewId, tenantId: tid } });
    const session = await tx.calibrationSession.findFirst({ where: { id: input.calibrationSessionId, tenantId: tid } });
    if (!review || !session || session.cycleId !== review.cycleId)
      throw Object.assign(new Error('Review and calibration session must belong to the same company and cycle'), { status: 404 });
    if (review.status === 'FINALIZED' || session.status === 'COMPLETED')
      throw Object.assign(new Error('Completed appraisal evidence is immutable'), { status: 409 });
    if ([review.employeeId, review.reviewerId].includes(who.id))
      throw Object.assign(new Error('Independent calibration reviewer required'), { status: 403 });
    if (review.overall_rating !== input.old_rating)
      throw Object.assign(new Error('Rating changed; reload before calibrating'), { status: 412 });
    const adjustment = await tx.ratingAdjustment.create({ data: {
      tenantId: tid, ...input, calibrated_by_employee_id: who.id,
    } });
    await tx.performanceReview.update({ where: { id: review.id }, data: {
      overall_rating: input.new_rating, calibrationSessionId: session.id,
    } });
    const queued = await enqueueHrDomainEvent(tx, { tenantId: tid,
      eventName: 'hr.performance.legacy_calibrated.v1', actorType: 'user', actorId: ctx.user.userId,
      aggregateType: 'PerformanceReview', aggregateId: review.id, correlationId: ctx.correlationId,
      payload: { reviewId: review.id, adjustmentId: adjustment.id, calibrationSessionId: session.id },
    });
    if (!queued) throw Object.assign(new Error('Calibration event storage unavailable'), { status: 503 });
    return adjustment;
  }, { tenantId: ctx.user.tenantId, txOptions: { isolationLevel: 'Serializable' } });
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
  if (!session) throw new Error("Calibration session not found");

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
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Calibration",
    result: "SUCCESS",
    notes: `Finalized Calibration "${id}" updated successfully`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return update
};
