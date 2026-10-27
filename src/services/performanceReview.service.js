import { getCtx } from '../mcp/context.js';
import { actor } from './separation/base.js';
import { legacySubmit } from "./approval/legacy.js";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { logAction } from "../utils/logs.js";
import { scopedWhere, scopedData, scopedEmployeeWhere } from "../lib/tenancy.js";
import { conflict, notFound, perfError } from "../lib/performance-errors.js";
import {
  initiateReviewsSchema,
  parsePerformancePayload,
  reminderSchema,
  reviewSubmitSchema,
} from "../validators/performance.schema.js";

// C.2 — verified tenant (T-P2.1) threaded in as a trailing `tenantId`; folded
// into every read and stamped on every create, fail-closed when present.
//
// PERF-P0 (E-01 / D2): the bulk initiate used to embed a `reviewer: { select }`
// relation block inside createMany row data (Prisma rejects it) and ran no
// duplicate, cycle-status or employee checks. It is now idempotent: an employee
// who already holds a review of that type in the cycle is reported as skipped,
// never duplicated — the unique (tenantId, employeeId, cycleId, type) index is
// the race-proof backstop. The finalized domain event is emitted by the
// Approval Centre adapter (E-03), the only place a review becomes FINALIZED.

// 1️⃣ Create or initiate reviews
export const initiateReviewsService = async (cycleId, employeeIds, reviewedBy, tenantId, reviewType) => {
  const input = parsePerformancePayload(initiateReviewsSchema, { cycleId, employeeIds, reviewType });
  const type = input.reviewType ?? "SELF";
  const ids = [...new Set(input.employeeIds.map(Number))];

  const result = await tenantTransaction(
    prisma,
    async (tx) => {
      const cycle = await tx.performanceCycle.findFirst({
        where: scopedWhere(tenantId, { id: input.cycleId, archivedAt: null }),
        select: { id: true, status: true, start_date: true, end_date: true },
      });
      if (!cycle) throw notFound("Performance cycle");
      if (cycle.status === "CLOSED") throw conflict("The performance cycle is closed");

      const employees = await tx.employee.findMany({
        where: scopedEmployeeWhere(tenantId, { id: { in: ids } }),
        select: { id: true },
      });
      const known = new Set(employees.map((e) => e.id));
      const unknown = ids.filter((id) => !known.has(id));
      if (unknown.length)
        throw perfError(`Unknown employee id(s): ${unknown.join(", ")}`, 404, "HR-4040");

      const existing = await tx.performanceReview.findMany({
        where: scopedWhere(tenantId, { cycleId: cycle.id, type, employeeId: { in: ids } }),
        select: { employeeId: true },
      });
      const already = new Set(existing.map((r) => r.employeeId));
      const toCreate = ids.filter((id) => !already.has(id));

      const data = toCreate.map((empId) =>
        scopedData(tenantId, {
          employeeId: empId,
          cycleId: cycle.id,
          reviewerId: reviewedBy ? Number(reviewedBy) : null,
          type,
          status: "DRAFT",
          period_start: cycle.start_date,
          period_end: cycle.end_date,
        })
      );
      const created = data.length
        ? await tx.performanceReview.createMany({ data, skipDuplicates: true })
        : { count: 0 };

      return { count: created.count, skipped: ids.length - created.count, cycleId: cycle.id, type };
    },
    { tenantId }
  );

  await logAction({
    employeeId: Number(reviewedBy),
    type: "CREATE",
    module: "Performance Review",
    result: "SUCCESS",
    notes: `Initiated ${result.count} ${type} review(s) for cycle ${result.cycleId} (${result.skipped} already existed)`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return result;
};

// 2️⃣ Submit self/manager/peer review
export const submitReviewService = async (id, body, submittedBy, tenantId) => {
  const ctx = getCtx();
  if (!ctx.actorVerified) throw perfError('Verified employee identity required', 401);
  const input = parsePerformancePayload(reviewSubmitSchema, body);
  const rating = input.overall_rating ?? input.overallRating;
  await tenantTransaction(prisma, async tx => {
    const who = await actor(tx, ctx);
    const review = await tx.performanceReview.findFirst({ where: { id: Number(id), tenantId: ctx.user.tenantId } });
    if (!review || review.employeeId !== who.id) throw perfError('Only the employee initiator can submit this appraisal', 403);
    if (review.status === 'FINALIZED') throw conflict('The appraisal is already finalized');
    const request = await tx.hrApprovalRequest.findUnique({ where: { tenantId_kind_sourceRef: { tenantId: ctx.user.tenantId, kind: 'PERFORMANCE', sourceRef: String(id) } } });
    if (request && request.stage !== 'INITIATOR') throw conflict('The appraisal is already in review');
    await tx.performanceReview.update({
      where: { id: review.id },
      data: {
        comments: input.comments ?? review.comments,
        overall_rating: rating ?? review.overall_rating,
        submittedAt: new Date(),
        status: review.status === 'DRAFT' ? 'IN_PROGRESS' : review.status,
      },
    });
  }, { tenantId: ctx.user.tenantId });
  return legacySubmit('PERFORMANCE', id);
};

// 3️⃣ Get all reviews for a cycle
export const getCycleReviewsService = async (cycleId, tenantId) => {
  if (!cycleId) throw perfError("cycleId is required", 400, "HR-4000");
  return prisma.performanceReview.findMany({
    where: scopedWhere(tenantId, { cycleId: Number(cycleId) }),
    include: {
      employee: true,
      reviewer: true,
      feedbacks: true,
    },
    orderBy: [{ updated_at: "desc" }, { id: "desc" }],
  });
};

// 4️⃣ Send reminder (manual). One reminder of a type per recipient per day —
// a repeat call within the day returns the existing row instead of a second.
export const sendReviewReminderService = async (reviewId, sentToId, type, sentBy, tenantId) => {
  const input = parsePerformancePayload(reminderSchema, { reviewId, sentToId, type });
  const reminderType = input.type ?? "PENDING_REVIEW";

  const review = await prisma.performanceReview.findFirst({
    where: scopedWhere(tenantId, { id: input.reviewId }),
    select: { id: true, status: true },
  });
  if (!review) throw notFound("Review");
  if (review.status === "FINALIZED") throw conflict("The review is already finalized");

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const existing = await prisma.reviewReminder.findFirst({
    where: scopedWhere(tenantId, {
      reviewId: input.reviewId,
      sentToId: input.sentToId,
      type: reminderType,
      sentAt: { gte: startOfDay },
    }),
  });
  if (existing) return { ...existing, duplicate: true };

  const createReminder = await prisma.reviewReminder.create({
    data: scopedData(tenantId, { reviewId: input.reviewId, sentToId: input.sentToId, type: reminderType }),
  });
  await logAction({
    employeeId: Number(sentBy),
    type: "CREATE",
    module: "Performance Review",
    result: "SUCCESS",
    notes: `Reminder ${reminderType} sent for review ${input.reviewId} to employee ${input.sentToId}`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return createReminder;
};
