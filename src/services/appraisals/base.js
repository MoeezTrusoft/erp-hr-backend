import { createHash } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { tenantTransaction } from "../../lib/rlsTenant.js";
import { getCtx } from "../../mcp/context.js";
import { actor } from "../separation/base.js";
import { enqueueHrDomainEvent } from "../hrDomainEvent.service.js";
import { PERFORMANCE_EVENT_OPERATIONS } from "@trusoft/contracts/events/performance";
import {
  canonical,
  fail,
} from "@trusoft/contracts/performance-appraisal-rules";
import {
  AppraisalEvent,
  canonicalAppraisalPermission,
} from "@trusoft/contracts/performance-appraisals";
export { fail };
export const json = (value) => JSON.parse(JSON.stringify(value));
export const digest = (value) =>
  createHash("sha256")
    .update(canonical(json(value)))
    .digest("hex");
export const has = (env, permission) =>
  env.ctx.user.isAdmin ||
  env.ctx.permissions?.includes(canonicalAppraisalPermission(permission));
export function permit(env, permission) {
  if (!has(env, permission))
    fail("FORBIDDEN", "This action requires " + permission, 403);
}
export function expected(row, value) {
  if (value === undefined)
    fail(
      "EXPECTED_VERSION_REQUIRED",
      "Reload the current version before changing this record",
      428,
    );
  if (row.version !== value)
    fail(
      "VERSION_CONFLICT",
      "The record changed. Reload and merge your draft.",
      412,
      { currentVersion: row.version },
    );
}
export async function person(tx, tenantId, id) {
  const row = await tx.employee.findFirst({
    where: { tenant_id: tenantId, id },
  });
  if (
    !row ||
    /inactive|terminated|exited|offboard|separated/i.test(
      `${row.status} ${row.employement_status}`,
    )
  )
    fail("NOT_FOUND", "Active employee not found", 404);
  return row;
}
export async function review(
  tx,
  env,
  id,
  { write = false, correction = false } = {},
) {
  const row = await tx.perfReview.findFirst({
    where: { id, tenantId: env.tenantId },
  });
  if (!row) fail("NOT_FOUND", "Review not found", 404);
  const employee = await tx.employee.findFirst({
    where: { tenant_id: env.tenantId, id: row.employeeId },
  });
  if (!employee) fail("NOT_FOUND", "Employee not found", 404);
  const self = row.employeeId === env.who.id;
  const manager =
    row.managerId === env.who.id && employee.managerId === env.who.id && !self;
  const hr = has(env, "hr.performance.read.all");
  if (!self && !manager && !hr) fail("NOT_FOUND", "Review not found", 404);
  const cycle = await tx.perfCycle.findFirst({
    where: { id: row.cycleId, tenantId: env.tenantId },
  });
  if (
    write &&
    ["CLOSED", "ARCHIVED"].includes(cycle.status) &&
    !(correction && row.releasedRevisionId)
  )
    fail("STATE_CONFLICT", "The cycle is closed", 409);
  return { row, cycle, self, manager, hr, employee };
}
export function independent(env, row, other = []) {
  if ([row.employeeId, row.managerId, ...other].includes(env.who.id))
    fail(
      "INDEPENDENT_APPROVER_REQUIRED",
      "A different authorised approver must perform this action",
      403,
    );
}
export async function audit(
  tx,
  env,
  operation,
  aggregateId,
  version,
  input,
  metadata = {},
  disclosure = {},
) {
  const record = await tx.perfAudit.create({
    data: {
      tenantId: env.tenantId,
      aggregateId,
      actorId: env.who.id,
      operation,
      version,
      inputDigest: digest(input),
      correlationId: env.ctx.correlationId,
      metadata: json(metadata),
    },
  });
  const eventName = PERFORMANCE_EVENT_OPERATIONS[operation];
  if (!eventName)
    fail(
      "EVENT_UNREGISTERED",
      "Appraisal operation has no event contract",
      500,
    );
  await event(tx, env, eventName, {
    id: disclosure.aggregateId || aggregateId,
    version: disclosure.anonymous ? 0 : version,
    anonymous: disclosure.anonymous === true,
  });
  return record;
}
export async function event(tx, env, eventName, row) {
  const payload = AppraisalEvent.parse({
    aggregateId: row.id,
    aggregateVersion: row.version ?? 0,
    ...(row.cycleId ? { cycleId: row.cycleId } : {}),
    schemaVersion: 1,
  });
  if (!tx.outboxEvent?.create)
    fail("OUTBOX_UNAVAILABLE", "Transactional event storage unavailable", 503);
  const queued = await enqueueHrDomainEvent(tx, {
    tenantId: env.tenantId,
    eventName,
    actorId: row.anonymous ? "svc:hr-appraisals-peer" : env.ctx.user.userId,
    actorType: row.anonymous ? "service" : "user",
    aggregateType: "PerformanceAppraisal",
    aggregateId: row.id,
    correlationId: env.ctx.correlationId,
    payload,
  });
  if (!queued)
    fail("OUTBOX_UNAVAILABLE", "Appraisal event could not be recorded", 503);
}
export async function updateReview(tx, env, row, data) {
  const result = await tx.perfReview.updateMany({
    where: { id: row.id, tenantId: env.tenantId, version: row.version },
    data: { ...data, version: { increment: 1 } },
  });
  if (result.count !== 1) fail("VERSION_CONFLICT", "Review changed", 412);
  return { ...row, ...data, version: row.version + 1 };
}
export async function sign(tx, env, row, action, input) {
  await tx.perfSignoff.create({
    data: {
      tenantId: env.tenantId,
      reviewId: row.id,
      revisionId: row.currentRevisionId,
      actorId: env.who.id,
      action,
      approvedVersion: row.version,
      reason: input.reason,
      requestHash: digest(input),
    },
  });
}
export async function run(
  operation,
  input,
  permission,
  fn,
  { configuration = false, read = false, authorize } = {},
) {
  const ctx = getCtx();
  if (!ctx.actorVerified || !ctx.user?.tenantId)
    fail("UNAUTHENTICATED", "Verified identity and tenant required", 401);
  for (let attempt = 0; ; attempt++) {
    try {
      return await tenantTransaction(
        prisma,
        async (tx) => {
          const env = {
            ctx,
            tenantId: ctx.user.tenantId,
            who: await actor(tx, ctx),
            now: new Date(),
          };
          permit(env, permission);
          env.config = await tx.perfConfiguration.findUnique({
            where: { tenantId: env.tenantId },
          });
          if (!configuration && !env.config?.coreEnabled)
            fail(
              "FEATURE_DISABLED",
              "Appraisals have not been enabled for this company",
              409,
            );
          if (authorize) await authorize(tx, env);
          if (read) return json(await fn(tx, env));
          const key = `${env.tenantId}:${env.who.id}:${operation}:${input.requestKey}`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`;
          const prior = await tx.perfCommandReceipt.findFirst({
            where: {
              tenantId: env.tenantId,
              actorId: env.who.id,
              operation,
              requestKey: input.requestKey,
            },
          });
          if (prior) {
            if (prior.digest !== digest(input))
              fail(
                "IDEMPOTENCY_CONFLICT",
                "Request key already belongs to different content",
                409,
              );
            return prior.result;
          }
          const result = json(await fn(tx, env));
          await tx.perfCommandReceipt.create({
            data: {
              tenantId: env.tenantId,
              actorId: env.who.id,
              operation,
              requestKey: input.requestKey,
              digest: digest(input),
              result,
            },
          });
          return result;
        },
        {
          tenantId: ctx.user.tenantId,
          txOptions: {
            isolationLevel: "Serializable",
            timeout: 30000,
            maxWait: 10000,
          },
        },
      );
    } catch (error) {
      if (!["P2034", "40001"].includes(error.code) || attempt >= 3) throw error;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          20 * (attempt + 1) + Math.floor(Math.random() * 40),
        ),
      );
    }
  }
}
