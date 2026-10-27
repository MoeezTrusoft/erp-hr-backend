// Additional restrictions for the temporary SDLC verification bootstrap.
// A mounted plan is a scope limit; only a controller-installed DB grant authorizes it.
import { readFile, stat } from "node:fs/promises";
import { mcpCtx } from "../mcp/context.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import {
  BOOTSTRAP_ROLE_PREFIX,
  nativeDigest,
  nativeProvisioningKey,
  validateNativePlan,
  validateNativeWorkerClaim,
  assertNativePayload,
} from "../lib/native-verification-plan.js";

export const HR_NATIVE_PLAN_PATH = "/var/run/trusoft/sdlc-native/plan.json";
const RESERVED_EMAIL =
  /^sdlc-\d{8}-[a-f0-9]{8}-(?:bootstrap|owner|developer|reviewer|outsider)@example\.invalid$/i;
const grants = ["hr.employee.create", "rbac.employee.create"];
export const nativeHrDenied = () => {
  throw Object.assign(new Error("HR-0310: native verification authorization is unavailable"), {
    code: "HR-0310",
    status: 403,
  });
};

export async function loadNativeHrPlan() {
  try {
    const info = await stat(HR_NATIVE_PLAN_PATH);
    if (
      process.platform !== "linux" ||
      !process.env.KUBERNETES_SERVICE_HOST ||
      !info.isFile() ||
      info.size > 32768 ||
      info.uid !== 0 ||
      info.mode & 0o022
    )
      nativeHrDenied();
    return JSON.parse(await readFile(HR_NATIVE_PLAN_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    nativeHrDenied();
  }
}

export function isReservedNativeIdentity(data = {}, actor = {}) {
  return (
    [data.systemEmail, data.email, data.workEmail, data.personalEmail, actor.email].some((value) =>
      RESERVED_EMAIL.test(String(value || "")),
    ) ||
    (actor.roles || []).some((role) => String(role).startsWith(BOOTSTRAP_ROLE_PREFIX)) ||
    ["sdlcVerification", "nativeVerification", "nativeGrant"].some((key) =>
      Object.hasOwn(data, key),
    )
  );
}

// Pure check also used by the worker. The capability is never accepted from tool input.
export function checkNativeHrActor(plan, ctx, entryId, now = new Date()) {
  try {
    validateNativePlan(plan, { now });
  } catch {
    nativeHrDenied();
  }
  const user = ctx?.user || {};
  if (!Array.isArray(ctx?.permissions) || !Array.isArray(user.roles)) nativeHrDenied();
  const actualPermissions = [...new Set(ctx.permissions)].sort();
  if (
    ctx?.actorVerified !== true ||
    ctx?.system ||
    user.isAdmin ||
    user.employeeId != null ||
    String(user.userId) !== String(plan.bootstrap.userId) ||
    user.email !== plan.bootstrap.email ||
    user.tenantId !== plan.tenantId ||
    nativeDigest(user.roles) !== nativeDigest([plan.bootstrap.roleName]) ||
    nativeDigest(actualPermissions) !== nativeDigest(grants)
  )
    nativeHrDenied();
  const entry = plan.accounts.find((item) => item.entryId === entryId);
  if (!entry) nativeHrDenied();
  return { plan, entry, fingerprint: nativeDigest(plan) };
}

export function checkNativeHrCreate(plan, data, ctx, idempotencyKey, now = new Date()) {
  const authorization = checkNativeHrActor(plan, ctx, idempotencyKey, now);
  const { entry } = authorization;
  const expected = {
    firstName: entry.firstName,
    lastName: entry.lastName,
    jobTitle: entry.jobTitle,
    gender: entry.gender,
    hireDate: entry.hireDate,
    mobilePhone: entry.phone,
    employeeCategory: entry.employeeCategory,
    createSystemAccount: true,
    systemEmail: entry.email,
    workEmail: entry.email,
    roleId: entry.roleId,
  };
  if (
    Object.entries(expected).some(([key, value]) => data[key] !== value) ||
    Object.keys(data).some(
      (key) => ![...Object.keys(expected), "employmentStatus", "companyId"].includes(key),
    ) ||
    (data.employmentStatus !== undefined && data.employmentStatus !== "Active") ||
    (data.companyId !== undefined && data.companyId !== plan.companyId)
  )
    nativeHrDenied();
  return { ...authorization, requestFingerprint: nativeDigest(data) };
}

// Ordinary employee creation is unchanged. Reserved actors/identities fail closed
// even when the plan is missing, expired, replaced, or the client changes its target.
export async function authorizeNativeHrCreate(data, options = {}) {
  const ctx = options.ctx ?? mcpCtx.getStore() ?? {};
  const plan = await (options.loadPlan ?? loadNativeHrPlan)();
  const reserved =
    isReservedNativeIdentity(data, ctx.user) ||
    (plan &&
      (String(ctx.user?.userId) === String(plan.bootstrap?.userId) ||
        plan.accounts?.some((entry) => String(entry.roleId) === String(data.roleId))));
  if (!reserved) return null;
  if (!plan) nativeHrDenied();
  return checkNativeHrCreate(plan, data, ctx, options.idempotencyKey, options.now ?? new Date());
}

export async function lockNativeHrGrant(
  tx,
  authorization,
  now = new Date(),
  { allowCancelled = false } = {},
) {
  const { plan, fingerprint } = authorization;
  await tx.$queryRaw`SELECT id FROM "NativeVerificationGrant" WHERE id=${plan.grantId}::uuid AND "tenantId"=${plan.tenantId}::uuid FOR UPDATE`;
  const grant = await tx.nativeVerificationGrant.findFirst({
    where: { id: plan.grantId, tenantId: plan.tenantId },
  });
  if (
    !grant ||
    grant.fingerprint !== fingerprint ||
    nativeDigest(grant.plan) !== fingerprint ||
    grant.bootstrapUserId !== plan.bootstrap.userId ||
    !grant.operatorReceiptId ||
    !grant.operatorReceiptFingerprint ||
    (!allowCancelled &&
      (grant.cancelledAt || grant.expiresAt <= now || new Date(plan.expiresAt) <= now))
  )
    nativeHrDenied();
  return grant;
}

export async function findNativeHrReplay(tx, authorization) {
  const { plan, entry, requestFingerprint } = authorization;
  const owned = await tx.nativeVerificationEntry.findFirst({
    where: { tenantId: plan.tenantId, grantId: plan.grantId, entryId: entry.entryId },
  });
  if (!owned) return null;
  if (
    owned.requestFingerprint !== requestFingerprint ||
    owned.actorUserId !== plan.bootstrap.userId
  )
    nativeHrDenied();
  const employee = await tx.employee.findFirst({
    where: { tenant_id: plan.tenantId, id: owned.employeeId },
  });
  const intent = await tx.systemAccountProvisioning.findFirst({
    where: { tenantId: plan.tenantId, id: owned.provisioningId },
  });
  if (!employee || !intent) nativeHrDenied();
  assertNativeOwnedIntent(authorization, owned, intent);
  return { employee, systemAccount: intent, replayed: true };
}

export function assertNativeOwnedIntent(authorization, owned, intent) {
  const { plan, entry, fingerprint } = authorization;
  if (
    owned.tenantId !== plan.tenantId ||
    owned.grantId !== plan.grantId ||
    owned.entryId !== entry.entryId ||
    intent.id !== owned.provisioningId ||
    intent.tenantId !== plan.tenantId ||
    intent.employeeId !== owned.employeeId ||
    intent.idempotencyKey !== owned.idempotencyKey ||
    intent.payloadFingerprint !== owned.payloadFingerprint ||
    nativeDigest(intent.payload) !== owned.payloadFingerprint ||
    intent.idempotencyKey !== nativeProvisioningKey(plan.tenantId, owned.employeeId) ||
    String(intent.actor?.userId) !== String(plan.bootstrap.userId) ||
    intent.actor?.email !== plan.bootstrap.email ||
    !Array.isArray(intent.actor?.roles) ||
    nativeDigest(intent.actor.roles) !== nativeDigest([plan.bootstrap.roleName]) ||
    nativeDigest([...(intent.actor?.permissions || [])].sort()) !== nativeDigest(grants)
  )
    nativeHrDenied();
  const claim = {
    version: 1,
    grantId: plan.grantId,
    grantFingerprint: fingerprint,
    runId: plan.runId,
    entryId: entry.entryId,
    provisioningId: intent.id,
    employeeId: owned.employeeId,
    idempotencyKey: owned.idempotencyKey,
    payloadFingerprint: owned.payloadFingerprint,
  };
  try {
    validateNativeWorkerClaim(claim);
    assertNativePayload(plan, intent.payload, {
      actorId: plan.bootstrap.userId,
      tenantId: plan.tenantId,
      source: "service-jwt",
      service: "erp-hr-backend",
      verifiedNativeGrant: true,
      key: intent.idempotencyKey,
      fingerprint: intent.payloadFingerprint,
      claim,
    });
  } catch {
    nativeHrDenied();
  }
  return claim;
}

export async function bindNativeHrIntent(tx, authorization, employee, intent) {
  const { plan, entry, requestFingerprint } = authorization;
  const owned = {
    tenantId: plan.tenantId,
    grantId: plan.grantId,
    entryId: entry.entryId,
    employeeId: employee.id,
    provisioningId: intent.id,
    idempotencyKey: intent.idempotencyKey,
    payloadFingerprint: intent.payloadFingerprint,
    actorUserId: plan.bootstrap.userId,
    requestFingerprint,
  };
  assertNativeOwnedIntent(authorization, owned, intent);
  return tx.nativeVerificationEntry.create({ data: owned });
}

// Hold the grant lock through the bounded RPC. Cancellation takes the same lock,
// so once cancellation commits no later worker call can begin. RBAC independently
// locks and checks its grant; cancellation there must precede HR cancellation.
export async function withNativeHrWorkerClaim(prisma, intent, run, options = {}) {
  const plan = await (options.loadPlan ?? loadNativeHrPlan)();
  const receipt = await prisma.nativeVerificationEntry?.findFirst({
    where: { tenantId: intent.tenantId, provisioningId: intent.id },
  });
  const reserved =
    Boolean(receipt) ||
    isReservedNativeIdentity(intent.payload, intent.actor) ||
    (plan &&
      (String(intent.actor?.userId) === String(plan.bootstrap?.userId) ||
        plan.accounts?.some((entry) =>
          intent.payload?.roles?.some((role) => String(role.roleId) === String(entry.roleId)),
        )));
  if (!reserved) return run(null, prisma);
  if (!plan) nativeHrDenied();
  try {
    validateNativePlan(plan, { now: options.now?.() ?? new Date() });
  } catch {
    nativeHrDenied();
  }
  return tenantTransaction(
    prisma,
    async (tx) => {
      const authorization = { plan, fingerprint: nativeDigest(plan) };
      await lockNativeHrGrant(tx, authorization, options.now?.() ?? new Date());
      const owned = await tx.nativeVerificationEntry.findFirst({
        where: { tenantId: intent.tenantId, provisioningId: intent.id },
      });
      authorization.entry = plan.accounts.find((entry) => entry.entryId === owned?.entryId);
      if (!owned || !authorization.entry) nativeHrDenied();
      // Re-read after the lock: a stale queued object is not a durable receipt.
      const current = await tx.systemAccountProvisioning.findFirst({
        where: { tenantId: intent.tenantId, id: intent.id },
      });
      if (
        !current ||
        nativeDigest(current.payload) !== nativeDigest(intent.payload) ||
        (options.requireLease !== false &&
          (current.status !== "PROCESSING" ||
            current.claimedBy !== intent.claimedBy ||
            !current.claimExpiresAt ||
            current.claimExpiresAt.getTime() <= (options.now?.() ?? new Date()).getTime() + 20000))
      )
        nativeHrDenied();
      if (options.requireLease === false && current.status !== intent.status) nativeHrDenied();
      const claim = assertNativeOwnedIntent(authorization, owned, current);
      return run(claim, tx);
    },
    { tenantId: intent.tenantId, txOptions: { timeout: 20000 } },
  );
}
