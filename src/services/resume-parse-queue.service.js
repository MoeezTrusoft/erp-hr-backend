// src/services/resume-parse-queue.service.js
//
// Phase 2 — queue a candidate's resume for the asynchronous parse worker. The
// intake paths call this instead of parsing in the request, so an applicant
// never waits on the AI plane and a plane outage never fails an application.
//
// Contract (callers rely on it): never throws for a missing resume or a
// failed queue write; returns { queued: boolean, reason?: string }.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";

/**
 * @param {{ tenantId: string, candidateId: number, mediaId: number, applicationId?: number|null }} args
 * @returns {Promise<{ queued: boolean, reason?: string }>}
 */
export async function enqueueCandidateResumeParse({ tenantId, candidateId, mediaId, applicationId = null } = {}) {
    if (!tenantId || !Number.isInteger(Number(candidateId)) || !Number(mediaId)) {
        return { queued: false, reason: "MISSING_INPUT" };
    }
    try {
        await prisma.candidate.update({
            where: { id: Number(candidateId) },
            data: { parseStatus: "PENDING", parseError: null },
        });
        return { queued: true };
    } catch (err) {
        logger.warn({ err, candidateId, applicationId }, "resume parse: could not queue");
        return { queued: false, reason: "QUEUE_WRITE_FAILED" };
    }
}
