import { HR_ERRORS } from "../constants/errorCodes.js";
import prisma from "../lib/prisma.js";
import { Prisma } from "@prisma/client";
import {
  currentRequestContext,
  runWithRequestContext,
} from "../lib/requestContext.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { hasPermission } from "../lib/assertPermission.js";
import { rolesOf, resolveRecruitmentScope } from "../lib/recruitmentAccess.js";
import { actor } from "./separation/base.js";
import { AppError } from "../utils/AppError.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { userIdToUuid } from "@trusoft/contracts/identity";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
const kinds = ["IT_ACCESS_SETUP", "WORKSPACE_EQUIPMENT"];
const active = (p) =>
  p &&
  !/inactive|terminated|exited|offboard|separated/i.test(
    [p.status, p.employement_status].join(" "),
  );
const fail = (message, status = 422) => {
  throw new AppError(
    message,
    status,
    status === 422 ? { code: HR_ERRORS.VALIDATION.code } : {},
  );
};
async function run(tenantId, write, fn) {
  const ctx = currentRequestContext();
  if (!ctx?.actorVerified || !tenantId || ctx.user?.tenantId !== tenantId)
    fail("Verified company context required", 401);
  if (ctx.user.isAutomation || ctx.user.tokenClaims?.act?.type === "automation")
    fail("An employee must perform this action", 403);
  return tenantTransaction(
    prisma,
    async (tx) => {
      const who = await actor(tx, ctx),
        scope = resolveRecruitmentScope({ ...ctx.user, employeeId: who.id });
      const hr =
        (write
          ? scope.level === "ORG"
          : ["ORG", "MANAGED"].includes(scope.level)) &&
        hasPermission(
          ctx.permissions,
          "hr:onboarding",
          write ? "EDIT" : "VIEW",
        );
      const it =
        rolesOf(ctx.user).some((r) =>
          ["IT", "IT_ADMIN", "IT_MANAGER"].includes(r),
        ) &&
        hasPermission(
          ctx.permissions,
          "hr:onboarding_provisioning",
          write ? "EDIT" : "VIEW",
        );
      if (!it && (!hr || (write && scope.level !== "ORG")))
        fail("Provisioning permission required", 403);
      return fn(tx, { tenantId, ctx, who, scope, hr, it });
    },
    {
      tenantId,
      txOptions: {
        maxWait: 10000,
        timeout: 30000,
        isolationLevel: write ? "ReadCommitted" : "RepeatableRead",
      },
    },
  );
}
async function event(tx, tenantId, payload) {
  const queued = await enqueueHrDomainEvent(tx, {
    tenantId,
    eventName: "hr.onboarding.provisioning_requested.v1",
    aggregateType: "OnboardingTask",
    aggregateId: payload.taskId,
    payload,
  });
  if (!queued) fail("Provisioning request could not be saved", 503);
}
// Joins checklist/task creation transactions; the periodic worker also repairs
// missed or previously disabled projections using the same task identity.
export async function ensureProvisioningRequests(
  tx,
  tenantId,
  checklistId,
  now = new Date(),
) {
  if (!isRecruitmentFlagEnabled("onboarding"))
    return { created: 0, notified: 0, unassigned: 0 };
  const c = await tx.onboardingChecklist.findFirst({
    where: { tenantId, id: checklistId },
    include: {
      employee: {
        select: { tenant_id: true, status: true, employement_status: true },
      },
    },
  });
  if (!c || c.employee.tenant_id !== tenantId || !active(c.employee))
    return { created: 0, notified: 0, unassigned: 0 };
  const tasks = await tx.onboardingTask.findMany({
      where: {
        tenantId,
        checklistId,
        category: { in: kinds },
        assigneeType: { not: "NEW_HIRE" },
      },
      orderBy: { id: "asc" },
    }),
    result = { created: 0, notified: 0, unassigned: 0 };
  for (const task of tasks) {
    if (task.completed) continue;
    const added = await tx.$queryRawUnsafe(
      'INSERT INTO "OnboardingProvisioning" ("taskId","tenantId","requestedAt") VALUES ($1,$2::uuid,$3) ON CONFLICT DO NOTHING RETURNING "taskId"',
      task.id,
      tenantId,
      now,
    );
    result.created += added.length;
    const r = (
      await tx.$queryRawUnsafe(
        'SELECT * FROM "OnboardingProvisioning" WHERE "tenantId"=$1::uuid AND "taskId"=$2 FOR UPDATE',
        tenantId,
        task.id,
      )
    )[0];
    const person = task.assigneeId
      ? await tx.employee.findFirst({
          where: { tenant_id: tenantId, id: task.assigneeId },
          select: { userId: true, status: true, employement_status: true },
        })
      : null;
    const userId =
      active(person) && Number.isSafeInteger(person.userId) && person.userId > 0
        ? person.userId
        : null;
    if (userId == null) result.unassigned++;
    if (added.length || userId !== r.notifiedUserId) {
      await event(tx, tenantId, {
        taskId: String(task.id),
        checklistId: String(c.id),
        employeeId: String(c.employeeId),
        category: task.category,
        dueAt: task.dueDate?.toISOString() ?? null,
        recipientUserIds: userId ? [userIdToUuid(tenantId, userId)] : [],
      });
      await tx.$executeRawUnsafe(
        'UPDATE "OnboardingProvisioning" SET "notifiedUserId"=$1,"lastNotifiedAt"=$2 WHERE "tenantId"=$3::uuid AND "taskId"=$4',
        userId,
        userId ? now : null,
        tenantId,
        task.id,
      );
      if (userId) result.notified++;
    }
  }
  return result;
}
export async function runOnboardingProvisioning({
  tenantId,
  now = new Date(),
} = {}) {
  if (!currentRequestContext()?.system)
    fail("Scheduler identity required", 403);
  if (!isRecruitmentFlagEnabled("onboarding")) return { skipped: true };
  const result = { created: 0, notified: 0, unassigned: 0 };
  const tenants = await prisma.onboardingChecklist.findMany({
    where: {
      tenantId: tenantId ?? { not: null },
      status: { not: "COMPLETED" },
    },
    select: { tenantId: true },
    distinct: ["tenantId"],
  });
  for (const { tenantId: company } of tenants)
    await runWithRequestContext(
      { system: false, user: { tenantId: company } },
      async () => {
        let cursor = 0;
        for (;;) {
          const page = await prisma.onboardingChecklist.findMany({
            where: {
              tenantId: company,
              id: { gt: cursor },
              status: { not: "COMPLETED" },
            },
            select: { id: true },
            orderBy: { id: "asc" },
            take: 200,
          });
          for (const c of page) {
            const r = await tenantTransaction(
              prisma,
              async (tx) => {
                await tx.$queryRawUnsafe(
                  'SELECT id FROM onboarding_checklists WHERE "tenantId"=$1::uuid AND id=$2 FOR UPDATE',
                  company,
                  c.id,
                );
                return ensureProvisioningRequests(tx, company, c.id, now);
              },
              { tenantId: company },
            );
            for (const k of Object.keys(result)) result[k] += r[k];
          }
          if (page.length < 200) break;
          cursor = page.at(-1).id;
        }
      },
    );
  return result;
}
export const listProvisioning = (input, tenantId) =>
  run(tenantId, false, async (tx, env) => {
    const page = Number(input.page ?? 1),
      pageSize = Number(input.pageSize ?? 20);
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    )
      fail("Use a valid page and page size");
    if (input.category && !kinds.includes(input.category))
      fail("Unknown provisioning category");
    if (input.status && !["PENDING", "FULFILLED"].includes(input.status))
      fail("Unknown provisioning status");
    const where = [Prisma.sql`p."tenantId"=${tenantId}::uuid`];
    if (env.hr && env.scope.level === "MANAGED")
      where.push(Prisma.sql`e."managerId"=${env.who.id}`);
    else if (!env.hr) where.push(Prisma.sql`t."assigneeId"=${env.who.id}`);
    if (input.checklistId) {
      const id = Number(input.checklistId);
      if (!Number.isSafeInteger(id) || id <= 0) fail("Invalid checklist ID");
      where.push(Prisma.sql`c.id=${id}`);
    }
    if (input.category)
      where.push(Prisma.sql`t.category::text=${input.category}`);
    if (input.status)
      where.push(
        input.status === "FULFILLED"
          ? Prisma.sql`p."fulfilledAt" IS NOT NULL`
          : Prisma.sql`p."fulfilledAt" IS NULL`,
      );
    const from = Prisma.sql`FROM "OnboardingProvisioning" p JOIN onboarding_tasks t ON t.id=p."taskId" AND t."tenantId"=p."tenantId" JOIN onboarding_checklists c ON c.id=t."checklistId" AND c."tenantId"=p."tenantId" JOIN "Employee" e ON e.id=c."employeeId" AND e.tenant_id=p."tenantId" LEFT JOIN "Employee" a ON a.id=t."assigneeId" AND a.tenant_id=p."tenantId" WHERE ${Prisma.join(where, " AND ")}`;
    const total = (
      await tx.$queryRaw(Prisma.sql`SELECT count(*)::int AS n ${from}`)
    )[0].n;
    const items = await tx.$queryRaw(
      Prisma.sql`SELECT p."taskId",p.version,p."requestedAt",p."fulfilledAt",p.reference,t.title,t.description,t.category,t."dueDate",t.completed,t."assigneeId",c.id AS "checklistId",c."employeeId",c."startDate",COALESCE(NULLIF(e.employee_name,''),concat_ws(' ',e.first_name,e.last_name)) AS "employeeName",COALESCE(NULLIF(a.employee_name,''),NULLIF(concat_ws(' ',a.first_name,a.last_name),'')) AS "assigneeName" ${from} ORDER BY t."dueDate" ASC NULLS LAST,p."taskId" ASC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    );
    const hrEdit =
        env.hr &&
        env.scope.level === "ORG" &&
        hasPermission(env.ctx.permissions, "hr:onboarding", "EDIT"),
      itEdit =
        env.it &&
        hasPermission(
          env.ctx.permissions,
          "hr:onboarding_provisioning",
          "EDIT",
        );
    return {
      items: items.map((r) => ({
        ...r,
        canAssign: hrEdit && !r.fulfilledAt,
        canFulfill:
          !r.fulfilledAt &&
          !r.completed &&
          (hrEdit || (itEdit && r.assigneeId === env.who.id)),
        status: r.fulfilledAt ? "FULFILLED" : "PENDING",
      })),
      total,
      page,
      pageSize,
      automationEnabled: isRecruitmentFlagEnabled("onboarding"),
    };
  });
export const fulfillProvisioning = (input, tenantId) =>
  run(tenantId, true, async (tx, env) => {
    const id = Number(input.taskId),
      version = Number(input.expectedVersion);
    if (
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      !Number.isInteger(version) ||
      version < 0
    )
      fail("Use the current request version");
    if (
      typeof input.reference !== "string" ||
      !input.reference.trim() ||
      input.reference.length > 2000
    )
      fail("Record a provisioning reference of 1–2000 characters");
    let task = await tx.onboardingTask.findFirst({ where: { tenantId, id } });
    if (!task) fail("Provisioning request not found", 404);
    await tx.$queryRawUnsafe(
      'SELECT id FROM onboarding_checklists WHERE "tenantId"=$1::uuid AND id=$2 FOR UPDATE',
      tenantId,
      task.checklistId,
    );
    task = await tx.onboardingTask.findFirst({ where: { tenantId, id } });
    if (
      !task ||
      !kinds.includes(task.category) ||
      (!env.hr && task.assigneeId !== env.who.id)
    )
      fail("Provisioning request not found", 404);
    const r = (
      await tx.$queryRawUnsafe(
        'SELECT * FROM "OnboardingProvisioning" WHERE "tenantId"=$1::uuid AND "taskId"=$2 FOR UPDATE',
        tenantId,
        id,
      )
    )[0];
    if (!r) fail("Provisioning request not found", 404);
    if (
      r.fulfilledAt &&
      r.fulfilledById === env.who.id &&
      r.reference === input.reference.trim()
    )
      return {
        taskId: id,
        version: r.version,
        fulfilledAt: r.fulfilledAt,
        reference: r.reference,
      };
    if (r.version !== version)
      fail("Provisioning request changed; reload it before saving", 412);
    if (r.fulfilledAt || task.completed)
      fail("This request is already complete", 409);
    const now = new Date();
    await tx.onboardingTask.update({
      where: { id },
      data: { completed: true, completedAt: now },
    });
    const saved = (
      await tx.$queryRawUnsafe(
        'UPDATE "OnboardingProvisioning" SET "fulfilledAt"=$1,"fulfilledById"=$2,reference=$3,version=version+1 WHERE "tenantId"=$4::uuid AND "taskId"=$5 RETURNING "taskId",version,"fulfilledAt",reference',
        now,
        env.who.id,
        input.reference.trim(),
        tenantId,
        id,
      )
    )[0];
    const c = await tx.onboardingChecklist.findFirst({
      where: { tenantId, id: task.checklistId },
    });
    const queued = await enqueueHrDomainEvent(tx, {
      tenantId,
      eventName: "hr.onboarding.task_changed.v1",
      aggregateType: "OnboardingChecklist",
      aggregateId: String(c.id),
      actorId: String(env.who.id),
      actorType: "user",
      payload: {
        checklistId: String(c.id),
        employeeId: String(c.employeeId),
        taskId: String(id),
        actorId: String(env.who.id),
        action: "COMPLETED",
      },
    });
    if (!queued) fail("Provisioning result could not be saved", 503);
    return saved;
  });
// Ordinary checklist mutations cannot bypass or rewrite fulfillment evidence.
export async function guardProvisioningTaskMutation(
  tx,
  tenantId,
  task,
  patch = {},
  deleting = false,
) {
  const r = (
    await tx.$queryRawUnsafe(
      'SELECT * FROM "OnboardingProvisioning" WHERE "tenantId"=$1::uuid AND "taskId"=$2 FOR UPDATE',
      tenantId,
      task.id,
    )
  )[0];
  if (!r) return;
  if (
    patch.expectedProvisioningVersion !== undefined &&
    r.version !== patch.expectedProvisioningVersion
  )
    fail("Provisioning request changed; reload it before saving", 412);
  if (r.fulfilledAt) {
    if (
      deleting ||
      Object.keys(patch).some((k) => k !== "done") ||
      patch.done === false
    )
      fail(
        "Fulfillment is recorded. Create a new task for additional provisioning work",
        409,
      );
    return;
  }
  if (patch.assigneeType === "NEW_HIRE")
    fail(
      "A queued provisioning request must stay with the responsible team; create a separate employee confirmation task",
      409,
    );
  if (patch.done === true)
    fail(
      "Complete this task through the provisioning queue with a fulfillment reference",
      409,
    );
  if (patch.category && patch.category !== task.category)
    fail(
      "A queued provisioning request must retain its category; replace the pending task if its purpose changed",
      409,
    );
  if (!deleting && Object.keys(patch).length)
    await tx.$executeRawUnsafe(
      'UPDATE "OnboardingProvisioning" SET version=version+1 WHERE "tenantId"=$1::uuid AND "taskId"=$2',
      tenantId,
      task.id,
    );
}
export async function provisioningTaskIds(tx, tenantId, checklistId) {
  const rows = await tx.$queryRawUnsafe(
    'SELECT p."taskId" FROM "OnboardingProvisioning" p JOIN onboarding_tasks t ON t.id=p."taskId" AND t."tenantId"=p."tenantId" WHERE p."tenantId"=$1::uuid AND t."checklistId"=$2',
    tenantId,
    checklistId,
  );
  return new Set(rows.map((r) => r.taskId));
}
