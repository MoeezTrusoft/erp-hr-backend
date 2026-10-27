import {
  ONBOARDING_FEEDBACK_QUESTIONS,
  validateFeedbackAnswers,
} from "./onboardingTaxonomy.js";
export const ONBOARDING_MILESTONES = Object.freeze([
  { type: "DAY_30", days: 30 },
  { type: "DAY_60", days: 60 },
  { type: "DAY_90", days: 90 },
]);
export function milestoneDueAt(startDate, days) {
  const start = new Date(startDate);
  if (!Number.isFinite(start.getTime()))
    throw Object.assign(new Error("Valid onboarding start date required"), {
      status: 422,
    });
  start.setUTCDate(start.getUTCDate() + days);
  return start;
}
export function validateMilestoneResponse(answers, comments) {
  const result = validateFeedbackAnswers(answers);
  if (
    !result.ok ||
    result.normalized.length !== ONBOARDING_FEEDBACK_QUESTIONS.length
  )
    throw Object.assign(
      new Error(result.error || "Answer every survey question"),
      { status: 422 },
    );
  if (
    comments != null &&
    (typeof comments !== "string" || comments.length > 4000)
  )
    throw Object.assign(new Error("Comments must be at most 4000 characters"), {
      status: 422,
    });
  return {
    version: 1,
    answers: result.normalized,
    comments: comments?.trim() || null,
  };
}
export function milestoneView(
  checklist,
  rows,
  { enabled, canSubmit, now = new Date() } = {},
) {
  return {
    enabled: !!enabled,
    questions: ONBOARDING_FEEDBACK_QUESTIONS,
    items: ONBOARDING_MILESTONES.map((m) => {
      const existing = rows.find((r) => r.type === m.type),
        dueAt = milestoneDueAt(checklist.startDate, m.days);
      return {
        type: m.type,
        days: m.days,
        dueAt,
        submittedAt: existing?.submittedAt ?? null,
        answers: existing?.responses?.answers ?? [],
        comments: existing?.responses?.comments ?? null,
        canSubmit: !!enabled && !!canSubmit && +dueAt <= +now,
      };
    }),
  };
}
