import { createHash } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { tenantTransaction } from "../../lib/rlsTenant.js";
import { getCtx } from "../../mcp/context.js";
import { enqueueHrDomainEvent } from "../hrDomainEvent.service.js";
import { AssessmentPolicy } from "@trusoft/contracts/assessment";
import { canonical, fail } from "@trusoft/contracts/assessment-rules";
export { fail };
export const hash = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const json = (value) => JSON.parse(JSON.stringify(value));
export const days = (n) => n * 86400000;
export const has = (ctx, permission) =>
  ctx.user.isAdmin || ctx.permissions.includes(permission);
export function requirePermission(ctx, permission) {
  if (!ctx.actorVerified || !ctx.user.tenantId)
    fail("UNAUTHENTICATED", "Verified company context is required", 401);
  if (!has(ctx, permission)) fail("FORBIDDEN", `Requires ${permission}`, 403);
}
export async function actor(tx, ctx) {
  const userId = Number(ctx.user.userId);
  if (!Number.isInteger(userId) || userId <= 0)
    fail(
      "ACTOR_UNLINKED",
      "Link this signed-in account to a verified employee code",
      403,
    );
  const employees = await tx.employee.findMany({
    where: { tenant_id: ctx.user.tenantId, userId },
    select: { id: true, employement_status: true, status: true },
    take: 2,
  });
  if (employees.length !== 1)
    fail(
      "ACTOR_UNLINKED",
      "The signed-in account must resolve to exactly one employee in this company",
      403,
    );
  if (
    /inactive|terminated|exited|offboard|separated/i.test(
      `${employees[0].employement_status || ""} ${employees[0].status || ""}`,
    )
  )
    fail(
      "ACTOR_INACTIVE",
      "The employee account is no longer active in HR",
      403,
    );
  const identity = await tx.assessmentIdentity.findFirst({
    where: {
      tenantId: ctx.user.tenantId,
      employeeRowId: employees[0].id,
      active: true,
    },
  });
  if (!identity)
    fail("ACTOR_UNVERIFIED", "Employee-code verification is required", 403);
  const changes = await tx.assessmentCodeChange.findMany({
    where: { tenantId: ctx.user.tenantId },
    select: { oldCode: true, newCode: true },
  });
  const historicalCodes = [identity.employeeCode];
  for (let i = 0; i < changes.length; i++) {
    const prior = changes.find(
      (c) =>
        historicalCodes.includes(c.newCode) &&
        !historicalCodes.includes(c.oldCode),
    );
    if (!prior) break;
    historicalCodes.push(prior.oldCode);
  }
  return { ...identity, historicalCodes, principal: String(ctx.user.userId) };
}
export async function run(permission, fn, { requireActor = true } = {}) {
  const ctx = getCtx();
  requirePermission(ctx, permission);
  return tenantTransaction(
    prisma,
    async (tx) => {
      const who = requireActor
        ? await actor(tx, ctx)
        : {
            employeeCode: null,
            principal: String(ctx.user.userId || "assessment-service"),
          };
      return fn(tx, { ctx, tenantId: ctx.user.tenantId, who, now: new Date() });
    },
    {
      tenantId: ctx.user.tenantId,
      txOptions: { isolationLevel: "Serializable", timeout: 30000 },
    },
  );
}
export async function config(tx, tenantId) {
  const row = await tx.assessmentConfiguration.findUnique({
    where: { tenantId },
  });
  return { ...row, policy: AssessmentPolicy.parse(row?.policy || {}) };
}
export async function identity(tx, tenantId, employeeCode) {
  const row = await tx.assessmentIdentity.findFirst({
    where: { tenantId, employeeCode, active: true },
  });
  if (!row)
    fail(
      "IDENTITY_UNVERIFIED",
      `Employee code ${employeeCode} is not verified in this company`,
    );
  const employee = await tx.employee.findFirst({
    where: { tenant_id: tenantId, id: row.employeeRowId },
    select: {
      employee_code: true,
      employement_status: true,
      status: true,
      positionId: true,
    },
  });
  if (
    !employee ||
    employee.employee_code?.trim() !== employeeCode ||
    /inactive|terminated|exited|offboard|separated/i.test(
      `${employee.employement_status || ""} ${employee.status || ""}`,
    )
  )
    fail(
      "IDENTITY_INACTIVE",
      "The employee code is no longer active and verified in HR",
    );
  if (
    row.positionRef !==
    (employee.positionId == null ? null : String(employee.positionId))
  )
    fail(
      "IDENTITY_SCOPE_CHANGED",
      "The employee position changed; reconcile identity and approved profile before further assessment or planning",
    );
  return row;
}
export async function currentProfile(tx, env, person) {
  const bindings = await tx.employeeAssessmentProfile.findMany({
    where: {
      tenantId: env.tenantId,
      employeeCode: person.employeeCode,
      effectiveFrom: { lte: env.now },
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: env.now } }],
    },
  });
  if (bindings.length !== 1)
    fail(
      "PROFILE_SCOPE_CHANGED",
      "Exactly one current approved profile is required for this employee",
    );
  const profile = await tx.assessmentProfileVersion.findFirst({
    where: {
      tenantId: env.tenantId,
      id: bindings[0].profileRef,
      status: "PUBLISHED",
    },
  });
  if (!profile || profile.positionRef !== person.positionRef)
    fail(
      "PROFILE_SCOPE_CHANGED",
      "The current approved profile does not match the employee’s position",
    );
  return profile;
}
export async function verifyAssessmentScope(tx, env, assignment) {
  const person = await identity(tx, env.tenantId, assignment.employeeCode);
  const profile = await currentProfile(tx, env, person);
  if (profile.id !== assignment.profileRef)
    fail(
      "PROFILE_SCOPE_CHANGED",
      "This assessment belongs to a previous role profile; retain its history and reassess the current scope",
    );
  return profile;
}
export async function audit(
  tx,
  env,
  action,
  aggregateRef,
  input,
  result,
  metadata = {},
) {
  return tx.assessmentAudit.create({
    data: {
      tenantId: env.tenantId,
      aggregateRef,
      action,
      actorPrincipal: env.who.principal,
      actorCode: env.who.employeeCode,
      inputDigest: hash(input),
      resultDigest: hash(result),
      metadata: json(metadata),
    },
  });
}
export async function event(tx, env, name, aggregateRef, payload) {
  if (!tx.outboxEvent)
    fail(
      "OUTBOX_UNAVAILABLE",
      "Transactional event delivery is unavailable",
      503,
    );
  return enqueueHrDomainEvent(tx, {
    eventName: name,
    tenantId: env.tenantId,
    actorId: env.who.principal,
    actorType: env.who.employeeCode ? "user" : "automation",
    aggregateType: "Assessment",
    aggregateId: aggregateRef,
    correlationId: env.ctx?.correlationId,
    payload: json(payload),
  });
}
export async function exception(
  tx,
  env,
  key,
  kind,
  scopeRef,
  detail,
  ownerRole = "HR_ASSESSMENT_OWNER",
) {
  return tx.assessmentException.upsert({
    where: { tenantId_key: { tenantId: env.tenantId, key } },
    create: {
      tenantId: env.tenantId,
      key,
      kind,
      scopeRef,
      detail: json(detail),
      ownerRole,
    },
    update: {
      status: "OPEN",
      detail: json(detail),
      stableSince: null,
      resolvedAt: null,
      version: { increment: 1 },
    },
  });
}
export async function cas(tx, table, row, expectedVersion, data) {
  if (expectedVersion !== row.version)
    fail(
      "STALE_VERSION",
      "This record changed. Reload and reconcile your draft.",
      409,
    );
  const result = await tx[table].updateMany({
    where: { tenantId: row.tenantId, id: row.id, version: expectedVersion },
    data: { ...data, version: { increment: 1 } },
  });
  if (result.count !== 1)
    fail("STALE_VERSION", "Another user updated this record", 409);
  return tx[table].findFirst({ where: { tenantId: row.tenantId, id: row.id } });
}
export function assignmentAccess(env, a, write = false) {
  if (!a) fail("NOT_FOUND", "Assessment not found", 404);
  if (
    write
      ? a.raterCode !== env.who.employeeCode
      : !has(env.ctx, "hr.assessment.read") &&
        ![a.employeeCode, a.raterCode, a.reviewerCode].some((code) =>
          (env.who.historicalCodes || [env.who.employeeCode]).includes(code),
        )
  )
    fail("FORBIDDEN", "You are not assigned to this assessment", 403);
}
export const scopeKey = (task) =>
  `${task.complexity}|${task.technology}|${task.scope}`;
