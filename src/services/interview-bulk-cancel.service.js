// src/services/interview-bulk-cancel.service.js
//
// Recruitment Phase 6 — cancel several interviews with ONE coded reason.
//
// The interview list's "Cancel selected" used to write hr_interview_update
// { status: CANCELLED } once per row, so a bulk cancel carried no reason code,
// wrote no lifecycle ledger row and sent no interview_cancelled event (the
// Phase 3a residue). This is the bulk twin of hr_interview_cancel: the same
// §5.4 reason vocabulary (CANDIDATE_REQUEST ... OTHER, OTHER needs notes; the
// system-only ASSESSMENT_NOT_PASSED is not offered), validated once before
// anything is written, then passed to cancelInterview for every interview, so
// each one gets exactly what a single cancel gets: the CANCELLED status, the
// calendar cancel, the ledger row with the code and notes, the ids-only
// interview_cancelled event and the audit line.
//
// Each interview is its own transaction (cancelInterview's), so one failure
// never undoes or stops the others; the answer lists every id with its
// outcome. An interview that is already cancelled is reported as
// ALREADY_CANCELLED, so a retried bulk call is harmless.
import logger from "../lib/logger.js";
import { RESCHEDULE_REASONS, validateLifecycleReason } from "../lib/interview-scheduling.util.js";
import { cancelInterview } from "./interview-schedule.service.js";

export const BULK_CANCEL_MAX = 50;
/** The reasons a person may give (the single cancel tool's list). */
export const BULK_CANCEL_REASONS = Object.freeze([...RESCHEDULE_REASONS]);

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

const positiveInt = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
};

// cancelInterview's ScheduleError carries its domain code in `details`.
const codeOf = (err) => err?.code ?? (typeof err?.details === "string" ? err.details : err?.details?.code) ?? null;

/**
 * @param {{ interviewIds: Array<number|string>, reasonCode: string, notes?: string|null, tenantId: string, actorId?: number|null }} args
 * @returns {Promise<{ reasonCode: string, requested: number, cancelled: number, alreadyCancelled: number, failed: number, results: object[] }>}
 */
export async function cancelInterviewsBulk({ interviewIds, reasonCode, notes = null, tenantId, actorId = null } = {}) {
    if (!tenantId) throw fail("Verified company is required", 403, "HR-TENANT-REQUIRED");
    const reason = validateLifecycleReason({ reasonCode, notes, allowed: BULK_CANCEL_REASONS });
    if (!reason.ok) throw fail(reason.error, 400, "HR-RECRUITMENT-SCHEDULE-REASON-INVALID");
    const list = Array.isArray(interviewIds) ? interviewIds.map(positiveInt) : [];
    if (!list.length || list.some((id) => id === null)) {
        throw fail("interviewIds must be a non-empty list of interview ids", 400, "HR-RECRUITMENT-INTERVIEW-BULK-INVALID");
    }
    const ids = [...new Set(list)];
    if (ids.length > BULK_CANCEL_MAX) {
        throw fail(`At most ${BULK_CANCEL_MAX} interviews can be cancelled at once`, 400, "HR-RECRUITMENT-INTERVIEW-BULK-INVALID");
    }

    const summary = { reasonCode: reason.code, requested: ids.length, cancelled: 0, alreadyCancelled: 0, failed: 0, results: [] };
    for (const interviewId of ids) {
        try {
            await cancelInterview({ interviewId, reasonCode: reason.code, notes: reason.notes, tenantId, actorId });
            summary.cancelled += 1;
            summary.results.push({ interviewId, status: "CANCELLED", reasonCode: reason.code });
        } catch (err) {
            const code = codeOf(err);
            if (code === "HR-RECRUITMENT-SCHEDULE-ALREADY-CANCELLED") {
                summary.alreadyCancelled += 1;
                summary.results.push({ interviewId, status: "ALREADY_CANCELLED" });
                continue;
            }
            const status = Number(err?.status) || 500;
            summary.failed += 1;
            summary.results.push({
                interviewId,
                status: "FAILED",
                error: { status, code, message: status < 500 ? err.message : "The interview could not be cancelled" },
            });
            logger.warn({ component: "interview-bulk-cancel", interviewId, tenantId, code, errMessage: err?.message }, "bulk cancel: interview failed");
        }
    }
    return summary;
}

export default { cancelInterviewsBulk };
