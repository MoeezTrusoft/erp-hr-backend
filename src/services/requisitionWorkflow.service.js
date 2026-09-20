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
 */
export function assertRequisitionTransition(from, to, { comments } = {}) {
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
    return target;
}
