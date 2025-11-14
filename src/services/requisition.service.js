import { PrismaClient } from "@prisma/client";
import { logAction } from "../utils/logs.js";


const prisma = new PrismaClient();
// ✅ Create a new requisition
export const createRequisition = async (data, requestedBy) => {
  const { title, description, departmentId, positionId, openings } = data;
  if (!title) throw new Error("Title  are required");

  const createRequi = await prisma.jobRequisition.create({
    data: {
      title,
      description,
      departmentId: departmentId ? Number(departmentId) : null,
      positionId: positionId ? Number(positionId) : null,
      requestedById: Number(requestedBy),
      openings: openings ? Number(openings) : 1,
      //   status: "PENDING_APPROVAL",
    },
    requestedBy: {
      select: {
        id: true,
        first_name: true,
        last_name: true
      }
    }
  });
  await logAction({
    employeeId: requestedBy,
    type: "Create", // 👈 changed from CREATE to UPDATE
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
      // department: true,
      position: true,
      requestedBy: true,
      approvedBy: true,
    },
    orderBy: { id: "desc" },
  });
};

export const getByIdRequisitions = async (id) => {
  const getByID = prisma.jobRequisition.findUnique({
    where: { id: Number(id) },
    include: {
      // department: true,
      position: true,
      requestedBy: true,
      approvedBy: true,
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
  // Log the update action
  await logAction({
    employeeId: deletedBy,
    type: "Delete", // 👈 changed from CREATE to UPDATE
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
  // Log the update action
  await logAction({
    employeeId: approvedBy,
    type: "UPDATE", // 👈 changed from CREATE to UPDATE
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
    type: "UPDATE", // 👈 changed from CREATE to UPDATE
    module: "Requisition Post",
    result: "SUCCESS",
    notes: `Post Requisition "${id}" Posted successfully`,
  });
  return jobPosted;
};
