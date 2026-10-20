// src/lib/interviewScheduling.js
//
// Phase 7 / decision record §5.2–5.4 — the PURE scheduling rules.
//
// No DB, no I/O: the §5.4 reason vocabulary and validation, and the §5.2/5.2a
// availability evaluation, live here so the REST path, the MCP tools and any
// future scheduler worker all decide identically. The service owns the reads
// (leave rows, work schedules, holiday calendars) and hands their RESULTS to
// these functions.
//
// §5.2a is a two-tier contract and the tier names matter:
//
//   * APPROVED LEAVE = HARD BLOCK. An interviewer on approved leave at the
//     proposed time cannot be scheduled — not with a warning, not with an
//     override. The API shape refuses (blocked) rather than warns.
//   * NON-WORKING-DAY / WORK-SCHEDULE conflicts = WARNING with an authorized
//     override + REQUIRED reason. The schedule says "off that day" — that is
//     advisory (the tenant may run weekend panels); the human decides, and the
//     override is audited.

/** The §5.4 suggested set, frozen. Adding a code = edit here + the migration's CHECK. */
export const RESCHEDULE_REASONS = [
    "CANDIDATE_REQUEST",
    "INTERVIEWER_CONFLICT",
    "BUSINESS_REQUEST",
    "TECHNICAL_ISSUE",
    "LOGISTICS_ISSUE",
    "REQUISITION_CLOSED",
    "OTHER",
];

/**
 * Phase 3b — cancel reasons only the system writes: a released candidate's
 * interview is cancelled with ASSESSMENT_NOT_PASSED (the CHECK in migration
 * 20261021003400 allows it). A cancel accepts them; a reschedule does not, so
 * the reschedule paths pass `allowed: RESCHEDULE_REASONS`.
 */
export const SYSTEM_CANCEL_REASONS = ["ASSESSMENT_NOT_PASSED"];

/** Every reason a cancel may carry. */
export const CANCEL_REASONS = [...RESCHEDULE_REASONS, ...SYSTEM_CANCEL_REASONS];

/** Lifecycle event kinds (the ledger's eventType column). */
export const LIFECYCLE_EVENTS = ["CANCELLED", "RESCHEDULED", "RESCHEDULE_REQUESTED"];

/**
 * Validate a §5.4 cancel/reschedule reason.
 * @param {{ reasonCode: string, notes?: string|null, allowed?: string[] }} input
 *   allowed defaults to CANCEL_REASONS; a reschedule passes RESCHEDULE_REASONS
 * @returns {{ ok: true, code: string, notes: string|null } | { ok: false, error: string }}
 */
export function validateLifecycleReason({ reasonCode, notes, allowed = CANCEL_REASONS }) {
    const code = String(reasonCode ?? "").trim();
    if (!code) return { ok: false, error: "A reason code is required" };
    if (!allowed.includes(code)) {
        return { ok: false, error: `Unknown reason code "${code}"` };
    }
    const trimmedNotes = typeof notes === "string" ? notes.trim() : "";
    if (code === "OTHER" && !trimmedNotes) {
        return { ok: false, error: "Free-text notes are required when the reason is OTHER" };
    }
    return { ok: true, code, notes: trimmedNotes || null };
}

/**
 * Evaluate one interviewer's availability against a proposed slot.
 *
 * @param {object} input
 * @param {Array<{startDate: Date|string, endDate: Date|string}>} input.approvedLeave
 *   APPROVED leave rows overlapping-check is done HERE (pure) — the caller
 *   passes the rows; overlapping semantics live in one place.
 * @param {boolean} input.isWorkingDay  does the interviewer's effective work
 *   schedule (or the tenant default) mark this date as working?
 * @returns {{ blocked: boolean, warnings: string[] }}
 *   blocked = §5.2a hard block (approved leave). warnings = §5.2a advisory
 *   conflicts that an authorized override with a required reason may proceed
 *   past.
 */
export function evaluateInterviewerAvailability({ approvedLeave = [], isWorkingDay = true }) {
    const warnings = [];
    if (!isWorkingDay) {
        warnings.push("NON_WORKING_DAY");
    }
    // §5.2a — approved leave is a HARD block, not a warning. The caller passes
    // already-filtered APPROVED rows; anything here blocks.
    if (approvedLeave.length) {
        return { blocked: true, warnings, blockReason: "APPROVED_LEAVE" };
    }
    return { blocked: false, warnings };
}

/**
 * Does [slotStart, slotEnd) overlap [leaveStart, leaveEnd]? Leave is
 * inclusive of its start and end dates (a full-day leave on the interview
 * day blocks, whatever the hour).
 */
export function leaveOverlapsSlot(slotStart, slotEnd, leaveStart, leaveEnd) {
    const s = new Date(slotStart);
    const e = new Date(slotEnd);
    const ls = new Date(leaveStart);
    const le = new Date(leaveEnd);
    // Normalize leave bounds to full days (a leave row is day-granular).
    const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    const dayEnd = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
    return s <= dayEnd(le) && e >= dayStart(ls);
}

/**
 * Which interviewers are hard-blocked by approved leave for this slot?
 * Convenience over leaveOverlapsSlot so the service never re-implements the
 * overlap rule.
 */
export function blockedInterviewers(slotStart, slotEnd, leaveRows = []) {
    return leaveRows
        .filter((r) => leaveOverlapsSlot(slotStart, slotEnd, r.startDate, r.endDate))
        .map((r) => r.employeeId);
}

/**
 * §5.2a — an override of a WARNING requires an authorized flag AND a reason.
 * A hard block can never be overridden, whatever the caller claims.
 */
export function validateConflictOverride({ hasBlocked, override, overrideReason }) {
    if (hasBlocked) {
        return { ok: false, error: "Approved leave is a hard block and cannot be overridden" };
    }
    if (!override) return { ok: true, overridden: false };
    const reason = typeof overrideReason === "string" ? overrideReason.trim() : "";
    if (!reason) {
        return { ok: false, error: "An override requires a reason" };
    }
    return { ok: true, overridden: true, reason };
}

/** Human-readable vocabulary for MCP schemas. */
export const RESCHEDULE_REASON_VALUES = RESCHEDULE_REASONS.slice();
