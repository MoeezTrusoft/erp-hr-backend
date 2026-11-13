import { z } from "zod";
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
  if(!tenantId || !Array.isArray(employeeIds) || !employeeIds.length || employeeIds.length>10000) throw Object.assign(new Error('Verified tenant and eligible employees are required'),{status:422});
  const create=await tenantTransaction(prisma,async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId+':legacy-launch:'+cycleId},0))`;
    const cycle=await tx.performanceCycle.findFirst({where:{id:Number(cycleId),tenantId}});
    if(!cycle)throw Object.assign(new Error('Cycle not found'),{status:404});
    const ids=[...new Set(employeeIds.map(Number))];
    if(ids.some(id=>!Number.isSafeInteger(id)||id<1))throw Object.assign(new Error('Invalid employee identifiers'),{status:422});
    const employees=await tx.employee.findMany({where:{tenant_id:tenantId,id:{in:ids}}});
    if(employees.length!==ids.length)throw Object.assign(new Error('Employee not found'),{status:404});
    const existing=await tx.performanceReview.findMany({where:{tenantId,cycleId:cycle.id,type:'SELF'},select:{employeeId:true}});
    const seen=new Set(existing.map(r=>r.employeeId));
    return tx.performanceReview.createMany({data:employees.filter(e=>!seen.has(e.id)).map(e=>({tenantId,employeeId:e.id,cycleId:cycle.id,reviewerId:e.managerId,type:'SELF',status:'DRAFT',period_start:cycle.start_date,period_end:cycle.end_date}))});
  },{tenantId,txOptions:{isolationLevel:'Serializable'}});

  await logAction({
    employeeId: Number(reviewedBy),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Performance Review",
    result: "SUCCESS",
    notes: `${create.count} performance reviews created`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return create;


};

// 2️⃣ Submit self/manager/peer review
export const submitReviewService = async (id, body, submittedBy, tenantId) => {
  const input = z.object({ comments: z.string().max(16000).optional(),
    overall_rating: z.number().min(0).max(5).optional() }).strict().parse(body);
  const ctx = getCtx();
  if (!ctx.actorVerified || !ctx.user?.tenantId)
    throw Object.assign(new Error('Verified employee identity required'), { status: 401 });
  if (tenantId && tenantId !== ctx.user.tenantId)
    throw Object.assign(new Error('Company mismatch'), { status: 403 });
  return legacySubmit('PERFORMANCE', id, 'Employee submitted the appraisal', {
    prepare: async (tx, env) => {
      const review = await tx.performanceReview.findFirst({ where: { id: Number(id), tenantId: env.tenantId } });
      if (!review || review.employeeId !== env.who.id)
        throw Object.assign(new Error('Only the employee initiator can submit this appraisal'), { status: 403 });
      if (review.status === 'FINALIZED')
        throw Object.assign(new Error('Finalized appraisals are immutable'), { status: 409 });
      await tx.performanceReview.update({ where: { id: review.id }, data: input });
    },
  });
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
