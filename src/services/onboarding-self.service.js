// src/services/onboarding-self.service.js
//
// Recruitment Phase 4 (plan 6.7) — the new hire's own pre-boarding portal, and
// HR's review of what the new hire uploads.
//
// Why a separate service: every older onboarding tool asserts hr:onboarding,
// which a new hire does not hold, and most of them take a caller-chosen
// checklistId/employeeId. The portal is reached with hr:self instead, so the
// rule here is the opposite of those tools: the subject is ALWAYS the verified
// caller (the tool layer pins employeeId to the claim), and every row is
// reached through the caller's own checklists, never by a bare id. A row that
// is not the caller's reads as "not found", with the same text as a missing
// one, so ids cannot be probed.
//
// What the new hire may do:
//   * read their checklist (tasks assigned to NEW_HIRE in full, counts for the
//     rest), sessions, their own documents, open surveys, buddy and manager;
//   * complete / reopen a NEW_HIRE task of an open checklist;
//   * upload a document (validated by lib/onboarding-upload.util.js, stored in
//     DAM, recorded with source NEW_HIRE and reviewStatus PENDING);
//   * sign an HR-supplied document that requires a signature;
//   * submit an issued, unsubmitted 30/60/90 day survey.
// HR (hr:onboarding) verifies or rejects an upload and lists the uploads that
// wait for review.
//
// Every function answers 503 HR-ONBOARDING-SELF-PORTAL-DISABLED while the
// onboardingSelfPortal flag is off. Writes run in one tenantTransaction with
// their outbox event; conditional updates (where state = expected) keep a
// double click or a race from applying a transition twice.
import { z } from "zod";

import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { scopedWhere, scopedData, scopedEmployeeWhere, requireTenant } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { eventContext } from "../lib/event-context.util.js";
import { validateOnboardingUpload } from "../lib/onboarding-upload.util.js";
import { liveSessionWhere } from "../lib/onboarding-sessions.util.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { onboardingTaskUpdatedEvent, onboardingSurveySubmittedEvent } from "./hrEvents.js";
import { uploadFileToDAM, deleteDamAsset } from "./dam.media.service.js";

export const DOCUMENT_SOURCE = Object.freeze({ HR: "HR", NEW_HIRE: "NEW_HIRE" });
export const REVIEW_STATUS = Object.freeze({ PENDING: "PENDING", VERIFIED: "VERIFIED", REJECTED: "REJECTED" });
export const REVIEW_DECISIONS = Object.freeze([REVIEW_STATUS.VERIFIED, REVIEW_STATUS.REJECTED]);
export const SELF_SURVEY_TYPES = Object.freeze(["DAY_30", "DAY_60", "DAY_90"]);

export const DOCUMENT_TITLE_MAX_LENGTH = 200;
export const DOCUMENT_CATEGORY_MAX_LENGTH = 60;
export const REVIEW_NOTE_MAX_LENGTH = 1000; // onboarding_documents_review_check

// The same shape the HR survey submit stores (responses keyed by question id),
// bounded so a portal caller cannot park arbitrary JSON on the row.
const surveyAnswer = z.union([
    z.string().max(2000),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(z.string().max(500)).max(20),
]);
export const SURVEY_RESPONSES_SCHEMA = z
    .record(z.string().min(1).max(100), surveyAnswer)
    .refine((r) => Object.keys(r).length > 0, { message: "Answer at least one question" })
    .refine((r) => Object.keys(r).length <= 50, { message: "At most 50 answers" });

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });
const notFound = (what) => fail(`${what} not found`, 404, "HR-ONBOARDING-NOT-FOUND");

/** 503 while the portal flag is off (clients see HR-5031). */
// HR's review of a new hire's upload belongs to both rollouts: the self
// portal that produces uploads and the HR automation screens that review them.
export function assertDocumentReviewEnabled() {
    if (!isRecruitmentFlagEnabled("onboardingSelfPortal") && !isRecruitmentFlagEnabled("onboardingAutomation")) {
        throw fail("Onboarding document review is turned off", 503, "HR-ONBOARDING-DOCUMENT-REVIEW-DISABLED");
    }
}

export function assertSelfPortalEnabled() {
    if (!isRecruitmentFlagEnabled("onboardingSelfPortal")) {
        throw fail("The onboarding self portal is turned off", 503, "HR-ONBOARDING-SELF-PORTAL-DISABLED");
    }
}

const positiveInt = (value, label) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw fail(`A valid ${label} is required`, 400, "HR-ONBOARDING-INVALID-ID");
    return n;
};

const displayName = (e) =>
    (e?.employee_name && String(e.employee_name).trim()) ||
    [e?.first_name, e?.last_name].filter(Boolean).join(" ").trim() ||
    e?.preferred_name ||
    null;

const personSelect = { id: true, employee_name: true, first_name: true, last_name: true, preferred_name: true, work_email: true };
const contactOf = (e) => (e ? { id: e.id, name: displayName(e), workEmail: e.work_email || null } : null);

const idStr = (value) => (value != null ? String(value) : null);

// ── events (ids only; names, file names and notes never ride) ───────────────

function documentEvent(eventName, doc, ctx, extra = {}) {
    const tenantId = doc?.tenantId ?? null;
    if (!tenantId) return null;
    return {
        eventName,
        tenantId,
        aggregateType: "OnboardingDocument",
        aggregateId: doc?.id,
        actorId: ctx?.actorId,
        correlationId: ctx?.correlationId,
        payload: {
            documentId: String(doc?.id),
            checklistId: idStr(doc?.checklistId),
            employeeId: idStr(doc?.employeeId),
            source: doc?.source ?? null,
            reviewStatus: doc?.reviewStatus ?? null,
            ...extra,
        },
    };
}

/** To HR: a new hire uploaded a document that waits for review. */
export const onboardingDocumentUploadedEvent = (doc, ctx = {}, { hrOwnerId = null } = {}) =>
    documentEvent("hr.onboarding.document_uploaded.v1", doc, ctx, { hrOwnerId: idStr(hrOwnerId) });

/** To HR: the new hire signed an HR-supplied document. */
export const onboardingDocumentSignedEvent = (doc, ctx = {}, { hrOwnerId = null } = {}) =>
    documentEvent("hr.onboarding.document_signed.v1", doc, ctx, {
        signedByEmpId: idStr(doc?.signedByEmpId),
        hrOwnerId: idStr(hrOwnerId),
    });

/** To the employee (payload employeeId): HR verified or rejected their upload. */
export const onboardingDocumentReviewedEvent = (doc, ctx = {}) =>
    documentEvent("hr.onboarding.document_reviewed.v1", doc, ctx, { reviewedById: idStr(doc?.reviewedById) });

// ── the caller and their checklists ─────────────────────────────────────────

async function loadSelf(db, tenantId, employeeId) {
    const id = Number(employeeId);
    const employee = Number.isInteger(id) && id > 0
        ? await db.employee.findFirst({ where: scopedEmployeeWhere(tenantId, { id }), select: { id: true, managerId: true } })
        : null;
    if (!employee) {
        throw fail("Your account is not linked to an employee record", 400, "HR-ONBOARDING-SELF-NO-EMPLOYEE");
    }
    return employee;
}

const checklistSelect = { id: true, employeeId: true, title: true, status: true, currentStage: true, startDate: true, targetDate: true, tenantId: true };

// The checklist the portal shows: the latest still-open one, else the latest.
async function currentChecklist(db, tenantId, employeeId) {
    const open = await db.onboardingChecklist.findFirst({
        where: scopedWhere(tenantId, { employeeId, status: { not: "COMPLETED" } }),
        orderBy: [{ startDate: "desc" }, { id: "desc" }],
        select: checklistSelect,
    });
    if (open) return open;
    return db.onboardingChecklist.findFirst({
        where: scopedWhere(tenantId, { employeeId }),
        orderBy: [{ startDate: "desc" }, { id: "desc" }],
        select: checklistSelect,
    });
}

async function ownChecklists(db, tenantId, employeeId) {
    return db.onboardingChecklist.findMany({
        where: scopedWhere(tenantId, { employeeId }),
        select: { id: true, status: true },
    });
}

const assertOpen = (checklist) => {
    if (checklist?.status === "COMPLETED") {
        throw fail("This onboarding checklist is already complete", 409, "HR-ONBOARDING-CHECKLIST-CLOSED");
    }
};

// The HR routing id for a checklist's document notices: the assignee of its
// first HR documentation task, when one is set (else the Notification Hub
// falls back to the tenant's hr:onboarding holders).
async function hrOwnerOf(db, tenantId, checklistId) {
    const task = await db.onboardingTask.findFirst({
        where: scopedWhere(tenantId, { checklistId, assigneeType: "HR", category: "HR_DOCUMENTATION", assigneeId: { not: null } }),
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        select: { assigneeId: true },
    });
    return task?.assigneeId ?? null;
}

// ── shaping ─────────────────────────────────────────────────────────────────

const taskView = (t) => ({
    id: t.id,
    title: t.title,
    description: t.description ?? null,
    stage: t.stage ?? null,
    category: t.category ?? "OTHER",
    dueDate: t.dueDate ?? null,
    completed: Boolean(t.completed),
    completedAt: t.completedAt ?? null,
});

const documentView = (d) => ({
    id: d.id,
    title: d.title,
    category: d.category ?? null,
    mediaId: d.mediaId ?? null,
    requiresSign: Boolean(d.requiresSign),
    signed: d.signedAt != null,
    signedAt: d.signedAt ?? null,
    source: d.source ?? DOCUMENT_SOURCE.HR,
    reviewStatus: d.reviewStatus ?? null,
    // HR's note reaches the new hire only on a rejection (it says what to fix).
    reviewNote: d.reviewStatus === REVIEW_STATUS.REJECTED ? d.reviewNote ?? null : null,
    uploadedAt: d.created_at ?? null,
});

const documentSelect = {
    id: true, checklistId: true, employeeId: true, title: true, category: true, mediaId: true, requiresSign: true,
    signedAt: true, signedByEmpId: true, source: true, reviewStatus: true, reviewedAt: true, reviewedById: true,
    reviewNote: true, created_at: true, tenantId: true,
};

const EMPTY_PORTAL = Object.freeze({
    checklist: null,
    progress: { total: 0, done: 0, percent: 0, newHire: { total: 0, done: 0 }, others: { total: 0, done: 0 } },
    tasks: [],
    sessions: [],
    documents: [],
    openSurveys: [],
    buddy: null,
    manager: null,
});

// ── 1. read ─────────────────────────────────────────────────────────────────

/**
 * The caller's own pre-boarding portal. A caller without a checklist gets the
 * empty shape (checklist null), not an error.
 * @param {{ tenantId: string, employeeId: number }} args
 */
export async function getMyOnboarding({ tenantId, employeeId } = {}) {
    assertSelfPortalEnabled();
    requireTenant(tenantId);
    const self = await loadSelf(prisma, tenantId, employeeId);
    const checklist = await currentChecklist(prisma, tenantId, self.id);
    if (!checklist) {
        const manager = self.managerId ? await findPerson(tenantId, self.managerId) : null;
        return { ...structuredClone(EMPTY_PORTAL), manager };
    }

    const [tasks, sessions, documents, surveys, buddy] = await Promise.all([
        prisma.onboardingTask.findMany({
            where: scopedWhere(tenantId, { checklistId: checklist.id }),
            orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
            select: { id: true, title: true, description: true, stage: true, category: true, assigneeType: true, dueDate: true, completed: true, completedAt: true },
        }),
        prisma.onboardingSession.findMany({
            where: scopedWhere(tenantId, { checklistId: checklist.id, ...liveSessionWhere() }),
            orderBy: [{ sessionDate: "asc" }, { id: "asc" }],
            select: { id: true, title: true, sessionDate: true, fromTime: true, toTime: true, location: true, sessionType: true, required: true },
        }),
        prisma.onboardingDocument.findMany({
            // Both keys: the checklist is the caller's AND the row names them.
            where: scopedWhere(tenantId, { checklistId: checklist.id, employeeId: self.id }),
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
            select: documentSelect,
        }),
        prisma.onboardingSurvey.findMany({
            where: scopedWhere(tenantId, { checklistId: checklist.id, employeeId: self.id, issuedAt: { not: null }, submittedAt: null }),
            orderBy: [{ dueAt: "asc" }, { id: "asc" }],
            select: { id: true, type: true, issuedAt: true, dueAt: true },
        }),
        prisma.onboardingBuddy.findFirst({
            where: scopedWhere(tenantId, { checklistId: checklist.id }),
            select: { buddyId: true },
        }),
    ]);

    const [buddyPerson, manager] = await Promise.all([
        buddy?.buddyId ? findPerson(tenantId, buddy.buddyId) : null,
        self.managerId ? findPerson(tenantId, self.managerId) : null,
    ]);

    const mine = tasks.filter((t) => t.assigneeType === "NEW_HIRE");
    const others = tasks.filter((t) => t.assigneeType !== "NEW_HIRE");
    const done = (list) => list.filter((t) => t.completed).length;
    const total = tasks.length;
    const doneAll = done(tasks);

    return {
        checklist: {
            id: checklist.id,
            title: checklist.title ?? null,
            status: checklist.status,
            stage: checklist.currentStage ?? null,
            startDate: checklist.startDate ?? null,
            targetDate: checklist.targetDate ?? null,
        },
        progress: {
            total,
            done: doneAll,
            percent: total === 0 ? 0 : Math.round((doneAll / total) * 100),
            newHire: { total: mine.length, done: done(mine) },
            others: { total: others.length, done: done(others) },
        },
        tasks: mine.map(taskView),
        sessions: sessions.map((s) => ({
            id: s.id,
            title: s.title,
            date: s.sessionDate ?? null,
            fromTime: s.fromTime ?? null,
            toTime: s.toTime ?? null,
            location: s.location ?? null,
            type: s.sessionType ?? null,
            required: Boolean(s.required),
        })),
        documents: documents.map(documentView),
        openSurveys: surveys.map((s) => ({ id: s.id, type: s.type, issuedAt: s.issuedAt ?? null, dueAt: s.dueAt ?? null })),
        buddy: buddyPerson,
        manager,
    };
}

async function findPerson(tenantId, id) {
    const row = await prisma.employee.findFirst({ where: scopedEmployeeWhere(tenantId, { id }), select: personSelect });
    return contactOf(row);
}

// ── 2. tasks ────────────────────────────────────────────────────────────────

async function setMyTaskCompleted({ tenantId, employeeId, taskId, completed, now = new Date() }) {
    assertSelfPortalEnabled();
    requireTenant(tenantId);
    const id = positiveInt(taskId, "task id");
    const evtCtx = eventContext({ actorId: employeeId });
    return tenantTransaction(prisma, async (tx) => {
        const self = await loadSelf(tx, tenantId, employeeId);
        const checklists = await ownChecklists(tx, tenantId, self.id);
        const task = checklists.length
            ? await tx.onboardingTask.findFirst({
                where: scopedWhere(tenantId, { id, checklistId: { in: checklists.map((c) => c.id) }, assigneeType: "NEW_HIRE" }),
            })
            : null;
        if (!task) throw notFound("Task");
        assertOpen(checklists.find((c) => c.id === task.checklistId));

        if (Boolean(task.completed) === completed) return { task: taskView(task), changed: false };

        const moved = await tx.onboardingTask.updateMany({
            where: scopedWhere(tenantId, { id, completed: !completed }),
            data: { completed, completedAt: completed ? now : null },
        });
        const updated = await tx.onboardingTask.findFirst({ where: scopedWhere(tenantId, { id }) });
        if (moved.count === 0) return { task: taskView(updated), changed: false };
        await enqueueHrDomainEvent(tx, onboardingTaskUpdatedEvent({ ...updated, tenantId: updated.tenantId ?? tenantId }, evtCtx));
        return { task: taskView(updated), changed: true };
    }, { tenantId });
}

/** Complete a NEW_HIRE task of the caller's open checklist (idempotent). */
export const completeMyTask = (args = {}) => setMyTaskCompleted({ ...args, completed: true });

/** Reopen a NEW_HIRE task of the caller's open checklist (idempotent). */
export const reopenMyTask = (args = {}) => setMyTaskCompleted({ ...args, completed: false });

// ── 3. upload ───────────────────────────────────────────────────────────────

const cleanText = (value, label, max, { required = false } = {}) => {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) {
        if (required) throw fail(`${label} is required`, 400, "HR-ONBOARDING-VALIDATION");
        return null;
    }
    if (text.length > max) throw fail(`${label} is at most ${max} characters`, 400, "HR-ONBOARDING-VALIDATION");
    return text;
};

/**
 * Upload a document to the caller's open checklist. Validated first, then
 * stored in DAM, then recorded with its event. A DAM failure answers 502 and
 * records nothing; a failed record removes the DAM asset again (best effort).
 */
export async function uploadMyDocument({ tenantId, employeeId, title, category, fileName, mimeType, contentBase64 } = {}) {
    assertSelfPortalEnabled();
    requireTenant(tenantId);
    const cleanTitle = cleanText(title, "The title", DOCUMENT_TITLE_MAX_LENGTH, { required: true });
    const cleanCategory = cleanText(category, "The category", DOCUMENT_CATEGORY_MAX_LENGTH);
    const file = validateOnboardingUpload({ fileName, mimeType, contentBase64 });

    // Refuse before anything reaches DAM when there is nowhere to record it.
    const self = await loadSelf(prisma, tenantId, employeeId);
    const target = await currentChecklist(prisma, tenantId, self.id);
    if (!target) throw fail("You have no onboarding checklist", 404, "HR-ONBOARDING-SELF-NO-CHECKLIST");
    assertOpen(target);

    const uploaded = await uploadFileToDAM({ buffer: file.buffer, mimetype: file.mimeType, originalname: file.fileName }, "document");
    const mediaId = Number(Array.isArray(uploaded) ? uploaded[0]?.id : NaN);
    if (!Number.isInteger(mediaId) || mediaId <= 0) {
        throw fail("The document could not be stored; please try again", 502, "HR-ONBOARDING-DAM-UNAVAILABLE");
    }

    const evtCtx = eventContext({ actorId: self.id });
    try {
        const doc = await tenantTransaction(prisma, async (tx) => {
            // Re-read inside the write: the checklist must still be the caller's and open.
            const checklist = await tx.onboardingChecklist.findFirst({
                where: scopedWhere(tenantId, { id: target.id, employeeId: self.id }),
                select: { id: true, status: true },
            });
            if (!checklist) throw notFound("Onboarding checklist");
            assertOpen(checklist);
            const created = await tx.onboardingDocument.create({
                data: scopedData(tenantId, {
                    checklistId: checklist.id,
                    employeeId: self.id,
                    title: cleanTitle,
                    category: cleanCategory,
                    mediaId,
                    requiresSign: false,
                    source: DOCUMENT_SOURCE.NEW_HIRE,
                    reviewStatus: REVIEW_STATUS.PENDING,
                }),
                select: documentSelect,
            });
            const hrOwnerId = await hrOwnerOf(tx, tenantId, checklist.id);
            await enqueueHrDomainEvent(tx, onboardingDocumentUploadedEvent({ ...created, tenantId: created.tenantId ?? tenantId }, evtCtx, { hrOwnerId }));
            return created;
        }, { tenantId });
        return { document: documentView(doc), fileName: file.fileName, size: file.size, mimeType: file.mimeType };
    } catch (err) {
        const removed = await deleteDamAsset(mediaId).catch((e) => ({ ok: false, error: e?.message }));
        if (!removed?.ok) logger.warn({ mediaId, tenantId, error: removed?.error }, "onboarding upload: orphaned DAM asset after a failed record");
        throw err;
    }
}

// ── 4. sign ─────────────────────────────────────────────────────────────────

/** Sign an HR-supplied document of the caller's open checklist that requires it. */
export async function signMyDocument({ tenantId, employeeId, documentId, now = new Date() } = {}) {
    assertSelfPortalEnabled();
    requireTenant(tenantId);
    const id = positiveInt(documentId, "document id");
    const evtCtx = eventContext({ actorId: employeeId });
    return tenantTransaction(prisma, async (tx) => {
        const self = await loadSelf(tx, tenantId, employeeId);
        const checklists = await ownChecklists(tx, tenantId, self.id);
        const doc = checklists.length
            ? await tx.onboardingDocument.findFirst({
                where: scopedWhere(tenantId, { id, employeeId: self.id, checklistId: { in: checklists.map((c) => c.id) } }),
                select: documentSelect,
            })
            : null;
        if (!doc) throw notFound("Document");
        assertOpen(checklists.find((c) => c.id === doc.checklistId));
        if (doc.source !== DOCUMENT_SOURCE.HR || !doc.requiresSign) {
            throw fail("This document does not need your signature", 409, "HR-ONBOARDING-DOCUMENT-NOT-SIGNABLE");
        }
        if (doc.signedAt) throw fail("You have already signed this document", 409, "HR-ONBOARDING-DOCUMENT-ALREADY-SIGNED");

        const moved = await tx.onboardingDocument.updateMany({
            where: scopedWhere(tenantId, { id, signedAt: null }),
            data: { signedAt: now, signedByEmpId: self.id },
        });
        if (moved.count === 0) throw fail("You have already signed this document", 409, "HR-ONBOARDING-DOCUMENT-ALREADY-SIGNED");
        const signed = await tx.onboardingDocument.findFirst({ where: scopedWhere(tenantId, { id }), select: documentSelect });
        const hrOwnerId = await hrOwnerOf(tx, tenantId, doc.checklistId);
        await enqueueHrDomainEvent(tx, onboardingDocumentSignedEvent({ ...signed, tenantId: signed.tenantId ?? tenantId }, evtCtx, { hrOwnerId }));
        return { document: documentView(signed) };
    }, { tenantId });
}

// ── 5. survey ───────────────────────────────────────────────────────────────

/** Submit an issued, unsubmitted 30/60/90 day survey of the caller's. */
export async function submitMySurvey({ tenantId, employeeId, type, responses, now = new Date() } = {}) {
    assertSelfPortalEnabled();
    requireTenant(tenantId);
    const surveyType = String(type ?? "").toUpperCase();
    if (!SELF_SURVEY_TYPES.includes(surveyType)) {
        throw fail("The survey type must be DAY_30, DAY_60 or DAY_90", 400, "HR-ONBOARDING-VALIDATION");
    }
    const parsed = SURVEY_RESPONSES_SCHEMA.safeParse(responses);
    if (!parsed.success) {
        throw fail(parsed.error.issues[0]?.message || "The survey answers are not valid", 400, "HR-ONBOARDING-SURVEY-RESPONSES");
    }
    const evtCtx = eventContext({ actorId: employeeId });
    return tenantTransaction(prisma, async (tx) => {
        const self = await loadSelf(tx, tenantId, employeeId);
        // Surveys outlive the checklist (day 90 is usually after completion),
        // so any of the caller's checklists counts here.
        const checklistIds = (await ownChecklists(tx, tenantId, self.id)).map((c) => c.id);
        const base = { employeeId: self.id, type: surveyType, checklistId: { in: checklistIds } };
        const survey = checklistIds.length
            ? await tx.onboardingSurvey.findFirst({
                where: scopedWhere(tenantId, { ...base, issuedAt: { not: null }, submittedAt: null }),
                orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
            })
            : null;
        if (!survey) {
            const submitted = checklistIds.length
                ? await tx.onboardingSurvey.findFirst({ where: scopedWhere(tenantId, { ...base, submittedAt: { not: null } }), select: { id: true } })
                : null;
            if (submitted) throw fail("You have already submitted this survey", 409, "HR-ONBOARDING-SURVEY-ALREADY-SUBMITTED");
            throw fail("This survey has not been sent to you", 404, "HR-ONBOARDING-SURVEY-NOT-ISSUED");
        }
        const moved = await tx.onboardingSurvey.updateMany({
            where: scopedWhere(tenantId, { id: survey.id, submittedAt: null }),
            data: { responses: parsed.data, submittedAt: now },
        });
        if (moved.count === 0) throw fail("You have already submitted this survey", 409, "HR-ONBOARDING-SURVEY-ALREADY-SUBMITTED");
        const saved = { ...survey, submittedAt: now, tenantId: survey.tenantId ?? tenantId };
        await enqueueHrDomainEvent(tx, onboardingSurveySubmittedEvent(saved, evtCtx));
        return { survey: { id: saved.id, type: saved.type, submittedAt: now, dueAt: saved.dueAt ?? null } };
    }, { tenantId });
}

// ── HR: review and the pending queue ────────────────────────────────────────

/**
 * HR verifies or rejects a new hire's upload (PENDING only; a note is required
 * on a rejection and reaches the new hire). Nobody reviews their own upload.
 */
export async function reviewOnboardingDocument({ tenantId, reviewerId = null, documentId, decision, note, now = new Date() } = {}) {
    assertDocumentReviewEnabled();
    requireTenant(tenantId);
    const id = positiveInt(documentId, "document id");
    const verdict = String(decision ?? "").toUpperCase();
    if (!REVIEW_DECISIONS.includes(verdict)) {
        throw fail("The decision must be VERIFIED or REJECTED", 400, "HR-ONBOARDING-VALIDATION");
    }
    const cleanNote = cleanText(note, "The note", REVIEW_NOTE_MAX_LENGTH, { required: verdict === REVIEW_STATUS.REJECTED });
    const reviewer = reviewerId != null && Number.isInteger(Number(reviewerId)) && Number(reviewerId) > 0 ? Number(reviewerId) : null;
    const evtCtx = eventContext({ actorId: reviewer });
    return tenantTransaction(prisma, async (tx) => {
        const doc = await tx.onboardingDocument.findFirst({ where: scopedWhere(tenantId, { id }), select: documentSelect });
        if (!doc) throw notFound("Document");
        if (doc.source !== DOCUMENT_SOURCE.NEW_HIRE) {
            throw fail("Only a document the new hire uploaded is reviewed", 409, "HR-ONBOARDING-DOCUMENT-NOT-REVIEWABLE");
        }
        if (reviewer != null && reviewer === doc.employeeId) {
            throw fail("You cannot review your own document", 403, "HR-ONBOARDING-REVIEW-OWN-DOCUMENT");
        }
        if (doc.reviewStatus !== REVIEW_STATUS.PENDING) {
            throw fail("This document has already been reviewed", 409, "HR-ONBOARDING-DOCUMENT-ALREADY-REVIEWED");
        }
        const moved = await tx.onboardingDocument.updateMany({
            where: scopedWhere(tenantId, { id, reviewStatus: REVIEW_STATUS.PENDING }),
            data: { reviewStatus: verdict, reviewedAt: now, reviewedById: reviewer, reviewNote: cleanNote },
        });
        if (moved.count === 0) throw fail("This document has already been reviewed", 409, "HR-ONBOARDING-DOCUMENT-ALREADY-REVIEWED");
        const reviewed = await tx.onboardingDocument.findFirst({ where: scopedWhere(tenantId, { id }), select: documentSelect });
        await enqueueHrDomainEvent(tx, onboardingDocumentReviewedEvent({ ...reviewed, tenantId: reviewed.tenantId ?? tenantId }, evtCtx));
        return {
            document: {
                ...documentView(reviewed),
                checklistId: reviewed.checklistId,
                employeeId: reviewed.employeeId,
                reviewNote: reviewed.reviewNote ?? null,
                reviewedAt: reviewed.reviewedAt ?? null,
                reviewedById: reviewed.reviewedById ?? null,
            },
        };
    }, { tenantId });
}

/** HR: new hires' uploads waiting for review, oldest first. */
export async function listPendingOnboardingDocuments({ tenantId, checklistId, employeeId, page = 1, limit = 50 } = {}) {
    assertDocumentReviewEnabled();
    requireTenant(tenantId);
    const take = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const pageNo = Math.max(Number(page) || 1, 1);
    const where = scopedWhere(tenantId, {
        source: DOCUMENT_SOURCE.NEW_HIRE,
        reviewStatus: REVIEW_STATUS.PENDING,
        ...(checklistId != null ? { checklistId: positiveInt(checklistId, "checklist id") } : {}),
        ...(employeeId != null ? { employeeId: positiveInt(employeeId, "employee id") } : {}),
    });
    const [rows, total] = await Promise.all([
        prisma.onboardingDocument.findMany({
            where,
            orderBy: [{ created_at: "asc" }, { id: "asc" }],
            skip: (pageNo - 1) * take,
            take,
            select: documentSelect,
        }),
        prisma.onboardingDocument.count({ where }),
    ]);
    const ids = [...new Set(rows.map((r) => r.employeeId))];
    const people = ids.length
        ? await prisma.employee.findMany({ where: scopedEmployeeWhere(tenantId, { id: { in: ids } }), select: personSelect })
        : [];
    const nameOf = new Map(people.map((p) => [p.id, displayName(p)]));
    return {
        items: rows.map((r) => ({
            id: r.id,
            checklistId: r.checklistId,
            employeeId: r.employeeId,
            employeeName: nameOf.get(r.employeeId) ?? null,
            title: r.title,
            category: r.category ?? null,
            mediaId: r.mediaId ?? null,
            reviewStatus: r.reviewStatus,
            uploadedAt: r.created_at ?? null,
        })),
        total,
        page: pageNo,
        limit: take,
    };
}
