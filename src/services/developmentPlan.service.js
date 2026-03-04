import prisma from "../config/prisma.js";

export const createPlan = async ({ employeeId, title, description, startDate, endDate, reviewedById }) => {
  return prisma.developmentPlan.create({
    data: {
      employeeId: Number(employeeId),
      title,
      description,
      startDate: startDate ? new Date(startDate) : new Date(),
      endDate: endDate ? new Date(endDate) : null,
      reviewedById: reviewedById ? Number(reviewedById) : null,
    },
  });
};

export const listPlans = async ({ employeeId }) => {
  const where = employeeId ? { employeeId: Number(employeeId) } : {};
  return prisma.developmentPlan.findMany({ where, orderBy: { created_at: "desc" }, include: { items: true } });
};

export const addPlanItem = async ({ planId, title, description, targetDate }) => {
  return prisma.developmentPlanItem.create({
    data: {
      planId: Number(planId),
      title,
      description,
      targetDate: targetDate ? new Date(targetDate) : null,
    },
  });
};

export const listPlanItems = async (planId) => {
  return prisma.developmentPlanItem.findMany({ where: { planId: Number(planId) }, orderBy: { created_at: "desc" } });
};

export const updatePlanItem = async (id, data) => {
  const payload = { ...data };
  if (data.status === "COMPLETED") payload.completedAt = new Date();
  return prisma.developmentPlanItem.update({ where: { id: Number(id) }, data: payload });
};
