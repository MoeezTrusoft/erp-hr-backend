// src/services/interview-scorecard.service.js — HR-INTERVIEW-FEEDBACK-01
//
// One place where a reviewer's InterviewScorecard is written, so "submit
// feedback" is idempotent and re-submittable from every entry point
// (hr_interview_update / hr_interview_score / REST POST :id/scorecards).
//
// WHY THIS EXISTS
// The scorecard is unique on (interviewId, reviewerId) — a DB index that knows
// nothing about tenants. The tenantScope extension, however, injects
// `where.tenantId = <caller tenant>` into every read, so a scorecard row whose
// tenantId is NULL (seeded, or written before the tenant backfill) is invisible
// to a findUnique/upsert lookup while STILL colliding on insert. Callers doing
// "look it up, else create" therefore hard-failed with P2002 —
// "Unique constraint failed" — for every interview that already had feedback.
//
// The fix is to resolve the row by its real unique key in an explicit SYSTEM
// context (the same escape hatch the backfills use), then decide:
//   * no row                  -> create, stamped with the caller's tenant
//   * row is ours / NULL      -> update in place and adopt it into the tenant
//   * row is another tenant's -> refuse; never silently overwrite
//
// CALLER CONTRACT: the interview must already have been read under the caller's
// tenant (fail-closed). Given that, its scorecards are the caller's by
// construction — InterviewScorecard.interviewId is a cascading FK on Interview.
import prisma from '../lib/prisma.js';
import { mcpCtx } from '../mcp/context.js';

const asSystem = (fn) => mcpCtx.run({ system: true }, fn);

const currentTenantId = () => {
    const raw = mcpCtx.getStore()?.user?.tenantId;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
};

/**
 * Create-or-update the (interviewId, reviewerId) scorecard.
 *
 * @param {object}  params
 * @param {number}  params.interviewId  interview the scorecard belongs to (tenant-verified by the caller)
 * @param {number}  params.reviewerId   Employee id of the reviewer
 * @param {object}  params.data         column values (scores, overallScore, recommendation, notes, submittedAt)
 * @param {string} [params.tenantId]    caller tenant; defaults to the async-local request tenant
 * @returns {Promise<object>} the written scorecard row
 */
export const upsertInterviewScorecard = async ({ interviewId, reviewerId, data = {}, tenantId } = {}) => {
    const interview = Number(interviewId);
    const reviewer = Number(reviewerId);
    if (!Number.isFinite(interview) || !Number.isFinite(reviewer)) {
        throw Object.assign(new Error('interviewId and reviewerId are required to write a scorecard'), { status: 400 });
    }

    const tenant = tenantId ?? currentTenantId();

    // Resolve by the REAL unique key — tenant-blind, like the index itself.
    const existing = await asSystem(async () =>
        prisma.interviewScorecard.findUnique({
            where: { interviewId_reviewerId: { interviewId: interview, reviewerId: reviewer } },
        }),
    );

    if (!existing) {
        return prisma.interviewScorecard.create({
            data: { interviewId: interview, reviewerId: reviewer, ...data, ...(tenant ? { tenantId: tenant } : {}) },
        });
    }

    if (tenant && existing.tenantId && existing.tenantId !== tenant) {
        throw Object.assign(
            new Error('This interview scorecard belongs to another tenant and cannot be modified'),
            { status: 409 },
        );
    }

    // Ours, or a legacy tenant-less row on our interview: update and adopt it.
    return asSystem(async () =>
        prisma.interviewScorecard.update({
            where: { id: existing.id },
            data: { ...data, ...(tenant ? { tenantId: tenant } : {}) },
        }),
    );
};

export default upsertInterviewScorecard;
