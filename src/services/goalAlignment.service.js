import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// ✅ Create alignment between two goals
export const createGoalAlignmentService = async (data) => {
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

  return prisma.goalAlignment.create({
    data: {
      parentGoalId: Number(parentGoalId),
      alignedGoalId: Number(alignedGoalId),
    },
  });
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
export const deleteGoalAlignmentService = async (id) => {
  const existing = await prisma.goalAlignment.findUnique({ where: { id: Number(id) } });
  if (!existing) throw new Error("Alignment not found");

  await prisma.goalAlignment.delete({ where: { id: Number(id) } });
  return { message: "Goal alignment removed successfully" };
};
