import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import { scopedWhere, scopedData, scopedEmployeeWhere } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { conflict, isUniqueViolation, mean, notFound, round2 } from "../lib/performance-errors.js";
import {
  feedbackCreateSchema,
  feedbackUpdateSchema,
  parsePerformancePayload,
  reviewCreateSchema,
  reviewUpdateSchema,
} from "../validators/performance.schema.js";

// C.2 — the verified tenant (RBAC Company.uuid; T-P2.1) is threaded in from the
// controller as a trailing `tenantId` and folded into every read predicate and
// stamped on every create. `undefined` = legacy/no-scope (back-compat for
// existing callers/tests); a present value (incl. null) is fail-closed so
// tenant B can never read/mutate tenant A's performance rows for the same id.
//
// PERF-P0 (E-01/E-02/E-04): every payload is parsed against
// src/validators/performance.schema.js; the create/update calls no longer carry
// the phantom `createdById` / `updatedById` columns or a top-level `createdBy`
// select (D1) — both made Prisma reject the query, so review creation and
// feedback never worked. Review STATUS is no longer writable here (D4): the
// only path to FINALIZED is the PERFORMANCE adapter of the HR Approval Centre.

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

// Nine-box: an employee whose mean rating is below this is plotted as HIGH
// risk. Kept as a named constant (was an inline 2.5) until a template-defined
// band map lands (P1 scope).
export const NINE_BOX_RISK_THRESHOLD = 2.5;

const pageArgs = ({ page, limit, pageSize } = {}) => {
  const size = Number(limit ?? pageSize);
  const take = Number.isFinite(size) && size > 0 ? Math.min(size, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  const p = Number(page);
  const current = Number.isFinite(p) && p > 0 ? Math.floor(p) : 1;
  return { take, skip: (current - 1) * take, page: current };
};

const assertEmployee = async (db, tenantId, employeeId, what = "Employee") => {
  const employee = await db.employee.findFirst({
    where: scopedEmployeeWhere(tenantId, { id: Number(employeeId) }),
    select: { id: true },
  });
  if (!employee) throw notFound(what);
  return employee;
};

const assertOpenCycle = async (db, tenantId, cycleId) => {
  const cycle = await db.performanceCycle.findFirst({
    where: scopedWhere(tenantId, { id: Number(cycleId), archivedAt: null }),
    select: { id: true, status: true, start_date: true, end_date: true },
  });
  if (!cycle) throw notFound("Performance cycle");
  if (cycle.status === "CLOSED") throw conflict("The performance cycle is closed");
  return cycle;
};

// ✅ Create new performance review
export const createPerformanceReview = async (data, createdBy, tenantId) => {
  const input = parsePerformancePayload(reviewCreateSchema, data);
  const { employeeId, reviewerId, period_start, period_end, cycleId, comments, reviewType } = input;
  const type = reviewType ?? "SELF";

  const create = await tenantTransaction(
    prisma,
    async (tx) => {
      await assertEmployee(tx, tenantId, employeeId);
      if (reviewerId != null) await assertEmployee(tx, tenantId, reviewerId, "Reviewer");
      if (cycleId != null) await assertOpenCycle(tx, tenantId, cycleId);

      // One review per (employee, cycle, type). The DB unique index is the
      // race-proof guard for a cycle-bound review; a review with no cycle is
      // de-duplicated here (NULL cycleId is distinct for the index).
      const duplicate = await tx.performanceReview.findFirst({
        where: scopedWhere(tenantId, {
          employeeId: Number(employeeId),
          cycleId: cycleId != null ? Number(cycleId) : null,
          type,
        }),
        select: { id: true },
      });
      if (duplicate)
        throw conflict(`A ${type} review already exists for this employee in this cycle`);

      try {
        return await tx.performanceReview.create({
          data: scopedData(tenantId, {
            employeeId: Number(employeeId),
            reviewerId: reviewerId != null ? Number(reviewerId) : null,
            cycleId: cycleId != null ? Number(cycleId) : null,
            period_start: new Date(period_start),
            period_end: new Date(period_end),
            comments: comments ?? null,
            type,
          }),
        });
      } catch (err) {
        if (isUniqueViolation(err))
          throw conflict(`A ${type} review already exists for this employee in this cycle`);
        throw err;
      }
    },
    { tenantId }
  );

  await logAction({
    employeeId: createdBy,
    type: "CREATE",
    module: "Performance Review",
    result: "SUCCESS",
    notes: `Performance review ${create.id} created for employee ${employeeId}`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return create;
};

// ✅ Get all reviews (admin or HR) — paginated at the database (D17).
export const getAllReviews = async (tenantId, query = {}) => {
  const { take, skip, page } = pageArgs(query);
  const where = scopedWhere(tenantId, {
    ...(query.cycleId ? { cycleId: Number(query.cycleId) } : {}),
    ...(query.status ? { status: String(query.status) } : {}),
    ...(query.employeeId ? { employeeId: Number(query.employeeId) } : {}),
  });
  const [items, total] = await Promise.all([
    prisma.performanceReview.findMany({
      where,
      include: {
        employee: true,
        reviewer: true,
        feedbacks: true,
        // Per-metric scored items back the Strength / Development-area panels:
        // high-rated metrics are strengths, low-rated ones are development areas.
        performanceReviewItems: { include: { metric: { select: { name: true, category: true } } } },
      },
      orderBy: [{ updated_at: "desc" }, { id: "desc" }],
      take,
      skip,
    }),
    prisma.performanceReview.count({ where }),
  ]);
  return { items, total, page, limit: take };
};

// Per-employee nine-box aggregate for the Performance Analytics grid.
// The HR FE's Analytics screen categorises EMPLOYEES on a performance ×
// potential matrix, but the raw `performanceMetric` catalog carries no
// per-employee ratings — so the grid rendered empty. Here we derive each
// employee's ratings from their scored reviews (tenant-scoped, fail-closed):
//   • performanceRating — mean overall_rating across the employee's reviews
//                          (optionally one cycle via `cycleId`)
//   • potentialRating   — mean rating of "Leadership"/"Potential" competency
//                          items (falls back to performanceRating when none)
//   • riskLevel         — HIGH when performanceRating < NINE_BOX_RISK_THRESHOLD
// Returns a `{ items }` envelope shaped for the FE `mapPerformanceMetric`
// aliasing (name / performanceRating / potentialRating / riskLevel).
export const getEmployeeNineBox = async (tenantId, { cycleId } = {}) => {
  const reviews = await prisma.performanceReview.findMany({
    where: scopedWhere(tenantId, {
      employeeId: { not: null },
      overall_rating: { not: null },
      ...(cycleId ? { cycleId: Number(cycleId) } : {}),
    }),
    select: {
      employeeId: true,
      overall_rating: true,
      employee: { select: { id: true, first_name: true, last_name: true, employee_name: true } },
      performanceReviewItems: {
        select: { rating: true, metric: { select: { category: true } } },
      },
    },
  });

  const byEmployee = new Map();
  for (const review of reviews) {
    const key = review.employeeId;
    if (!byEmployee.has(key)) {
      byEmployee.set(key, { employee: review.employee, perf: [], potential: [] });
    }
    const bucket = byEmployee.get(key);
    if (typeof review.overall_rating === "number") bucket.perf.push(review.overall_rating);
    for (const item of review.performanceReviewItems || []) {
      if (typeof item.rating !== "number") continue;
      const category = (item.metric?.category || "").toLowerCase();
      if (category.includes("leadership") || category.includes("potential")) {
        bucket.potential.push(item.rating);
      }
    }
  }

  const items = [];
  for (const { employee, perf, potential } of byEmployee.values()) {
    const performanceRating = mean(perf);
    if (performanceRating == null) continue; // no scored review → not plottable
    const potentialRating = mean(potential) ?? performanceRating;
    const name =
      employee?.employee_name ||
      [employee?.first_name, employee?.last_name].filter(Boolean).join(" ").trim() ||
      `Employee ${employee?.id ?? ""}`.trim();
    items.push({
      id: employee?.id,
      name,
      performanceRating: round2(performanceRating),
      potentialRating: round2(potentialRating),
      riskLevel: performanceRating < NINE_BOX_RISK_THRESHOLD ? "HIGH" : "LOW",
    });
  }

  return { items, total: items.length };
};

// ✅ Get reviews by employee (for employee dashboard)
export const getReviewsByEmployee = async (employeeId, tenantId) => {
  await assertEmployee(prisma, tenantId, employeeId);

  return prisma.performanceReview.findMany({
    where: scopedWhere(tenantId, { employeeId: Number(employeeId) }),
    include: { reviewer: true, feedbacks: true, cycle: { select: { id: true, name: true, status: true } } },
    orderBy: [{ updated_at: "desc" }, { id: "desc" }],
  });
};

// ✅ Update review narrative / rating. STATUS is intentionally not accepted
// (E-02): finalisation is the Approval Centre's PERFORMANCE adapter only.
export const updateReview = async (id, data, updatedBy, tenantId) => {
  const input = parsePerformancePayload(reviewUpdateSchema, data);

  // Tenant-scoped pre-read: a cross-tenant id resolves to not-found, never
  // another tenant's review — and we never mutate it (fail-closed).
  const existing = await prisma.performanceReview.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!existing) throw notFound("Review");
  if (existing.status === "FINALIZED")
    throw conflict("A finalized review is immutable; open a correction through the Approval Centre");

  const nextRating = input.overallRating ?? input.overall_rating;
  const updated = await prisma.performanceReview.update({
    where: { id: Number(id) },
    data: {
      overall_rating: nextRating ?? existing.overall_rating,
      comments: input.comments ?? existing.comments,
    },
  });

  await logAction({
    employeeId: updatedBy,
    type: "UPDATE",
    module: "Performance Review",
    result: "SUCCESS",
    notes: `Performance review ${id} updated`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });
  return updated;
};

// ✅ Add feedback to a review
export const addFeedback = async (data, createdBy, tenantId) => {
  const { reviewId, reviewerId, feedback, rating } = parsePerformancePayload(
    feedbackCreateSchema,
    data
  );

  // D5: the review id used to be validated as an EMPLOYEE id.
  const review = await prisma.performanceReview.findFirst({
    where: scopedWhere(tenantId, { id: Number(reviewId) }),
    select: { id: true, status: true },
  });
  if (!review) throw notFound("Review");
  await assertEmployee(prisma, tenantId, reviewerId, "Reviewer");

  const create = await prisma.reviewFeedback.create({
    data: scopedData(tenantId, {
      reviewId: Number(reviewId),
      reviewerId: Number(reviewerId),
      feedback,
      rating: rating ?? null,
    }),
  });

  await logAction({
    employeeId: createdBy,
    type: "CREATE",
    module: "Performance Feedback",
    result: "SUCCESS",
    notes: `Feedback ${create.id} added to review ${reviewId}`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return create;
};

export const updateFeedback = async (id, data, updatedBy, tenantId) => {
  const input = parsePerformancePayload(feedbackUpdateSchema, data);

  const existing = await prisma.reviewFeedback.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!existing) throw notFound("Feedback");

  const updated = await prisma.reviewFeedback.update({
    where: { id: Number(id) },
    data: {
      feedback: input.feedback ?? existing.feedback,
      // D-list: `Number(undefined)` used to write NaN; an omitted rating keeps
      // the stored one, an explicit null clears it.
      rating: input.rating === undefined ? existing.rating : input.rating,
    },
  });

  await logAction({
    employeeId: updatedBy,
    type: "UPDATE",
    module: "Performance Feedback",
    result: "SUCCESS",
    notes: `Feedback ${id} updated`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });
  return updated;
};

export const deleteFeedback = async (id, deletedBy, tenantId) => {
  const existing = await prisma.reviewFeedback.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!existing) throw notFound("Feedback");

  const deleted = await prisma.reviewFeedback.delete({ where: { id: Number(id) } });

  await logAction({
    employeeId: deletedBy,
    type: "DELETE",
    module: "Performance Feedback",
    result: "SUCCESS",
    notes: `Feedback ${id} deleted`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });
  return { ...deleted, message: `Feedback ${id} deleted` };
};
