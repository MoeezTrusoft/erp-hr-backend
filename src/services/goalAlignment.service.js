import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { logAction } from "../utils/logs.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { legacyGoalAlignment } from '../validators/performance.schema.js';

// C.2-completion — verified tenant (T-P2.1) threaded via `tenantId` (in the
// create payload, or a trailing read/delete param); both aligned goals are
// re-checked inside the tenant, and the alignment row is stamped + read
// fail-closed so tenant B never aligns/reads tenant A's goals.

// ✅ Create alignment between two goals
export const createGoalAlignmentService = async (data, createdBy) => {
  const { tenantId, ...payload } = data;
  const { parentGoalId, alignedGoalId } = legacyGoalAlignment.parse(payload);

  if (!parentGoalId || !alignedGoalId)
    throw new Error("Both parentGoalId and alignedGoalId are required");

  if (parentGoalId === alignedGoalId)
    throw new Error("A goal cannot be aligned to itself");

  const create=await tenantTransaction(prisma,async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId+':legacy-goal-alignment'},0))`;
    const ids=[Number(parentGoalId),Number(alignedGoalId)];
    if(ids.some(id=>!Number.isSafeInteger(id)||id<1))throw Object.assign(new Error('Invalid goal identifiers'),{status:422});
    const goals=await tx.goal.findMany({where:scopedWhere(tenantId,{id:{in:ids}}),select:{id:true}});
    if(goals.length!==2)throw Object.assign(new Error('Goals not found or self alignment requested'),{status:404});
    const edges=await tx.goalAlignment.findMany({where:scopedWhere(tenantId),select:{parentGoalId:true,alignedGoalId:true,archivedAt:true}});
    if(edges.some(e=>e.parentGoalId===ids[0]&&e.alignedGoalId===ids[1]))throw Object.assign(new Error('These goals are already aligned'),{status:409});
    const seen=new Set(),pending=[ids[0]];
    while(pending.length){const id=pending.pop();if(id===ids[1])throw Object.assign(new Error('Alignment would create a cycle'),{status:409});if(seen.has(id))continue;seen.add(id);pending.push(...edges.filter(e=>!e.archivedAt&&e.alignedGoalId===id).map(e=>e.parentGoalId));}
    return tx.goalAlignment.create({data:scopedData(tenantId,{parentGoalId:ids[0],alignedGoalId:ids[1]})});
  },{tenantId});
  await logAction({
    employeeId: Number(createdBy),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Goal Allignment",
    result: "SUCCESS",
    notes: `Goal Allignment "${create.id}" Create successfully`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return create
};

// ✅ Get all alignments for a goal (both parent & children)
export const getGoalAlignmentsService = async (goalId, tenantId) => {
  return prisma.goalAlignment.findMany({
    where: scopedWhere(tenantId, {
      archivedAt: null,
      OR: [
        { parentGoalId: Number(goalId) },
        { alignedGoalId: Number(goalId) },
      ],
    }),
    include: {
      parentGoal: true,
      alignedGoal: true,
    },
  });
};

// ✅ Remove alignment
export const deleteGoalAlignmentService = async (id, deletedBy, tenantId) => {
  const existing = await prisma.goalAlignment.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!existing) throw new Error("Alignment not found");

  const deleted = await prisma.goalAlignment.update({ where: { id: Number(id) }, data: { archivedAt: existing.archivedAt ?? new Date() } });

  await logAction({
    employeeId: Number(deletedBy),
    type: "Archive",
    module: "Goal Allignment",
    result: "SUCCESS",
    notes: `Goal Alignment "${id}" Archived successfully`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return deleted
};
