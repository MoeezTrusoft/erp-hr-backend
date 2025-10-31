import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// 🟢 Create calibration session
export const createCalibrationSessionService = async (data) => {
  const { name, cycleId } = data;
  if (!name || !cycleId) throw new Error("name and cycleId are required");

  return prisma.calibrationSession.create({
    data: { name, cycleId },
  });
};

// 🟢 Add rating adjustment
export const adjustRatingService = async (data) => {
  const { reviewId, old_rating, new_rating, justification, calibrated_by_employee_id } = data;
  console.log(data);
  
  if (!reviewId || !new_rating || ! calibrated_by_employee_id)
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
      calibrated_by_employee_id,
    },
  });

  // Update the main review rating
  await prisma.performanceReview.update({
    where: { id: reviewId },
    data: { overall_rating: new_rating },
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
export const finalizeCalibrationService = async (id) => {
  const session = await prisma.calibrationSession.findUnique({
    where: { id: Number(id) },
  });
  if (!session) throw new Error("Calibration session not found");

  await prisma.calibrationSession.update({
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

  return { message: "Calibration session finalized successfully" };
};
