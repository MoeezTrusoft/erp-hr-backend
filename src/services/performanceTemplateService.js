import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { performanceTemplateCreate, performanceTemplateUpdate } from '../validators/performance.schema.js';

// C.2-completion — verified tenant (T-P2.1) threaded via `tenantId`; folded into
// template reads + stamped on creates, fail-closed so tenant B never reads or
// mutates tenant A's performance templates.

export const createPerformanceTemplate = async (data, createdBy) => {
  const { tenantId, ...payload } = data;
  const { name, description, criteria, overall_rating } = performanceTemplateCreate.parse(payload);
  if (!name) throw new Error("Template name is required");
  if(criteria!==undefined && (!Array.isArray(criteria)||criteria.some(c=>typeof c!=='string'||!c.trim())))throw Object.assign(new Error('Legacy template criteria must be an array of nonempty labels'),{status:422});

  const create = await prisma.performanceTemplate.create({
    data: scopedData(tenantId, {
      name,
      description,
      criteria,
      overall_rating,

    }),
  });
  await logAction({
    employeeId: Number(createdBy),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Performance Template",
    result: "SUCCESS",
    notes: `Performance Template "${create.id}" Created successfully`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
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
  data = performanceTemplateUpdate.parse(data);

  const performanceTemplate = await prisma.performanceTemplate.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) })
  if (!performanceTemplate) throw new Error("Performance Template Not Found");
  if(Object.keys(data).some(k=>!["name","description","criteria","overall_rating"].includes(k)))throw Object.assign(new Error('Unsupported template field'),{status:422});
  if(await prisma.performanceCycle.count({where:scopedWhere(tenantId,{templateId:Number(id)})}))throw Object.assign(new Error('Referenced templates are immutable; create a new template version'),{status:409});
  if(data.criteria!==undefined&&(!Array.isArray(data.criteria)||data.criteria.some(c=>typeof c!=='string'||!c.trim())))throw Object.assign(new Error('Invalid template criteria'),{status:422});
  const update = await prisma.performanceTemplate.update({
    where: { id: Number(id) },
    data: Object.fromEntries(Object.entries(data).filter(([key]) => ["name", "description", "criteria", "overall_rating"].includes(key))),

  });

  await logAction({
    employeeId: Number(updatedBy),
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Performance Template",
    result: "SUCCESS",
    notes: `Performance Template "${id}" Updated Successfully`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
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
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return deleted
};
