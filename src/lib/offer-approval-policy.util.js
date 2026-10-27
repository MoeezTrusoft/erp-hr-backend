// src/lib/offer-approval-policy.util.js — FR-09 residue.
//
// ROLE-SPECIFIC APPROVER CHAINS + COMPENSATION EXCEPTION ROUTING for offers.
//
// Until now the required offer approvals were a hard-coded triple
// (`hiringManager`, `hrHead`, `finance`) applied to every offer regardless of
// amount, role or band — a $40k offer collected the same three signatures as a
// $400k one. This module makes the chain a TENANT POLICY:
//
//   * a rule says which STAGE is required, at which step, by which ROLE
//   * a rule may carry an AMOUNT WINDOW (`minAmount` / `maxAmount`), which is
//     the compensation-exception routing: an offer above the hiring manager's
//     band escalates to finance because a rule says so, not because a constant
//     does
//   * a rule may name a CURRENCY; a USD threshold is not a PKR threshold, so a
//     rule that names a different currency does not apply
//
// With NO rules configured the fixed triple is returned verbatim, so a tenant
// that never configures a policy keeps today's behavior exactly.
//
// FAIL-CLOSED ON AN UNKNOWN AMOUNT, deliberately: when the offer's amount cannot
// be determined, every amount-bearing rule still applies (the chain is longer,
// not shorter). This mirrors the requisition side's documented choice — "an
// unknown amount satisfies every amount threshold, so a missing figure escalates
// to Finance rather than skipping it".
/** The closed stage vocabulary (a stage outside it would have no approver set). */
export const OFFER_APPROVAL_STAGES = Object.freeze(["hiringManager", "hrHead", "finance"]);

/**
 * The pre-policy behavior, expressed as rules. No tenant configuration ⇒ these,
 * which is why an unconfigured tenant is byte-identical to the previous build.
 */
export const DEFAULT_OFFER_APPROVAL_RULES = Object.freeze([
    Object.freeze({ stepOrder: 1, stage: "hiringManager", role: null, minAmount: null, maxAmount: null, currency: null }),
    Object.freeze({ stepOrder: 2, stage: "hrHead", role: null, minAmount: null, maxAmount: null, currency: null }),
    Object.freeze({ stepOrder: 3, stage: "finance", role: null, minAmount: null, maxAmount: null, currency: null }),
]);

const MAX_RULES = 20;

/**
 * Validate a tenant-authored rule list.
 *
 * @returns {{ ok: true, rules: object[] } | { ok: false, error: string }}
 */
export function validateOfferApprovalRules(rules) {
    if (!Array.isArray(rules) || rules.length === 0) {
        return { ok: false, error: "An offer approval policy needs at least one rule" };
    }
    if (rules.length > MAX_RULES) {
        return { ok: false, error: `An offer approval policy allows at most ${MAX_RULES} rules` };
    }

    const seenStages = new Set();
    const out = [];
    for (const [i, raw] of rules.entries()) {
        const where = `Rule ${i + 1}`;
        const stage = typeof raw?.stage === "string" ? raw.stage.trim() : "";
        if (!OFFER_APPROVAL_STAGES.includes(stage)) {
            return { ok: false, error: `${where}: stage must be one of ${OFFER_APPROVAL_STAGES.join(", ")}` };
        }
        // One rule per stage: two windows for the same stage would make
        // "is this offer approved" depend on which matched first.
        if (seenStages.has(stage)) {
            return { ok: false, error: `${where}: stage "${stage}" is already covered by an earlier rule` };
        }
        seenStages.add(stage);

        const stepOrder = Number(raw?.stepOrder);
        if (!Number.isInteger(stepOrder) || stepOrder < 1) {
            return { ok: false, error: `${where}: stepOrder must be a positive integer` };
        }

        const asAmount = (value) => {
            if (value === undefined || value === null || value === "") return null;
            const n = Number(value);
            if (!Number.isFinite(n) || n < 0) return NaN;
            return n;
        };
        const minAmount = asAmount(raw?.minAmount);
        const maxAmount = asAmount(raw?.maxAmount);
        if (Number.isNaN(minAmount)) return { ok: false, error: `${where}: minAmount must be a number >= 0` };
        if (Number.isNaN(maxAmount)) return { ok: false, error: `${where}: maxAmount must be a number >= 0` };
        if (minAmount != null && maxAmount != null && minAmount > maxAmount) {
            return { ok: false, error: `${where}: minAmount must not exceed maxAmount` };
        }

        const role = typeof raw?.role === "string" && raw.role.trim() ? raw.role.trim() : null;
        const currency = typeof raw?.currency === "string" && raw.currency.trim() ? raw.currency.trim().toUpperCase() : null;

        out.push({ stepOrder, stage, role, minAmount, maxAmount, currency });
    }

    out.sort((a, b) => a.stepOrder - b.stepOrder);
    return { ok: true, rules: out };
}

/**
 * The chain an offer is approved against.
 *
 * @param {{rules?: object[], amount?: number|null, currency?: string|null}} args
 * @returns {{steps: object[], source: 'TEMPLATE'|'DEFAULT'}}
 */
export function resolveOfferApprovalChain({ rules, amount = null, currency = null } = {}) {
    if (!Array.isArray(rules) || rules.length === 0) {
        return { steps: DEFAULT_OFFER_APPROVAL_RULES.map((r) => ({ ...r })), source: "DEFAULT" };
    }

    const numericAmount = amount === null || amount === undefined || amount === "" ? null : Number(amount);
    const knownAmount = Number.isFinite(numericAmount);
    const offerCurrency = currency ? String(currency).trim().toUpperCase() : null;

    const steps = rules
        .filter((rule) => {
            // Currency mismatch: the rule does not speak this offer's money.
            if (rule.currency && offerCurrency && rule.currency !== offerCurrency) return false;
            // Unknown amount ⇒ amount-bearing rules still apply (fail-closed).
            if (!knownAmount) return true;
            if (rule.minAmount != null && numericAmount < rule.minAmount) return false;
            if (rule.maxAmount != null && numericAmount > rule.maxAmount) return false;
            return true;
        })
        .sort((a, b) => a.stepOrder - b.stepOrder);

    // A policy that filters every rule away is a policy with no approver, which
    // would let any offer be sent unapproved. Escalate to the default instead.
    if (steps.length === 0) {
        return { steps: DEFAULT_OFFER_APPROVAL_RULES.map((r) => ({ ...r })), source: "DEFAULT" };
    }
    return { steps, source: "TEMPLATE" };
}
