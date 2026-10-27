import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { conflict, isUniqueViolation, notFound } from "../lib/performance-errors.js";
import { goalAlignmentCreateSchema, parsePerformancePayload } from "../validators/performance.schema.js";

// C.2-completion — verified tenant (T-P2.1) threaded via a trailing `tenantId`;
// both aligned goals are re-checked inside the tenant, and the alignment row is
// stamped + read fail-closed so tenant B never aligns/reads tenant A's goals.
//
// PERF-P0 (E-01 / D10): an alignment edge is parent → child
// (parentGoalId → alignedGoalId). Creating one is now a transaction that
//   * rejects a cycle — the new child must not already be an ancestor of the
//     parent (a path child → … → parent would close a loop),
//   * bounds the walk (MAX_ALIGNMENT_DEPTH) so a pathological graph cannot
//     spin the request,
//   * relies on the unique (tenantId, parentGoalId, alignedGoalId) index as the
//     race-proof duplicate guard,
// and a removal archives the edge (E-05) instead of deleting it.

export const MAX_ALIGNMENT_DEPTH = 32;

// Would adding parent → child create a cycle? True when `parent` is reachable
// from `child` by following existing parent → child edges.
export async function wouldCreateCycle(db, tenantId, parentGoalId, childGoalId) {
  if (parentGoalId === childGoalId) return true;
  const seen = new Set([childGoalId]);
  let frontier = [childGoalId];
  for (let depth = 0; depth < MAX_ALIGNMENT_DEPTH && frontier.length; depth += 1) {
    const edges = await db.goalAlignment.findMany({
      where: scopedWhere(tenantId, { parentGoalId: { in: frontier }, archivedAt: null }),
      select: { alignedGoalId: true },
    });
    const next = [];
    for (const { alignedGoalId } of edges) {
      if (alignedGoalId == null || seen.has(alignedGoalId)) continue;
      if (alignedGoalId === parentGoalId) return true;
      seen.add(alignedGoalId);
      next.push(alignedGoalId);
    }
    frontier = next;
  }
  if (frontier.length) throw conflict(`Alignment graph deeper than ${MAX_ALIGNMENT_DEPTH} levels`);
  return false;
}

// ✅ Create alignment between two goals
export const createGoalAlignmentService = async (data, createdBy, tenantId) => {
  const { parentGoalId, alignedGoalId } = parsePerformancePayload(goalAlignmentCreateSchema, data);

  const create = await tenantTransaction(
    prisma,
    async (tx) => {
      // Check both goals exist (within this tenant)
      const [parentGoal, alignedGoal] = await Promise.all([
        tx.goal.findFirst({ where: scopedWhere(tenantId, { id: parentGoalId }), select: { id: true } }),
        tx.goal.findFirst({ where: scopedWhere(tenantId, { id: alignedGoalId }), select: { id: true } }),
      ]);
      if (!parentGoal || !alignedGoal) throw notFound("One or both goals");

      const existing = await tx.goalAlignment.findFirst({
        where: scopedWhere(tenantId, { parentGoalId, alignedGoalId }),
      });
      if (existing && !existing.archivedAt) throw conflict("These goals are already aligned");

      if (await wouldCreateCycle(tx, tenantId, parentGoalId, alignedGoalId))
        throw conflict("Aligning these goals would create a cycle in the alignment graph");

      try {
        // Re-activate an archived edge rather than violating the unique index.
        if (existing) {
          return await tx.goalAlignment.update({
            where: { id: existing.id },
            data: { archivedAt: null },
          });
        }
        return await tx.goalAlignment.create({
          data: scopedData(tenantId, { parentGoalId, alignedGoalId }),
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict("These goals are already aligned");
        throw err;
      }
    },
    { tenantId }
  );

  await logAction({
    employeeId: Number(createdBy),
    type: "CREATE",
    module: "Goal Alignment",
    result: "SUCCESS",
    notes: `Goal ${alignedGoalId} aligned under goal ${parentGoalId} (alignment ${create.id})`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return create;
};

// ✅ Get all alignments for a goal (both parent & children)
export const getGoalAlignmentsService = async (goalId, tenantId) => {
  if (!goalId) throw notFound("Goal");
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

// ✅ Remove alignment (archive — the edge stays for history)
export const deleteGoalAlignmentService = async (id, deletedBy, tenantId) => {
  const existing = await prisma.goalAlignment.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!existing || existing.archivedAt) throw notFound("Alignment");

  const archived = await prisma.goalAlignment.update({
    where: { id: Number(id) },
    data: { archivedAt: new Date() },
  });

  await logAction({
    employeeId: Number(deletedBy),
    type: "DELETE",
    module: "Goal Alignment",
    result: "SUCCESS",
    notes: `Goal alignment ${id} archived`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return { ...archived, message: `Alignment ${id} removed` };
};
