// src/services/applicationWorkflow.service.js
//
// Canonical Recruitment application workflow. REST, MCP, interview scheduling,
// and future workers must use this service instead of writing Application.stage
// directly. The optional `db` argument lets callers compose the transition into
// an existing transaction (for example, interview creation).
import { normalizeExpectedVersion, preconditionFailedError } from "../lib/optimisticConcurrency.js";
import { applicationScopeWhere } from "../lib/recruitmentAccess.js";
import prisma from "../config/prisma.js";
import { logAction } from "../utils/logs.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { applicationStageChangedEvent } from "./hrEvents.js";
import { APPLICATION_ACCEPTING_STATUSES } from "../lib/requisitionEligibility.js";
import { recordTransitionFailure } from "../lib/recruitmentOpsMetrics.js";

export const APPLICATION_STAGES = Object.freeze([
  "applied",
  "screening",
  "interview",
  "offer",
  "hired",
  "rejected",
  "on_hold",
  "withdrawn",
]);

const ALLOWED_TRANSITIONS = Object.freeze({
  applied: new Set(["screening", "rejected", "on_hold", "withdrawn"]),
  screening: new Set(["interview", "rejected", "on_hold", "withdrawn"]),
  interview: new Set(["offer", "rejected", "on_hold", "withdrawn"]),
  offer: new Set(["hired", "rejected", "on_hold", "withdrawn"]),
  hired: new Set(),
  rejected: new Set(),
  on_hold: new Set(["screening", "interview", "rejected", "withdrawn"]),
  withdrawn: new Set(),
});

const normalizeStage = (stage) =>
  String(stage || "")
    .trim()
    .toLowerCase();

const workflowError = (message, code = "HR-RECRUITMENT-WORKFLOW") =>
  Object.assign(new Error(message), { status: 409, code });

const actorNumber = (actorId) => {
  const value = Number(actorId);
  return Number.isInteger(value) && value > 0 ? value : null;
};

const assertReason = (targetStage, reason) => {
  if (["rejected", "on_hold", "withdrawn"].includes(targetStage) && !String(reason || "").trim()) {
    recordTransitionFailure("REASON-REQUIRED");
    throw workflowError(
      `${targetStage} transitions require a reason`,
      "HR-RECRUITMENT-REASON-REQUIRED",
    );
  }
};

async function assertPrerequisites(db, application, targetStage) {
  if (
    application.agencySubmissionId &&
    ["screening", "interview", "offer", "hired"].includes(targetStage)
  ) {
    const submitted = await db.agencySubmission.findFirst({
      where: {
        tenantId: application.tenantId,
        id: application.agencySubmissionId,
        state: "ACCEPTED",
      },
    });
    if (!submitted)
      throw workflowError(
        "A recruiter must accept this agency submission before proceeding",
        "HR-5306",
      );
  }
  if (targetStage === "interview") {
    // Phase 6 / §4.1b — a recorded screening ADVANCE is required before the
    // interview stage. The scheduled-interview check below stays authoritative
    // for scheduling; this gate is for the STAGE move. Screening is the
    // recruiter's first-class decision (§4.1), not a side effect of booking a
    // calendar slot.
    const advance = await db.applicationScreening.findFirst({
      where: {
        applicationId: application.id,
        tenantId: application.tenantId ?? null,
        recordKind: "DECISION",
      },
      orderBy: [{ reviewedAt: "desc" }, { id: "desc" }],
      select: { id: true, outcome: true },
    });
    if (!advance || advance.outcome !== "ADVANCE") {
      recordTransitionFailure("SCREENING-ADVANCE-REQUIRED");
      throw workflowError(
        "A recorded screening with outcome ADVANCE is required before moving to interview stage",
        "HR-RECRUITMENT-SCREENING-ADVANCE-REQUIRED",
      );
    }

    // A scheduled interview is the authoritative prerequisite. The interview
    // creation path invokes this service in the same transaction after the
    // interview row exists.
    // A scheduled interview is the authoritative prerequisite. The interview
    // creation path invokes this service in the same transaction after the
    // interview row exists.
    const interview = await db.interview.findFirst({
      where: {
        applicationId: application.id,
        tenantId: application.tenantId ?? null,
        status: { not: "CANCELLED" },
      },
      select: { id: true },
    });
    if (!interview) {
      recordTransitionFailure("INTERVIEW-REQUIRED");
      throw workflowError(
        "An active interview is required before moving to interview stage",
        "HR-RECRUITMENT-INTERVIEW-REQUIRED",
      );
    }
  }

  if (targetStage === "offer") {
    const completedInterview = await db.interview.findFirst({
      where: {
        applicationId: application.id,
        tenantId: application.tenantId ?? null,
        status: "COMPLETED",
        decision: "NEXT_ROUND",
      },
      select: { id: true },
    });
    if (!completedInterview) {
      recordTransitionFailure("INTERVIEW-OUTCOME-REQUIRED");
      throw workflowError(
        "A completed interview with a NEXT_ROUND decision is required before an offer stage",
        "HR-RECRUITMENT-INTERVIEW-OUTCOME-REQUIRED",
      );
    }
  }

  if (targetStage === "hired") {
    const acceptedOffer = await db.offer.findFirst({
      where: {
        applicationId: application.id,
        tenantId: application.tenantId ?? null,
        status: "ACCEPTED",
      },
      select: { id: true },
    });
    if (!acceptedOffer) {
      recordTransitionFailure("ACCEPTED-OFFER-REQUIRED");
      throw workflowError(
        "An accepted offer is required before moving to hired stage",
        "HR-RECRUITMENT-ACCEPTED-OFFER-REQUIRED",
      );
    }

    // Phase 4 / §2.9 — the requisition must still be in an accepting state.
    // Closing or withdrawing a requisition is an operator decision that ends
    // the search; a hire already in flight MAY complete (an offer accepted the
    // day before the close should not be invalidated), so this is deliberately
    // a state check, not a full eligibility re-evaluation — a past closesAt or
    // a lapsed posting does not undo an accepted offer.
    const requisition = await db.jobRequisition.findFirst({
      where: {
        id: application.jobRequisitionId,
        tenantId: application.tenantId ?? null,
      },
      select: { id: true, status: true },
    });
    if (
      requisition &&
      !APPLICATION_ACCEPTING_STATUSES.includes(String(requisition.status).toUpperCase())
    ) {
      recordTransitionFailure("REQUISITION-NOT-ACCEPTING");
      throw workflowError(
        `The requisition is ${String(requisition.status).toLowerCase()} — a hire cannot be recorded against a closed or withdrawn search`,
        "HR-RECRUITMENT-REQUISITION-NOT-ACCEPTING",
      );
    }
  }
}

/**
 * Transition one tenant-scoped application, write immutable transition history,
 * and announce the change on the event fabric.
 *
 * Pass `db` when composing into a caller-owned transaction (interview scheduling,
 * offer creation). With no `db` the whole transition runs in ONE tenant
 * transaction, so the state change, its history row and the outbox event are
 * atomic — previously the REST/MCP path wrote them as separate statements, so a
 * mid-way failure could record a stage move with no history or announce one that
 * rolled back.
 */
export async function transitionApplicationStage(args = {}) {
  const { db, ...rest } = args;
  if (db) return transitionApplicationStageCore({ ...rest, db });
  return tenantTransaction(prisma, (tx) => transitionApplicationStageCore({ ...rest, db: tx }), {
    tenantId: rest.tenantId,
  });
}

/** The transition itself. Must be given a client (caller tx or the wrapper's). */
async function transitionApplicationStageCore({
  id,
  tenantId,
  targetStage,
  expectedVersion,
  scope,
  reason,
  actorId,
  source = "application",
  automaticReversalId,
  db = prisma,
} = {}) {
  if (tenantId === undefined || tenantId === null || tenantId === "") {
    // (tenant context is required on every path, including the wrapper's)
    throw Object.assign(new Error("Tenant context is required"), {
      status: 400,
      code: "HR-TENANT-REQUIRED",
    });
  }

  const normalizedTarget = normalizeStage(targetStage);
  if (!APPLICATION_STAGES.includes(normalizedTarget)) {
    recordTransitionFailure("STAGE-INVALID");
    throw workflowError(
      `Unsupported application stage: ${normalizedTarget}`,
      "HR-RECRUITMENT-STAGE-INVALID",
    );
  }

  await db.$queryRawUnsafe(
    'SELECT id FROM "Application" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
    Number(id),
    tenantId,
  );
  const application = await db.application.findFirst({
    where: {
      id: Number(id),
      tenantId,
      ...(scope ? applicationScopeWhere(scope) : {}),
    },
    include: { offer: { select: { id: true, status: true } } },
  });
  if (!application)
    throw Object.assign(new Error(`Application "${id}" not found`), {
      status: 404,
    });
  const expected = normalizeExpectedVersion(expectedVersion);
  if (expected != null && expected !== application.version)
    throw preconditionFailedError(application.version);
  if (application.stage === normalizedTarget) {
    return {
      success: true,
      changed: false,
      id: application.id,
      stage: application.stage,
    };
  }

  let automaticReversal = false;
  if (automaticReversalId != null) {
    const disposition = await db.applicationAutoDisposition.findFirst({
      where: {
        id: automaticReversalId,
        applicationId: application.id,
        tenantId,
      },
    });
    if (
      !actorNumber(actorId) ||
      !disposition ||
      disposition.reversedAt ||
      new Date() >= disposition.noticeDueAt ||
      application.stage !== "rejected" ||
      application.version !== disposition.rejectionVersion ||
      normalizedTarget !== disposition.previousStage
    ) {
      throw workflowError("The automatic rejection can no longer be reversed", "HR-5303");
    }
    automaticReversal = true;
    source = "automatic_rejection_reversal";
  }
  if (!automaticReversal && !ALLOWED_TRANSITIONS[application.stage]?.has(normalizedTarget)) {
    recordTransitionFailure("TRANSITION-INVALID");
    throw workflowError(
      `Invalid application transition: ${application.stage} → ${normalizedTarget}`,
      "HR-RECRUITMENT-TRANSITION-INVALID",
    );
  }

  assertReason(normalizedTarget, reason);
  await assertPrerequisites(db, application, normalizedTarget);

  const reasonText = String(reason || "").trim() || null;
  const updateData = {
    stage: normalizedTarget,
    status: ["hired", "rejected"].includes(normalizedTarget)
      ? normalizedTarget
      : normalizedTarget === "withdrawn"
        ? "closed"
        : "open",
    version: { increment: 1 },
    ...(automaticReversal ? { dispositionReason: null } : {}),
    ...(normalizedTarget === "rejected" ? { dispositionReason: reasonText } : {}),
    ...(normalizedTarget === "on_hold" ? { holdReason: reasonText } : {}),
    ...(normalizedTarget === "withdrawn" ? { withdrawnReason: reasonText } : {}),
  };

  const updated = await db.application.update({
    where: { id: application.id },
    data: updateData,
    include: { candidate: true, jobRequisition: true, offer: true },
  });

  await db.applicationStageHistory.create({
    data: {
      applicationId: application.id,
      tenantId,
      fromStage: application.stage,
      toStage: normalizedTarget,
      reason: reasonText,
      actorId: actorNumber(actorId),
      source,
    },
  });

  // Audit logging is best-effort in the legacy log subsystem; the immutable
  // applicationStageHistory row above is the authoritative workflow record.
  await logAction({
    employeeId: actorNumber(actorId),
    type: "UPDATE",
    module: "ApplicationStage",
    result: "SUCCESS",
    notes: `Application "${application.id}" moved from "${application.stage}" to "${normalizedTarget}".`,
    tenantId,
  });

  // Phase 11 — outbox-on-write. The event is enqueued on the SAME client as the
  // state change (the caller's tx when composed), so a rolled-back transition
  // never announces a move that did not happen. Ids-only: no candidate PII and
  // no compensation leave the service.
  await enqueueHrDomainEvent(
    db,
    applicationStageChangedEvent(
      updated,
      { actorId: actorNumber(actorId) },
      { fromStage: application.stage, toStage: normalizedTarget },
    ),
  );

  return { success: true, changed: true, data: updated };
}

export async function transitionApplicationStageInTransaction(args, tx) {
  return transitionApplicationStage({ ...args, db: tx });
}

export function canTransitionApplicationStage(fromStage, targetStage) {
  return Boolean(ALLOWED_TRANSITIONS[normalizeStage(fromStage)]?.has(normalizeStage(targetStage)));
}
