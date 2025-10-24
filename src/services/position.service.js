import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();


// ✅ Create position
export const createPosition = async (data) => {
  const { title, description, isActive } = data;
  if (!title) throw new Error("Title is required");

  return prisma.position.create({
    data: {
      title,
      description,
      isActive,
    },
  });
};

// ✅ Get all positions
export const getAllPositions = async () => {
  return prisma.position.findMany({
    include: { employees: true },
    orderBy: { id: "desc" },
  });
};

// ✅ Get single position
export const getPositionById = async (id) => {
  const position = await prisma.position.findUnique({
    where: { id: Number(id) },
    include: { employees: true },
  });
  if (!position) throw new Error("Position not found");
  return position;
};

// ✅ Update position
export const updatePosition = async (id, data) => {
  const existing = await prisma.position.findUnique({ where: { id: Number(id) } });
  if (!existing) throw new Error("Position not found");

  return prisma.position.update({
    where: { id: Number(id) },
    data,
  });
};

// ✅ Delete position
export const deletePosition = async (id) => {
  const existing = await prisma.position.findUnique({ where: { id: Number(id) } });
  if (!existing) throw new Error("Position not found");

  return prisma.position.delete({
    where: { id: Number(id) }
  });

};
