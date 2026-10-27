import prisma from "../lib/prisma.js";
import { getCtx } from "../mcp/context.js";
import { actor } from "./separation/base.js";
import { resolveRecruitmentScope, rolesOf } from "../lib/recruitmentAccess.js";
export async function requireRecruitmentActor(
  {
    tenantId,
    permission = "hr.recruitment.read",
    allowedScopes = ["ORG", "MANAGED"],
    adminOnly = false,
  },
  db = prisma,
) {
  const ctx = getCtx();
  const deny = () => {
    throw Object.assign(new Error("Recruitment operation is not permitted"), {
      status: 403,
      code: "HR-5304",
    });
  };
  if (
    !ctx.actorVerified ||
    !tenantId ||
    ctx.user?.tenantId !== tenantId ||
    !ctx.permissions?.includes(permission)
  )
    deny();
  const who = await actor(db, ctx),
    scope = resolveRecruitmentScope({ ...ctx.user, employeeId: who.id });
  if (
    !allowedScopes.includes(scope.level) ||
    (adminOnly &&
      !rolesOf(ctx.user).some((r) => ["HR_ADMIN", "HR_HEAD"].includes(r)))
  )
    deny();
  return { who, scope };
}
