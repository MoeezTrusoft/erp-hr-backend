import prisma from "../lib/prisma.js";
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
      target_value: target_value ? Number(target_value) : null,
      status: "PENDING",
    }),
     employee: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      },
  });

 await logAction({
    employeeId: Number(createdBy),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Goal",
    result: "SUCCESS",
    notes: `Goal "${create.id}" Created successfully`,
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

  //const targetValue = existing.target_value ?? 0;
   let newCurrentValue = existing.current_value - progress;

   if (newCurrentValue < progress){
    throw new Error("Progress can not be greater than current progress value");

   }


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
      updatedById: Number(updatedBy),
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
  });

  return update
};

// ✅ Approve or reject goal
export const approveGoalService = async (id, status, approvedBy, tenantId) => {
  if (!["APPROVED", "REJECTED"].includes(status))
    throw new Error("Invalid status. Use APPROVED or REJECTED.");
const existing = await prisma.goal.findFirst({where: scopedWhere(tenantId, {id: Number(id)})})
if (!existing) throw new Error("Goal Not found");


  const approve =  await prisma.goal.update({
    where: { id: Number(id) },
    data: {
      status,
      approvedById: Number(approvedBy),
    },
     approvedBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      },
  });

 await logAction({
    employeeId: Number(approvedBy),
    type: "Approved Goal", // 👈 changed from CREATE to UPDATE
    module: "Goal",
    result: "SUCCESS",
    notes: `Goal "${id}" Approved successfully`,
  });

  return approve
};

// ✅ Add a progress update
export const addGoalProgressService = async (data,createdBy,tenantId) => {
  const { goalId, comment, progress, } = data;

  const goal = await prisma.goal.findFirst({ where: scopedWhere(tenantId, { id: Number(goalId) }) });
  if (!goal) throw new Error("Goal not found");

  const newProgress = await prisma.goalProgress.create({
    data: scopedData(tenantId, {
      goalId: Number(goalId),
      comment,
      progress: Number(progress),
      created_by: Number(createdBy),
    }),
     createdBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      },
  });

  // Update goal's overall progress
  await prisma.goal.update({
    where: { id: Number(goalId) },
    data: { progress: Number(progress), updated_at: new Date() },
  });

 await logAction({
    employeeId: Number(createdBy),
    type: "Add Goal Progres", // 👈 changed from CREATE to UPDATE
    module: "Goal",
    result: "SUCCESS",
    notes: `Goal Progress"${id}" Added successfully`,
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
