import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// 1️⃣ Create or initiate reviews
export const initiateReviewsService = async (cycleId, employeeIds, reviewerId) => {
  const data = employeeIds.map(empId => ({
    employeeId: empId,
    cycleId,
    reviewerId,
    type: "SELF",
    status: "DRAFT"
  }));

  return prisma.performanceReview.createMany({ data });


};

// 2️⃣ Submit self/manager/peer review
export const submitReviewService = async (id, body) => {
  const { comments, overall_rating } = body;

  const review = await prisma.performanceReview.findUnique({ where: { id: Number(id) } });
  if (!review) throw new Error("Review not found");

  return prisma.performanceReview.update({
    where: { id: Number(id) },
    data: {
      comments,
      overall_rating,
      status: "FINALIZED",
    //  submittedAt: new Date(),
    },
  });
};

// 3️⃣ Get all reviews for a cycle
export const getCycleReviewsService = async (cycleId) => {
  return prisma.performanceReview.findMany({
    where: { cycleId: Number(cycleId) },
    include: {
      employee: true,
      reviewer: true,
      feedbacks: true,
    },
  });
};

// 4️⃣ Send reminder
export const sendReviewReminderService = async (reviewId, sentToId) => {
  return prisma.reviewReminder.create({
    data: { reviewId: Number(reviewId), sentToId: Number(sentToId), type :"PENDING_REVIEW" },
  });
};
