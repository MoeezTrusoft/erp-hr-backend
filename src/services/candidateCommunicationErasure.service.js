import prisma from "../lib/prisma.js";
import { runWithRequestContext } from "../lib/requestContext.js";
import { cancelCandidateDelivery } from "../lib/notificationClient.js";
export async function runCandidateCommunicationErasure({
  limit = 100,
  cancel = cancelCandidateDelivery,
  tenantId,
} = {}) {
  const rows = await prisma.candidateCommunication.findMany({
    where: {
      ...(tenantId ? { tenantId } : {}),
      status: "CANCELLED",
      context: { path: ["hubCleanup"], equals: "PENDING" },
    },
    select: { id: true, tenantId: true, candidateId: true },
    orderBy: { updatedAt: "asc" },
    take: Math.min(500, limit),
  });
  let erased = 0,
    failed = 0;
  for (const row of rows)
    await runWithRequestContext(
      { system: false, user: { tenantId: row.tenantId } },
      async () => {
        if (
          !(await prisma.candidate.findFirst({
            where: {
              id: row.candidateId,
              tenantId: row.tenantId,
              anonymizedAt: { not: null },
            },
            select: { id: true },
          }))
        )
          return;
        let result;
        try {
          result = await cancel({
            tenantId: row.tenantId,
            communicationId: row.id,
          });
        } catch {
          result = { ok: false };
        }
        await prisma.candidateCommunication.updateMany({
          where: { id: row.id, tenantId: row.tenantId, status: "CANCELLED" },
          data: {
            context: { hubCleanup: result.ok ? "COMPLETE" : "PENDING" },
            lastError: result.ok
              ? "Candidate data erased"
              : "Notification cleanup will retry",
          },
        });
        if (result.ok) erased++;
        else failed++;
      },
    );
  return { erased, failed };
}
