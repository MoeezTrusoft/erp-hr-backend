import { encryptString } from "../../lib/crypto.js";
import { enqueueHrDomainEvent } from "../hrDomainEvent.service.js";
import { fail, has, digest, independent } from "./base.js";

export const isAppraisalApproval = (row) =>
  row?.kind === "PERFORMANCE" && row.sourceRef?.startsWith("perf:");
export const appraisalApprovalPermission = (row) =>
  row.sourceRef.startsWith("perf:SENIOR:")
    ? "hr.performance.approve"
    : "hr.performance.release";

export async function approvalBinding(tx, env, row) {
  const binding = await tx.perfApprovalBinding.findFirst({
    where: { tenantId: env.tenantId, approvalRef: row.id },
  });
  if (!binding) fail("NOT_FOUND", "Appraisal approval not found", 404);
  const review = await tx.perfReview.findFirst({
    where: { tenantId: env.tenantId, id: binding.reviewId },
  });
  if (!review) fail("NOT_FOUND", "Appraisal not found", 404);
  return { binding, review };
}

export async function canReadAppraisalApproval(tx, env, row) {
  const { review } = await approvalBinding(tx, env, row);
  // Approval Centre must never become a second route to employee-visible drafts.
  if (review.employeeId === env.who.id) return !!review.releasedRevisionId;
  const employee = await tx.employee.findFirst({
    where: { tenant_id: env.tenantId, id: review.employeeId },
    select: { managerId: true },
  });
  return (
    (review.managerId === env.who.id && employee?.managerId === env.who.id) ||
    has(env, "hr.performance.read.all")
  );
}

export async function appraisalApprovalSource(tx, env, row) {
  const { binding, review } = await approvalBinding(tx, env, row);
  const source = {
    purpose: binding.purpose,
    reviewId: review.id,
    reviewVersion: binding.reviewVersion,
    revisionId: binding.revisionId,
  };
  if (
    review.employeeId === env.who.id &&
    binding.revisionId !== review.releasedRevisionId
  )
    return source;
  const revision = await tx.perfReviewRevision.findFirst({
    where: {
      tenantId: env.tenantId,
      reviewId: review.id,
      id: binding.revisionId,
    },
  });
  return {
    ...source,
    revisionDigest: revision.digest,
    score: revision.score,
    rubric: revision.content.rubric,
    selfResponse: revision.content.selfResponse,
    managerResponse: revision.content.managerResponse,
    evidence: revision.content.evidence,
    calibration: revision.content.calibration ?? null,
  };
}

export async function appraisalApprovalActions(tx, env, row) {
  if (
    row.stage !== "MANAGEMENT" ||
    !has(env, appraisalApprovalPermission(row)) ||
    !has(env, "hr.performance.response.write")
  )
    return [];
  const { binding, review } = await approvalBinding(tx, env, row);
  if (
    !has(env, "hr.performance.read.all") ||
    [review.employeeId, review.managerId].includes(env.who.id) ||
    review.currentRevisionId !== binding.revisionId ||
    review.version !== binding.reviewVersion
  )
    return [];
  if (binding.purpose === "RELEASE") {
    const maker = await tx.perfSignoff.findFirst({
      where: {
        tenantId: env.tenantId,
        reviewId: review.id,
        actorId: env.who.id,
        action: "PROPOSE_CALIBRATION",
      },
    });
    return review.state === "CALIBRATED" && !maker ? ["APPROVE"] : [];
  }
  return review.state === "APPROVAL_PENDING" ? ["APPROVE", "REVERT"] : [];
}

async function record(tx, env, before, after, action, reason) {
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
      reason: reason || "Appraisal workflow",
      sourceHash: after.sourceHash,
    },
  });
  const queued = await enqueueHrDomainEvent(tx, {
    tenantId: env.tenantId,
    actorId: env.ctx.user.userId,
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
  if (!queued)
    fail("OUTBOX_UNAVAILABLE", "Approval event storage unavailable", 503);
}

export async function openReviewApproval(tx, env, review, purpose) {
  const revision = await tx.perfReviewRevision.findFirst({
    where: {
      tenantId: env.tenantId,
      reviewId: review.id,
      id: review.currentRevisionId,
    },
  });
  const employee = await tx.employee.findFirst({
    where: {
      tenant_id: env.tenantId,
      id: review.employeeId,
    },
  });
  const manager = await tx.employee.findFirst({
    where: {
      tenant_id: env.tenantId,
      id: review.managerId,
    },
  });
  if (!revision || !employee?.employee_code || !manager?.employee_code)
    fail(
      "APPROVAL_IDENTITY_REQUIRED",
      "Verified appraisal identities and revision required",
      409,
    );
  const source = {
    purpose,
    reviewId: review.id,
    revisionId: revision.id,
    reviewVersion: review.version,
    revisionDigest: revision.digest,
  };
  const request = await tx.hrApprovalRequest.create({
    data: {
      tenantId: env.tenantId,
      kind: "PERFORMANCE",
      sourceRef: `perf:${purpose}:${review.id}:${revision.id}:${review.version}`,
      employeeCode: employee.employee_code,
      managerCode: manager.employee_code,
      managerActorCode: manager.employee_code,
      stage: "MANAGEMENT",
      version: 1,
      round: 1,
      recommendation: "RECOMMEND_APPROVAL",
      sourceHash: digest(source),
      snapshot: { sealed: encryptString(JSON.stringify(source)) },
    },
  });
  await tx.perfApprovalBinding.create({
    data: {
      tenantId: env.tenantId,
      approvalRef: request.id,
      reviewId: review.id,
      revisionId: revision.id,
      reviewVersion: review.version,
      purpose,
    },
  });
  await record(
    tx,
    env,
    { stage: "INITIATOR" },
    request,
    "SUBMIT",
    `Appraisal ${purpose.toLowerCase()} approval`,
  );
  return request.id;
}

export async function completeReviewApproval(tx, env, review, purpose, input) {
  const binding = await tx.perfApprovalBinding.findFirst({
    where: {
      tenantId: env.tenantId,
      reviewId: review.id,
      revisionId: review.currentRevisionId,
      reviewVersion: review.version,
      purpose,
    },
  });
  if (!binding)
    fail(
      "APPROVAL_REQUIRED",
      "An Approval Centre request for this exact revision is required",
      409,
    );
  await tx.$queryRaw`SELECT id FROM "HrApprovalRequest" WHERE "tenantId"=${env.tenantId}::uuid AND id=${binding.approvalRef}::uuid FOR UPDATE`;
  const request = await tx.hrApprovalRequest.findFirst({
    where: {
      tenantId: env.tenantId,
      id: binding.approvalRef,
    },
  });
  const action = input.action === "RETURN" ? "REVERT" : "APPROVE";
  if (
    !request ||
    !(await appraisalApprovalActions(tx, env, request)).includes(action)
  )
    fail(
      "APPROVAL_REQUIRED",
      "Approval authority or the reviewed source changed",
      409,
    );
  independent(env, review);
  const revision = await tx.perfReviewRevision.findFirst({
    where: {
      tenantId: env.tenantId,
      id: binding.revisionId,
    },
  });
  const source = {
    purpose,
    reviewId: review.id,
    revisionId: revision.id,
    reviewVersion: review.version,
    revisionDigest: revision.digest,
  };
  if (request.sourceHash !== digest(source))
    fail(
      "REVISION_CHANGED",
      "Approval source no longer matches the frozen revision",
      409,
    );
  const next = await tx.hrApprovalRequest.update({
    where: { id: request.id },
    data: {
      stage: action === "APPROVE" ? "APPROVED" : "WITHDRAWN",
      execution: "APPLIED",
      verification: input.reason || "Approved exact appraisal revision",
      hrActorCode: env.who.employee_code,
      version: { increment: 1 },
    },
  });
  await record(tx, env, request, next, action, input.reason);
  return next;
}

export async function actAppraisalApproval(
  tx,
  env,
  request,
  input,
  transition,
) {
  if (!(await canReadAppraisalApproval(tx, env, request)))
    fail("NOT_FOUND", "Request not found", 404);
  if (request.version !== input.expectedVersion)
    fail("VERSION_CONFLICT", "Approval request changed", 412);
  if (
    !(await appraisalApprovalActions(tx, env, request)).includes(input.action)
  )
    fail(
      "FORBIDDEN",
      "Action is not available for this appraisal approval",
      403,
    );
  const { binding } = await approvalBinding(tx, env, request);
  env.config = await tx.perfConfiguration.findUnique({
    where: { tenantId: env.tenantId },
  });
  if (!env.config?.coreEnabled)
    fail("FEATURE_DISABLED", "Appraisals are disabled", 409);
  await transition(tx, env, {
    id: binding.reviewId,
    expectedVersion: binding.reviewVersion,
    requestKey: input.requestKey,
    reason: input.reason,
    action:
      input.action === "REVERT"
        ? "RETURN"
        : binding.purpose === "SENIOR"
          ? "APPROVE_SENIOR"
          : "RELEASE",
  });
  return tx.hrApprovalRequest.findFirst({
    where: { tenantId: env.tenantId, id: request.id },
  });
}
