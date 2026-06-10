import { PrismaClient } from "@prisma/client";
import { logAction } from "../utils/logs.js";

const prisma = new PrismaClient();

// ✅ Create a new requisition
export const createRequisition = async (data, requestedBy) => {
  const { title, description, departmentId, positionId, employeeId, openings, status } = data;
  if (!title) throw new Error("Title  are required");
  const requesterId = requestedBy || employeeId;
  if (!requesterId) throw new Error("Hiring manager is required");

  const createRequi = await prisma.jobRequisition.create({
    data: {
      title,
      description,
      departmentId: departmentId ? Number(departmentId) : null,
      positionId: positionId ? Number(positionId) : null,
      requestedById: Number(requesterId),
      employeeId: employeeId ? Number(employeeId) : null,
      openings: openings ? Number(openings) : 1,
      status: status || "DRAFT",
    },
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

  return createRequi;
};

// ✅ Get all requisitions
export const getAllRequisitions = async () => {
  return prisma.jobRequisition.findMany({
    include: {
      position: true,
      requestedBy: true,
      approvedBy: true,
      employee: true,
    },
    orderBy: { id: "desc" },
  });
};

export const getByIdRequisitions = async (id) => {
  const getByID = prisma.jobRequisition.findUnique({
    where: { id: Number(id) },
    include: {
      position: true,
      requestedBy: true,
      approvedBy: true,
      employee: true,
    },
  });
  if (!getByID) throw new Error("Job Requisition");
  return getByID;
};

export const deleteRequisitions = async (id, deletedBy) => {
  const requisition = await prisma.jobRequisition.findUnique({ where: { id: Number(id) } });
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
export const approveRequisition = async (id, status, comments, approvedBy) => {
  if (!["APPROVED", "REJECTED"].includes(status)) throw new Error("Invalid status");

  const requisition = await prisma.jobRequisition.findUnique({ where: { id: Number(id) } });
  if (!requisition) throw new Error("Requisition not found");

  await prisma.requisitionApproval.create({
    data: {
      requisitionId: Number(id),
      approverId: Number(approvedBy),
      status,
      comments,
      decidedAt: new Date(),
    },
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
export const postRequisition = async (id, externalUrl, createdBy) => {
  const requisition = await prisma.jobRequisition.findUnique({ where: { id: Number(id) } });
  if (!requisition) throw new Error("Requisition not found");
  if (requisition.status !== "APPROVED") throw new Error("Only approved requisitions can be posted");

  await prisma.jobPosting.create({
    data: {
      requisitionId: Number(id),
      externalUrl,
      isActive: true,
      createdById: Number(createdBy),
    },
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
export const updateRequisition = async (id, data, updatedBy) => {
  const { title, description, departmentId, positionId, employeeId, openings, status } = data;
  const updateData = {};
  if (title !== undefined) updateData.title = title;
  if (description !== undefined) updateData.description = description;
  if (departmentId !== undefined) updateData.departmentId = departmentId ? Number(departmentId) : null;
  if (positionId !== undefined) updateData.positionId = positionId ? Number(positionId) : null;
  if (employeeId !== undefined) updateData.employeeId = employeeId ? Number(employeeId) : null;
  if (openings !== undefined) updateData.openings = openings ? Number(openings) : undefined;
  if (status !== undefined) updateData.status = status;

  const updatedRequi = await prisma.jobRequisition.update({
    where: { id: Number(id) },
    data: updateData,
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
