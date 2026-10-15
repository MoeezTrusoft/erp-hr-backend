import { createHash } from "node:crypto";
import {
  SetupResult,
  setupCanonical,
} from "@trusoft/contracts/hr-company-setup";
import prisma from "../../lib/prisma.js";
import { tenantTransaction } from "../../lib/rlsTenant.js";
import { getCtx } from "../../mcp/context.js";
import { actor, fail, json } from "../separation/base.js";
import { encryptString, decryptString } from "../../lib/crypto.js";
export { fail, json };
export const hash = (v) =>
  createHash("sha256")
    .update(setupCanonical(json(v)))
    .digest("hex");
export const seal = (v) => ({ encrypted: encryptString(JSON.stringify(v)) });
export const unseal = (v) => JSON.parse(decryptString(v.encrypted));
export const has = (env, p) =>
  env.ctx.permissions?.includes("hr.setup." + p) === true;
export const permit = (env, p) => {
  if (!has(env, p)) fail("Requires hr.setup." + p, 403);
};
export function scope() {
  const ctx = getCtx();
  if (!ctx.actorVerified || !ctx.user?.tenantId)
    fail("Verified company context is required", 401);
  return ctx;
}
export async function transact(permission, fn) {
  const ctx = scope();
  return tenantTransaction(
    prisma,
    async (tx) => {
      const env = {
        ctx,
        tenantId: ctx.user.tenantId,
        who: await actor(tx, ctx),
      };
      permit(env, "read");
      if (permission) permit(env, permission);
      // Serialize setup writers and reads of their source in a company. Database
      // row locks additionally protect against writes through other HR screens.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${env.tenantId + ":company-setup"},0))`;
      return fn(tx, env);
    },
    { tenantId: ctx.user.tenantId, txOptions: { timeout: 30000 } },
  );
}
export async function lockedRow(tx, env, ref) {
  const row = await tx.hrSetupReview.findFirst({
    where: { id: ref, tenantId: env.tenantId },
  });
  if (!row) fail("Review not found in this company", 404);
  return row;
}
export function version(row, input) {
  if ((row?.version || 0) !== input.expectedVersion)
    fail("This review changed. Refresh before continuing.", 409);
}
export const independent = (row, env) =>
  !row.editorUserIds.includes(env.who.userId) &&
  row.employeeCode !== env.who.employee_code &&
  unseal(row.source).affectedUserId !== env.who.userId;
export function actions(row, env) {
  const a = [];
  if (
    has(env, "prepare") &&
    ["DRAFT", "RETURNED", "REJECTED"].includes(row.state)
  )
    a.push("SAVE", "SUBMIT");
  if (
    has(env, "approve") &&
    ["MANAGEMENT", "APPROVED"].includes(row.state) &&
    independent(row, env)
  )
    a.push(
      ...(row.state === "MANAGEMENT"
        ? ["APPROVE", "REJECT", "REVERT"]
        : ["REVERT"]),
    );
  if (has(env, "activate") && row.state === "APPROVED") a.push("ACTIVATE");
  if (has(env, "activate") && row.state === "ACTIVATING") a.push("RETRY");
  return a;
}
export async function audit(tx, env, row, action, reason) {
  await tx.hrSetupAudit.create({
    data: {
      tenantId: env.tenantId,
      reviewRef: row.id,
      version: row.version,
      action,
      actorCode: env.who.employee_code,
      actorUserId: env.who.userId,
      reason: encryptString(reason),
      contentHash: row.contentHash,
    },
  });
}
export async function view(tx, env, row, blockers = []) {
  const history = await tx.hrSetupAudit.findMany({
    where: { tenantId: env.tenantId, reviewRef: row.id },
    orderBy: { version: "asc" },
  });
  const payload = unseal(row.payload),
    source = unseal(row.source);
  return {
    reviewRef: row.id,
    kind: row.kind,
    state: row.state,
    employeeCode: row.employeeCode,
    version: row.version,
    data: payload.data,
    evidenceRefs: payload.evidenceRefs,
    preparedByCode: row.preparedByCode,
    approvedByCode: row.approvedByCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() || null,
    activatedAt: row.activatedAt?.toISOString() || null,
    actions: actions(row, env),
    source: source.public,
    blockers,
    failure: row.failure,
    history: history.map((a) => ({
      action: a.action,
      actorCode: a.actorCode,
      reason: decryptString(a.reason),
      at: a.createdAt.toISOString(),
      version: a.version,
    })),
  };
}
export const result = (env, extra = {}) =>
  SetupResult.parse({
    actorCode: env.who.employee_code,
    permissions: env.ctx.permissions.filter((p) => p.startsWith("hr.setup.")),
    ...extra,
  });
export async function command(input, permission, operation, fn) {
  return transact(permission, async (tx, env) => {
    const digest = hash({ operation, input });
    const prior = await tx.hrSetupReceipt.findUnique({
      where: {
        tenantId_requestKey: {
          tenantId: env.tenantId,
          requestKey: input.requestKey,
        },
      },
    });
    if (prior) {
      if (prior.actorUserId !== env.who.userId || prior.digest !== digest)
        fail("Request key already used for a different command", 409);
      return SetupResult.parse(unseal(prior.result));
    }
    const output = await fn(tx, env);
    await tx.hrSetupReceipt.create({
      data: {
        tenantId: env.tenantId,
        requestKey: input.requestKey,
        actorUserId: env.who.userId,
        digest,
        result: seal(output),
      },
    });
    return output;
  });
}
