import { createHash } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { tenantTransaction } from "../../lib/rlsTenant.js";
import { getCtx } from "../../mcp/context.js";
import { enqueueHrDomainEvent } from "../hrDomainEvent.service.js";
import {
  EmploymentResult,
  SeparationPolicy,
} from "@trusoft/contracts/employment";
import {
  employmentError,
  assertTransition,
} from "@trusoft/contracts/employment-rules";
export const fail = (message, status = 422) => {
  throw employmentError(message, status);
};
export const json = (value) => JSON.parse(JSON.stringify(value));
export const terminal = ["EXIT_COMPLETED", "WITHDRAWN", "CANCELLED"];
export const has = (env, permission) =>
  env.ctx.user.isAdmin || env.ctx.permissions?.includes(permission);
export function permit(env, permission) {
  if (!has(env, permission)) fail(`Requires ${permission}`, 403);
}
export const isHr = (env) =>
  has(env, "hr.separation.manage") || has(env, "hr.separation.verify");
export async function currentCode(tx, tenantId, code) {
  const seen = new Set();
  while (!seen.has(code)) {
    seen.add(code);
    const alias = await tx.employeeCodeAlias.findFirst({
      where: { tenantId, employeeCode: code },
    });
    if (!alias) return code;
    code = alias.newCode;
  }
  fail("Employee code alias cycle requires HR review", 409);
}
export function employeeCodes(env, code) {
  const aliases = env.codeAliases || [],
    seen = new Set();
  let current = code;
  for (;;) {
    if (seen.has(current))
      fail("Employee code alias cycle requires HR review", 409);
    seen.add(current);
    const next = aliases.find((a) => a.employeeCode === current);
    if (!next) break;
    current = next.newCode;
  }
  const codes = new Set([current]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const a of aliases)
      if (codes.has(a.newCode) && !codes.has(a.employeeCode)) {
        codes.add(a.employeeCode);
        changed = true;
      }
  }
  return [...codes];
}
export const ownsCode = (env, code) =>
  env.identityCodes?.includes(code) || env.who?.employee_code === code;
export const includesActor = (env, codes = []) =>
  codes.some((code) => ownsCode(env, code));
export async function employee(tx, tenantId, employeeCode) {
  employeeCode = await currentCode(tx, tenantId, employeeCode);
  const e = await tx.employee.findFirst({
    where: { tenant_id: tenantId, employee_code: employeeCode },
  });
  if (!e) fail("Employee not found", 404);
  return e;
}
export async function actor(tx, ctx) {
  const uid = Number(ctx.user.userId);
  if (!Number.isInteger(uid) || uid <= 0)
    fail("A linked employee account is required", 403);
  const rows = await tx.employee.findMany({
    where: { tenant_id: ctx.user.tenantId, userId: uid },
    take: 2,
  });
  if (
    rows.length !== 1 ||
    !rows[0].employee_code ||
    /inactive|terminated|exited|offboard|separated/i.test(
      `${rows[0].status} ${rows[0].employement_status}`,
    )
  )
    fail("An active linked employee code is required", 403);
  return rows[0];
}
export async function run(input, permission, fn, operation) {
  const ctx = getCtx();
  if (!ctx.actorVerified || !ctx.user.tenantId)
    fail("Verified company context is required", 401);
  return tenantTransaction(
    prisma,
    async (tx) => {
      const who = await actor(tx, ctx),
        env = { ctx, tenantId: ctx.user.tenantId, who, now: new Date() };
      env.identityCodes = [who.employee_code];
      const aliases = await tx.employeeCodeAlias.findMany({
        where: { tenantId: env.tenantId },
        select: { employeeCode: true, newCode: true },
      });
      env.codeAliases = aliases;
      for (let changed = true; changed; ) {
        changed = false;
        for (const a of aliases)
          if (
            env.identityCodes.includes(a.newCode) &&
            !env.identityCodes.includes(a.employeeCode)
          ) {
            env.identityCodes.push(a.employeeCode);
            changed = true;
          }
      }
      if (permission) permit(env, permission);
      let digest;
      if (input.requestKey) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${env.tenantId + ":" + input.requestKey},0))`;
        digest = createHash("sha256")
          .update(JSON.stringify({ operation, input }))
          .digest("hex");
        const prior = await tx.employmentCommandReceipt.findUnique({
          where: {
            tenantId_requestKey: {
              tenantId: env.tenantId,
              requestKey: input.requestKey,
            },
          },
        });
        if (prior) {
          if (prior.actorCode !== who.employee_code || prior.digest !== digest)
            fail("Request key was already used for a different command", 409);
          return EmploymentResult.parse(prior.result);
        }
      }
      const result = EmploymentResult.parse(json(await fn(tx, env)));
      if (input.requestKey)
        await tx.employmentCommandReceipt.create({
          data: {
            tenantId: env.tenantId,
            employeeCode: input.employeeCode,
            requestKey: input.requestKey,
            actorCode: who.employee_code,
            digest,
            result,
          },
        });
      return result;
    },
    {
      tenantId: ctx.user.tenantId,
      txOptions: { isolationLevel: "ReadCommitted", timeout: 30000 },
    },
  );
}
export function view(row, kind = "SEPARATION", payload) {
  return {
    ref: row.id || row.tenantId,
    employeeCode: row.employeeCode || row.actorCode,
    version: row.version,
    kind,
    state: row.state || row.status || "ACTIVE",
    ownerCode: row.ownerCode || null,
    dueAt: row.dueAt || null,
    payload: payload ?? row.payload ?? {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
export const result = (env, record = null, items = [], nextCursor = null) => ({
  record,
  items,
  nextCursor,
  actorCode: env.who.employee_code,
  capabilities: env.ctx.user.isAdmin ? ["*"] : env.ctx.permissions || [],
});
export async function policy(tx, tenantId) {
  const p = await tx.separationPolicy.findUnique({ where: { tenantId } });
  if (!p) fail("Configure and publish company separation policy first", 409);
  return { row: p, value: SeparationPolicy.parse(p.policy) };
}
export function checkVersion(row, expected) {
  if (row.version !== expected)
    fail("This record changed. Refresh and review before retrying.", 409);
}
export async function authorizedSeparation(
  tx,
  env,
  input,
  { lock = false } = {},
) {
  if (lock)
    await tx.$queryRaw`SELECT id FROM "Separation" WHERE "tenantId"=${env.tenantId}::uuid AND id=${input.separationRef}::uuid FOR UPDATE`;
  const row = await tx.separation.findFirst({
    where: {
      tenantId: env.tenantId,
      id: input.separationRef,
      employeeCode: { in: employeeCodes(env, input.employeeCode) },
    },
  });
  if (!row) fail("Separation not found", 404);
  const self =
    ownsCode(env, row.employeeCode) && has(env, "hr.separation.self");
  const target = await employee(tx, env.tenantId, row.employeeCode);
  const manager = target.managerId === env.who.id;
  const authority = row.policySnapshot.authority.find(
    (a) => a.category === row.category && a.gradeCode === row.gradeCode,
  );
  const approver =
    has(env, "hr.separation.approve") &&
    includesActor(env, authority?.approverCodes);
  const taskOwner = await ownsTask(tx, env, row);
  if (
    !self &&
    !isHr(env) &&
    !(has(env, "hr.separation.read") && !lock) &&
    !(manager && has(env, "hr.separation.manager")) &&
    !approver &&
    !taskOwner &&
    !has(env, "hr.separation.integrate") &&
    !has(env, "hr.separation.settle")
  )
    fail("Separation not found", 404);
  if (lock) {
    checkVersion(row, input.expectedVersion);
    if (terminal.includes(row.state)) fail("This separation is closed", 409);
  }
  return row;
}
export const taskModels = {
  REPLACEMENT_PLAN: "replacementPlan",
  REPLACEMENT_SESSION: "replacementSession",
  KNOWLEDGE_TRANSFER: "knowledgeTransferItem",
  ASSET: "assetHandoverItem",
  ACCESS: "accessRevocationTask",
  CLEARANCE: "clearanceItem",
  INTERVIEW: "exitInterview",
  SETTLEMENT: "finalSettlementSheet",
  DOCUMENT: "separationDocument",
  NOTICE: "noticePeriodRecord",
};
async function ownsTask(tx, env, s) {
  if (!has(env, "hr.separation.task") && !has(env, "hr.separation.clear"))
    return false;
  if (
    s.policySnapshot.clearanceDepartments.some((d) =>
      includesActor(env, d.signerCodes),
    )
  )
    return true;
  for (const model of [
    "replacementPlan",
    "replacementSession",
    "knowledgeTransferItem",
    "assetHandoverItem",
    "accessRevocationTask",
  ])
    if (
      await tx[model].findFirst({
        where: {
          tenantId: env.tenantId,
          separationRef: s.id,
          ownerCode: { in: env.identityCodes },
        },
      })
    )
      return true;
  return false;
}
export async function managerOnly(tx, env, s) {
  permit(env, "hr.separation.manager");
  const target = await employee(tx, env.tenantId, s.employeeCode);
  if (
    target.managerId !== env.who.id ||
    s.employeeCode === env.who.employee_code
  )
    fail("Only the current direct manager may act", 403);
}
export async function approverOnly(tx, env, s) {
  permit(env, "hr.separation.approve");
  const rule = s.policySnapshot.authority.find(
    (a) => a.category === s.category && a.gradeCode === s.gradeCode,
  );
  if (
    !includesActor(env, rule?.approverCodes) ||
    s.employeeCode === env.who.employee_code
  )
    fail("The authority matrix requires an independent approver", 403);
  // An employee cannot approve the departure of their own manager/ancestor.
  const target = await employee(tx, env.tenantId, s.employeeCode);
  let cursor = env.who.managerId;
  const seen = new Set();
  while (cursor) {
    if (cursor === target.id)
      fail("Approving a superior in your reporting line is prohibited", 403);
    if (seen.has(cursor))
      fail("Resolve the reporting-line cycle before approval", 409);
    seen.add(cursor);
    const parent = await tx.employee.findFirst({
      where: { tenant_id: env.tenantId, id: cursor },
      select: { managerId: true },
    });
    cursor = parent?.managerId;
  }
}
export async function event(tx, env, s, name) {
  const queued = await enqueueHrDomainEvent(tx, {
    eventName: name,
    tenantId: env.tenantId,
    actorId: env.who?.employee_code || "separation-worker",
    actorType: env.who ? "user" : "automation",
    aggregateType: "Separation",
    aggregateId: s.id,
    payload: json({
      employeeCode: s.employeeCode,
      separationRef: s.id,
      state: s.state,
      version: s.version,
      effectiveAt: s.lastWorkingAt || s.deferredUntil || env.now,
      replacementCode:
        s.recommendation?.replacementCode ||
        s.recommendation?.interimOwnerCode ||
        null,
    }),
  });
  if (!queued) fail("Transactional outbox unavailable", 503);
}
export async function notify(tx, env, s, messageCode, key) {
  const authority = s.policySnapshot.authority.find(
    (a) => a.category === s.category && a.gradeCode === s.gradeCode,
  );
  const assigned =
    s.state === "DRAFT"
      ? [s.createdByCode]
      : s.state === "HR_VERIFICATION"
        ? s.policySnapshot.hrCodes
        : s.state === "MANAGEMENT_DECISION"
          ? authority?.approverCodes || []
          : [s.managerCode];
  const recipientCodes = [
    ...new Set(
      [
        s.employeeCode,
        s.createdByCode,
        ...assigned,
        ...s.policySnapshot.hrCodes,
      ].filter(Boolean),
    ),
  ];
  await tx.employmentDelivery.upsert({
    where: { tenantId_key: { tenantId: env.tenantId, key } },
    create: {
      tenantId: env.tenantId,
      employeeCode: s.employeeCode,
      key,
      kind: "NOTIFICATION",
      payload: { separationRef: s.id, recipientCodes, messageCode },
    },
    update: {},
  });
}
export async function audit(
  tx,
  env,
  s,
  action,
  reason,
  priorState = s.state,
  review = null,
) {
  await tx.separationTransition.create({
    data: {
      tenantId: env.tenantId,
      employeeCode: s.employeeCode,
      separationRef: s.id,
      key: `${s.version}:${action}`,
      status: "RECORDED",
      actorCode: env.who?.employee_code || null,
      payload: json({
        action,
        reason,
        from: priorState,
        to: s.state,
        at: env.now,
        ...(review ? { review } : {}),
      }),
    },
  });
}
export async function change(
  tx,
  env,
  s,
  to,
  action,
  reason,
  data = {},
  eventName,
) {
  assertTransition(s.state, to);
  const row = await tx.separation.update({
    where: { id: s.id },
    data: { ...data, state: to, version: { increment: 1 } },
  });
  const review = ["MANAGER_RECOMMENDED", "HR_VERIFIED"].includes(action)
    ? {
        recommendation: row.recommendation,
        verification: row.verification,
        verifiedByCode: row.verifiedByCode,
      }
    : ["REVERTED", "DEFERRAL_DUE"].includes(action)
      ? {
          recommendation: s.recommendation,
          verification: s.verification,
          verifiedByCode: s.verifiedByCode,
        }
      : null;
  await audit(tx, env, row, action, reason, s.state, review);
  if (eventName) await event(tx, env, row, eventName);
  await notify(tx, env, row, action, `transition:${s.id}:${row.version}`);
  return row;
}
export async function touch(tx, env, s, action, reason, data = {}) {
  const row = await tx.separation.update({
    where: { id: s.id },
    data: { ...data, version: { increment: 1 } },
  });
  await audit(tx, env, row, action, reason);
  return row;
}
export async function createTask(
  tx,
  env,
  s,
  model,
  key,
  payload,
  ownerCode,
  dueAt = s.lastWorkingAt,
) {
  if (ownerCode)
    ownerCode = (await employee(tx, env.tenantId, ownerCode)).employee_code;
  return tx[model].create({
    data: {
      tenantId: env.tenantId,
      employeeCode: s.employeeCode,
      separationRef: s.id,
      key,
      payload: json(payload),
      ownerCode: ownerCode || null,
      dueAt: dueAt ? new Date(dueAt) : null,
      actorCode: env.who?.employee_code || null,
    },
  });
}
export async function task(tx, env, s, model, input) {
  const row = await tx[model].findFirst({
    where: { tenantId: env.tenantId, separationRef: s.id, id: input.taskRef },
  });
  if (!row) fail("Task not found", 404);
  checkVersion(row, input.taskVersion);
  return row;
}
export async function updateTask(tx, env, model, row, data) {
  return tx[model].update({
    where: { id: row.id },
    data: {
      ...data,
      actorCode: env.who?.employee_code || null,
      version: { increment: 1 },
    },
  });
}
