export const snapshotApplicationQuestions = (questions) =>
  questions.map((q) => ({
    questionId: q.id,
    questionVersion: q.version,
    knockout: q.knockout === true,
    minimumScore: q.minimumScore ?? null,
  }));
export function applicationKnockoutEvidence(
  application,
  fallbackQuestions = [],
) {
  const answers = new Map(application.answers.map((a) => [a.questionId, a]));
  const snapshot = Array.isArray(application.questionSnapshot)
    ? application.questionSnapshot
    : snapshotApplicationQuestions(
        application.answers.length
          ? application.answers.map((a) => a.question)
          : fallbackQuestions,
      );
  return snapshot
    .filter((q) => q.knockout)
    .map((q) => ({ ...q, score: answers.get(q.questionId)?.score ?? null }));
}
