import { createHash, randomUUID } from "node:crypto";
import {
  calendarViews,
  sessionCalendarView,
  calendarRecord,
} from "./onboardingCalendar.service.js";
import { attachPrivateOnboardingDocument } from "./onboardingDocuments.service.js";
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
import {
  runOnboardingManagement,
  managementChecklist,
  onboardingFailure,
} from "./onboardingManagement.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";

// Compose an employee display name from the split name columns, falling back to
// preferred_name then a stable "Employee {id}" placeholder. Returns null when
// the employee could not be resolved at all.
const employeeName = (employee) => {
  if (!employee) return null;
  return (
    [employee.first_name, employee.middle_name, employee.last_name]
      .filter(Boolean)
      .join(" ") ||
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

const notFound = (message) =>
  Object.assign(new Error(message), { status: 404 });
const badRequest = (message) =>
  Object.assign(new Error(message), { status: 400 });

// Load a checklist within the caller's tenant, including the candidate employee.
// Throws 404 when missing or cross-tenant.
async function loadChecklist(checklistId, tx, env, lock = false) {
  return managementChecklist(tx, env, checklistId, {
    lock,
    include: {
      employee: {
        select: {
          id: true,
          first_name: true,
          middle_name: true,
          last_name: true,
          preferred_name: true,
          job_title: true,
        },
      },
    },
  });
}
async function checkAssignee(tx, tenantId, id) {
  if (id == null) return;
  const p = await tx.employee.findFirst({
    where: { tenant_id: tenantId, id: Number(id) },
    select: { id: true },
  });
  if (!p) throw notFound("Session owner not found");
}
function validateSession(input) {
  if (
    typeof input.title !== "string" ||
    !input.title.trim() ||
    input.title.length > 200
  )
    throw badRequest("Session title must be 1–200 characters");
  if (
    input.sessionDate != null &&
    (!toDate(input.sessionDate) ||
      new Date(input.sessionDate).toISOString().slice(0, 10) !==
        String(
          input.sessionDate instanceof Date
            ? input.sessionDate.toISOString()
            : input.sessionDate,
        ).slice(0, 10))
  )
    throw badRequest("Use a valid session date");
  for (const key of ["fromTime", "toTime"])
    if (input[key] != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input[key]))
      throw badRequest("Session times must use HH:mm");
  if (
    Boolean(input.fromTime) !== Boolean(input.toTime) ||
    (input.fromTime && input.toTime <= input.fromTime)
  )
    throw badRequest("Session end must follow start on the same day");
  if (input.fromTime && !input.sessionDate)
    throw badRequest("A timed session needs a date");
  if (
    input.sessionType != null &&
    !["orientation", "training", "meeting", "compliance"].includes(
      input.sessionType,
    )
  )
    throw badRequest("Unknown session type");
  if (
    input.location != null &&
    (typeof input.location !== "string" || input.location.length > 1000)
  )
    throw badRequest("Session location must be at most 1000 characters");
}
async function sessionChanged(tx, env, c, action) {
  const event = await enqueueHrDomainEvent(tx, {
    tenantId: env.tenantId,
    eventName: "hr.onboarding.checklist_changed.v1",
    aggregateType: "OnboardingChecklist",
    aggregateId: String(c.id),
    actorId: String(env.who.id),
    actorType: "user",
    payload: {
      checklistId: String(c.id),
      employeeId: String(c.employeeId),
      actorId: String(env.who.id),
      action,
    },
  });
  if (!event) onboardingFailure("Session event could not be saved", 503);
}

// ── SCHEDULE (sessions) ────────────────────────────────────────────────────

// List sessions for a checklist, enriched with candidate/role/joiningDate (from
// the checklist.employee) and the resolved assignee name. Tenant-scoped.
export async function listSchedule(checklistId, tenantId) {
  return runOnboardingManagement(tenantId, "GET", async (tx, env) => {
    const checklist = await loadChecklist(checklistId, tx, env);

    const sessions = await tx.onboardingSession.findMany({
      where: { checklistId: checklist.id, tenantId },
      orderBy: [{ sessionDate: "asc" }, { id: "asc" }],
    });

    const candidate = employeeName(checklist.employee);
    const role = checklist.employee?.job_title ?? null;
    const joiningDate = checklist.startDate ?? null;

    // Resolve assignee names in one query rather than N.
    const assigneeIds = [
      ...new Set(sessions.map((s) => s.assigneeId).filter((v) => v != null)),
    ];
    const assignees = assigneeIds.length
      ? await tx.employee.findMany({
          where: { id: { in: assigneeIds }, tenant_id: tenantId },
          select: {
            id: true,
            first_name: true,
            middle_name: true,
            last_name: true,
            preferred_name: true,
          },
        })
      : [];
    const assigneeById = new Map(assignees.map((e) => [e.id, employeeName(e)]));

    const calendars = await calendarViews(
      tx,
      tenantId,
      sessions.map((s) => s.id),
    );
    return sessions.map((s) => ({
      calendar: calendars.get(s.id) || sessionCalendarView(null),
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
      assigneeId: assigneeById.has(s.assigneeId) ? s.assigneeId : null,
      assignee:
        s.assigneeId != null ? (assigneeById.get(s.assigneeId) ?? null) : null,
    }));
  });
}

// Create an OnboardingSession under a checklist. Tenant-scoped: the checklist is
// validated within the caller's tenant, and the row inherits that tenantId.
export async function createSession(input, tenantId) {
  return runOnboardingManagement(tenantId, "POST", async (tx, env) => {
    const {
      checklistId,
      title,
      sessionDate,
      fromTime,
      toTime,
      sessionType,
      location,
      assigneeId,
    } = input;
    const checklist = await loadChecklist(checklistId, tx, env, true);
    if (!title || !String(title).trim()) throw badRequest("title is required");

    if (checklist.status === "COMPLETED")
      throw Object.assign(new Error("This onboarding checklist is closed"), {
        status: 409,
      });
    validateSession(input);
    const key = input.requestKey;
    if (
      key != null &&
      (typeof key !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(key))
    )
      throw badRequest("Invalid session request key");
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          actorId: env.who.id,
          title: String(title).trim(),
          sessionDate: toDate(sessionDate)?.toISOString() || null,
          fromTime: fromTime ?? null,
          toTime: toTime ?? null,
          sessionType: sessionType ?? null,
          location: location ?? null,
          assigneeId: assigneeId != null ? Number(assigneeId) : null,
        }),
      )
      .digest("hex");
    const log = Array.isArray(checklist.activityLog)
      ? checklist.activityLog
      : [];
    const prior =
      key &&
      log.find((e) => e.kind === "SESSION_CREATED" && e.requestKey === key);
    if (prior) {
      if (prior.requestHash !== requestHash)
        throw Object.assign(
          new Error("Request key was already used for a different session"),
          { status: 409 },
        );
      const saved = await tx.onboardingSession.findFirst({
        where: { tenantId, checklistId: checklist.id, id: prior.sessionId },
      });
      if (!saved)
        throw Object.assign(
          new Error("The prior session is no longer available"),
          { status: 409 },
        );
      return saved;
    }
    await checkAssignee(tx, tenantId, assigneeId);
    const saved = await tx.onboardingSession.create({
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
    if (key)
      await tx.onboardingChecklist.update({
        where: { id: checklist.id },
        data: {
          activityLog: [
            ...log,
            {
              id: randomUUID(),
              kind: "SESSION_CREATED",
              at: new Date().toISOString(),
              actor: String(env.who.id),
              text: "Session draft created",
              sessionId: saved.id,
              requestKey: key,
              requestHash,
            },
          ],
        },
      });
    await calendarRecord(tx, tenantId, saved.id, { create: true });
    await sessionChanged(tx, env, checklist, "SESSION_CREATED");
    return saved;
  });
}

// Update an OnboardingSession. Tenant-scoped by id+tenantId — a cross-tenant id
// updates zero rows and surfaces as 404 (no leak of existence).
export async function updateSession(id, patch, tenantId) {
  return runOnboardingManagement(tenantId, "PUT", async (tx, env) => {
    const sessionId = Number(id);
    if (!Number.isInteger(sessionId) || sessionId <= 0)
      throw badRequest("Invalid session id");

    let existing = await tx.onboardingSession.findFirst({
      where: { id: sessionId, tenantId },
    });
    if (!existing) throw notFound("Onboarding session not found");

    const checklist = await loadChecklist(existing.checklistId, tx, env, true);
    existing = await tx.onboardingSession.findFirst({
      where: { id: sessionId, tenantId },
    });
    if (!existing) throw notFound("Onboarding session not found");
    if (checklist.status === "COMPLETED")
      throw Object.assign(new Error("This onboarding checklist is closed"), {
        status: 409,
      });
    const calendar = await calendarRecord(tx, tenantId, sessionId);
    if (calendar && calendar.state !== "DRAFT")
      throw Object.assign(
        new Error(
          "Use calendar scheduling or cancellation for a confirmed session",
        ),
        { status: 409 },
      );
    if (
      calendar &&
      ((patch.expectedVersion != null &&
        patch.expectedVersion !== calendar.version) ||
        (patch.expectedVersion == null && calendar.version !== 0))
    )
      throw Object.assign(
        new Error("This session changed. Reload before editing."),
        { status: 412 },
      );
    validateSession({ ...existing, ...patch });
    await checkAssignee(tx, tenantId, patch.assigneeId ?? existing.assigneeId);
    const data = {};
    if (patch.title !== undefined) data.title = String(patch.title).trim();
    if (patch.sessionDate !== undefined)
      data.sessionDate = toDate(patch.sessionDate);
    if (patch.fromTime !== undefined) data.fromTime = patch.fromTime ?? null;
    if (patch.toTime !== undefined) data.toTime = patch.toTime ?? null;
    if (patch.sessionType !== undefined)
      data.sessionType = patch.sessionType ?? null;
    if (patch.location !== undefined) data.location = patch.location ?? null;
    if (patch.assigneeId !== undefined)
      data.assigneeId =
        patch.assigneeId != null ? Number(patch.assigneeId) : null;

    const saved = await tx.onboardingSession.update({
      where: { id: sessionId },
      data,
    });
    await calendarRecord(tx, tenantId, sessionId, { create: true });
    await tx.$executeRawUnsafe(
      'UPDATE "OnboardingSessionCalendar" SET version=version+1,"updatedAt"=now() WHERE "tenantId"=$1::uuid AND "sessionId"=$2',
      tenantId,
      sessionId,
    );
    await sessionChanged(tx, env, checklist, "SESSION_UPDATED");
    return saved;
  });
}

// ── DOCUMENTS ──────────────────────────────────────────────────────────────

// Derive the display status from the sign lifecycle: signed → pending (awaiting
// signature) → uploaded (no signature required).
const documentStatus = (doc, verified) => {
  if (verified.has(doc.id)) return "signed";
  if (doc.signedAt) return "signature_verification_required";
  if (doc.requiresSign) return "pending";
  return "uploaded";
};

// List OnboardingDocument rows for a checklist, enriched with candidate/role/
// joiningDate from the checklist.employee. Tenant-scoped.
export async function listDocuments(checklistId, tenantId) {
  return runOnboardingManagement(tenantId, "GET", async (tx, env) => {
    const checklist = await loadChecklist(checklistId, tx, env);

    const docs = await tx.onboardingDocument.findMany({
      where: {
        checklistId: checklist.id,
        tenantId,
        employeeId: checklist.employee.id,
      },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
    });

    const verified = new Set(
      (
        await tx.$queryRawUnsafe(
          'SELECT s."documentId" FROM "OnboardingDocumentSignature" s JOIN onboarding_documents d ON d.id=s."documentId" AND d."tenantId"=s."tenantId" WHERE s."tenantId"=$1::uuid AND d."checklistId"=$2 AND s.state=\'SIGNED\' AND s."signedMediaId" IS NOT NULL AND s."signedSha256" IS NOT NULL',
          tenantId,
          checklist.id,
        )
      ).map((r) => r.documentId),
    );
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
      status: documentStatus(d, verified),
      signatureVerified: verified.has(d.id),
      mediaId: d.mediaId,
    }));
  });
}

// Create an OnboardingDocument row referencing an ALREADY-uploaded DAM mediaId.
// This does NOT perform the DAM upload — the caller uploads the media (a
// separate DAM upload tool exists) and passes the resulting mediaId here.
export const addDocument = (input, tenantId) =>
  attachPrivateOnboardingDocument(input, tenantId);
