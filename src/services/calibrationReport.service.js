import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * 1️⃣ Overall Distribution
 */
export const getCalibrationOverviewService = async () => {
  const reviews = await prisma.performanceReview.findMany({
    select: { overall_rating: true, cycleId: true, id: true },
  });

  const adjustments = await prisma.ratingAdjustment.findMany({
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
export const getAverageByDepartmentService = async () => {
  const results = await prisma.employee.groupBy({
    by: ["departmentId"],
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
export const getAverageByManagerService = async () => {
  const results = await prisma.performanceReview.groupBy({
    by: ["managerId"],
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
export const getCycleComparisonService = async (cycleId) => {
  const reviews = await prisma.performanceReview.findMany({
    where: { cycleId: Number(cycleId) },
    select: { id: true, overall_rating: true },
  });

  const adjusted = await prisma.ratingAdjustment.findMany({
    where: { review: { cycleId: Number(cycleId) } },
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
