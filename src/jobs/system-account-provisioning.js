// F-03 / ARCH-00 P-04/P-07/P-12 / ARCH-01 §3.5, §7-§9.
// Durable HR-owned account provisioning with claim/lease and bounded retry.
import crypto from "node:crypto";

import defaultPrisma from "../lib/prisma.js";
import defaultLogger from "../lib/logger.js";
import { mcpCtx } from "../mcp/context.js";
import { createRbacSystemAccount } from "../services/rbac.client.js";

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_BATCH_SIZE = 25;
const LAST_ERROR_MAX = 512;

const truncate = (value, max = LAST_ERROR_MAX) => {
  const text = value == null ? null : String(value?.message ?? value);
  return text && text.length > max ? text.slice(0, max) : text;
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
};

const digest = (value) => crypto
  .createHash("sha256")
  .update(JSON.stringify(canonicalize(value)))
  .digest("hex");

const uuidFromDigest = (hex) => {
  const bytes = Buffer.from(hex.slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const out = bytes.toString("hex");
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
};

const safeActor = (ctx = {}) => {
  const ambient = mcpCtx.getStore() ?? {};
  const source = ctx.actor ?? {
    ...(ambient.user ?? {}),
    permissions: ambient.permissions,
  };
  const permissions = Array.isArray(source.permissions)
    ? source.permissions.filter((item) => typeof item === "string")
    : typeof source.permissions === "string"
      ? source.permissions.split(/[\s,]+/).filter(Boolean)
      : [];
  return {
    userId: source.userId == null ? null : String(source.userId),
    employeeId: source.employeeId == null ? null : String(source.employeeId),
    email: source.email || null,
    roles: Array.isArray(source.roles) ? source.roles.map(String) : [],
    permissions,
  };
};

export function buildSystemAccountProvisioningIntent(data, employee, ctx = {}) {
  if (data.createSystemAccount !== true) return null;
  const tenantId = ctx.tenantId ?? mcpCtx.getStore()?.user?.tenantId ?? null;
  if (!tenantId) throw new Error("HR-0301: verified tenant is required for system-account provisioning");
  if (!data.roleId) throw new Error("HR-0302: roleId is required for system-account provisioning");

  const overrides = Array.isArray(data.permissions)
    ? data.permissions
      .filter((item) => item?.permissionId != null)
      .map((item) => ({ permissionId: item.permissionId, granted: item.granted !== false }))
    : [];
  const payload = {
    first_name: data.firstName,
    last_name: data.lastName,
    job_title: data.jobTitle,
    email: data.systemEmail || data.email || data.workEmail || data.personalEmail || null,
    phone: data.mobilePhone,
    gender: data.gender,
    hire_date: data.hireDate instanceof Date ? data.hireDate.toISOString() : data.hireDate,
    status: employee.status || employee.employement_status || data.employmentStatus || "Active",
    roles: [{ roleId: data.roleId, ...(overrides.length ? { permissions: overrides } : {}) }],
    hrEmployeeId: employee.id,
    mediaId: employee.employee_media_id ?? null,
    departmentId: data.departmentId ?? employee.departmentId ?? null,
  };
  const cleanPayload = Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
  const payloadFingerprint = digest(cleanPayload);
  const idempotencyKey = uuidFromDigest(digest(`hr:system-account:${tenantId}:${employee.id}:v1`));
  return {
    tenantId: String(tenantId),
    employeeId: employee.id,
    status: "PENDING",
    idempotencyKey,
    payloadFingerprint,
    payload: cleanPayload,
    actor: safeActor(ctx),
    correlationId: ctx.correlationId ?? mcpCtx.getStore()?.correlationId ?? null,
    attempts: 0,
    nextAttemptAt: new Date(),
  };
}

export function publicProvisioningState(row) {
  if (!row) return null;
  const status = {
    PENDING: "pending",
    PROCESSING: "processing",
    RETRY_WAIT: "retrying",
    SUCCEEDED: "succeeded",
    TERMINAL_FAILED: "failed",
  }[row.status] ?? "failed";
  return {
    provisioningId: row.id,
    status,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt ?? null,
    ...(row.rbacUserId != null ? { userId: row.rbacUserId } : {}),
    ...(row.lastError ? { error: row.lastError } : {}),
    ...(row.lastErrorCode ? { code: row.lastErrorCode } : {}),
  };
}

const retryDelayMs = (attempt, jitterFn = Math.random) => {
  const base = Math.min(30_000 * (2 ** Math.max(0, attempt - 1)), 60 * 60_000);
  return base + Math.floor(base * 0.2 * jitterFn());
};

const isPermanentFailure = (result) => {
  const status = Number(result?.status);
  return status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
};

function actorContext(row) {
  const actor = row.actor && typeof row.actor === "object" ? row.actor : {};
  return {
    system: true,
    actorVerified: true,
    correlationId: row.correlationId ?? undefined,
    permissions: Array.isArray(actor.permissions) ? actor.permissions : [],
    user: {
      userId: actor.userId ?? null,
      employeeId: actor.employeeId ?? null,
      email: actor.email ?? null,
      roles: Array.isArray(actor.roles) ? actor.roles : [],
      tenantId: row.tenantId,
      isAdmin: false,
    },
  };
}

async function runBatch(options) {
  const {
    prisma = defaultPrisma,
    provision = createRbacSystemAccount,
    logger = defaultLogger,
    workerId,
    now = () => new Date(),
    leaseMs = DEFAULT_LEASE_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    jitterFn = Math.random,
    randomBytesFn = crypto.randomBytes,
  } = options;
  if (!workerId) throw new Error("F-03 provisioning workerId is required");
  const model = prisma.systemAccountProvisioning;
  const startedAt = now();
  const leaseUntil = new Date(startedAt.getTime() + leaseMs);
  const candidates = await model.findMany({
    where: {
      OR: [
        {
          status: { in: ["PENDING", "RETRY_WAIT"] },
          nextAttemptAt: { lte: startedAt },
          OR: [{ claimedAt: null }, { claimExpiresAt: { lt: startedAt } }],
        },
        { status: "PROCESSING", claimExpiresAt: { lt: startedAt } },
      ],
    },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: Math.max(1, Math.min(Number(batchSize) || DEFAULT_BATCH_SIZE, 100)),
  });
  const counts = { scanned: candidates.length, claimed: 0, succeeded: 0, failed: 0, claimRaceLost: 0 };

  for (const row of candidates) {
    const claim = await model.updateMany({
      where: {
        id: row.id,
        OR: [
          { status: { in: ["PENDING", "RETRY_WAIT"] }, OR: [{ claimedAt: null }, { claimExpiresAt: { lt: startedAt } }] },
          { status: "PROCESSING", claimExpiresAt: { lt: startedAt } },
        ],
      },
      data: { status: "PROCESSING", claimedAt: startedAt, claimedBy: workerId, claimExpiresAt: leaseUntil },
    });
    if (claim.count !== 1) {
      counts.claimRaceLost += 1;
      continue;
    }
    counts.claimed += 1;
    const attempt = row.attempts + 1;
    let result;
    try {
      const password = randomBytesFn(18).toString("base64url");
      result = await mcpCtx.run(actorContext(row), () => provision(
        { ...row.payload, password },
        {},
        { idempotencyKey: row.idempotencyKey, payloadFingerprint: row.payloadFingerprint },
      ));
    } catch (error) {
      result = { ok: false, status: null, error: error?.message || "RBAC provisioning failed" };
    }

    if (result?.ok) {
      const userId = result.user?.id == null ? null : String(result.user.id);
      await model.updateMany({
        where: { id: row.id, claimedBy: workerId, status: "PROCESSING" },
        data: {
          status: "SUCCEEDED",
          attempts: attempt,
          rbacUserId: userId,
          result: { userId },
          completedAt: now(),
          nextAttemptAt: null,
          lastError: null,
          lastErrorCode: null,
          lastHttpStatus: null,
          claimedAt: null,
          claimedBy: null,
          claimExpiresAt: null,
        },
      });
      counts.succeeded += 1;
      continue;
    }

    const terminal = isPermanentFailure(result) || attempt >= row.maxAttempts;
    await model.updateMany({
      where: { id: row.id, claimedBy: workerId, status: "PROCESSING" },
      data: {
        status: terminal ? "TERMINAL_FAILED" : "RETRY_WAIT",
        attempts: attempt,
        nextAttemptAt: terminal ? null : new Date(now().getTime() + retryDelayMs(attempt, jitterFn)),
        lastError: truncate(result?.error || "RBAC provisioning failed"),
        lastErrorCode: result?.code == null ? null : truncate(result.code, 128),
        lastHttpStatus: Number.isInteger(result?.status) ? result.status : null,
        claimedAt: null,
        claimedBy: null,
        claimExpiresAt: null,
      },
    });
    counts.failed += 1;
    logger.warn?.(
      { provisioningId: row.id, employeeId: row.employeeId, attempt, terminal },
      "F-03 system-account provisioning attempt failed",
    );
  }
  return counts;
}

export function runSystemAccountProvisioningBatch(options = {}) {
  return mcpCtx.run({ system: true }, () => runBatch(options));
}

export async function getSystemAccountProvisioning(id, tenantId, { prisma = defaultPrisma } = {}) {
  const row = await prisma.systemAccountProvisioning.findFirst({ where: { id, tenantId } });
  if (!row) throw new Error("HR-0303: system-account provisioning not found");
  return publicProvisioningState(row);
}

export async function retrySystemAccountProvisioning(id, tenantId, {
  prisma = defaultPrisma,
  now = () => new Date(),
} = {}) {
  const row = await prisma.systemAccountProvisioning.findFirst({ where: { id, tenantId } });
  if (!row) throw new Error("HR-0303: system-account provisioning not found");
  if (row.status !== "TERMINAL_FAILED") {
    throw new Error("HR-0304: only terminal failed provisioning can be retried manually");
  }
  const updated = await prisma.systemAccountProvisioning.update({
    where: { id: row.id },
    data: {
      status: "PENDING",
      attempts: 0,
      nextAttemptAt: now(),
      lastError: null,
      lastErrorCode: null,
      lastHttpStatus: null,
      claimedAt: null,
      claimedBy: null,
      claimExpiresAt: null,
      manualRetryCount: row.manualRetryCount + 1,
    },
  });
  return publicProvisioningState(updated);
}
