// src/lib/offer-extension.util.js
//
// Recruitment Phase 6 — the HR Approval Centre reference of an offer EXPIRY
// EXTENSION request (pure: no DB, no I/O).
//
// Why a reference and not a new kind or column. The Centre's kinds are a
// closed contract enum (@trusoft/contracts/hr-approval), so a new kind is a
// contracts bump; and the offer has no column for a pending date. The Centre
// already binds a request to a source REVISION through a suffix on sourceRef
// (ASSESSMENT_RELEASE "id@revisionNo", SEPARATION_WITHDRAWAL "id@ms"), and its
// DB guard matches every request of a source by split_part(sourceRef,'@',1).
// An extension is therefore an OFFER request whose sourceRef carries the
// revision it extends and the date it proposes:
//
//     <offerId>@x<sequence>.<attempt>.<proposedExpiryMs>
//
//   * sequence = the offer's expiryExtendedCount + 1 when requested. Applying
//     an extension increments the count, so a request for an older revision
//     can never apply twice or over a newer extension.
//   * attempt  = 1 + the earlier requests for the same sequence (a rejected
//     or withdrawn request keeps its row, and (tenant, kind, sourceRef) is
//     unique), so the same date may be asked for again.
//   * proposedExpiryMs = the new expiry in epoch milliseconds. Carrying it in
//     the reference puts it in the snapshot, and so in the digest the
//     approvers sign: the date applied is the date approved.
//
// The original OFFER request keeps its bare "<offerId>" reference, so the
// send path (consumeApproval) and the withdraw guard are untouched.

export const OFFER_EXTENSION_REF_PATTERN = /^([1-9][0-9]{0,9})@x([1-9][0-9]{0,5})\.([1-9][0-9]{0,5})\.([1-9][0-9]{9,14})$/;

/** The Approval Centre stages in which an extension request is still open. */
export const OFFER_EXTENSION_OPEN_STAGES = Object.freeze(["INITIATOR", "LINE_MANAGER", "HR", "MANAGEMENT"]);

/** The decided event's decisions. */
export const OFFER_EXTENSION_DECISIONS = Object.freeze(["APPROVED", "REJECTED", "WITHDRAWN"]);

/** The sourceRef prefix shared by every extension request of one offer. */
export const offerExtensionRefPrefix = (offerId) => `${Number(offerId)}@x`;

/** The prefix of one sequence's attempts. */
export const offerExtensionSequencePrefix = (offerId, sequence) => `${Number(offerId)}@x${Number(sequence)}.`;

/**
 * Build the sourceRef of an extension request.
 * @param {{ offerId: number, sequence: number, attempt: number, proposedExpiryDate: Date|string }} parts
 */
export function buildOfferExtensionRef({ offerId, sequence, attempt, proposedExpiryDate }) {
    const ms = new Date(proposedExpiryDate).getTime();
    const ref = `${Number(offerId)}@x${Number(sequence)}.${Number(attempt)}.${ms}`;
    if (!OFFER_EXTENSION_REF_PATTERN.test(ref)) throw new Error("Invalid offer extension reference parts");
    return ref;
}

/**
 * Parse an extension reference; null for anything else (the original
 * "<offerId>" OFFER reference included).
 * @returns {{ offerId: number, sequence: number, attempt: number, proposedExpiryDate: Date } | null}
 */
export function parseOfferExtensionRef(ref) {
    const match = OFFER_EXTENSION_REF_PATTERN.exec(String(ref ?? ""));
    if (!match) return null;
    const proposedExpiryDate = new Date(Number(match[4]));
    if (Number.isNaN(proposedExpiryDate.getTime())) return null;
    return { offerId: Number(match[1]), sequence: Number(match[2]), attempt: Number(match[3]), proposedExpiryDate };
}

export const isOfferExtensionRef = (ref) => parseOfferExtensionRef(ref) !== null;

/**
 * What an extension adds to the Approval Centre snapshot of the offer (the
 * Centre's loadSource already carries the offer's current expiryDate).
 */
export function offerExtensionSnapshot(ref) {
    const ext = parseOfferExtensionRef(ref);
    if (!ext) return null;
    return {
        sequence: ext.sequence,
        attempt: ext.attempt,
        proposedExpiryDate: ext.proposedExpiryDate.toISOString(),
    };
}
