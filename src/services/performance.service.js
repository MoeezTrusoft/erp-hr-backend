import { PrismaClient } from "@prisma/client";
import { logAction } from "../utils/logs.js";

const prisma = new PrismaClient();

// ✅ Create new performance review
export const createPerformanceReview = async (data) => {
  const { employeeId, reviewerId, period_start, period_end,cycleId, comments } = data;

  if (!employeeId || !period_start || !period_end)
    throw new Error("employeeId, period_start, and period_end are required");

  const create = await prisma.performanceReview.create({
    data: {
      employeeId: Number(employeeId),
      reviewerId: reviewerId ? Number(reviewerId) : null,
      cycleId: cycleId ? Number(cycleId) :null,
      period_start: new Date(period_start),
      period_end: new Date(period_end),
      comments,
    },
  });
  // Log the update action
  await logAction({
    employeeId: 1,
    type: "Performance Create", // 👈 changed from CREATE to UPDATE
    module: "performance",
    result: "SUCCESS",
    notes: `Performance "${employeeId}" created successfully`,
  });

  return create;
};

// ✅ Get all reviews (admin or HR)
export const getAllReviews = async () => {
  return prisma.performanceReview.findMany({
    include: {
      employee: true,
      reviewer: true,
      feedbacks: true,
    },
    orderBy: { updated_at: "desc" },
  });
};

// ✅ Get reviews by employee (for employee dashboard)
export const getReviewsByEmployee = async (employeeId) => {
  return prisma.performanceReview.findMany({
    where: { employeeId: Number(employeeId) },
    include: { reviewer: true, feedbacks: true },
    orderBy: { updated_at: "desc" },
  });
};

// ✅ Update review (e.g., finalize)
export const updateReview = async (id, data) => {
  const existing = await prisma.performanceReview.findUnique({ where: { id: Number(id) } });
  if (!existing) throw new Error("Review not found");

  const updated = await prisma.performanceReview.update({
    where: { id: Number(id) },
    data: {
      overall_rating: data.overall_rating ?? existing.overall_rating,
      comments: data.comments ?? existing.comments,
      status: data.status ?? existing.status,
    },
  });

  // Log the update action
  await logAction({
    employeeId: 1,
    type: "UPDATE", // 👈 changed from CREATE to UPDATE
    module: "Review in Performnace",
    result: "SUCCESS",
    notes: `Performance "${id}" updated successfully`,
  });
  return updated;
};

// ✅ Add feedback to a review
export const addFeedback = async (data) => {
  const { reviewId, reviewerId, feedback, rating } = data;
  if (!reviewId || !reviewerId || !feedback)
    throw new Error("reviewId, reviewerId, and feedback are required");

  const create = await prisma.reviewFeedback.create({
    data: {
      reviewId: Number(reviewId),
      reviewerId: Number(reviewerId),
      feedback,
      rating: rating ? Number(rating) : null,
    },
  });
  // Log the update action
  await logAction({
    employeeId: 1,
    type: "Create Feed Back", // 👈 changed from CREATE to UPDATE
    module: "Performance",
    result: "SUCCESS",
    notes: `Feed Back "${1}" updated successfully`,
  });

  return create;
};


export const updateFeedback = async (id, data) => {
  const { reviewId, reviewerId, feedback, rating } = data;

  const existing = await prisma.reviewFeedback.findUnique({ where: { id: Number(id) } });
  if (!existing) throw new Error("Feed Back not found");

  const updated = await prisma.reviewFeedback.update({
    where: { id: Number(id) },
    data: {
      reviewId: existing.reviewId,
      reviewerId: existing.reviewerId,
      feedback,
      rating: Number(rating),
    },
  });
  // Log the update action
  await logAction({
    employeeId: 1,
    type: "UPDATE", // 👈 changed from CREATE to UPDATE
    module: "Performance Feed Back",
    result: "SUCCESS",
    notes: `Feed back "${id}" updated successfully`,
  });
  return updated;
};

export const deleteFeedback = async (id) => {
  const existing = await prisma.reviewFeedback.findUnique({ where: { id: Number(id) } });
  if (!existing) throw new Error("FeedBack not found");

  const deleted = await prisma.reviewFeedback.delete({ where: { id: Number(id) } });

 // Log the update action
  await logAction({
    employeeId: 1,
    type: "UPDATE", // 👈 changed from CREATE to UPDATE
    module: "Performance Feed Back",
    result: "SUCCESS",
    notes: `Feed Back "${id}" Deleted successfully`,
  });
  return deleted;
};
