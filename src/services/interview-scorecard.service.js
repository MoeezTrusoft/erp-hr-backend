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
import { resolveForInterview, validateSubmission } from './scorecardTemplate.service.js';

const asSystem = (fn) => mcpCtx.run({ system: true }, fn);

const currentTenantId = () => {
    const raw = mcpCtx.getStore()?.user?.tenantId;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
};

// Phase 3.4 (remainder) — a SUBMITTED scorecard is evidence, so it locks.
//
// Before this, a submitted scorecard was freely re-writable: the same reviewer
// (or anyone who could reach the update path) could rewrite a rating after the
// hiring decision had been made, leaving no trace that the record changed. The
// pipeline prerequisites were enforced, but the record they justified was not.
//
// The rule now:
//   * no submittedAt on the stored row        -> write normally (first submit)
//   * stored row submitted, payload IDENTICAL -> idempotent no-op, returns as-is
//     (a double-click, or a retry of the same request, must not fail)
//   * stored row submitted, payload DIFFERS   -> REFUSED (409
//     HR-RECRUITMENT-SCORECARD-LOCKED) unless the caller passes an explicit
//     `amendment: { reason }`, which is the authorised path and appends to the
//     scorecard's own amendment log (who, when, why, and the values replaced).
//
// `amendmentLog` / `lastAmendedAt` are columns on interview_scorecards (which is
// already tenant-scoped and under FORCE RLS), so the trail travels with the
// scorecard and needs no new table, no new grant and no new policy.

// Only the fields a reviewer actually owns are compared/amended. `submittedAt`
// is bookkeeping and is deliberately excluded, so re-sending the same payload
// with a fresh timestamp still counts as unchanged.
const COMPARABLE_FIELDS = ["scores", "overallScore", "recommendation", "notes"];

const stable = (value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (Array.isArray(value)) return value.map(stable);
    if (typeof value === "object") {
        return Object.keys(value)
            .sort()
            .reduce((acc, key) => {
                acc[key] = stable(value[key]);
                return acc;
            }, {});
    }
    return value;
};

/** The stored/incoming values for the fields a reviewer may change. */
const comparable = (row = {}) =>
    COMPARABLE_FIELDS.reduce((acc, field) => {
        if (row[field] !== undefined) acc[field] = row[field];
        return acc;
    }, {});

/** True when the incoming payload would change anything the reviewer owns. */
export const scorecardPayloadChanged = (existing, data = {}) => {
    const before = stable(comparable(existing));
    const after = stable(comparable(data));
    return COMPARABLE_FIELDS.some(
        (field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null),
    );
};

const lockedError = () =>
    Object.assign(
        new Error(
            "This interview scorecard has been submitted and is locked; resubmit it with an amendment reason to change it",
        ),
        { status: 409, code: "HR-RECRUITMENT-SCORECARD-LOCKED" },
    );

/**
 * Create-or-update the (interviewId, reviewerId) scorecard.
 *
 * @param {object}  params
 * @param {number}  params.interviewId  interview the scorecard belongs to (tenant-verified by the caller)
 * @param {number}  params.reviewerId   Employee id of the reviewer
 * @param {object}  params.data         column values (scores, overallScore, recommendation, notes, submittedAt)
 * @param {string} [params.tenantId]    caller tenant; defaults to the async-local request tenant
 * @param {object} [params.amendment]   authorised change to a LOCKED scorecard:
 *                                      `{ reason, by? }` — reason is mandatory
 * @returns {Promise<object>} the written scorecard row
 */
export const upsertInterviewScorecard = async ({ interviewId, reviewerId, data = {}, tenantId, amendment = null } = {}) => {
    const interview = Number(interviewId);
    const reviewer = Number(reviewerId);
    if (!Number.isInteger(interview) || interview <= 0) {
        throw Object.assign(new Error('A valid interview id is required to write a scorecard'), { status: 400 });
    }
    // A scorecard is attributable evidence: never write one under a guessed or
    // defaulted reviewer (callers used to fall back to employee id 1).
    if (!Number.isInteger(reviewer) || reviewer <= 0) {
        throw Object.assign(
            new Error('A reviewer (employee) id is required to submit interview feedback'),
            { status: 400 },
        );
    }

    const tenant = tenantId ?? currentTenantId();

    // Phase 7 / §5.5b — if a template governs this interview, the submission
    // must complete every REQUIRED criterion and may not invent criteria the
    // template does not define; the overall becomes the template's weighted
    // (or equal-weighted) computation rather than the reviewer's claim.
    // No template → free-form scoring, exactly as before templates existed.
    let template = null;
    try {
        template = await resolveForInterview({ interviewId: interview, tenantId: tenant });
    } catch {
        // A template-resolution failure must not block feedback; fall back to
        // free-form (the write stays attributable either way).
        template = null;
    }
    if (template) {
        const verdict = validateSubmission({ template, scores: data.scores ?? {} });
        if (verdict.overall !== null && verdict.overall !== undefined) {
            data = { ...data, overallScore: verdict.overall };
        }
    }

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

    // Phase 3.4 — lock enforcement. A submitted scorecard only changes through
    // the explicit amendment path; an identical resubmit stays a no-op so a
    // retry or a double-click does not surface a spurious 409.
    if (existing.submittedAt) {
        if (!scorecardPayloadChanged(existing, data)) return existing;

        const reason = typeof amendment?.reason === "string" ? amendment.reason.trim() : "";
        if (!reason) throw lockedError();

        const entry = {
            at: new Date().toISOString(),
            by: amendment?.by ?? null,
            reason,
            replaced: comparable(existing),
        };

        // Ours, or a legacy tenant-less row on our interview: amend and adopt it.
        // The log is appended, never overwritten, and the ORIGINAL submittedAt is
        // preserved so `lastAmendedAt` is what shows a record has moved.
        return asSystem(async () =>
            prisma.interviewScorecard.update({
                where: { id: existing.id },
                data: {
                    ...data,
                    ...(tenant ? { tenantId: tenant } : {}),
                    amendmentLog: [...(Array.isArray(existing.amendmentLog) ? existing.amendmentLog : []), entry],
                    lastAmendedAt: new Date(),
                },
            }),
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
