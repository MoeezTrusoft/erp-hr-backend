import { fail } from "./rules.js";
export const MINIMUM_COHORT = 5;
export const MINIMUM_COMPARISON = 20;
const scored = (r) =>
  r.status === "SUBMITTED" &&
  ["PASSED", "BORDERLINE", "FAILED"].includes(r.band);
const passed = (r) => ["PASSED", "BORDERLINE"].includes(r.band);
const review = (r) => ["FAILED", "REVIEW", "INCOMPLETE"].includes(r.band);
const rate = (n, d) => (d ? n / d : null);
function measures(rows, suppress = false) {
  const completed = rows.filter(scored),
    reviewRequired = rows.filter(review);
  return {
    count: suppress ? null : rows.length,
    completed: suppress ? null : completed.length,
    passRate:
      suppress || completed.length < MINIMUM_COHORT
        ? null
        : rate(completed.filter(passed).length, completed.length),
    incompleteRate: suppress
      ? null
      : rate(rows.filter((r) => r.band === "INCOMPLETE").length, rows.length),
    overrideRate:
      suppress || reviewRequired.length < MINIMUM_COHORT
        ? null
        : rate(
            rows.filter((r) => r.decision === "OVERRIDE").length,
            reviewRequired.length,
          ),
    reviewRequired: suppress ? null : reviewRequired.length,
    suppressed: suppress,
  };
}
// Input rows are the bounded, newest-first results from one company. Only aggregate
// output leaves this function; candidate identities and accommodation reasons do not.
export function summarizeAssessments(rows, { truncated = false } = {}) {
  const bands = {},
    decisions = {},
    latest = new Map();
  for (const r of rows) {
    bands[r.band] = (bands[r.band] ?? 0) + 1;
    if (r.decision) decisions[r.decision] = (decisions[r.decision] ?? 0) + 1;
    const identity = JSON.stringify([
      r.candidateId,
      r.requisitionId,
      r.jobFamily,
    ]);
    if (!latest.has(identity)) latest.set(identity, r);
  }
  const groups = new Map();
  for (const r of latest.values()) {
    const key = JSON.stringify([
      r.requisitionId,
      r.blueprintId,
      r.blueprintVersion,
      r.language,
    ]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const items = [...groups]
    .map(([key, values]) => {
      const first = values[0],
        standard = values.filter((r) => !r.extraTime),
        extra = values.filter((r) => r.extraTime);
      // Suppress both sides when a non-empty small cohort could be obtained by subtraction.
      const hidden = [standard, extra].some(
        (v) => v.length > 0 && v.length < MINIMUM_COHORT,
      );
      const overall = measures(values, values.length < MINIMUM_COHORT);
      const timeSupport = [
        { key: "STANDARD_TIME", ...measures(standard, hidden) },
        { key: "EXTRA_TIME", ...measures(extra, hidden) },
      ];
      const comparisonEligible =
        !hidden && timeSupport.every((g) => g.completed >= MINIMUM_COMPARISON);
      const gap = comparisonEligible
        ? Math.abs(timeSupport[0].passRate - timeSupport[1].passRate)
        : null;
      const flags = [];
      if (!truncated) {
        if (
          overall.reviewRequired >= MINIMUM_COMPARISON &&
          overall.overrideRate > 0.2
        )
          flags.push("OVERRIDE_REVIEW");
        if (overall.count >= MINIMUM_COMPARISON && overall.incompleteRate > 0.2)
          flags.push("COMPLETION_REVIEW");
        if (gap !== null && gap + Number.EPSILON >= 0.2)
          flags.push("TIME_SUPPORT_REVIEW");
      }
      return {
        key,
        requisitionId: first.requisitionId,
        requisitionTitle: first.requisitionTitle,
        blueprintId: first.blueprintId,
        blueprintVersion: first.blueprintVersion,
        blueprintName: first.blueprintName,
        jobFamily: first.jobFamily,
        language: first.language,
        passMarkPct: first.passMarkPct,
        ...overall,
        timeSupport,
        timeSupportPassRateGap: gap,
        comparisonEligible,
        flags,
      };
    })
    .sort(
      (a, b) =>
        a.requisitionId - b.requisitionId ||
        a.blueprintId - b.blueprintId ||
        a.blueprintVersion - b.blueprintVersion,
    );
  return {
    total: rows.length,
    bands,
    decisions,
    overrideRate: rate(decisions.OVERRIDE ?? 0, rows.length),
    truncated,
    monitoring: {
      advisory: true,
      minimumCohort: MINIMUM_COHORT,
      minimumComparison: MINIMUM_COMPARISON,
      reviewThreshold: 0.2,
      unit: "LATEST_CANDIDATE_REQUISITION_JOB_FAMILY",
      items,
    },
  };
}
export async function assessmentAnalytics(tx, tenantId, input) {
  const from = new Date(input.from),
    to = new Date(input.to);
  if (
    !Number.isFinite(+from) ||
    !Number.isFinite(+to) ||
    +to <= +from ||
    +to - +from > 366 * 86400000
  )
    fail("Use a positive range up to one year");
  const rows = await tx.$queryRaw`
    SELECT r.id, r.band, r.decision, s.status, s."candidateId",
      a."jobRequisitionId" AS "requisitionId", j.title AS "requisitionTitle",
      s."blueprintId", s."blueprintVersion",
      COALESCE(s."blueprintSnapshot"->>'name','Assessment') AS "blueprintName",
      COALESCE(s."blueprintSnapshot"->>'jobFamily','Unspecified') AS "jobFamily",
      COALESCE(s."blueprintSnapshot"->>'language','Unspecified') AS language,
      (s."blueprintSnapshot"->>'passMarkPct')::double precision AS "passMarkPct",
      (s."extraTimePct" > 0) AS "extraTime"
    FROM "CandidateTestResult" r
    JOIN "CandidateTestSession" s ON s."tenantId"=r."tenantId" AND s.id=r."sessionId"
    JOIN "Application" a ON a."tenantId"=r."tenantId" AND a.id=r."applicationId" AND a."candidateId"=s."candidateId"
    JOIN "Candidate" c ON c."tenantId"=s."tenantId" AND c.id=s."candidateId" AND c."anonymizedAt" IS NULL
    JOIN "JobRequisition" j ON j."tenantId"=a."tenantId" AND j.id=a."jobRequisitionId"
    WHERE r."tenantId"=${tenantId}::uuid AND r."createdAt">=${from} AND r."createdAt"<${to}
    ORDER BY r."createdAt" DESC,r.id DESC LIMIT 10001
  `;
  return summarizeAssessments(rows.slice(0, 10000), {
    truncated: rows.length > 10000,
  });
}
