// src/lib/requisition-eligibility.util.js
//
// Phase 4 / decision record §2.9 + §2.9a — whether a requisition can accept a
// new application RIGHT NOW.
//
// Pure functions, no DB and no I/O, and one exported answer shape. Why one
// module: the decision names three conditions (posting active, requisition
// publishable/open, closing date not passed) and one optional behaviour
// (autoCloseWhenFilled, which closes terminally). Five callers read this answer — the
// application-creation gate, the hired prerequisite, the auto-close sweep, the
// candidate-facing listing and the "closed job" UX copy — and five callers
// re-deriving "is this job open" from raw columns is how a withdrawn
// requisition ends up accepting applications on one surface only.
//
// The conditions are evaluated ALL and reported as a structured answer rather
// than thrown as the first failure: the UI needs to say WHY a job is closed
// ("applications closed 2026-09-01"), not just that it is.

import { isPostingOpen } from "./requisition-publication.util.js";

// Statuses from which applications can flow in. POSTED is the advertised state;
// APPROVED is included deliberately — the decision says "the requisition is
// publishable/open", and an approved-but-not-yet-posted requisition with an
// active internal posting (an employee referral channel opened before the
// career-site flip) is open by the same rule. Nothing else is: a DRAFT was
// never published, a PENDING_APPROVAL may still be refused, and
// REJECTED/CLOSED/WITHDRAWN are over.
export const APPLICATION_ACCEPTING_STATUSES = Object.freeze(["APPROVED", "POSTED"]);

const isBlank = (value) => value === undefined || value === null || value === "";

/**
 * Evaluate every eligibility condition for one requisition (with its postings).
 *
 * `now` defaults to the current time; pass a fixed one in tests and in the
 * auto-close sweep so a slow query cannot straddle midnight and close a window
 * that opened the same second.
 *
 * Returns `{ eligible, reasons, closable }`:
 *   - `eligible` — all conditions hold; an application may be created.
 *   - `reasons`  — every failed condition as a code, so the UI can name them all.
 *   - `closable` — conditions OTHER than the closing date hold, i.e. the
 *                  requisition is live but its window has passed. Used by the
 *                  candidate-facing copy ("this position is no longer accepting
 *                  applications", §2.9a) as distinct from "this job does not exist".
 */
export function evaluateRequisitionEligibility(requisition, { postings = [], now = new Date() } = {}) {
    const reasons = [];

    if (!requisition) {
        return { eligible: false, reasons: ["REQUISITION_NOT_FOUND"], closable: false };
    }

    const status = String(requisition.status ?? "").trim().toUpperCase();
    if (!APPLICATION_ACCEPTING_STATUSES.includes(status)) {
        reasons.push(status === "CLOSED" ? "REQUISITION_CLOSED" : `REQUISITION_${status || "UNKNOWN"}`);
    }

    const closesAt = requisition.closesAt ? new Date(requisition.closesAt) : null;
    // "the closing date has not passed" — the closing instant itself still
    // belongs to the window: an application submitted AT closesAt has not missed
    // a deadline that says "applications close at 12:00". One millisecond later
    // it has.
    const windowClosed = closesAt ? closesAt.getTime() < now.getTime() : false;
    if (windowClosed) reasons.push("APPLICATION_WINDOW_CLOSED");

    const activePostings = postings.filter((p) => isPostingOpen(p, now));
    // No postings YET is not the same as closed: an APPROVED requisition is
    // publishable before its first channel goes live. What must not happen is
    // accepting applications while NO channel is live AND the requisition is
    // past the states where publication is possible.
    if (!activePostings.length && status === "POSTED") {
        reasons.push("NO_ACTIVE_POSTING");
    }

    const eligible = reasons.length === 0;

    return {
        eligible,
        reasons,
        closable: eligible || (windowClosed && reasons.length === 1),
    };
}

/**
 * Why a candidate cannot apply — the §2.9a copy contract.
 *
 * One code per situation, resolved in priority order, because a CLOSED
 * requisition with an expired window must read as "this position is no longer
 * accepting applications", not as two contradictory reasons. `detail` carries
 * the closing date when that is the reason, so the UI can show it without
 * re-deriving it.
 */
export function closedApplicationMessage(requisition, evaluation) {
    const reasons = evaluation?.reasons ?? [];
    if (!reasons.length) return null;

    const detail = (() => {
        const closesAt = requisition?.closesAt ? new Date(requisition.closesAt) : null;
        return closesAt && !Number.isNaN(closesAt.getTime())
            ? { closesAt: closesAt.toISOString() }
            : null;
    })();

    const resolve = (code, message) => ({ code, message, ...(detail ? { detail } : {}) });

    if (reasons.includes("REQUISITION_CLOSED")) {
        return resolve("REQUISITION_CLOSED", "This position is no longer accepting applications.");
    }
    if (reasons.includes("REQUISITION_WITHDRAWN")) {
        return resolve("REQUISITION_WITHDRAWN", "This position is no longer accepting applications.");
    }
    if (reasons.includes("APPLICATION_WINDOW_CLOSED")) {
        return resolve("APPLICATION_WINDOW_CLOSED", "The application window for this position has closed.");
    }
    if (reasons.includes("NO_ACTIVE_POSTING")) {
        return resolve("NO_ACTIVE_POSTING", "This position is no longer accepting applications.");
    }
    if (reasons.some((r) => r.startsWith("REQUISITION_"))) {
        return resolve(reasons[0], "This position is not currently accepting applications.");
    }
    return resolve(reasons[0], "This position is not currently accepting applications.");
}

/**
 * Normalize the closesAt payload value. Accepts null/"" to clear the window
 * (present-only update semantics live in the callers), an ISO date string, or a
 * Date. Rejects a non-date and a window that ends before it begins.
 */
export function normalizeClosesAt(value, { openedAt = null } = {}) {
    if (isBlank(value)) return null;
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw Object.assign(new Error("closesAt is not a valid date"), {
            status: 422,
            code: "HR-RECRUITMENT-CLOSES-AT-INVALID",
        });
    }
    const opened = openedAt ? new Date(openedAt) : null;
    if (opened && !Number.isNaN(opened.getTime()) && parsed.getTime() < opened.getTime()) {
        throw Object.assign(new Error("closesAt cannot be earlier than the requisition's creation"), {
            status: 422,
            code: "HR-RECRUITMENT-CLOSES-AT-BEFORE-CREATED",
        });
    }
    return parsed;
}
