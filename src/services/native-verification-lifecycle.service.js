import { z } from "zod";
import { EventEnvelope } from "@trusoft/contracts/envelopes";
import { HrEmployeeLifecycleV1 } from "@trusoft/contracts/events";
import { deterministicUuid } from "./employeeOutbox.service.js";
import { mcpCtx } from "../mcp/context.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { nativeDigest } from "../lib/native-verification-plan.js";
import {
  checkNativeHrActor,
  loadNativeHrPlan,
  lockNativeHrGrant,
  assertNativeOwnedIntent,
  nativeHrDenied,
} from "./native-verification-guard.service.js";

export const NativeEntryLifecycleInput = z.object({ entryId: z.uuid() }).strict();
export const NativeEntryLifecycleOutput = z
  .object({
    grantId: z.uuid(),
    entryId: z.uuid(),
    tenantId: z.uuid(),
    employeeId: z.number().int().positive().max(2147483647),
    employeeUuid: z.uuid(),
    eventId: z.uuid(),
    outboxId: z.uuid(),
    eventName: z.literal("hr.employee.lifecycle.v1"),
    phase: z.literal("hired"),
    publishedAt: z.iso.datetime().nullable(),
    dispatchAttempts: z.number().int().min(0).max(2147483647),
  })
  .strict()
  .refine((value) => value.publishedAt === null || value.dispatchAttempts >= 1);

export async function nativeVerificationEntryLifecycle(input, options = {}) {
  const parsed = NativeEntryLifecycleInput.safeParse(input);
  if (!parsed.success) nativeHrDenied();
  const ctx = options.ctx ?? mcpCtx.getStore() ?? {};
  const clock = options.now ?? (() => new Date());
  const loadPlan = options.loadPlan ?? loadNativeHrPlan;
  const plan = await loadPlan();
  const authorization = checkNativeHrActor(plan, ctx, parsed.data.entryId, clock());
  const db = options.db ?? (await import("../lib/prisma.js")).default;
  return tenantTransaction(
    db,
    async (tx) => {
      // Serialize with cancellation and the worker, without mutating durable state.
      const grant = await lockNativeHrGrant(tx, authorization, clock());
      // The grant lock may have waited. Recheck both the mounted plan and expiry
      // after acquisition, so a replaced mount or elapsed deadline cannot be used.
      const currentPlan = await loadPlan();
      const current = checkNativeHrActor(currentPlan, ctx, parsed.data.entryId, clock());
      if (nativeDigest(currentPlan) !== authorization.fingerprint) nativeHrDenied();
      if (grant.expiresAt <= clock()) nativeHrDenied();
      const owned = await tx.nativeVerificationEntry.findFirst({
        where: { tenantId: plan.tenantId, grantId: plan.grantId, entryId: parsed.data.entryId },
      });
      if (!owned || owned.actorUserId !== plan.bootstrap.userId || owned.deactivatedAt)
        nativeHrDenied();
      const employee = await tx.employee.findFirst({
        where: { tenant_id: plan.tenantId, id: owned.employeeId },
        select: { id: true, tenant_id: true },
      });
      const intent = await tx.systemAccountProvisioning.findFirst({
        where: { tenantId: plan.tenantId, id: owned.provisioningId },
      });
      if (
        !employee ||
        employee.id !== owned.employeeId ||
        employee.tenant_id !== plan.tenantId ||
        !intent
      )
        nativeHrDenied();
      assertNativeOwnedIntent(current, owned, intent);
      const rows = await tx.outboxEvent.findMany({
        where: {
          tenantId: plan.tenantId,
          eventName: "hr.employee.lifecycle.v1",
          aggregateType: "Employee",
          aggregateId: String(owned.employeeId),
          payload: { path: ["payload", "phase"], equals: "hired" },
        },
        select: {
          id: true,
          tenantId: true,
          eventName: true,
          aggregateType: true,
          aggregateId: true,
          payload: true,
          publishedAt: true,
          attempts: true,
        },
        orderBy: { id: "asc" },
        take: 2,
      });
      if (rows.length !== 1) nativeHrDenied();
      const row = rows[0];
      const outer = EventEnvelope.safeParse(row.payload);
      const inner = HrEmployeeLifecycleV1.safeParse(outer.success ? outer.data.payload : null);
      const employeeUuid = deterministicUuid(
        "hr:employee:" + plan.tenantId + ":" + owned.employeeId,
      );
      if (
        !outer.success ||
        !inner.success ||
        row.tenantId !== plan.tenantId ||
        row.eventName !== "hr.employee.lifecycle.v1" ||
        row.aggregateType !== "Employee" ||
        row.aggregateId !== String(owned.employeeId) ||
        outer.data.tenantId !== plan.tenantId ||
        outer.data.name !== row.eventName ||
        outer.data.version !== 1 ||
        inner.data.tenantId !== plan.tenantId ||
        inner.data.employeeId !== employeeUuid ||
        inner.data.phase !== "hired"
      )
        nativeHrDenied();
      if (row.publishedAt !== null && !z.date().safeParse(row.publishedAt).success)
        nativeHrDenied();

      // Re-read the mounted plan after awaited evidence reads as well.
      const finalPlan = await loadPlan();
      checkNativeHrActor(finalPlan, ctx, parsed.data.entryId, clock());
      if (
        nativeDigest(finalPlan) !== authorization.fingerprint ||
        new Date(finalPlan.expiresAt) <= clock() ||
        grant.expiresAt <= clock()
      )
        nativeHrDenied();
      // Outbox publication is dispatch evidence only. RBAC must independently
      // observe the actual consumer record keyed by this persisted envelope ID.
      const result = NativeEntryLifecycleOutput.safeParse({
        grantId: owned.grantId,
        entryId: owned.entryId,
        tenantId: plan.tenantId,
        employeeId: owned.employeeId,
        employeeUuid,
        eventId: outer.data.id,
        outboxId: row.id,
        eventName: row.eventName,
        phase: inner.data.phase,
        publishedAt: row.publishedAt === null ? null : row.publishedAt.toISOString(),
        dispatchAttempts: row.attempts,
      });
      if (!result.success) nativeHrDenied();
      return result.data;
    },
    { tenantId: plan.tenantId, txOptions: { timeout: 10000, maxWait: 5000 } },
  );
}
