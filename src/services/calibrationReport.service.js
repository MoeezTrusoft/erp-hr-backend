import prisma from "../lib/prisma.js";
import { scopedWhere } from "../lib/tenancy.js";

// C.2-completion — verified tenant (T-P2.1) threaded via a trailing `tenantId`;
// every calibration aggregate is computed over tenant-scoped reads only, so a
// tenant never sees another tenant's ratings folded into its calibration stats.

/**
 * 1️⃣ Overall Distribution
 */
export function calibrationSummary(reviews, adjustments) {
  const first = new Map(), changed = new Set();
  for (const a of adjustments) {
    if (!first.has(a.reviewId)) first.set(a.reviewId, a.old_rating);
    changed.add(a.reviewId);
  }
  const cohort = reviews.map(r => ({ before: first.has(r.id) ? first.get(r.id) : r.overall_rating,
    after: r.overall_rating })).filter(r => r.before != null && r.after != null);
  const avg = key => cohort.length ? cohort.reduce((sum,r)=>sum+r[key],0)/cohort.length : null;
  const averageBefore=avg('before'), averageAfter=avg('after');
  return { totalReviews: reviews.length, adjustedReviews: reviews.filter(r=>changed.has(r.id)).length,
    ratedReviews: cohort.length, averageBefore, averageAfter,
    improvement: averageBefore == null ? null : averageAfter-averageBefore };
}
export const getCalibrationOverviewService = async (tenantId) => {
  const reviews = await prisma.performanceReview.findMany({
    where: scopedWhere(tenantId, {}), select: { overall_rating: true, cycleId: true, id: true },
  });
  const adjustments = await prisma.ratingAdjustment.findMany({
    where: scopedWhere(tenantId, {}), select: { reviewId: true, old_rating: true, new_rating: true },
    orderBy: { id: 'asc' },
  });
  return { ...calibrationSummary(reviews, adjustments), scope: 'allCycles' };
};

/**
 * 2️⃣ Average by Department
 */
export const getAverageByDepartmentService = async (tenantId) => {
  const rows = await prisma.performanceReview.findMany({where:scopedWhere(tenantId,{}),select:{overall_rating:true,employee:{select:{businessUnitId:true}}}});
  const groups = new Map();
  for(const row of rows){const id=row.employee?.businessUnitId;if(id==null)continue;const values=groups.get(id)||[];if(row.overall_rating!=null)values.push(row.overall_rating);groups.set(id,values);}
  return [...groups].map(([departmentId,values])=>({departmentId,averageRating:values.length?values.reduce((a,b)=>a+b,0)/values.length:null,ratedReviews:values.length}));
};

/**
 * 3️⃣ Average by Manager
 */
export const getAverageByManagerService = async (tenantId) => {
  const results = await prisma.performanceReview.groupBy({
    by: ["reviewerId"],
    where: tenantId === undefined ? undefined : scopedWhere(tenantId, {}),
    _avg: { overall_rating: true },
    _count: { id: true },
  });

  return results.map(r => ({
    managerId: r.reviewerId,
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
    where: scopedWhere(tenantId, { performance_review: { cycleId: Number(cycleId) } }),
    select: { reviewId: true, old_rating: true, new_rating: true }, orderBy: { id: 'asc' },
  });
  const summary = calibrationSummary(reviews,adjusted);
  return { cycleId: Number(cycleId), totalReviews: summary.totalReviews,
    calibratedReviews: summary.adjustedReviews, ratedReviews: summary.ratedReviews,
    avgBefore: summary.averageBefore, avgAfter: summary.averageAfter, improvement: summary.improvement };
};
