// Compatibility transports converge on the same verified management/portal rules.
import {
  uploadOnboardingDocument,
  requireOnboardingSignatures,
} from "./onboardingDocuments.service.js";
import { createHash } from "node:crypto";
import {
  submitPortalMilestone,
  createPortalTask,
  updatePortalTask,
  deletePortalTask,
} from "./onboardingPortalScreen.service.js";
import {
  runOnboardingManagement,
  managementChecklist,
  managementChecklistWhere,
  onboardingFailure as fail,
} from "./onboardingManagement.service.js";
import { addNewHire } from "./onboardingDashboard.service.js";
import { listDocuments as managedDocuments } from "./onboardingSchedule.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
const employeeSelect = {
  id: true,
  employee_name: true,
  first_name: true,
  last_name: true,
  job_title: true,
  joining_date: true,
  photo_url: true,
  tenant_id: true,
};
const includeFor = (tenantId) => ({
  employee: { select: employeeSelect },
  tasks: {
    where: { tenantId },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  },
  buddy: { include: { buddy: { select: employeeSelect } } },
});
const safeRow = (row, tenantId) => ({
  ...row,
  buddy:
    row.buddy?.tenantId === tenantId && row.buddy?.buddy?.tenant_id === tenantId
      ? row.buddy
      : null,
});
const positive = (value) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) fail("Use a valid record ID");
  return id;
};
function date(value) {
  if (value == null) return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(+new Date(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    fail("Use a valid calendar date");
  return new Date(value);
}
function text(value, max, label) {
  if (value != null && (typeof value !== "string" || value.length > max))
    fail(label + " is too long");
  return value?.trim() || null;
}
async function changed(tx, env, c, action) {
  const e = await enqueueHrDomainEvent(tx, {
    tenantId: env.tenantId,
    actorId: String(env.who.id),
    actorType: "user",
    eventName: "hr.onboarding.checklist_changed.v1",
    aggregateType: "OnboardingChecklist",
    aggregateId: String(c.id),
    payload: {
      checklistId: String(c.id),
      employeeId: String(c.employeeId),
      actorId: String(env.who.id),
      action,
    },
  });
  if (!e) fail("Onboarding event could not be saved", 503);
}
export const createChecklist = ({
  tenantId,
  employeeId,
  title,
  templateId,
  startDate,
  buddyId,
  ...rest
}) => {
  if (Object.keys(rest).some((k) => rest[k] !== undefined))
    fail("Use the current checklist fields and a company template ID");
  return addNewHire(
    {
      employeeId: positive(employeeId),
      title,
      templateId: templateId == null ? undefined : positive(templateId),
      startDate: startDate || new Date().toISOString().slice(0, 10),
      buddyId,
    },
    tenantId,
  );
};
export const listChecklists = ({ tenantId, page = 1, limit = 20 } = {}) =>
  runOnboardingManagement(tenantId, "GET", async (tx, env) => {
    page = positive(page);
    limit = positive(limit);
    if (limit > 100) fail("Page size must be at most 100");
    const where = managementChecklistWhere(env);
    const items = await tx.onboardingChecklist.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      include: includeFor(tenantId),
    });
    const total = await tx.onboardingChecklist.count({ where });
    return {
      items: items.map((c) => safeRow(c, tenantId)),
      total,
      page,
      limit,
    };
  });
export const getChecklist = (id, tenantId) =>
  runOnboardingManagement(tenantId, "GET", async (tx, env) =>
    safeRow(
      await managementChecklist(tx, env, id, { include: includeFor(tenantId) }),
      tenantId,
    ),
  );
export const getChecklistByEmployee = (employeeId, tenantId) =>
  runOnboardingManagement(tenantId, "GET", async (tx, env) => {
    const rows = await tx.onboardingChecklist.findMany({
      where: {
        ...managementChecklistWhere(env),
        employeeId: positive(employeeId),
      },
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      include: includeFor(tenantId),
      take: 1001,
    });
    if (rows.length > 1000)
      fail("Use the paged onboarding list for this employee", 413);
    return rows.map((c) => safeRow(c, tenantId));
  });
export const updateChecklist = (id, input, tenantId) =>
  runOnboardingManagement(tenantId, "PUT", async (tx, env) => {
    const allowed = [
      "title",
      "status",
      "notes",
      "startDate",
      "targetDate",
      "currentStage",
    ];
    if (!input || Object.keys(input).some((k) => !allowed.includes(k)))
      fail("Unsupported checklist update field");
    const c = await managementChecklist(tx, env, id, { lock: true }),
      data = {};
    for (const key of ["title", "notes"])
      if (input[key] !== undefined)
        data[key] = text(input[key], key === "title" ? 200 : 4000, key);
    if (data.title === null) fail("A checklist title is required");
    if (input.startDate !== undefined) {
      data.startDate = date(input.startDate);
      if (!data.startDate) fail("Start date is required");
    }
    if (input.targetDate !== undefined)
      data.targetDate = date(input.targetDate);
    if (
      (data.targetDate ?? c.targetDate) &&
      (data.targetDate ?? c.targetDate) < (data.startDate ?? c.startDate)
    )
      fail("Target date cannot precede the start date");
    if (input.currentStage !== undefined) {
      if (
        ![
          "pre_joining",
          "pre_boarding",
          "first_week",
          "equipment",
          "complete",
        ].includes(input.currentStage)
      )
        fail("Unknown onboarding stage");
      data.currentStage = input.currentStage;
    }
    if (input.status !== undefined) {
      if (
        !["NOT_STARTED", "IN_PROGRESS", "COMPLETED", "OVERDUE"].includes(
          input.status,
        )
      )
        fail("Unknown onboarding status");
      data.status = input.status;
    }
    if (data.status === "COMPLETED" || data.currentStage === "complete") {
      if (
        await tx.onboardingTask.count({
          where: { tenantId, checklistId: c.id, completed: false },
        })
      )
        fail("Complete all checklist tasks before closing onboarding", 409);
      await requireOnboardingSignatures(tx, tenantId, c.id);
      data.status = "COMPLETED";
      data.currentStage = "complete";
      data.completedAt = c.completedAt || new Date();
    } else if (data.status) {
      data.completedAt = null;
      if (c.currentStage === "complete" && data.currentStage === undefined)
        data.currentStage = "pre_joining";
    }
    const saved = await tx.onboardingChecklist.update({
      where: { id: c.id },
      data,
      include: includeFor(tenantId),
    });
    await changed(tx, env, c, "CHECKLIST_UPDATED");
    return safeRow(saved, tenantId);
  });
const legacyTask = (t) => ({
  ...t,
  completed: t.done,
  dueDate: t.deadline,
  assigneeId: t.responsible?.id ?? null,
});
export const addTask = async ({
  tenantId,
  checklistId,
  title,
  description,
  notes,
  assigneeType,
  dueDate,
  assignedToId,
  assigneeId,
  stage,
  category,
}) =>
  legacyTask(
    await createPortalTask({
      tenantId,
      checklistId: positive(checklistId),
      title,
      description: description ?? notes,
      assigneeType,
      deadline: dueDate,
      responsibleId: assignedToId ?? assigneeId,
      stage,
      category,
    }),
  );
export const updateTask = async (taskId, input, tenantId) => {
  const allowed = [
    "title",
    "description",
    "notes",
    "category",
    "stage",
    "assigneeType",
    "assigneeId",
    "dueDate",
    "completed",
    "isCompleted",
    "status",
  ];
  if (!input || Object.keys(input).some((k) => !allowed.includes(k)))
    fail("Unsupported task update field");
  const patch = { tenantId, taskId: positive(taskId) };
  for (const key of [
    "title",
    "description",
    "category",
    "stage",
    "assigneeType",
  ])
    if (input[key] !== undefined) patch[key] = input[key];
  if (input.notes !== undefined) patch.description = input.notes;
  if (input.assigneeId !== undefined) patch.responsibleId = input.assigneeId;
  if (input.dueDate !== undefined) patch.deadline = input.dueDate;
  if (input.status !== undefined) {
    if (!["PENDING", "IN_PROGRESS", "COMPLETED"].includes(input.status))
      fail("Unknown task status");
    patch.done = input.status === "COMPLETED";
  }
  for (const key of ["completed", "isCompleted"])
    if (input[key] !== undefined) {
      if (typeof input[key] !== "boolean")
        fail("Completion must be true or false");
      if (patch.done !== undefined && patch.done !== input[key])
        fail("Conflicting task completion values");
      patch.done = input[key];
    }
  return legacyTask(await updatePortalTask(patch));
};
export const deleteTask = (taskId, tenantId) =>
  deletePortalTask({ tenantId, taskId: positive(taskId) });
export const listDocuments = managedDocuments;
// Preserve the legacy upload transport with verified company/employee ownership.
// Employee self-service uploads are handled separately from this HR transport.
export async function uploadDocument({
  checklistId,
  employeeId,
  title,
  file,
  tenantId,
}) {
  const checked = await runOnboardingManagement(
    tenantId,
    "POST",
    async (tx, env) => {
      const c = await managementChecklist(tx, env, checklistId);
      if (employeeId != null && positive(employeeId) !== c.employeeId)
        fail("Document employee does not match the checklist", 404);
      return { id: c.id, employeeId: c.employeeId };
    },
  );
  if (
    !Buffer.isBuffer(file?.buffer) ||
    !file.buffer.length ||
    file.buffer.length > 5 * 1024 * 1024
  )
    fail("Choose a document of 5 MB or less");
  const pdf = file.buffer.subarray(0, 5).toString() === "%PDF-",
    docx =
      file.buffer.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])) &&
      file.buffer.includes(Buffer.from("word/document.xml")) &&
      file.buffer.includes(Buffer.from("[Content_Types].xml"));
  if (!pdf && !docx) fail("Choose a valid PDF or Word document");
  const documentTitle = text(title || file.originalname, 200, "Document title");
  if (!documentTitle) fail("Document title is required");
  const hash = createHash("sha256").update(file.buffer).digest("hex");
  return uploadOnboardingDocument(
    {
      checklistId: checked.id,
      title: documentTitle,
      requestKey: "legacy:" + hash,
      contentBase64: file.buffer.toString("base64"),
    },
    tenantId,
  );
}
export const signDocument = (docId, { tenantId } = {}) =>
  runOnboardingManagement(tenantId, "PUT", async (tx, env) => {
    const doc = await tx.onboardingDocument.findFirst({
      where: { id: positive(docId), tenantId },
    });
    if (!doc) fail("Onboarding document not found", 404);
    await managementChecklist(tx, env, doc.checklistId);
    fail(
      "A verified LibreSign result is required; a manual signature timestamp is not accepted",
      409,
    );
  });
export const assignBuddy = ({ checklistId, buddyId, tenantId }) =>
  runOnboardingManagement(tenantId, "POST", async (tx, env) => {
    const c = await managementChecklist(tx, env, checklistId, { lock: true }),
      id = positive(buddyId);
    if (id === c.employeeId) fail("Choose a different employee as buddy");
    const buddy = await tx.employee.findFirst({
      where: { tenant_id: tenantId, id },
    });
    if (
      !buddy ||
      /inactive|terminated|exited|offboard|separated/i.test(
        [buddy.status, buddy.employement_status].join(" "),
      )
    )
      fail("Active buddy not found", 404);
    const saved = await tx.onboardingBuddy.upsert({
      where: { checklistId: c.id },
      create: { tenantId, checklistId: c.id, buddyId: id },
      update: { buddyId: id, tenantId },
      include: { buddy: { select: employeeSelect } },
    });
    await changed(tx, env, c, "BUDDY_ASSIGNED");
    return saved;
  });
export const getBuddy = (checklistId, tenantId) =>
  runOnboardingManagement(tenantId, "GET", async (tx, env) => {
    const c = await managementChecklist(tx, env, checklistId);
    const row = await tx.onboardingBuddy.findFirst({
      where: {
        tenantId,
        checklistId: c.id,
        buddy: { is: { tenant_id: tenantId } },
      },
      include: { buddy: { select: employeeSelect } },
    });
    return row;
  });
const mapSurveyType = (value) => {
  const key = String(value || "DAY_30")
    .toUpperCase()
    .replaceAll("-", "_");
  return (
    { "30_DAY": "DAY_30", "60_DAY": "DAY_60", "90_DAY": "DAY_90" }[key] || key
  );
};
export const submitSurvey = ({
  employeeId,
  checklistId,
  type,
  surveyType,
  responses,
  tenantId,
}) =>
  submitPortalMilestone({
    employeeId,
    checklistId,
    type: mapSurveyType(surveyType || type),
    tenantId,
    answers: Array.isArray(responses?.answers)
      ? responses.answers
      : Object.entries(responses || {}).map(([questionId, answer]) => ({
          questionId,
          answer,
        })),
    comments: responses?.comments,
  });
export const getSurveys = (employeeId, tenantId) =>
  runOnboardingManagement(tenantId, "GET", async (tx, env) =>
    tx.onboardingSurvey.findMany({
      where: {
        tenantId,
        employeeId: positive(employeeId),
        checklist: {
          is: {
            ...managementChecklistWhere(env),
            employeeId: positive(employeeId),
          },
        },
      },
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
    }),
  );
