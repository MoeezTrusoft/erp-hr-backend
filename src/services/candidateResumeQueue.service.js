import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { requireRecruitmentActor } from "./recruitmentActor.service.js";
import { assertCommunicationsAllowed } from "./candidatePrivacy.service.js";
const error = (message, status = 409) =>
  Object.assign(new Error(message), { status, code: "HR-5901" });
export async function enqueueCandidateResume(
  db,
  { tenantId, candidateId, mediaId, now = new Date() },
) {
  await db.$queryRawUnsafe(
    'SELECT id FROM "Candidate" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
    Number(candidateId),
    tenantId,
  );
  const candidate = await db.candidate.findFirst({
    where: {
      id: Number(candidateId),
      tenantId,
      anonymizedAt: null,
      status: "active",
    },
  });
  if (!candidate) throw error("Candidate not found", 404);
  const asset = Number(mediaId ?? candidate.resumeMediaId);
  if (
    !Number.isSafeInteger(asset) ||
    asset <= 0 ||
    asset !== candidate.resumeMediaId
  )
    throw error("Select the candidate’s current resume", 400);
  await assertCommunicationsAllowed(
    {
      tenantId,
      candidateId: candidate.id,
      purpose: "PROCESSING",
      requireExplicitConsent: true,
    },
    { db },
  );
  const job = await db.candidateResumeParseJob.upsert({
    where: {
      tenantId_candidateId_mediaId: {
        tenantId,
        candidateId: candidate.id,
        mediaId: asset,
      },
    },
    create: { tenantId, candidateId: candidate.id, mediaId: asset, dueAt: now },
    update: {},
  });
  if (["PENDING", "RETRY", "RUNNING"].includes(job.status))
    await db.candidate.update({
      where: { id: candidate.id },
      data: {
        parseStatus: job.status === "RUNNING" ? "RUNNING" : "PENDING",
        parseError: null,
      },
    });
  return {
    candidateId: candidate.id,
    mediaId: asset,
    jobId: job.id,
    status: job.status,
    queued: ["PENDING", "RETRY", "RUNNING"].includes(job.status),
  };
}
export async function requestCandidateResumeParse(args) {
  await requireRecruitmentActor({
    tenantId: args.tenantId,
    permission: "hr.recruitment.create",
    allowedScopes: ["ORG"],
  });
  return tenantTransaction(prisma, (db) => enqueueCandidateResume(db, args), {
    tenantId: args.tenantId,
  });
}
