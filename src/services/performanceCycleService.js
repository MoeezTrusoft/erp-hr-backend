import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { conflict, isUniqueViolation, notFound } from "../lib/performance-errors.js";
import {
  CYCLE_TRANSITIONS,
  cycleCreateSchema,
  cycleUpdateSchema,
  parsePerformancePayload,
} from "../validators/performance.schema.js";

// C.2-completion — verified tenant (T-P2.1) threaded via a trailing
// `tenantId`; folded into cycle reads + stamped on creates, fail-closed so
// tenant B never reads or mutates tenant A's performance cycles.
//
// PERF-P0 (E-01 / D11, D12; E-05):
//   * the payload is parsed (camelCase startDate/endDate from the MCP tool and
//     snake_case from REST both normalise to start_date/end_date), so
//     hr_performance_cycle_create works and nothing is spread raw into Prisma;
//   * templateId is optional (the tool never offered one) but verified when
//     given;
//   * status moves DRAFT → ACTIVE → CLOSED only; CLOSED is terminal;
//   * delete archives (archivedAt) instead of orphaning the cycle's reviews.

const assertTemplate = async (tenantId, templateId) => {
  const template = await prisma.performanceTemplate.findFirst({
    where: scopedWhere(tenantId, { id: Number(templateId), archivedAt: null }),
    select: { id: true },
  });
  if (!template) throw notFound(`Template ${templateId}`);
  return template;
};

const duplicateName = (name) => conflict(`A performance cycle named "${name}" already exists (archived cycles keep their name)`);

export const createPerformanceCycle = async (data, createdBy, tenantId) => {
  const input = parsePerformancePayload(cycleCreateSchema, data);
  const { name, description, start_date, end_date, status, templateId } = input;

  if (templateId != null) await assertTemplate(tenantId, templateId);

  let create;
  try {
    create = await prisma.performanceCycle.create({
      data: scopedData(tenantId, {
        name,
        description: description ?? null,
        start_date: new Date(start_date),
        end_date: new Date(end_date),
        status: status ?? "DRAFT",
        ...(templateId != null ? { templateId: Number(templateId) } : {}),
      }),
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicateName(name);
    throw err;
  }

  await logAction({
    employeeId: Number(createdBy),
    type: "CREATE",
    module: "Performance Cycle",
    result: "SUCCESS",
    notes: `Performance cycle ${create.id} (${name}) created`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return create;
};

export const getAllPerformanceCycles = async (tenantId, { includeArchived = false } = {}) => {
  return prisma.performanceCycle.findMany({
    where: scopedWhere(tenantId, includeArchived ? {} : { archivedAt: null }),
    include: { template: true, _count: { select: { reviews: true } } },
    orderBy: { id: "desc" },
  });
};

export const getPerformanceCycleById = async (id, tenantId) => {
  const cycle = await prisma.performanceCycle.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
    include: { template: true, reviews: true },
  });
  if (!cycle) throw notFound("Performance cycle");
  return cycle;
};

export const updatePerformanceCycle = async (id, data, updatedBy, tenantId) => {
  const input = parsePerformancePayload(cycleUpdateSchema, data);
  const existing = await prisma.performanceCycle.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!existing) throw notFound("Performance cycle");
  if (existing.archivedAt) throw conflict("An archived performance cycle cannot be updated");

  if (input.status && input.status !== existing.status) {
    const allowed = CYCLE_TRANSITIONS[existing.status] ?? [];
    if (!allowed.includes(input.status))
      throw conflict(`A ${existing.status} cycle cannot move to ${input.status}`);
  }
  if (existing.status === "CLOSED" && (input.start_date || input.end_date || input.name))
    throw conflict("A closed performance cycle is immutable");
  if (input.templateId != null) await assertTemplate(tenantId, input.templateId);

  const nextStart = input.start_date ? new Date(input.start_date) : existing.start_date;
  const nextEnd = input.end_date ? new Date(input.end_date) : existing.end_date;
  if (nextEnd.getTime() < nextStart.getTime()) throw conflict("end_date must not be before start_date");

  const patch = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.start_date ? { start_date: nextStart } : {}),
    ...(input.end_date ? { end_date: nextEnd } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
  };

  let update;
  try {
    update = await prisma.performanceCycle.update({ where: { id: Number(id) }, data: patch });
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicateName(input.name);
    throw err;
  }

  await logAction({
    employeeId: Number(updatedBy),
    type: "UPDATE",
    module: "Performance Cycle",
    result: "SUCCESS",
    notes: `Performance cycle ${id} updated (${Object.keys(patch).join(", ") || "no-op"})`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return update;
};

// Archive (soft delete). Reviews, calibration sessions and appraisal inputs
// that reference the cycle stay intact and readable.
export const deletePerformanceCycle = async (id, deletedBy, tenantId) => {
  const existing = await prisma.performanceCycle.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!existing || existing.archivedAt) throw notFound("Performance cycle");
  if (existing.status === "ACTIVE") throw conflict("Close the performance cycle before archiving it");

  const archived = await prisma.performanceCycle.update({
    where: { id: Number(id) },
    data: { archivedAt: new Date() },
  });

  await logAction({
    employeeId: Number(deletedBy),
    type: "DELETE",
    module: "Performance Cycle",
    result: "SUCCESS",
    notes: `Performance cycle ${id} archived`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return archived;
};
