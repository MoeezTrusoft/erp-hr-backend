// src/services/dsr-export.service.js
//
// Recruitment Phase 5 (plan 6.9) — the access export for a data-subject
// request: "generated from all candidate-linked tables".
//
// hr_candidate_request_export_generate (POST, ORG scope, dsrPortal flag)
// builds ONE JSON document of everything HR holds about the request's
// candidate, uploads it to DAM as a file, and stamps exportMediaId and
// exportGeneratedAt on the request (a regenerated export replaces the old
// file, which is then deleted from DAM: two copies of someone's data is one
// too many).
//
// WHAT IT CONTAINS — every row reached from the candidate id (or, for the
// do-not-contact register, the candidate's own address): the profile, parsed
// skills and tags; applications with stage history, the subject's own answers,
// screening outcomes, fit scores, interviews with the panel and the
// scorecards' ratings and recommendations, on-site test results and
// check-ins, the offer with its letter versions; the communications log;
// consents; do-not-contact entries; talent pools and invitations; saved
// application drafts; the AI processing records (metadata); the subject's own
// data requests; and every document as METADATA only (DAM media ids, kinds,
// dates — never the bytes, and never a link that would work without HR).
//
// WHAT IT NEVER CONTAINS:
//   * Another person's data. Every query is keyed by this candidate's id (or
//     their applications, interviews and offers, read tenant-scoped first).
//     Reviewers and panel members appear by name only; duplicate suggestions
//     (which name another candidate) and referrals (which identify the
//     referring employee) are left out entirely. The request must belong to
//     the candidate: the candidate's address must equal the request's verified
//     subject address, or nothing is generated.
//   * Internal notes. DECISION: every free-text field written BY STAFF is
//     withheld from the automatic export — the internal notes the row-scope
//     library already masks (Candidate.notes, Interview.notes) and the same
//     class on the other records (Offer.notes, screening notes and criteria,
//     scorecard notes and per-criterion evidence notes, the hold reason, stage
//     move reasons, the test decision reason, DNC and lift reasons, talent pool
//     notes, the check-in accommodation reason). Free text can name other
//     people, so it cannot be released without a human reading it. The export
//     lists each withheld field with its count (`withheld`), so HR can review
//     and release it by hand when the request warrants it. Text the SUBJECT
//     wrote (answers, invitation replies, offer decline notes, drafts) is
//     theirs and is included.
//   * Legal holds (legally privileged; disclosed by counsel, not by a tool),
//     verification and link tokens, outbox/event internals, and the
//     communications' template variables (they can carry live links).
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { withTenant } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { RECRUITMENT_SCOPE } from "../lib/recruitmentAccess.js";
import { storedCriteriaOf, storedDecisionOf } from "../lib/evaluation-form.util.js";
import { deleteDamAsset, uploadFileToDAM } from "./dam.media.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { logAction } from "../utils/logs.js";

const log = logger.child({ component: "dsr-export" });

export const DSR_EXPORT_GENERATED_EVENT = "hr.recruitment.dsr_export_generated.v1";
export const ACCESS_EXPORT_FORMAT = "trusoft.hr.candidate-access-export";
export const ACCESS_EXPORT_VERSION = 1;
const OPEN_STATUSES = Object.freeze(["RECEIVED", "IN_PROGRESS"]);

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });
const positiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};
const normalizeEmail = (email) => String(email ?? "").trim().toLowerCase();
const hasText = (value) => typeof value === "string" && value.trim() !== "";
const iso = (value) => {
    if (value == null) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const uniq = (values) => [...new Set(values.filter((v) => v != null))];

// ── Reading (every query keyed by this candidate) ────────────────────────────

// One query at a time: these run on one interactive-transaction connection.
const inOrder = async (thunks) => {
    const out = [];
    for (const thunk of thunks) out.push(await thunk());
    return out;
};

const CANDIDATE_SELECT = Object.freeze({
    id: true,
    firstName: true,
    lastName: true,
    email: true,
    phone: true,
    location: true,
    source: true,
    status: true,
    consentStatus: true,
    consentUpdatedAt: true,
    retentionUntil: true,
    retentionPopulation: true,
    archivedAt: true,
    anonymizedAt: true,
    emailVerifiedAt: true,
    parsedResume: true,
    resumeMediaId: true,
    resumeUrl: true,
    notes: true,
    createdAt: true,
    updatedAt: true,
});

/**
 * Read everything linked to one candidate. `db` is a tenant-scoped client
 * (a tenantTransaction tx). Returns the raw rows; buildAccessExport shapes them.
 */
export async function collectCandidateData(db, tenantId, candidateId) {
    const byCandidate = withTenant(tenantId, { candidateId });
    const candidate = await db.candidate.findFirst({ where: withTenant(tenantId, { id: candidateId }), select: CANDIDATE_SELECT });
    if (!candidate) return null;

    const applications = await db.application.findMany({
        where: byCandidate,
        select: {
            id: true, jobRequisitionId: true, stage: true, status: true, appliedAt: true, updatedAt: true,
            sourceChannel: true, dispositionReason: true, withdrawnReason: true, holdReason: true,
            knockedOut: true, answerScore: true, answerMaxScore: true,
            jobRequisition: { select: { id: true, title: true } },
        },
        orderBy: [{ appliedAt: "asc" }, { id: "asc" }],
    });
    const applicationIds = applications.map((a) => a.id);
    const inApplications = { applicationId: { in: applicationIds } };
    const none = applicationIds.length === 0;

    const [stageHistory, answers, screenings, interviews, scores] = none
        ? [[], [], [], [], []]
        : await inOrder([
            () => db.applicationStageHistory.findMany({
                where: withTenant(tenantId, inApplications),
                select: { applicationId: true, fromStage: true, toStage: true, source: true, reason: true, createdAt: true },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            }),
            // ApplicationAnswer has no tenant column; the application ids were
            // read tenant-scoped above.
            () => db.applicationAnswer.findMany({
                where: inApplications,
                select: { applicationId: true, value: true, score: true, answeredAt: true, question: { select: { prompt: true } } },
                orderBy: [{ answeredAt: "asc" }, { id: "asc" }],
            }),
            () => db.applicationScreening.findMany({
                where: withTenant(tenantId, inApplications),
                select: { applicationId: true, outcome: true, reasonCode: true, scoreOverall: true, reviewedById: true, reviewedAt: true, notes: true, criteria: true },
                orderBy: [{ reviewedAt: "asc" }, { id: "asc" }],
            }),
            () => db.interview.findMany({
                where: withTenant(tenantId, inApplications),
                select: {
                    id: true, applicationId: true, interviewType: true, scheduledAt: true, durationMinutes: true, location: true,
                    status: true, decision: true, noShowAt: true, notes: true,
                    interviewers: { select: { employeeId: true, panelRole: true, status: true } },
                },
                orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
            }),
            () => db.applicationScore.findMany({
                where: withTenant(tenantId, inApplications),
                select: { applicationId: true, score: true, band: true, modelVersion: true, components: true, computedAt: true },
            }),
        ]);

    const interviewIds = interviews.map((i) => i.id);
    const scorecards = interviewIds.length
        ? await db.interviewScorecard.findMany({
            where: withTenant(tenantId, { interviewId: { in: interviewIds } }),
            select: {
                interviewId: true, reviewerId: true, status: true, overallScore: true, weightedScore: true, recommendation: true,
                scores: true, criterionScores: true, mustHaveFailed: true, submittedAt: true, notes: true,
            },
            orderBy: [{ id: "asc" }],
        })
        : [];

    const [skills, tags, testResults, checkIns, offers, communications, consents, dnc, pools, invitations, drafts, aiRecords, requests] = await inOrder([
        () => db.candidateSkill.findMany({
            where: byCandidate,
            select: { name: true, category: true, level: true, score: true, source: true, createdAt: true },
            orderBy: [{ id: "asc" }],
        }),
        () => db.candidateTag.findMany({ where: byCandidate, select: { tag: { select: { name: true } } }, orderBy: [{ id: "asc" }] }),
        () => db.candidateTestResult.findMany({
            where: byCandidate,
            select: {
                applicationId: true, jobFamily: true, rawScore: true, maxScore: true, scorePct: true, sectionScores: true, band: true,
                decision: true, decisionReason: true, decidedAt: true, validUntil: true, createdAt: true,
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        }),
        () => db.candidateCheckIn.findMany({
            where: byCandidate,
            select: { applicationId: true, arrivedAt: true, idType: true, idLast4: true, consentAt: true, photoMediaId: true, accommodations: true, accommodationReason: true },
            orderBy: [{ arrivedAt: "asc" }, { id: "asc" }],
        }),
        () => db.offer.findMany({
            where: byCandidate,
            select: {
                id: true, applicationId: true, salary: true, currency: true, startDate: true, expiryDate: true, status: true,
                sentAt: true, viewedAt: true, respondedAt: true, offerType: true, employmentType: true, terms: true, compensation: true,
                declineReasonCode: true, declineNote: true, talentPoolOptIn: true, offerLetterMediaId: true, notes: true, created_at: true,
                letterVersions: { select: { version: true, mediaId: true, signedMediaId: true, signatureStatus: true, createdAt: true, signedAt: true } },
            },
            orderBy: [{ id: "asc" }],
        }),
        () => db.candidateCommunication.findMany({
            where: byCandidate,
            select: { applicationId: true, templateId: true, channel: true, category: true, status: true, suppressedReason: true, scheduledFor: true, sentAt: true, createdAt: true },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        }),
        () => db.candidateConsent.findMany({
            where: byCandidate,
            select: { purpose: true, status: true, policyVersion: true, source: true, evidence: true, occurredAt: true },
            orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
        }),
        () => db.candidateDncEntry.findMany({
            where: withTenant(tenantId, { OR: [{ candidateId }, { email: normalizeEmail(candidate.email) }] }),
            select: { reasonCode: true, scope: true, status: true, effectiveFrom: true, expiresAt: true, liftedAt: true, reason: true, liftReason: true },
            orderBy: [{ effectiveFrom: "asc" }, { id: "asc" }],
        }),
        () => db.talentPool.findMany({ where: byCandidate, select: { poolName: true, addedAt: true, notes: true }, orderBy: [{ addedAt: "asc" }, { id: "asc" }] }),
        () => db.talentPoolInvitation.findMany({
            where: byCandidate,
            select: { poolName: true, status: true, invitedAt: true, expiresAt: true, respondedAt: true, responseNote: true, jobRequisition: { select: { title: true } } },
            orderBy: [{ invitedAt: "asc" }, { id: "asc" }],
        }),
        () => db.applicationDraft.findMany({
            where: byCandidate,
            select: { requisitionId: true, payload: true, resumeMediaId: true, expiresAt: true, submittedAt: true, created_at: true },
            orderBy: [{ id: "asc" }],
        }),
        () => db.aiInferenceRecord.findMany({
            where: byCandidate,
            select: { kind: true, status: true, provider: true, model: true, confidence: true, applicationId: true, createdAt: true },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        }),
        () => db.candidateDataAccessRequest.findMany({
            where: byCandidate,
            select: { id: true, type: true, source: true, status: true, receivedAt: true, verifiedAt: true, dueAt: true, closedAt: true },
            orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
        }),
    ]);

    // Reviewers and panel members: names only, from this tenant's staff.
    const employeeIds = uniq([
        ...screenings.map((s) => s.reviewedById),
        ...scorecards.map((c) => c.reviewerId),
        ...interviews.flatMap((i) => (i.interviewers ?? []).map((p) => p.employeeId)),
    ]);
    const employees = employeeIds.length
        ? await db.employee.findMany({
            where: { id: { in: employeeIds }, tenant_id: tenantId },
            select: { id: true, first_name: true, last_name: true, employee_name: true },
        })
        : [];

    return {
        candidate, skills, tags, applications, stageHistory, answers, screenings, interviews, scorecards, scores, testResults, checkIns,
        offers, communications, consents, dnc, pools, invitations, drafts, aiRecords, requests, employees,
    };
}

// ── Shaping (pure) ───────────────────────────────────────────────────────────

const employeeName = (e) => {
    const full = [e?.first_name, e?.last_name].map((s) => String(s ?? "").trim()).filter(Boolean).join(" ");
    return full || String(e?.employee_name ?? "").trim() || null;
};

// Criterion ratings without the evidence notes (counted as withheld instead).
function scorecardCriteria(card) {
    const out = {};
    let notes = 0;
    for (const [key, entry] of Object.entries(storedCriteriaOf(card))) {
        out[key] = { rating: entry?.rating ?? null, notAssessed: entry?.notAssessed === true };
        if (hasText(entry?.note)) notes += 1;
    }
    return { criteria: out, notes };
}

/**
 * Shape collected rows into the export document. Pure: the same input gives
 * the same document (bar generatedAt), and nothing outside `data` is read.
 */
export function buildAccessExport(data, { requestId, generatedAt = new Date() } = {}) {
    const withheldCounts = {};
    const withhold = (field, count = 1) => {
        if (count > 0) withheldCounts[field] = (withheldCounts[field] ?? 0) + count;
    };
    const names = new Map((data.employees ?? []).map((e) => [e.id, employeeName(e)]));
    const nameOf = (id) => (id != null ? names.get(id) ?? null : null);
    const byApp = (rows) => {
        const map = new Map();
        for (const row of rows ?? []) {
            if (!map.has(row.applicationId)) map.set(row.applicationId, []);
            map.get(row.applicationId).push(row);
        }
        return map;
    };

    const c = data.candidate;
    if (hasText(c.notes)) withhold("candidate.notes");

    const history = byApp(data.stageHistory);
    const answers = byApp(data.answers);
    const screenings = byApp(data.screenings);
    const interviews = byApp(data.interviews);
    const tests = byApp(data.testResults);
    const checkIns = byApp(data.checkIns);
    const scores = new Map((data.scores ?? []).map((s) => [s.applicationId, s]));
    const offers = new Map((data.offers ?? []).map((o) => [o.applicationId, o]));
    const cardsByInterview = new Map();
    for (const card of data.scorecards ?? []) {
        if (!cardsByInterview.has(card.interviewId)) cardsByInterview.set(card.interviewId, []);
        cardsByInterview.get(card.interviewId).push(card);
    }
    const documents = [];
    if (c.resumeMediaId != null) documents.push({ kind: "RESUME", mediaId: c.resumeMediaId });
    else if (hasText(c.resumeUrl)) documents.push({ kind: "RESUME", mediaId: null, legacyLink: true });

    const presentOffer = (o) => {
        if (!o) return null;
        if (hasText(o.notes)) withhold("offer.notes");
        if (o.offerLetterMediaId != null) documents.push({ kind: "OFFER_LETTER", offerId: o.id, mediaId: o.offerLetterMediaId });
        for (const v of o.letterVersions ?? []) {
            if (v.mediaId != null) documents.push({ kind: "OFFER_LETTER_VERSION", offerId: o.id, version: v.version, mediaId: v.mediaId, createdAt: iso(v.createdAt) });
            if (v.signedMediaId != null) documents.push({ kind: "SIGNED_OFFER_LETTER", offerId: o.id, version: v.version, mediaId: v.signedMediaId, signedAt: iso(v.signedAt) });
        }
        return {
            status: o.status, salary: o.salary, currency: o.currency, compensation: o.compensation ?? null, terms: o.terms ?? null,
            offerType: o.offerType ?? null, employmentType: o.employmentType ?? null,
            startDate: iso(o.startDate), expiryDate: iso(o.expiryDate), createdAt: iso(o.created_at), sentAt: iso(o.sentAt),
            viewedAt: iso(o.viewedAt), respondedAt: iso(o.respondedAt),
            declineReasonCode: o.declineReasonCode ?? null, declineNote: o.declineNote ?? null, talentPoolOptIn: o.talentPoolOptIn ?? null,
            letterVersions: (o.letterVersions ?? []).map((v) => ({ version: v.version, signatureStatus: v.signatureStatus, createdAt: iso(v.createdAt), signedAt: iso(v.signedAt) })),
        };
    };

    const applications = (data.applications ?? []).map((a) => {
        if (hasText(a.holdReason)) withhold("application.holdReason");
        const offer = presentOffer(offers.get(a.id));
        const score = scores.get(a.id);
        return {
            applicationId: a.id,
            requisition: { id: a.jobRequisitionId, title: a.jobRequisition?.title ?? null },
            stage: a.stage,
            status: a.status,
            appliedAt: iso(a.appliedAt),
            updatedAt: iso(a.updatedAt),
            sourceChannel: a.sourceChannel ?? null,
            dispositionReason: a.dispositionReason ?? null,
            withdrawnReason: a.withdrawnReason ?? null,
            knockedOut: a.knockedOut === true,
            answerScore: a.answerScore ?? null,
            answerMaxScore: a.answerMaxScore ?? null,
            stageHistory: (history.get(a.id) ?? []).map((h) => {
                if (hasText(h.reason)) withhold("stageHistory.reason");
                return { fromStage: h.fromStage, toStage: h.toStage, source: h.source, at: iso(h.createdAt) };
            }),
            answers: (answers.get(a.id) ?? []).map((x) => ({ question: x.question?.prompt ?? null, value: x.value ?? null, score: x.score ?? null, answeredAt: iso(x.answeredAt) })),
            screenings: (screenings.get(a.id) ?? []).map((s) => {
                if (hasText(s.notes)) withhold("screening.notes");
                if (s.criteria != null) withhold("screening.criteria");
                return { outcome: s.outcome, reasonCode: s.reasonCode ?? null, scoreOverall: s.scoreOverall ?? null, reviewer: nameOf(s.reviewedById), reviewedAt: iso(s.reviewedAt) };
            }),
            fitScore: score ? { score: score.score, band: score.band, modelVersion: score.modelVersion, components: score.components ?? null, computedAt: iso(score.computedAt) } : null,
            interviews: (interviews.get(a.id) ?? []).map((i) => {
                if (hasText(i.notes)) withhold("interview.notes");
                return {
                    type: i.interviewType, scheduledAt: iso(i.scheduledAt), durationMinutes: i.durationMinutes, location: i.location ?? null,
                    status: i.status, decision: i.decision ?? null, noShowAt: iso(i.noShowAt),
                    panel: (i.interviewers ?? []).map((p) => ({ name: nameOf(p.employeeId), role: p.panelRole ?? null, status: p.status ?? null })),
                    scorecards: (cardsByInterview.get(i.id) ?? []).map((card) => {
                        if (hasText(card.notes)) withhold("scorecard.notes");
                        const { criteria, notes } = scorecardCriteria(card);
                        withhold("scorecard.criterionNotes", notes);
                        return {
                            reviewer: nameOf(card.reviewerId), status: card.status, submittedAt: iso(card.submittedAt),
                            overallScore: card.overallScore ?? null, weightedScore: card.weightedScore ?? null,
                            recommendation: card.recommendation ?? null, decision: storedDecisionOf(card), mustHaveFailed: card.mustHaveFailed === true,
                            criteria,
                        };
                    }),
                };
            }),
            testResults: (tests.get(a.id) ?? []).map((t) => {
                if (hasText(t.decisionReason)) withhold("testResult.decisionReason");
                return {
                    jobFamily: t.jobFamily ?? null, rawScore: t.rawScore, maxScore: t.maxScore, scorePct: t.scorePct, band: t.band,
                    sectionScores: t.sectionScores ?? null, decision: t.decision ?? null, decidedAt: iso(t.decidedAt),
                    validUntil: iso(t.validUntil), takenAt: iso(t.createdAt),
                };
            }),
            checkIns: (checkIns.get(a.id) ?? []).map((k) => {
                if (hasText(k.accommodationReason)) withhold("checkIn.accommodationReason");
                if (k.photoMediaId != null) documents.push({ kind: "CHECK_IN_PHOTO", applicationId: a.id, mediaId: k.photoMediaId });
                return { arrivedAt: iso(k.arrivedAt), idType: k.idType ?? null, idLast4: k.idLast4 ?? null, consentAt: iso(k.consentAt), accommodations: k.accommodations ?? null };
            }),
            offer,
        };
    });

    for (const d of data.drafts ?? []) {
        if (d.resumeMediaId != null) documents.push({ kind: "DRAFT_RESUME", requisitionId: d.requisitionId, mediaId: d.resumeMediaId });
    }
    for (const entry of data.dnc ?? []) {
        if (hasText(entry.reason)) withhold("doNotContact.reason");
        if (hasText(entry.liftReason)) withhold("doNotContact.liftReason");
    }
    for (const pool of data.pools ?? []) if (hasText(pool.notes)) withhold("talentPool.notes");

    return {
        format: ACCESS_EXPORT_FORMAT,
        version: ACCESS_EXPORT_VERSION,
        generatedAt: iso(generatedAt),
        requestId: requestId ?? null,
        profile: {
            candidateId: c.id,
            firstName: c.firstName ?? null,
            lastName: c.lastName ?? null,
            email: c.email ?? null,
            phone: c.phone ?? null,
            location: c.location ?? null,
            source: c.source ?? null,
            status: c.status ?? null,
            emailVerifiedAt: iso(c.emailVerifiedAt),
            consentStatus: c.consentStatus ?? null,
            consentUpdatedAt: iso(c.consentUpdatedAt),
            retentionUntil: iso(c.retentionUntil),
            retentionPopulation: c.retentionPopulation ?? null,
            archivedAt: iso(c.archivedAt),
            anonymizedAt: iso(c.anonymizedAt),
            createdAt: iso(c.createdAt),
            updatedAt: iso(c.updatedAt),
            parsedResume: c.parsedResume ?? null,
        },
        applications,
        communications: (data.communications ?? []).map((m) => ({
            applicationId: m.applicationId ?? null, templateId: m.templateId, channel: m.channel, category: m.category, status: m.status,
            suppressedReason: m.suppressedReason ?? null, scheduledFor: iso(m.scheduledFor), sentAt: iso(m.sentAt), createdAt: iso(m.createdAt),
        })),
        consents: (data.consents ?? []).map((x) => ({ purpose: x.purpose, status: x.status, policyVersion: x.policyVersion ?? null, source: x.source ?? null, evidence: x.evidence ?? null, occurredAt: iso(x.occurredAt) })),
        doNotContact: (data.dnc ?? []).map((x) => ({ reasonCode: x.reasonCode, scope: x.scope, status: x.status, effectiveFrom: iso(x.effectiveFrom), expiresAt: iso(x.expiresAt), liftedAt: iso(x.liftedAt) })),
        talentPools: (data.pools ?? []).map((p) => ({ poolName: p.poolName, addedAt: iso(p.addedAt) })),
        invitations: (data.invitations ?? []).map((v) => ({
            poolName: v.poolName ?? null, requisitionTitle: v.jobRequisition?.title ?? null, status: v.status, invitedAt: iso(v.invitedAt),
            expiresAt: iso(v.expiresAt), respondedAt: iso(v.respondedAt), responseNote: v.responseNote ?? null,
        })),
        applicationDrafts: (data.drafts ?? []).map((d) => ({ requisitionId: d.requisitionId, payload: d.payload ?? null, createdAt: iso(d.created_at), expiresAt: iso(d.expiresAt), submittedAt: iso(d.submittedAt) })),
        automatedProcessing: (data.aiRecords ?? []).map((r) => ({ kind: r.kind, status: r.status, provider: r.provider ?? null, model: r.model ?? null, confidence: r.confidence ?? null, applicationId: r.applicationId ?? null, at: iso(r.createdAt) })),
        skills: (data.skills ?? []).map((k) => ({ name: k.name, category: k.category ?? null, level: k.level ?? null, score: k.score ?? null, source: k.source ?? null, addedAt: iso(k.createdAt) })),
        tags: uniq((data.tags ?? []).map((t) => t.tag?.name ?? null)),
        dataRequests: (data.requests ?? []).map((r) => ({ requestId: r.id, type: r.type, source: r.source, status: r.status, receivedAt: iso(r.receivedAt), verifiedAt: iso(r.verifiedAt), dueAt: iso(r.dueAt), closedAt: iso(r.closedAt) })),
        documents,
        withheld: Object.entries(withheldCounts).map(([field, count]) => ({ field, count, reason: "STAFF_FREE_TEXT" })),
    };
}

// ── The tool ─────────────────────────────────────────────────────────────────

/**
 * hr_candidate_request_export_generate — build, upload and stamp the access
 * export for one ACCESS request.
 */
export async function generateDsrAccessExport({ tenantId, requestId, actorId = null, scope, now = new Date() } = {}) {
    if (!isRecruitmentFlagEnabled("dsrPortal")) {
        throw fail("Data-subject request exports are disabled", 503, "HR-RECRUITMENT-DSR-PORTAL-DISABLED");
    }
    if (!tenantId) throw fail("Verified company is required", 403, "HR-TENANT-REQUIRED");
    if (scope?.level !== RECRUITMENT_SCOPE.ORG) {
        throw fail("Only recruitment administrators can export candidate data", 403, "HR-RECRUITMENT-PRIVACY-FORBIDDEN");
    }
    const id = positiveInt(requestId);
    if (!id) throw fail("Data access request not found", 404, "HR-RECRUITMENT-DAR-NOT-FOUND");
    const at = new Date(now);
    const actor = positiveInt(actorId);

    // 1. Read the request and everything linked, in one tenant snapshot.
    const collected = await tenantTransaction(
        prisma,
        async (tx) => {
            const request = await tx.candidateDataAccessRequest.findFirst({ where: withTenant(tenantId, { id }) });
            // An unverified portal request is not in the HR queue.
            if (!request || (request.source === "PORTAL" && !request.verifiedAt)) {
                throw fail("Data access request not found", 404, "HR-RECRUITMENT-DAR-NOT-FOUND");
            }
            if (request.type !== "ACCESS") throw fail("Only an ACCESS request has an export", 409, "HR-RECRUITMENT-DSR-EXPORT-TYPE");
            if (!OPEN_STATUSES.includes(request.status)) throw fail(`Request ${id} is already ${request.status}`, 409, "HR-RECRUITMENT-DAR-ALREADY-CLOSED");

            const subject = normalizeEmail(request.subjectEmail);
            let candidateId = positiveInt(request.candidateId);
            if (!candidateId) {
                const match = await tx.candidate.findFirst({
                    where: withTenant(tenantId, { email: { equals: subject, mode: "insensitive" }, anonymizedAt: null }),
                    select: { id: true },
                    orderBy: { id: "asc" },
                });
                candidateId = match?.id ?? null;
            }
            if (!candidateId) {
                throw fail("No candidate record matches this request's address; close it as fulfilled with nothing held", 409, "HR-RECRUITMENT-DSR-NO-CANDIDATE");
            }
            const data = await collectCandidateData(tx, tenantId, candidateId);
            // The export goes to the request's subject: the record must be theirs.
            if (!data || normalizeEmail(data.candidate.email) !== subject) {
                throw fail("The linked candidate's address does not match the request's subject", 409, "HR-RECRUITMENT-DSR-SUBJECT-MISMATCH");
            }
            return { request, candidateId, data };
        },
        { tenantId },
    );

    // 2. Build and upload (outside any transaction: DAM is a network call).
    const document = buildAccessExport(collected.data, { requestId: id, generatedAt: at });
    const fileName = `candidate-access-export-${id}-${at.toISOString().slice(0, 10)}.json`;
    const uploaded = await uploadFileToDAM(
        { buffer: Buffer.from(JSON.stringify(document, null, 2), "utf8"), mimetype: "application/json", originalname: fileName },
        "document",
    );
    const mediaId = positiveInt(uploaded?.[0]?.id);
    if (!mediaId) throw fail("The export could not be stored in DAM; try again", 502, "HR-RECRUITMENT-DSR-EXPORT-UPLOAD-FAILED");

    // 3. Stamp the request (still open, still this candidate's) and announce.
    const stamped = await tenantTransaction(
        prisma,
        async (tx) => {
            const claim = await tx.candidateDataAccessRequest.updateMany({
                where: withTenant(tenantId, { id, status: { in: [...OPEN_STATUSES] } }),
                data: {
                    exportMediaId: mediaId,
                    exportGeneratedAt: at,
                    candidateId: collected.candidateId,
                    status: "IN_PROGRESS",
                    ...(actor ? { handledById: actor } : {}),
                },
            });
            if (Number(claim?.count ?? 0) !== 1) return false;
            await enqueueHrDomainEvent(tx, {
                eventName: DSR_EXPORT_GENERATED_EVENT,
                tenantId,
                aggregateType: "CandidateDataAccessRequest",
                aggregateId: id,
                actorId: actor,
                payload: { requestId: String(id), candidateId: String(collected.candidateId), mediaId: String(mediaId) },
            });
            return true;
        },
        { tenantId },
    );
    if (!stamped) {
        // Closed meanwhile: the file must not outlive the request it was for.
        await deleteDamAsset(mediaId);
        throw fail(`Request ${id} was closed while the export was generated`, 409, "HR-RECRUITMENT-DAR-ALREADY-CLOSED");
    }

    // 4. The previous export, if any, is a second copy of the same data.
    const previous = positiveInt(collected.request.exportMediaId);
    if (previous && previous !== mediaId) {
        const removed = await deleteDamAsset(previous);
        if (!removed?.ok) log.warn({ tenantId, requestId: id, mediaId: previous, error: removed?.error }, "previous access export not deleted from DAM");
    }

    await logAction({
        employeeId: actor,
        type: "Create",
        module: "Candidate Privacy",
        result: "SUCCESS",
        notes: `Access export generated for request ${id} (candidate ${collected.candidateId}, media ${mediaId}).`,
        tenantId,
    });

    return {
        requestId: id,
        candidateId: collected.candidateId,
        exportMediaId: mediaId,
        exportGeneratedAt: at,
        sections: {
            applications: document.applications.length,
            communications: document.communications.length,
            consents: document.consents.length,
            doNotContact: document.doNotContact.length,
            invitations: document.invitations.length,
            documents: document.documents.length,
        },
        withheld: document.withheld,
    };
}
