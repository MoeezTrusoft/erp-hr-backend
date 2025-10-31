import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const createPerformanceTemplate = async (data) => {
  const { name, description, overall_rating} = data;
  if (!name) throw new Error("Template name is required");

  return prisma.performanceTemplate.create({
    data: {
      name,
      description,
      overall_rating,
    },
  });
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

export const updatePerformanceTemplate = async (id, data) => {
  return prisma.performanceTemplate.update({
    where: { id: Number(id) },
    data,
  });
};

export const deletePerformanceTemplate = async (id) => {
  return prisma.performanceTemplate.delete({
    where: { id: Number(id) },
  });
};
