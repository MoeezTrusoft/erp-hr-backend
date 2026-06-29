import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

// C.2-completion — verified tenant (T-P2.1) threaded via `tenantId`; folded into
// template reads + stamped on creates, fail-closed so tenant B never reads or
// mutates tenant A's performance templates.

export const createPerformanceTemplate = async (data, createdBy) => {
  const { name, description, overall_rating, tenantId } = data;
  if (!name) throw new Error("Template name is required");

  const create = await prisma.performanceTemplate.create({
    data: scopedData(tenantId, {
      name,
      description,
      overall_rating,
      createdById: Number(createdBy)
    }),
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

export const getAllPerformanceTemplates = async (tenantId) => {
  return prisma.performanceTemplate.findMany({
    where: scopedWhere(tenantId, {}),
    include: { cycles: true },
    orderBy: { id: "desc" },
  });
};

export const getPerformanceTemplateById = async (id, tenantId) => {
  const template = await prisma.performanceTemplate.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
    include: { cycles: true },
  });
  if (!template) throw new Error("Template not found");
  return template;
};

export const updatePerformanceTemplate = async (id, data, updatedBy, tenantId) => {

  const performanceTemplate = await prisma.performanceTemplate.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) })
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

export const deletePerformanceTemplate = async (id, deletedBy, tenantId) => {
  const existing = await prisma.performanceTemplate.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
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
