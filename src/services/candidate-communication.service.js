// src/services/candidate-communication.service.js
//
// Recruitment Phase 2 — the candidate communications log.
//
// Every candidate-facing message the recruitment module produces is a
// CandidateCommunication row first and an email second:
//
//   event / recruiter -> row QUEUED (dedupe key) -> delivery loop -> SENT
//                                                                  | SUPPRESSED
//                                                                  | FAILED
//   recruiter cancel / reinstatement -> CANCELLED (only while QUEUED)
//
// The unique (tenantId, dedupeKey) makes each message exactly-once: an event
// redelivered by the stream, or a recruiter's retried click (same
// clientRequestId), lands on the existing row. Contact details are never
// stored on the row: the delivery loop reads the address at send time, after
// the DNC and consent checks, so a candidate who opts out between queueing and
// sending is not contacted.
//
// This module holds what the consumer, the delivery loop and the tools share:
// context resolution, row building, queueing and cancelling, the list/send/
// cancel operations, and the two outbox event builders.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { withTenant } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import {
    RECRUITMENT_SCOPE,
    applicationScopeWhere,
    candidateScopeWhere,
} from "../lib/recruitmentAccess.js";
import { getRecruitmentSettings } from "./recruitment-settings.service.js";
import { PORTAL_STATUS_REQUEST_PATH } from "./candidateVerification.service.js";
import {
    getCommunicationTemplate,
    listCommunicationTemplateSummaries,
} from "./candidate-communication.templates.js";

const commsLog = logger.child({ component: "candidate-communication" });

export const COMMUNICATION_STATUS = Object.freeze({
    QUEUED: "QUEUED",
    SENT: "SENT",
    SUPPRESSED: "SUPPRESSED",
    FAILED: "FAILED",
    CANCELLED: "CANCELLED",
});

export const SUPPRESSED_REASONS = Object.freeze(["DNC", "CONSENT_WITHDRAWN", "NO_EMAIL", "ANONYMIZED", "DISABLED"]);

export const SENT_EVENT = "hr.recruitment.candidate_communication_sent.v1";
export const SUPPRESSED_EVENT = "hr.recruitment.candidate_communication_suppressed.v1";

export const PERSONAL_NOTE_MAX = 1000;
export const CANCEL_REASON_MAX = 500;
const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const HOUR_MS = 60 * 60 * 1000;

const fail = (message, code, status = 400) => Object.assign(new Error(message), { status, code });

const positiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

const idStr = (value) => (value != null ? String(value) : null);

const isUniqueViolation = (err) => err?.code === "P2002";

// ── Outbox event builders (pure) ────────────────────────────────────────────
// ids, the template and the outcome only: never the address, the name or the
// message data. aggregateId is the row id.
function communicationEvent(eventName, row, ctx = {}, extra = {}) {
    if (!row?.tenantId) return null;
    return {
        eventName,
        tenantId: row.tenantId,
        aggregateType: "CandidateCommunication",
        aggregateId: row.id,
        actorId: ctx?.actorId,
        correlationId: ctx?.correlationId,
        payload: {
            communicationId: String(row.id),
            candidateId: idStr(row.candidateId),
            applicationId: idStr(row.applicationId),
            requisitionId: idStr(row.requisitionId),
            templateId: row.templateId ?? null,
            category: row.category ?? null,
            status: extra.status ?? row.status ?? null,
            reason: extra.reason ?? null,
        },
    };
}

export function candidateCommunicationSentEvent(row, ctx = {}) {
    return communicationEvent(SENT_EVENT, row, ctx, { status: COMMUNICATION_STATUS.SENT });
}

export function candidateCommunicationSuppressedEvent(row, ctx = {}, extra = {}) {
    return communicationEvent(SUPPRESSED_EVENT, row, ctx, {
        status: COMMUNICATION_STATUS.SUPPRESSED,
        reason: extra.reason ?? null,
    });
}

// ── Context ─────────────────────────────────────────────────────────────────

/** The portal status page (no token: the candidate requests a fresh link there). */
export function statusPageUrlFor(settings, env = process.env) {
    const base = String(settings?.portalBaseUrl || env.HR_PORTAL_BASE_URL || "").trim().replace(/\/+$/, "");
    return base ? `${base}${PORTAL_STATUS_REQUEST_PATH}` : null;
}

const APPLICATION_SELECT = Object.freeze({
    id: true,
    tenantId: true,
    candidateId: true,
    jobRequisitionId: true,
    stage: true,
    candidate: { select: { id: true, firstName: true } },
    jobRequisition: { select: { id: true, title: true } },
    offer: { select: { id: true, status: true } },
});

/** One application with what a template renders, tenant-scoped, or null. */
export async function loadApplicationForCommunication({ tenantId, applicationId, extraWhere = {}, db = prisma }) {
    const id = positiveInt(applicationId);
    if (!id) return null;
    return db.application.findFirst({
        where: withTenant(tenantId, { id, ...extraWhere }),
        select: APPLICATION_SELECT,
    });
}

/** The tenant facts every template renders, read once per event. */
export async function loadTenantCommunicationFacts(tenantId) {
    const settings = await getRecruitmentSettings({ tenantId });
    return { settings, statusPageUrl: statusPageUrlFor(settings) };
}

/** Template context for one application (+ event-specific extras). */
export function communicationContext(application, facts, extra = {}) {
    return {
        application: { stage: application?.stage ?? null },
        candidate: { firstName: application?.candidate?.firstName ?? null },
        requisition: { title: application?.jobRequisition?.title ?? null },
        offer: application?.offer ? { status: application.offer.status } : null,
        settings: { companyName: facts?.settings?.companyName ?? null },
        statusPageUrl: facts?.statusPageUrl ?? null,
        ...extra,
    };
}

// Defence in depth: whatever a template builds, contact fields never reach the
// row (the hub gets the address as the recipient at send time).
const FORBIDDEN_DATA_KEYS = Object.freeze(["email", "phone", "lastName", "address", "stage", "reason", "reasonCode", "dispositionReason", "notes"]);
export function sanitizeTemplateData(data) {
    const out = {};
    for (const [key, value] of Object.entries(data ?? {})) {
        if (FORBIDDEN_DATA_KEYS.includes(key)) continue;
        out[key] = value;
    }
    return out;
}

/**
 * The QUEUED row for one (template, application). REJECTION waits the tenant's
 * rejectionDelayHours from `decidedAt` (the event time), everything else is
 * due at once.
 */
export function buildCommunicationRow({
    tenantId,
    template,
    application,
    context,
    dedupeKey,
    eventId = null,
    eventName = null,
    createdById = null,
    rejectionDelayHours = 0,
    decidedAt,
    now = new Date(),
}) {
    const base = decidedAt instanceof Date && !Number.isNaN(decidedAt.getTime()) && decidedAt <= now ? decidedAt : now;
    const delayHours = template.category === "REJECTION" ? Math.max(0, Number(rejectionDelayHours) || 0) : 0;
    return {
        tenantId,
        candidateId: application.candidateId,
        applicationId: application.id,
        requisitionId: application.jobRequisitionId ?? null,
        eventId,
        eventName,
        templateId: template.id,
        channel: "email",
        category: template.category,
        dedupeKey,
        status: COMMUNICATION_STATUS.QUEUED,
        scheduledFor: delayHours ? new Date(base.getTime() + delayHours * HOUR_MS) : new Date(now),
        data: sanitizeTemplateData(template.buildData(context)),
        createdById: positiveInt(createdById),
    };
}

/**
 * Insert QUEUED rows; a dedupe key that already exists is skipped (redelivery
 * is a no-op). Returns how many rows were new.
 */
export async function queueCommunicationRows(tenantId, rows) {
    if (!rows.length) return { queued: 0, duplicates: 0 };
    const result = await tenantTransaction(
        prisma,
        async (tx) => await tx.candidateCommunication.createMany({ data: rows, skipDuplicates: true }),
        { tenantId },
    );
    const queued = Number(result?.count ?? 0);
    return { queued, duplicates: rows.length - queued };
}

/**
 * Cancel QUEUED rows matching `where` (tenant-scoped). Each row keeps the
 * cancellation (reason, who, when) in its data; a row a worker has claimed is
 * left alone (it is being sent right now). Returns the number cancelled.
 */
export async function cancelQueuedCommunications({ tenantId, where = {}, reason, actorId = null, now = new Date() }) {
    const rows = await prisma.candidateCommunication.findMany({
        where: withTenant(tenantId, { ...where, status: COMMUNICATION_STATUS.QUEUED }),
        select: { id: true, data: true },
    });
    let cancelled = 0;
    for (const row of rows) {
        cancelled += await cancelOne({ tenantId, row, reason, actorId, now });
    }
    return cancelled;
}

const unclaimedAt = (now) => ({ OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lt: now } }] });

async function cancelOne({ tenantId, row, reason, actorId, now }) {
    const cancellation = {
        reason: String(reason ?? "").slice(0, CANCEL_REASON_MAX),
        cancelledById: positiveInt(actorId),
        cancelledAt: now.toISOString(),
    };
    const result = await tenantTransaction(
        prisma,
        async (tx) =>
            await tx.candidateCommunication.updateMany({
                where: withTenant(tenantId, { id: row.id, status: COMMUNICATION_STATUS.QUEUED, ...unclaimedAt(now) }),
                data: {
                    status: COMMUNICATION_STATUS.CANCELLED,
                    data: { ...(row.data ?? {}), cancellation },
                    claimedBy: null,
                    claimExpiresAt: null,
                    nextAttemptAt: null,
                },
            }),
        { tenantId },
    );
    return Number(result?.count ?? 0);
}

// ── Presentation ────────────────────────────────────────────────────────────

const LIST_SELECT = Object.freeze({
    id: true,
    candidateId: true,
    applicationId: true,
    requisitionId: true,
    templateId: true,
    category: true,
    channel: true,
    status: true,
    suppressedReason: true,
    scheduledFor: true,
    sentAt: true,
    attempts: true,
    eventName: true,
    createdById: true,
    createdAt: true,
    data: true,
});

// The log entry a recruiter sees: what was (or will be) sent, when, and why it
// was not. The message data itself stays out (it may hold a personal note);
// only the cancellation reason is lifted out of it.
export function presentCommunication(row) {
    if (!row) return null;
    const { data, ...rest } = row;
    const cancellation = data && typeof data === "object" ? data.cancellation : null;
    return {
        ...rest,
        hasPersonalNote: Boolean(data && typeof data === "object" && data.personalNote),
        cancelReason: cancellation?.reason ?? null,
        cancelledAt: cancellation?.cancelledAt ?? null,
    };
}

// ── Operations (tools) ──────────────────────────────────────────────────────

const requireTenant = (tenantId) => {
    if (!tenantId) throw fail("Verified company is required", "HR-TENANT-REQUIRED", 403);
};

const requireOrgScope = (scope) => {
    if (scope?.level !== RECRUITMENT_SCOPE.ORG) {
        throw fail("Only recruiters can send or cancel candidate messages", "HR-RECRUITMENT-COMMUNICATIONS-FORBIDDEN", 403);
    }
};

const requireCommunicationsEnabled = () => {
    if (!isRecruitmentFlagEnabled("communications")) {
        throw fail("Candidate communications are disabled", "HR-RECRUITMENT-COMMUNICATIONS-DISABLED", 503);
    }
};

const notFound = (what) => fail(`${what} not found`, `HR-RECRUITMENT-${what.toUpperCase()}-NOT-FOUND`, 404);

/**
 * The communications log for one candidate or one application, cut to the
 * caller's scope. A candidate or application outside the scope is not found
 * (never forbidden). A restricted caller sees only the messages about the
 * applications their scope reaches, not the candidate's other applications.
 */
export async function listCandidateCommunications({ tenantId, scope, candidateId, applicationId, status, page = 1, pageSize = 50 } = {}) {
    requireTenant(tenantId);
    const appId = positiveInt(applicationId);
    const candId = positiveInt(candidateId);
    if (!appId && !candId) throw fail("candidateId or applicationId is required", "HR-RECRUITMENT-COMMUNICATIONS-TARGET-REQUIRED");

    const where = withTenant(tenantId, {});
    if (appId) {
        const application = await prisma.application.findFirst({
            where: withTenant(tenantId, { id: appId, ...(candId ? { candidateId: candId } : {}), ...applicationScopeWhere(scope) }),
            select: { id: true },
        });
        if (!application) throw notFound("Application");
        where.applicationId = appId;
    } else {
        const candidate = await prisma.candidate.findFirst({
            where: withTenant(tenantId, { id: candId, ...candidateScopeWhere(scope) }),
            select: { id: true },
        });
        if (!candidate) throw notFound("Candidate");
        where.candidateId = candId;
        if (!scope?.unrestricted) {
            const visible = await prisma.application.findMany({
                where: withTenant(tenantId, { candidateId: candId, ...applicationScopeWhere(scope) }),
                select: { id: true },
            });
            where.applicationId = { in: visible.map((a) => a.id) };
        }
    }
    if (status) where.status = String(status).toUpperCase();

    const take = Math.min(Math.max(positiveInt(pageSize) ?? 50, 1), 200);
    const current = positiveInt(page) ?? 1;
    const [items, total] = await Promise.all([
        prisma.candidateCommunication.findMany({
            where,
            select: LIST_SELECT,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: (current - 1) * take,
            take,
        }),
        prisma.candidateCommunication.count({ where }),
    ]);
    return { items: items.map(presentCommunication), total, page: current, pageSize: take };
}

/** The catalogue for the templates tool. */
export function listCommunicationTemplates() {
    return listCommunicationTemplateSummaries();
}

// Plain text only: markup and control characters are removed (a newline is
// kept), and an empty note is no note.
export function normalizePersonalNote(note) {
    if (note == null) return null;
    const text = String(note)
        .replace(/<[^>]*>/g, "")
        .replace(/[^\S\n]+/g, " ")
        .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "")
        .trim();
    if (text.length > PERSONAL_NOTE_MAX) {
        throw fail(`personalNote must be at most ${PERSONAL_NOTE_MAX} characters`, "HR-RECRUITMENT-COMMUNICATION-NOTE-TOO-LONG");
    }
    return text || null;
}

function assertManualTemplate(template, application, note) {
    if (!template || !template.manual) {
        throw fail("Unknown or non-manual communication template", "HR-RECRUITMENT-COMMUNICATION-TEMPLATE-INVALID");
    }
    if (note && !template.personalNote) {
        throw fail(`Template ${template.id} does not take a personal note`, "HR-RECRUITMENT-COMMUNICATION-NOTE-NOT-ALLOWED");
    }
    if (application.stage === "withdrawn") {
        throw fail("The candidate withdrew this application", "HR-RECRUITMENT-APPLICATION-WITHDRAWN", 409);
    }
    if (template.manualStages && !template.manualStages.includes(application.stage)) {
        throw fail(
            `Template ${template.id} does not match the application's current status`,
            "HR-RECRUITMENT-COMMUNICATION-TEMPLATE-STAGE",
            409,
        );
    }
    if (template.category === "OFFER" && application.offer?.status !== "SENT") {
        throw fail("An offer message needs a sent offer", "HR-RECRUITMENT-COMMUNICATION-OFFER-NOT-SENT", 409);
    }
}

/**
 * A recruiter's message for one application: a catalogue template, optionally
 * with a personal note, through the same QUEUED -> delivery path (and the same
 * DNC and consent checks at send) as the event-driven ones. Idempotent on
 * clientRequestId. A personalised offer message replaces an automatic one
 * that has not gone out yet.
 */
export async function sendManualCandidateCommunication({
    tenantId,
    scope,
    actorId = null,
    applicationId,
    templateId,
    personalNote,
    clientRequestId,
    now = new Date(),
} = {}) {
    requireTenant(tenantId);
    requireOrgScope(scope);
    requireCommunicationsEnabled();
    const requestId = String(clientRequestId ?? "").trim();
    if (!CLIENT_REQUEST_ID_RE.test(requestId)) {
        throw fail("clientRequestId is required (1-100 of A-Z a-z 0-9 . _ : -)", "HR-RECRUITMENT-COMMUNICATION-REQUEST-ID");
    }
    const template = getCommunicationTemplate(String(templateId ?? ""));
    const note = normalizePersonalNote(personalNote);

    const application = await loadApplicationForCommunication({
        tenantId,
        applicationId,
        extraWhere: applicationScopeWhere(scope),
    });
    if (!application) throw notFound("Application");
    assertManualTemplate(template, application, note);

    const dedupeKey = `manual:${application.id}:${template.id}:${requestId}`;
    const existing = await findByDedupeKey(tenantId, dedupeKey);
    if (existing) return { communication: presentCommunication(existing), replayed: true };

    const facts = await loadTenantCommunicationFacts(tenantId);
    const row = buildCommunicationRow({
        tenantId,
        template,
        application,
        context: communicationContext(application, facts, { personalNote: note }),
        dedupeKey,
        createdById: actorId,
        now,
    });

    let created;
    try {
        created = await tenantTransaction(
            prisma,
            async (tx) => await tx.candidateCommunication.create({ data: row, select: LIST_SELECT }),
            { tenantId },
        );
    } catch (err) {
        // A concurrent retry with the same clientRequestId won the insert.
        if (!isUniqueViolation(err)) throw err;
        const winner = await findByDedupeKey(tenantId, dedupeKey);
        if (winner) return { communication: presentCommunication(winner), replayed: true };
        throw err;
    }

    let superseded = 0;
    if (template.category === "OFFER") {
        superseded = await cancelQueuedCommunications({
            tenantId,
            where: { applicationId: application.id, templateId: template.id, eventId: { not: null } },
            reason: "SUPERSEDED_BY_PERSONALISED_MESSAGE",
            actorId,
            now,
        });
    }
    commsLog.info(
        { communicationId: created.id, applicationId: application.id, templateId: template.id, superseded },
        "candidate communication: manual message queued",
    );
    return { communication: presentCommunication(created), replayed: false, superseded };
}

function findByDedupeKey(tenantId, dedupeKey) {
    return prisma.candidateCommunication.findFirst({
        where: withTenant(tenantId, { dedupeKey }),
        select: LIST_SELECT,
    });
}

/** Cancel one QUEUED message (e.g. a delayed rejection) with a reason. */
export async function cancelCandidateCommunication({ tenantId, scope, actorId = null, id, reason, now = new Date() } = {}) {
    requireTenant(tenantId);
    requireOrgScope(scope);
    const commId = positiveInt(id);
    const text = String(reason ?? "").trim();
    if (!text) throw fail("A cancellation reason is required", "HR-RECRUITMENT-COMMUNICATION-CANCEL-REASON");
    if (text.length > CANCEL_REASON_MAX) {
        throw fail(`reason must be at most ${CANCEL_REASON_MAX} characters`, "HR-RECRUITMENT-COMMUNICATION-CANCEL-REASON");
    }
    const row = commId
        ? await prisma.candidateCommunication.findFirst({ where: withTenant(tenantId, { id: commId }), select: LIST_SELECT })
        : null;
    if (!row) throw notFound("Communication");
    if (row.status !== COMMUNICATION_STATUS.QUEUED) {
        throw fail(`Only a queued message can be cancelled (status: ${row.status})`, "HR-RECRUITMENT-COMMUNICATION-NOT-CANCELLABLE", 409);
    }
    const cancelled = await cancelOne({ tenantId, row, reason: text, actorId, now });
    if (!cancelled) {
        // Claimed by the delivery loop (or finished) between the read and now.
        throw fail("The message is being sent and can no longer be cancelled", "HR-RECRUITMENT-COMMUNICATION-IN-FLIGHT", 409);
    }
    const updated = await prisma.candidateCommunication.findFirst({ where: withTenant(tenantId, { id: row.id }), select: LIST_SELECT });
    commsLog.info({ communicationId: row.id }, "candidate communication: cancelled");
    return { communication: presentCommunication(updated) };
}
