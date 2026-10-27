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
