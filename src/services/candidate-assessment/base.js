import prisma from "../../lib/prisma.js";
import { tenantTransaction } from "../../lib/rlsTenant.js";
import { getCtx } from "../../mcp/context.js";
import { actor } from "../separation/base.js";
import { enqueueHrDomainEvent } from "../hrDomainEvent.service.js";
import { isRecruitmentFlagEnabled } from "../../lib/recruitmentFlags.js";
import {
  resolveRecruitmentScope,
  interviewScopeWhere,
} from "../../lib/recruitmentAccess.js";
import { fail } from "./rules.js";
export { fail, json } from "./rules.js";
export const has = (env, p) =>
  Array.isArray(env.ctx.permissions) && env.ctx.permissions.includes(p);
export function permit(env, p) {
  if (!has(env, p)) fail("Permission required: " + p, 403, "HR-6002");
}
export async function run(permission, fn, flag = "onsiteTest") {
  const ctx = getCtx();
  if (!ctx.actorVerified || !ctx.user?.tenantId)
    fail("Verified employee and company required", 401, "HR-6002");
  if (!isRecruitmentFlagEnabled(flag))
    fail("This recruitment capability is not enabled", 503, "HR-6003");
  return tenantTransaction(
    prisma,
    async (tx) => {
      const who = await actor(tx, ctx),
        env = {
          ctx,
          who,
          tenantId: ctx.user.tenantId,
          now: new Date(),
          scope: resolveRecruitmentScope({ ...ctx.user, employeeId: who.id }),
        };
      permit(env, permission);
      return fn(tx, env);
    },
    {
      tenantId: ctx.user.tenantId,
      txOptions: { timeout: 30000, isolationLevel: "Serializable" },
    },
  );
}
export async function load(tx, env, model, id, { lock = false } = {}) {
  const table = model[0].toUpperCase() + model.slice(1);
  if (
    ![
      "CandidateTestItem",
      "CandidateTestBlueprint",
      "CandidateTestSession",
      "CandidateTestResult",
      "TestWorkstation",
      "InterviewQuestion",
    ].includes(table)
  )
    throw new Error("Unknown assessment aggregate");
  if (lock)
    await tx.$queryRawUnsafe(
      'SELECT id FROM "' +
        table +
        '" WHERE "tenantId"=$1::uuid AND id=$2 FOR UPDATE',
      env.tenantId,
      Number(id),
    );
  const row = await tx[model].findFirst({
    where: { tenantId: env.tenantId, id: Number(id) },
  });
  if (!row) fail("Record not found", 404);
  return row;
}
export function version(row, expected) {
  if (row.revision !== expected)
    fail("Record changed; refresh before saving", 412, "HR-6005");
}
export async function interview(
  tx,
  env,
  id,
  { reception = false, lock = false } = {},
) {
  if (lock)
    await tx.$queryRaw`SELECT id FROM interviews WHERE "tenantId"=${env.tenantId}::uuid AND id=${Number(id)} FOR UPDATE`;
  const row = await tx.interview.findFirst({
    where: {
      tenantId: env.tenantId,
      id: Number(id),
      ...(reception ? {} : interviewScopeWhere(env.scope)),
    },
    include: {
      interviewers: true,
      application: { include: { jobRequisition: true, candidate: true } },
    },
  });
  if (!row || row.application.candidate.anonymizedAt)
    fail("Interview not found", 404);
  if (
    reception &&
    !has(env, "hr.recruitment.assessment.admin") &&
    !(env.who.recruitmentSiteRefs ?? []).includes(row.siteRef)
  )
    fail("Interview not found", 404);
  return row;
}
export async function event(tx, env, name, payload) {
  const queued = await enqueueHrDomainEvent(tx, {
    tenantId: env.tenantId,
    actorId: env.who?.id ?? "assessment-kiosk",
    actorType: env.who ? "user" : "service",
    eventName: "hr.recruitment." + name + ".v1",
    aggregateType: "Application",
    aggregateId: String(payload.applicationId),
    payload: { ...payload, ...(env.who ? { actorId: env.who.id } : {}) },
  });
  if (!queued) fail("Event could not be persisted", 503);
}
