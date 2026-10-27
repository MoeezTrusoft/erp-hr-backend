import { transitionApplicationStage } from "./applicationWorkflow.service.js";

/** Called inside verified draft submission after consent and all answers validate.
 * Recruited pool members enter screening with invitation provenance; this never
 * fabricates a screening decision or bypasses the interview prerequisites.
 */
export async function convertAcceptedPoolInvitation(db, application) {
  await db.$queryRawUnsafe(
    'SELECT id FROM "Application" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
    application.id,
    application.tenantId,
  );
  const current = await db.application.findFirst({
    where: { id: application.id, tenantId: application.tenantId },
  });
  if (
    !current ||
    current.talentPoolInvitationId ||
    current.stage !== "applied" ||
    current.status !== "open"
  )
    return current ?? application;
  application = current;
  const invitation = await db.talentPoolInvitation.findFirst({
    where: {
      tenantId: application.tenantId,
      candidateId: application.candidateId,
      jobRequisitionId: application.jobRequisitionId,
      status: "ACCEPTED",
    },
    orderBy: [{ respondedAt: "desc" }, { id: "desc" }],
  });
  if (!invitation) return application;
  await db.application.update({
    where: { id: application.id },
    data: { talentPoolInvitationId: invitation.id },
  });
  await transitionApplicationStage({
    db,
    id: application.id,
    tenantId: application.tenantId,
    targetStage: "screening",
    expectedVersion: application.version,
    actorId: null,
    source: "talent-pool-invitation",
    reason:
      "Accepted talent-pool invitation; candidate completed the application",
  });
  return {
    ...application,
    talentPoolInvitationId: invitation.id,
    stage: "screening",
    version: application.version + 1,
  };
}
