import { requireRecruitmentActor } from "./recruitmentActor.service.js";
import {
  maskCandidateForScope,
  maskOfferForScope,
  maskInterviewForScope,
  interviewScopeWhere,
} from "../lib/recruitmentAccess.js";
import { snapshotApplicationQuestions } from "../lib/applicationQuestionSnapshot.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { applicationCreatedEvent } from "./hrEvents.js";
import { assertCommunicationsAllowed } from "./candidatePrivacy.service.js";
// src/services/applicationService.js
import prisma from "../config/prisma.js";
import { logAction } from "../utils/logs.js";
import { transitionApplicationStage } from "./applicationWorkflow.service.js";
import { applicationScopeWhere } from "../lib/recruitmentAccess.js";
import {
  evaluateRequisitionEligibility,
  closedApplicationMessage,
} from "../lib/requisitionEligibility.js";
import { tenantTransaction } from "../lib/rlsTenant.js";

// Phase 1.4 (remainder) — application reads/writes are TENANT-scoped and, when a
// caller passes a scope, ROW-scoped. The MCP tools used to reach prisma directly
// with `findUnique({ where: { id } })` / `delete({ where: { id } })`, which has no
// tenant predicate at all: a valid `hr:recruitment` grant was enough to read ANY
// tenant's application (with candidate PII, interviews and the offer) or delete
// it. Both now go through here so REST and MCP share one gate.
const maskApplication = (row, scope) =>
  row
    ? {
        ...row,
        candidate: maskCandidateForScope(row.candidate, scope),
        ...(row.offer
          ? {
              offer:
                scope.level === "ASSIGNED"
                  ? null
                  : maskOfferForScope(row.offer, scope),
            }
          : {}),
        ...(row.interviews
          ? {
              interviews: row.interviews.map((i) =>
                maskInterviewForScope(i, scope),
              ),
            }
          : {}),
      }
    : row;
const APPLICATION_INCLUDE = {
  candidate: true,
  jobRequisition: true,
  interviews: true,
  offer: true,
};

/**
 * Read one application, tenant-scoped and row-scoped.
 *
 * An out-of-scope or cross-tenant id returns null, which callers surface as
 * not-found — never as forbidden, since a 403 on a guessed id confirms the row
 * exists.
 */
export const getApplication = async ({ id, tenantId, scope = null }) => {
  scope = (
    await requireRecruitmentActor({
      tenantId,
      allowedScopes: ["ORG", "MANAGED", "ASSIGNED"],
    })
  ).scope;
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) return null;
  const row = await prisma.application.findFirst({
    where: {
      id: numericId,
      tenantId: tenantId ?? null,
      ...(scope ? applicationScopeWhere(scope) : {}),
    },
    include: {
      ...APPLICATION_INCLUDE,
      interviews: { where: { tenantId, ...interviewScopeWhere(scope) } },
    },
  });
  return maskApplication(row, scope);
};

/**
 * Delete one application, tenant-scoped and row-scoped.
 * Returns the deleted id, or null when the row is not the caller's to delete.
 */
export const deleteApplication = async ({ id, tenantId, scope = null }) => {
  scope = (
    await requireRecruitmentActor({
      tenantId,
      permission: "hr.recruitment.delete",
      allowedScopes: ["ORG"],
    })
  ).scope;
  const existing = await prisma.application.findFirst({
    where: {
      id: Number(id),
      tenantId: tenantId ?? null,
      ...(scope ? applicationScopeWhere(scope) : {}),
    },
    select: { id: true },
  });
  if (!existing) return null;
  await prisma.application.delete({ where: { id: existing.id } });
  return existing.id;
};
/**
 * Create an application: candidate → jobRequisition
 *
 * Phase 4 / §2.9 — gated by the requisition's APPLICATION ELIGIBILITY: an
 * application is refused unless a channel is live, the requisition is in an
 * accepting state, and the closing date has not passed. The eligibility read
 * happens INSIDE the write transaction, so a withdrawal or auto-close that lands
 * between the check and the insert still wins — the gate re-runs against the
 * same snapshot the insert commits on, rather than against a stale pre-read.
 */
export const createApplication = async ({
  candidateId,
  jobRequisitionId,
  stage = "applied",
  status = "open",
  tenantId,
  createdById,
}) => {
  const verified = await requireRecruitmentActor({
    tenantId,
    permission: "hr.recruitment.create",
    allowedScopes: ["ORG"],
  });
  createdById = verified.who.id;
  candidateId = Number(candidateId);
  jobRequisitionId = Number(jobRequisitionId);
  if (
    !Number.isSafeInteger(candidateId) ||
    candidateId <= 0 ||
    !Number.isSafeInteger(jobRequisitionId) ||
    jobRequisitionId <= 0
  )
    throw Object.assign(new Error("Choose a candidate and requisition"), {
      status: 400,
      code: "HR-5301",
    });
  if (String(stage).toLowerCase() !== "applied") {
    throw Object.assign(
      new Error("New applications must start in the applied stage"),
      { status: 409, code: "HR-RECRUITMENT-INITIAL-STAGE" },
    );
  }
  if (tenantId === undefined || tenantId === null || tenantId === "") {
    throw Object.assign(new Error("Tenant context is required"), {
      status: 400,
      code: "HR-TENANT-REQUIRED",
    });
  }

  if (String(status).toLowerCase() !== "open")
    throw Object.assign(new Error("New applications must start open"), {
      status: 409,
      code: "HR-5301",
    });
  stage = "applied";
  status = "open";
  return tenantTransaction(prisma, async (tx) => {
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      tenantId + ":" + candidateId + ":" + jobRequisitionId,
    );
    // Serialize intake with consent changes and erasure before writing child rows.
    await tx.$queryRawUnsafe(
      'SELECT id FROM "Candidate" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
      candidateId,
      tenantId,
    );
    const existing = await tx.application.findFirst({
      where: {
        tenantId,
        candidateId: Number(candidateId),
        jobRequisitionId: Number(jobRequisitionId),
      },
      include: { candidate: true, jobRequisition: true },
    });
    if (existing) return existing;
    await tx.$queryRawUnsafe(
      'SELECT id FROM "JobRequisition" WHERE id=$1 AND "tenantId"=$2::uuid FOR SHARE',
      Number(jobRequisitionId),
      tenantId,
    );
    const requisition = await tx.jobRequisition.findFirst({
      where: { id: Number(jobRequisitionId), tenantId: tenantId ?? null },
      include: { postings: { where: { isActive: true } } },
    });
    if (!requisition) {
      throw Object.assign(
        new Error(`Job requisition "${jobRequisitionId}" not found`),
        {
          status: 404,
          code: "HR-RECRUITMENT-REQUISITION-NOT-FOUND",
        },
      );
    }

    // §2.9 — the eligibility gate. Refused with the structured reason list so
    // the caller can show "applications closed 2026-09-01" instead of a bare
    // conflict, and with the §2.9a copy contract attached.
    const evaluation = evaluateRequisitionEligibility(requisition, {
      postings: requisition.postings,
    });
    if (!evaluation.eligible) {
      throw Object.assign(
        new Error(
          `This requisition is not accepting applications: ${evaluation.reasons.join(", ")}`,
        ),
        {
          status: 409,
          code: "HR-RECRUITMENT-APPLICATIONS-CLOSED",
          details: {
            reasons: evaluation.reasons,
            candidateMessage: closedApplicationMessage(requisition, evaluation),
          },
        },
      );
    }

    const candidate = await tx.candidate.findFirst({
      where: { id: Number(candidateId), tenantId, anonymizedAt: null },
    });
    if (!candidate)
      throw Object.assign(new Error("Candidate not found"), { status: 404 });
    await assertCommunicationsAllowed(
      {
        tenantId,
        candidateId: candidate.id,
        purpose: "PROCESSING",
        requireExplicitConsent: true,
      },
      { db: tx },
    );
    const questions = await tx.applicationQuestion.findMany({
      where: {
        tenantId,
        requisitionId: Number(jobRequisitionId),
        isActive: true,
      },
      orderBy: [{ orderIndex: "asc" }, { id: "asc" }],
    });
    const create = await tx.application.create({
      data: {
        // candidateId / jobRequisitionId are NOT-NULL Int FKs — coerce (arrive as
        // numeric strings from the MCP boundary) to align with sibling services.
        questionSnapshot: snapshotApplicationQuestions(questions),
        candidateId: Number(candidateId),
        jobRequisitionId: Number(jobRequisitionId),
        stage,
        status,
        tenantId: tenantId ?? null,
        // Guard against NaN: Number(undefined) ?? null === NaN. Only write a
        // finite creator id, else null (createdById is nullable).
        createdById: Number.isFinite(Number(createdById))
          ? Number(createdById)
          : null,
      },
      include: {
        candidate: true,
        jobRequisition: true,
      },
    });
    await tx.applicationStageHistory.create({
      data: {
        applicationId: create.id,
        tenantId,
        fromStage: "applied",
        toStage: "applied",
        reason: "initial application",
        actorId: Number.isFinite(Number(createdById))
          ? Number(createdById)
          : null,
        source: "application",
      },
    });
    await enqueueHrDomainEvent(
      tx,
      applicationCreatedEvent(create, { actorId: createdById }),
    );
    await logAction({
      employeeId: createdById ?? null,
      type: "CREATE",
      module: "Application",
      result: "SUCCESS",
      notes: `Application "${create.id}" created successfully for candidate "${candidateId}" on job "${jobRequisitionId}".`,
      tenantId: typeof tenantId !== "undefined" ? tenantId : null,
    });

    return create;
  });
};

/**
 * Update stage of an application
 */
export const updateApplicationStage = async ({
  id,
  tenantId,
  stage,
  reason,
  updatedById,
  expectedVersion,
  scope,
}) => {
  const verified = await requireRecruitmentActor({
    tenantId,
    permission: "hr.recruitment.update",
    allowedScopes: ["ORG"],
  });
  scope = verified.scope;
  updatedById = verified.who.id;
  return transitionApplicationStage({
    id,
    tenantId,
    targetStage: stage,
    expectedVersion,
    scope,
    reason,
    actorId: updatedById,
    source: "rest",
  });
};

/**
 * Update status (open/closed/hired/rejected)
 */
export const updateApplicationStatus = async ({
  id,
  tenantId,
  status,
  reason,
  updatedById,
  expectedVersion,
  scope,
}) => {
  const verified = await requireRecruitmentActor({
    tenantId,
    permission: "hr.recruitment.update",
    allowedScopes: ["ORG"],
  });
  scope = verified.scope;
  updatedById = verified.who.id;
  const normalized = String(status || "")
    .trim()
    .toLowerCase();
  if (!["hired", "rejected", "closed"].includes(normalized)) {
    throw Object.assign(
      new Error(
        "Use a pipeline stage transition to reopen or advance an application",
      ),
      { status: 409, code: "HR-5301" },
    );
  }
  return transitionApplicationStage({
    id,
    tenantId,
    targetStage: normalized === "closed" ? "withdrawn" : normalized,
    reason,
    actorId: updatedById,
    expectedVersion,
    scope,
    source: "rest-status",
  });
};

/**
 * List applications with filters
 */
export const listApplications = async ({
  tenantId,
  jobRequisitionId,
  candidateId,
  stage,
  status,
  page = 1,
  limit = 20,
  scope = null,
}) => {
  scope = (
    await requireRecruitmentActor({
      tenantId,
      allowedScopes: ["ORG", "MANAGED", "ASSIGNED"],
    })
  ).scope;
  page = Math.max(1, Math.trunc(Number(page) || 1));
  limit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 20)));
  const skip = (page - 1) * limit;

  // `scope` is optional so internal callers keep the previous behaviour; when a
  // transport passes one (REST + MCP both do) the caller only sees the
  // applications their role reaches.
  const where = {
    tenantId: tenantId ?? null,
    ...(scope ? applicationScopeWhere(scope) : {}),
    ...(jobRequisitionId ? { jobRequisitionId } : {}),
    ...(candidateId ? { candidateId } : {}),
    ...(stage ? { stage } : {}),
    ...(status ? { status } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.application.findMany({
      where,
      include: {
        candidate: true,
        jobRequisition: true,
      },
      orderBy: { appliedAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.application.count({ where }),
  ]);

  // Resolve each application's requisition department (BusinessUnit) name so the
  // Create Offer form can auto-fill Department from the chosen candidate. There
  // is no JobRequisition→BusinessUnit relation, so batch-resolve by id.
  const departmentIds = [
    ...new Set(
      items
        .map((item) => item.jobRequisition?.departmentId)
        .filter((id) => id != null),
    ),
  ];
  if (departmentIds.length) {
    const units = await prisma.businessUnit.findMany({
      where: { id: { in: departmentIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(units.map((unit) => [unit.id, unit.name]));
    for (const item of items) {
      if (item.jobRequisition?.departmentId != null) {
        item.jobRequisition.departmentName =
          nameById.get(item.jobRequisition.departmentId) ?? null;
      }
    }
  }

  return {
    items: items.map((row) => maskApplication(row, scope)),
    total,
    page,
    limit,
  };
};
