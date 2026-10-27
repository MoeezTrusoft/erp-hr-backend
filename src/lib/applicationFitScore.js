import { createHash } from "node:crypto";
import { resolveSkill } from "./skillNormalization.js";
export const FIT_MODEL_VERSION = "taxonomy-fit-v1";
export const FIT_WEIGHTS = Object.freeze({
  required: 60,
  preferred: 20,
  experience: 20,
});
const round = (n) => Math.round(n * 100) / 100;
export function requisitionSkillRequirements(content, legacy = "") {
  const block = content?.skills;
  let required = [],
    preferred = [];
  if (Array.isArray(block))
    for (const item of block) {
      const name = typeof item === "string" ? item : item?.name;
      if (!name) continue;
      (item?.importance === "preferred" ? preferred : required).push(name);
    }
  else if (block && typeof block === "object") {
    required = block.required ?? [];
    preferred = block.preferred ?? [];
  }
  if (!required.length && !preferred.length && legacy)
    required = legacy
      .split(/[,;\n•]+/)
      .map((x) => x.replace(/^[-*\d.)\s]+/, "").trim())
      .filter(Boolean);
  return { required, preferred };
}
export function calculateApplicationFit({
  index,
  candidateSkills = [],
  requirements = {},
  experienceYears = null,
  minimumExperienceYears = null,
  knockouts = [],
}) {
  // Only explicit job-related features enter this model. Identity, age, gender,
  // address, nationality, disability, school names and salary never enter the hash or formula.
  const candidateIds = new Set(
    candidateSkills
      .map(
        (s) => resolveSkill(index, typeof s === "string" ? s : s?.name).skillId,
      )
      .filter(Boolean),
  );
  const resolve = (names) => [
    ...new Map(
      (names ?? []).map((raw) => {
        const result = resolveSkill(
          index,
          typeof raw === "string" ? raw : raw?.name,
        );
        return [
          result.skillId ?? String(raw).trim().toLowerCase(),
          {
            skillId: result.skillId ?? null,
            requirement: typeof raw === "string" ? raw : raw?.name,
          },
        ];
      }),
    ).values(),
  ];
  const required = resolve(requirements.required),
    requiredIds = new Set(required.map((s) => s.skillId).filter(Boolean));
  const preferred = resolve(requirements.preferred).filter(
    (s) => !s.skillId || !requiredIds.has(s.skillId),
  );
  const coverage = (list) => ({
    total: list.length,
    matched: list.filter((s) => s.skillId && candidateIds.has(s.skillId))
      .length,
    missing: list
      .filter((s) => s.skillId && !candidateIds.has(s.skillId))
      .map((s) => s.skillId),
    unmapped: list.filter((s) => !s.skillId).map((s) => s.requirement),
  });
  const features = {
    required: coverage(required),
    preferred: coverage(preferred),
    experience: {
      minimum:
        Number.isFinite(minimumExperienceYears) && minimumExperienceYears > 0
          ? minimumExperienceYears
          : null,
      observed:
        Number.isFinite(experienceYears) &&
        experienceYears >= 0 &&
        experienceYears <= 60
          ? experienceYears
          : null,
    },
    knockouts: knockouts.map((k) => ({
      questionId: k.questionId,
      questionVersion: k.questionVersion,
      minimumScore: k.minimumScore,
      score: k.score ?? null,
      passed: k.score != null ? k.score >= k.minimumScore : null,
    })),
  };
  const warnings = [];
  if (features.required.unmapped.length || features.preferred.unmapped.length)
    warnings.push("Resolve unmapped job skills before using this score.");
  if (
    features.experience.minimum != null &&
    features.experience.observed == null
  )
    warnings.push("Experience evidence is missing.");
  if (features.knockouts.some((k) => k.passed === null))
    warnings.push("A knockout answer is missing.");
  const components = [];
  for (const key of ["required", "preferred"])
    if (features[key].total)
      components.push({
        key,
        weight: FIT_WEIGHTS[key],
        ratio: features[key].matched / features[key].total,
      });
  if (
    features.experience.minimum != null &&
    features.experience.observed != null
  )
    components.push({
      key: "experience",
      weight: FIT_WEIGHTS.experience,
      ratio: Math.min(
        1,
        features.experience.observed / features.experience.minimum,
      ),
    });
  if (!components.length && !features.knockouts.length)
    warnings.push("No scorable role requirements are configured.");
  const knockoutFailed = features.knockouts.some((k) => k.passed === false);
  const scorePct = warnings.length
    ? null
    : knockoutFailed
      ? 0
      : !components.length
        ? 100
        : round(
            (100 * components.reduce((sum, c) => sum + c.weight * c.ratio, 0)) /
              components.reduce((sum, c) => sum + c.weight, 0),
          );
  const explanation = {
    features,
    components: components.map((c) => ({ ...c, ratio: round(c.ratio) })),
    weights: FIT_WEIGHTS,
    warnings,
    advisory: true,
    humanDecisionRequired: true,
  };
  const inputHash = createHash("sha256")
    .update(
      JSON.stringify({
        model: FIT_MODEL_VERSION,
        features,
        weights: FIT_WEIGHTS,
      }),
    )
    .digest("hex");
  return {
    modelVersion: FIT_MODEL_VERSION,
    inputHash,
    scorePct,
    knockoutFailed,
    explanation,
  };
}
export function rankFitScores(rows, { percent = 10, minimumScore = 0 } = {}) {
  const eligible = rows
    .filter((r) => Number.isFinite(r.scorePct) && !r.knockoutFailed)
    .sort(
      (a, b) => b.scorePct - a.scorePct || a.applicationId - b.applicationId,
    );
  const top = Math.max(
    eligible.length ? 1 : 0,
    Math.ceil((eligible.length * percent) / 100),
  );
  const cutoff = eligible[top - 1]?.scorePct ?? Infinity;
  let rank = 0,
    last = null;
  return eligible.map((row, n) => {
    if (row.scorePct !== last) rank = n + 1;
    last = row.scorePct;
    return {
      ...row,
      rank,
      proposed: row.scorePct >= cutoff && row.scorePct >= minimumScore,
    };
  });
}
