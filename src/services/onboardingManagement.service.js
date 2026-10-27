import prisma from "../lib/prisma.js";
import { currentRequestContext } from "../lib/requestContext.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { assertPermission } from "../lib/assertPermission.js";
import { resolveRecruitmentScope } from "../lib/recruitmentAccess.js";
import { actor } from "./separation/base.js";
import { AppError } from "../utils/AppError.js";
export const onboardingFailure = (message, status = 422) => {
  throw new AppError(message, status);
};
export async function runOnboardingManagement(tenantId, method, fn) {
  const ctx = currentRequestContext();
  if (!ctx?.actorVerified || !tenantId || ctx.user?.tenantId !== tenantId)
    onboardingFailure("Verified company context required", 401);
  if (ctx.user.isAutomation || ctx.user.tokenClaims?.act?.type === "automation")
    onboardingFailure("An employee must perform this action", 403);
  assertPermission(ctx.permissions, method, "hr:onboarding", false);
  return tenantTransaction(
    prisma,
    async (tx) => {
      const who = await actor(tx, ctx),
        scope = resolveRecruitmentScope({ ...ctx.user, employeeId: who.id });
      if (
        !["ORG", "MANAGED"].includes(scope.level) ||
        (!["GET", "EXPORT"].includes(method) && scope.level !== "ORG")
      )
        onboardingFailure("Onboarding management role required", 403);
      return fn(tx, { ctx, who, scope, tenantId });
    },
    {
      tenantId,
      txOptions: {
        isolationLevel: ["GET", "EXPORT"].includes(method)
          ? "RepeatableRead"
          : "ReadCommitted",
        maxWait: 10000,
        timeout: 30000,
      },
    },
  );
}
export const managementChecklistWhere = (env) => ({
  tenantId: env.tenantId,
  employee: {
    is: {
      tenant_id: env.tenantId,
      ...(env.scope.level === "MANAGED" ? { managerId: env.who.id } : {}),
    },
  },
});
export async function managementChecklist(
  tx,
  env,
  id,
  { lock = false, include } = {},
) {
  id = Number(id);
  if (!Number.isSafeInteger(id) || id <= 0)
    onboardingFailure("Onboarding checklist not found", 404);
  if (lock)
    await tx.$queryRawUnsafe(
      'SELECT id FROM onboarding_checklists WHERE "tenantId"=$1::uuid AND id=$2 FOR UPDATE',
      env.tenantId,
      id,
    );
  const row = await tx.onboardingChecklist.findFirst({
    where: { ...managementChecklistWhere(env), id },
    ...(include ? { include } : {}),
  });
  if (!row) onboardingFailure("Onboarding checklist not found", 404);
  return row;
}
