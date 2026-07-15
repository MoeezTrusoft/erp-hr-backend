// src/services/onboardingDetail.service.js — Onboarding "New Hire Detail" screen.
//
// Backs the detail view for a single OnboardingChecklist: the new-hire header
// (name / role / joining date / progress / status) plus the checklist tasks
// grouped by their `stage` (pre_joining | pre_boarding | first_week | equipment).
// Also provides the stage-aware task create and the "send reminder" intent
// recorder (appends to OnboardingChecklist.activityLog — no email is sent).
//
// Tenant-scoped fail-closed via scopedWhere (RBAC Company.uuid on tenantId).
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

const STAGES = ["pre_joining", "pre_boarding", "first_week", "equipment"];
const ASSIGNEE_TYPES = ["HR", "MANAGER", "NEW_HIRE", "IT"];

const notFound = () => {
  const err = new Error("Onboarding checklist not found");
  err.status = 404;
  return err;
};

const badRequest = (msg) => {
  const err = new Error(msg);
  err.status = 400;
  return err;
};

const employeeName = (e) =>
  e?.employee_name ||
  [e?.first_name, e?.last_name].filter(Boolean).join(" ").trim() ||
  null;

// A task's stage bucket. Unknown / null stages fall back to "pre_joining".
const stageOf = (stage) => (STAGES.includes(stage) ? stage : "pre_joining");

// Resolve a task's assignee display: employee name (when assigneeId resolves)
// else the assigneeType label (HR / MANAGER / NEW_HIRE / IT).
const shapeTask = (t, nameById) => ({
  id: t.id,
  title: t.title,
  description: t.description ?? null,
  assignee:
    (t.assigneeId != null ? nameById.get(t.assigneeId) : null) ||
    t.assigneeType ||
    null,
  dueDate: t.dueDate ?? null,
  completed: t.completed,
  stage: stageOf(t.stage),
});

/**
 * Detail payload for a single onboarding checklist (tenant-scoped).
 * @param {number} id  OnboardingChecklist id
 * @param {string|null|undefined} tenantId
 */
export const getOnboardingDetail = async (id, tenantId) => {
  const checklist = await prisma.onboardingChecklist.findFirst({
    where: scopedWhere(tenantId, { id }),
    include: {
      employee: {
        select: {
          id: true,
          employee_name: true,
          first_name: true,
          last_name: true,
          job_title: true,
        },
      },
      tasks: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
    },
  });
  if (!checklist) throw notFound();

  const tasks = checklist.tasks || [];

  // Batch-resolve assignee employee names referenced by tasks.
  const assigneeIds = [...new Set(tasks.map((t) => t.assigneeId).filter((v) => v != null))];
  const nameById = new Map();
  if (assigneeIds.length) {
    const people = await prisma.employee.findMany({
      where: { id: { in: assigneeIds } },
      select: { id: true, employee_name: true, first_name: true, last_name: true },
    });
    for (const p of people) nameById.set(p.id, employeeName(p));
  }

  const checklistByStage = { pre_joining: [], pre_boarding: [], first_week: [], equipment: [] };
  for (const t of tasks) checklistByStage[stageOf(t.stage)].push(shapeTask(t, nameById));

  const done = tasks.filter((t) => t.completed).length;
  const progress = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

  return {
    id: checklist.id,
    newHireName: employeeName(checklist.employee),
    role: checklist.employee?.job_title ?? null,
    joiningDate: checklist.startDate,
    progress,
    status: checklist.status,
    checklist: checklistByStage,
  };
};

/**
 * Stage-aware OnboardingTask create.
 * @param {object} input { checklistId, title, stage, startDate?, assigneeId?, assigneeType?, notes? }
 * @param {string|null|undefined} tenantId
 */
export const createOnboardingTask = async (input, tenantId) => {
  const { checklistId, title, stage, startDate, assigneeId, assigneeType, notes } = input;

  if (!STAGES.includes(stage)) {
    throw badRequest(`Invalid stage: ${stage}. Expected one of ${STAGES.join(" | ")}`);
  }
  const type = assigneeType ?? "HR";
  if (!ASSIGNEE_TYPES.includes(type)) {
    throw badRequest(`Invalid assigneeType: ${type}. Expected one of ${ASSIGNEE_TYPES.join(" | ")}`);
  }

  // Tenant-scoped existence check so a task can't be attached cross-tenant.
  const checklist = await prisma.onboardingChecklist.findFirst({
    where: scopedWhere(tenantId, { id: checklistId }),
    select: { id: true },
  });
  if (!checklist) throw notFound();

  const task = await prisma.onboardingTask.create({
    data: scopedData(tenantId, {
      checklistId,
      title,
      stage,
      description: notes ?? null,
      assigneeType: type,
      assigneeId: assigneeId ?? null,
      dueDate: startDate ? new Date(startDate) : null,
    }),
  });

  return {
    id: task.id,
    checklistId: task.checklistId,
    title: task.title,
    stage: task.stage,
    description: task.description ?? null,
    assigneeType: task.assigneeType,
    assigneeId: task.assigneeId ?? null,
    dueDate: task.dueDate ?? null,
    completed: task.completed,
  };
};

/**
 * Record a reminder intent against the checklist's activityLog.
 * No email is actually sent — this persists the intent as an audit entry.
 * @param {object} input { checklistId, sendTo, subject, message, actor? }
 * @param {string|null|undefined} tenantId
 */
export const sendOnboardingReminder = async (input, tenantId) => {
  const { checklistId, sendTo, subject, message, actor } = input;

  const checklist = await prisma.onboardingChecklist.findFirst({
    where: scopedWhere(tenantId, { id: checklistId }),
    select: { id: true, activityLog: true },
  });
  if (!checklist) throw notFound();

  const sentAt = new Date().toISOString();
  const entry = {
    at: sentAt,
    actor: actor ?? "system",
    text: `Reminder sent to ${sendTo}: ${subject}`,
  };

  const log = Array.isArray(checklist.activityLog) ? checklist.activityLog : [];
  await prisma.onboardingChecklist.update({
    where: { id: checklist.id },
    data: { activityLog: [...log, entry] },
  });

  return {
    success: true,
    reminder: { sendTo, subject, message, sentAt },
  };
};
