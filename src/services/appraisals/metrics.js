export async function cycleMetrics(tx, tenantId, cycleId, asOf = new Date()) {
  const population = await tx.perfParticipant.count({
    where: { tenantId, cycleId, inclusionState: "INCLUDED" },
  });
  const states = await tx.perfReview.groupBy({
    by: ["state"],
    where: { tenantId, cycleId },
    _count: { id: true },
  });
  // Completion means an outcome was released. A correction does not undo that
  // historical fact; use the immutable first signoff for release timeliness.
  const [health] = await tx.$queryRaw`
    WITH first_release AS (
      SELECT "tenantId", "reviewId", min("createdAt") AS at
      FROM "PerfSignoff" WHERE "tenantId"=${tenantId}::uuid AND action='RELEASE'
      GROUP BY "tenantId", "reviewId"
    ), first_self AS (
      SELECT "tenantId", "reviewId", min("submittedAt") AS at
      FROM "PerfResponse" WHERE "tenantId"=${tenantId}::uuid AND role='SELF' AND "submittedAt" IS NOT NULL
      GROUP BY "tenantId", "reviewId"
    )
    SELECT
      count(*) FILTER(WHERE r."releasedRevisionId" IS NOT NULL)::int AS released,
      count(*) FILTER(WHERE f.at<=p."originalManagerDue")::int AS "originalOnTime",
      count(*) FILTER(WHERE f.at<=r."managerDue")::int AS "adjustedOnTime",
      count(*) FILTER(WHERE s.at IS NOT NULL)::int AS "selfSubmitted",
      count(*) FILTER(WHERE s.at<=p."originalSelfDue")::int AS "selfOriginalOnTime",
      count(*) FILTER(WHERE s.at<=r."selfDue")::int AS "selfAdjustedOnTime",
      count(*) FILTER(WHERE r."selfWaiver" IS NOT NULL)::int AS "selfWaived",
      count(*) FILTER(WHERE r.state='SELF_OPEN' AND r."selfDue"<${asOf})::int AS "selfOverdue",
      count(*) FILTER(WHERE r."releasedRevisionId" IS NULL AND r.state IN ('SELF_OPEN','SELF_SUBMITTED') AND r."managerDue"<${asOf})::int AS "managerOverdue",
      count(*) FILTER(WHERE r.state='ACKNOWLEDGED')::int AS acknowledged,
      count(*) FILTER(WHERE r."releasedRevisionId" IS NOT NULL AND r.state NOT IN ('RELEASED','ACKNOWLEDGED'))::int AS "correctionsInProgress"
    FROM "PerfParticipant" p
    LEFT JOIN "PerfReview" r ON r."tenantId"=p."tenantId" AND r."participantId"=p.id
    LEFT JOIN first_release f ON f."tenantId"=r."tenantId" AND f."reviewId"=r.id
    LEFT JOIN first_self s ON s."tenantId"=r."tenantId" AND s."reviewId"=r.id
    WHERE p."tenantId"=${tenantId}::uuid AND p."cycleId"=${cycleId}::uuid AND p."inclusionState"='INCLUDED'`;
  const [cases] = await tx.$queryRaw`
    SELECT count(*)::int AS "openAppeals" FROM "PerfAppeal" a
    JOIN "PerfReview" r ON r."tenantId"=a."tenantId" AND r.id=a."reviewId"
    WHERE r."tenantId"=${tenantId}::uuid AND r."cycleId"=${cycleId}::uuid AND a.status='OPEN'`;
  const released = health.released;
  const distribution = await releasedDistribution(tx, tenantId, cycleId);
  return {
    cycleId,
    metricVersion: 2,
    asOf,
    population,
    released,
    notStarted: population - states.reduce((n, s) => n + s._count.id, 0),
    completionPercent: population
      ? Math.round((released * 10000) / population) / 100
      : null,
    ...health,
    ...cases,
    distribution,
    states: states.map((s) => ({ state: s.state, count: s._count.id })),
    scope:
      "Frozen included roster. Completion counts reviews with a released outcome, including corrections in progress. First release and first self-submission are compared with original and effective response deadlines. These are response deadlines, not a separate release SLA.",
  };
}

export async function releasedDistribution(tx, tenantId, cycleId) {
  // No employee, manager, department or demographic filters: small cohort
  // subtraction must not recover individual ratings from this aggregate view.
  const rows = await tx.$queryRaw`
    WITH released AS (
      SELECT v.score, t.rubric FROM "PerfReview" r
      JOIN "PerfParticipant" p ON p."tenantId"=r."tenantId" AND p.id=r."participantId" AND p."inclusionState"='INCLUDED'
      JOIN "PerfReviewRevision" v ON v."tenantId"=r."tenantId" AND v.id=r."releasedRevisionId"
      JOIN "PerfCycle" c ON c."tenantId"=r."tenantId" AND c.id=r."cycleId"
      JOIN "PerfTemplateVersion" t ON t."tenantId"=c."tenantId" AND t.id=c."templateId"
      WHERE r."tenantId"=${tenantId}::uuid AND r."cycleId"=${cycleId}::uuid
    ), bands AS (
      SELECT 'RELEASED' AS stage, score->>'band' AS band FROM released
      UNION ALL
      SELECT 'CALCULATED' AS stage,
        (SELECT b->>'label' FROM jsonb_array_elements(rubric->'bands') b
         WHERE (b->>'min')::numeric * (score->>'denominator')::numeric <= (score->>'numerator')::numeric * 100
         ORDER BY (b->>'min')::numeric DESC LIMIT 1) AS band
      FROM released
    )
    SELECT stage, band, count(*)::int AS count FROM bands GROUP BY stage, band ORDER BY stage, band`;
  const minimum = 5;
  const population = rows
    .filter((r) => r.stage === "RELEASED")
    .reduce((n, r) => n + r.count, 0);
  const suppressed =
    population < minimum || rows.some((r) => !r.band || r.count < minimum);
  return {
    basis:
      "Latest released revisions only; calculated score before calibration versus released band. Unreleased corrections are excluded.",
    minimum,
    population,
    suppressed,
    reason: suppressed
      ? "Distribution withheld because at least one populated rating group has fewer than five reviews."
      : null,
    bands: suppressed ? [] : rows,
    potential: {
      available: false,
      reason:
        "No separately approved potential assessment is linked to this cycle.",
    },
  };
}

export function cycleMetricsCsv(report) {
  // Quote every cell and neutralise spreadsheet formulas, including tabs/CR.
  const cell = (value) => {
    let text = String(value ?? "");
    if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const lines = [
    ["section", "measure", "value"],
    ["metadata", "cycleId", report.cycleId],
    ["metadata", "metricVersion", report.metricVersion],
    [
      "metadata",
      "asOf",
      report.asOf instanceof Date ? report.asOf.toISOString() : report.asOf,
    ],
    ["metadata", "scope", report.scope],
    ["metadata", "closingSnapshotAvailable", !!report.closingSnapshot],
  ];
  for (const name of [
    "population",
    "released",
    "notStarted",
    "completionPercent",
    "originalOnTime",
    "adjustedOnTime",
    "selfSubmitted",
    "selfOriginalOnTime",
    "selfAdjustedOnTime",
    "selfWaived",
    "selfOverdue",
    "managerOverdue",
    "acknowledged",
    "correctionsInProgress",
    "openAppeals",
  ])
    lines.push(["health", name, report[name]]);
  for (const state of report.states)
    lines.push(["state", state.state, state.count]);
  lines.push(
    ["distribution", "basis", report.distribution.basis],
    ["distribution", "suppressed", report.distribution.suppressed],
  );
  if (report.distribution.suppressed)
    lines.push(["distribution", "reason", report.distribution.reason]);
  else
    for (const row of report.distribution.bands)
      lines.push([row.stage, row.band, row.count]);
  return (
    "\uFEFF" + lines.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n"
  );
}
