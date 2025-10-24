import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// ✅ Create new performance review
export const createPerformanceReview = async (data) => {
  const { employeeId, reviewerId, period_start, period_end, comments } = data;

  if (!employeeId || !period_start || !period_end)
    throw new Error("employeeId, period_start, and period_end are required");

  return prisma.performanceReview.create({
    data: {
      employeeId: Number(employeeId),
      reviewerId: reviewerId ? Number(reviewerId) : null,
      period_start: new Date(period_start),
      period_end: new Date(period_end),
      comments,
    },
  });
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

  return prisma.performanceReview.update({
    where: { id: Number(id) },
    data: {
      overall_rating: data.overall_rating ?? existing.overall_rating,
      comments: data.comments ?? existing.comments,
      status: data.status ?? existing.status,
    },
  });
};

// ✅ Add feedback to a review
export const addFeedback = async (data) => {
  const { reviewId, reviewerId, feedback, rating } = data;
  if (!reviewId || !reviewerId || !feedback)
    throw new Error("reviewId, reviewerId, and feedback are required");

  return prisma.reviewFeedback.create({
    data: {
      reviewId: Number(reviewId),
      reviewerId: Number(reviewerId),
      feedback,
      rating: rating ? Number(rating) : null,
    },
  });
};


export const updateFeedback = async (id,data) => {
    const { reviewId, reviewerId, feedback, rating } = data;

    const existing = await prisma.reviewFeedback.findUnique({ where: { id: Number(id) } });
  if (!existing) throw new Error("Feed Back not found");

  return prisma.reviewFeedback.update({
      where: { id: Number(id) },
    data: {
       reviewId:  existing.reviewId,
      reviewerId: existing.reviewerId,
      feedback,
      rating: Number(rating),
    },
  });
};

export const deleteFeedback = async (id) => {
  const existing = await prisma.reviewFeedback.findUnique({ where: { id: Number(id) } });
  if (!existing) throw new Error("FeedBack not found");

  await prisma.reviewFeedback.delete({ where: { id: Number(id) } });
  return { message: "Feedback deleted successfully" };
};
