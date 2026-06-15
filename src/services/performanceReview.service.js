import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";

// 1️⃣ Create or initiate reviews
export const initiateReviewsService = async (cycleId, employeeIds, reviewedBy) => {
  const data = employeeIds.map(empId => ({
    employeeId: empId,
    cycleId,
    reviewerId: Number(reviewedBy),
    type: "SELF",
    status: "DRAFT",
    reviewer: {
      select: {
        id: true,
        first_name: true,
        last_name: true
      }
    },
  })

  );

  const create = await prisma.performanceReview.createMany({ data });

  await logAction({
    employeeId: Number(reviewedBy),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Performance Review",
    result: "SUCCESS",
    notes: `Performance Review "${create.id}" Created successfully`,
  });

  return create;


};

// 2️⃣ Submit self/manager/peer review
export const submitReviewService = async (id, body, submittedBy) => {
  const { comments, overall_rating } = body;

  const review = await prisma.performanceReview.findUnique({ where: { id: Number(id) } });
  if (!review) throw new Error("Review not found");

  const submitted = await prisma.performanceReview.update({
    where: { id: Number(id) },
    data: {
      comments,
      overall_rating,
      status: "FINALIZED",
      submittedById: Number(submittedBy)
      //  submittedAt: new Date(),
    },
    submittedBy: {
      select: {
        id: true,
        first_name: true,
        last_name: true
      }
    },
  });

  await logAction({
    employeeId: Number(reviewedBy),
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Performance Review",
    result: "SUCCESS",
    notes: `Performance Review "${id}" Updated successfully`,
  });

  return submitted
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
export const sendReviewReminderService = async (reviewId, sentToId, sentBy) => {
  const createReminder = await prisma.reviewReminder.create({
    data: { reviewId: Number(reviewId), sentToId: Number(sentToId), type: "PENDING_REVIEW" },
  });
   await logAction({
    employeeId: Number(sentBy),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Performance Review",
    result: "SUCCESS",
    notes: `Performance Review Reminder Sent successfully`,
  });

  return createReminder;
};
