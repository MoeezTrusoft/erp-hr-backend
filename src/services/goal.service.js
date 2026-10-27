import { legacyDecision } from "./approval/legacy.js";
import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import { scopedWhere, scopedData, scopedEmployeeWhere } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { normalizeExpectedVersion, preconditionFailedError } from "../lib/optimisticConcurrency.js";
import { conflict, notFound } from "../lib/performance-errors.js";
import {
  goalCreateSchema,
  goalProgressSchema,
  goalUpdateSchema,
  parsePerformancePayload,
} from "../validators/performance.schema.js";

// C.2 — verified tenant (T-P2.1) threaded in as a trailing `tenantId`; folded
// into goal reads and stamped on creates, fail-closed when present.
//
// PERF-P0 (E-01 / D8, D9): `progress` is the goal's completion PERCENT (0..100,
// the Goal.progress column and what every tool documents). The previous update
// computed `current_value = current_value - progress` and then rejected most
// writes; `addProgress` referenced an undefined `id` after a partial write.
// Now: progress is stored as given, `current_value` is derived from the target
// (target_value × progress / 100) when a numeric target exists, and the
// progress-note + goal update are one transaction.

const deriveCurrentValue = (goal, progress) =>
  typeof goal.target_value === "number" && Number.isFinite(goal.target_value)
    ? Math.round(goal.target_value * (progress / 100) * 10000) / 10000
    : goal.current_value;

// ✅ Create a new goal
export const createGoalService = async (data, createdBy, tenantId) => {
  const input = parsePerformancePayload(goalCreateSchema, data);
  const { employeeId, title, description, category, start_date, end_date, target_value } = input;

  const employee = await prisma.employee.findFirst({
    where: scopedEmployeeWhere(tenantId, { id: employeeId }),
    select: { id: true },
  });
  if (!employee) throw notFound("Employee");

  const create = await prisma.goal.create({
    data: scopedData(tenantId, {
      employeeId,
      title,
      description: description ?? null,
      category: category ?? null,
      start_date: new Date(start_date),
      end_date: new Date(end_date),
      target_value: target_value ?? null,
      status: "PENDING",
    }),
  });

  await logAction({
    employeeId: Number(createdBy),
    type: "CREATE",
    module: "Goal",
    result: "SUCCESS",
    notes: `Goal ${create.id} created for employee ${employeeId}`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });
  return create;
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
export const updateGoalService = async (id, data, updatedBy, tenantId) => {
  const input = parsePerformancePayload(goalUpdateSchema, data);
  const { title, description, category, progress, status } = input;

  // API-2 — optimistic-concurrency guard (opt-in via expectedVersion). Absent ⇒ no reject.
  const expectedVersion = normalizeExpectedVersion(input.expectedVersion);

  // Find existing goal (tenant-scoped pre-read; cross-tenant id → not-found)
  const existing = await prisma.goal.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!existing) throw notFound("Goal");

  // Approval decisions ride the HR Approval Centre (approveGoalService); a
  // direct status write may not forge one.
  if (status && ["APPROVED", "REJECTED"].includes(status) && status !== existing.status)
    throw conflict("Goal approval decisions are made through the HR Approval Centre");

  const nextProgress = progress ?? existing.progress;

  // Update goal — API-2 atomic compare-and-set + version bump, tenant-scoped.
  const versionWhere = expectedVersion == null ? {} : { version: expectedVersion };
  const { count } = await prisma.goal.updateMany({
    where: scopedWhere(tenantId, { id: Number(id), ...versionWhere }),
    data: {
      title: title ?? existing.title,
      description: description ?? existing.description,
      category: category ?? existing.category,
      progress: nextProgress,
      current_value: progress == null ? existing.current_value : deriveCurrentValue(existing, progress),
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
    type: "UPDATE",
    module: "Goal",
    result: "SUCCESS",
    notes: `Goal ${id} updated`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return update;
};

// ✅ Approve or reject goal — deliberately routed to the HR Approval Centre
// (HR-4201 redirect); the decision itself is applied by the GOAL adapter.
export const approveGoalService = async (id, status, approvedBy, tenantId) => {
  return legacyDecision('GOAL', id);
};

// ✅ Add a progress update (note + goal progress, atomically)
export const addGoalProgressService = async (data, createdBy, tenantId) => {
  const { goalId, comment, progress } = parsePerformancePayload(goalProgressSchema, data);

  const newProgress = await tenantTransaction(
    prisma,
    async (tx) => {
      const goal = await tx.goal.findFirst({ where: scopedWhere(tenantId, { id: goalId }) });
      if (!goal) throw notFound("Goal");

      const created = await tx.goalProgress.create({
        data: scopedData(tenantId, {
          goalId,
          comment: comment ?? null,
          progress,
          created_by: Number(createdBy),
        }),
      });

      await tx.goal.update({
        where: { id: goalId },
        data: {
          progress,
          current_value: deriveCurrentValue(goal, progress),
          version: { increment: 1 },
        },
      });
      return created;
    },
    { tenantId }
  );

  await logAction({
    employeeId: Number(createdBy),
    type: "CREATE",
    module: "Goal",
    result: "SUCCESS",
    notes: `Progress ${progress}% recorded on goal ${goalId} (update ${newProgress.id})`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return newProgress;
};

// ✅ Get all progress updates for a goal
export const getGoalProgressService = async (id, tenantId) => {
  const goal = await prisma.goal.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!goal) throw notFound("Goal");

  return prisma.goalProgress.findMany({
    where: scopedWhere(tenantId, { goalId: Number(id) }),
    include: { createdBy: true },
    orderBy: { update_date: "desc" },
  });
};
