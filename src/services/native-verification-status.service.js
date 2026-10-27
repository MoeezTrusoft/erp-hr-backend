import { z } from "zod";
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

export const NativeEntryStatusInput = z.object({ entryId: z.uuid() }).strict();
const PositiveInt32 = z.number().int().positive().max(2147483647);
const RbacId = z
  .string()
  .regex(/^[1-9]\d{0,9}$/)
  .refine((value) => Number(value) <= 2147483647);
export const NativeEntryStatusOutput = z
  .object({
    grantId: z.uuid(),
    entryId: z.uuid(),
    employeeId: PositiveInt32,
    provisioningId: z.uuid(),
    idempotencyKey: z.uuid(),
    payloadFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["PENDING", "PROCESSING", "RETRY_WAIT", "SUCCEEDED", "TERMINAL_FAILED"]),
    rbacUserId: RbacId.nullable(),
  })
  .strict()
  .refine((value) =>
    value.status === "SUCCEEDED" ? value.rbacUserId !== null : value.rbacUserId === null,
  );

export async function nativeVerificationEntryStatus(input, options = {}) {
  const parsed = NativeEntryStatusInput.safeParse(input);
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
      // Final read-time expiry check, after all awaited reads.
      checkNativeHrActor(currentPlan, ctx, parsed.data.entryId, clock());
      if (new Date(currentPlan.expiresAt) <= clock() || grant.expiresAt <= clock())
        nativeHrDenied();
      const result = NativeEntryStatusOutput.safeParse({
        grantId: owned.grantId,
        entryId: owned.entryId,
        employeeId: owned.employeeId,
        provisioningId: owned.provisioningId,
        idempotencyKey: owned.idempotencyKey,
        payloadFingerprint: owned.payloadFingerprint,
        status: intent.status,
        rbacUserId: intent.rbacUserId ?? null,
      });
      if (!result.success) nativeHrDenied();
      return result.data;
    },
    { tenantId: plan.tenantId, txOptions: { timeout: 10000, maxWait: 5000 } },
  );
}
