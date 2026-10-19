// src/services/recruitmentHandoff.service.js
//
// Phase 9 — accepted-offer → employee/onboarding handoff.
//
// One ACCEPTED offer must produce exactly ONE logical employee + onboarding
// checklist, no matter how many times acceptance is replayed. Two mechanisms
// enforce that:
//   1. `offer_handoffs.offerId` is UNIQUE, so the handoff row is the idempotency
//      key — a replay finds the completed row and returns it untouched.
//   2. The provisioning steps run in ONE tenant transaction, so a mid-way
//      failure rolls back rather than leaving a half-provisioned employee that a
//      retry would duplicate. The failure itself is persisted (status=FAILED +
//      an append-only attempt row) so it is visible and retryable.
//
// A pre-existing employee with the same tenant + email is ADOPTED instead of a
// second row being created — that keeps a stable business key for hires that HR
// already created by hand.
import prisma from "../config/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { scopedWhere, scopedData, scopedEmployeeWhere } from "../lib/tenancy.js";
import { recordHandoff } from "../lib/recruitmentOpsMetrics.js";
import { provisionHireCompensation } from "./payrollService.js";
import { materializeOnboardingTaskRows } from "../lib/onboardingDefaults.js";
import { resolveTasksForProvisioning } from "./onboardingTemplate.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { offerHandoffCompletedEvent, offerHandoffFailedEvent } from "./hrEvents.js";

export const HANDOFF_STATUS = Object.freeze({
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
});

const handoffError = (message, code = "HR-RECRUITMENT-HANDOFF") =>
  Object.assign(new Error(message), { status: 409, code });

const requireTenant = (tenantId) => {
  if (tenantId === undefined || tenantId === null || tenantId === "") {
    throw Object.assign(new Error("Tenant context is required"), { status: 400, code: "HR-TENANT-REQUIRED" });
  }
};

const employeeFullName = (candidate) =>
  [candidate?.firstName, candidate?.lastName].filter(Boolean).join(" ").trim() || null;

/** Tenant-scoped read of an offer's handoff (null when none has been started). */
export async function getOfferHandoff({ offerId, tenantId, db = prisma } = {}) {
  requireTenant(tenantId);
  return db.offerHandoff.findFirst({
    where: scopedWhere(tenantId, { offerId: Number(offerId) }),
    include: { attempts: { orderBy: { created_at: "desc" }, take: 20 } },
  });
}

/**
 * Phase 9 residue — the OPERATOR view of failed handoffs.
 *
 * A handoff failure is persisted (status=FAILED + an append-only attempt row),
 * but before now the only way to see one was to already know the offer id and
 * call `getOfferHandoff` — which means the failure was visible to nobody who
 * didn't already know about it. This is the fleet view: every non-completed
 * handoff in the tenant, FAILED first (oldest failure first — the one that has
 * been silently broken the longest sorts first), with the identifying offer /
 * candidate / requisition context an operator needs to act. Ids + status only:
 * `lastError` is on the per-offer detail read, not the fleet surface.
 */
export async function listFailedHandoffs({ tenantId, status = "FAILED", limit = 50 } = {}) {
  requireTenant(tenantId);
  const where = scopedWhere(tenantId, status ? { status } : {});
  const rows = await prisma.offerHandoff.findMany({
    where,
    orderBy: [{ updated_at: "asc" }],
    take: Math.min(Number(limit) || 50, 200),
    include: {
      offer: {
        select: {
          id: true,
          status: true,
          application: {
            select: {
              id: true,
              jobRequisition: { select: { id: true, title: true } },
              candidate: { select: { id: true, firstName: true, lastName: true } },
            },
          },
        },
      },
    },
  });
  return {
    items: rows.map((h) => ({
      handoffId: h.id,
      status: h.status,
      attemptCount: h.attemptCount,
      lastStep: h.lastStep,
      updatedAt: h.updated_at,
      offerId: h.offerId,
      offerStatus: h.offer?.status ?? null,
      requisitionId: h.offer?.application?.jobRequisition?.id ?? null,
      requisitionTitle: h.offer?.application?.jobRequisition?.title ?? null,
      candidateId: h.offer?.application?.candidate?.id ?? null,
      candidateName: [h.offer?.application?.candidate?.firstName, h.offer?.application?.candidate?.lastName]
        .filter(Boolean)
        .join(" ") || null,
    })),
    total: rows.length,
  };
}

async function recordAttempt(db, { handoffId, tenantId, step, status, error = null }) {
  await db.offerHandoffAttempt.create({
    data: { handoffId, tenantId, step, status, error },
  });
}

/**
 * Provision (or resume) the handoff for an ACCEPTED offer.
 *
 * Returns { handoff, replayed } — `replayed` is true when a previously completed
 * handoff was returned instead of provisioning again.
 */
export async function runOfferHandoff({ offerId, tenantId, actorId = null } = {}) {
  requireTenant(tenantId);
  const id = Number(offerId);
  if (!Number.isInteger(id) || id <= 0) throw handoffError("A valid offer id is required");

  const offer = await prisma.offer.findFirst({
    where: scopedWhere(tenantId, { id }),
    include: { application: { include: { candidate: true } } },
  });
  if (!offer) throw Object.assign(new Error("Offer not found"), { status: 404 });
  if (offer.status !== "ACCEPTED") {
    throw handoffError(`A handoff requires an ACCEPTED offer (current status: ${offer.status})`, "HR-RECRUITMENT-HANDOFF-OFFER-NOT-ACCEPTED");
  }
  const candidate = offer.application?.candidate;
  if (!candidate) throw handoffError("The accepted offer has no linked candidate to provision", "HR-RECRUITMENT-HANDOFF-NO-CANDIDATE");

  // Idempotency key: the unique offerId row. Created once, then reused.
  let handoff = await prisma.offerHandoff.findFirst({ where: scopedWhere(tenantId, { offerId: id }) });
  if (!handoff) {
    handoff = await prisma.offerHandoff.create({
      data: scopedData(tenantId, { offerId: id, status: HANDOFF_STATUS.IN_PROGRESS, attemptCount: 1 }),
    });
  } else {
    if (handoff.status === HANDOFF_STATUS.COMPLETED) {
      return { handoff, replayed: true };
    }
    handoff = await prisma.offerHandoff.update({
      where: { id: handoff.id },
      data: { status: HANDOFF_STATUS.IN_PROGRESS, attemptCount: { increment: 1 }, lastError: null },
    });
  }

  const salaryStr = String(offer.salary ?? "0");
  const hireDate = offer.startDate ? new Date(offer.startDate) : new Date();

  try {
    return await tenantTransaction(prisma, async (tx) => {
      // 1) Employee — adopt a same-tenant employee for this candidate's email, else create.
      // Employee carries the tenant under snake_case `tenant_id` → scopedEmployeeWhere.
      let employee = candidate.email
        ? await tx.employee.findFirst({
            where: scopedEmployeeWhere(tenantId, { email: candidate.email }),
            select: { id: true },
          })
        : null;

      if (!employee) {
        employee = await tx.employee.create({
          data: {
            tenant_id: tenantId,
            first_name: candidate.firstName,
            last_name: candidate.lastName || "",
            employee_name: employeeFullName(candidate),
            email: candidate.email || null,
            personal_contact: candidate.phone || null,
            hire_date: hireDate,
            employee_type: offer.employmentType || "FULL_TIME",
            employement_status: "active",
            status: "active",
            job_title: offer.notes || "New Hire",
            createdById: Number.isInteger(Number(actorId)) && Number(actorId) > 0 ? Number(actorId) : null,
          },
          select: { id: true },
        });
        await recordAttempt(tx, { handoffId: handoff.id, tenantId, step: "employee", status: "OK" });
      } else {
        await recordAttempt(tx, { handoffId: handoff.id, tenantId, step: "employee", status: "OK", error: "adopted existing employee by email" });
      }

      // 2) Compensation — PAYROLL-OWNED. Recruitment does not write payroll
      // tables itself; it hands the hire's numbers to payroll and lets payroll
      // decide which table carries the contractual base (N-15: terms, never a
      // duplicate BASE_SALARY assignment alongside them). Runs in THIS tx via
      // `{ db: tx }` so the provisioning stays atomic, and `audit: false` because
      // the handoff row + attempt trail below is the audit record for this step.
      const compensation = await provisionHireCompensation(
        {
          employeeId: employee.id,
          tenantId,
          baseSalary: salaryStr,
          currency: offer.currency || "USD",
          startDate: hireDate,
          actorId,
        },
        { db: tx, audit: false },
      );
      await recordAttempt(tx, {
        handoffId: handoff.id,
        tenantId,
        step: "employment_terms",
        status: "OK",
        error: compensation.created?.employmentTerms
          ? null
          : "reused existing employment terms",
      });
      await recordAttempt(tx, {
        handoffId: handoff.id,
        tenantId,
        step: "payroll_assignment",
        status: "OK",
        error: `base source: ${compensation.baseSource}`,
      });

      // 4) Onboarding checklist — one per employee, seeded so HR starts from a
      // real checklist, not an empty one. FR-13 residue: the task set is the
      // TENANT'S configured template when one is active+default, else the
      // documented baseline — resolved inside this transaction so the template
      // read and the checklist write cannot straddle a config change. Seeding
      // happens ONLY on creation, so the (idempotent) handoff cannot duplicate
      // tasks.
      let checklist = await tx.onboardingChecklist.findFirst({
        where: scopedWhere(tenantId, { employeeId: employee.id }),
        select: { id: true },
      });
      if (!checklist) {
        checklist = await tx.onboardingChecklist.create({
          data: scopedData(tenantId, {
            employeeId: employee.id,
            title: "Employee Onboarding",
            startDate: hireDate,
            currentStage: "pre_joining",
          }),
          select: { id: true },
        });
        const taskPlan = await resolveTasksForProvisioning(tx, tenantId);
        await tx.onboardingTask.createMany({
          data: materializeOnboardingTaskRows({
            tasks: taskPlan.tasks,
            checklistId: checklist.id,
            tenantId,
            startDate: hireDate,
          }),
        });
        await recordAttempt(tx, {
          handoffId: handoff.id,
          tenantId,
          step: "onboarding_checklist_source",
          status: "OK",
          error: taskPlan.source === "TEMPLATE" ? `template:${taskPlan.templateId}` : "baseline",
        });
      }
      await recordAttempt(tx, { handoffId: handoff.id, tenantId, step: "onboarding_checklist", status: "OK" });

      const completed = await tx.offerHandoff.update({
        where: { id: handoff.id },
        data: {
          status: HANDOFF_STATUS.COMPLETED,
          lastStep: "onboarding_checklist",
          lastError: null,
          employeeId: employee.id,
          checklistId: checklist.id,
          completedAt: new Date()
        },
      });

      // Outbox-on-write: completion is announced in the same tx as the state it
      // describes (ids-only; fail-closed on a missing tenant).
      await enqueueHrDomainEvent(tx, offerHandoffCompletedEvent(
        { ...completed, tenantId },
        { actorId: actorId ?? null },
      ));

      recordHandoff(completed.status === HANDOFF_STATUS.COMPLETED ? "enqueued" : "other");
      return { handoff: completed, replayed: false };
    }, { tenantId });
  } catch (error) {
    // Rolled back — nothing partial survived. Persist the failure so an operator
    // can see and retry it (the unique offerId row keeps retries idempotent).
    recordHandoff("failed");
    await tenantTransaction(prisma, async (tx) => {
      const row = await tx.offerHandoff.update({
        where: { id: handoff.id },
        data: { status: HANDOFF_STATUS.FAILED, lastError: String(error?.message || error) },
      });
      await recordAttempt(tx, {
        handoffId: handoff.id,
        tenantId,
        step: "provision",
        status: "FAILED",
        error: String(error?.message || error),
      });
      await enqueueHrDomainEvent(tx, offerHandoffFailedEvent(
        { ...row, tenantId },
        { actorId: actorId ?? null },
        // The offer's owning recruiter rides as the OPERATOR routing id — the
        // hire whose provisioning failed must never be the notice's recipient.
        { step: "provision", operatorId: offer.createdById != null ? String(offer.createdById) : null },
      ));
      return row;
    }, { tenantId });
    throw error;
  }
}
