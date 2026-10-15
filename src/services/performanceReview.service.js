import { getCtx } from '../mcp/context.js';
import { actor } from './separation/base.js';
import { legacySubmit } from "./approval/legacy.js";
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
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return create;


};

// 2️⃣ Submit self/manager/peer review
export const submitReviewService = async (id, body, submittedBy, tenantId) => {
  const ctx=getCtx();
  if(!ctx.actorVerified)throw Object.assign(new Error('Verified employee identity required'),{status:401});
  await tenantTransaction(prisma,async tx=>{
    const who=await actor(tx,ctx);
    const review=await tx.performanceReview.findFirst({where:{id:Number(id),tenantId:ctx.user.tenantId}});
    if(!review || review.employeeId!==who.id)throw Object.assign(new Error('Only the employee initiator can submit this appraisal'),{status:403});
    const request=await tx.hrApprovalRequest.findUnique({where:{tenantId_kind_sourceRef:{tenantId:ctx.user.tenantId,kind:'PERFORMANCE',sourceRef:String(id)}}});
    if(request&&request.stage!=='INITIATOR')throw Object.assign(new Error('The appraisal is already in review'),{status:409});
    await tx.performanceReview.update({where:{id:review.id},data:{comments:body.comments,overall_rating:body.overall_rating}});
  },{tenantId:ctx.user.tenantId});
  return legacySubmit('PERFORMANCE',id);
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
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return createReminder;
};
