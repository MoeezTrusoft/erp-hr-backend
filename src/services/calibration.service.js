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
  });

  return create
};

// 🟢 Add rating adjustment
export const adjustRatingService = async (data, calibrated_by_employee_id, tenantId) => {
  const { reviewId, old_rating, new_rating, justification } = data;

  if (reviewId == null || new_rating == null || old_rating == null)
    throw new Error("reviewId, new_rating and old_rating are required");

  const reviewIdNum = Number(reviewId);
  const review = await prisma.performanceReview.findFirst({
    where: scopedWhere(tenantId, { id: reviewIdNum }),
  });
  if (!review) throw new Error("Review not found");

  const adjustment = await prisma.ratingAdjustment.create({
    data: scopedData(tenantId, {
      reviewId: reviewIdNum,
      old_rating: Number(old_rating),
      new_rating: Number(new_rating),
      justification,
      calibrated_by_employee_id: calibrated_by_employee_id ? Number(calibrated_by_employee_id) : null,
    }),
  });

  // Update the main review rating (pre-read above already proved tenant scope)
  await prisma.performanceReview.update({
    where: { id: reviewIdNum },
    data: { overall_rating: Number(new_rating) },
  });

   await logAction({
    employeeId: Number(calibrated_by_employee_id),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Calibration",
    result: "SUCCESS",
    notes: `Calibiration adjusment  "${reviewId}" Created successfully`,
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
  if (!session) throw new Error("Calibration session not found");

  const update = await prisma.calibrationSession.update({
    where: { id: Number(id) },
    data: {
      status: "COMPLETED",
      completed_at: new Date(),
    },
  });

  // Optionally, mark all reviews in that cycle as FINALIZED (tenant-scoped so a
  // finalize never reaches another tenant's reviews in the same cycle).
  await prisma.performanceReview.updateMany({
    where: scopedWhere(tenantId, { cycleId: session.cycleId }),
    data: { status: "FINALIZED" },
  });
   await logAction({
    employeeId: Number(finalizedBy),
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Calibration",
    result: "SUCCESS",
    notes: `Finalized Calibration "${id}" updated successfully`,
  });

  return update
};
