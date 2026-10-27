import { assertNotHiringFrozen } from "./recruitmentFreeze.service.js";
import {
  storedBoardConfig,
  validateBoardBinding,
  boardReference,
  boardJobUrl,
  validateBoardJob,
} from "../lib/job-board-feeds.js";
import { PUBLIC_JOB_SELECT, toPublicJob } from "../lib/publicPortal.js";
const fail = (message, status = 422) => {
  throw Object.assign(new Error(message), { status, code: "HR-5314" });
};
// Caller holds the company policy advisory lock. Publication takes the same lock
// before requisition rows; other close/withdraw paths only take requisition locks.
export async function applyJobBoardSettings(
  db,
  { tenantId, previous, next, actorId, canPublish, reconcile = false, now = new Date() },
) {
  if (next === undefined || (!reconcile && JSON.stringify(previous) === JSON.stringify(next)))
    return;
  const config = storedBoardConfig(next);
  if (!config) return; // Explicit disabled settings override the deployment fallback.
  try {
    validateBoardBinding(tenantId, config);
  } catch {
    fail(
      "The careers website must be assigned to this company and feed signing must be configured before enabling a provider",
    );
  }
  const rows = await db.jobRequisition.findMany({
    where: {
      tenantId,
      status: "POSTED",
      postings: { some: { tenantId, channel: "CAREER_SITE", isActive: true, closedAt: null } },
    },
    select: { id: true },
    orderBy: { id: "asc" },
    take: 10001,
  });
  if (rows.length > 10000) fail("The company exceeds the supported feed inventory", 409);
  if (!rows.length) return;
  await db.$queryRawUnsafe(
    'SELECT id FROM "JobRequisition" WHERE "tenantId"=$1::uuid AND id=ANY($2::int[]) ORDER BY id FOR UPDATE',
    tenantId,
    rows.map((r) => r.id),
  );
  const current = await db.jobRequisition.findMany({
    where: { tenantId, id: { in: rows.map((r) => r.id) }, status: "POSTED" },
    select: PUBLIC_JOB_SELECT,
    orderBy: { id: "asc" },
  });
  const requisitionsById = new Map(current.map((row) => [row.id, row]));
  const jobs = current.map((row) => toPublicJob(row, { now })).filter((job) => job.eligible);
  const postings = await db.jobPosting.findMany({
    where: {
      tenantId,
      requisitionId: { in: jobs.map((j) => j.id) },
      channel: { in: ["INDEED", "LINKEDIN"] },
      isActive: true,
      closedAt: null,
    },
    select: { id: true, requisitionId: true, channel: true, channelRef: true },
  });
  const byJobChannel = new Map();
  for (const posting of postings) {
    const key = posting.requisitionId + ":" + posting.channel;
    byJobChannel.set(key, [...(byJobChannel.get(key) || []), posting]);
  }
  const additions = [];
  for (const job of jobs) {
    for (const channel of ["INDEED", "LINKEDIN"]) {
      if (!config[channel]) continue;
      const matching = byJobChannel.get(job.id + ":" + channel) || [];
      if (
        matching.length > 1 ||
        matching.some((p) => p.channelRef !== boardReference(tenantId, job.id, channel))
      )
        fail("Close legacy or duplicate job-board postings before enabling the managed feed", 409);
      if (channel === "LINKEDIN" && !matching.length) continue; // LinkedIn remains per-requisition opt-in.
      try {
        validateBoardJob(config, job, channel);
      } catch {
        fail(
          "Complete public job content and exact location mappings for every included vacancy before enabling this provider",
          409,
        );
      }
      if (!previous?.[channel]?.enabled || !matching.length)
        await assertNotHiringFrozen(tenantId, requisitionsById.get(job.id), "publication", db);
      if (channel === "INDEED" && !matching.length)
        additions.push({
          tenantId,
          requisitionId: job.id,
          channel,
          channelRef: boardReference(tenantId, job.id, channel),
          externalUrl: boardJobUrl(config, job.id, channel),
          isActive: true,
          postedAt: now,
          postedById: actorId,
        });
    }
  }
  if (additions.length) {
    if (!canPublish)
      fail(
        "Recruitment create permission is also required to include existing public vacancies on Indeed",
        403,
      );
    // No skipDuplicates: a conflicting identity must roll back the policy version.
    await db.jobPosting.createMany({ data: additions });
  }
}
