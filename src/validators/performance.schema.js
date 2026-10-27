// src/validators/performance.schema.js — PERF-P0 (E-04).
//
// Zod boundary schemas for the legacy performance-appraisal payloads (reviews,
// feedback, goals, goal progress, alignments, cycles, templates, calibration).
// Until this module existed every controller passed `req.body` straight into a
// service, and two services spread the raw body into Prisma `data` (cycle and
// template update) — a mass-assignment path. Every schema here is `.strict()`
// so an unknown key is rejected instead of silently ignored or written.
//
// Review STATUS is deliberately absent from `reviewUpdateSchema` (E-02): the
// only path to FINALIZED is the PERFORMANCE adapter of the shared HR Approval
// Centre (src/services/approval/adapters.js). A client can no longer finalise a
// review by PUT, nor through hr_performance_review_update.
//
// Dates are accepted as ISO-8601 strings and must parse; a goal / cycle / review
// period must not end before it starts. Ratings are bounded to the implicit
// 0..5 scale the screens render (`/5`); a template-defined scale is P1 scope.
import { z } from "zod";

export const RATING_MIN = 0;
export const RATING_MAX = 5;

export const REVIEW_TYPES = Object.freeze(["SELF", "MANAGER", "PEER", "HR"]);
export const GOAL_STATUSES = Object.freeze([
  "PENDING",
  "IN_PROGRESS",
  "COMPLETED",
  "APPROVED",
  "REJECTED",
]);
export const CYCLE_STATUSES = Object.freeze(["DRAFT", "ACTIVE", "CLOSED"]);
export const REMINDER_TYPES = Object.freeze([
  "PENDING_REVIEW",
  "LATE_SUBMISSION",
  "FEEDBACK_REQUEST",
]);

// Cycle status transitions a client may request. DRAFT→ACTIVE→CLOSED only;
// a CLOSED cycle is terminal and ACTIVE never returns to DRAFT (E-01 / D12).
export const CYCLE_TRANSITIONS = Object.freeze({
  DRAFT: ["ACTIVE"],
  ACTIVE: ["CLOSED"],
  CLOSED: [],
});

const id = z.coerce.number().int().positive();
const optionalId = id.optional();
const nullableId = z.union([id, z.null()]).optional();
const text = z.string().trim().min(1);
const optionalText = z.string().trim().optional();
const rating = z.coerce.number().min(RATING_MIN).max(RATING_MAX);
const percent = z.coerce.number().min(0).max(100);
const isoDate = z
  .string()
  .trim()
  .min(1)
  .refine((v) => !Number.isNaN(new Date(v).getTime()), {
    message: "Expected an ISO-8601 date",
  });

const periodOrdered = (startKey, endKey) => (value, ctx) => {
  const start = value[startKey];
  const end = value[endKey];
  if (start && end && new Date(end).getTime() < new Date(start).getTime()) {
    ctx.addIssue({
      code: "custom",
      path: [endKey],
      message: `${endKey} must not be before ${startKey}`,
    });
  }
};

// ── Reviews ──────────────────────────────────────────────────────────────
export const reviewCreateSchema = z
  .object({
    employeeId: id,
    reviewerId: nullableId,
    cycleId: nullableId,
    period_start: isoDate,
    period_end: isoDate,
    comments: optionalText,
    reviewType: z.enum(REVIEW_TYPES).optional(),
  })
  .strict()
  .superRefine(periodOrdered("period_start", "period_end"));

export const reviewUpdateSchema = z
  .object({
    overallRating: rating.optional(),
    overall_rating: rating.optional(),
    comments: optionalText,
  })
  .strict();

export const reviewSubmitSchema = z
  .object({
    comments: optionalText,
    overall_rating: rating.optional(),
    overallRating: rating.optional(),
  })
  .strict();

export const initiateReviewsSchema = z
  .object({
    cycleId: id,
    employeeIds: z.array(id).min(1),
    reviewType: z.enum(REVIEW_TYPES).optional(),
  })
  .strict();

export const reminderSchema = z
  .object({
    reviewId: id,
    sentToId: id,
    type: z.enum(REMINDER_TYPES).optional(),
  })
  .strict();

// ── Feedback ─────────────────────────────────────────────────────────────
export const feedbackCreateSchema = z
  .object({
    reviewId: id,
    reviewerId: id,
    feedback: text,
    rating: rating.optional(),
  })
  .strict();

export const feedbackUpdateSchema = z
  .object({
    feedback: optionalText,
    rating: z.union([rating, z.null()]).optional(),
  })
  .strict();

// ── Goals ────────────────────────────────────────────────────────────────
export const goalCreateSchema = z
  .object({
    employeeId: id,
    title: text,
    description: optionalText,
    category: optionalText,
    start_date: isoDate,
    end_date: isoDate,
    target_value: z.coerce.number().optional(),
  })
  .strict()
  .superRefine(periodOrdered("start_date", "end_date"));

export const goalUpdateSchema = z
  .object({
    title: optionalText,
    description: optionalText,
    category: optionalText,
    progress: percent.optional(),
    status: z.enum(GOAL_STATUSES).optional(),
    expectedVersion: z.coerce.number().int().min(0).optional(),
  })
  .strict();

export const goalProgressSchema = z
  .object({
    goalId: id,
    progress: percent,
    comment: optionalText,
  })
  .strict();

export const goalAlignmentCreateSchema = z
  .object({
    parentGoalId: id,
    alignedGoalId: id,
  })
  .strict()
  .refine((v) => v.parentGoalId !== v.alignedGoalId, {
    message: "A goal cannot be aligned to itself",
    path: ["alignedGoalId"],
  });

// ── Cycles ───────────────────────────────────────────────────────────────
// Accept both the service's snake_case keys and the MCP tool's camelCase keys
// (D11: hr_performance_cycle_create sent startDate/endDate to a service that
// read start_date/end_date, so the tool always failed). The schema normalises
// to snake_case so services see one shape.
const cycleShape = {
  name: text,
  description: optionalText,
  start_date: isoDate.optional(),
  end_date: isoDate.optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  templateId: nullableId,
  status: z.enum(CYCLE_STATUSES).optional(),
};

const normaliseCycle = (value) => {
  const { startDate, endDate, ...rest } = value;
  return {
    ...rest,
    ...(rest.start_date ?? startDate ? { start_date: rest.start_date ?? startDate } : {}),
    ...(rest.end_date ?? endDate ? { end_date: rest.end_date ?? endDate } : {}),
  };
};

export const cycleCreateSchema = z
  .object(cycleShape)
  .strict()
  .transform(normaliseCycle)
  .pipe(
    z
      .object({
        name: text,
        description: optionalText,
        start_date: isoDate,
        end_date: isoDate,
        templateId: nullableId,
        status: z.enum(["DRAFT", "ACTIVE"]).optional(),
      })
      .superRefine(periodOrdered("start_date", "end_date"))
  );

export const cycleUpdateSchema = z
  .object({ ...cycleShape, name: text.optional() })
  .strict()
  .transform(normaliseCycle)
  .pipe(
    z
      .object({
        name: text.optional(),
        description: optionalText,
        start_date: isoDate.optional(),
        end_date: isoDate.optional(),
        templateId: nullableId,
        status: z.enum(CYCLE_STATUSES).optional(),
      })
      .superRefine(periodOrdered("start_date", "end_date"))
  );

// ── Templates ────────────────────────────────────────────────────────────
// `criteria` is persisted as JSON (D13: create used to drop it). A criterion is
// either a bare label or { name, weight?, description? }; weights, when all
// present, must sum to 100 so a weighted composite (P1) can be reproduced.
const criterion = z.union([
  text,
  z
    .object({
      name: text,
      description: optionalText,
      weight: z.coerce.number().min(0).max(100).optional(),
    })
    .strict(),
]);

const criteriaWeightsSum = (value, ctx) => {
  const list = value.criteria;
  if (!Array.isArray(list) || list.length === 0) return;
  const weights = list
    .map((c) => (typeof c === "object" && c !== null ? c.weight : undefined))
    .filter((w) => typeof w === "number");
  if (weights.length === 0) return;
  if (weights.length !== list.length) {
    ctx.addIssue({
      code: "custom",
      path: ["criteria"],
      message: "Either every criterion carries a weight or none does",
    });
    return;
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 0.001) {
    ctx.addIssue({
      code: "custom",
      path: ["criteria"],
      message: `Criterion weights must sum to 100 (got ${sum})`,
    });
  }
};

export const templateCreateSchema = z
  .object({
    name: text,
    description: optionalText,
    criteria: z.array(criterion).optional(),
    overall_rating: rating.optional(),
  })
  .strict()
  .superRefine(criteriaWeightsSum);

export const templateUpdateSchema = z
  .object({
    name: text.optional(),
    description: optionalText,
    criteria: z.array(criterion).optional(),
    overall_rating: z.union([rating, z.null()]).optional(),
  })
  .strict()
  .superRefine(criteriaWeightsSum);

// ── Calibration ──────────────────────────────────────────────────────────
export const calibrationCreateSchema = z
  .object({
    name: text,
    cycleId: id,
  })
  .strict();

export const calibrationAdjustSchema = z
  .object({
    reviewId: id,
    calibrationSessionId: optionalId,
    old_rating: rating,
    new_rating: rating,
    justification: optionalText,
  })
  .strict();

// ── Parse helper ─────────────────────────────────────────────────────────
/**
 * Parse `payload` with `schema`; on failure throw a typed 400 (HR-4000) whose
 * `details.fieldErrors` lists `{ path, message }` per issue so a controller or
 * the MCP error mapper can surface it without leaking a Zod stack.
 */
export const parsePerformancePayload = (schema, payload) => {
  const result = schema.safeParse(payload ?? {});
  if (result.success) return result.data;
  const fieldErrors = result.error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
  const summary = fieldErrors.map((f) => `${f.path}: ${f.message}`).join("; ");
  throw Object.assign(new Error(`Invalid performance payload — ${summary}`), {
    status: 400,
    statusCode: 400,
    code: "HR-4000",
    details: { fieldErrors },
  });
};
