// src/lib/onboardingTaxonomy.js
//
// Canonical taxonomy for the FE "Onboarding Portal" screen:
//   1. Task categories  — the OnboardingTaskCategory enum values + FE labels.
//   2. Feedback questions — the radio questionnaire the new hire submits.
//
// Kept dependency-free so both the service (validation) and the seed can import
// it. The FE renders categories from ONBOARDING_TASK_CATEGORIES and the feedback
// form from ONBOARDING_FEEDBACK_QUESTIONS; the service validates every submitted
// answer against the question's allowed options.

// ── Task categories ─────────────────────────────────────────────────────────
// Enum value → human label. Mirrors enum OnboardingTaskCategory in schema.prisma.
export const ONBOARDING_TASK_CATEGORY_LABELS = Object.freeze({
  IT_ACCESS_SETUP: "IT & Access Setup",
  WORKSPACE_EQUIPMENT: "Workspace & Equipment",
  ORIENTATION_TRAINING: "Orientation & Training",
  HR_DOCUMENTATION: "HR & Documentation",
  TEAM_INTRODUCTION: "Team Introduction",
  COMPLIANCE_POLICY: "Compliance & Policy",
  OTHER: "Other",
});

export const ONBOARDING_TASK_CATEGORIES = Object.freeze(
  Object.keys(ONBOARDING_TASK_CATEGORY_LABELS)
);

export function onboardingCategoryLabel(value) {
  return ONBOARDING_TASK_CATEGORY_LABELS[value] || ONBOARDING_TASK_CATEGORY_LABELS.OTHER;
}

// ── Feedback questionnaire ───────────────────────────────────────────────────
// Each question: id (stable key persisted in responses), text, and radio
// `options` (the ONLY accepted answers). Order is the render order.
export const ONBOARDING_FEEDBACK_QUESTIONS = Object.freeze([
  {
    id: "role_clarity",
    question: "How clear are your role and responsibilities?",
    options: ["Very clear", "Clear", "Somewhat clear", "Unclear"],
  },
  {
    id: "team_support",
    question: "How supported do you feel by your team?",
    options: ["Very supported", "Supported", "Neutral", "Unsupported"],
  },
  {
    id: "tools_access",
    question: "Did you receive the tools and access you needed on time?",
    options: ["Yes, everything", "Mostly", "Some", "None"],
  },
  {
    id: "manager_guidance",
    question: "How would you rate your manager's guidance so far?",
    options: ["Excellent", "Good", "Fair", "Poor"],
  },
  {
    id: "buddy_helpfulness",
    question: "How helpful was your onboarding buddy?",
    options: ["Very helpful", "Helpful", "Neutral", "Not helpful", "No buddy assigned"],
  },
  {
    id: "overall_experience",
    question: "Overall, how would you rate your onboarding experience?",
    options: ["Excellent", "Good", "Fair", "Poor"],
  },
  {
    id: "would_recommend",
    question: "Would you recommend this onboarding process to a new colleague?",
    options: ["Definitely", "Probably", "Maybe", "No"],
  },
]);

// questionId → the frozen question object (fast validation lookup).
const QUESTION_BY_ID = Object.freeze(
  Object.fromEntries(ONBOARDING_FEEDBACK_QUESTIONS.map((q) => [q.id, q]))
);

export function getFeedbackQuestion(questionId) {
  return QUESTION_BY_ID[questionId] || null;
}

/**
 * Validate a submitted answers array against the canonical questionnaire.
 * @param {Array<{questionId:string, answer:string}>} answers
 * @returns {{ ok: boolean, error?: string, normalized?: Array }}
 *   normalized = [{ questionId, question, answer }] (question text folded in).
 */
export function validateFeedbackAnswers(answers) {
  if (!Array.isArray(answers) || answers.length === 0) {
    return { ok: false, error: "answers must be a non-empty array" };
  }
  const seen = new Set();
  const normalized = [];
  for (const a of answers) {
    const questionId = a?.questionId;
    const answer = a?.answer;
    const q = getFeedbackQuestion(questionId);
    if (!q) {
      return { ok: false, error: `unknown questionId "${questionId}"` };
    }
    if (seen.has(questionId)) {
      return { ok: false, error: `duplicate answer for questionId "${questionId}"` };
    }
    if (!q.options.includes(answer)) {
      return {
        ok: false,
        error: `answer "${answer}" is not a valid option for "${questionId}" (allowed: ${q.options.join(" | ")})`,
      };
    }
    seen.add(questionId);
    normalized.push({ questionId, question: q.question, answer });
  }
  return { ok: true, normalized };
}
