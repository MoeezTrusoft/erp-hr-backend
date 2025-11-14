import { PrismaClient } from '@prisma/client';
import { logAction } from "../utils/logs.js";

const prisma = new PrismaClient();

export const createPerformanceTemplate = async (data, createdBy) => {
  const { name, description, overall_rating } = data;
  if (!name) throw new Error("Template name is required");

  const create = await prisma.performanceTemplate.create({
    data: {
      name,
      description,
      overall_rating,
      createdById: Number(createdBy)
    },
    createdBy: {
      select: {
        id: true,
        first_name: true,
        last_name: true
      }
    },
  });
  await logAction({
    employeeId: Number(createdBy),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Performance Template",
    result: "SUCCESS",
    notes: `Performance Template "${create.id}" Created successfully`,
  });

  return create
};

export const getAllPerformanceTemplates = async () => {
  return prisma.performanceTemplate.findMany({
    include: { cycles: true },
    orderBy: { id: "desc" },
  });
};

export const getPerformanceTemplateById = async (id) => {
  const template = await prisma.performanceTemplate.findUnique({
    where: { id: Number(id) },
    include: { cycles: true },
  });
  if (!template) throw new Error("Template not found");
  return template;
};

export const updatePerformanceTemplate = async (id, data, updatedBy) => {

  const performanceTemplate = await prisma.performanceTemplate.findUnique({ where: { id: id } })
  if (!performanceTemplate) throw new Error("Performance Template Not Found");
  const update = await prisma.performanceTemplate.update({
    where: { id: Number(id) },
    data,
    updatedById: Number(updatedBy),
    updatedBy: {
      select: {
        id: true,
        first_name: true,
        last_name: true
      }
    },
  });

  await logAction({
    employeeId: Number(updatedBy),
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Performance Template",
    result: "SUCCESS",
    notes: `Performance Template "${id}" Updated Successfully`,
  });

  return update
};

export const deletePerformanceTemplate = async (id, deletedBy) => {
  const existing = await prisma.performanceTemplate.findUnique({
    where: { id: Number(id) },
  });
  if (!existing) {
    throw new Error(`Performance Template Not Found ${id}`);

  }
  const deleted = await prisma.performanceTemplate.delete({
    where: { id: Number(id) },
  });
  await logAction({
    employeeId: Number(deletedBy),
    type: "Delete", // 👈 changed from CREATE to UPDATE
    module: "Performance Template",
    result: "SUCCESS",
    notes: `Performance Template "${id}" Deleted successfully`,
  });

  return deleted
};
