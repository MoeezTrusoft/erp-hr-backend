import { isAppraisalApproval, appraisalApprovalPermission, canReadAppraisalApproval,
  appraisalApprovalActions, appraisalApprovalSource, actAppraisalApproval } from "../appraisals/approval-bridge.js";
import { has as hasAppraisal } from "../appraisals/base.js";
import { transitionInTransaction } from "../appraisals/core.js";
import { encryptString, decryptString } from "../../lib/crypto.js";
import prisma from "../../lib/prisma.js";
import { tenantTransaction } from "../../lib/rlsTenant.js";
import { getCtx } from "../../mcp/context.js";
import {
  ApprovalList,
  ApprovalRead,
  ApprovalPreview,
  ApprovalSubmit,
  ApprovalAction,
  ApprovalResult,
} from "@trusoft/contracts/hr-approval";
import {
  HR_APPROVAL_ACTIONS,
  hrRevertTarget,
} from "@trusoft/contracts/hr-approval-rules";
import {
  actor,
  employee,
  ownsCode,
  employeeCodes,
} from "../separation/base.js";
import { enqueueHrDomainEvent } from "../hrDomainEvent.service.js";
import {
  fail,
  hash,
  json,
  loadSource,
  sourceCandidates,
  onSubmit,
  onReturn,
  applyDecision,
} from "./adapters.js";
const seal = (value) => ({
  sealed: encryptString(JSON.stringify(json(value))),
});
const unseal = (value) => JSON.parse(decryptString(value.sealed));
const permits = (env, key) =>
  env.ctx.permissions?.includes("hr.approvals." + key) === true;
const assertVersion = (row, version) => {
  if (row.version !== version)
    fail("Request changed. Refresh and review the current version.", 412);
};
async function execute(input, operation, fn) {
  const ctx = getCtx();
  if (!ctx.actorVerified || !ctx.user.tenantId)
    fail("Verified company and employee identity required", 401);
  return tenantTransaction(
    prisma,
    async (tx) => {
      const who = await actor(tx, ctx),
        env = { ctx, who, tenantId: ctx.user.tenantId, now: new Date() };
      if (
        !["self", "manager", "verify", "approve", "read"].some((k) => permits(env, k))
        && !hasAppraisal(env, "hr.performance.read")
      )
        fail("Approval access required", 403);
      env.codeAliases = await tx.employeeCodeAlias.findMany({
        where: { tenantId: env.tenantId },
        select: { employeeCode: true, newCode: true },
      });
      env.identityCodes = employeeCodes(env, who.employee_code);
      const digest = hash({ operation, input });
      if (input.requestKey) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${env.tenantId + ":approval-key:" + input.requestKey},0))`;
        const prior = await tx.hrApprovalReceipt.findUnique({
          where: {
            tenantId_requestKey: {
              tenantId: env.tenantId,
              requestKey: input.requestKey,
            },
          },
        });
        if (prior) {
          if (!ownsCode(env, prior.actorCode) || prior.digest !== digest)
            fail("Request key already used for another command");
          const cached = ApprovalResult.parse(unseal(prior.result));
          const current = await tx.hrApprovalRequest.findFirst({
            where: { tenantId: env.tenantId, id: cached.record.approvalRef },
          });
          const from = cached.record.history.at(-1)?.fromStage;
          const grant =
            operation === "SUBMIT" || input.action === "WITHDRAW"
              ? "self"
              : {
                  LINE_MANAGER: "manager",
                  HR: "verify",
                  MANAGEMENT: "approve",
                }[from];
          if (
            !current ||
            (isAppraisalApproval(current)
              ? !hasAppraisal(env, appraisalApprovalPermission(current))
              : !grant || !permits(env, grant)) ||
            !(await canRead(tx, env, current))
          )
            fail("Approval access required", 403);
          return cached;
        }
      }
      const result = ApprovalResult.parse(json(await fn(tx, env)));
      if (input.requestKey)
        await tx.hrApprovalReceipt.create({
          data: {
            tenantId: env.tenantId,
            requestKey: input.requestKey,
            actorCode: who.employee_code,
            digest,
            result: seal(result),
          },
        });
      return result;
    },
    { tenantId: ctx.user.tenantId, txOptions: { timeout: 60000 } },
  );
}
async function actionsFor(tx, env, row) {
  if (isAppraisalApproval(row)) return appraisalApprovalActions(tx, env, row);
  if (["APPROVED", "REJECTED", "WITHDRAWN"].includes(row.stage)) return [];
  const subject = await employee(tx, env.tenantId, row.employeeCode),
    self = ownsCode(env, row.employeeCode);
  if (self)
    return permits(env, "self")
      ? [
          ...(row.stage === "INITIATOR" ? ["SUBMIT"] : []),
          ...(["LEAVE", "OVERTIME", "CLAIM", "SHIFT_SWAP"].includes(row.kind)
            ? ["WITHDRAW"]
            : []),
        ]
      : [];
  if (row.stage === "LINE_MANAGER")
    return subject.managerId === env.who.id && permits(env, "manager")
      ? HR_APPROVAL_ACTIONS.LINE_MANAGER
      : [];
  if (row.stage === "HR")
    return permits(env, "verify") && !ownsCode(env, row.managerActorCode)
      ? HR_APPROVAL_ACTIONS.HR
      : [];
  if (row.stage === "MANAGEMENT")
    return permits(env, "approve") &&
      ![row.managerActorCode, row.hrActorCode].some((c) => ownsCode(env, c))
      ? HR_APPROVAL_ACTIONS.MANAGEMENT
      : [];
  return [];
}
async function canRead(tx, env, row) {
  if (isAppraisalApproval(row)) return canReadAppraisalApproval(tx, env, row);
  if (
    ownsCode(env, row.employeeCode) ||
    permits(env, "read") ||
    permits(env, "verify") ||
    permits(env, "approve")
  )
    return true;
  const subject = await employee(tx, env.tenantId, row.employeeCode);
  return permits(env, "manager") && subject.managerId === env.who.id;
}
async function view(tx, env, row, summary = false) {
  if (!(await canRead(tx, env, row))) fail("Request not found", 404);
  const leavePolicies =
    !summary && row.kind === "LEAVE" && permits(env, "verify")
      ? (
          await tx.leavePolicy.findMany({
            where: { tenantId: env.tenantId, active: true },
            select: { id: true, name: true },
            orderBy: { name: "asc" },
          })
        ).map((p) => ({ ref: String(p.id), label: p.name }))
      : [];
  const history = summary
    ? []
    : await tx.hrApprovalAudit.findMany({
        where: { tenantId: env.tenantId, approvalRef: row.id },
        orderBy: { version: "asc" },
      });
  return {
    approvalRef: row.id,
    kind: row.kind,
    sourceRef: row.sourceRef,
    employeeCode: row.employeeCode,
    stage: row.stage,
    version: row.version,
    round: row.round,
    managerCode: row.managerCode,
    recommendation: row.recommendation,
    verification: row.verification,
    execution: row.execution,
    source: summary ? {} : isAppraisalApproval(row)
      ? await appraisalApprovalSource(tx, env, row) : unseal(row.snapshot),
    leavePolicies,
    actions: summary ? [] : await actionsFor(tx, env, row),
    history: history.map(
      ({
        actorCode,
        fromStage,
        toStage,
        action,
        reason,
        round,
        version,
        createdAt,
      }) => ({
        actorCode,
        fromStage,
        toStage,
        action,
        reason,
        round,
        version,
        createdAt,
      }),
    ),
    updatedAt: row.updatedAt,
  };
}
async function audit(tx, env, before, after, action, reason) {
  await tx.hrApprovalAudit.create({
    data: {
      tenantId: env.tenantId,
      approvalRef: after.id,
      version: after.version,
      round: after.round,
      actorCode: env.who.employee_code,
      fromStage: before.stage,
      toStage: after.stage,
      action,
      reason,
      sourceHash: after.sourceHash,
    },
  });
  const queued = await enqueueHrDomainEvent(tx, {
    tenantId: env.tenantId,
    actorId: env.who.employee_code,
    actorType: "user",
    eventName: "hr.approval.transitioned.v1",
    aggregateType: "HrApprovalRequest",
    aggregateId: after.id,
    correlationId: env.ctx.correlationId,
    payload: {
      approvalRef: after.id,
      kind: after.kind,
      sourceRef: after.sourceRef,
      employeeCode: after.employeeCode,
      actorCode: env.who.employee_code,
      fromStage: before.stage,
      toStage: after.stage,
      action,
      version: after.version,
      round: after.round,
    },
  });
  if (!queued) fail("Transactional approval event could not be recorded", 503);
}
export function submitApproval(raw, { prepare } = {}) {
  const input = ApprovalSubmit.parse(raw);
  return execute(input, "SUBMIT", async (tx, env) => {
    if (!permits(env, "self") || !ownsCode(env, input.employeeCode))
      fail("Only the employee initiator can submit", 403);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${env.tenantId + ":approval-source:" + input.kind + ":" + input.sourceRef},0))`;
    let row = await tx.hrApprovalRequest.findUnique({
      where: {
        tenantId_kind_sourceRef: {
          tenantId: env.tenantId,
          kind: input.kind,
          sourceRef: input.sourceRef,
        },
      },
    });
    if (row) {
      await tx.$queryRaw`SELECT id FROM "HrApprovalRequest" WHERE "tenantId"=${env.tenantId}::uuid AND id=${row.id}::uuid FOR UPDATE`;
      row = await tx.hrApprovalRequest.findUnique({ where: { id: row.id } });
      assertVersion(row, input.expectedVersion);
      if (row.stage !== "INITIATOR")
        fail("Only a draft or returned request can be submitted");
    } else if (input.expectedVersion !== 0)
      fail("Request changed. Refresh before submission", 412);
    if (prepare) await prepare(tx, env);
    const source = await loadSource(tx, env, input.kind, input.sourceRef, {
      lock: true,
    });
    if (!ownsCode(env, source.who.employee_code))
      fail("Only the employee initiator can submit", 403);
    const manager = await tx.employee.findFirst({
      where: { tenant_id: env.tenantId, id: source.who.managerId ?? -1 },
    });
    if (
      !manager?.employee_code ||
      manager.id === env.who.id ||
      /inactive|terminated|exited|separated/i.test(
        `${manager.status} ${manager.employement_status}`,
      )
    )
      fail("Configure an active independent line manager before submission");
    await onSubmit(tx, env, input.kind, source);
    const data = {
      employeeCode: env.who.employee_code,
      stage: "LINE_MANAGER",
      managerCode: manager.employee_code,
      managerActorCode: null,
      hrActorCode: null,
      recommendation: null,
      verification: null,
      sourceHash: source.digest,
      snapshot: seal(source.snapshot),
      execution: "PENDING",
    };
    const next = row
      ? await tx.hrApprovalRequest.update({
          where: { id: row.id },
          data: { ...data, version: { increment: 1 }, round: { increment: 1 } },
        })
      : await tx.hrApprovalRequest.create({
          data: {
            tenantId: env.tenantId,
            kind: input.kind,
            sourceRef: input.sourceRef,
            ...data,
            version: 1,
            round: 1,
          },
        });
    await audit(
      tx,
      env,
      row || { stage: "INITIATOR" },
      next,
      "SUBMIT",
      input.reason,
    );
    return {
      actorCode: env.who.employee_code,
      record: await view(tx, env, next),
    };
  });
}
export function actApproval(raw) {
  const input = ApprovalAction.parse(raw);
  return execute(input, "ACTION", async (tx, env) => {
    await tx.$queryRaw`SELECT id FROM "HrApprovalRequest" WHERE "tenantId"=${env.tenantId}::uuid AND id=${input.approvalRef}::uuid FOR UPDATE`;
    const row = await tx.hrApprovalRequest.findFirst({
      where: { tenantId: env.tenantId, id: input.approvalRef },
    });
    if (!row) fail("Request not found", 404);
    if (isAppraisalApproval(row)) {
      const next = await actAppraisalApproval(tx, env, row, input, transitionInTransaction);
      return { actorCode: env.who.employee_code, record: await view(tx, env, next) };
    }
    if (!(await canRead(tx, env, row))) fail("Request not found", 404);
    assertVersion(row, input.expectedVersion);
    if (!(await actionsFor(tx, env, row)).includes(input.action))
      fail("You cannot perform this action at the current stage", 403);
    let source = await loadSource(tx, env, row.kind, row.sourceRef, {
      lock: true,
    });
    const data = { version: { increment: 1 } };
    if (input.action === "WITHDRAW") {
      data.stage = "WITHDRAWN";
      data.execution = "APPLIED";
    } else if (input.action === "REVERT") {
      data.stage = hrRevertTarget(row.stage);
      data.verification = null;
      data.hrActorCode = null;
      await onReturn(tx, row.kind, source, data.stage);
      if (data.stage === "INITIATOR") {
        data.recommendation = null;
        data.managerActorCode = null;
      }
    } else {
      if (
        row.stage !== "LINE_MANAGER" &&
        row.managerActorCode &&
        (await employee(tx, env.tenantId, row.managerActorCode)).id !==
          source.who.managerId
      )
        fail(
          "The line manager changed. Revert to the initiator for a fresh recommendation.",
        );
      if (source.digest !== row.sourceHash)
        fail(
          "The request or evidence changed. Revert to the initiator for a fresh review.",
        );
      if (input.leavePolicyRef) {
        if (row.kind !== "LEAVE" || input.action !== "VERIFY")
          fail("Only HR verification may classify a leave request", 403);
        const policy = await tx.leavePolicy.findFirst({
          where: {
            tenantId: env.tenantId,
            id: Number(input.leavePolicyRef),
            active: true,
          },
        });
        if (!policy) fail("Choose an active company leave policy", 422);
        await tx.leaveRequest.update({
          where: { id: source.row.id },
          data: { leavePolicyId: policy.id },
        });
        source = await loadSource(tx, env, row.kind, row.sourceRef);
        data.sourceHash = source.digest;
        data.snapshot = seal(source.snapshot);
      }
      if (input.action.startsWith("RECOMMEND_")) {
        data.stage = "HR";
        data.recommendation = input.action;
        data.managerActorCode = env.who.employee_code;
        data.managerCode = env.who.employee_code;
      } else if (input.action === "VERIFY") {
        if (row.kind === "LEAVE" && !source.row.leavePolicyId)
          fail("Select the leave policy before verification", 422);
        data.stage = "MANAGEMENT";
        data.verification = input.reason;
        data.hrActorCode = env.who.employee_code;
        if (row.kind === "ATTENDANCE")
          await tx.attendanceRuleAudit.create({
            data: {
              tenantId: env.tenantId,
              employeeId: source.row.employeeId,
              anomalyId: source.row.id,
              action: "COMMENT",
              actorId: env.who.employee_code,
              data: {
                kind: "HR",
                comment: input.reason,
                factHash: source.row.factHash,
                approvalRef: row.id,
                round: row.round,
              },
            },
          });
      } else {
        data.stage = input.action === "APPROVE" ? "APPROVED" : "REJECTED";
      }
    }
    let next = await tx.hrApprovalRequest.update({
      where: { id: row.id },
      data,
    });
    if (input.action === "WITHDRAW") {
      await tx.$executeRaw`SELECT set_config('app.hr_approval_finalizing',${row.kind + ":" + source.row.id},true)`;
      await tx[source.definition.model].update({
        where: { id: source.row.id },
        data: { status: row.kind === "LEAVE" ? "CANCELLED" : "WITHDRAWN" },
      });
    }
    if (["APPROVE", "REJECT"].includes(input.action)) {
      const execution = await applyDecision(
        tx,
        env,
        row,
        source,
        input.action === "APPROVE",
        input.reason,
      );
      next = await tx.hrApprovalRequest.update({
        where: { id: row.id },
        data: { execution },
      });
    }
    await audit(tx, env, row, next, input.action, input.reason);
    return {
      actorCode: env.who.employee_code,
      record: await view(tx, env, next),
    };
  });
}
export function readApproval(raw) {
  const input = ApprovalRead.parse(raw);
  return execute(input, "READ", async (tx, env) => {
    const row = await tx.hrApprovalRequest.findFirst({
      where: { tenantId: env.tenantId, id: input.approvalRef },
    });
    if (!row) fail("Request not found", 404);
    return {
      actorCode: env.who.employee_code,
      record: await view(tx, env, row),
    };
  });
}
export function listApprovals(raw) {
  const input = ApprovalList.parse(raw);
  return execute(input, "LIST", async (tx, env) => {
    if (
      !["self", "manager", "verify", "approve", "read"].some((k) => permits(env, k))
      && !hasAppraisal(env, "hr.performance.read")
    )
      fail("Approval access required", 403);
    if (input.scope === "ALL" && !permits(env, "read") && !hasAppraisal(env, "hr.performance.read.all"))
      fail("Approval audit access required", 403);
    const where = {
      tenantId: env.tenantId,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.cursor ? { id: { gt: input.cursor } } : {}),
    };
    if (input.scope === "MINE") where.employeeCode = { in: env.identityCodes };
    // Scope in SQL before pagination so a busy tenant cannot hide a manager's queue.
    if (input.scope === "QUEUE") {
      const reports = permits(env, "manager")
        ? await tx.employee.findMany({
            where: { tenant_id: env.tenantId, managerId: env.who.id },
            select: { employee_code: true },
          })
        : [];
      where.OR = [
        ...(permits(env, "self")
          ? [{ stage: "INITIATOR", employeeCode: { in: env.identityCodes } }]
          : []),
        ...(reports.length
          ? [
              {
                stage: "LINE_MANAGER",
                employeeCode: {
                  in: reports.flatMap((e) =>
                    employeeCodes(env, e.employee_code),
                  ),
                },
              },
            ]
          : []),
        ...(permits(env, "verify")
          ? [
              {
                stage: "HR",
                employeeCode: { notIn: env.identityCodes },
                OR: [
                  { managerActorCode: null },
                  { managerActorCode: { notIn: env.identityCodes } },
                ],
              },
            ]
          : []),
        ...(permits(env, "approve")
          ? [
              {
                stage: "MANAGEMENT",
                employeeCode: { notIn: env.identityCodes },
                managerActorCode: { notIn: env.identityCodes },
                hrActorCode: { notIn: env.identityCodes },
              },
            ]
          : []),
      ];
    }
    const appraisalVisible = hasAppraisal(env, "hr.performance.read.all");
    const normal = { NOT: { sourceRef: { startsWith: "perf:" } }, ...where };
    if (!["self", "manager", "verify", "approve", "read"].some((k) => permits(env, k))) normal.id = { in: [] };
    const appraisalWhere = { tenantId: env.tenantId, kind: "PERFORMANCE",
      sourceRef: { startsWith: "perf:" }, ...(input.cursor ? { id: { gt: input.cursor } } : {}) };
    if (input.kind && input.kind !== "PERFORMANCE") appraisalWhere.AND = [{ id: { in: [] } }];
    if (input.scope === "QUEUE") {
      appraisalWhere.stage = "MANAGEMENT";
      appraisalWhere.employeeCode = { notIn: env.identityCodes };
      appraisalWhere.managerActorCode = { notIn: env.identityCodes };
      appraisalWhere.OR = [
        ...(appraisalVisible && hasAppraisal(env, "hr.performance.approve")
          ? [{ sourceRef: { startsWith: "perf:SENIOR:" } }] : []),
        ...(appraisalVisible && hasAppraisal(env, "hr.performance.release")
          ? [{ sourceRef: { startsWith: "perf:RELEASE:" } }] : []),
      ];
    } else if (!appraisalVisible || input.scope === "MINE") {
      const visible = await tx.perfReview.findMany({ where: {
        tenantId: env.tenantId, employeeId: env.who.id, releasedRevisionId: { not: null },
      }, select: { id: true } });
      const bindings = await tx.perfApprovalBinding.findMany({ where: {
        tenantId: env.tenantId, reviewId: { in: visible.map((r) => r.id) },
      }, select: { approvalRef: true } });
      appraisalWhere.id = { in: bindings.map((b) => b.approvalRef) };
    } else {
      const unreleased = await tx.perfReview.findMany({ where: {
        tenantId: env.tenantId, employeeId: env.who.id, releasedRevisionId: null,
      }, select: { id: true } });
      const bindings = await tx.perfApprovalBinding.findMany({ where: {
        tenantId: env.tenantId, reviewId: { in: unreleased.map((r) => r.id) },
      }, select: { approvalRef: true } });
      appraisalWhere.NOT = { id: { in: bindings.map((b) => b.approvalRef) } };
    }
    const scopedWhere = { OR: [normal, appraisalWhere] };
    const rows = await tx.hrApprovalRequest.findMany({
        where: scopedWhere,
        orderBy: { id: "asc" },
        take: input.limit + 1,
      }),
      page = rows.slice(0, input.limit);
    const items = [];
    for (const row of page) items.push(await view(tx, env, row, true));
    return {
      actorCode: env.who.employee_code,
      items,
      candidates:
        input.scope === "MINE" && permits(env, "self")
          ? await sourceCandidates(tx, env, input.kind)
          : [],
      nextCursor: rows.length > input.limit ? page.at(-1).id : null,
    };
  });
}

export function previewApproval(raw) {
  const input = ApprovalPreview.parse(raw);
  return execute(input, "PREVIEW", async (tx, env) => {
    const source = await loadSource(tx, env, input.kind, input.sourceRef);
    if (!ownsCode(env, source.who.employee_code) || !permits(env, "self"))
      fail("Only the employee initiator may preview submission", 403);
    return {
      actorCode: env.who.employee_code,
      preview: {
        kind: input.kind,
        sourceRef: input.sourceRef,
        employeeCode: source.who.employee_code,
        source: source.snapshot,
      },
    };
  });
}
