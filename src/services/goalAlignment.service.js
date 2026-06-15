import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";

// ✅ Create alignment between two goals
export const createGoalAlignmentService = async (data, createdBy) => {
  const { parentGoalId, alignedGoalId } = data;

  if (!parentGoalId || !alignedGoalId)
    throw new Error("Both parentGoalId and alignedGoalId are required");

  if (parentGoalId === alignedGoalId)
    throw new Error("A goal cannot be aligned to itself");

  // Check both goals exist
  const [parentGoal, alignedGoal] = await Promise.all([
    prisma.goal.findUnique({ where: { id: Number(parentGoalId) } }),
    prisma.goal.findUnique({ where: { id: Number(alignedGoalId) } }),
  ]);

  if (!parentGoal || !alignedGoal)
    throw new Error("Invalid goal IDs — one or both goals not found");

  // Check if already aligned
  const existing = await prisma.goalAlignment.findFirst({
    where: { parentGoalId: Number(parentGoalId), alignedGoalId: Number(alignedGoalId) },
  });
  if (existing) throw new Error("These goals are already aligned");

  const create = await prisma.goalAlignment.create({
    data: {
      parentGoalId: Number(parentGoalId),
      alignedGoalId: Number(alignedGoalId),
      createdById: Number(createdBy),
    },
    createdBy: {
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
    module: "Goal Allignment",
    result: "SUCCESS",
    notes: `Goal Allignment "${create.id}" Create successfully`,
  });

  return create
};

// ✅ Get all alignments for a goal (both parent & children)
export const getGoalAlignmentsService = async (goalId) => {
  return prisma.goalAlignment.findMany({
    where: {
      OR: [
        { parentGoalId: Number(goalId) },
        { alignedGoalId: Number(goalId) },
      ],
    },
    include: {
      parentGoal: true,
      alignedGoal: true,
    },
  });
};

// ✅ Remove alignment
export const deleteGoalAlignmentService = async (id, deletedBy) => {
  const existing = await prisma.goalAlignment.findUnique({ where: { id: Number(id) } });
  if (!existing) throw new Error("Alignment not found");

  const deleted = await prisma.goalAlignment.delete({ where: { id: Number(id) } });

  await logAction({
    employeeId: Number(deletedBy),
    type: "Delete", // 👈 changed from CREATE to UPDATE
    module: "Goal Allignment",
    result: "SUCCESS",
    notes: `Goal Allignment "${id}" Deleted successfully`,
  });

  return deleted
};
