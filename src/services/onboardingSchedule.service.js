// src/services/onboardingSchedule.service.js — Onboarding Schedule (sessions)
// + Onboarding Documents read/write surface.
//
// Backs the onboarding "Schedule" (session) and "Documents" screens for a given
// checklist. Sessions live on the OnboardingSession model (onboarding_sessions);
// documents on OnboardingDocument (onboarding_documents). Both are tenant-scoped
// by the verified RBAC Company.uuid (user.tenantId) — never trust the body.
//
// NAME RESOLUTION: the Employee model has NO single `name` column — the display
// name is composed from first_name/middle_name/last_name (matching the
// employeeName helper used across the position/profile services). The checklist
// "candidate" is checklist.employee; the session "assignee" is resolved from
// assigneeId against Employee.
//
// SCHEMA NOTES:
//   * OnboardingSession has createdAt/updatedAt (camelCase).
//   * OnboardingDocument HAS a created_at column (snake_case), so
//     `uploadedDate` maps to created_at; document list is ordered by
//     created_at then id.
//   * Session fromTime/toTime/sessionType/location/assigneeId are all nullable.
import prisma from "../lib/prisma.js";

// Compose an employee display name from the split name columns, falling back to
// preferred_name then a stable "Employee {id}" placeholder. Returns null when
// the employee could not be resolved at all.
const employeeName = (employee) => {
  if (!employee) return null;
  return (
    [employee.first_name, employee.middle_name, employee.last_name].filter(Boolean).join(" ") ||
    employee.preferred_name ||
    `Employee ${employee.id}`
  );
};

// Coerce an incoming date-ish value (ISO string, Date) to a Date, or null.
const toDate = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const notFound = (message) => Object.assign(new Error(message), { status: 404 });
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

// Load a checklist within the caller's tenant, including the candidate employee.
// Throws 404 when missing or cross-tenant.
async function loadChecklist(checklistId, tenantId) {
  const id = Number(checklistId);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("Invalid checklistId");
  const checklist = await prisma.onboardingChecklist.findFirst({
    where: { id, tenantId },
    select: {
      id: true,
      startDate: true,
      employee: {
        select: { id: true, first_name: true, middle_name: true, last_name: true, preferred_name: true, job_title: true },
      },
    },
  });
  if (!checklist) throw notFound("Onboarding checklist not found");
  return checklist;
}

// ── SCHEDULE (sessions) ────────────────────────────────────────────────────

// List sessions for a checklist, enriched with candidate/role/joiningDate (from
// the checklist.employee) and the resolved assignee name. Tenant-scoped.
export async function listSchedule(checklistId, tenantId) {
  const checklist = await loadChecklist(checklistId, tenantId);

  const sessions = await prisma.onboardingSession.findMany({
    where: { checklistId: checklist.id, tenantId },
    orderBy: [{ sessionDate: "asc" }, { id: "asc" }],
  });

  const candidate = employeeName(checklist.employee);
  const role = checklist.employee?.job_title ?? null;
  const joiningDate = checklist.startDate ?? null;

  // Resolve assignee names in one query rather than N.
  const assigneeIds = [...new Set(sessions.map((s) => s.assigneeId).filter((v) => v != null))];
  const assignees = assigneeIds.length
    ? await prisma.employee.findMany({
        where: { id: { in: assigneeIds }, tenant_id: tenantId },
        select: { id: true, first_name: true, middle_name: true, last_name: true, preferred_name: true },
      })
    : [];
  const assigneeById = new Map(assignees.map((e) => [e.id, employeeName(e)]));

  return sessions.map((s) => ({
    id: s.id,
    title: s.title,
    candidate,
    role,
    joiningDate,
    sessionDate: s.sessionDate,
    fromTime: s.fromTime,
    toTime: s.toTime,
    sessionType: s.sessionType,
    location: s.location,
    assignee: s.assigneeId != null ? assigneeById.get(s.assigneeId) ?? null : null,
  }));
}

// Create an OnboardingSession under a checklist. Tenant-scoped: the checklist is
// validated within the caller's tenant, and the row inherits that tenantId.
export async function createSession(input, tenantId) {
  const { checklistId, title, sessionDate, fromTime, toTime, sessionType, location, assigneeId } = input;
  const checklist = await loadChecklist(checklistId, tenantId);
  if (!title || !String(title).trim()) throw badRequest("title is required");

  return prisma.onboardingSession.create({
    data: {
      checklistId: checklist.id,
      title: String(title).trim(),
      sessionDate: toDate(sessionDate),
      fromTime: fromTime ?? null,
      toTime: toTime ?? null,
      sessionType: sessionType ?? null,
      location: location ?? null,
      assigneeId: assigneeId != null ? Number(assigneeId) : null,
      tenantId,
    },
  });
}

// Update an OnboardingSession. Tenant-scoped by id+tenantId — a cross-tenant id
// updates zero rows and surfaces as 404 (no leak of existence).
export async function updateSession(id, patch, tenantId) {
  const sessionId = Number(id);
  if (!Number.isInteger(sessionId) || sessionId <= 0) throw badRequest("Invalid session id");

  const existing = await prisma.onboardingSession.findFirst({
    where: { id: sessionId, tenantId },
    select: { id: true },
  });
  if (!existing) throw notFound("Onboarding session not found");

  const data = {};
  if (patch.title !== undefined) data.title = String(patch.title).trim();
  if (patch.sessionDate !== undefined) data.sessionDate = toDate(patch.sessionDate);
  if (patch.fromTime !== undefined) data.fromTime = patch.fromTime ?? null;
  if (patch.toTime !== undefined) data.toTime = patch.toTime ?? null;
  if (patch.sessionType !== undefined) data.sessionType = patch.sessionType ?? null;
  if (patch.location !== undefined) data.location = patch.location ?? null;
  if (patch.assigneeId !== undefined) data.assigneeId = patch.assigneeId != null ? Number(patch.assigneeId) : null;

  return prisma.onboardingSession.update({ where: { id: sessionId }, data });
}

// ── DOCUMENTS ──────────────────────────────────────────────────────────────

// Derive the display status from the sign lifecycle: signed → pending (awaiting
// signature) → uploaded (no signature required).
const documentStatus = (doc) => {
  if (doc.signedAt) return "signed";
  if (doc.requiresSign) return "pending";
  return "uploaded";
};

// List OnboardingDocument rows for a checklist, enriched with candidate/role/
// joiningDate from the checklist.employee. Tenant-scoped.
export async function listDocuments(checklistId, tenantId) {
  const checklist = await loadChecklist(checklistId, tenantId);

  const docs = await prisma.onboardingDocument.findMany({
    where: { checklistId: checklist.id, tenantId },
    orderBy: [{ created_at: "asc" }, { id: "asc" }],
  });

  const candidate = employeeName(checklist.employee);
  const role = checklist.employee?.job_title ?? null;
  const joiningDate = checklist.startDate ?? null;

  return docs.map((d) => ({
    id: d.id,
    candidate,
    role,
    joiningDate,
    documentName: d.title,
    type: d.category,
    uploadedDate: d.created_at ?? null,
    status: documentStatus(d),
    mediaId: d.mediaId,
  }));
}

// Create an OnboardingDocument row referencing an ALREADY-uploaded DAM mediaId.
// This does NOT perform the DAM upload — the caller uploads the media (a
// separate DAM upload tool exists) and passes the resulting mediaId here.
export async function addDocument(input, tenantId) {
  const { checklistId, employeeId, title, mediaId, category, requiresSign } = input;
  const checklist = await loadChecklist(checklistId, tenantId);
  if (!title || !String(title).trim()) throw badRequest("title is required");

  const empId = Number(employeeId);
  if (!Number.isInteger(empId) || empId <= 0) throw badRequest("Invalid employeeId");
  const media = Number(mediaId);
  if (!Number.isInteger(media) || media <= 0) throw badRequest("Invalid mediaId");

  return prisma.onboardingDocument.create({
    data: {
      checklistId: checklist.id,
      employeeId: empId,
      title: String(title).trim(),
      mediaId: media,
      category: category ?? null,
      requiresSign: requiresSign ?? false,
      tenantId,
    },
  });
}
