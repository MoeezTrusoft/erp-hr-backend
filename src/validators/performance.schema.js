import { z } from 'zod';

// Keep absent values distinct from explicit empty collections: replacing review
// items is destructive and must never interpret a malformed request as deletion.
export const performanceId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const label = z.string().trim().min(1).max(200);
const optionalText = z.string().max(4000).nullable().optional();
const date = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const templateFields = z.object({
  name: label,
  description: optionalText,
  criteria: z.array(label).max(200).optional(),
  overall_rating: z.number().min(0).max(5).nullable().optional(),
}).strict();
const nonempty = value => Object.values(value).some(item => item !== undefined);
export const performanceTemplateCreate = templateFields;
export const performanceTemplateUpdate = templateFields.partial().refine(nonempty, 'At least one change is required');
const cycleFields = z.object({
  name: label,
  description: optionalText,
  start_date: date,
  end_date: date,
  templateId: performanceId,
}).strict();
const orderedDates = value => !value.start_date || !value.end_date || new Date(value.start_date) <= new Date(value.end_date);
export const performanceCycleCreate = cycleFields.extend({ status: z.literal('DRAFT').optional() })
  .refine(orderedDates, 'Cycle end must be on or after its start');
export const performanceCycleUpdate = cycleFields.partial().refine(nonempty, 'At least one change is required')
  .refine(orderedDates, 'Cycle end must be on or after its start');
export const performanceMetricCreate = z.object({
  name: label,
  description: optionalText,
  category: label.nullable().optional(),
}).strict();
export const performanceMetricList = z.object({
  search: z.string().trim().max(200).optional(),
  page: z.number().int().min(1).max(100000).default(1),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();
export const performanceReviewItems = z.object({
  items: z.array(z.object({
    metricId: performanceId,
    rating: z.number().min(1).max(5).nullable().optional(),
    comment: optionalText,
  }).strict()).max(200),
}).strict().superRefine(({ items }, ctx) => {
  const seen = new Set();
  items.forEach((item, index) => {
    if (seen.has(item.metricId)) ctx.addIssue({
      code: 'custom', path: ['items', index, 'metricId'],
      message: 'Each metric may appear only once',
    });
    seen.add(item.metricId);
  });
});

// Legacy MCP identifiers are strings; accept only canonical positive integer
// strings, never boolean/blank/exponent coercions or unsafe integers.
export const legacyPerformanceId = z.union([
  performanceId,
  z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(performanceId),
]);
const reviewFields = z.object({
  employeeId: legacyPerformanceId,
  reviewerId: legacyPerformanceId.nullable().optional(),
  cycleId: legacyPerformanceId.nullable().optional(),
  period_start: date,
  period_end: date,
  comments: optionalText,
  reviewType: z.enum(['SELF', 'MANAGER', 'PEER', 'HR']).optional(),
}).strict();
export const legacyReviewCreate = reviewFields.refine(
  value => new Date(value.period_start) <= new Date(value.period_end),
  'Review end must be on or after its start',
);
export const legacyReviewUpdate = z.object({
  overallRating: z.number().min(0).max(5).nullable().optional(),
  overall_rating: z.number().min(0).max(5).nullable().optional(),
  comments: optionalText,
  status: z.enum(['DRAFT', 'IN_PROGRESS', 'FINALIZED']).optional(),
}).strict().refine(nonempty, 'At least one change is required').refine(
  value => value.overallRating === undefined || value.overall_rating === undefined,
  'Use one rating field',
);
const feedbackFields = z.object({
  reviewId: legacyPerformanceId,
  reviewerId: legacyPerformanceId,
  feedback: z.string().trim().min(1).max(4000),
  rating: z.number().min(0).max(5).nullable().optional(),
}).strict();
export const legacyFeedbackCreate = feedbackFields;
export const legacyFeedbackUpdate = feedbackFields.partial().refine(nonempty, 'At least one change is required');
export const legacyGoalCreate = z.object({
  employeeId: legacyPerformanceId,
  title: label,
  description: optionalText,
  category: label.nullable().optional(),
  start_date: date,
  end_date: date,
  target_value: z.number().finite().nullable().optional(),
}).strict().refine(orderedDates, 'Goal end must be on or after its start');
export const legacyGoalUpdate = z.object({
  title: label.optional(),
  description: optionalText,
  progress: z.number().min(0).max(100).optional(),
  status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'APPROVED', 'REJECTED']).optional(),
  expectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict().refine(nonempty, 'At least one change is required');
export const legacyGoalProgress = z.object({
  goalId: legacyPerformanceId,
  comment: optionalText,
  progress: z.number().min(0).max(100),
  expectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
export const legacyGoalAlignment = z.object({
  parentGoalId: legacyPerformanceId,
  alignedGoalId: legacyPerformanceId,
}).strict().refine(value => value.parentGoalId !== value.alignedGoalId, 'A goal cannot be aligned to itself');

export const legacyReviewList = z.object({
  page: legacyPerformanceId.pipe(z.number().max(100000)).default(1),
  pageSize: legacyPerformanceId.pipe(z.number().max(200)).default(50),
  cycleId: legacyPerformanceId.optional(),
  employeeId: legacyPerformanceId.optional(),
}).strict();
