// src/lib/requisitionApprovalChain.js
//
// Phase 4 / decision record §2.5 — the requisition APPROVAL CHAIN.
//
// Pure functions only (no DB, no I/O), so the whole matrix is unit-testable and
// the ordering and distinct-approver rules cannot drift between the REST path,
// the management path and the legacy /api/hr path — all three call in here.
//
// The model:
//
//   * A CHAIN is the ordered list of steps that apply to ONE requisition, each
//     step naming the rule it came from (`stepOrder`, `role`, `approverId`).
//   * A step is PENDING until an APPROVED RequisitionApproval row carries its
//     stepOrder. The chain completes when its LAST applicable step is decided;
//     only then does the requisition become APPROVED.
//   * An EMPTY chain (a tenant that has configured no rules) is a single
//     un-stepped decision — exactly the behaviour every tenant has today. See
//     `DEFAULT_CHAIN` for why the default chain is data an admin seeds rather
//     than a path the runtime silently takes.
//
// Three choices worth stating, because each one is a control decision:
//
//  1. UNCONFIGURED TENANTS ARE UNCHANGED. The decision's "default chain"
//     (Hiring Manager → HR Head → conditional Finance) is what the matrix is
//     SEEDED with — `DEFAULT_CHAIN` below — not a hard-coded runtime route. The
//     decision says the chain must not be hard-coded into Recruitment, and
//     silently making every existing tenant's approvals two-step on upgrade would
//     break in-flight approvals everywhere. A tenant opts in by configuring it.
//  2. AN UNKNOWN AMOUNT SATISFIES EVERY `minAmount` STEP. If Finance requires
//     sign-off above a figure and no figure is set, the conservative outcome is
//     to escalate to Finance, not to skip it. A missing number must never read as
//     "below threshold".
//  3. THE DISTINCT-APPROVER RULE HAS TWO HALVES, ENFORCED DIFFERENTLY. A person
//     NO LONGER decides their own requisition — that half is unconditional, so it
//     also closes the gap for a tenant with no matrix configured at all. The
//     second half (one employee must not satisfy two steps of the same chain) is
//     governed by each step's `requiresDistinctApprover`: it only has meaning once
//     there are two steps to satisfy, and without it a single person holding
//     HR_HEAD and FINANCE collapses a three-step chain into one signature while
//     every step still looks individually satisfied.

export const RULE_ROLES = Object.freeze(["HIRING_MANAGER", "HR_HEAD", "FINANCE", "CUSTOM"]);

/**
 * The chain a tenant gets when it asks for the recommended configuration.
 *
 * Deliberately NOT applied at runtime: it is returned by `seedDefaultChain` and
 * stored as rules. Registering it as data (rather than a code path) is what makes
 * it editable per tenant, which is the whole point of §2.5.
 *
 * `minAmount: 0` on the Finance step means "any requisition with a recorded
 * budget of zero or more", i.e. effectively every requisition that HAS a budget,
 * and — per choice 2 above — every requisition whose budget is unknown. A tenant
 * that wants Finance only above a figure edits this one number.
 */
export const DEFAULT_CHAIN = Object.freeze([
    Object.freeze({ stepOrder: 1, role: "HIRING_MANAGER", requiresDistinctApprover: true }),
    Object.freeze({ stepOrder: 2, role: "HR_HEAD", requiresDistinctApprover: true }),
    Object.freeze({ stepOrder: 3, role: "FINANCE", minAmount: 0, requiresDistinctApprover: true }),
]);

const chainError = (message, code, status = 409, details) =>
    Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

const toNumber = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};

const normalize = (value) => String(value ?? "").trim().toUpperCase();

/** Does this one rule apply to this requisition? */
export function ruleApplies(rule, requisition) {
    if (!rule) return false;
    if (rule.isActive === false) return false;

    // Amount arm. An UNKNOWN amount deliberately satisfies any threshold (choice
    // 2): skipping Finance because nobody filled in a number is the failure mode
    // this rule exists to prevent.
    const threshold = toNumber(rule.minAmount);
    if (threshold !== null) {
        const amount = toNumber(requisition?.budgetedAmount);
        if (amount !== null && amount < threshold) return false;
    }

    if (rule.departmentId != null) {
        const dept = toNumber(requisition?.departmentId);
        if (dept === null || dept !== toNumber(rule.departmentId)) return false;
    }

    if (rule.hiringReason != null && normalize(rule.hiringReason)) {
        if (normalize(requisition?.hiringReason) !== normalize(rule.hiringReason)) return false;
    }

    return true;
}

/**
 * The ordered steps that apply to a requisition.
 *
 * Returns [] when the tenant has configured nothing — which callers must read as
 * "a single un-stepped decision", not as "no approval required" (choice 1).
 */
export function resolveApprovalChain(requisition, rules = []) {
    const applicable = (Array.isArray(rules) ? rules : []).filter((rule) => ruleApplies(rule, requisition));
    return applicable
        .slice()
        .sort((a, b) => toNumber(a.stepOrder) - toNumber(b.stepOrder))
        .map((rule) => ({
            stepOrder: toNumber(rule.stepOrder),
            role: normalize(rule.role) || "CUSTOM",
            approverId: rule.approverId == null ? null : Number(rule.approverId),
            requiresDistinctApprover: rule.requiresDistinctApprover !== false,
        }));
}

/**
 * The first step with no APPROVED decision, or null when the chain is complete.
 * A chain of zero steps is complete by definition (there is nothing to satisfy).
 */
export function nextPendingStep(chain = [], decisions = []) {
    const approved = new Set(
        (Array.isArray(decisions) ? decisions : [])
            .filter((d) => normalize(d.status) === "APPROVED")
            .map((d) => toNumber(d.stepOrder)),
    );
    return chain.find((step) => !approved.has(toNumber(step.stepOrder))) || null;
}

/** Which step orders an employee has already decided (any status). */
export function stepsDecidedBy(decisions = [], employeeId) {
    const id = Number(employeeId);
    return (Array.isArray(decisions) ? decisions : [])
        .filter((d) => Number(d.approverId) === id)
        .map((d) => toNumber(d.stepOrder));
}

/**
 * May `actorId` decide `step` on this requisition?
 *
 * Enforces both halves of the distinct-approver rule (choice 3). Throws with a
 * code the caller can surface, rather than returning a boolean, so a refusal can
 * never be ignored by a caller that forgot to check.
 */
export function assertNotRequester(requisition, actorId) {
    const actor = Number(actorId);
    if (!Number.isInteger(actor) || actor <= 0) {
        throw chainError("An approver (employee) id is required", "HR-RECRUITMENT-APPROVER-REQUIRED", 400);
    }
    const requesterId = toNumber(requisition?.requestedById);
    if (requesterId !== null && requesterId === actor) {
        throw chainError(
            "The person who raised a requisition cannot approve it",
            "HR-RECRUITMENT-CHAIN-SELF_APPROVAL",
            403,
            { requesterId, stepOrder: null },
        );
    }
    return true;
}

/**
 * May `actorId` decide `step`? Enforces the pinned-approver rule and the
 * second half of the distinct-approver rule.
 *
 * The REQUESTER half is deliberately NOT here — it is `assertNotRequester`, which
 * applies even when no chain is configured at all. This function does not accept
 * the requisition at all, so it is impossible to read it as enforcing that rule.
 */
export function assertStepDecidable({ step, decisions = [], actorId } = {}) {
    if (!step) throw chainError("There is no pending approval step to decide", "HR-RECRUITMENT-CHAIN-NO-PENDING-STEP");
    const actor = Number(actorId);
    if (!Number.isInteger(actor) || actor <= 0) {
        throw chainError("An approver (employee) id is required", "HR-RECRUITMENT-APPROVER-REQUIRED", 400);
    }

    // A step pinned to a named approver is theirs and nobody else's.
    if (step.approverId != null && Number(step.approverId) !== actor) {
        throw chainError(
            `Approval step ${step.stepOrder} is assigned to a different approver`,
            "HR-RECRUITMENT-CHAIN-WRONG-APPROVER",
            403,
            { stepOrder: step.stepOrder, requiredApproverId: Number(step.approverId) },
        );
    }

    if (!step.requiresDistinctApprover) return true;

    const already = stepsDecidedBy(decisions, actor);
    if (already.some((order) => order !== null && order !== toNumber(step.stepOrder))) {
        throw chainError(
            `Employee ${actor} has already decided an earlier step of this chain, which requires independent approvers`,
            "HR-RECRUITMENT-CHAIN-DUPLICATE_APPROVER",
            403,
            { stepOrder: step.stepOrder, alreadyDecidedSteps: already },
        );
    }

    return true;
}

/**
 * Refuse a chain that can never be completed, at SUBMIT time.
 *
 * The one case the matrix can create: a step pinned to the requisition's own
 * requester while requiring an independent approver. Left alone this does not
 * fail at configuration time — it fails much later, at approval, when the
 * requisition is already submitted and nobody can decide it. Failing at submit
 * names the misconfiguration while it is still cheap to fix.
 */
export function assertChainCanComplete(chain = [], requisition) {
    const requesterId = toNumber(requisition?.requestedById);
    if (requesterId === null) return;
    for (const step of chain) {
        if (!step.requiresDistinctApprover) continue;
        if (step.approverId != null && Number(step.approverId) === requesterId) {
            throw chainError(
                `Approval step ${step.stepOrder} (${step.role}) is assigned to the requisition's own requester, so it could never be decided`,
                "HR-RECRUITMENT-CHAIN-UNSATISFIABLE",
                422,
                { stepOrder: step.stepOrder, role: step.role, requesterId },
            );
        }
    }
}

/**
 * The view of a chain used by the detail endpoints and returned after a partial
 * decision, so a caller always learns what happens next without a second read.
 */
export function chainProgress(chain = [], decisions = []) {
    const approved = new Set(
        (Array.isArray(decisions) ? decisions : [])
            .filter((d) => normalize(d.status) === "APPROVED")
            .map((d) => toNumber(d.stepOrder)),
    );
    const steps = chain.map((step) => ({
        ...step,
        satisfied: approved.has(toNumber(step.stepOrder)),
    }));
    const next = steps.find((step) => !step.satisfied) || null;
    return {
        configured: chain.length > 0,
        steps,
        nextStep: next ? { stepOrder: next.stepOrder, role: next.role, approverId: next.approverId } : null,
        complete: chain.length > 0 && !next,
    };
}
