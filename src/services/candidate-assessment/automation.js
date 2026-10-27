import prisma from "../../lib/prisma.js";
import { tenantTransaction } from "../../lib/rlsTenant.js";
import { runWithRequestContext } from "../../lib/requestContext.js";
import { decryptString } from "../../lib/crypto.js";
import { isRecruitmentFlagEnabled } from "../../lib/recruitmentFlags.js";
import { finish } from "./sessions.js";
import { scoreItem } from "./rules.js";
export const ASSESSMENT_JOBS = [
  { name: "candidate-test-expiry", pattern: "* * * * *" },
  { name: "candidate-test-item-statistics", pattern: "30 2 * * *" },
];
const correlation = (xs, ys) => {
  if (xs.length < 2) return null;
  const n = xs.length,
    mx = xs.reduce((a, b) => a + b, 0) / n,
    my = ys.reduce((a, b) => a + b, 0) / n;
  let a = 0,
    b = 0,
    c = 0;
  for (let i = 0; i < n; i++) {
    a += (xs[i] - mx) * (ys[i] - my);
    b += (xs[i] - mx) ** 2;
    c += (ys[i] - my) ** 2;
  }
  return b && c ? a / Math.sqrt(b * c) : null;
};
export async function runAssessmentAutomation({ kind, now = new Date() }) {
  if (!isRecruitmentFlagEnabled("onsiteTest")) return { skipped: true };
  if (!ASSESSMENT_JOBS.some((j) => j.name === kind))
    throw new Error("Unknown assessment job");
  const tenants = await prisma.candidateTestSession.findMany({
      distinct: ["tenantId"],
      where: { tenantId: { not: null } },
      select: { tenantId: true },
    }),
    results = [];
  for (const { tenantId } of tenants)
    await runWithRequestContext({ system: false, user: { tenantId } }, () =>
      tenantTransaction(
        prisma,
        async (tx) => {
          if (kind === "candidate-test-expiry") {
            const sessions = await tx.candidateTestSession.findMany({
              where: {
                tenantId,
                OR: [
                  { status: "IN_PROGRESS", deadlineAt: { lte: now } },
                  { status: "ISSUED", codeExpiresAt: { lte: now } },
                ],
              },
              take: 200,
              orderBy: { id: "asc" },
            });
            for (const old of sessions) {
              await tx.$queryRaw`SELECT id FROM "CandidateTestSession" WHERE "tenantId"=${tenantId}::uuid AND id=${old.id} FOR UPDATE`;
              const s = await tx.candidateTestSession.findFirst({
                where: { tenantId, id: old.id },
              });
              if (
                (s.status === "IN_PROGRESS" && s.deadlineAt <= now) ||
                (s.status === "ISSUED" && s.codeExpiresAt <= now)
              )
                await finish(tx, { tenantId, now }, s, "EXPIRED");
            }
            results.push({ tenantId, expired: sessions.length });
            return;
          }
          const period = new Date(
              Date.UTC(
                now.getUTCFullYear(),
                now.getUTCMonth(),
                now.getUTCDate(),
              ),
            ),
            from = new Date(+period - 30 * 86400000),
            items = await tx.candidateTestItem.findMany({
              where: { tenantId, status: { in: ["PUBLISHED", "RETIRED"] } },
            });
          for (const item of items) {
            const responses = await tx.candidateTestResponse.findMany({
              where: {
                tenantId,
                itemId: item.id,
                answeredAt: { gte: from, lt: period },
              },
              take: 10000,
            });
            if (!responses.length) continue;
            const resultRows = await tx.candidateTestResult.findMany({
              where: {
                tenantId,
                sessionId: { in: responses.map((r) => r.sessionId) },
              },
            });
            const key = JSON.parse(decryptString(item.answerKey)),
              pairs = responses
                .map((r) => ({
                  r,
                  result: resultRows.find((x) => x.sessionId === r.sessionId),
                }))
                .filter((p) => p.result),
              xs = pairs.map((p) => scoreItem(item, key, p.r.answer)),
              ys = pairs.map((p) => p.result.scorePct),
              sampleSize = pairs.length;
            if (!sampleSize) continue;
            const difficulty = xs.reduce((a, b) => a + b, 0) / sampleSize,
              discrimination = correlation(xs, ys),
              previous = await tx.candidateTestItemStat.findFirst({
                where: { tenantId, itemId: item.id, period: { lt: period } },
                orderBy: { period: "desc" },
              }),
              flags = [];
            if (sampleSize >= 20) {
              if (difficulty < 0.2 || difficulty > 0.9)
                flags.push("DIFFICULTY_REVIEW");
              if (discrimination !== null && discrimination < 0.2)
                flags.push("LOW_DISCRIMINATION");
              if (
                previous?.sampleSize >= 20 &&
                difficulty - previous.difficulty > 0.25
              )
                flags.push("POSSIBLE_LEAKAGE");
            }
            const distractorRates = Object.fromEntries(
              item.options.map((o) => [
                o.key,
                pairs.filter(
                  (p) =>
                    Array.isArray(p.r.answer) && p.r.answer.includes(o.key),
                ).length / sampleSize,
              ]),
            );
            const data = {
              sampleSize,
              difficulty,
              discrimination,
              distractorRates,
              avgTimeSec:
                pairs.reduce((a, p) => a + p.r.timeSpentSec, 0) / sampleSize,
              flags,
            };
            await tx.candidateTestItemStat.upsert({
              where: {
                tenantId_itemId_period: { tenantId, itemId: item.id, period },
              },
              create: { tenantId, itemId: item.id, period, ...data },
              update: data,
            });
          }
          results.push({ tenantId, items: items.length });
        },
        { tenantId, txOptions: { timeout: 60000 } },
      ),
    );
  return { kind, results };
}
