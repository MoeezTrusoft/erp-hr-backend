import { fail } from "./rules.js";
export const exposureMonth = (now) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
export async function withPeriodExposure(tx, env, items) {
  const rows =
    await tx.$queryRaw`SELECT "itemId", "servedCount" FROM "CandidateTestItemExposure"
    WHERE "tenantId"=${env.tenantId}::uuid AND period=${exposureMonth(env.now)}::date`;
  const counts = new Map(rows.map((r) => [r.itemId, r.servedCount]));
  return items.map((item) => ({
    ...item,
    exposureCount: counts.get(item.id) ?? 0,
  }));
}
export async function reserveExposure(tx, env, item) {
  const rows =
    await tx.$queryRaw`INSERT INTO "CandidateTestItemExposure" ("tenantId","itemId",period,"servedCount")
    VALUES (${env.tenantId}::uuid, ${item.id}, ${exposureMonth(env.now)}::date, 1)
    ON CONFLICT ("tenantId","itemId",period) DO UPDATE SET "servedCount"="CandidateTestItemExposure"."servedCount"+1
    WHERE "CandidateTestItemExposure"."servedCount"<${item.exposureCap} RETURNING "servedCount"`;
  if (!rows.length)
    fail(
      "Monthly item exposure limit reached; retry test assembly",
      409,
      "HR-6004",
    );
  await tx.candidateTestItem.update({
    where: { id: item.id },
    data: { exposureCount: { increment: 1 } },
  });
}
