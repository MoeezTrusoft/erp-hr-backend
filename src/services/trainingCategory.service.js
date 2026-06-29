import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

// C.2 — verified tenant (T-P2.1) threaded in as a trailing `tenantId`; folded
// into training-category reads and stamped on creates, fail-closed when present.

export const createCategory = async (data, tenantId) => {
  if (!data.name) throw new Error("Category name is required");

  const create= await prisma.trainingCategory.create({ data: scopedData(tenantId, { ...data }) });
    await logAction({
    employeeId: 1,
    type: "Create Category", // 👈 changed from CREATE to UPDATE
    module: "Training Category",
    result: "SUCCESS",
    notes: `Training Category "${create.id}" created successfully`,
  });

  return create;
};

export const getAllCategories = async (tenantId) => {
  return prisma.trainingCategory.findMany({
    where: scopedWhere(tenantId, {}),
    include: { courses: true },
    orderBy: { id: "desc" },
  });
};

export const getCategoryById = async (id, tenantId) => {
  const category = await prisma.trainingCategory.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
    include: { courses: true },
  });
  if (!category) throw new Error("Category not found");
  return category;
};

export const updateCategory = async (id, data, tenantId) => {
  const existing = await prisma.trainingCategory.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!existing) throw new Error("Category not found");
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

export const deleteCategory = async (id, tenantId) => {
   const category = await prisma.trainingCategory.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
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
