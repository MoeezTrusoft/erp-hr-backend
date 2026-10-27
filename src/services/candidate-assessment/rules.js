import { randomInt } from "node:crypto";
export function fail(message, status = 422, code = "HR-6000") {
  throw Object.assign(new Error(message), { status, code });
}
export const json = (v) => JSON.parse(JSON.stringify(v));
export const shuffle = (values, random = randomInt) => {
  const a = [...values];
  for (let n = a.length - 1; n > 0; n--) {
    const j = random(n + 1);
    [a[n], a[j]] = [a[j], a[n]];
  }
  return a;
};
export function difficultyCounts(section) {
  const rows = Object.entries(section.difficultyMix).map(
    ([difficulty, pct]) => ({
      difficulty,
      n: Math.floor((section.itemCount * pct) / 100),
      fraction: ((section.itemCount * pct) / 100) % 1,
    }),
  );
  let remaining = section.itemCount - rows.reduce((a, r) => a + r.n, 0);
  for (const r of [...rows].sort((a, b) => b.fraction - a.fraction)) {
    if (remaining-- <= 0) break;
    r.n++;
  }
  return rows;
}
export function assemble(blueprint, items, seenCodes = [], random = randomInt) {
  const seen = new Set(seenCodes),
    used = new Set(),
    draw = [];
  for (const section of blueprint.sections) {
    for (const { difficulty, n } of difficultyCounts(section)) {
      const pool = items.filter(
        (i) =>
          i.status === "PUBLISHED" &&
          i.competencyKey === section.competencyKey &&
          i.difficulty === difficulty &&
          i.language === blueprint.language &&
          i.jobFamily === blueprint.jobFamily &&
          !seen.has(i.itemCode) &&
          !used.has(i.itemCode) &&
          i.exposureCount < i.exposureCap,
      );
      if (pool.length < n)
        fail(
          "Not enough unseen eligible items; ask the recruiter for an alternative",
          409,
          "HR-6004",
        );
      for (const i of shuffle(pool, random).slice(0, n)) {
        used.add(i.itemCode);
        draw.push({
          itemId: i.id,
          itemVersion: i.version,
          itemCode: i.itemCode,
          sectionKey: section.key,
          optionOrder: shuffle(
            i.options.map((o) => o.key),
            random,
          ),
        });
      }
    }
  }
  return blueprint.sections.some((section) => section.durationMin != null)
    ? blueprint.sections.flatMap((section) =>
        shuffle(
          draw.filter((item) => item.sectionKey === section.key),
          random,
        ),
      )
    : shuffle(draw, random);
}
export function validatePool(blueprint, items) {
  for (const s of blueprint.sections)
    for (const { difficulty, n } of difficultyCounts(s)) {
      const codes = new Set(
        items
          .filter(
            (i) =>
              i.status === "PUBLISHED" &&
              i.competencyKey === s.competencyKey &&
              i.difficulty === difficulty &&
              i.language === blueprint.language &&
              i.jobFamily === blueprint.jobFamily &&
              i.exposureCount < i.exposureCap,
          )
          .map((i) => i.itemCode),
      );
      if (codes.size < n * 3)
        fail(
          "Each difficulty pool must contain at least three times the draw: " +
            s.key +
            " / " +
            difficulty,
          409,
          "HR-6004",
        );
    }
}
export function scoreItem(item, key, answer, penalty = 0) {
  if (
    answer === null ||
    answer === undefined ||
    (Array.isArray(answer) && !answer.length)
  )
    return 0;
  let score;
  if (item.type === "NUMERIC") {
    if (typeof answer !== "number" || !Number.isFinite(answer))
      fail("A finite numeric answer is required");
    score = Math.abs(answer - key.value) <= key.tolerance ? 1 : 0;
  } else {
    if (
      !Array.isArray(answer) ||
      new Set(answer).size !== answer.length ||
      answer.some((k) => !item.options.some((o) => o.key === k)) ||
      (item.type !== "MULTI" && answer.length > 1)
    )
      fail("Answer does not match the item options");
    const hits = answer.filter((k) => key.keys.includes(k)).length,
      wrong = answer.length - hits;
    score =
      item.type === "MULTI" && item.scoringRule === "PARTIAL"
        ? Math.max(
            0,
            hits / key.keys.length -
              wrong / Math.max(1, item.options.length - key.keys.length),
          )
        : hits === key.keys.length && !wrong
          ? 1
          : 0;
  }
  return score === 0 ? (penalty ? -penalty : 0) : score;
}
export function scoreTest(
  blueprint,
  draw,
  items,
  responses,
  keys,
  flags = 0,
  incomplete = false,
) {
  const sections = blueprint.sections.map((s) => {
    const refs = draw.filter((d) => d.sectionKey === s.key);
    let raw = 0;
    for (const ref of refs) {
      const item = items.find(
        (i) => i.id === ref.itemId && i.version === ref.itemVersion,
      );
      if (!item) fail("Frozen test item is unavailable", 409);
      raw += scoreItem(
        item,
        keys[item.id],
        responses.find((r) => r.itemId === item.id)?.answer,
        blueprint.negativeMarking,
      );
    }
    const pct = refs.length ? Math.max(0, (100 * raw) / refs.length) : 0;
    return {
      key: s.key,
      competencyKey: s.competencyKey,
      rawScore: raw,
      maxScore: refs.length,
      scorePct: pct,
      weight: s.weight,
      mustPass: s.mustPass,
      passMarkPct: s.passMarkPct,
    };
  });
  const maxScore = draw.length,
    rawScore = sections.reduce((a, s) => a + s.rawScore, 0),
    scorePct =
      sections.reduce((a, s) => a + s.scorePct * s.weight, 0) /
      sections.reduce((a, s) => a + s.weight, 0),
    mustPassFailed = sections.some(
      (s) => s.mustPass && s.scorePct < s.passMarkPct,
    );
  const band = incomplete
    ? "INCOMPLETE"
    : flags >= blueprint.integrityThreshold
      ? "REVIEW"
      : mustPassFailed
        ? "FAILED"
        : scorePct >= blueprint.passMarkPct
          ? "PASSED"
          : scorePct >= blueprint.passMarkPct - blueprint.borderlineBandPct
            ? "BORDERLINE"
            : "FAILED";
  return {
    rawScore,
    maxScore,
    scorePct,
    sectionScores: sections,
    mustPassFailed,
    band,
    integrityFlagCount: flags,
  };
}
export function evaluateForm(form, panelRole, input, { submit = false } = {}) {
  const criteria = form.sections
      .filter((s) => !s.panelRoles.length || s.panelRoles.includes(panelRole))
      .flatMap((s) => s.criteria),
    byKey = new Map(input.criterionScores.map((a) => [a.key, a]));
  if (
    byKey.size !== input.criterionScores.length ||
    [...byKey.keys()].some((k) => !criteria.some((c) => c.key === k))
  )
    fail("Unknown or duplicate criterion");
  let value = 0,
    maximum = 0,
    mustHaveFailed = false,
    completed = 0;
  for (const c of criteria) {
    const a = byKey.get(c.key),
      max = c.scale === "FIVE" ? 5 : c.scale === "FOUR" ? 4 : 1,
      min = c.scale === "YES_NO" ? 0 : 1;
    if (a?.rating == null) {
      if (submit && c.required) fail("Required rating missing: " + c.label);
      continue;
    }
    if (!Number.isInteger(a.rating) || a.rating < min || a.rating > max)
      fail("Rating outside the criterion scale");
    if (
      submit &&
      ([1, 2, 5].includes(a.rating) || c.mustHaveThreshold !== null) &&
      !a.evidence.trim()
    )
      fail("Evidence required: " + c.label);
    if (c.mustHaveThreshold !== null && a.rating <= c.mustHaveThreshold)
      mustHaveFailed = true;
    value += a.rating * c.weight;
    maximum += max * c.weight;
    completed++;
  }
  if (submit && (!input.coiDeclared || !input.recommendation))
    fail("Confirm conflict of interest and select a recommendation");
  return {
    weightedScore: maximum ? (100 * value) / maximum : null,
    mustHaveFailed,
    completed,
    total: criteria.length,
    reviewFlags:
      /\b(age|marital|religion|pregnan|ethnicity|caste|disability|gender)\w*/iu.test(
        [input.notes, ...input.criterionScores.map((a) => a.evidence)].join(
          " ",
        ),
      )
        ? ["PROHIBITED_TOPIC_REVIEW"]
        : [],
  };
}
export function composite(testScore, interviewScore, testWeightPct = 30) {
  if (interviewScore == null) return null;
  return testScore == null
    ? interviewScore
    : (testScore * testWeightPct + interviewScore * (100 - testWeightPct)) /
        100;
}
export function assertAssessmentComplete(interview) {
  if (
    !["NOT_REQUIRED", "PASSED", "BORDERLINE", "OVERRIDDEN", "WAIVED"].includes(
      interview.assessmentStatus ?? "NOT_REQUIRED",
    )
  )
    fail(
      "Complete the assessment or record an authorized decision before submitting interview evidence",
      409,
      "HR-6001",
    );
}
