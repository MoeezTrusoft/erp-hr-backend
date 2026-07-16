// src/services/shiftTemplateSwap.service.js — Shift Templates, Shift Swap
// requests, and Overtime withdraw.
//
// Backs the HR "Shift Templates" library, the "Shift Swap" request workflow,
// and the overtime-request withdraw action. All reads/writes are tenant-scoped
// via the verified tenant (scopedWhere for the C.2 tables ShiftTemplate /
// ShiftAssignment / ShiftSwapRequest / OvertimeRequest; scopedEmployeeWhere for
// the snake_case Employee.tenant_id). Names (requester / target / approver) are
// resolved in one round-trip against Employee — ShiftSwapRequest has no Prisma
// relation to Employee.
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedEmployeeWhere } from "../lib/tenancy.js";
import { parseListQuery, buildListPayload } from "../utils/apiContract.js";

const employeeName = (e) =>
  e?.employee_name ||
  [e?.first_name, e?.last_name].filter(Boolean).join(" ").trim() ||
  null;

const SHIFT_TYPES = ["morning", "evening", "night"];
const WORK_MODES = ["remote", "hybrid", "onsite"];
const SWAP_STATUSES = ["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"];

const toId = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
};

const parseDate = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const badRequest = (message) =>
  Object.assign(new Error(message), { status: 400 });
const notFound = (message) => Object.assign(new Error(message), { status: 404 });

// ---------------------------------------------------------------------------
// Shift Templates
// ---------------------------------------------------------------------------

const TEMPLATE_SORTS = ["name", "fromTime", "toTime", "shiftType", "workMode", "createdAt", "id"];

const shapeTemplate = (t, assignedCount) => ({
  id: t.id,
  name: t.name,
  fromTime: t.fromTime,
  toTime: t.toTime,
  shiftType: t.shiftType,
  workMode: t.workMode ?? null,
  assignedCount,
});

/**
 * Paginated shift-template library with the assigned-employee count per
 * template (count of ShiftAssignment rows with templateId = template.id).
 */
export const listShiftTemplates = async (query = {}, tenantId) => {
  const list = parseListQuery(query, { sort: "name", order: "asc" });
  const shiftType = query.shiftType ? String(query.shiftType).toLowerCase() : null;
  const workMode = query.workMode ? String(query.workMode).toLowerCase() : null;

  const where = scopedWhere(tenantId, {
    AND: [
      list.q ? { name: { contains: list.q, mode: "insensitive" } } : {},
      shiftType ? { shiftType } : {},
      workMode ? { workMode } : {},
    ],
  });

  const sort = TEMPLATE_SORTS.includes(list.sort) ? list.sort : "name";
  const orderBy = { [sort]: list.order };

  const [rows, total] = await Promise.all([
    prisma.shiftTemplate.findMany({
      where,
      orderBy,
      skip: list.skip,
      take: list.pageSize,
    }),
    prisma.shiftTemplate.count({ where }),
  ]);

  // Assigned-employee count per template in a single grouped round-trip.
  const templateIds = rows.map((r) => r.id);
  const countByTemplate = new Map();
  if (templateIds.length) {
    const grouped = await prisma.shiftAssignment.groupBy({
      by: ["templateId"],
      where: scopedWhere(tenantId, { templateId: { in: templateIds } }),
      _count: { _all: true },
    });
    for (const g of grouped) {
      if (g.templateId != null) countByTemplate.set(g.templateId, g._count._all);
    }
  }

  const items = rows.map((t) => shapeTemplate(t, countByTemplate.get(t.id) ?? 0));

  return buildListPayload({
    ...list,
    sort,
    total,
    filters: { shiftType, workMode },
    items,
  });
};

/**
 * Create a shift template (tenant stamped fail-closed).
 */
export const createShiftTemplate = async (
  { name, fromTime, toTime, shiftType, workMode } = {},
  tenantId
) => {
  const cleanName = typeof name === "string" ? name.trim() : "";
  if (!cleanName) throw badRequest("name is required");
  if (!fromTime || typeof fromTime !== "string") throw badRequest("fromTime is required");
  if (!toTime || typeof toTime !== "string") throw badRequest("toTime is required");

  const type = shiftType ? String(shiftType).toLowerCase() : "morning";
  if (!SHIFT_TYPES.includes(type)) {
    throw badRequest(`shiftType must be one of ${SHIFT_TYPES.join(", ")}`);
  }
  let mode = null;
  if (workMode != null && workMode !== "") {
    mode = String(workMode).toLowerCase();
    if (!WORK_MODES.includes(mode)) {
      throw badRequest(`workMode must be one of ${WORK_MODES.join(", ")}`);
    }
  }

  const created = await prisma.shiftTemplate.create({
    data: {
      name: cleanName,
      fromTime,
      toTime,
      shiftType: type,
      workMode: mode,
      tenantId: tenantId ?? null,
    },
  });

  return shapeTemplate(created, 0);
};

/**
 * Update editable fields of a shift template. Tenant-scoped via updateMany so a
 * foreign-tenant id cannot be edited (404 when out of scope).
 */
export const updateShiftTemplate = async ({ id, ...patch } = {}, tenantId) => {
  const templateId = toId(id);
  if (templateId == null) throw badRequest("Valid template id is required");

  const data = {};
  if (patch.name !== undefined) {
    const cleanName = typeof patch.name === "string" ? patch.name.trim() : "";
    if (!cleanName) throw badRequest("name cannot be empty");
    data.name = cleanName;
  }
  if (patch.fromTime !== undefined) {
    if (!patch.fromTime) throw badRequest("fromTime cannot be empty");
    data.fromTime = String(patch.fromTime);
  }
  if (patch.toTime !== undefined) {
    if (!patch.toTime) throw badRequest("toTime cannot be empty");
    data.toTime = String(patch.toTime);
  }
  if (patch.shiftType !== undefined) {
    const type = String(patch.shiftType).toLowerCase();
    if (!SHIFT_TYPES.includes(type)) {
      throw badRequest(`shiftType must be one of ${SHIFT_TYPES.join(", ")}`);
    }
    data.shiftType = type;
  }
  if (patch.workMode !== undefined) {
    if (patch.workMode === null || patch.workMode === "") {
      data.workMode = null;
    } else {
      const mode = String(patch.workMode).toLowerCase();
      if (!WORK_MODES.includes(mode)) {
        throw badRequest(`workMode must be one of ${WORK_MODES.join(", ")}`);
      }
      data.workMode = mode;
    }
  }

  if (Object.keys(data).length === 0) throw badRequest("No editable fields provided");

  const result = await prisma.shiftTemplate.updateMany({
    where: scopedWhere(tenantId, { id: templateId }),
    data,
  });
  if (result.count === 0) throw notFound("Shift template not found");

  const updated = await prisma.shiftTemplate.findFirst({
    where: scopedWhere(tenantId, { id: templateId }),
  });
  const assigned = await prisma.shiftAssignment.count({
    where: scopedWhere(tenantId, { templateId }),
  });
  return shapeTemplate(updated, assigned);
};

/**
 * Hard-delete a shift template. Tenant-scoped via deleteMany (404 out of scope).
 */
export const deleteShiftTemplate = async ({ id } = {}, tenantId) => {
  const templateId = toId(id);
  if (templateId == null) throw badRequest("Valid template id is required");

  const result = await prisma.shiftTemplate.deleteMany({
    where: scopedWhere(tenantId, { id: templateId }),
  });
  if (result.count === 0) throw notFound("Shift template not found");

  return { id: templateId, deleted: true };
};

// ---------------------------------------------------------------------------
// Shift Swap requests
// ---------------------------------------------------------------------------

const SWAP_SORTS = ["fromDate", "toDate", "status", "createdAt", "decidedAt", "id"];

// Resolve requester/target/approver ids → display names in one round-trip.
const buildNameMap = async (rows, tenantId) => {
  const ids = [
    ...new Set(
      rows
        .flatMap((r) => [r.requesterId, r.targetId, r.approverId])
        .filter((v) => v != null)
    ),
  ];
  if (!ids.length) return new Map();
  const employees = await prisma.employee.findMany({
    where: scopedEmployeeWhere(tenantId, { id: { in: ids } }),
    select: { id: true, employee_name: true, first_name: true, last_name: true },
  });
  return new Map(employees.map((e) => [e.id, employeeName(e)]));
};

const shapeSwap = (r, nameMap) => ({
  id: r.id,
  requester: r.requesterId != null ? nameMap.get(r.requesterId) ?? null : null,
  target: r.targetId != null ? nameMap.get(r.targetId) ?? null : null,
  fromDate: r.fromDate,
  toDate: r.toDate ?? null,
  shiftType: r.shiftType ?? null,
  reason: r.reason ?? null,
  status: r.status,
  approver: r.approverId != null ? nameMap.get(r.approverId) ?? null : null,
});

/**
 * Paginated shift-swap requests, tenant-scoped, filterable by status.
 */
export const listShiftSwaps = async (query = {}, tenantId) => {
  const list = parseListQuery(query, { sort: "createdAt" });
  const status = query.status ? String(query.status).toUpperCase() : null;
  if (status && !SWAP_STATUSES.includes(status)) {
    throw badRequest(`status must be one of ${SWAP_STATUSES.join(", ")}`);
  }

  const where = scopedWhere(tenantId, status ? { status } : {});
  const sort = SWAP_SORTS.includes(list.sort) ? list.sort : "createdAt";
  const orderBy = { [sort]: list.order };

  const [rows, total] = await Promise.all([
    prisma.shiftSwapRequest.findMany({
      where,
      orderBy,
      skip: list.skip,
      take: list.pageSize,
    }),
    prisma.shiftSwapRequest.count({ where }),
  ]);

  const nameMap = await buildNameMap(rows, tenantId);
  const items = rows.map((r) => shapeSwap(r, nameMap));

  return buildListPayload({ ...list, sort, total, filters: { status }, items });
};

/**
 * Create a shift-swap request (status PENDING). Tenant stamped fail-closed.
 */
export const createShiftSwap = async (
  { requesterId, targetId, fromDate, toDate, shiftType, reason } = {},
  tenantId
) => {
  const reqId = toId(requesterId);
  if (reqId == null) throw badRequest("requesterId is required");

  let tgtId = null;
  if (targetId !== undefined && targetId !== null && targetId !== "") {
    tgtId = toId(targetId);
    if (tgtId == null) throw badRequest("targetId must be a valid id");
  }

  const from = parseDate(fromDate);
  if (!from) throw badRequest("Valid fromDate is required");
  const to = parseDate(toDate); // optional

  let type = null;
  if (shiftType != null && shiftType !== "") {
    type = String(shiftType).toLowerCase();
    if (!SHIFT_TYPES.includes(type)) {
      throw badRequest(`shiftType must be one of ${SHIFT_TYPES.join(", ")}`);
    }
  }

  const created = await prisma.shiftSwapRequest.create({
    data: {
      requesterId: reqId,
      targetId: tgtId,
      fromDate: from,
      toDate: to,
      shiftType: type,
      reason: reason ?? null,
      status: "PENDING",
      tenantId: tenantId ?? null,
    },
  });

  const nameMap = await buildNameMap([created], tenantId);
  return shapeSwap(created, nameMap);
};

/**
 * Update editable fields of a shift-swap request — only while PENDING.
 * Tenant-scoped; 404 out of scope, 409 when not PENDING.
 */
export const updateShiftSwap = async ({ id, ...patch } = {}, tenantId) => {
  const swapId = toId(id);
  if (swapId == null) throw badRequest("Valid swap id is required");

  const existing = await prisma.shiftSwapRequest.findFirst({
    where: scopedWhere(tenantId, { id: swapId }),
  });
  if (!existing) throw notFound("Shift swap request not found");
  if (existing.status !== "PENDING") {
    throw Object.assign(
      new Error("Only PENDING shift swap requests can be edited"),
      { status: 409 }
    );
  }

  const data = {};
  if (patch.targetId !== undefined) {
    if (patch.targetId === null || patch.targetId === "") {
      data.targetId = null;
    } else {
      const tgtId = toId(patch.targetId);
      if (tgtId == null) throw badRequest("targetId must be a valid id");
      data.targetId = tgtId;
    }
  }
  if (patch.fromDate !== undefined) {
    const from = parseDate(patch.fromDate);
    if (!from) throw badRequest("fromDate must be a valid date");
    data.fromDate = from;
  }
  if (patch.toDate !== undefined) {
    if (patch.toDate === null || patch.toDate === "") {
      data.toDate = null;
    } else {
      const to = parseDate(patch.toDate);
      if (!to) throw badRequest("toDate must be a valid date");
      data.toDate = to;
    }
  }
  if (patch.shiftType !== undefined) {
    if (patch.shiftType === null || patch.shiftType === "") {
      data.shiftType = null;
    } else {
      const type = String(patch.shiftType).toLowerCase();
      if (!SHIFT_TYPES.includes(type)) {
        throw badRequest(`shiftType must be one of ${SHIFT_TYPES.join(", ")}`);
      }
      data.shiftType = type;
    }
  }
  if (patch.reason !== undefined) {
    data.reason = patch.reason === "" ? null : patch.reason ?? null;
  }

  if (Object.keys(data).length === 0) throw badRequest("No editable fields provided");

  await prisma.shiftSwapRequest.updateMany({
    where: scopedWhere(tenantId, { id: swapId, status: "PENDING" }),
    data,
  });

  const updated = await prisma.shiftSwapRequest.findFirst({
    where: scopedWhere(tenantId, { id: swapId }),
  });
  const nameMap = await buildNameMap([updated], tenantId);
  return shapeSwap(updated, nameMap);
};

/**
 * Decide a shift-swap request: approve / reject / withdraw. Sets status +
 * decidedAt(now); approve/reject also stamp approverId (the caller's employee
 * id). Tenant-scoped via updateMany (404 out of scope).
 */
export const decideShiftSwap = async (
  { id, decision, approverEmployeeId } = {},
  tenantId
) => {
  const swapId = toId(id);
  if (swapId == null) throw badRequest("Valid swap id is required");

  const normalized = String(decision || "").toLowerCase();
  const statusByDecision = {
    approve: "APPROVED",
    reject: "REJECTED",
    withdraw: "WITHDRAWN",
  };
  const status = statusByDecision[normalized] || null;
  if (!status) {
    throw badRequest("decision must be 'approve', 'reject', or 'withdraw'");
  }

  const data = { status, decidedAt: new Date() };
  // withdraw is requester-initiated — no approver is stamped.
  if (status !== "WITHDRAWN") {
    data.approverId = toId(approverEmployeeId);
  }

  const result = await prisma.shiftSwapRequest.updateMany({
    where: scopedWhere(tenantId, { id: swapId }),
    data,
  });
  if (result.count === 0) throw notFound("Shift swap request not found");

  const updated = await prisma.shiftSwapRequest.findFirst({
    where: scopedWhere(tenantId, { id: swapId }),
  });
  const nameMap = await buildNameMap([updated], tenantId);
  return shapeSwap(updated, nameMap);
};

// ---------------------------------------------------------------------------
// Overtime withdraw
// ---------------------------------------------------------------------------

/**
 * Withdraw an overtime request → status WITHDRAWN. Tenant-scoped via updateMany
 * so a foreign-tenant id cannot be withdrawn (404 out of scope). Approve/reject
 * remain on the existing decideOvertimeRequest / hr_overtime_request_decide.
 */
export const withdrawOvertimeRequest = async ({ id } = {}, tenantId) => {
  const reqId = toId(id);
  if (reqId == null) throw badRequest("Valid request id is required");

  const result = await prisma.overtimeRequest.updateMany({
    where: scopedWhere(tenantId, { id: reqId }),
    data: { status: "WITHDRAWN", decidedAt: new Date() },
  });
  if (result.count === 0) throw notFound("Overtime request not found");

  const updated = await prisma.overtimeRequest.findFirst({
    where: scopedWhere(tenantId, { id: reqId }),
  });

  return {
    reqId: updated.id,
    employeeId: updated.employeeId,
    status: updated.status,
    decidedAt: updated.decidedAt ?? null,
  };
};
