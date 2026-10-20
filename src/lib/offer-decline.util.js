// src/lib/offer-decline.util.js
//
// Recruitment Phase 3a — the offer DECLINE vocabulary and its validation (pure).
//
// A decline used to be a bare status flip, so "why do candidates turn us down"
// had no answer. The reason is a closed code (the migration's
// offers_declineReasonCode_check holds the same list, so a value that slips past
// here still cannot land) plus an optional free-text note.
//
// Backwards compatibility decides the defaults. The REST respond endpoint and
// any other legacy caller send no reason, and they must keep working:
//   * no code and no note  -> nothing is recorded (code null, reported as
//     "not recorded"); the decline itself still succeeds;
//   * a note but no code   -> OTHER, because the note is the reason;
//   * OTHER without a note -> refused: "other" alone tells nobody anything.
// New callers (the hr_offer_decline_record tool) require a code.
//
// No DB, no I/O.

export const DECLINE_NOTE_MAX_LENGTH = 1000;

// Order is display order. Labels are recruiter-facing.
export const DECLINE_REASONS = Object.freeze([
    Object.freeze({ code: "ACCEPTED_OTHER_OFFER", label: "Accepted another offer" }),
    Object.freeze({ code: "COMPENSATION", label: "Compensation" }),
    Object.freeze({ code: "LOCATION", label: "Location" }),
    Object.freeze({ code: "ROLE_FIT", label: "Role fit" }),
    Object.freeze({ code: "TIMING", label: "Timing" }),
    Object.freeze({ code: "COUNTER_OFFER", label: "Accepted a counter offer" }),
    Object.freeze({ code: "PERSONAL", label: "Personal reasons" }),
    Object.freeze({ code: "NO_RESPONSE", label: "No response from the candidate" }),
    Object.freeze({ code: "OTHER", label: "Other (see note)" }),
]);

export const DECLINE_REASON_CODES = Object.freeze(DECLINE_REASONS.map((r) => r.code));

/** Reported in place of a code when a legacy caller declined without one. */
export const DECLINE_REASON_NOT_RECORDED = "NOT_RECORDED";

const fail = (message, code) => Object.assign(new Error(message), { status: 400, code });

/** The label for a code, or null for an unknown or absent code. */
export const declineReasonLabel = (code) => DECLINE_REASONS.find((r) => r.code === code)?.label ?? null;

/**
 * Normalise the decline inputs a caller supplied.
 *
 * @param {{ declineReasonCode?: string|null, declineNote?: string|null, talentPoolOptIn?: boolean|null }} input
 * @param {{ requireCode?: boolean }} [options] - true for callers that must name a reason
 * @returns {{ declineReasonCode: string|null, declineNote: string|null, talentPoolOptIn: boolean|null }}
 */
export function normalizeDeclineInput({ declineReasonCode, declineNote, talentPoolOptIn } = {}, { requireCode = false } = {}) {
    const rawCode = typeof declineReasonCode === "string" ? declineReasonCode.trim().toUpperCase() : "";
    if (declineReasonCode != null && typeof declineReasonCode !== "string") {
        throw fail("declineReasonCode must be a string", "HR-RECRUITMENT-OFFER-DECLINE-REASON-INVALID");
    }
    if (rawCode && !DECLINE_REASON_CODES.includes(rawCode)) {
        throw fail(
            `declineReasonCode must be one of ${DECLINE_REASON_CODES.join(", ")} (received "${rawCode}")`,
            "HR-RECRUITMENT-OFFER-DECLINE-REASON-INVALID",
        );
    }
    if (declineNote != null && typeof declineNote !== "string") {
        throw fail("declineNote must be a string", "HR-RECRUITMENT-OFFER-DECLINE-NOTE-INVALID");
    }
    const note = typeof declineNote === "string" ? declineNote.trim() : "";
    if (note.length > DECLINE_NOTE_MAX_LENGTH) {
        throw fail(
            `declineNote must be at most ${DECLINE_NOTE_MAX_LENGTH} characters`,
            "HR-RECRUITMENT-OFFER-DECLINE-NOTE-INVALID",
        );
    }
    if (talentPoolOptIn != null && typeof talentPoolOptIn !== "boolean") {
        throw fail("talentPoolOptIn must be true or false", "HR-RECRUITMENT-OFFER-DECLINE-OPT-IN-INVALID");
    }

    // A note with no code is an OTHER reason; neither is "not recorded".
    const code = rawCode || (note ? "OTHER" : null);
    if (!code && requireCode) {
        throw fail("declineReasonCode is required", "HR-RECRUITMENT-OFFER-DECLINE-REASON-REQUIRED");
    }
    if (code === "OTHER" && !note) {
        throw fail("A declineNote is required when the reason is OTHER", "HR-RECRUITMENT-OFFER-DECLINE-NOTE-REQUIRED");
    }
    return {
        declineReasonCode: code,
        declineNote: note || null,
        talentPoolOptIn: typeof talentPoolOptIn === "boolean" ? talentPoolOptIn : null,
    };
}
