import { PrismaClient } from "@prisma/client";
import { logAction } from "../utils/logs.js";
const prisma = new PrismaClient();


// ✅ Create position
export const createPosition = async (data,createdBy) => {
  const { title, description, isActive } = data;
  if (!title) throw new Error("Title is required");
console.log("fjaf", createdBy)

  // Generate a unique job code, e.g., "POS-001", "POS-002", etc.
  const lastPosition = await prisma.position.findFirst({
    orderBy: { id: "desc" },
    select: { id: true }
  });

  const nextId = lastPosition ? lastPosition.id + 1 : 1;
  const jobCode = `TST-${nextId.toString().padStart(3, "0")}`; // POS-001, POS-002

  const create =await prisma.position.create({
    data: {
      title,
      description,
      isActive,
     createdById: Number(createdBy),
      jobCode,
    },
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
export const getAllPositions = async () => {
  return prisma.position.findMany({
    include: { employees: true,
      //createdBy: true,
     },
    orderBy: { id: "desc" },
  });
};

// ✅ Get single position
export const getPositionById = async (id) => {
  const position = await prisma.position.findUnique({
    where: { id: Number(id) },
    include: { 
      employees: true, 
      createdBy: true,
     },
  });
  if (!position) throw new Error("Position not found");
  return position;
};

// ✅ Update position
export const updatePosition = async (id, data, updatedBy) => {
  const existing = await prisma.position.findUnique({
    where: { id: Number(id) },
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
export const deletePosition = async (id,deletedBy) => {
  const existing = await prisma.position.findUnique({ where: { id: Number(id) } });
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
