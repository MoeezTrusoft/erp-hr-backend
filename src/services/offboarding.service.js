// src/services/offboarding.service.js — Phase-2 schema-drift fixes + Phase-3 outbox event
//
// Fixes applied vs. original:
//   1. Wrong prisma import path (config/prisma.js → lib/prisma.js).
//   2. createOffboarding wrote `assignedById` (non-existent); removed; replaced
//      with `status: 'INITIATED'` only where the model supports it.
//   3. assignedToId → assigneeId on OffboardingTask (gap report §3.7.4).
//   4. isCompleted → completed on OffboardingTask (gap report §3.7.4).
//   5. tenantId is now threaded through on every write.
//   6. Phase-3: emit hr.employee.lifecycle.v1 (phase=terminated) inside the
//      offboarding create tx so downstream IAM consumers revoke access.
//
// C.2 — verified tenant (T-P2.1) threaded in as `tenantId` on the args /
// trailing param; folded into offboarding reads and stamped on creates,
// fail-closed so tenant B never reads/mutates tenant A's exit checklists.

import prisma from "../lib/prisma.js";           // FIX: was config/prisma.js
import { uploadFileToDAM } from "./dam.media.service.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { scopedEmployeeWhere } from "../lib/tenancy.js";
import {
  enqueueEmployeeLifecycle,
  mapEmployeeToLifecycleInput,
} from "./employeeOutbox.service.js";
import logger from "../lib/logger.js";

// Lifecycle source columns (same as hrContract.service.js::lifecycleSourceSelect).
const lifecycleSourceSelect = {
  id: true,
  tenant_id: true,
  employee_code: true,
  employee_name: true,
  first_name: true,
  last_name: true,
  work_email: true,
  businessUnitId: true,
  positionId: true,
  status: true,
  hire_date: true,
};

/**
 * Emit hr.employee.lifecycle.v1 (phase=terminated) inside a Prisma tx.
 * Fail-soft: logs and continues when outbox is unavailable.
 */
async function emitTerminatedLifecycle(tx, employee, exitDate, ctx = {}) {
  if (!employee) return;
  const input = mapEmployeeToLifecycleInput(employee, "terminated", {
    effectiveOn: exitDate ?? employee.hire_date,
  });
  if (!input.tenantId) return; // fail-closed: no tenant → no event
  try {
    await enqueueEmployeeLifecycle(tx, {
      ...input,
      aggregateId: employee.id,
      actorId: ctx.actorId,
      correlationId: ctx.correlationId,
    });
  } catch (err) {
    logger.warn({ err: err?.message, employeeId: employee?.id }, "offboarding: lifecycle outbox enqueue failed (non-fatal)");
  }
}

// -------- Public service exports --------

export const createOffboarding = async ({
  employeeId,
  exitDate,
  exitReason,
  notes,
  tenantId,
  actorId,       // Phase 3: for lifecycle event
  correlationId, // Phase 3: request chain id
}) => {
  const empId = Number(employeeId);

  // Phase 3: emit terminated lifecycle event in the SAME tx as checklist create.
  const employee = await prisma.employee.findFirst({
    where: scopedEmployeeWhere(tenantId, { id: empId }),
    select: lifecycleSourceSelect,
  });

  return prisma.$transaction(async (tx) => {
    const checklist = await tx.offboardingChecklist.create({
      data: {
        ...scopedData(tenantId, {
          employeeId: empId,
          exitDate: exitDate ? new Date(exitDate) : null,
          exitReason,
          notes,
          status: "INITIATED",
        }),
      },
      include: { tasks: true },
    });

    // Phase 3: emit hr.employee.lifecycle.v1 (phase=terminated) in-tx.
    if (employee) {
      await emitTerminatedLifecycle(
        tx,
        employee,
        exitDate,
        { actorId, correlationId }
      );
    }

    return checklist;
  });
};

export const getOffboarding = async (id, tenantId) => {
  return prisma.offboardingChecklist.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
    include: { employee: true, tasks: true },
  });
};

export const getOffboardingByEmployee = async (employeeId, tenantId) => {
  return prisma.offboardingChecklist.findFirst({
    where: scopedWhere(tenantId, { employeeId: Number(employeeId) }),
    include: { tasks: true },
  });
};

export const updateOffboarding = async (id, data, tenantId) => {
  const existing = await prisma.offboardingChecklist.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
  });
  if (!existing) throw new Error("Offboarding checklist not found");
  return prisma.offboardingChecklist.update({ where: { id: Number(id) }, data });
};

export const addTask = async ({
  checklistId,
  title,
  description,
  assigneeType,
  dueDate,
  assigneeId,   // FIX: was assignedToId — model field is assigneeId
  tenantId,
}) => {
  return prisma.offboardingTask.create({
    data: scopedData(tenantId, {
      checklistId: Number(checklistId),
      title,
      description,
      assigneeType: assigneeType || "HR",
      dueDate: dueDate ? new Date(dueDate) : null,
      assigneeId: assigneeId ? Number(assigneeId) : null,  // FIX
    }),
  });
};

export const updateTask = async (taskId, data, tenantId) => {
  const existing = await prisma.offboardingTask.findFirst({
    where: scopedWhere(tenantId, { id: Number(taskId) }),
  });
  if (!existing) throw new Error("Task not found");

  const update = { ...data };
  // FIX: model field is `completed` (not isCompleted); also set completedAt timestamp.
  if (update.isCompleted !== undefined) {
    update.completed = Boolean(update.isCompleted);
    if (update.completed) update.completedAt = new Date();
    delete update.isCompleted;
  }

  return prisma.offboardingTask.update({ where: { id: Number(taskId) }, data: update });
};

export const uploadExitInterview = async (id, file, tenantId) => {
  const existing = await prisma.offboardingChecklist.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
  });
  if (!existing) throw new Error("Offboarding checklist not found");
  const uploaded = await uploadFileToDAM(file, "video");
  if (!uploaded || !uploaded[0]) throw new Error("DAM upload failed");
  return prisma.offboardingChecklist.update({
    where: { id: Number(id) },
    data: { exitInterviewMediaId: uploaded[0].id },
  });
};
