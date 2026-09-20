import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import { assertRequisitionTransition } from "./requisitionWorkflow.service.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { normalizeExpectedVersion, preconditionFailedError } from "../lib/optimisticConcurrency.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { requisitionDecisionEvent, requisitionPostedEvent } from "./hrEvents.js";
import { getDepartmentById, listDepartments } from "./rbac.client.js"; // department is owned by RBAC (Company → Department)

// C.2 — verified tenant (T-P2.1) threaded in as a trailing `tenantId`; folded
// into every recruitment read and stamped on every create, fail-closed when
// present so tenant B can never read/mutate tenant A's requisitions.

// ✅ Create a new requisition
export const createRequisition = async (data, requestedBy, tenantId) => {
  const { title, description, departmentId, positionId, employeeId, openings, status, priority } = data;
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

  const createRequi = await prisma.jobRequisition.create({
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
    }),
    include: {
      position: true,
      requestedBy: true,
      approvedBy: true,
      employee: true,
    },
  });
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
export const getAllRequisitions = async (tenantId) => {
  return prisma.jobRequisition.findMany({
    where: scopedWhere(tenantId, {}),
    include: {
      position: true,
      requestedBy: true,
      approvedBy: true,
      employee: true,
    },
    orderBy: { id: "desc" },
  });
};

export const getByIdRequisitions = async (id, tenantId) => {
  // findFirst (not findUnique) so the non-unique tenantId predicate scopes the
  // read; a cross-tenant id resolves to not-found, never another tenant's row.
  const getByID = await prisma.jobRequisition.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
    include: {
      position: true,
      requestedBy: true,
      approvedBy: true,
      employee: true,
    },
  });
  return getByID;
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
  const target = String(status || "").toUpperCase();
  if (!["APPROVED", "REJECTED"].includes(target)) {
    throw Object.assign(new Error("Invalid status"), { status: 400, code: "HR-RECRUITMENT-REQUISITION-STATUS-INVALID" });
  }

  const approverId = Number(approvedBy);
  if (!Number.isInteger(approverId) || approverId <= 0) {
    throw Object.assign(new Error("An approver (employee) id is required"), { status: 400, code: "HR-RECRUITMENT-APPROVER-REQUIRED" });
  }

  const requisition = await prisma.jobRequisition.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!requisition) throw Object.assign(new Error("Requisition not found"), { status: 404 });

  // Throws on an illegal transition, a no-op re-decision, or a missing reason.
  assertRequisitionTransition(requisition.status, target, { comments });

  // Phase 11 — the decision, its approval row and the event commit together. The
  // transition is re-asserted INSIDE the transaction: the pre-read above is only
  // a fast fail, and a decision raced by a concurrent one must not overwrite it.
  return tenantTransaction(prisma, async (tx) => {
    const current = await tx.jobRequisition.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
    if (!current) throw Object.assign(new Error("Requisition not found"), { status: 404 });
    assertRequisitionTransition(current.status, target, { comments });

    await tx.requisitionApproval.create({
      data: scopedData(tenantId, {
        requisitionId: Number(id),
        approverId,
        status: target,
        comments,
        decidedAt: new Date(),
      }),
    });

    const update = await tx.jobRequisition.update({
      where: { id: Number(id) },
      data: {
        status: target,
        approvedById: approverId,
      },
      approvedBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      }
    });
    await logAction({
      employeeId: approvedBy,
      type: "UPDATE",
      module: "Requisition Approve",
      result: "SUCCESS",
      notes: `Requisition approve "${id}" updated successfully`,
      tenantId: typeof tenantId !== "undefined" ? tenantId : null,
    });

    // Outbox-on-write, ids-only: consumers react to the decision, never to the
    // justification text beyond the reason the workflow already made mandatory.
    await enqueueHrDomainEvent(
      tx,
      requisitionDecisionEvent(
        update,
        { actorId: approverId },
        { decision: target, reason: comments, decidedById: approverId },
      ),
    );

    return update;
  });
};

// ✅ Post approved job externally
export const postRequisition = async (id, externalUrl, createdBy, tenantId) => {
  const requisition = await prisma.jobRequisition.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!requisition) throw Object.assign(new Error("Requisition not found"), { status: 404 });
  // Phase 3.2 — publish is a state transition (APPROVED → POSTED), so it goes
  // through the same guard as every other move rather than a bare status check.
  assertRequisitionTransition(requisition.status, "POSTED");

  // Phase 11 — the posting row, the status flip and the event are one unit: a
  // published posting must never exist without the requisition saying POSTED.
  return tenantTransaction(prisma, async (tx) => {
    await tx.jobPosting.create({
      data: scopedData(tenantId, {
        requisitionId: Number(id),
        externalUrl,
        isActive: true,
        createdById: Number(createdBy),
      }),
      createdBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      },
    });

    const jobPosted = await tx.jobRequisition.update({
      where: { id: Number(id) },
      data: { status: "POSTED" },
    });

    await logAction({
      employeeId: createdBy,
      type: "UPDATE",
      module: "Requisition Post",
      result: "SUCCESS",
      notes: `Post Requisition "${id}" Posted successfully`,
      tenantId: typeof tenantId !== "undefined" ? tenantId : null,
    });

    await enqueueHrDomainEvent(
      tx,
      requisitionPostedEvent({ ...jobPosted, externalUrl }, { actorId: Number(createdBy) || null }),
    );

    return jobPosted;
  });
};

// ✅ Update requisition
export const updateRequisition = async (id, data, updatedBy, tenantId) => {
  const { title, description, departmentId, positionId, employeeId, openings, status, priority, requestedById } = data;

  // API-2 — optimistic-concurrency guard (opt-in via expectedVersion; threaded
  // through the MCP body / REST payload). Absent ⇒ no reject.
  const expectedVersion = normalizeExpectedVersion(data?.expectedVersion);

  // Tenant-scoped pre-read so a cross-tenant id cannot be mutated (fail-closed).
  const existing = await prisma.jobRequisition.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!existing) throw new Error("Requisition not found");

  const updateData = {};
  if (title !== undefined) updateData.title = title;
  if (description !== undefined) updateData.description = description;
  if (departmentId !== undefined) updateData.departmentId = departmentId ? Number(departmentId) : null;
  if (positionId !== undefined) updateData.positionId = positionId ? Number(positionId) : null;
  if (employeeId !== undefined) updateData.employeeId = employeeId ? Number(employeeId) : null;
  if (requestedById) updateData.requestedById = Number(requestedById); // NOT-NULL FK — only reassign when a truthy id is supplied
  if (openings !== undefined) updateData.openings = openings ? Number(openings) : undefined;
  if (priority !== undefined) updateData.priority = priority; // JobRequisition.priority String?: Low | Medium | High | Urgent
  if (status !== undefined && String(status).toUpperCase() !== String(existing.status).toUpperCase()) {
    // Phase 3.2 — status is not a free field. A generic update may only perform a
    // LEGAL transition (e.g. REJECTED → DRAFT to revise); it can never jump to
    // APPROVED/POSTED and bypass the approval chain. Re-sending the current
    // status (full-object PATCH) stays a harmless no-op.
    updateData.status = assertRequisitionTransition(existing.status, status);
  }

  // API-2 — atomic compare-and-set + version bump, still tenant-scoped.
  const versionWhere = expectedVersion == null ? {} : { version: expectedVersion };
  const { count } = await prisma.jobRequisition.updateMany({
    where: scopedWhere(tenantId, { id: Number(id), ...versionWhere }),
    data: { ...updateData, version: { increment: 1 } },
  });
  if (count === 0 && expectedVersion != null) {
    const fresh = await prisma.jobRequisition.findFirst({
      where: scopedWhere(tenantId, { id: Number(id) }),
      select: { version: true },
    });
    throw preconditionFailedError(fresh?.version);
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
