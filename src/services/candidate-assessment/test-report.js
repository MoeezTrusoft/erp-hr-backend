// Called only after interview authorization. Keep answer keys, options and the
// unserved item bank out of every interviewer report and frozen PDF snapshot.
export async function testReport(tx, tenantId, result, targetInterview) {
  if (!result) return null;
  const session = await tx.candidateTestSession.findFirst({
    where: { tenantId, id: result.sessionId },
  });
  if (
    !session ||
    session.candidateId !== targetInterview.application.candidateId
  )
    return null;
  const integrityEvents = await tx.candidateTestIntegrityEvent.findMany({
    where: { tenantId, sessionId: session.id },
    orderBy: { occurredAt: "asc" },
  });
  const weak = result.sectionScores.filter(
    (section) => section.scorePct < section.passMarkPct,
  );
  const questions = [];
  for (const competencyKey of new Set(
    weak.map((section) => section.competencyKey),
  )) {
    questions.push(
      ...(await tx.interviewQuestion.findMany({
        where: { tenantId, status: "PUBLISHED", competencyKey },
        orderBy: [{ version: "desc" }, { id: "desc" }],
        take: 3,
      })),
    );
  }
  const probes = weak.map((section) => ({
    sectionKey: section.key,
    competencyKey: section.competencyKey,
    scorePct: section.scorePct,
    passMarkPct: section.passMarkPct,
    questions: questions
      .filter((q) => q.competencyKey === section.competencyKey)
      .slice(0, 3)
      .map((q) => ({
        id: q.id,
        version: q.version,
        prompt: q.prompt,
        followUps: q.followUps,
        goodAnswerGuide: q.goodAnswerGuide,
      })),
    suggestion:
      "Ask for a recent work example involving " +
      section.competencyKey +
      "; probe the steps taken, checks performed and outcome.",
  }));
  const discussionPrompts = session.itemOrder.length
    ? await tx.candidateTestItem.findMany({
        where: {
          tenantId,
          discussionPrompt: true,
          OR: session.itemOrder.map((ref) => ({
            id: ref.itemId,
            version: ref.itemVersion,
          })),
        },
        select: { id: true, version: true, competencyKey: true, stem: true },
        orderBy: { id: "asc" },
      })
    : [];
  const rows = await tx.$queryRawUnsafe(
    'SELECT DISTINCT ON (s."candidateId") s."candidateId",r."scorePct" FROM "CandidateTestResult" r JOIN "CandidateTestSession" s ON s.id=r."sessionId" AND s."tenantId"=r."tenantId" JOIN interviews i ON i."tenantId"=r."tenantId" AND (i."assessmentResultId"=r.id OR i.id=r."interviewId") JOIN "Application" a ON a.id=i."applicationId" AND a."tenantId"=i."tenantId" WHERE r."tenantId"=$1::uuid AND a."jobRequisitionId"=$2 AND s.status=\'SUBMITTED\' AND r.band IN (\'PASSED\',\'BORDERLINE\',\'FAILED\') AND s."blueprintSnapshot"->>\'jobFamily\'=$3 AND s."blueprintSnapshot"->>\'language\'=$4 ORDER BY s."candidateId",r."createdAt" DESC,r.id DESC',
    tenantId,
    targetInterview.application.jobRequisitionId,
    session.blueprintSnapshot.jobFamily,
    session.blueprintSnapshot.language,
  );
  const cohortSize = rows.length,
    below = rows.filter((r) => r.scorePct < result.scorePct).length,
    equal = rows.filter((r) => r.scorePct === result.scorePct).length;
  const minimumCohort = 5;
  const planned =
    session.blueprintSnapshot.durationMin *
    60000 *
    (1 + session.extraTimePct / 100);
  const pauses =
    session.startedAt && session.deadlineAt
      ? Math.max(0, session.deadlineAt - session.startedAt - planned)
      : 0;
  const timeTakenSec =
    session.startedAt && session.submittedAt
      ? Math.max(
          0,
          Math.round(
            (Math.min(+session.submittedAt, +session.deadlineAt) -
              session.startedAt -
              pauses) /
              1000,
          ),
        )
      : null;
  return {
    ...result,
    percentile:
      ["PASSED", "BORDERLINE", "FAILED"].includes(result.band) &&
      session.status === "SUBMITTED" &&
      cohortSize >= minimumCohort
        ? Math.round(((below + equal / 2) / cohortSize) * 1000) / 10
        : null,
    cohortSize,
    minimumCohort,
    percentileMethod: "MIDRANK_LATEST_CANDIDATE",
    timeTakenSec,
    integrityEvents,
    probes,
    discussionPrompts,
    sourceInterviewId: result.interviewId,
    reused: result.interviewId !== targetInterview.id,
    language: session.blueprintSnapshot.language,
    blueprintVersion: session.blueprintVersion,
  };
}
