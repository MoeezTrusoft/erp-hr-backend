// src/services/gradeBand.service.js
//
// Payroll Setup → Salary Structure: grade-band editing. A GradeLevel carries an
// optional salary band (minSalary / midSalary / maxSalary + bandCurrency) that
// bounds the compensation range for the grade. The grade rows themselves are
// owned/created elsewhere; this service only reads them and edits the band
// fields.
//
// GradeLevel is FORCE-RLS (see src/lib/rlsTenant.js): reads fold the verified
// tenant via scopedWhere(tenantId, where); a single update runs under ambient
// ctx so the RLS extension auto-wraps the write with the tenant GUC.
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import logger from "../lib/logger.js";

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
}

function toIntOrNull(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toNumberOrNull(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function toBand(g, componentCount) {
  return {
    id: g.id,
    name: g.name,
    description: g.description ?? null,
    minSalary: g.minSalary ?? null,
    midSalary: g.midSalary ?? null,
    maxSalary: g.maxSalary ?? null,
    bandCurrency: g.bandCurrency ?? null,
    ...(componentCount !== undefined ? { componentCount } : {}),
  };
}

export async function listGradeBands({ tenantId }) {
  const grades = await prisma.gradeLevel.findMany({
    where: scopedWhere(tenantId, {}),
    orderBy: [{ name: "asc" }],
  });

  // Count the salary components scoped to each grade (tenant-scoped).
  const items = await Promise.all(
    grades.map(async (g) => {
      const componentCount = await prisma.salaryComponent.count({
        where: scopedWhere(tenantId, { gradeLevelId: g.id }),
      });
      return toBand(g, componentCount);
    })
  );
  return items;
}

export async function upsertGradeBand({ tenantId, id, minSalary, midSalary, maxSalary, bandCurrency }) {
  const gradeId = toIntOrNull(id);
  if (gradeId == null) throw badRequest("id is required");

  const existing = await prisma.gradeLevel.findFirst({
    where: scopedWhere(tenantId, { id: gradeId }),
  });
  if (!existing) throw notFound(`Grade level ${id} not found`);

  const data = {};
  if (minSalary !== undefined) data.minSalary = toNumberOrNull(minSalary);
  if (midSalary !== undefined) data.midSalary = toNumberOrNull(midSalary);
  if (maxSalary !== undefined) data.maxSalary = toNumberOrNull(maxSalary);
  if (bandCurrency !== undefined) {
    data.bandCurrency = bandCurrency == null || bandCurrency === "" ? null : String(bandCurrency);
  }

  // Validate min <= mid <= max across the effective (merged) values when all
  // present.
  const eff = {
    min: data.minSalary !== undefined ? data.minSalary : existing.minSalary,
    mid: data.midSalary !== undefined ? data.midSalary : existing.midSalary,
    max: data.maxSalary !== undefined ? data.maxSalary : existing.maxSalary,
  };
  if (eff.min != null && eff.mid != null && eff.max != null) {
    if (!(eff.min <= eff.mid && eff.mid <= eff.max)) {
      throw badRequest("Salary band must satisfy minSalary <= midSalary <= maxSalary");
    }
  }

  const updated = await prisma.gradeLevel.update({ where: { id: gradeId }, data });
  logger.info({ id: gradeId }, "grade band updated");
  return toBand(updated);
}

export async function getGradeBand({ tenantId, id }) {
  const gradeId = toIntOrNull(id);
  if (gradeId == null) throw badRequest("id is required");

  const grade = await prisma.gradeLevel.findFirst({
    where: scopedWhere(tenantId, { id: gradeId }),
  });
  if (!grade) throw notFound(`Grade level ${id} not found`);

  const componentCount = await prisma.salaryComponent.count({
    where: scopedWhere(tenantId, { gradeLevelId: gradeId }),
  });
  return toBand(grade, componentCount);
}

// ── Grade CRUD (Payroll Setup → Salary Structure grade rows) ─────────────────
// The grade rows themselves (name/description + optional band) are created and
// removed here; hr_grade_band_upsert only edits the band fields of an existing
// grade. Writes run under ambient ctx so the RLS extension auto-stamps/wraps
// the tenant GUC; scopedWhere/scopedData keep every read/write fail-closed.

export async function createGradeLevel({ tenantId, name, description, minSalary, midSalary, maxSalary, bandCurrency }) {
  const nm = name == null ? "" : String(name).trim();
  if (!nm) throw badRequest("name is required");

  const data = {
    name: nm,
    description: description == null || description === "" ? null : String(description).trim(),
  };
  if (minSalary !== undefined) data.minSalary = toNumberOrNull(minSalary);
  if (midSalary !== undefined) data.midSalary = toNumberOrNull(midSalary);
  if (maxSalary !== undefined) data.maxSalary = toNumberOrNull(maxSalary);
  if (bandCurrency !== undefined) {
    data.bandCurrency = bandCurrency == null || bandCurrency === "" ? null : String(bandCurrency);
  }
  if (data.minSalary != null && data.midSalary != null && data.maxSalary != null) {
    if (!(data.minSalary <= data.midSalary && data.midSalary <= data.maxSalary)) {
      throw badRequest("Salary band must satisfy minSalary <= midSalary <= maxSalary");
    }
  }

  const created = await prisma.gradeLevel.create({ data: scopedData(tenantId, data) });
  logger.info({ id: created.id, tenantId }, "grade level created");
  return toBand(created, 0);
}

export async function updateGradeLevel({ tenantId, id, name, description }) {
  const gradeId = toIntOrNull(id);
  if (gradeId == null) throw badRequest("id is required");

  const data = {};
  if (name !== undefined) {
    const nm = name == null ? "" : String(name).trim();
    if (!nm) throw badRequest("name cannot be empty");
    data.name = nm;
  }
  if (description !== undefined) {
    data.description = description == null || description === "" ? null : String(description).trim();
  }
  if (Object.keys(data).length === 0) throw badRequest("Provide name or description to update");

  // updateMany so the tenant scope is enforced in the WHERE (fail-closed).
  const res = await prisma.gradeLevel.updateMany({ where: scopedWhere(tenantId, { id: gradeId }), data });
  if (res.count === 0) throw notFound(`Grade level ${id} not found`);
  const updated = await prisma.gradeLevel.findFirst({ where: scopedWhere(tenantId, { id: gradeId }) });
  logger.info({ id: gradeId, tenantId }, "grade level updated");
  return getGradeBand({ tenantId, id: gradeId });
}

export async function deleteGradeLevel({ tenantId, id }) {
  const gradeId = toIntOrNull(id);
  if (gradeId == null) throw badRequest("id is required");

  const existing = await prisma.gradeLevel.findFirst({ where: scopedWhere(tenantId, { id: gradeId }) });
  if (!existing) throw notFound(`Grade level ${id} not found`);

  // Guard: refuse to delete a grade that is still in use — a live FK reference
  // would otherwise dangle (Employee.gradeLevelId) or silently detach
  // (SalaryComponent.gradeLevelId ON DELETE SET NULL). Surface a clear reason.
  const [employeeCount, componentCount] = await Promise.all([
    prisma.employee.count({ where: scopedWhere(tenantId, { gradeLevelId: gradeId }) }),
    prisma.salaryComponent.count({ where: scopedWhere(tenantId, { gradeLevelId: gradeId }) }),
  ]);
  if (employeeCount > 0) {
    throw badRequest(`Cannot delete grade — ${employeeCount} employee(s) are assigned to it. Reassign them first.`);
  }
  if (componentCount > 0) {
    throw badRequest(`Cannot delete grade — ${componentCount} salary component(s) are assigned to it. Unassign them first (hr_grade_unassign_components).`);
  }

  const res = await prisma.gradeLevel.deleteMany({ where: scopedWhere(tenantId, { id: gradeId }) });
  if (res.count === 0) throw notFound(`Grade level ${id} not found`);
  logger.info({ id: gradeId, tenantId }, "grade level deleted");
  return { success: true, id: gradeId };
}

// ── Component ↔ grade assignment ─────────────────────────────────────────────
// A SalaryComponent belongs to at most one grade (SalaryComponent.gradeLevelId).
// "Assign" sets that FK for a batch of components; "unassign" clears it.

function toComponentIdList(componentIds) {
  const list = Array.isArray(componentIds) ? componentIds : [componentIds];
  const ids = [...new Set(list.map(toIntOrNull).filter((n) => n != null))];
  if (ids.length === 0) throw badRequest("componentIds must be a non-empty list of SalaryComponent ids");
  return ids;
}

export async function assignComponentsToGrade({ tenantId, gradeLevelId, componentIds }) {
  const gradeId = toIntOrNull(gradeLevelId);
  if (gradeId == null) throw badRequest("gradeLevelId is required");
  const ids = toComponentIdList(componentIds);

  const grade = await prisma.gradeLevel.findFirst({ where: scopedWhere(tenantId, { id: gradeId }) });
  if (!grade) throw notFound(`Grade level ${gradeLevelId} not found`);

  // updateMany with the tenant + id set in the WHERE: components from another
  // tenant (or non-existent ids) simply don't match — no cross-tenant write.
  const res = await prisma.salaryComponent.updateMany({
    where: scopedWhere(tenantId, { id: { in: ids } }),
    data: { gradeLevelId: gradeId },
  });
  logger.info({ gradeLevelId: gradeId, requested: ids.length, assigned: res.count, tenantId }, "components assigned to grade");
  return {
    success: true,
    gradeLevelId: gradeId,
    requested: ids.length,
    assigned: res.count,
    skipped: ids.length - res.count, // ids that matched no in-tenant component
  };
}

export async function unassignComponents({ tenantId, componentIds }) {
  const ids = toComponentIdList(componentIds);
  const res = await prisma.salaryComponent.updateMany({
    where: scopedWhere(tenantId, { id: { in: ids } }),
    data: { gradeLevelId: null },
  });
  logger.info({ requested: ids.length, unassigned: res.count, tenantId }, "components unassigned from grade");
  return { success: true, requested: ids.length, unassigned: res.count, skipped: ids.length - res.count };
}
