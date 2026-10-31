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
  isVerifiedOnBehalf,
  requiresLineManager,
  skipsManagerWhenNone,
  stageAfterSubmission,
} from "../../lib/approvalStagePolicy.js";
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
import { Prisma } from "@prisma/client";
import { identitiesByCode } from "../../lib/personIdentity.js";
import {
  MATRIX_KINDS,
  PERMISSION_BY_ACTION,
  amountOf,
  buildRoute,
  levelActions,
  nextActionable,
  previousActionable,
} from "../../lib/approvalMatrix.js";
import { loadPublishedMatrix } from "../approvalMatrix.service.js";
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
// ── Configurable matrix (ATTENDANCE / PAYROLL with a published route) ─────────────────────────────
// A request that sealed a route waits at stage LEVEL; everything else keeps the fixed stages.
const INACTIVE = /inactive|terminated|exited|separated/i;
const stageLabel = (row) =>
  row.stage === "LEVEL" && row.route?.levels?.[row.level]
    ? `LEVEL ${row.level + 1}: ${row.route.levels[row.level].name}`
    : row.stage;
const routeView = (row) =>
  row.route && ["LEVEL", "APPROVED", "REJECTED", "WITHDRAWN"].includes(row.stage)
    ? {
        matrixVersion: row.route.matrixVersion,
        current: row.stage === "LEVEL" ? row.level : null,
        levels: row.route.levels.map(
          ({ index, name, action, required, engaged, auto, skipped }) => ({
            index, name, action, required, engaged, auto, skipped,
          }),
        ),
      }
    : null;
function levelActionsFor(env, row) {
  const level = row.route?.levels?.[row.level];
  if (!level || !env.identityCodes.some((c) => row.pendingCodes.includes(c))) return [];
  return permits(env, PERMISSION_BY_ACTION[level.action]) ? levelActions(level) : [];
}
async function sealRoute(tx, env, kind, matrix, source) {
  const ids = [...new Set(matrix.levels.flatMap((l) => l.approverIds))];
  const named = ids.length
    ? await tx.employee.findMany({ where: { tenant_id: env.tenantId, id: { in: ids } } })
    : [];
  const live = (e) =>
    e?.employee_code && !INACTIVE.test(`${e.status} ${e.employement_status}`) ? e.employee_code : null;
  const byId = new Map(named.map((e) => [e.id, live(e)]));
  const manager = source.who.managerId
    ? await tx.employee.findFirst({ where: { tenant_id: env.tenantId, id: source.who.managerId } })
    : null;
  return buildRoute({
    kind,
    matrixVersion: matrix.version,
    levels: matrix.levels,
    initiator: env.who.employee_code,
    subject: source.who.employee_code,
    amount: amountOf(kind, source),
    approvers: (l) =>
      l.approverMode === "EMPLOYEE_MANAGER" ? [live(manager)] : l.approverIds.map((id) => byId.get(id)),
  });
}
const advancePatch = (route, from, acted) => {
  const next = nextActionable(route, from + 1, acted.map((a) => a.code));
  if (!next) fail("The approval route has no level left to act", 409);
  return { level: next.index, pendingCodes: next.codes };
};
const verifyComment = (tx, env, source, row, extra = {}) =>
  tx.attendanceRuleAudit.create({
    data: {
      tenantId: env.tenantId,
      employeeId: source.row.employeeId,
      anomalyId: source.row.id,
      action: "COMMENT",
      actorId: env.who.employee_code,
      data: {
        kind: "HR",
        comment: extra.comment,
        factHash: source.row.factHash,
        approvalRef: row.id,
        round: row.round,
        ...(extra.verifiedOnBehalf ? { verifiedOnBehalf: true } : {}),
      },
    },
  });
// Levels the initiator satisfies by raising the request (HR raising payroll or an attendance case).
async function settleAutoLevels(tx, env, row, source, reason) {
  let current = row;
  while (current.route.levels[current.level]?.auto) {
    const level = current.route.levels[current.level];
    const acted = [...current.route.acted, { level: current.level, code: env.who.employee_code }];
    const verify = level.action === "VERIFY";
    const updated = await tx.hrApprovalRequest.update({
      where: { id: current.id },
      data: {
        ...advancePatch(current.route, current.level, acted),
        route: { ...current.route, acted },
        ...(verify
          ? { verification: reason, hrActorCode: env.who.employee_code }
          : { recommendation: "RECOMMEND_APPROVAL", managerActorCode: env.who.employee_code, managerCode: env.who.employee_code }),
        version: { increment: 1 },
      },
    });
    if (verify && current.kind === "ATTENDANCE")
      await verifyComment(tx, env, source, current, {
        comment: reason,
        verifiedOnBehalf: source.who.employee_code !== env.who.employee_code,
      });
    await audit(tx, env, current, updated, verify ? "VERIFY" : "RECOMMEND_APPROVAL", reason);
    current = updated;
  }
  return current;
}
async function levelTransition(tx, env, row, source, input) {
  const route = row.route;
  const level = route.levels[row.level];
  const me = env.who.employee_code;
  if (input.action === "REVERT") {
    const previous = previousActionable(route, row.level);
    if (previous === null) {
      await onReturn(tx, row.kind, source, "INITIATOR");
      return {
        stage: "INITIATOR", level: null, pendingCodes: [], recommendation: null, verification: null,
        managerActorCode: null, hrActorCode: null, route: { ...route, acted: [] },
      };
    }
    const acted = route.acted.filter((a) => a.level < previous);
    return {
      level: previous,
      pendingCodes: route.levels[previous].approverCodes.filter((c) => !acted.some((a) => a.code === c)),
      route: { ...route, acted },
      verification: null,
      hrActorCode: null,
    };
  }
  if (source.digest !== row.sourceHash)
    fail("The request or evidence changed. Revert to the initiator for a fresh review.");
  if (level.viaManager) {
    const manager = source.who.managerId
      ? await tx.employee.findFirst({ where: { tenant_id: env.tenantId, id: source.who.managerId } })
      : null;
    if (manager?.employee_code !== level.approverCodes[0])
      fail("The line manager changed. Revert to the initiator for a fresh recommendation.");
  }
  const acted = [...route.acted, { level: row.level, code: me }];
  const base = { route: { ...route, acted } };
  if (input.action.startsWith("RECOMMEND_"))
    return { ...base, ...advancePatch(route, row.level, acted), recommendation: input.action, managerActorCode: me, managerCode: me };
  if (input.action === "VERIFY") {
    if (row.kind === "ATTENDANCE") await verifyComment(tx, env, source, row, { comment: input.reason });
    return { ...base, ...advancePatch(route, row.level, acted), verification: input.reason, hrActorCode: me };
  }
  return { ...base, stage: input.action === "APPROVE" ? "APPROVED" : "REJECTED", pendingCodes: [] };
}
async function actionsFor(tx, env, row) {
  if (isAppraisalApproval(row)) return appraisalApprovalActions(tx, env, row);
  if (["APPROVED", "REJECTED", "WITHDRAWN"].includes(row.stage)) return [];
  const subject = await employee(tx, env.tenantId, row.employeeCode),
    self = ownsCode(env, row.employeeCode);
  // A verification level may allow the employee to verify their own request (matrix `allowSelf`).
  if (self && row.stage === "LEVEL" && row.route?.levels?.[row.level]?.allowSelf)
    return levelActionsFor(env, row);
  if (self)
    return permits(env, "self")
      ? [
          ...(row.stage === "INITIATOR" ? ["SUBMIT"] : []),
          ...(["LEAVE", "OVERTIME", "CLAIM", "SHIFT_SWAP"].includes(row.kind)
            ? ["WITHDRAW"]
            : []),
        ]
      : [];
  if (row.stage === "LEVEL") return levelActionsFor(env, row);
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
  if (row.stage === "LEVEL" && env.identityCodes.some((c) => row.pendingCodes.includes(c)))
    return true;
  const subject = await employee(tx, env.tenantId, row.employeeCode);
  return permits(env, "manager") && subject.managerId === env.who.id;
}
async function view(tx, env, row, summary = false, people = null) {
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
  const who =
    people ??
    (await identitiesByCode(tx, env.tenantId, [
      row.employeeCode,
      row.managerCode,
      ...history.map((h) => h.actorCode),
    ]));
  return {
    approvalRef: row.id,
    kind: row.kind,
    sourceRef: row.sourceRef,
    employeeCode: row.employeeCode,
    employee: who.get(row.employeeCode) ?? { code: row.employeeCode, name: row.employeeCode },
    stage: row.stage,
    level: row.level,
    route: routeView(row),
    pendingCodes: row.stage === "LEVEL" ? row.pendingCodes : [],
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
        actor: who.get(actorCode) ?? { code: actorCode, name: actorCode },
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
      fromStage: stageLabel(before),
      toStage: stageLabel(after),
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
// The shared submission body. `submitApproval` is the employee initiator's own
// door (owner-only); `submitApprovalOnBehalf` is the HR door used by specialist
// services that file a request FOR an employee.
async function submitWithin(tx, env, input, { onBehalf = false, prepare } = {}) {
  if (onBehalf) {
    // TS-ONBEHALF-01 — HR filing on an employee's behalf. The specialist
    // service has already asserted that the caller may act for this employee;
    // here we re-assert the grant the HR stage itself requires, so no role
    // weaker than the verifier can open a request in someone else's name.
    if (!permits(env, "verify"))
      fail("Only HR may submit a request on an employee's behalf", 403);
  } else if (!permits(env, "self") || !ownsCode(env, input.employeeCode)) {
    fail("Only the employee initiator can submit", 403);
  }
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
    if (onBehalf) {
      // The owner always comes from the source, never from the caller: an
      // on-behalf submission cannot attach a request to a third employee.
      if (source.who.employee_code !== input.employeeCode)
        fail("The request belongs to another employee", 403);
    } else if (!ownsCode(env, source.who.employee_code)) {
      fail("Only the employee initiator can submit", 403);
    }
    // A paused manager stage needs no manager configured — the request enters
    // the HR verification stage instead (see lib/approvalStagePolicy.js).
    const matrix = MATRIX_KINDS.includes(input.kind)
      ? await loadPublishedMatrix(tx, env.tenantId, input.kind)
      : null;
    const needsManager = !matrix && requiresLineManager(input.kind);
    const manager = needsManager
      ? await tx.employee.findFirst({
          where: { tenant_id: env.tenantId, id: source.who.managerId ?? -1 },
        })
      : null;
    const noUsableManager =
      needsManager &&
      (!manager?.employee_code ||
        manager.id === env.who.id ||
        /inactive|terminated|exited|separated/i.test(
          `${manager.status} ${manager.employement_status}`,
        ));
    // Leave, overtime, claims and loans go to HR when there is no usable manager; other kinds still need one.
    const sentToHr = noUsableManager && skipsManagerWhenNone(input.kind);
    if (noUsableManager && !sentToHr)
      fail("Configure an active independent line manager before submission");
    await onSubmit(tx, env, input.kind, source);
    const route = matrix ? await sealRoute(tx, env, input.kind, matrix, source) : null;
    const data = {
      // The canonical owner code of the source, not the caller's: identical for
      // a self submission, the employee's for an on-behalf one.
      employeeCode: source.who.employee_code,
      stage: route ? "LEVEL" : sentToHr ? "HR" : stageAfterSubmission(input.kind),
      route: route ?? Prisma.DbNull,
      level: route ? route.levels.findIndex((l) => l.engaged) : null,
      pendingCodes: route ? route.levels.find((l) => l.engaged).approverCodes : [],
      managerCode: sentToHr ? null : (manager?.employee_code ?? null),
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
      sentToHr
        ? `${input.reason ?? ""} [No active line manager: sent to HR for verification]`.trim()
        : input.reason,
    );
    // HR raising on behalf has reviewed the day: the filing IS the HR
    // verification (lib/approvalStagePolicy.js). The trail keeps both steps —
    // SUBMIT into HR, then VERIFY by the same filer into MANAGEMENT — so the
    // auto-verification is visible rather than implied.
    let current = next;
    if (route) current = await settleAutoLevels(tx, env, next, source, input.reason);
    else if (onBehalf && isVerifiedOnBehalf(input.kind) && next.stage === "HR") {
      current = await tx.hrApprovalRequest.update({
        where: { id: next.id },
        data: {
          stage: "MANAGEMENT",
          verification: input.reason,
          hrActorCode: env.who.employee_code,
          version: { increment: 1 },
        },
      });
      if (input.kind === "ATTENDANCE")
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
              approvalRef: next.id,
              round: next.round,
              verifiedOnBehalf: true,
            },
          },
        });
      await audit(tx, env, next, current, "VERIFY", input.reason);
    }
    return {
      actorCode: env.who.employee_code,
      record: await view(tx, env, current),
    };
}

export function submitApproval(raw, { prepare } = {}) {
  const input = ApprovalSubmit.parse(raw);
  return execute(input, "SUBMIT", (tx, env) => submitWithin(tx, env, input, { prepare }));
}

// TS-ONBEHALF-01 — HR submits a request FOR an employee.
//
// `hr_approval_submit` is the employee initiator's door and stays owner-only.
// This second door exists for the specialist services where HR acts for an
// employee (the attendance anomaly resolution request is the first caller).
// The CALLER MUST HAVE ALREADY ASSERTED ITS OWN PERMISSION — the attendance
// rules service requires the HR role and an in-scope employee before it gets
// here — because this function re-asserts only the approval-centre grant.
//
// The request's owner is the SUBJECT employee (input.employeeCode, checked
// against the source), while HrApprovalAudit.actorCode records the FILER, so
// the trail always distinguishes a self-filed request from an on-behalf one.
export function submitApprovalOnBehalf(raw) {
  const input = ApprovalSubmit.parse(raw);
  return execute(input, "SUBMIT", (tx, env) =>
    submitWithin(tx, env, input, { onBehalf: true }),
  );
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
    } else if (row.stage === "LEVEL") {
      Object.assign(data, await levelTransition(tx, env, row, source, input));
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
        ...(["manager", "verify", "approve"].some((k) => permits(env, k))
          ? [
              {
                stage: "LEVEL",
                employeeCode: { notIn: env.identityCodes },
                pendingCodes: { hasSome: env.identityCodes },
              },
            ]
          : []),
        // `notIn` never matches a NULL column in SQL. A request with no line-manager step (no manager, or a paused level) has
        // managerActorCode NULL, so Management never saw it (issue 137: six production requests are stuck this way). NULL is
        // "nobody acted", which is not the approver, so it must match.
        ...(permits(env, "approve")
          ? [
              {
                stage: "MANAGEMENT",
                employeeCode: { notIn: env.identityCodes },
                AND: [
                  { OR: [{ managerActorCode: null }, { managerActorCode: { notIn: env.identityCodes } }] },
                  { OR: [{ hrActorCode: null }, { hrActorCode: { notIn: env.identityCodes } }] },
                ],
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
    const people = await identitiesByCode(tx, env.tenantId, page.map((r) => r.employeeCode));
    for (const row of page) items.push(await view(tx, env, row, true, people));
    const candidates =
      input.scope === "MINE" && permits(env, "self")
        ? await sourceCandidates(tx, env, input.kind)
        : [];
    const owners = await identitiesByCode(tx, env.tenantId, candidates.map((c) => c.employeeCode));
    return {
      actorCode: env.who.employee_code,
      items,
      candidates: candidates.map((c) => ({ ...c, employee: owners.get(c.employeeCode) ?? null })),
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
