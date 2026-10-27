import prisma from "../lib/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { currentRequestContext } from "../lib/requestContext.js";
import { assertPermission } from "../lib/assertPermission.js";
import { resolveRecruitmentScope } from "../lib/recruitmentAccess.js";
import { actor } from "./separation/base.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import {
  resolveChecklistTasks,
  validateTemplateTasks,
} from "../lib/onboardingTemplates.js";
import { AppError } from "../utils/AppError.js";
const fail = (message, status = 422) => {
  throw new AppError(message, status);
};
async function run(tenantId, method, fn) {
  const ctx = currentRequestContext();
  if (!ctx?.actorVerified || !tenantId || ctx.user?.tenantId !== tenantId)
    fail("Verified company context required", 401);
  if (ctx.user.isAutomation || ctx.user.tokenClaims?.act?.type === "automation")
    fail("An employee must perform this action", 403);
  assertPermission(ctx.permissions, method, "hr:recruitment", false);
  if (resolveRecruitmentScope(ctx.user).level !== "ORG")
    fail("HR template administration role required", 403);
  return tenantTransaction(
    prisma,
    async (tx) => {
      const who = await actor(tx, ctx);
      if (method !== "GET")
        await tx.$executeRawUnsafe(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          "onboarding-template:" + tenantId,
        );
      return fn(tx, who);
    },
    {
      tenantId,
      txOptions: {
        isolationLevel: "ReadCommitted",
        maxWait: 10000,
        timeout: 30000,
      },
    },
  );
}
export const findDefaultTemplate = (db, tenantId) =>
  db.onboardingChecklistTemplate.findFirst({
    where: scopedWhere(tenantId, { isActive: true, isDefault: true }),
    orderBy: { id: "asc" },
  });
export const resolveTasksForProvisioning = async (db, tenantId) =>
  resolveChecklistTasks(await findDefaultTemplate(db, tenantId));
export const listTemplates = ({ tenantId, includeInactive = false } = {}) =>
  run(tenantId, "GET", async (tx) => {
    if (typeof includeInactive !== "boolean")
      fail("Use a boolean inactive filter");
    return tx.onboardingChecklistTemplate.findMany({
      where: scopedWhere(tenantId, includeInactive ? {} : { isActive: true }),
      orderBy: [{ isDefault: "desc" }, { id: "asc" }],
      take: 200,
    });
  });
function revision(row, expected) {
  if (
    typeof expected !== "string" ||
    !Number.isFinite(Date.parse(expected)) ||
    new Date(expected).toISOString() !== row.updated_at.toISOString()
  )
    fail("This template changed. Reload and review before saving.", 412);
}
async function changed(tx, tenantId, row, who, action) {
  const event = await enqueueHrDomainEvent(tx, {
    tenantId,
    eventName: "hr.onboarding.template_changed.v1",
    aggregateType: "OnboardingChecklistTemplate",
    aggregateId: String(row.id),
    actorId: String(who.id),
    actorType: "user",
    payload: {
      templateId: String(row.id),
      actorId: String(who.id),
      action,
      revision: row.updated_at.toISOString(),
    },
  });
  if (!event) fail("Template change could not be saved", 503);
  return row;
}
export const upsertTemplate = ({
  tenantId,
  name,
  description = null,
  tasks,
  makeDefault = false,
  expectedUpdatedAt,
} = {}) =>
  run(tenantId, "PUT", async (tx, who) => {
    const cleanName = typeof name === "string" ? name.trim() : "";
    if (!cleanName || cleanName.length > 120)
      fail("Template name must be 1–120 characters");
    if (
      description != null &&
      (typeof description !== "string" || description.length > 2000)
    )
      fail("Description must be at most 2000 characters");
    if (typeof makeDefault !== "boolean") fail("Use a boolean default choice");
    const verdict = validateTemplateTasks(tasks);
    if (!verdict.ok) fail(verdict.error);
    const existing = await tx.onboardingChecklistTemplate.findFirst({
      where: scopedWhere(tenantId, { name: cleanName }),
    });
    if (existing) revision(existing, expectedUpdatedAt);
    else if (expectedUpdatedAt != null) fail("Template not found", 404);
    const count = await tx.onboardingChecklistTemplate.count({
      where: scopedWhere(tenantId, {}),
    });
    if (!existing && count >= 200)
      fail("A company may have at most 200 onboarding templates", 409);
    const updated_at = new Date(
      Math.max(Date.now(), existing ? existing.updated_at.getTime() + 1 : 0),
    );
    if (makeDefault)
      await tx.onboardingChecklistTemplate.updateMany({
        where: scopedWhere(tenantId, {
          isDefault: true,
          ...(existing ? { id: { not: existing.id } } : {}),
        }),
        data: { isDefault: false, updated_at },
      });
    const data = {
      description: description?.trim() || null,
      tasks: verdict.tasks,
      isActive: true,
      updated_at,
      ...(makeDefault ? { isDefault: true } : {}),
    };
    const row = existing
      ? await tx.onboardingChecklistTemplate.update({
          where: { id: existing.id },
          data,
        })
      : await tx.onboardingChecklistTemplate.create({
          data: scopedData(tenantId, {
            ...data,
            name: cleanName,
            isDefault: makeDefault || count === 0,
            createdById: who.id,
          }),
        });
    return changed(tx, tenantId, row, who, existing ? "UPDATED" : "CREATED");
  });
export const deactivateTemplate = ({
  tenantId,
  templateId,
  expectedUpdatedAt,
} = {}) =>
  run(tenantId, "PUT", async (tx, who) => {
    const id = Number(templateId);
    if (!Number.isSafeInteger(id) || id <= 0) fail("Template not found", 404);
    const row = await tx.onboardingChecklistTemplate.findFirst({
      where: scopedWhere(tenantId, { id }),
    });
    if (!row) fail("Template not found", 404);
    revision(row, expectedUpdatedAt);
    const saved = await tx.onboardingChecklistTemplate.update({
      where: { id },
      data: {
        isActive: false,
        isDefault: false,
        updated_at: new Date(
          Math.max(Date.now(), row.updated_at.getTime() + 1),
        ),
      },
    });
    return changed(tx, tenantId, saved, who, "DEACTIVATED");
  });
