// Called only after current-round panel authorization. Earlier rounds belong to
// the same application; no current-round drafts or individual peer notes escape.
export async function earlierRoundContext(tx, tenantId, interview) {
  const rounds = await tx.interview.findMany({
    where: {
      tenantId,
      applicationId: interview.applicationId,
      id: { not: interview.id },
      status: "COMPLETED",
      scheduledAt: { lt: interview.scheduledAt },
    },
    select: {
      id: true,
      interviewType: true,
      scheduledAt: true,
      decision: true,
    },
    orderBy: [{ scheduledAt: "desc" }, { id: "desc" }],
    take: 21,
  });
  const visible = rounds.slice(0, 20),
    summaries = visible.length
      ? await tx.candidateEvaluationSummary.findMany({
          where: {
            tenantId,
            applicationId: interview.applicationId,
            interviewId: { in: visible.map((r) => r.id) },
          },
          select: {
            interviewId: true,
            interviewScorePct: true,
            compositeScore: true,
            frozenAt: true,
          },
        })
      : [];
  return {
    truncated: rounds.length > 20,
    items: visible.map((r) => ({
      interviewId: r.id,
      interviewType: r.interviewType,
      scheduledAt: r.scheduledAt,
      decision: r.decision,
      summary: summaries.find((s) => s.interviewId === r.id) ?? null,
    })),
  };
}
