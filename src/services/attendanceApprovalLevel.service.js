// src/services/attendanceApprovalLevel.service.js
//
// Payroll Setup → Attendance Anomaly Approval Chain. Ordered levels, ascending:
// typically 1 = the requester's own manager, 2 = HR, 3 = management.
//
// Level 1 usually sets useEmployeeManager, which resolves the approver from the
// requester's Employee.managerId at routing time rather than pinning one person.
// HR and management are real people chosen from the employee list, so those
// levels carry an approverId — hence listApproverCandidates() below, which backs
// the picker on the Payroll Setup screen.
//
// skipIfUnresolved implements "if the manager does not exist, hop to the next
// level": an unresolvable level is stepped over, not left blocking.
//
// HR-ATT-POLICY-01.
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import logger from "../lib/logger.js";

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
}

export async function listApprovalLevels({ tenantId }) {
  return prisma.attendanceApprovalLevel.findMany({
    where: { tenantId },
    orderBy: { level: "asc" },
    include: {
      approver: {
        select: { id: true, employee_code: true, employee_name: true, job_title: true },
      },
    },
  });
}

/**
 * Employees selectable as approvers. RLS scopes this to the caller's tenant, so
 * an approver can never be set to someone in another company.
 */
export async function listApproverCandidates({ tenantId, search, limit = 50 } = {}) {
  const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const term = typeof search === "string" ? search.trim() : "";

  const where = {};
  if (term) {
    where.OR = [
      { employee_name: { contains: term, mode: "insensitive" } },
      { first_name: { contains: term, mode: "insensitive" } },
      { last_name: { contains: term, mode: "insensitive" } },
      { employee_code: { contains: term, mode: "insensitive" } },
    ];
  }

  const rows = await prisma.employee.findMany({
    where,
    select: {
      id: true,
      employee_code: true,
      employee_name: true,
      first_name: true,
      last_name: true,
      job_title: true,
    },
    orderBy: { employee_code: "asc" },
    take,
  });

  return rows.map((e) => ({
    id: e.id,
    employee_code: e.employee_code,
    // employee_name is not always populated; fall back to the name parts.
    name: e.employee_name || [e.first_name, e.last_name].filter(Boolean).join(" ") || e.employee_code,
    job_title: e.job_title,
  }));
}

export async function upsertApprovalLevel({ tenantId, level, ...input }) {
  const lvl = Number(level);
  if (!Number.isInteger(lvl) || lvl < 1) throw badRequest("level must be a whole number >= 1");

  const data = {};

  if (input.role !== undefined) {
    const role = String(input.role).trim();
    if (!role) throw badRequest("role is required");
    data.role = role;
  }

  if (input.useEmployeeManager !== undefined) {
    data.useEmployeeManager = Boolean(input.useEmployeeManager);
  }
  if (input.skipIfUnresolved !== undefined) {
    data.skipIfUnresolved = Boolean(input.skipIfUnresolved);
  }

  if (input.approverId !== undefined) {
    if (input.approverId === null) {
      data.approverId = null;
    } else {
      const id = Number(input.approverId);
      if (!Number.isInteger(id) || id < 1) throw badRequest("approverId must be a positive integer");
      // findUnique is RLS-scoped, so an id from another tenant reads as missing.
      const approver = await prisma.employee.findUnique({ where: { id }, select: { id: true } });
      if (!approver) throw notFound(`Employee ${id} not found in this tenant`);
      data.approverId = id;
    }
  }

  if (input.autoEscalateAfterHours !== undefined) {
    if (input.autoEscalateAfterHours === null) {
      data.autoEscalateAfterHours = null;
    } else {
      const n = Number(input.autoEscalateAfterHours);
      if (!Number.isInteger(n) || n < 1) {
        throw badRequest("autoEscalateAfterHours must be null or a whole number >= 1");
      }
      data.autoEscalateAfterHours = n;
    }
  }

  if (input.rowStatus !== undefined) {
    const s = String(input.rowStatus).trim().toUpperCase();
    if (!["ACTIVE", "INACTIVE"].includes(s)) throw badRequest("rowStatus must be ACTIVE or INACTIVE");
    data.rowStatus = s;
  }

  // A level with neither a fixed approver nor dynamic manager resolution can
  // never route to anybody. Reject it at config time rather than discovering it
  // when a request silently skips every level and auto-approves.
  const existing = await prisma.attendanceApprovalLevel.findUnique({
    where: { tenantId_level: { tenantId, level: lvl } },
  });
  const effectiveApprover = data.approverId !== undefined ? data.approverId : existing?.approverId ?? null;
  const effectiveManager =
    data.useEmployeeManager !== undefined
      ? data.useEmployeeManager
      : existing?.useEmployeeManager ?? false;
  if (!effectiveApprover && !effectiveManager) {
    throw badRequest("A level needs either an approverId or useEmployeeManager=true");
  }
  if (!existing && data.role === undefined) throw badRequest("role is required");

  const row = await tenantTransaction(prisma, async (tx) => {
    return tx.attendanceApprovalLevel.upsert({
      where: { tenantId_level: { tenantId, level: lvl } },
      create: { tenantId, level: lvl, role: data.role, ...data, status: "DRAFT", version: 1 },
      update: { ...data, status: "DRAFT", version: { increment: 1 } },
    });
  });

  logger.info({ id: row.id, level: lvl, role: row.role }, "attendance approval level updated");
  return row;
}

export async function deleteApprovalLevel({ tenantId, level }) {
  const lvl = Number(level);
  if (!Number.isInteger(lvl) || lvl < 1) throw badRequest("level must be a whole number >= 1");

  return tenantTransaction(prisma, async (tx) => {
    const existing = await tx.attendanceApprovalLevel.findUnique({
      where: { tenantId_level: { tenantId, level: lvl } },
    });
    if (!existing) throw notFound(`Approval level ${lvl} not found`);
    await tx.attendanceApprovalLevel.delete({ where: { id: existing.id } });
    logger.info({ id: existing.id, level: lvl }, "attendance approval level deleted");
    return { deleted: true, level: lvl };
  });
}
