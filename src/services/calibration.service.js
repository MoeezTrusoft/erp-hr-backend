import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";

// 🟢 Create calibration session
export const createCalibrationSessionService = async (data, createdBy) => {
  const { name, cycleId } = data;
  if (!name || !cycleId) throw new Error("name and cycleId are required");

  const create = await prisma.calibrationSession.create({
    data: { name, cycleId },
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
export const adjustRatingService = async (data, calibrated_by_employee_id) => {
  const { reviewId, old_rating, new_rating, justification } = data;
  console.log(data);

  if (!reviewId || !new_rating)
    throw new Error("reviewId, new_rating and calibrated_by are required");

  const review = await prisma.performanceReview.findUnique({
    where: { id: reviewId },
  });
  if (!review) throw new Error("Review not found");

  const adjustment = await prisma.ratingAdjustment.create({
    data: {
      reviewId,
      old_rating,
      new_rating,
      justification,
      calibrated_by_employee_id: calibrated_by_employee_id,
    },
  });

  // Update the main review rating
  await prisma.performanceReview.update({
    where: { id: reviewId },
    data: { overall_rating: new_rating },
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
export const getAllCalibrationSessionsService = async () => {
  return prisma.calibrationSession.findMany({
    include: {
      ratingAdjustments: true,
      cycle: true,
    },
    orderBy: { created_at: "desc" },
  });
};

// 🟢 Finalize a calibration session
export const finalizeCalibrationService = async (id, finalizedBy) => {
  const session = await prisma.calibrationSession.findUnique({
    where: { id: Number(id) },
  });
  if (!session) throw new Error("Calibration session not found");

  const update = await prisma.calibrationSession.update({
    where: { id: Number(id) },
    data: {
      status: "COMPLETED",
      completed_at: new Date(),
    },
  });

  // Optionally, mark all reviews in that cycle as FINALIZED
  await prisma.performanceReview.updateMany({
    where: { cycleId: session.cycleId },
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
