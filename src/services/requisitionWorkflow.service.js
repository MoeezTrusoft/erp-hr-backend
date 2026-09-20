// src/services/requisitionWorkflow.service.js
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
]);

import { assertRequisitionSubmittable } from "../lib/requisitionFields.js";

// DRAFT ──submit──▶ PENDING_APPROVAL ──decide──▶ APPROVED ──post──▶ POSTED ──▶ CLOSED
//   │                      │                        │                          ▲
//   │                      └──▶ REJECTED ──revise──▶ DRAFT                     │
//   └──────────────────────┴────────────────────────┴──────────────────────────┘
// CLOSED is terminal: a closed requisition is a historical record.
// REJECTED may be abandoned (CLOSED) as well as revised back into DRAFT — HR
// closes requisitions that were never going to be revisited.
const ALLOWED_TRANSITIONS = Object.freeze({
    DRAFT: new Set(["PENDING_APPROVAL", "CLOSED"]),
    PENDING_APPROVAL: new Set(["APPROVED", "REJECTED"]),
    APPROVED: new Set(["POSTED", "CLOSED"]),
    REJECTED: new Set(["DRAFT", "CLOSED"]),
    POSTED: new Set(["CLOSED"]),
    CLOSED: new Set(),
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
 * mandatory-field set in lib/requisitionFields.js. The row is REQUIRED, not
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
    if (target === "PENDING_APPROVAL") {
        if (!requisition || typeof requisition !== "object") {
            throw workflowError(
                "Submitting a requisition requires its record so the mandatory-field gate can run",
                "HR-RECRUITMENT-REQUISITION-GATE-CONTEXT-REQUIRED",
            );
        }
        assertRequisitionSubmittable(requisition);
    }
    return target;
}

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
