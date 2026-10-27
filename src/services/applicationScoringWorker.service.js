import { applyAutomaticKnockout } from "./applicationAutoDisposition.service.js";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { runWithRequestContext } from "../lib/requestContext.js";
import { refreshFitScore } from "./applicationFitScore.service.js";
// The scheduler provides SYSTEM only for bounded tenant discovery. All scoring
// runs under tenant RLS; row locks and score input hashes make retries harmless.
export async function runApplicationScoring({ now = new Date(), limit = 100, tenantId } = {}) {
  const rows = await prisma.application.findMany({
    where: {
      tenantId: tenantId ?? { not: null },
      stage: { notIn: ["hired", "rejected", "withdrawn"] },
      candidate: {
        anonymizedAt: null,
        status: "active",
        archivedAt: null,
        consentStatus: "GRANTED",
        OR: [{ retentionUntil: null }, { retentionUntil: { gt: now } }],
      },
      OR: [
        { fitScoreCheckedAt: null },
        { fitScoreCheckedAt: { lt: new Date(now.getTime() - 15 * 60000) } },
      ],
    },
    select: { id: true, tenantId: true, candidateId: true },
    orderBy: [{ fitScoreCheckedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    take: Math.max(1, Math.min(500, limit)),
  });
  let scored = 0,
    failed = 0;
  for (const row of rows)
    await runWithRequestContext({ system: false, user: { tenantId: row.tenantId } }, async () => {
      try {
        const committed = await tenantTransaction(
          prisma,
          async (db) => {
            const owner =
              await db.$queryRaw`SELECT id FROM "Candidate" WHERE id=${row.candidateId} AND "tenantId"=${row.tenantId}::uuid FOR UPDATE SKIP LOCKED`;
            if (!owner.length) return;
            const claimed =
              await db.$queryRaw`SELECT id FROM "Application" WHERE id=${row.id} AND "tenantId"=${row.tenantId}::uuid AND "candidateId"=${row.candidateId} AND stage NOT IN ('hired','rejected','withdrawn') AND ("fitScoreCheckedAt" IS NULL OR "fitScoreCheckedAt" < ${new Date(now.getTime() - 15 * 60000)}) FOR UPDATE SKIP LOCKED`;
            if (!claimed.length) return;
            const score = await refreshFitScore(db, {
              tenantId: row.tenantId,
              applicationId: row.id,
            });
            await applyAutomaticKnockout(db, {
              tenantId: row.tenantId,
              applicationId: row.id,
              score,
              now,
            });
            return true;
          },
          { tenantId: row.tenantId, txOptions: { timeout: 30000 } },
        );
        if (committed) scored++;
      } catch {
        failed++;
        await tenantTransaction(
          prisma,
          (db) =>
            db.$executeRaw`UPDATE "Application" SET "fitScoreCheckedAt"=${now},"fitScoreError"='Scoring failed; will retry' WHERE id=${row.id} AND "tenantId"=${row.tenantId}::uuid`,
          { tenantId: row.tenantId },
        );
      }
    });
  return { scored, failed };
}
