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
import { scopedWhere } from "../lib/tenancy.js";
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
