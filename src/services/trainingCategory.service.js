import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";



export const createCategory = async (data) => {
  if (!data.name) throw new Error("Category name is required");

  const create= await prisma.trainingCategory.create({ data });
    await logAction({
    employeeId: 1,
    type: "Create Category", // 👈 changed from CREATE to UPDATE
    module: "Training Category",
    result: "SUCCESS",
    notes: `Training Category "${create.id}" created successfully`,
  });

  return create;
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
  const update = await prisma.trainingCategory.update({
    where: { id: Number(id) },
    data,
  });
  await logAction({
    employeeId: 1,
    type: "UPDATE", // 👈 changed from CREATE to UPDATE
    module: "Training Category",
    result: "SUCCESS",
    notes: `Training Category "${id}" Updated successfully`,
  });

  return update;
};

export const deleteCategory = async (id) => {
   const category = await prisma.trainingCategory.findUnique({ where: { id: Number(id) } });
  if (!category) throw new Error("Category not found");
  const deleted = await prisma.trainingCategory.delete({ where: { id: Number(id) } });
  await logAction({
    employeeId: 1,
    type: "Deleted", // 👈 changed from CREATE to UPDATE
    module: "Training Category",
    result: "SUCCESS",
    notes: `Training Category "${id}" Deleted successfully`,
  });
  return deleted;
};
