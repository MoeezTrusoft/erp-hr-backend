import { jobBoardStatus } from "../lib/job-board-feeds.js";
import { applyJobBoardSettings } from "./job-board-settings.service.js";
import { RecruitmentPolicy } from "@trusoft/contracts/recruitment-policy";
import prisma from "../lib/prisma.js";
import { getCtx } from "../mcp/context.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { rolesOf, resolveRecruitmentScope } from "../lib/recruitmentAccess.js";
import { actor } from "./separation/base.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
const fail = (message, status = 403) => {
  throw Object.assign(new Error(message), { status, code: "HR-5102" });
};
export async function readRecruitmentSettings(db, tenantId) {
  const row = await db.recruitmentSettings.findUnique({ where: { tenantId } });
  return {
    version: row?.version ?? 0,
    policy: RecruitmentPolicy.parse(row?.policy ?? {}),
  };
}
export async function portalBaseUrl(db, tenantId) {
  const { policy } = await readRecruitmentSettings(db, tenantId);
  let bases = {};
  try {
    bases = JSON.parse(process.env.HR_PORTAL_BASE_URLS || "{}");
  } catch {
    fail("Portal origin configuration is invalid", 503);
  }
  const value = policy.careerBaseUrl || bases[tenantId] || process.env.HR_PORTAL_BASE_URL;
  if (!value) fail("Careers origin is not configured", 503);
  const checked = RecruitmentPolicy.shape.careerBaseUrl.safeParse(value);
  if (!checked.success) fail("Careers origin must be HTTPS", 503);
  return value.replace(/\/$/, "");
}
export async function recruitmentSettingsGet() {
  const ctx = getCtx();
  if (!ctx.actorVerified || !ctx.permissions?.includes("hr.recruitment.read"))
    fail("Recruitment read permission required");
  return tenantTransaction(
    prisma,
    async (db) => {
      const who = await actor(db, ctx);
      if (
        !["ORG", "MANAGED"].includes(
          resolveRecruitmentScope({ ...ctx.user, employeeId: who.id }).level,
        )
      )
        fail("Recruitment settings access required");
      const result = await readRecruitmentSettings(db, ctx.user.tenantId);
      return {
        ...result,
        jobBoardStatus: jobBoardStatus(ctx.user.tenantId, result.policy.jobBoards),
      };
    },
    { tenantId: ctx.user.tenantId },
  );
}
export async function recruitmentSettingsSet({
  policy,
  expectedVersion,
  reason,
  reconcileJobBoards = false,
}) {
  const ctx = getCtx(),
    tenantId = ctx.user?.tenantId;
  if (
    !ctx.actorVerified ||
    !ctx.permissions?.includes("hr.recruitment.update") ||
    !rolesOf(ctx.user).some((r) => ["HR_ADMIN", "HR_HEAD"].includes(r))
  )
    fail("HR policy administrator permission required");
  const parsed = RecruitmentPolicy.parse(policy);
  if (!String(reason ?? "").trim() || reason.trim().length < 10)
    fail("Explain the policy change in at least 10 characters", 422);
  return tenantTransaction(
    prisma,
    async (db) => {
      const who = await actor(db, ctx);
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ":recruitment-policy"},0))`;
      const current = await readRecruitmentSettings(db, tenantId);
      if (current.version !== expectedVersion) fail("Policy changed; reload before saving", 412);
      if (!Object.hasOwn(parsed, "jobBoards") && Object.hasOwn(current.policy, "jobBoards"))
        parsed.jobBoards = current.policy.jobBoards;
      await applyJobBoardSettings(db, {
        tenantId,
        previous: current.policy.jobBoards,
        next: parsed.jobBoards,
        actorId: who.id,
        canPublish: ctx.permissions.includes("hr.recruitment.create"),
        reconcile: reconcileJobBoards === true,
      });
      const recipients = [...new Set(parsed.analyticsAlerts.recipientEmployeeIds)];
      if (recipients.length) {
        const valid = await db.employee.count({
          where: {
            tenant_id: tenantId,
            id: { in: recipients },
            status: "Active",
            employement_status: "Active",
            userId: { gt: 0 },
          },
        });
        if (valid !== recipients.length)
          fail("Alert recipients must be active employees with accounts in this company", 422);
      }
      parsed.analyticsAlerts.recipientEmployeeIds = recipients;
      const version = current.version + 1;
      await db.recruitmentPolicyVersion.create({
        data: {
          tenantId,
          version,
          policy: parsed,
          reason: reason.trim(),
          changedById: who.id,
        },
      });
      await db.recruitmentSettings.upsert({
        where: { tenantId },
        create: { tenantId, version, policy: parsed, updatedById: who.id },
        update: { version, policy: parsed, updatedById: who.id },
      });
      await enqueueHrDomainEvent(db, {
        tenantId,
        actorId: who.id,
        eventName: "hr.recruitment.policy_changed.v1",
        aggregateType: "RecruitmentSettings",
        aggregateId: tenantId,
        payload: { policyVersion: version },
      });
      return {
        version,
        policy: parsed,
        jobBoardStatus: jobBoardStatus(tenantId, parsed.jobBoards),
      };
    },
    { tenantId, txOptions: { timeout: 20000 } },
  );
}
