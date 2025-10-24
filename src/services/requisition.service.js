import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
// ✅ Create a new requisition
export const createRequisition = async (data) => {
  const { title, description, departmentId, positionId, requestedById, openings } = data;
  if (!title || !requestedById) throw new Error("Title and requestedById are required");

  return prisma.jobRequisition.create({
    data: {
      title,
      description,
      departmentId: departmentId ? Number(departmentId) : null,
      positionId: positionId ? Number(positionId) : null,
      requestedById: Number(requestedById),
      openings: openings ? Number(openings) : 1,
   //   status: "PENDING_APPROVAL",
    },
  });
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
  const getByID= prisma.jobRequisition.findUnique({
     where: { id: Number(id) },
    include: {
     // department: true,
      position: true,
      requestedBy: true,
      approvedBy: true,
    },
  });
  if(!getByID)throw new Error("Job Requisition");
  return getByID;
};

export const deleteRequisitions = async (id) => {
  const requisition = await prisma.jobRequisition.findUnique({ where: { id: Number(id) } });
  if (!requisition) throw new Error("Requisition not found");
  
  return prisma.jobRequisition.delete({
    where: { id: Number(id) }
  });
};

// ✅ Approve or reject requisition
export const approveRequisition = async (id, approverId, status, comments) => {
  if (!["APPROVED", "REJECTED"].includes(status)) throw new Error("Invalid status");

  const requisition = await prisma.jobRequisition.findUnique({ where: { id: Number(id) } });
  if (!requisition) throw new Error("Requisition not found");

  await prisma.requisitionApproval.create({
    data: {
      requisitionId: Number(id),
      approverId: Number(approverId),
      status,
      comments,
      decidedAt: new Date(),
    },
  });

  return prisma.jobRequisition.update({
    where: { id: Number(id) },
    data: {
      status,
      approvedById: Number(approverId),
    },
  });
};

// ✅ Post approved job externally
export const postRequisition = async (id, externalUrl) => {
  const requisition = await prisma.jobRequisition.findUnique({ where: { id: Number(id) } });
  if (!requisition) throw new Error("Requisition not found");
  if (requisition.status !== "APPROVED") throw new Error("Only approved requisitions can be posted");

  await prisma.jobPosting.create({
    data: {
      requisitionId: Number(id),
      externalUrl,
      isActive: true,
    },
  });

  return prisma.jobRequisition.update({
    where: { id: Number(id) },
    data: { status: "POSTED" },
  });
};
