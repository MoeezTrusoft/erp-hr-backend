import prisma from "../lib/prisma.js";
import { currentRequestContext } from "../lib/requestContext.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { assertPermission } from "../lib/assertPermission.js";
import { resolveRecruitmentScope } from "../lib/recruitmentAccess.js";
import { actor } from "./separation/base.js";
const fail = (message, status = 422) => {
  throw Object.assign(new Error(message), { status });
};
async function run(tenantId, method, fn) {
  const ctx = currentRequestContext();
  if (!ctx?.actorVerified || !tenantId || ctx.user?.tenantId !== tenantId)
    fail("Verified company context required", 401);
  assertPermission(ctx.permissions, method, "hr:recruitment", false);
  if (
    method !== "GET" &&
    (ctx.user.isAutomation || ctx.user.tokenClaims?.act?.type === "automation")
  )
    fail("A person must approve recruitment costs", 403);
  return tenantTransaction(
    prisma,
    async (tx) => {
      const who = await actor(tx, ctx);
      if (
        resolveRecruitmentScope({ ...ctx.user, employeeId: who.id }).level !==
        "ORG"
      )
        fail("Recruitment lead required", 403);
      return fn(tx);
    },
    { tenantId },
  );
}
const periodValue = (period) => {
  if (typeof period !== "string" || !period.trim() || period.length > 80)
    fail("A cost period of at most 80 characters is required");
  return period.trim();
};
export async function getCostConfig(tenantId, period = "all") {
  period = periodValue(period);
  return run(tenantId, "GET", (tx) =>
    tx.recruitmentCostConfig.findFirst({ where: { tenantId, period } }),
  );
}
export async function setCostConfig(tenantId, input = {}) {
  const period = periodValue(input.period ?? "all"),
    values = {};
  for (const key of ["jobAds", "agencyFees", "tools", "other"])
    if (input[key] != null) {
      if (
        typeof input[key] !== "number" ||
        !Number.isFinite(input[key]) ||
        input[key] < 0 ||
        input[key] > 1e12
      )
        fail(
          "Costs must be finite, non-negative amounts within the supported range",
        );
      values[key] = Math.round(input[key] * 10000) / 10000;
    }
  if (input.currency != null) {
    if (
      typeof input.currency !== "string" ||
      !/^[A-Z]{3}$/.test(input.currency)
    )
      fail("Use an uppercase three-letter currency code");
    values.currency = input.currency;
  }
  return run(tenantId, "PUT", async (tx) => {
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      tenantId + ":recruitment-cost:" + period,
    );
    const previous = await tx.recruitmentCostConfig.findFirst({
      where: { tenantId, period },
    });
    return previous
      ? tx.recruitmentCostConfig.update({
          where: { id: previous.id },
          data: values,
        })
      : tx.recruitmentCostConfig.create({
          data: {
            tenantId,
            period,
            jobAds: 0,
            agencyFees: 0,
            tools: 0,
            other: 0,
            currency: "PKR",
            ...values,
          },
        });
  });
}
