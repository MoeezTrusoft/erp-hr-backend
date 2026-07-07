import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

// C.2-completion — verified tenant (T-P2.1) threaded via `tenantId` (in the
// create payload, or a trailing read/update/delete param); folded into position
// reads + stamped on creates, fail-closed so tenant B never reads or mutates
// tenant A's positions.

// ✅ Create position
export const createPosition = async (data,createdBy) => {
  const { title, description, isActive, tenantId } = data;
  if (!title) throw new Error("Title is required");

  // Generate a unique job code, e.g., "POS-001", "POS-002", etc. (scoped read)
  const lastPosition = await prisma.position.findFirst({
    where: scopedWhere(tenantId, {}),
    orderBy: { id: "desc" },
    select: { id: true }
  });

  const nextId = lastPosition ? lastPosition.id + 1 : 1;
  const jobCode = `TST-${nextId.toString().padStart(3, "0")}`; // POS-001, POS-002

  const create =await prisma.position.create({
    data: scopedData(tenantId, {
      title,
      description,
      isActive,
     createdById: Number(createdBy),
      jobCode,
    }),
    //  createdBy: {
    //     select: {
    //       id: true,
    //       first_name: true,
    //       last_name: true
    //     }
    //   },
  });
    await logAction({
    employeeId: createdBy, // 👈 correct field name that matches the Log model
    type: "CREATE",
    module: "Position",
    result: "SUCCESS",
    notes: `Position "${title}" created successfully`,
  });
  return create;
};

// ✅ Get all positions
export const getAllPositions = async (tenantId) => {
  return prisma.position.findMany({
    where: scopedWhere(tenantId, {}),
    include: { employees: true,
      //createdBy: true,
     },
    orderBy: { id: "desc" },
  });
};

// ✅ Get single position
export const getPositionById = async (id, tenantId) => {
  const position = await prisma.position.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
    include: {
      employees: true,
     //createdBy: true,
     },
  });
  if (!position) throw new Error("Position not found");
  return position;
};

// ✅ Update position
export const updatePosition = async (id, data, updatedBy, tenantId) => {
  const existing = await prisma.position.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
  });

  if (!existing) throw new Error("Position not found");

  const { title, description, isActive } = data;

  // ✅ Correctly use the `data` field for Prisma update
  const updated = await prisma.position.update({
    where: { id: Number(id) },
    data: {
      title,
      description,
      isActive,
      updatedByById : Number(updatedBy),
       jobCode,
    },
     updatedBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      },
  });

  // Log the update action
  await logAction({
    employeeId: updatedBy,
    type: "UPDATE", // 👈 changed from CREATE to UPDATE
    module: "Position",
    result: "SUCCESS",
    notes: `Position "${id}" updated successfully`,
  });

  return updated;
};
// ✅ Delete position
export const deletePosition = async (id,deletedBy, tenantId) => {
  const existing = await prisma.position.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!existing) throw new Error("Position not found");

  const  deleted = prisma.position.delete({
    where: { id: Number(id) }
  });

   // Log the update action
  await logAction({
    employeeId: deletedBy,
    type: "Delete", // 👈 changed from CREATE to UPDATE
    module: "Position",
    result: "SUCCESS",
    notes: `Position "${id}" Deleted successfully`,
  });

  return deleted;

};
