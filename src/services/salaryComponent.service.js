// src/services/salaryComponent.service.js
//
// Payroll Setup → Salary Structure: unified salary-component config (EARNING /
// DEDUCTION lines with FIXED / PERCENTAGE / FORMULA computation).
//
// SalaryComponent is FORCE-RLS (see src/lib/rlsTenant.js): reads fold the
// verified tenant via scopedWhere(tenantId, where); a single create/update runs
// under ambient ctx so the RLS extension auto-wraps the write with the tenant
// GUC (tenant is create-stamped by the DB default — never passed here).
//
// FORMULA computation is validated with the shared safe evaluator
// (src/lib/payrollFormula.js). Allowed formula variables are the payroll base
// vars PLUS every OTHER active component's code in the tenant, so a formula may
// reference sibling components (e.g. "(BASIC + HRA) * 0.1").
import prisma from "../lib/prisma.js";
import { scopedWhere } from "../lib/tenancy.js";
import { validateFormula } from "../lib/payrollFormula.js";
import logger from "../lib/logger.js";

const PAY_ELEMENT_TYPES = new Set(["EARNING", "DEDUCTION"]);
const COMPUTATION_TYPES = new Set(["FIXED", "PERCENTAGE", "FORMULA"]);
const CONFIG_STATUSES = new Set(["DRAFT", "PUBLISHED"]);
const SORT_FIELDS = new Set(["sortOrder", "code", "name", "type"]);

// Payroll base variables always available to a formula, on top of the tenant's
// other component codes.
const BASE_FORMULA_VARS = [
  "BASIC",
  "GROSS",
  "NET",
  "DAYS_WORKED",
  "WORKING_DAYS",
  "LWP_DAYS",
];

const GRADE_SELECT = { id: true, name: true };

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

// Build the allowed formula variable set: base vars + every OTHER active
// component's code in the tenant (excluding the row being edited).
async function buildAllowedVars(tenantId, excludeId) {
  const where = scopedWhere(tenantId, {
    active: true,
    ...(excludeId != null ? { id: { not: excludeId } } : {}),
  });
  const others = await prisma.salaryComponent.findMany({
    where,
    select: { code: true },
  });
  const codes = others.map((c) => c.code).filter(Boolean);
  return [...BASE_FORMULA_VARS, ...codes];
}

// Validate a component's computation/value/formula combination, running the
// formula validator against the tenant allowedVars when computation=FORMULA.
async function validateComputation({ tenantId, computation, value, formula, excludeId }) {
  if (!COMPUTATION_TYPES.has(computation)) {
    throw badRequest(`Invalid computation "${computation}" (FIXED|PERCENTAGE|FORMULA)`);
  }
  if (computation === "FIXED" || computation === "PERCENTAGE") {
    const num = toNumberOrNull(value);
    if (num == null) {
      throw badRequest(`value is required (number) for computation ${computation}`);
    }
    if (computation === "PERCENTAGE" && (num < 0 || num > 100)) {
      throw badRequest("PERCENTAGE value must be between 0 and 100");
    }
    return { value: num, formula: null };
  }
  // FORMULA
  if (!formula || String(formula).trim() === "") {
    throw badRequest("formula is required for computation FORMULA");
  }
  const allowedVars = await buildAllowedVars(tenantId, excludeId);
  const res = validateFormula(formula, allowedVars);
  if (!res.ok) {
    throw badRequest(`Invalid formula: ${res.error}`);
  }
  return { value: null, formula: String(formula) };
}

export async function createSalaryComponent({
  tenantId,
  code,
  name,
  type,
  computation,
  value,
  formula,
  taxable,
  active,
  sortOrder,
  gradeLevelId,
}) {
  if (!code || String(code).trim() === "") throw badRequest("code is required");
  if (!name || String(name).trim() === "") throw badRequest("name is required");
  if (!PAY_ELEMENT_TYPES.has(type)) throw badRequest(`Invalid type "${type}" (EARNING|DEDUCTION)`);

  const comp = computation ?? "FIXED";
  const { value: normValue, formula: normFormula } = await validateComputation({
    tenantId,
    computation: comp,
    value,
    formula,
    excludeId: null,
  });

  // Unique code per tenant (scoped).
  const dup = await prisma.salaryComponent.findFirst({
    where: scopedWhere(tenantId, { code: String(code) }),
    select: { id: true },
  });
  if (dup) throw badRequest(`A salary component with code "${code}" already exists`);

  const created = await prisma.salaryComponent.create({
    data: {
      code: String(code),
      name: String(name),
      type,
      computation: comp,
      value: normValue,
      formula: normFormula,
      taxable: taxable == null ? true : Boolean(taxable),
      active: active == null ? true : Boolean(active),
      sortOrder: toIntOrNull(sortOrder) ?? 0,
      gradeLevelId: toIntOrNull(gradeLevelId),
      // status defaults DRAFT (DB default); version defaults 1.
    },
    include: { gradeLevel: { select: GRADE_SELECT } },
  });
  logger.info({ id: created.id, code: created.code }, "salary component created");
  return created;
}

export async function updateSalaryComponent({ tenantId, id, ...fields }) {
  const compId = toIntOrNull(id);
  if (compId == null) throw badRequest("id is required");

  const existing = await prisma.salaryComponent.findFirst({
    where: scopedWhere(tenantId, { id: compId }),
  });
  if (!existing) throw notFound(`Salary component ${id} not found`);

  const data = {};

  if (fields.code !== undefined) {
    const nextCode = String(fields.code);
    if (nextCode.trim() === "") throw badRequest("code cannot be empty");
    if (nextCode !== existing.code) {
      const dup = await prisma.salaryComponent.findFirst({
        where: scopedWhere(tenantId, { code: nextCode, id: { not: compId } }),
        select: { id: true },
      });
      if (dup) throw badRequest(`A salary component with code "${nextCode}" already exists`);
    }
    data.code = nextCode;
  }
  if (fields.name !== undefined) {
    if (String(fields.name).trim() === "") throw badRequest("name cannot be empty");
    data.name = String(fields.name);
  }
  if (fields.type !== undefined) {
    if (!PAY_ELEMENT_TYPES.has(fields.type)) throw badRequest(`Invalid type "${fields.type}" (EARNING|DEDUCTION)`);
    data.type = fields.type;
  }
  if (fields.taxable !== undefined) data.taxable = Boolean(fields.taxable);
  if (fields.active !== undefined) data.active = Boolean(fields.active);
  if (fields.sortOrder !== undefined) data.sortOrder = toIntOrNull(fields.sortOrder) ?? 0;
  if (fields.gradeLevelId !== undefined) data.gradeLevelId = toIntOrNull(fields.gradeLevelId);

  // Re-validate the computation when computation / value / formula changes.
  const computationChanged =
    fields.computation !== undefined ||
    fields.value !== undefined ||
    fields.formula !== undefined;
  if (computationChanged) {
    const comp = fields.computation ?? existing.computation;
    const val = fields.value !== undefined ? fields.value : existing.value;
    const fml = fields.formula !== undefined ? fields.formula : existing.formula;
    const { value: normValue, formula: normFormula } = await validateComputation({
      tenantId,
      computation: comp,
      value: val,
      formula: fml,
      excludeId: compId,
    });
    data.computation = comp;
    data.value = normValue;
    data.formula = normFormula;
  }

  // Any edit bumps version and reverts the row to DRAFT (edits are draft until
  // re-published).
  data.version = (existing.version ?? 1) + 1;
  data.status = "DRAFT";

  const updated = await prisma.salaryComponent.update({
    where: { id: compId },
    data,
    include: { gradeLevel: { select: GRADE_SELECT } },
  });
  logger.info({ id: updated.id, version: updated.version }, "salary component updated");
  return updated;
}

export async function deleteSalaryComponent({ tenantId, id }) {
  const compId = toIntOrNull(id);
  if (compId == null) throw badRequest("id is required");

  const existing = await prisma.salaryComponent.findFirst({
    where: scopedWhere(tenantId, { id: compId }),
    select: { id: true },
  });
  if (!existing) throw notFound(`Salary component ${id} not found`);

  await prisma.salaryComponent.delete({ where: { id: compId } });
  logger.info({ id: compId }, "salary component deleted");
  return { success: true, id: compId };
}

export async function getSalaryComponent({ tenantId, id }) {
  const compId = toIntOrNull(id);
  if (compId == null) throw badRequest("id is required");

  const row = await prisma.salaryComponent.findFirst({
    where: scopedWhere(tenantId, { id: compId }),
    include: { gradeLevel: { select: GRADE_SELECT } },
  });
  if (!row) throw notFound(`Salary component ${id} not found`);
  return row;
}

function toRow(c) {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    type: c.type,
    computation: c.computation,
    value: c.value,
    formula: c.formula,
    taxable: c.taxable,
    active: c.active,
    sortOrder: c.sortOrder,
    status: c.status,
    version: c.version,
    grade: c.gradeLevel ? { id: c.gradeLevel.id, name: c.gradeLevel.name } : null,
  };
}

export async function listSalaryComponents({
  tenantId,
  q,
  type,
  taxable,
  active,
  gradeLevelId,
  status,
  sortBy,
  sortDir,
  page,
  pageSize,
}) {
  const where = {};
  if (q && String(q).trim() !== "") {
    const term = String(q).trim();
    where.OR = [
      { code: { contains: term, mode: "insensitive" } },
      { name: { contains: term, mode: "insensitive" } },
    ];
  }
  if (type !== undefined && type !== null && type !== "") {
    if (!PAY_ELEMENT_TYPES.has(type)) throw badRequest(`Invalid type "${type}" (EARNING|DEDUCTION)`);
    where.type = type;
  }
  if (taxable !== undefined && taxable !== null && taxable !== "") where.taxable = Boolean(taxable);
  if (active !== undefined && active !== null && active !== "") where.active = Boolean(active);
  const gradeId = toIntOrNull(gradeLevelId);
  if (gradeId != null) where.gradeLevelId = gradeId;
  if (status !== undefined && status !== null && status !== "") {
    if (!CONFIG_STATUSES.has(status)) throw badRequest(`Invalid status "${status}" (DRAFT|PUBLISHED)`);
    where.status = status;
  }

  const sortField = SORT_FIELDS.has(sortBy) ? sortBy : "sortOrder";
  const dir = String(sortDir).toLowerCase() === "desc" ? "desc" : "asc";
  const orderBy =
    sortField === "sortOrder"
      ? [{ sortOrder: dir }, { code: "asc" }]
      : [{ [sortField]: dir }];

  const pg = Math.max(1, toIntOrNull(page) ?? 1);
  const size = Math.min(100, Math.max(1, toIntOrNull(pageSize) ?? 20));

  const scoped = scopedWhere(tenantId, where);
  const [total, rows] = await Promise.all([
    prisma.salaryComponent.count({ where: scoped }),
    prisma.salaryComponent.findMany({
      where: scoped,
      include: { gradeLevel: { select: GRADE_SELECT } },
      orderBy,
      skip: (pg - 1) * size,
      take: size,
    }),
  ]);

  return { items: rows.map(toRow), total, page: pg, pageSize: size };
}
