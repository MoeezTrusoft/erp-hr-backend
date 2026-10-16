import { legacyWithdraw, legacyDecision } from "./approval/legacy.js";
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
import { tenantTransaction } from '../lib/rlsTenant.js';
import { validateShiftMapping, bindRosterShifts, validateEmployeeShiftSequence, queueChangedShift, shiftForEmployee } from './shiftGovernance.service.js';
import { dateKey } from '../lib/attendanceDates.js';
import { civilNow } from '../lib/attendanceClock.js';
import { assertRosterPeriodEditable } from './workScheduleService.js';

const employeeName = (e) =>
  e?.employee_code ||
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
  departmentId: t.departmentId ?? null,
  department: t.department?.name ?? null,
  supervisorCode: t.supervisor?.employee_code ?? null,
  checkoutCutoffTime: t.checkoutCutoffTime ?? null,
  checkoutCutoffDayOffset: t.checkoutCutoffDayOffset ?? 0,
  assignedCount,
});
const templateInclude = { department: true, supervisor: {select:{employee_code:true}} };
const rosterWindows=p=>[p?.shift,...(Array.isArray(p?.shifts)?p.shifts:[]),...(Array.isArray(p?.rotatingShifts)?p.rotatingShifts:[]),...Object.values(p?.shiftByDay||{})].filter(Boolean);
async function validateTemplateUse(tx,tenantId,previous,{schedules,employees,overrides,templates,today}) {
  for(const employee of employees) {
    const matches=w=>Number(w.templateId)===previous.id || (!w.templateId && previous.departmentId===employee.businessUnitId && w.from===previous.fromTime && w.to===previous.toTime);
    const own=schedules.filter(s=>s.employeeId===employee.id);
    const active=s=>!s.effective_end_date || dateKey(s.effective_end_date)>=today;
    const assigned=overrides.filter(a=>a.employeeId===employee.id);
    if(!own.some(s=>active(s)&&rosterWindows(s.schedule_pattern).some(matches)) && !assigned.some(a=>a.templateId===previous.id&&dateKey(a.date)>=today)) continue;
    const proposed=await Promise.all(own.map(async s=>{
      if(!active(s)) return s;
      const pattern=structuredClone(s.schedule_pattern);
      for(const window of rosterWindows(pattern)) if(matches(window)) window.templateId=previous.id;
      return {...s,schedule_pattern:await bindRosterShifts(tx,tenantId,employee,pattern,templates)};
    }));
    for(const assignment of assigned.filter(a=>a.templateId===previous.id&&dateKey(a.date)>=today))
      await shiftForEmployee(tx,tenantId,employee,assignment,templates);
    validateEmployeeShiftSequence(proposed,assigned);
  }
}
async function mappingData(tx, tenantId, patch) {
  const data={};
  if(patch.departmentId!==undefined) {
    data.departmentId=patch.departmentId===null ? null : Number(patch.departmentId);
    if(data.departmentId!==null && (!Number.isInteger(data.departmentId)||data.departmentId<1)) throw badRequest('Invalid department');
  }
  if(patch.supervisorCode!==undefined) {
    const code=String(patch.supervisorCode||'').trim();
    const employee=code ? await tx.employee.findFirst({where:{tenant_id:tenantId,employee_code:code,status:'Active'}}) : null;
    if(code&&!employee) throw badRequest('Active supervisor employee code not found in this company');
    data.supervisorId=employee?.id ?? null;
  }
  if(patch.checkoutCutoffTime!==undefined) data.checkoutCutoffTime=patch.checkoutCutoffTime||null;
  if(patch.checkoutCutoffDayOffset!==undefined) data.checkoutCutoffDayOffset=Number(patch.checkoutCutoffDayOffset);
  return data;
}

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
      include: templateInclude,
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

  const [departments,supervisors]=await Promise.all([
    prisma.businessUnit.findMany({where:{tenantId},select:{id:true,name:true},orderBy:{name:'asc'}}),
    prisma.employee.findMany({where:scopedEmployeeWhere(tenantId,{status:'Active'}),select:{employee_code:true,businessUnitId:true},orderBy:{employee_code:'asc'}}),
  ]);
  return {...buildListPayload({
    ...list,
    sort,
    total,
    filters: { shiftType, workMode },
    items,
  }),departments,supervisors};
};

/**
 * Create a shift template (tenant stamped fail-closed).
 */
export const createShiftTemplate = async (
  { name, fromTime, toTime, shiftType, workMode, ...mapping } = {},
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

  const created = await tenantTransaction(prisma,async tx=>{
    const data = {
      name: cleanName,
      fromTime,
      toTime,
      shiftType: type,
      workMode: mode,
      tenantId: tenantId ?? null,
      ...await mappingData(tx,tenantId,mapping),
    };
    await validateShiftMapping(tx,tenantId,data);
    const row=await tx.shiftTemplate.create({data,include:templateInclude});
    const [schedules,employees,overrides,templates,draft]=await Promise.all([
      tx.workSchedule.findMany({where:{tenantId}}),tx.employee.findMany({where:{tenant_id:tenantId}}),
      tx.shiftAssignment.findMany({where:{tenantId}}),tx.shiftTemplate.findMany({where:{tenantId}}),
      tx.attendanceSetupDraft.findUnique({where:{tenantId}}),
    ]);
    await validateTemplateUse(tx,tenantId,row,{schedules,employees,overrides,templates,
      today:dateKey(civilNow(new Date(),draft?.settings?.timeZone||'Asia/Karachi'))});
    return row;
  },{tenantId,txOptions:{isolationLevel:'Serializable'}});

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

  return tenantTransaction(prisma,async tx=>{
  Object.assign(data,await mappingData(tx,tenantId,patch));
  if (Object.keys(data).length === 0) throw badRequest("No editable fields provided");
  const previous=await tx.shiftTemplate.findFirst({where:scopedWhere(tenantId,{id:templateId})});
  if(!previous) throw notFound('Shift template not found');
  await validateShiftMapping(tx,tenantId,{...previous,...data});
  const result = await tx.shiftTemplate.updateMany({
    where: scopedWhere(tenantId, { id: templateId }),
    data,
  });
  if (result.count === 0) throw notFound("Shift template not found");

  // Rebind proposed patterns for validation only. Published setup remains a
  // versioned snapshot; revised cutoffs take effect when HR republishes it.
  const schedules=await tx.workSchedule.findMany({where:{tenantId}});
  const employees=await tx.employee.findMany({where:{tenant_id:tenantId}});
  const overrides=await tx.shiftAssignment.findMany({where:{tenantId}});
  const templates=await tx.shiftTemplate.findMany({where:{tenantId}});
  const draft=await tx.attendanceSetupDraft.findUnique({where:{tenantId}});
  const today=dateKey(civilNow(new Date(),draft?.settings?.timeZone||'Asia/Karachi'));
  const changed={...previous,...data};
  const changedAssignments=overrides.filter(a=>a.templateId===templateId && dateKey(a.date)>=today).map(a=>({...a,
    fromTime:changed.fromTime,toTime:changed.toTime,checkoutCutoffTime:changed.checkoutCutoffTime,checkoutCutoffDayOffset:changed.checkoutCutoffDayOffset}));
  await validateTemplateUse(tx,tenantId,previous,{schedules,employees,templates,today,
    overrides:overrides.map(a=>changedAssignments.find(c=>c.id===a.id)||a)});
  for(const assignment of changedAssignments) {
    await assertRosterPeriodEditable(tx,tenantId,assignment.date,assignment.date);
    await tx.shiftAssignment.update({where:{id:assignment.id},data:{fromTime:assignment.fromTime,toTime:assignment.toTime,
      checkoutCutoffTime:assignment.checkoutCutoffTime,checkoutCutoffDayOffset:assignment.checkoutCutoffDayOffset}});
    await queueChangedShift(tx,tenantId,assignment.employeeId,assignment.date,today);
  }
  const updated = await tx.shiftTemplate.findFirst({
    where: scopedWhere(tenantId, { id: templateId }),
    include: templateInclude,
  });
  const assigned = await tx.shiftAssignment.count({
    where: scopedWhere(tenantId, { templateId }),
  });
  return shapeTemplate(updated, assigned);
  },{tenantId,txOptions:{isolationLevel:'Serializable'}});
};

/**
 * Hard-delete a shift template. Tenant-scoped via deleteMany (404 out of scope).
 */
export const deleteShiftTemplate = async ({ id } = {}, tenantId) => {
  const templateId = toId(id);
  if (templateId == null) throw badRequest("Valid template id is required");

  return tenantTransaction(prisma,async tx=>{
  const used=await tx.shiftAssignment.count({where:scopedWhere(tenantId,{templateId})});
  const rosters=await tx.workSchedule.findMany({where:{tenantId}});
  if(used || rosters.some(r=>rosterWindows(r.schedule_pattern).some(w=>Number(w.templateId)===templateId)))
    throw Object.assign(new Error('This shift is referenced by a roster or assignment and cannot be deleted'),{status:409});
  const result = await tx.shiftTemplate.deleteMany({
    where: scopedWhere(tenantId, { id: templateId }),
  });
  if (result.count === 0) throw notFound("Shift template not found");

  return { id: templateId, deleted: true };
  },{tenantId,txOptions:{isolationLevel:'Serializable'}});
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
    select: { id: true, employee_code: true },
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
  if(['WITHDRAW','WITHDRAWN'].includes(decision))return legacyWithdraw('SHIFT_SWAP',id);return legacyDecision('SHIFT_SWAP',id);
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
  return legacyWithdraw('OVERTIME',id);
};
