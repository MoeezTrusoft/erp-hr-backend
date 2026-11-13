import prisma from "../config/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

// C.2 — verified tenant (T-P2.1) threaded in as `tenantId` on the args / trailing
// param; folded into development-plan reads and stamped on creates, fail-closed.

export const createPlan = async ({ employeeId, title, description, startDate, endDate, reviewedById, tenantId }) => {
  return prisma.developmentPlan.create({
    data: scopedData(tenantId, {
      employeeId: Number(employeeId),
      title,
      description,
      startDate: startDate ? new Date(startDate) : new Date(),
      endDate: endDate ? new Date(endDate) : null,
      reviewedById: reviewedById ? Number(reviewedById) : null,
    }),
  });
};

export const listPlans = async ({ employeeId, tenantId }) => {
  const where = scopedWhere(tenantId, employeeId ? { employeeId: Number(employeeId) } : {});
  return prisma.developmentPlan.findMany({ where, orderBy: { created_at: "desc" }, include: { items: true } });
};

export const addPlanItem = async ({ planId, title, description, targetDate, tenantId }) => {
  return prisma.developmentPlanItem.create({
    data: scopedData(tenantId, {
      planId: Number(planId),
      title,
      description,
      targetDate: targetDate ? new Date(targetDate) : null,
    }),
  });
};

export const listPlanItems = async (planId, tenantId) => {
  return prisma.developmentPlanItem.findMany({ where: scopedWhere(tenantId, { planId: Number(planId) }), orderBy: { created_at: "desc" } });
};

export const updatePlanItem = async (id, data, tenantId) => {
  const existing = await prisma.developmentPlanItem.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!existing) throw new Error("Development plan item not found");
  const payload = { ...data };
  if (data.status === "COMPLETED") payload.completedAt = new Date();
  return prisma.developmentPlanItem.update({ where: { id: Number(id) }, data: payload });
};
