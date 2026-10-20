import { legacyDecision, legacySubmit } from "./approval/legacy.js";
import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import {
  assertRequisitionTransition,
  assertRequisitionAdvanceAllowed,
  recordRequisitionTransition,
} from "./requisitionWorkflow.service.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { requisitionScopeWhere } from "../lib/recruitmentAccess.js";
import { normalizeExpectedVersion, preconditionFailedError } from "../lib/optimisticConcurrency.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { requisitionDecisionEvent, requisitionPostedEvent } from "./hrEvents.js";
import { getDepartmentById, listDepartments } from "./rbac.client.js"; // department is owned by RBAC (Company → Department)
import { pickRequisitionFields, assertReplacementPairing, assertRequisitionFieldsEditable } from "../lib/requisitionFields.js";
import { emitRequisitionSubmittedEvent } from "./requisitionApprovalChain.service.js";
import { publishRequisition, closeActivePostingsForRequisition } from "./requisitionPublication.service.js";
import { assertFinanceValidityAtSubmit } from "./financeValidity.service.js";

// The HR Approval Centre request for a requisition, reduced to what a detail
// view needs. Stages: INITIATOR, MANAGER, HR, MANAGEMENT, APPROVED, REJECTED,
// WITHDRAWN. No request yet means the requisition was never submitted.
const approvalCentreProgress = async (tenantId, requisitionId) => {
  const request = tenantId
    ? await prisma.hrApprovalRequest.findUnique({
        where: { tenantId_kind_sourceRef: { tenantId, kind: "REQUISITION", sourceRef: String(requisitionId) } },
        select: { stage: true, version: true, round: true, updatedAt: true },
      })
    : null;
  return {
    engine: "HR_APPROVAL_CENTRE",
    workflowUrl: "/hr/approvals",
    submitted: Boolean(request),
    stage: request?.stage ?? null,
    version: request?.version ?? null,
    round: request?.round ?? null,
    updatedAt: request?.updatedAt ?? null,
  };
};

// C.2 — verified tenant (T-P2.1) threaded in as a trailing `tenantId`; folded
// into every recruitment read and stamped on every create, fail-closed when
// present so tenant B can never read/mutate tenant A's requisitions.

// ✅ Create a new requisition
export const createRequisition = async (data, requestedBy, tenantId) => {
  const { title, description, departmentId, positionId, employeeId, openings, status, priority } = data;
  // Phase 2.2 — the expansion fields. Normalized (and validated) here rather than
  // spread raw into `data`, so an unknown employmentType is a 422 instead of a
  // value the CHECK constraint rejects later with an opaque Prisma error.
  const expansion = pickRequisitionFields(data);
  if (!title) throw new Error("Title  are required");
  // Phase 3.2 — a requisition is BORN as a draft. Accepting an arbitrary
  // initial status let a caller create an already-APPROVED requisition and skip
  // the entire approval chain.
  if (status && String(status).toUpperCase() !== "DRAFT") {
    throw Object.assign(
      new Error("New requisitions must start in DRAFT and be submitted for approval"),
      { status: 409, code: "HR-RECRUITMENT-REQUISITION-INITIAL-STATUS" },
    );
  }
  const requesterId = requestedBy || employeeId;
  if (!requesterId) throw new Error("Hiring manager is required");
  // Phase 2.2 — a requisition created AS a replacement must name who it replaces.
  // Checked against the values actually being written so the caller gets a 422
  // naming the field rather than the raw CHECK-constraint violation.
  assertReplacementPairing({ ...expansion, requestedById: requesterId });

  // Phase 2.1 — the requisition and its opening history row are ONE unit. A
  // requisition whose own origin is unrecorded is exactly the gap this closes;
  // the row is written with both sides equal to the born status (DRAFT), matching
  // the application-history convention for a creation.
  const createRequi = await tenantTransaction(
    prisma,
    async (tx) => {
      const created = await tx.jobRequisition.create({
        data: scopedData(tenantId, {
          title,
          description,
          departmentId: departmentId ? Number(departmentId) : null,
          positionId: positionId ? Number(positionId) : null,
          requestedById: Number(requesterId),
          employeeId: employeeId ? Number(employeeId) : null,
          openings: openings ? Number(openings) : 1,
          priority: priority ?? undefined, // persisted (JobRequisition.priority String?): Low | Medium | High | Urgent
          status: status || "DRAFT",
          ...expansion,
        }),
        include: {
          position: true,
          requestedBy: true,
          approvedBy: true,
          employee: true,
        },
      });
      await recordRequisitionTransition(tx, {
        requisitionId: created.id,
        tenantId,
        fromStatus: created.status,
        toStatus: created.status,
        reason: "initial requisition",
        actorId: requesterId,
      });
      return created;
    },
    { tenantId },
  );
  await logAction({
    employeeId: requesterId,
    type: "Create",
    module: "Create Requisition",
    result: "SUCCESS",
    notes: `Create Requisition"${createRequi.id}" Created successfully`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  // Department is owned by RBAC (Company → Department); JobRequisition.departmentId
  // is an RBAC Department.id. Resolve it over the internal service plane and
  // attach `department`{id,name} to the response for the caller/FE. Fail-soft:
  // department is null if RBAC is unavailable — the requisition still returns.
  const department = await getDepartmentById(createRequi.departmentId);

  return { ...createRequi, department };
};

// ✅ Get all requisitions
// Phase 1.4 — record scope. `scope` is resolved from the caller's role claim by
// the controller/MCP layer; when omitted the tenant-wide read is retained so
// internal callers (jobs, exports) are unaffected.
// The people on a requisition are shown by name only: the full Employee row
// carries national ID, tax number, date of birth and addresses that a
// requisition list has no business returning.
const REQUISITION_PERSON_SELECT = Object.freeze({
  id: true,
  employee_code: true,
  employee_name: true,
  first_name: true,
  last_name: true,
  job_title: true,
});
// A list is bounded; the paged hr_requisitions_list tool serves deeper reads.
export const REQUISITION_LIST_LIMIT = 500;

export const getAllRequisitions = async (tenantId, scope = null) => {
  const scopeWhere = scope ? requisitionScopeWhere(scope) : {};
  return prisma.jobRequisition.findMany({
    where: scopedWhere(tenantId, scopeWhere),
    include: {
      position: true,
      requestedBy: { select: REQUISITION_PERSON_SELECT },
      approvedBy: { select: REQUISITION_PERSON_SELECT },
      employee: { select: REQUISITION_PERSON_SELECT },
    },
    orderBy: { id: "desc" },
    take: REQUISITION_LIST_LIMIT,
  });
};

export const getByIdRequisitions = async (id, tenantId, scope = null) => {
  // findFirst (not findUnique) so the non-unique tenantId predicate scopes the
  // read; a cross-tenant id resolves to not-found, never another tenant's row.
  // The record scope composes the same way: a requisition outside the caller's
  // scope is NOT FOUND, not FORBIDDEN — a 403 on a guessed id confirms it exists.
  const scopeWhere = scope ? requisitionScopeWhere(scope) : {};
  const getByID = await prisma.jobRequisition.findFirst({
    where: scopedWhere(tenantId, { id: Number(id), ...scopeWhere }),
    include: {
      position: true,
      requestedBy: true,
      approvedBy: true,
      employee: true,
    },
  });
  if (!getByID) return getByID;

  // The detail says where the HR Approval Centre review stands, so a caller never
  // has to query the centre to answer "who is this waiting on?". Read-only and
  // best-effort: a lookup that fails must not take the requisition detail down.
  try {
    return { ...getByID, approvalProgress: await approvalCentreProgress(tenantId, getByID.id) };
  } catch {
    return getByID;
  }
};

export const deleteRequisitions = async (id, deletedBy, tenantId) => {
  const requisition = await prisma.jobRequisition.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!requisition) throw new Error("Requisition not found");

  const deleted = await prisma.jobRequisition.delete({
    where: { id: Number(id) }
  });
  await logAction({
    employeeId: deletedBy,
    type: "Delete",
    module: "Requisition",
    result: "SUCCESS",
    notes: `Requisition Position  "${id}" Deleted successfully`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });
  return deleted;
};

// ✅ Approve or reject requisition
// Phase 3.2 — the decision is only legal on a requisition that was actually
// SUBMITTED (PENDING_APPROVAL), a rejection needs a reason, and re-deciding an
// already-decided requisition is refused instead of stacking another
// RequisitionApproval row onto the history.
export const approveRequisition = async (id, status, comments, approvedBy, tenantId) => {
  // Requisition decisions belong to the HR Approval Centre (initiator, line
  // manager, HR, Management). This legacy entry point never changes status: it
  // answers HR-4201 with the Approval Centre link for this requisition.
  return legacyDecision("REQUISITION", id);
};

// ✅ Post approved job externally
//
// Phase 4 / §2.4 — this is now a thin wrapper over the per-CHANNEL publication
// service, kept because `/api/hr/requisitions/post/:id` and the
// `hr_requisition_post` MCP tool call it by this name.
//
// It was also BROKEN before this change: it wrote `createdById` on `jobPosting`
// and passed a nested `createdBy` relation, and neither exists on the JobPosting
// model (the column was dropped in 20251118112502). Prisma rejects unknown
// arguments, so every publication through this path failed at runtime — which is
// why the per-channel service, not this wrapper, now owns the write.
//
export const postRequisition = async (id, externalUrl, createdBy, tenantId, postingChannels = null) => {
  const result = await publishRequisition({
    id,
    postingChannels,
    externalUrl: externalUrl ?? null,
    actorId: createdBy,
    tenantId,
  });
  // The legacy contract returns the requisition row. The postings it opened are on
  // the result too, but a caller written against the old shape keeps working.
  return result.requisition;
};

// ✅ Update requisition
export const updateRequisition = async (id, data, updatedBy, tenantId) => {
  const { title, description, departmentId, positionId, employeeId, openings, status, priority, requestedById } = data;
  // Phase 2.2 — expansion fields. Present-only semantics: an absent key leaves the
  // column untouched (a partial PATCH must not wipe the cost center), an explicit
  // null clears it, and pickRequisitionFields already rejects a REPLACEMENT
  // requisition that names nobody.
  const expansion = pickRequisitionFields(data);

  // API-2 — optimistic-concurrency guard (opt-in via expectedVersion; threaded
  // through the MCP body / REST payload). Absent ⇒ no reject.
  const expectedVersion = normalizeExpectedVersion(data?.expectedVersion);

  // Tenant-scoped pre-read so a cross-tenant id cannot be mutated (fail-closed).
  const existing = await prisma.jobRequisition.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!existing) throw new Error("Requisition not found");

  // FR-02.02 — the field lock: past DRAFT the requisition's editable fields are
  // frozen. Judged on the merged payload so a same-PATCH submit (DRAFT →
  // PENDING_APPROVAL with fields) still works, while editing a POSTED or
  // PENDING_APPROVAL requisition refuses. Status-only payloads pass through to
  // the transition guard below.
  assertRequisitionFieldsEditable(existing, { ...data, ...expansion });

  const updateData = {};
  // Phase 2.2 — checked against the MERGED row: reclassifying to REPLACEMENT is
  // legal when the row already names a replacement, and naming one is legal when
  // the reason is already REPLACEMENT.
  assertReplacementPairing({ ...existing, ...expansion });
  if (title !== undefined) updateData.title = title;
  if (description !== undefined) updateData.description = description;
  if (departmentId !== undefined) updateData.departmentId = departmentId ? Number(departmentId) : null;
  if (positionId !== undefined) updateData.positionId = positionId ? Number(positionId) : null;
  if (employeeId !== undefined) updateData.employeeId = employeeId ? Number(employeeId) : null;
  if (requestedById) updateData.requestedById = Number(requestedById); // NOT-NULL FK — only reassign when a truthy id is supplied
  if (openings !== undefined) updateData.openings = openings ? Number(openings) : undefined;
  if (priority !== undefined) updateData.priority = priority; // JobRequisition.priority String?: Low | Medium | High | Urgent
  Object.assign(updateData, expansion);
  // A submit through this surface saves the field changes first and then opens
  // the HR Approval Centre review, which owns the PENDING_APPROVAL move.
  let submitAfterUpdate = false;
  if (status !== undefined && String(status).toUpperCase() !== String(existing.status).toUpperCase()) {
    // Phase 3.2 — status is not a free field. A generic update may only perform a
    // LEGAL transition (e.g. REJECTED → DRAFT to revise); it can never jump to
    // APPROVED/POSTED and bypass the approval chain. Re-sending the current
    // status (full-object PATCH) stays a harmless no-op.
    // Phase 2.2 — the gate validates the requisition AS IT WILL BE after this
    // update, not as it is now: a caller that fixes the missing fields and
    // submits in ONE PATCH (the normal form-submit) must succeed, while a caller
    // that only flips the status must still be rejected.
    // Phase 4 / §2.4a — `comments` (or `reason`) travels with the payload so a
    // PUBLISHED → CLOSED move made through the generic update carries the same
    // mandatory justification the management and legacy close paths require.
    updateData.status = assertRequisitionTransition(existing.status, status, {
      requisition: { ...existing, ...updateData },
      comments: data.comments ?? data.reason,
    });
    // Decisions belong to the HR Approval Centre: answer HR-4201 before any write.
    if (["APPROVED", "REJECTED"].includes(updateData.status)) return legacyDecision("REQUISITION", id);
    // Phase 4 — a freeze blocks ADVANCING the requisition. Checked against the
    // merged row so a same-PATCH department change is judged on where the
    // requisition is going, not where it was.
    await assertRequisitionAdvanceAllowed(tenantId, { ...existing, ...updateData }, updateData.status);
    // FR-02.10 / decision B1.1–B1.2 — the Finance cost-center VALIDITY gate.
    // Dormant until FINANCE_SERVICE_URL is configured; advisory records evidence
    // on the snapshot; enforce blocks an invalid reference. Judged on the merged
    // row like the freeze, so a fix-and-submit PATCH validates what will exist.
    if (updateData.status === "PENDING_APPROVAL") {
      const validitySnapshot = await assertFinanceValidityAtSubmit(tenantId, { ...existing, ...updateData }, existing.budgetApprovalSnapshot);
      if (validitySnapshot) updateData.budgetApprovalSnapshot = validitySnapshot;
      submitAfterUpdate = true;
      delete updateData.status;
    }
  }

  // API-2 — atomic compare-and-set + version bump, still tenant-scoped.
  // Phase 2.1 — when this update is also a legal status move, the history row is
  // written in the SAME transaction, and only when the compare-and-set actually
  // matched a row (a lost race must not leave a transition nobody performed).
  const versionWhere = expectedVersion == null ? {} : { version: expectedVersion };
  const statusMove = updateData.status ? { from: existing.status, to: updateData.status } : null;
  const { count } = await tenantTransaction(
    prisma,
    async (tx) => {
      const result = await tx.jobRequisition.updateMany({
        where: scopedWhere(tenantId, { id: Number(id), ...versionWhere }),
        data: { ...updateData, version: { increment: 1 } },
      });
      if (result.count > 0 && statusMove) {
        // §2.4a — a close from this surface also takes the requisition off every
        // channel, so "CLOSED" cannot mean two different things depending on
        // which endpoint performed it.
        if (statusMove.to === "CLOSED") {
          await closeActivePostingsForRequisition(tx, {
            requisitionId: Number(id),
            tenantId,
            closeReason: "REQUISITION_CLOSED",
            actorId: updatedBy,
          });
        }
        await recordRequisitionTransition(tx, {
          requisitionId: Number(id),
          tenantId,
          fromStatus: statusMove.from,
          toStatus: statusMove.to,
          reason: data.comments ?? data.reason ?? null,
          actorId: updatedBy,
          source: "requisition.update",
        });
      }
      return result;
    },
    { tenantId },
  );
  if (count === 0 && expectedVersion != null) {
    const fresh = await prisma.jobRequisition.findFirst({
      where: scopedWhere(tenantId, { id: Number(id) }),
      select: { version: true },
    });
    throw preconditionFailedError(fresh?.version);
  }

  if (submitAfterUpdate) {
    await legacySubmit("REQUISITION", id, data.comments ?? data.reason ?? undefined);
    // Phase 4 closure — the submission emits the same routed event the
    // management and legacy surfaces do, so the audience cannot depend on the URL.
    await tenantTransaction(
      prisma,
      async (tx) => {
        await recordRequisitionTransition(tx, {
          requisitionId: Number(id),
          tenantId,
          fromStatus: existing.status,
          toStatus: "PENDING_APPROVAL",
          reason: data.comments ?? data.reason ?? null,
          actorId: updatedBy,
          source: "requisition.update",
        });
        const submitted = await tx.jobRequisition.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
        if (submitted) {
          await emitRequisitionSubmittedEvent(tx, { tenantId, requisition: submitted, actorId: updatedBy });
        }
      },
      { tenantId },
    );
  }

  const updatedRequi = await prisma.jobRequisition.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
    include: {
      position: true,
      requestedBy: true,
      approvedBy: true,
      employee: true,
    },
  });

  if (updatedBy) {
    await logAction({
      employeeId: updatedBy,
      type: "UPDATE",
      module: "Update Requisition",
      result: "SUCCESS",
      notes: `Requisition "${id}" updated successfully`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });
  }

  return updatedRequi;
};
