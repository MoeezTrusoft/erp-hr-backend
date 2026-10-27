import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { conflict, isUniqueViolation, notFound } from "../lib/performance-errors.js";
import {
  parsePerformancePayload,
  templateCreateSchema,
  templateUpdateSchema,
} from "../validators/performance.schema.js";

// C.2-completion — verified tenant (T-P2.1) threaded via a trailing `tenantId`;
// folded into template reads + stamped on creates, fail-closed so tenant B
// never reads or mutates tenant A's performance templates.
//
// PERF-P0 (E-01 / D13; E-05): `criteria` is persisted (create used to drop it),
// the update takes a parsed whitelist instead of the raw body, and delete
// archives (archivedAt) so cycles that reference the template keep resolving.

const duplicateName = (name) =>
  conflict(`A performance template named "${name}" already exists (archived templates keep their name)`);

export const createPerformanceTemplate = async (data, createdBy, tenantId) => {
  const { name, description, criteria, overall_rating } = parsePerformancePayload(templateCreateSchema, data);

  let create;
  try {
    create = await prisma.performanceTemplate.create({
      data: scopedData(tenantId, {
        name,
        description: description ?? null,
        criteria: criteria ?? undefined,
        overall_rating: overall_rating ?? null,
      }),
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicateName(name);
    throw err;
  }

  await logAction({
    employeeId: Number(createdBy),
    type: "CREATE",
    module: "Performance Template",
    result: "SUCCESS",
    notes: `Performance template ${create.id} (${name}) created`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return create;
};

export const getAllPerformanceTemplates = async (tenantId, { includeArchived = false } = {}) => {
  return prisma.performanceTemplate.findMany({
    where: scopedWhere(tenantId, includeArchived ? {} : { archivedAt: null }),
    include: { cycles: { where: { archivedAt: null }, select: { id: true, name: true, status: true } } },
    orderBy: { id: "desc" },
  });
};

export const getPerformanceTemplateById = async (id, tenantId) => {
  const template = await prisma.performanceTemplate.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
    include: { cycles: true },
  });
  if (!template) throw notFound("Template");
  return template;
};

export const updatePerformanceTemplate = async (id, data, updatedBy, tenantId) => {
  const input = parsePerformancePayload(templateUpdateSchema, data);

  const existing = await prisma.performanceTemplate.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!existing) throw notFound("Performance template");
  if (existing.archivedAt) throw conflict("An archived performance template cannot be updated");

  const patch = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.criteria !== undefined ? { criteria: input.criteria } : {}),
    ...(input.overall_rating !== undefined ? { overall_rating: input.overall_rating } : {}),
  };

  let update;
  try {
    update = await prisma.performanceTemplate.update({ where: { id: Number(id) }, data: patch });
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicateName(input.name);
    throw err;
  }

  await logAction({
    employeeId: Number(updatedBy),
    type: "UPDATE",
    module: "Performance Template",
    result: "SUCCESS",
    notes: `Performance template ${id} updated (${Object.keys(patch).join(", ") || "no-op"})`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return update;
};

// Archive (soft delete).
export const deletePerformanceTemplate = async (id, deletedBy, tenantId) => {
  const existing = await prisma.performanceTemplate.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
  });
  if (!existing || existing.archivedAt) throw notFound(`Performance template ${id}`);

  const activeCycles = await prisma.performanceCycle.count({
    where: scopedWhere(tenantId, { templateId: Number(id), archivedAt: null, status: { not: "CLOSED" } }),
  });
  if (activeCycles > 0)
    throw conflict(`The template is used by ${activeCycles} open performance cycle(s)`);

  const archived = await prisma.performanceTemplate.update({
    where: { id: Number(id) },
    data: { archivedAt: new Date() },
  });

  await logAction({
    employeeId: Number(deletedBy),
    type: "DELETE",
    module: "Performance Template",
    result: "SUCCESS",
    notes: `Performance template ${id} archived`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return archived;
};
