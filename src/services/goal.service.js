import { legacyDecision } from "./approval/legacy.js";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { logAction } from "../utils/logs.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { normalizeExpectedVersion, preconditionFailedError } from "../lib/optimisticConcurrency.js";

// C.2 — verified tenant (T-P2.1) threaded in as a trailing `tenantId`; folded
// into goal reads and stamped on creates, fail-closed when present.

// ✅ Create a new goal
export const createGoalService = async (data, createdBy, tenantId) => {
  const { employeeId, title, description, category, start_date, end_date, target_value } = data;

  if (!employeeId || !title) throw new Error("Employee ID and Title are required");

  const create = await prisma.goal.create({
    data: scopedData(tenantId, {
      employeeId: Number(employeeId),
      title,
      description,
      category,
      start_date: new Date(start_date),
      end_date: new Date(end_date),
      target_value: target_value == null ? null : Number(target_value),
      status: "PENDING",
    }),
  });

 await logAction({
    employeeId: Number(createdBy),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Goal",
    result: "SUCCESS",
    notes: `Goal "${create.id}" Created successfully`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });
  return create
};

// ✅ Get goals (all or by employee)
export const getGoalsService = async (employeeId, tenantId) => {
  const where = scopedWhere(tenantId, employeeId ? { employeeId: Number(employeeId) } : {});
  return prisma.goal.findMany({
    where,
    include: {
      employee: true,
      approvedBy: true,
      progressUpdates: { orderBy: { update_date: "desc" } },
    },
    orderBy: { created_at: "desc" },
  });
};

// ✅ Update goal details or progress
export const updateGoalService = async (id, data,updatedBy,tenantId) => {
  const { title, description, progress, status } = data;

  // API-2 — optimistic-concurrency guard (opt-in via expectedVersion). Absent ⇒ no reject.
  const expectedVersion = normalizeExpectedVersion(data?.expectedVersion);

  // Find existing goal (tenant-scoped pre-read; cross-tenant id → not-found)
  const existing = await prisma.goal.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!existing) throw new Error("Goal not found");

  if (progress !== undefined && (!Number.isFinite(progress) || progress < 0 || progress > 100)) throw Object.assign(new Error('Progress must be from 0 to 100'), {status:422});
  if (status === 'APPROVED' || status === 'REJECTED') throw Object.assign(new Error('Use the goal approval workflow'), {status:409});
  const newCurrentValue = existing.current_value;

  // Update goal — API-2 atomic compare-and-set + version bump, tenant-scoped.
  const versionWhere = expectedVersion == null ? {} : { version: expectedVersion };
  const { count } = await prisma.goal.updateMany({
    where: scopedWhere(tenantId, { id: Number(id), ...versionWhere }),
    data: {
      title: title ?? existing.title,
      description: description ?? existing.description,
      progress: progress ?? existing.progress,
      current_value: newCurrentValue,
      status: status ?? existing.status,

      version: { increment: 1 },
    },
  });
  if (count === 0 && expectedVersion != null) {
    const fresh = await prisma.goal.findFirst({
      where: scopedWhere(tenantId, { id: Number(id) }),
      select: { version: true },
    });
    throw preconditionFailedError(fresh?.version);
  }
  const update = await prisma.goal.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });

   await logAction({
    employeeId: Number(updatedBy),
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Goal",
    result: "SUCCESS",
    notes: `Goal "${id}" Updated successfully`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return update
};

// ✅ Approve or reject goal
export const approveGoalService = async (id, status, approvedBy, tenantId) => {
  return legacyDecision('GOAL',id);
};

// ✅ Add a progress update
export const addGoalProgressService = async (data,createdBy,tenantId) => {
  const { goalId, comment, progress, } = data;

  if (!Number.isFinite(Number(progress)) || Number(progress)<0 || Number(progress)>100) throw Object.assign(new Error('Progress must be from 0 to 100'),{status:422});
  const newProgress=await tenantTransaction(prisma,async tx=>{
    const goal=await tx.goal.findFirst({where:scopedWhere(tenantId,{id:Number(goalId)})});
    if(!goal)throw Object.assign(new Error('Goal not found'),{status:404});
    const expectedVersion=normalizeExpectedVersion(data.expectedVersion);
    if(expectedVersion!==null && expectedVersion!==undefined && expectedVersion!==goal.version)throw preconditionFailedError(goal.version);
    const changed=await tx.goal.updateMany({where:scopedWhere(tenantId,{id:goal.id,version:goal.version}),data:{progress:Number(progress),version:{increment:1}}});
    if(changed.count!==1)throw preconditionFailedError();
    return tx.goalProgress.create({data:scopedData(tenantId,{goalId:goal.id,comment,progress:Number(progress),created_by:Number(createdBy)})});
  },{tenantId});

 await logAction({
    employeeId: Number(createdBy),
    type: "Add Goal Progres", // 👈 changed from CREATE to UPDATE
    module: "Goal",
    result: "SUCCESS",
    notes: `Goal Progress"${goalId}" Added successfully`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return newProgress;
};

// ✅ Get all progress updates for a goal
export const getGoalProgressService = async (id, tenantId) => {

  const goal = await prisma.goal.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!goal) throw new Error("Goal not found");

  return prisma.goalProgress.findMany({
    where: scopedWhere(tenantId, { goalId: Number(id) }),
    include: { createdBy: true },
    orderBy: { update_date: "desc" },
  });
};
