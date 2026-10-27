// Evaluate only the most recent attempt in the family. An older pass must not
// override a newer failed/reviewed attempt, and an old RETEST approval is single use.
export function attemptPolicy(attempt, result, blueprint, now) {
  if (!attempt) return { kind: "NEW" };
  if (["ISSUED", "IN_PROGRESS", "PAUSED"].includes(attempt.status))
    return { kind: "ACTIVE" };
  const completed =
    attempt.submittedAt ?? attempt.startedAt ?? attempt.issuedAt;
  if (
    attempt.status === "SUBMITTED" &&
    result &&
    !result.decision &&
    ["PASSED", "BORDERLINE"].includes(result.band) &&
    attempt.submittedAt &&
    +new Date(attempt.submittedAt) + blueprint.resultValidityDays * 86400000 >
      +now
  )
    return { kind: "REUSE", resultId: result.id, band: result.band };
  if (
    result?.decision === "RETEST" &&
    result.decidedById &&
    result.decisionReason?.trim()
  )
    return { kind: "RETEST" };
  if (
    ["VOIDED", "EXPIRED"].includes(attempt.status) ||
    result?.band === "INCOMPLETE"
  )
    return { kind: "REISSUE" };
  const eligibleAt = new Date(
    +new Date(completed) + blueprint.retakeCooldownDays * 86400000,
  );
  return eligibleAt > now ? { kind: "COOLDOWN", eligibleAt } : { kind: "NEW" };
}
