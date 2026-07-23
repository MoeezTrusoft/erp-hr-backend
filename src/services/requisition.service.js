import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { normalizeExpectedVersion, preconditionFailedError } from "../lib/optimisticConcurrency.js";

// C.2 — verified tenant (T-P2.1) threaded in as a trailing `tenantId`; folded
// into every recruitment read and stamped on every create, fail-closed when
// present so tenant B can never read/mutate tenant A's requisitions.

// ✅ Create a new requisition
export const createRequisition = async (data, requestedBy, tenantId) => {
  const { title, description, departmentId, positionId, employeeId, openings, status, priority } = data;
  if (!title) throw new Error("Title  are required");
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
  });

  // JobRequisition.departmentId is a raw Int (references BusinessUnit.id, HR's
  // department model) with no Prisma relation, so resolve it explicitly and
  // attach `department` to the response for the caller/FE. Tenant-scoped.
  const department = createRequi.departmentId
    ? await prisma.businessUnit.findFirst({
        where: scopedWhere(tenantId, { id: createRequi.departmentId }),
        select: { id: true, name: true },
      })
    : null;

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
  });
  return deleted;
};

// ✅ Approve or reject requisition
export const approveRequisition = async (id, status, comments, approvedBy, tenantId) => {
  if (!["APPROVED", "REJECTED"].includes(status)) throw new Error("Invalid status");

  const requisition = await prisma.jobRequisition.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!requisition) throw new Error("Requisition not found");

  await prisma.requisitionApproval.create({
    data: scopedData(tenantId, {
      requisitionId: Number(id),
      approverId: Number(approvedBy),
      status,
      comments,
      decidedAt: new Date(),
    }),
  });

  const update = await prisma.jobRequisition.update({
    where: { id: Number(id) },
    data: {
      status,
      approvedById: Number(approvedBy),
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
  });
  return update;
};

// ✅ Post approved job externally
export const postRequisition = async (id, externalUrl, createdBy, tenantId) => {
  const requisition = await prisma.jobRequisition.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!requisition) throw new Error("Requisition not found");
  if (requisition.status !== "APPROVED") throw new Error("Only approved requisitions can be posted");

  await prisma.jobPosting.create({
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

  const jobPosted = await prisma.jobRequisition.update({
    where: { id: Number(id) },
    data: { status: "POSTED" },
  });

  await logAction({
    employeeId: createdBy,
    type: "UPDATE",
    module: "Requisition Post",
    result: "SUCCESS",
    notes: `Post Requisition "${id}" Posted successfully`,
  });
  return jobPosted;
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
  if (status !== undefined) updateData.status = status;

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
    });
  }

  return updatedRequi;
};
