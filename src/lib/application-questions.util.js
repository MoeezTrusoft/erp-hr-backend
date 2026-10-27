// src/lib/application-questions.util.js
//
// Phase 5 / decision record §3.5 — per-requisition application questions.
//
// Two responsibilities, both pure:
//
//   1. VALIDATE a question definition as a recruiter writes it. The admin path
//      and the MCP path both call this, so a question that would score
//      inconsistently cannot be saved from either surface.
//   2. NORMALIZE + SCORE a candidate's answer against that definition. The
//      scoring is deterministic by construction: a given (question, answer)
//      pair always yields the same points, computed here and stored on the
//      ApplicationAnswer row at submission time — never recomputed later,
//      so a recruiter editing weights after the fact cannot rewrite history
//      (§3.5: the candidate's record must be stable).
//
// Question vocabulary (kept deliberately small):
//   TEXT_SHORT | TEXT_LONG | SINGLE_CHOICE | MULTI_CHOICE | NUMBER | BOOLEAN | DATE
//
// Options shape: [{ value: "..", label: ".." }] for *_CHOICE.
//                [{ min }, { max }] (either/both) for NUMBER.
// Weights shape: { [choiceValue]: points } for *_CHOICE and BOOLEAN,
//                { min?, max?, points } for NUMBER (points awarded when the
//                answer falls in [min, max]), { [yyyy-mm-dd]: points } for DATE.
//
// Recruitment Phase 2 — KNOCKOUT. A question flagged `knockout` disqualifies an
// applicant whose answer matches its `knockoutRule`:
//   { values: [..] }  for SINGLE_CHOICE / MULTI_CHOICE (option values) and
//                     BOOLEAN (true / false): answering one of them knocks out;
//                     a multi-choice selection knocks out when it includes one.
//   { min?, max? }    for NUMBER: an answer OUTSIDE [min, max] knocks out.
// Only a REQUIRED question can knock out (the plan's guard: "knockout only on
// required questions the hiring manager set") — an optional question can be
// skipped, so a rule on it would only ever catch the candidates who answered
// honestly. The outcome is computed here at submission, like the score, and
// stored; the delayed, reversible disposition it triggers lives in
// services/scheduled-disposition.service.js.

export const QUESTION_TYPES = [
  "TEXT_SHORT",
  "TEXT_LONG",
  "SINGLE_CHOICE",
  "MULTI_CHOICE",
  "NUMBER",
  "BOOLEAN",
  "DATE",
];

const CHOICE_TYPES = new Set(["SINGLE_CHOICE", "MULTI_CHOICE"]);
export const KNOCKOUT_TYPES = Object.freeze(["SINGLE_CHOICE", "MULTI_CHOICE", "BOOLEAN", "NUMBER"]);
const WEIGHTED_TYPES = new Set(["SINGLE_CHOICE", "MULTI_CHOICE", "BOOLEAN", "NUMBER", "DATE"]);

const MAX_PROMPT_LENGTH = 2000;
const MAX_TEXT_ANSWER_LENGTH = 5000;
const MAX_CHOICES = 25;

function asFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function isIsoDate(value) {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Validate one question definition. Returns { ok, errors, normalized }.
 * `normalized` carries the canonical shape the service persists.
 */
export function validateQuestionDefinition(input = {}) {
  const errors = [];
  const type = typeof input.type === "string" ? input.type : "";
  if (!QUESTION_TYPES.includes(type)) {
    errors.push(`type must be one of: ${QUESTION_TYPES.join(", ")}`);
  }
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) errors.push("prompt is required");
  else if (prompt.length > MAX_PROMPT_LENGTH) {
    errors.push(`prompt must be at most ${MAX_PROMPT_LENGTH} characters`);
  }

  const orderIndex = asFiniteNumber(input.orderIndex) ?? 0;
  if (orderIndex < 0) errors.push("orderIndex must be >= 0");

  const normalized = {
    type,
    prompt,
    required: input.required === true,
    orderIndex: Math.trunc(orderIndex),
    options: null,
    weights: null,
    maxScore: null,
    knockout: false,
    knockoutRule: null,
    isActive: input.isActive !== false,
  };

  if (CHOICE_TYPES.has(type)) {
    const raw = Array.isArray(input.options) ? input.options : [];
    if (raw.length < 2) errors.push("choice questions need at least 2 options");
    if (raw.length > MAX_CHOICES) errors.push(`choice questions allow at most ${MAX_CHOICES} options`);
    const seen = new Set();
    const options = [];
    for (const opt of raw) {
      const value = typeof opt?.value === "string" ? opt.value.trim() : "";
      const label = typeof opt?.label === "string" && opt.label.trim() !== "" ? opt.label.trim() : value;
      if (!value) {
        errors.push("every option needs a non-empty value");
        continue;
      }
      if (label.length > 500) errors.push("option labels must be at most 500 characters");
      if (seen.has(value)) {
        errors.push(`duplicate option value: "${value}"`);
        continue; // a duplicated value must not survive into the stored definition
      }
      seen.add(value);
      options.push({ value, label });
    }
    if (options.length >= 2) normalized.options = options;
  } else if (type === "NUMBER") {
    const min = asFiniteNumber(input.options?.min);
    const max = asFiniteNumber(input.options?.max);
    if (input.options?.min !== undefined && min === null) errors.push("options.min must be a number");
    if (input.options?.max !== undefined && max === null) errors.push("options.max must be a number");
    if (min !== null && max !== null && min > max) errors.push("options.min must be <= options.max");
    if (min !== null || max !== null) normalized.options = { min, max };
  }

  // §3.5 scoring is optional but, when present, must be complete and bounded.
  if (input.weights != null) {
    if (!WEIGHTED_TYPES.has(type)) {
      errors.push(`weights are not supported for type ${type || "(missing)"}`);
    } else {
      const weights = input.weights;
      if (type === "NUMBER") {
        const min = asFiniteNumber(weights.min);
        const max = asFiniteNumber(weights.max);
        const points = asFiniteNumber(weights.points);
        if (points === null) errors.push("number weights need points");
        else if (points < 0) errors.push("number weight points must be >= 0");
        if (weights.min !== undefined && min === null) errors.push("weights.min must be a number");
        if (weights.max !== undefined && max === null) errors.push("weights.max must be a number");
        if (min !== null && max !== null && min > max) errors.push("weights.min must be <= weights.max");
        if (!errors.length) {
          normalized.weights = { min, max, points };
          // A range question awards `points` at most — the band either matches
          // or it doesn't; there is no per-option accumulation.
          normalized.maxScore = points;
        }
      } else {
        // Choice/boolean/date: a map of answer -> points. Accept numeric points
        // only; non-finite or negative entries are rejected so the maxScore sum
        // always exists.
        if (typeof weights !== "object" || Array.isArray(weights)) {
          errors.push("weights must be an object mapping answer values to points");
        } else {
          const clean = {};
          let bad = false;
          for (const [key, points] of Object.entries(weights)) {
            const pts = asFiniteNumber(points);
            if (pts === null || pts < 0) {
              errors.push(`weight for "${key}" must be a number >= 0`);
              bad = true;
              break;
            }
            clean[key] = pts;
          }
          if (!bad && Object.keys(clean).length) {
            if (CHOICE_TYPES.has(type)) {
              const defined = new Set((normalized.options ?? []).map((o) => o.value));
              for (const key of Object.keys(clean)) {
                if (!defined.has(key)) errors.push(`weight references unknown option "${key}"`);
              }
            }
            if (type === "BOOLEAN") {
              for (const key of Object.keys(clean)) {
                if (key !== "true" && key !== "false") {
                  errors.push('boolean weights may only use keys "true" and "false"');
                }
              }
            }
            if (type === "DATE") {
              for (const key of Object.keys(clean)) {
                if (!isIsoDate(key)) errors.push(`date weight key "${key}" must be YYYY-MM-DD`);
              }
            }
            if (!errors.length) {
              normalized.weights = clean;
              normalized.maxScore = Object.values(clean).reduce((a, b) => a + b, 0);
            }
          }
        }
      }
    }
  }

  if (normalized.weights && normalized.maxScore == null) normalized.maxScore = 0;

  // Knockout errors are reported separately too, so the service can answer
  // with a knockout-specific code instead of the generic "invalid definition".
  const knockoutErrors = validateKnockout(input, normalized);
  errors.push(...knockoutErrors);
  return { ok: errors.length === 0, errors, knockoutErrors, normalized };
}

const asBoolean = (value) => {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
};

/** Normalize a { values } rule for a choice or BOOLEAN question. */
function normalizeValuesRule(type, rule, options, errors) {
  if (rule.min !== undefined || rule.max !== undefined) {
    errors.push(`a ${type} knockout rule takes values, not min/max`);
    return null;
  }
  if (!Array.isArray(rule.values) || rule.values.length === 0) {
    errors.push("knockoutRule.values must list at least one knockout answer");
    return null;
  }
  const allowed = type === "BOOLEAN" ? [true, false] : (options ?? []).map((o) => o.value);
  const values = [];
  for (const raw of rule.values) {
    const value = type === "BOOLEAN" ? asBoolean(raw) : typeof raw === "string" ? raw.trim() : null;
    if (value === null || !allowed.includes(value)) {
      errors.push(`knockoutRule value "${String(raw)}" is not an answer this question accepts`);
      return null;
    }
    if (!values.includes(value)) values.push(value);
  }
  // A rule that disqualifies every possible answer is a closed requisition, not
  // a screening question.
  if (values.length >= allowed.length) {
    errors.push("knockoutRule.values cannot cover every answer");
    return null;
  }
  return { values };
}

/** Normalize a { min, max } rule for a NUMBER question. */
function normalizeRangeRule(rule, errors) {
  if (rule.values !== undefined) {
    errors.push("a NUMBER knockout rule takes min/max, not values");
    return null;
  }
  const min = rule.min === undefined || rule.min === null ? null : asFiniteNumber(rule.min);
  const max = rule.max === undefined || rule.max === null ? null : asFiniteNumber(rule.max);
  if (rule.min != null && min === null) errors.push("knockoutRule.min must be a number");
  if (rule.max != null && max === null) errors.push("knockoutRule.max must be a number");
  if (min === null && max === null) {
    if (!errors.length) errors.push("a NUMBER knockout rule needs min, max or both");
    return null;
  }
  if (min !== null && max !== null && min > max) {
    errors.push("knockoutRule.min must be <= knockoutRule.max");
    return null;
  }
  return { min, max };
}

/**
 * Validate the knockout flag and rule against the (already normalized) type,
 * options and required flag. Writes the canonical rule onto `normalized` and
 * returns the knockout errors (empty when fine).
 */
function validateKnockout(input, normalized) {
  const errors = [];
  const knockout = input.knockout === true;
  const rule = input.knockoutRule ?? null;
  if (!knockout) {
    if (rule !== null) errors.push("knockoutRule is only allowed on a knockout question (knockout: true)");
    return errors;
  }
  if (!KNOCKOUT_TYPES.includes(normalized.type)) {
    errors.push(`knockout is not supported for type ${normalized.type || "(missing)"}; use ${KNOCKOUT_TYPES.join(", ")}`);
    return errors;
  }
  if (!normalized.required) {
    errors.push("only a required question can be a knockout question");
    return errors;
  }
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    errors.push("a knockout question needs a knockoutRule object");
    return errors;
  }
  const canonical = normalized.type === "NUMBER"
    ? normalizeRangeRule(rule, errors)
    : normalizeValuesRule(normalized.type, rule, normalized.options, errors);
  if (canonical && !errors.length) {
    normalized.knockout = true;
    normalized.knockoutRule = canonical;
  }
  return errors;
}

/**
 * Does this validated answer meet the question's knockout rule? Pure; false for
 * anything that is not a required knockout question with a stored rule.
 */
export function isKnockedOut(question, value) {
  const rule = question?.knockoutRule;
  if (question?.knockout !== true || question.required !== true || !rule || value === null || value === undefined) {
    return false;
  }
  switch (question.type) {
    case "SINGLE_CHOICE":
    case "BOOLEAN":
      return Array.isArray(rule.values) && rule.values.includes(value);
    case "MULTI_CHOICE":
      return Array.isArray(rule.values) && Array.isArray(value) && value.some((v) => rule.values.includes(v));
    case "NUMBER":
      return (rule.min != null && value < rule.min) || (rule.max != null && value > rule.max);
    default:
      return false;
  }
}

/** Validate an ordered list of definitions as a set (prompt uniqueness). */
export function validateQuestionSet(inputs) {
  const results = (Array.isArray(inputs) ? inputs : []).map((q) => validateQuestionDefinition(q));
  const errors = results.flatMap((r) => r.errors);
  const seen = new Set();
  for (const r of results) {
    const key = r.normalized.prompt.toLowerCase();
    if (r.normalized.prompt) {
      if (seen.has(key)) errors.push(`duplicate question prompt: "${r.normalized.prompt}"`);
      seen.add(key);
    }
  }
  return { ok: errors.length === 0, errors, normalized: results.map((r) => r.normalized) };
}

/**
 * Validate + score one answer against one question definition.
 * Returns { ok, errors, value, score, knockedOut }.
 *   value      — the JSON shape stored on ApplicationAnswer (null when skipped)
 *   score      — the deterministic points awarded; null when the question is
 *                unscored or the answer was skipped (a skipped question never scores)
 *   knockedOut — the answer met the question's knockout rule (always false for
 *                an invalid or skipped answer)
 */
export function validateAnswer(question, rawAnswer) {
  const errors = [];
  const skipped = rawAnswer === undefined || rawAnswer === null || (typeof rawAnswer === "string" && rawAnswer.trim() === "");
  if (skipped) {
    if (question.required) {
      return { ok: false, errors: [`"${question.prompt}" is required`], value: null, score: null, knockedOut: false };
    }
    return { ok: true, errors, value: null, score: null, knockedOut: false };
  }

  let value = null;
  switch (question.type) {
    case "TEXT_SHORT":
    case "TEXT_LONG": {
      if (typeof rawAnswer !== "string") {
        errors.push(`"${question.prompt}" must be text`);
        break;
      }
      if (rawAnswer.length > MAX_TEXT_ANSWER_LENGTH) {
        errors.push(`"${question.prompt}" must be at most ${MAX_TEXT_ANSWER_LENGTH} characters`);
        break;
      }
      if (question.type === "TEXT_SHORT" && rawAnswer.length > 500) {
        errors.push(`"${question.prompt}" must be at most 500 characters`);
        break;
      }
      value = rawAnswer;
      break;
    }
    case "SINGLE_CHOICE": {
      const defined = new Set((question.options ?? []).map((o) => o.value));
      if (typeof rawAnswer !== "string" || !defined.has(rawAnswer)) {
        errors.push(`"${question.prompt}" must be one of the listed options`);
        break;
      }
      value = rawAnswer;
      break;
    }
    case "MULTI_CHOICE": {
      const defined = new Set((question.options ?? []).map((o) => o.value));
      if (!Array.isArray(rawAnswer) || rawAnswer.some((v) => typeof v !== "string" || !defined.has(v))) {
        errors.push(`"${question.prompt}" must be a list of the listed options`);
        break;
      }
      value = [...new Set(rawAnswer)]; // dedupe; duplicates add no information
      break;
    }
    case "NUMBER": {
      const n = asFiniteNumber(rawAnswer);
      if (n === null) {
        errors.push(`"${question.prompt}" must be a number`);
        break;
      }
      const { min, max } = question.options ?? {};
      if (min != null && n < min) {
        errors.push(`"${question.prompt}" must be >= ${min}`);
        break;
      }
      if (max != null && n > max) {
        errors.push(`"${question.prompt}" must be <= ${max}`);
        break;
      }
      value = n;
      break;
    }
    case "BOOLEAN": {
      if (typeof rawAnswer !== "boolean") {
        errors.push(`"${question.prompt}" must be true or false`);
        break;
      }
      value = rawAnswer;
      break;
    }
    case "DATE": {
      if (!isIsoDate(rawAnswer)) {
        errors.push(`"${question.prompt}" must be a date (YYYY-MM-DD)`);
        break;
      }
      value = rawAnswer;
      break;
    }
    default:
      errors.push(`question type "${question.type}" is not answerable`);
  }

  if (errors.length) return { ok: false, errors, value: null, score: null, knockedOut: false };

  // Deterministic scoring — pure arithmetic over the stored weights.
  let score = null;
  const weights = question.weights;
  if (weights) {
    if (question.type === "NUMBER") {
      score = value >= (weights.min ?? -Infinity) && value <= (weights.max ?? Infinity) ? weights.points : 0;
    } else if (question.type === "MULTI_CHOICE") {
      score = value.reduce((sum, v) => sum + (weights[v] ?? 0), 0);
    } else if (question.type === "BOOLEAN") {
      score = weights[value === true ? "true" : "false"] ?? 0;
    } else {
      score = weights[value] ?? 0;
    }
  }

  return { ok: true, errors, value, score: weights ? score : null, knockedOut: isKnockedOut(question, value) };
}

/** Total of a set of scored answers — used by the intake to store one sum. */
export function totalScore(scoredAnswers) {
  return scoredAnswers.reduce((sum, a) => sum + (a.score ?? 0), 0);
}

/**
 * The application-level outcome of one submission. Pure.
 *
 * @param {Array<{id:number, weights?:object|null, maxScore?:number|null}>} questions the active set asked
 * @param {Array<{questionId:number, score:number|null, knockedOut?:boolean}>} answers the validated answers
 * @returns {{ answerScore:number|null, answerMaxScore:number|null, knockedOut:boolean, knockoutQuestionIds:number[] }}
 *   answerScore/answerMaxScore are null when no asked question is scored; the
 *   ceiling counts every scored question asked, so a skipped optional question
 *   lowers the ratio rather than vanishing from it. Both are rounded to whole
 *   points (the Application columns are integers; weights may be fractional).
 */
export function scoreAnswers(questions = [], answers = []) {
  const scored = questions.filter((q) => q?.weights != null);
  const knockoutQuestionIds = answers.filter((a) => a.knockedOut === true).map((a) => a.questionId);
  return {
    answerScore: scored.length ? Math.round(totalScore(answers)) : null,
    answerMaxScore: scored.length ? Math.round(scored.reduce((sum, q) => sum + (q.maxScore ?? 0), 0)) : null,
    knockedOut: knockoutQuestionIds.length > 0,
    knockoutQuestionIds,
  };
}
