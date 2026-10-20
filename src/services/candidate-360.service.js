// src/services/candidate-360.service.js
//
// Candidate 360 (F-14): one candidate across every requisition they applied
// to, in one read — profile, applications with their stage history and latest
// screening, interviews with submitted scorecards, offers, documents, talent
// pools, privacy state and AI parse records.
//
// Every section is cut to the caller's recruitment scope with the same
// predicates and masks the list endpoints use (src/lib/recruitmentAccess.js):
//   - the candidate is reachable only through an application the caller may
//     see (candidateScopeWhere), else not found;
//   - applications, interviews and offers each apply their own scope filter;
//   - internal notes and compensation are masked for scopes that may not see
//     them;
//   - consent history, the DNC reason and the legal-hold reason are the
//     recruiter's (ORG) working record; narrower scopes get flags only.
//
// Tenant-scoped by the verified tenant (withTenant); read-only.
import prisma from "../lib/prisma.js";
import {
    applicationScopeWhere,
    candidateScopeWhere,
    interviewScopeWhere,
    maskCandidateForScope,
    maskOfferForScope,
    offerScopeWhere,
} from "../lib/recruitmentAccess.js";
import { withTenant } from "../lib/tenancy.js";
import { findActiveDnc } from "./candidatePrivacy.service.js";

const CONSENT_LIMIT = 50;
const AI_RECORD_LIMIT = 20;

const fail = (message, code, status) => Object.assign(new Error(message), { status, code });

const fullName = (candidate) =>
    [candidate.firstName, candidate.lastName].filter(Boolean).join(" ").trim();

const average = (values) => {
    const scores = values.filter((value) => typeof value === "number" && Number.isFinite(value));
    if (!scores.length) return null;
    return Math.round((scores.reduce((sum, value) => sum + value, 0) / scores.length) * 100) / 100;
};

function toInterview(interview) {
    const scorecards = (interview.scorecards || [])
        .filter((card) => card.submittedAt)
        .map((card) => ({
            reviewerId: card.reviewerId,
            overallScore: card.overallScore,
            recommendation: card.recommendation,
            submittedAt: card.submittedAt,
        }));
    return {
        id: interview.id,
        applicationId: interview.applicationId,
        interviewType: interview.interviewType,
        status: interview.status,
        scheduledAt: interview.scheduledAt,
        durationMinutes: interview.durationMinutes,
        decision: interview.decision,
        calendarSyncStatus: interview.calendarSyncStatus,
        scorecards,
        averageScore: average(scorecards.map((card) => card.overallScore)),
    };
}

function toApplication(application) {
    const screening = (application.screenings || [])[0] || null;
    return {
        id: application.id,
        jobRequisitionId: application.jobRequisitionId,
        requisition: application.jobRequisition
            ? {
                id: application.jobRequisition.id,
                title: application.jobRequisition.title,
                status: application.jobRequisition.status,
            }
            : null,
        stage: application.stage,
        status: application.status,
        dispositionReason: application.dispositionReason,
        holdReason: application.holdReason,
        withdrawnReason: application.withdrawnReason,
        appliedAt: application.appliedAt,
        updatedAt: application.updatedAt,
        stageHistory: (application.stageHistory || []).map((entry) => ({
            fromStage: entry.fromStage,
            toStage: entry.toStage,
            reason: entry.reason,
            source: entry.source,
            actorId: entry.actorId,
            at: entry.createdAt,
        })),
        screening: screening
            ? {
                outcome: screening.outcome,
                reasonCode: screening.reasonCode,
                scoreOverall: screening.scoreOverall,
                reviewedAt: screening.reviewedAt,
            }
            : null,
        interviews: (application.interviews || []).map(toInterview),
    };
}

function toOffer(offer, scope) {
    const masked = maskOfferForScope(
        {
            id: offer.id,
            applicationId: offer.applicationId,
            jobRequisitionId: offer.jobRequisitionId,
            status: offer.status,
            approvalStatus: offer.approvalStatus,
            offerType: offer.offerType,
            employmentType: offer.employmentType,
            employeeCategory: offer.employeeCategory,
            salary: offer.salary,
            currency: offer.currency,
            compensation: offer.compensation,
            startDate: offer.startDate,
            expiryDate: offer.expiryDate,
            sentAt: offer.sentAt,
            viewedAt: offer.viewedAt,
            respondedAt: offer.respondedAt,
            offerLetterMediaId: offer.offerLetterMediaId,
        },
        scope
    );
    return masked;
}

/**
 * @param {{ candidateId: number|string, tenantId: string, scope: object }} args
 * @returns {Promise<object>} the Candidate 360 read model.
 */
export async function getCandidate360({ candidateId, tenantId, scope }) {
    const id = Number(candidateId);
    if (!Number.isInteger(id) || id <= 0) {
        throw fail("A valid candidate id is required", "HR-RECRUITMENT-CANDIDATE-REQUIRED", 400);
    }
    if (!tenantId) throw fail("Verified company is required", "HR-TENANT-REQUIRED", 403);
    // FINANCE prices offers and AGENCY has no submission ownership yet: neither
    // reads candidate profiles (recruitmentAccess.canSeeCandidates).
    if (!scope?.canSeeCandidates) {
        throw fail("Candidate not found", "HR-RECRUITMENT-CANDIDATE-NOT-FOUND", 404);
    }

    const candidate = await prisma.candidate.findFirst({
        where: withTenant(tenantId, { id, ...candidateScopeWhere(scope) }),
        include: {
            tags: { include: { tag: { select: { name: true } } } },
            candidateSkills: { select: { name: true } },
            talentPools: {
                where: withTenant(tenantId, {}),
                select: { id: true, poolName: true, addedAt: true },
                orderBy: { addedAt: "desc" },
            },
        },
    });
    if (!candidate) throw fail("Candidate not found", "HR-RECRUITMENT-CANDIDATE-NOT-FOUND", 404);

    const recruiter = scope.unrestricted === true;
    const interviewWhere = withTenant(tenantId, interviewScopeWhere(scope));

    const [applications, offers, consents, legalHold, dnc, aiRecords] = await Promise.all([
        prisma.application.findMany({
            where: withTenant(tenantId, { candidateId: id, ...applicationScopeWhere(scope) }),
            orderBy: { appliedAt: "desc" },
            include: {
                jobRequisition: { select: { id: true, title: true, status: true } },
                stageHistory: { orderBy: { createdAt: "asc" } },
                screenings: { orderBy: { reviewedAt: "desc" }, take: 1 },
                interviews: {
                    where: interviewWhere,
                    orderBy: { scheduledAt: "asc" },
                    include: {
                        scorecards: {
                            select: {
                                reviewerId: true,
                                overallScore: true,
                                recommendation: true,
                                submittedAt: true,
                            },
                        },
                    },
                },
            },
        }),
        prisma.offer.findMany({
            where: withTenant(tenantId, { candidateId: id, ...offerScopeWhere(scope) }),
            orderBy: { id: "desc" },
        }),
        recruiter
            ? prisma.candidateConsent.findMany({
                where: withTenant(tenantId, { candidateId: id }),
                orderBy: { occurredAt: "desc" },
                take: CONSENT_LIMIT,
            })
            : Promise.resolve(null),
        prisma.candidateLegalHold.findFirst({
            where: withTenant(tenantId, { candidateId: id, releasedAt: null }),
            orderBy: { placedAt: "desc" },
        }),
        findActiveDnc({ tenantId, email: candidate.email }),
        prisma.aiInferenceRecord.findMany({
            where: withTenant(tenantId, { candidateId: id }),
            orderBy: { createdAt: "desc" },
            take: AI_RECORD_LIMIT,
            select: {
                id: true,
                kind: true,
                status: true,
                confidence: true,
                model: true,
                applicationId: true,
                requisitionId: true,
                createdAt: true,
            },
        }),
    ]);

    const profile = maskCandidateForScope(
        {
            id: candidate.id,
            name: fullName(candidate),
            firstName: candidate.firstName,
            lastName: candidate.lastName,
            email: candidate.email,
            phone: candidate.phone,
            source: candidate.source,
            location: candidate.location,
            status: candidate.status,
            notes: candidate.notes,
            parseStatus: candidate.parseStatus,
            parsedAt: candidate.parsedAt,
            emailVerifiedAt: candidate.emailVerifiedAt,
            createdAt: candidate.createdAt,
            archivedAt: candidate.archivedAt,
            anonymizedAt: candidate.anonymizedAt,
            tags: (candidate.tags || []).map((link) => link.tag?.name).filter(Boolean),
            skills: (candidate.candidateSkills || []).map((skill) => skill.name).filter(Boolean),
        },
        scope
    );

    const mappedApplications = applications.map(toApplication);
    const interviews = mappedApplications.flatMap((application) => application.interviews);
    const documents = [
        ...(candidate.resumeMediaId ? [{ type: "resume", mediaId: candidate.resumeMediaId }] : []),
        ...offers
            .filter((offer) => offer.offerLetterMediaId)
            .map((offer) => ({ type: "offer_letter", mediaId: offer.offerLetterMediaId, offerId: offer.id })),
    ];
    const activity = [
        ...mappedApplications.map((application) => application.updatedAt),
        ...interviews.map((interview) => interview.scheduledAt),
        ...offers.map((offer) => offer.respondedAt || offer.sentAt),
    ]
        .filter(Boolean)
        .map((at) => new Date(at).getTime())
        .filter(Number.isFinite);

    return {
        candidate: profile,
        summary: {
            applications: mappedApplications.length,
            activeApplications: mappedApplications.filter(
                (application) => !["hired", "rejected", "withdrawn"].includes(String(application.stage))
            ).length,
            interviews: interviews.length,
            offers: offers.length,
            averageInterviewScore: average(interviews.map((interview) => interview.averageScore)),
            lastActivityAt: activity.length ? new Date(Math.max(...activity)).toISOString() : null,
        },
        applications: mappedApplications,
        offers: offers.map((offer) => toOffer(offer, scope)),
        documents,
        talentPools: candidate.talentPools || [],
        privacy: {
            consentStatus: candidate.consentStatus,
            consentUpdatedAt: candidate.consentUpdatedAt,
            retentionUntil: recruiter ? candidate.retentionUntil : undefined,
            consents: recruiter
                ? consents.map((consent) => ({
                    id: consent.id,
                    purpose: consent.purpose,
                    status: consent.status,
                    policyVersion: consent.policyVersion,
                    source: consent.source,
                    occurredAt: consent.occurredAt,
                }))
                : undefined,
            doNotContact: dnc
                ? {
                    active: true,
                    ...(recruiter
                        ? { reasonCode: dnc.reasonCode, scope: dnc.scope, since: dnc.effectiveFrom, expiresAt: dnc.expiresAt }
                        : {}),
                }
                : { active: false },
            legalHold: legalHold
                ? { active: true, ...(recruiter ? { placedAt: legalHold.placedAt, reason: legalHold.reason } : {}) }
                : { active: false },
        },
        aiRecords: aiRecords,
    };
}
