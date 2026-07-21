import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { logAction } from "../utils/logs.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { performanceReviewFinalizedEvent } from "./hrEvents.js";

// C.2 — verified tenant (T-P2.1) threaded in as a trailing `tenantId`; folded
// into every read and stamped on every create, fail-closed when present.

// 1️⃣ Create or initiate reviews
export const initiateReviewsService = async (cycleId, employeeIds, reviewedBy, tenantId) => {
  const data = employeeIds.map(empId => scopedData(tenantId, {
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
export const submitReviewService = async (id, body, submittedBy, tenantId) => {
  const { comments, overall_rating } = body;

  const review = await prisma.performanceReview.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!review) throw new Error("Review not found");

  // M1-HR: the review FINALIZED flip + hr.performance.review_finalized.v1
  // outbox event are atomic (outbox-on-write, validate-before-write). Ids-only,
  // tenant-scoped from the review's verified tenant.
  const submitted = await tenantTransaction(prisma, async (tx) => {
    const row = await tx.performanceReview.update({
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

    const event = performanceReviewFinalizedEvent(
      { id: Number(id), employeeId: review.employeeId, cycleId: review.cycleId, rating: overall_rating ?? null, tenantId: review.tenantId ?? tenantId },
      { actorId: submittedBy }
    );
    if (event) await enqueueHrDomainEvent(tx, event);

    return row;
  });

  await logAction({
    employeeId: Number(submittedBy),
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Performance Review",
    result: "SUCCESS",
    notes: `Performance Review "${id}" Updated successfully`,
  });

  return submitted
};

// 3️⃣ Get all reviews for a cycle
export const getCycleReviewsService = async (cycleId, tenantId) => {
  return prisma.performanceReview.findMany({
    where: scopedWhere(tenantId, { cycleId: Number(cycleId) }),
    include: {
      employee: true,
      reviewer: true,
      feedbacks: true,
    },
  });
};

// 4️⃣ Send reminder
export const sendReviewReminderService = async (reviewId, sentToId, sentBy, tenantId) => {
  const createReminder = await prisma.reviewReminder.create({
    data: scopedData(tenantId, { reviewId: Number(reviewId), sentToId: Number(sentToId), type: "PENDING_REVIEW" }),
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
