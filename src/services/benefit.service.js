// src/services/benefit.service.js — HR-BENEFITS-04
//
// Per-employee benefits: benefit plans (health / retirement / allowance / other)
// + an Employee↔BenefitPlan enrollment join. Tenant-scoped fail-closed via the
// shared tenancy helpers (the VERIFIED tenant on req.user.tenantId — T-P2.1) so
// tenant B can never read/mutate tenant A's plans or enrollments; a cross-tenant
// reference resolves to not-found, never another tenant's row.
//
// MONEY: employer/employee contributions and the employee's elected amount are
// persisted in INTEGER MINOR UNITS (cents) via src/lib/money.js, and converted
// back to major-unit Numbers at the API boundary (serialize helpers below).
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { fromMajor, toMajor } from "../lib/money.js";

const BENEFIT_TYPES = new Set(["HEALTH", "RETIREMENT", "ALLOWANCE", "OTHER"]);

const err = (code, message, statusCode = 400) =>
  Object.assign(new Error(message), { code, statusCode });

// Major-unit Number → integer minor units (null/undefined passes through).
const toMinor = (major) =>
  major === null || major === undefined || major === "" ? undefined : fromMajor(Number(major));

// Integer minor units → major-unit Number (null/undefined passes through).
const toMajorOrNull = (minor) =>
  minor === null || minor === undefined ? null : toMajor(minor);

// Boundary serializers — never leak the *Minor columns to the API.
const serializePlan = (p) =>
  !p
    ? p
    : {
        id: p.id,
        tenantId: p.tenantId,
        name: p.name,
        type: p.type,
        description: p.description ?? null,
        employerContribution: toMajorOrNull(p.employerContributionMinor),
        employeeContribution: toMajorOrNull(p.employeeContributionMinor),
        active: p.active,
        created_at: p.created_at,
        updated_at: p.updated_at,
      };

const serializeEnrollment = (e) =>
  !e
    ? e
    : {
        id: e.id,
        tenantId: e.tenantId,
        employeeId: e.employeeId,
        benefitPlanId: e.benefitPlanId,
        enrolledAt: e.enrolledAt,
        status: e.status,
        electedAmount: toMajorOrNull(e.electedAmountMinor),
        ...(e.benefitPlan !== undefined ? { benefitPlan: serializePlan(e.benefitPlan) } : {}),
      };

// ── Benefit plan CRUD ─────────────────────────────────────────────────────────
export const createPlan = async ({
  name,
  type,
  description,
  employerContribution,
  employeeContribution,
  active,
  tenantId,
}) => {
  if (!name || !String(name).trim()) throw err("HR-4101", "Benefit plan name is required");
  if (!BENEFIT_TYPES.has(type)) throw err("HR-4102", `Invalid benefit type: ${type}`);

  const plan = await prisma.benefitPlan.create({
    data: scopedData(tenantId, {
      name: String(name).trim(),
      type,
      description: description ?? null,
      employerContributionMinor: toMinor(employerContribution) ?? null,
      employeeContributionMinor: toMinor(employeeContribution) ?? null,
      active: active === undefined ? true : Boolean(active),
    }),
  });
  return serializePlan(plan);
};

export const listPlans = async ({ type, active, tenantId } = {}) => {
  if (type !== undefined && !BENEFIT_TYPES.has(type)) throw err("HR-4102", `Invalid benefit type: ${type}`);
  const where = scopedWhere(tenantId, {
    ...(type ? { type } : {}),
    ...(active === undefined ? {} : { active: active === true || active === "true" }),
  });
  const plans = await prisma.benefitPlan.findMany({ where, orderBy: { created_at: "desc" } });
  return plans.map(serializePlan);
};

export const getPlan = async (id, tenantId) => {
  const plan = await prisma.benefitPlan.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!plan) throw err("HR-4103", "Benefit plan not found", 404);
  return serializePlan(plan);
};

export const updatePlan = async (id, patch = {}, tenantId) => {
  const existing = await prisma.benefitPlan.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
  });
  if (!existing) throw err("HR-4103", "Benefit plan not found", 404);
  if (patch.type !== undefined && !BENEFIT_TYPES.has(patch.type)) {
    throw err("HR-4102", `Invalid benefit type: ${patch.type}`);
  }

  const data = {};
  if (patch.name !== undefined) {
    if (!String(patch.name).trim()) throw err("HR-4101", "Benefit plan name is required");
    data.name = String(patch.name).trim();
  }
  if (patch.type !== undefined) data.type = patch.type;
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.active !== undefined) data.active = Boolean(patch.active);
  if (patch.employerContribution !== undefined) {
    data.employerContributionMinor = toMinor(patch.employerContribution) ?? null;
  }
  if (patch.employeeContribution !== undefined) {
    data.employeeContributionMinor = toMinor(patch.employeeContribution) ?? null;
  }

  const updated = await prisma.benefitPlan.update({ where: { id: existing.id }, data });
  return serializePlan(updated);
};

export const deletePlan = async (id, tenantId) => {
  const existing = await prisma.benefitPlan.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
  });
  if (!existing) throw err("HR-4103", "Benefit plan not found", 404);
  await prisma.benefitPlan.delete({ where: { id: existing.id } });
  return { id: existing.id, deleted: true };
};

// ── Enrollment ────────────────────────────────────────────────────────────────
export const enrollEmployee = async ({ employeeId, benefitPlanId, electedAmount, tenantId }) => {
  if (!employeeId) throw err("HR-4104", "employeeId is required");
  if (!benefitPlanId) throw err("HR-4105", "benefitPlanId is required");

  // Fail-closed: the plan must exist IN THE CALLER'S TENANT. A cross-tenant
  // (or missing) plan id resolves to not-found, never another tenant's plan.
  const plan = await prisma.benefitPlan.findFirst({
    where: scopedWhere(tenantId, { id: Number(benefitPlanId) }),
  });
  if (!plan) throw err("HR-4103", "Benefit plan not found", 404);

  // Reject a duplicate ACTIVE enrollment of the same employee in the same plan.
  const active = await prisma.employeeBenefit.findFirst({
    where: scopedWhere(tenantId, {
      employeeId: Number(employeeId),
      benefitPlanId: Number(benefitPlanId),
      status: "ACTIVE",
    }),
  });
  if (active) throw err("HR-4106", "Employee is already enrolled in this benefit plan");

  const enrollment = await prisma.employeeBenefit.create({
    data: scopedData(tenantId, {
      employeeId: Number(employeeId),
      benefitPlanId: Number(benefitPlanId),
      enrolledAt: new Date(),
      status: "ACTIVE",
      electedAmountMinor: toMinor(electedAmount) ?? null,
    }),
  });
  return serializeEnrollment(enrollment);
};

export const unenrollEmployee = async ({ employeeId, benefitPlanId, tenantId }) => {
  const enrollment = await prisma.employeeBenefit.findFirst({
    where: scopedWhere(tenantId, {
      employeeId: Number(employeeId),
      benefitPlanId: Number(benefitPlanId),
      status: "ACTIVE",
    }),
  });
  if (!enrollment) throw err("HR-4107", "Active enrollment not found", 404);

  const updated = await prisma.employeeBenefit.update({
    where: { id: enrollment.id },
    data: { status: "TERMINATED" },
  });
  return serializeEnrollment(updated);
};

export const listEmployeeBenefits = async ({ employeeId, status, tenantId }) => {
  const where = scopedWhere(tenantId, {
    employeeId: Number(employeeId),
    // Default to ACTIVE enrollments; an explicit status overrides.
    status: status === undefined ? "ACTIVE" : status,
  });
  const enrollments = await prisma.employeeBenefit.findMany({
    where,
    orderBy: { enrolledAt: "desc" },
    include: { benefitPlan: true },
  });
  return enrollments.map(serializeEnrollment);
};
