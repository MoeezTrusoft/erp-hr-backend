import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// ✅ Create a new goal
export const createGoalService = async (data) => {
  const { employeeId, title, description, category, start_date, end_date, target_value } = data;

  if (!employeeId || !title) throw new Error("Employee ID and Title are required");

  return prisma.goal.create({
    data: {
      employeeId: Number(employeeId),
      title,
      description,
      category,
      start_date: new Date(start_date),
      end_date: new Date(end_date),
      target_value: target_value ? Number(target_value) : null,
      status: "PENDING",
    },
  });
};

// ✅ Get goals (all or by employee)
export const getGoalsService = async (employeeId) => {
  const where = employeeId ? { employeeId: Number(employeeId) } : {};
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
export const updateGoalService = async (id, data) => {
  const { title, description, progress, status } = data;

  // Find existing goal
  const existing = await prisma.goal.findUnique({ where: { id: Number(id) } });
  if (!existing) throw new Error("Goal not found");

  //const targetValue = existing.target_value ?? 0;
   let newCurrentValue = existing.current_value - progress;

   if (newCurrentValue < progress){
    throw new Error("Progress can not be greater than current progress value");
    
   }


  // Update goal
  return prisma.goal.update({
    where: { id: Number(id) },
    data: {
      title: title ?? existing.title,
      description: description ?? existing.description,
      progress: progress ?? existing.progress,
      current_value: newCurrentValue,
      status: status ?? existing.status,
    },
  });
};

// ✅ Approve or reject goal
export const approveGoalService = async (id, approverId, status) => {
  if (!["APPROVED", "REJECTED"].includes(status))
    throw new Error("Invalid status. Use APPROVED or REJECTED.");

  return prisma.goal.update({
    where: { id: Number(id) },
    data: {
      status,
      approvedById: Number(approverId),
    },
  });
};

// ✅ Add a progress update
export const addGoalProgressService = async (data) => {
  const { goalId, comment, progress, created_by } = data;

  const goal = await prisma.goal.findUnique({ where: { id: Number(goalId) } });
  if (!goal) throw new Error("Goal not found");

  const newProgress = await prisma.goalProgress.create({
    data: {
      goalId: Number(goalId),
      comment,
      progress: Number(progress),
      created_by: Number(created_by),
    },
  });

  // Update goal's overall progress
  await prisma.goal.update({
    where: { id: Number(goalId) },
    data: { progress: Number(progress), updated_at: new Date() },
  });

  return newProgress;
};

// ✅ Get all progress updates for a goal
export const getGoalProgressService = async (id) => {
  return prisma.goalProgress.findMany({
    where: { goalId: Number(id) },
    include: { createdBy: true },
    orderBy: { update_date: "desc" },
  });
};
