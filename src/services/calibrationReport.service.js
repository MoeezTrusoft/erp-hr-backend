import prisma from "../lib/prisma.js";
import { scopedWhere } from "../lib/tenancy.js";

// C.2-completion — verified tenant (T-P2.1) threaded via a trailing `tenantId`;
// every calibration aggregate is computed over tenant-scoped reads only, so a
// tenant never sees another tenant's ratings folded into its calibration stats.

/**
 * 1️⃣ Overall Distribution
 */
export const getCalibrationOverviewService = async (tenantId) => {
  const reviews = await prisma.performanceReview.findMany({
    where: scopedWhere(tenantId, {}),
    select: { overall_rating: true, cycleId: true, id: true },
  });

  const adjustments = await prisma.ratingAdjustment.findMany({
    where: scopedWhere(tenantId, {}),
    select: { new_rating: true },
  });

  const before = reviews.map(r => r.overall_rating).filter(Boolean);
  const after = adjustments.map(a => a.new_rating).filter(Boolean);

  const avgBefore = before.length
    ? before.reduce((a, b) => a + b, 0) / before.length
    : 0;
  const avgAfter = after.length
    ? after.reduce((a, b) => a + b, 0) / after.length
    : 0;

  return {
    totalReviews: reviews.length,
    adjustedReviews: adjustments.length,
    averageBefore: avgBefore,
    averageAfter: avgAfter,
    improvement: avgAfter - avgBefore,
  };
};

/**
 * 2️⃣ Average by Department
 */
export const getAverageByDepartmentService = async (tenantId) => {
  const results = await prisma.employee.groupBy({
    by: ["departmentId"],
    // Employee carries the tenant on the snake_case column `tenant_id` (REQ-007).
    where: tenantId === undefined ? undefined : { tenant_id: tenantId ?? null },
    _avg: { currentRating: true },
    _count: { id: true },
  });

  return results.map(r => ({
    departmentId: r.departmentId,
    averageRating: r._avg.currentRating,
    totalEmployees: r._count.id,
  }));
};

/**
 * 3️⃣ Average by Manager
 */
export const getAverageByManagerService = async (tenantId) => {
  const results = await prisma.performanceReview.groupBy({
    by: ["managerId"],
    where: tenantId === undefined ? undefined : scopedWhere(tenantId, {}),
    _avg: { overall_rating: true },
    _count: { id: true },
  });

  return results.map(r => ({
    managerId: r.managerId,
    averageRating: r._avg.overall_rating,
    totalReviews: r._count.id,
  }));
};

/**
 * 4️⃣ Cycle Comparison
 */
export const getCycleComparisonService = async (cycleId, tenantId) => {
  const reviews = await prisma.performanceReview.findMany({
    where: scopedWhere(tenantId, { cycleId: Number(cycleId) }),
    select: { id: true, overall_rating: true },
  });

  const adjusted = await prisma.ratingAdjustment.findMany({
    where: scopedWhere(tenantId, { review: { cycleId: Number(cycleId) } }),
    select: { reviewId: true, old_rating: true, new_rating: true },
  });

  const total = reviews.length;
  const changed = adjusted.length;

  const avgBefore = reviews.reduce((sum, r) => sum + (r.overall_rating || 0), 0) / (total || 1);
  const avgAfter = adjusted.reduce((sum, a) => sum + (a.new_rating || 0), 0) / (changed || 1);

  return {
    cycleId: Number(cycleId),
    totalReviews: total,
    calibratedReviews: changed,
    avgBefore,
    avgAfter,
    improvement: avgAfter - avgBefore,
  };
};
