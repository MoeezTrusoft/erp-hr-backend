import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const createCategory = async (data) => {
  if (!data.name) throw new Error("Category name is required");

  return prisma.trainingCategory.create({ data });
};

export const getAllCategories = async () => {
  return prisma.trainingCategory.findMany({
    include: { courses: true },
    orderBy: { id: "desc" },
  });
};

export const getCategoryById = async (id) => {
  const category = await prisma.trainingCategory.findUnique({
    where: { id: Number(id) },
    include: { courses: true },
  });
  if (!category) throw new Error("Category not found");
  return category;
};

export const updateCategory = async (id, data) => {
  return prisma.trainingCategory.update({
    where: { id: Number(id) },
    data,
  });
};

export const deleteCategory = async (id) => {
   const category = await prisma.trainingCategory.findUnique({ where: { id: Number(id) } });
  if (!category) throw new Error("Category not found");
  return prisma.trainingCategory.delete({ where: { id: Number(id) } });
};
