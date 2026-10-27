// src/services/requisition-workflow.service.js
//
// Phase 3.2 — the canonical JobRequisition state machine. Every mutation path
// (REST requisition controller, the requisition-management MCP tools, and the
// generic requisition update) must validate against this instead of writing
// `status` directly.
//
// Why it exists: before this guard, `approveRequisition` accepted ANY current
// status, so a DRAFT could be approved without ever being submitted; a
// REJECTED decision needed no reason; the same requisition could be approved
// repeatedly (appending a fresh RequisitionApproval row each time); and
// `createRequisition` accepted an arbitrary initial status — including APPROVED.
// The approval chain was therefore advisory, not enforced.

export const REQUISITION_STATUSES = Object.freeze([
    "DRAFT",
    "PENDING_APPROVAL",
    "APPROVED",
    "REJECTED",
    "POSTED",
    "CLOSED",
    "WITHDRAWN",
]);

import { assertRequisitionSubmittable } from "../lib/requisition-fields.util.js";
import { assertNotHiringFrozen } from "./recruitment-freeze.service.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitment-flags.util.js";

// DRAFT ──submit──▶ PENDING_APPROVAL ──decide──▶ APPROVED ──post──▶ POSTED ──▶ CLOSED
//   │                      │                        │                          ▲
//   │                      └──▶ REJECTED ──revise──▶ DRAFT                     │
//   └──────────────────────┴────────────────────────┴──────────────────────────┘
// CLOSED is terminal: a closed requisition is a historical record.
// REJECTED may be abandoned (CLOSED) as well as revised back into DRAFT — HR
// closes requisitions that were never going to be revisited.
//
// Phase 4 / §2.4a — WITHDRAWN is a SECOND terminal state, reachable only for a
// requisition that was actually live or in the approval process (submitted,
// approved or posted). Withdrawing is refused for a DRAFT (a draft is deleted, not
// withdrawn — DRAFT→CLOSED already covers it) and for a REJECTED requisition
// (nothing is running to withdraw). It is not reachable FROM CLOSED either: a
// filled requisition cannot be retroactively withdrawn.
const ALLOWED_TRANSITIONS = Object.freeze({
    DRAFT: new Set(["PENDING_APPROVAL", "CLOSED"]),
    PENDING_APPROVAL: new Set(["APPROVED", "REJECTED", "WITHDRAWN"]),
    APPROVED: new Set(["POSTED", "CLOSED", "WITHDRAWN"]),
    REJECTED: new Set(["DRAFT", "CLOSED"]),
    POSTED: new Set(["CLOSED", "WITHDRAWN"]),
    CLOSED: new Set(),
    WITHDRAWN: new Set(),
});

const normalizeStatus = (status) => String(status || "").trim().toUpperCase();

const workflowError = (message, code = "HR-RECRUITMENT-REQUISITION-WORKFLOW") =>
    Object.assign(new Error(message), { status: 409, code });

/** Can `from` legally move to `to`? (Exported so callers can pre-check.) */
export function canTransitionRequisition(from, to) {
    return Boolean(ALLOWED_TRANSITIONS[normalizeStatus(from)]?.has(normalizeStatus(to)));
}

/**
 * Assert that a status transition is legal, and that a REJECTED decision carries
 * a reason. Returns the normalized target status.
 *
 * Phase 2.2 — SUBMISSION GATE. Moving into PENDING_APPROVAL requires the caller
 * to pass the requisition row (`{ requisition }`), which is checked against the
 * mandatory-field set in lib/requisition-fields.util.js. The row is REQUIRED, not
 * optional: an optional parameter would let a new submit path forget it and
 * silently reintroduce "approve a requisition with no cost center", which is the
 * exact hole this closes. A caller that omits it gets an explicit error.
 */
export function assertRequisitionTransition(from, to, { comments, requisition } = {}) {
    const target = normalizeStatus(to);
    if (!REQUISITION_STATUSES.includes(target)) {
        throw workflowError(`Unsupported requisition status: ${target || "(missing)"}`, "HR-RECRUITMENT-REQUISITION-STATUS-INVALID");
    }
    const current = normalizeStatus(from);
    if (current === target) {
        throw workflowError(`Requisition is already ${target}`, "HR-RECRUITMENT-REQUISITION-NOOP");
    }
    if (!ALLOWED_TRANSITIONS[current]?.has(target)) {
        throw workflowError(
            `Invalid requisition transition: ${current || "(unknown)"} → ${target}`,
            "HR-RECRUITMENT-REQUISITION-TRANSITION-INVALID",
        );
    }
    if (target === "REJECTED" && !String(comments || "").trim()) {
        throw workflowError("Rejecting a requisition requires a reason", "HR-RECRUITMENT-REQUISITION-REASON-REQUIRED");
    }
    // §2.4a — a withdrawal requires a reason too. Enforced here as well as by the
    // coded-reason normalization in the service, so a future call path that writes
    // WITHDRAWN directly cannot file an unexplained cancellation.
    if (target === "WITHDRAWN" && !String(comments || "").trim()) {
        throw workflowError("Withdrawing a requisition requires a reason", "HR-RECRUITMENT-REQUISITION-REASON-REQUIRED");
    }
    // §2.4a — "withdraw/CLOSE of a PUBLISHED requisition requires a reason". Scoped
    // to a requisition that actually went live: closing a draft or a rejected
    // requisition is housekeeping, and demanding a justification for it would
    // train people to type "-". This is the check that makes the reason reachable
    // from every close path (management service, legacy /api/hr, generic update)
    // instead of only from the one someone remembered to update.
    if (target === "CLOSED" && current === "POSTED" && !String(comments || "").trim()) {
        throw workflowError(
            "Closing a published requisition requires a reason",
            "HR-RECRUITMENT-REQUISITION-REASON-REQUIRED",
        );
    }
    if (target === "PENDING_APPROVAL") {
        if (!requisition || typeof requisition !== "object") {
            throw workflowError(
                "Submitting a requisition requires its record so the mandatory-field gate can run",
                "HR-RECRUITMENT-REQUISITION-GATE-CONTEXT-REQUIRED",
            );
        }
        // HR_RECRUITMENT_WORKFLOW_ENFORCEMENT off is the documented rollback to
        // legacy permissive submission: only the mandatory-field gate is lifted.
        // Legal transitions, reasons and the hiring freeze still apply.
        if (isRecruitmentFlagEnabled("workflow")) assertRequisitionSubmittable(requisition);
    }
    return target;
}

/**
 * Phase 4 / decision record §2.7 — the HIRING FREEZE gate for a status move.
 *
 * Kept as a separate async guard rather than folded into
 * `assertRequisitionTransition` because it needs a database read and that function
 * is deliberately synchronous and pure (callers use it to pre-check). Callers that
 * ADVANCE a requisition await this immediately after the transition guard, so the
 * two blockers read together and neither can be satisfied by accident.
 *
 * A freeze blocks SUBMISSION and PUBLICATION only. Drafting, revising and
 * CLOSING are not blocked — closing an in-flight requisition during a freeze is
 * exactly what a freeze is for.
 *
 * Returns the freeze it blocked on (null when nothing is frozen) so a caller can
 * surface which freeze applied without a second lookup.
 */
export const assertRequisitionNotFrozen = async (tenantId, requisition, targetStatus) => {
    const target = normalizeStatus(targetStatus);
    if (target === "PENDING_APPROVAL") return assertNotHiringFrozen(tenantId, requisition, "submission");
    if (target === "POSTED") return assertNotHiringFrozen(tenantId, requisition, "publication");
    return null;
};

/**
 * Phase 4 — every guard that must hold before a requisition ADVANCES.
 *
 * Read-only. It is one function rather than three because these guards share the
 * same four call sites, and three separate `await`s at four sites is how one of
 * them quietly goes missing. Currently:
 *
 *   * a hiring freeze blocks submission and publication (§2.7), and
 *   * a configured approval chain that could never be completed is refused at
 *     SUBMISSION rather than discovered at approval, when nobody can decide the
 *     requisition and it is already out of the requester's hands (§2.5).
 */
export const assertRequisitionAdvanceAllowed = async (tenantId, requisition, targetStatus) => {
    const target = normalizeStatus(targetStatus);
    await assertRequisitionNotFrozen(tenantId, requisition, target);
    // Reviewer availability is the HR Approval Centre's check (a verified
    // initiator with a current line manager); the recruitment approval matrix no
    // longer decides who approves, so it no longer blocks submission either.
    return null;
};

/**
 * Phase 2.1 — append one immutable row to a requisition's transition history.
 *
 * Mirrors `recordStageHistory` on the application side: the row is written by the
 * SAME transaction as the status change (pass the `tx` client, never the global
 * `prisma`), so a state move can never exist without the record of who made it,
 * and a rolled-back move leaves no orphan history. RequisitionApproval only ever
 * covered the approve/reject decision; submit, post, reopen and close were
 * invisible before this.
 *
 * `fromStatus`/`toStatus` are normalized to upper case so a client that sends
 * "draft" cannot write a history row that disagrees with the row it describes.
 * A creation is recorded with both sides equal to the born status and
 * `source: 'requisition'`, matching the application-history convention.
 */
export async function recordRequisitionTransition(db, {
    requisitionId,
    tenantId = null,
    fromStatus,
    toStatus,
    reason = null,
    actorId = null,
    source = "requisition",
} = {}) {
    const actor = Number(actorId);
    return db.requisitionTransition.create({
        data: {
            requisitionId: Number(requisitionId),
            tenantId: tenantId ?? null,
            fromStatus: normalizeStatus(fromStatus),
            toStatus: normalizeStatus(toStatus),
            // Trimmed to null rather than "" so an absent reason is one value in
            // the table, not two that read differently in a report.
            reason: String(reason ?? "").trim() || null,
            actorId: Number.isInteger(actor) && actor > 0 ? actor : null,
            source,
        },
    });
}
