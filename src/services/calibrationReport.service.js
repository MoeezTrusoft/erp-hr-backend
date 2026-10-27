import prisma from "../lib/prisma.js";
import { scopedWhere } from "../lib/tenancy.js";
import { mean, round2 } from "../lib/performance-errors.js";

// C.2-completion — verified tenant (T-P2.1) threaded via a trailing `tenantId`;
// every calibration aggregate is computed over tenant-scoped reads only, so a
// tenant never sees another tenant's ratings folded into its calibration stats.
//
// PERF-P0 (E-01 / D7): three of the four reports queried columns that do not
// exist (Employee.currentRating, PerformanceReview.managerId) or a relation
// under the wrong name (`review` instead of `performance_review`), so they threw
// on every call. They now aggregate from the review rows themselves:
//   * "before" = the rating a review carried before its FIRST adjustment (or its
//     current rating when it was never adjusted),
//   * "after"  = the current rating of every review in scope (a blended
//     population mean, not the mean of adjusted rows only).

const scopedRatedReviews = (tenantId, extra = {}) =>
  prisma.performanceReview.findMany({
    where: scopedWhere(tenantId, { overall_rating: { not: null }, ...extra }),
    select: {
      id: true,
      overall_rating: true,
      reviewerId: true,
      cycleId: true,
      // Employee carries no department column; the business unit is the org unit.
      employee: { select: { businessUnitId: true } },
      RatingAdjustment: {
        select: { old_rating: true, new_rating: true, created_at: true },
        orderBy: { created_at: "asc" },
      },
    },
  });

const beforeAfter = (reviews) => {
  const before = [];
  const after = [];
  let adjusted = 0;
  for (const r of reviews) {
    const first = r.RatingAdjustment?.[0];
    if (first) adjusted += 1;
    before.push(first ? first.old_rating : r.overall_rating);
    after.push(r.overall_rating);
  }
  const avgBefore = mean(before) ?? 0;
  const avgAfter = mean(after) ?? 0;
  return {
    totalReviews: reviews.length,
    adjustedReviews: adjusted,
    averageBefore: round2(avgBefore),
    averageAfter: round2(avgAfter),
    improvement: round2(avgAfter - avgBefore),
  };
};

/**
 * 1️⃣ Overall Distribution
 */
export const getCalibrationOverviewService = async (tenantId) => {
  const reviews = await scopedRatedReviews(tenantId);
  return beforeAfter(reviews);
};

/**
 * 2️⃣ Average by Department (the reviewed employee's business unit; the
 *    `departmentId` key is kept for API compatibility)
 */
export const getAverageByDepartmentService = async (tenantId) => {
  const reviews = await scopedRatedReviews(tenantId);
  const groups = new Map();
  for (const r of reviews) {
    const key = r.employee?.businessUnitId ?? null;
    if (!groups.has(key)) groups.set(key, { ratings: [] });
    const g = groups.get(key);
    g.ratings.push(r.overall_rating);
  }
  return [...groups.entries()].map(([departmentId, g]) => ({
    departmentId,
    businessUnitId: departmentId,
    averageRating: round2(mean(g.ratings) ?? 0),
    totalReviews: g.ratings.length,
  }));
};

/**
 * 3️⃣ Average by Manager (the reviewer who rated)
 */
export const getAverageByManagerService = async (tenantId) => {
  const results = await prisma.performanceReview.groupBy({
    by: ["reviewerId"],
    where: scopedWhere(tenantId, { overall_rating: { not: null } }),
    _avg: { overall_rating: true },
    _count: { id: true },
  });

  return results.map((r) => ({
    managerId: r.reviewerId,
    averageRating: r._avg.overall_rating == null ? null : round2(r._avg.overall_rating),
    totalReviews: r._count.id,
  }));
};

/**
 * 4️⃣ Cycle Comparison
 */
export const getCycleComparisonService = async (cycleId, tenantId) => {
  const reviews = await scopedRatedReviews(tenantId, { cycleId: Number(cycleId) });
  const summary = beforeAfter(reviews);
  return {
    cycleId: Number(cycleId),
    totalReviews: summary.totalReviews,
    calibratedReviews: summary.adjustedReviews,
    avgBefore: summary.averageBefore,
    avgAfter: summary.averageAfter,
    improvement: summary.improvement,
  };
};
