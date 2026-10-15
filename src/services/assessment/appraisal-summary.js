// Summaries describe signed observations. They never set an overall appraisal
// rating, infer a score from missing evidence, or compare incompatible scopes.
export function appraisalSummary({
  assignment,
  revision,
  snapshot,
  previous,
  evidence,
  restrictions,
  now,
}) {
  const tasks = snapshot.observations.map((observation) => {
    const requirement = assignment.profileSnapshot.requirements.find(
      (r) => r.taskCode === observation.taskCode,
    );
    const task = assignment.profileSnapshot.tasks.find(
      (t) => t.taskCode === observation.taskCode,
    );
    const priorTask = previous?.snapshot?.profile?.tasks?.find(
      (t) => t.taskCode === observation.taskCode,
    );
    const prior = previous?.snapshot?.observations?.find(
      (o) => o.taskCode === observation.taskCode,
    );
    const comparable =
      !!prior &&
      prior.taskVersion === observation.taskVersion &&
      ["scope", "complexity", "technology"].every(
        (key) => priorTask?.[key] === task?.[key],
      );
    return {
      taskCode: observation.taskCode,
      taskVersion: observation.taskVersion,
      scope: task?.scope,
      observedAt: observation.observedAt,
      criticalFailure: observation.criticalFailure,
      dimensions: observation.dimensions.map((d) => {
        const required =
          requirement?.[
            { K: "requiredK", S: "requiredS", V: "targetV" }[d.dimension]
          ] ?? null;
        const priorDimension = prior?.dimensions.find(
          (p) => p.dimension === d.dimension,
        );
        return {
          dimension: d.dimension,
          status: d.status,
          score: d.score,
          required,
          reasonCode: d.reasonCode,
          expiresAt: d.expiresAt,
          gap:
            required !== null && d.status === "RATED"
              ? Math.max(0, required - d.score)
              : null,
          gapType:
            required === null || d.status === "NOT_APPLICABLE"
              ? null
              : d.status === "PENDING"
                ? "EVIDENCE_GAP"
                : d.score < required
                  ? "CAPABILITY_GAP"
                  : null,
          trend: {
            previousRevisionRef: previous?.id ?? null,
            comparable,
            delta:
              comparable &&
              d.status === "RATED" &&
              priorDimension?.status === "RATED"
                ? d.score - priorDimension.score
                : null,
            reason: !previous
              ? "NO_PRIOR_ASSESSMENT"
              : !comparable
                ? "SCOPE_OR_VERSION_CHANGED"
                : d.status !== "RATED" || priorDimension?.status !== "RATED"
                  ? "NUMERIC_EVIDENCE_UNAVAILABLE"
                  : null,
          },
        };
      }),
    };
  });
  const evidenceRecency = evidence.map((e) => ({
    evidenceRef: e.id,
    sourceVersion: e.sourceVersion,
    capturedAt: e.captureAt,
    expiresAt: e.expiresAt,
    ageDays: Math.max(
      0,
      Math.floor((+now - +new Date(e.captureAt)) / 86400000),
    ),
  }));
  return {
    assessmentRef: assignment.id,
    revisionDigest: revision.digest,
    profileRef: assignment.profileRef,
    profileVersion: assignment.profileSnapshot.profileVersion,
    selectionPolicy: "LATEST_APPLICABLE_APPROVED_OBSERVATION",
    summaries: snapshot.summaries,
    tasks,
    requirementGaps: tasks.flatMap((t) =>
      t.dimensions
        .filter((d) => d.gapType)
        .map((d) => ({
          taskCode: t.taskCode,
          taskVersion: t.taskVersion,
          ...d,
        })),
    ),
    restrictions: restrictions.map((r) => ({
      restrictionRef: r.id,
      taskCode: r.taskCode,
      cause: r.cause,
      sourceRef: r.sourceRef,
    })),
    evidenceRecency,
    previousRevisionRef: previous?.id ?? null,
    narrativeDraft: true,
    narrative: `Approved observations for ${tasks.length} task(s), with separate K/S/V coverage and evidence references. Pending evidence requires context; it is not a demonstrated capability failure.`,
    reviewChecklist: [
      "Confirm the applicable role, scope and assessment period.",
      "Review coverage, evidence age, gaps and restrictions separately for K, S and V.",
      "Explain changes only where task scope and versions are comparable.",
      "Review business outcomes and context through the existing appraisal workflow.",
    ],
  };
}
