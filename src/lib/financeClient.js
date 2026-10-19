// src/lib/financeClient.js
//
// The client for the Finance service contract (hr-data/recruitment/
// finance-interface-contract.md) — decision B1.1/B1.2: contract-first, so the
// future service carries it smoothly because the calls, headers, response
// fields and failure semantics are already pinned here.
//
// ACTIVATION-GATED (contract §6):
//   * FINANCE_SERVICE_URL unset  → mode "off": every check returns
//     { mode: "off", checked: false, valid: null }. No outbound call, no
//     timeout, no behavior change — the pre-contract posture (reference
//     presence + fail-closed amount gate) is exactly what runs.
//   * FINANCE_VALIDITY_MODE=advisory → results are recorded and surfaced but
//     never block.
//   * FINANCE_VALIDITY_MODE=enforce → an INVALID/CLOSED cost center blocks;
//     an UNREACHABLE one does not (availability ≠ validity, contract §6) and
//     records "unverifiable".
//
// AUTH mirrors notificationClient.js / rbac.client.js: X-Internal-Secret + a
// signed service JWT (EdDSA) + the ambient tenant header. Finance derives the
// tenant from the VERIFIED credential — never from a body field.
//
// NO local fallback, NO shadow table, NO id normalization (contract §6): if
// the reference is unknown to Finance the answer is invalid/unverifiable,
// never a guess.
import axios from "axios";
import { signServiceJwtEdDSA, ambientTenantHeader } from "./serviceJwt.js";

const FINANCE_BASE_URL = process.env.FINANCE_SERVICE_URL || "";
const FINANCE_TIMEOUT = parseInt(process.env.FINANCE_TIMEOUT || "5000", 10);
const FINANCE_MODE = () =>
    String(process.env.FINANCE_VALIDITY_MODE || (FINANCE_BASE_URL ? "advisory" : "off")).toLowerCase();

const financeApi = FINANCE_BASE_URL
    ? axios.create({ baseURL: FINANCE_BASE_URL, timeout: FINANCE_TIMEOUT })
    : null;

const withInternalAuth = (tenantId) => ({
    ...ambientTenantHeader(),
    "X-Internal-Secret": process.env.INTERNAL_SERVICE_SECRET,
    Authorization: `Bearer ${signServiceJwtEdDSA()}`,
    ...(tenantId ? { "X-Tenant-Id": tenantId } : {}),
});

const unchecked = (mode, reason) => ({ mode, checked: false, valid: null, reason });

/**
 * Is the requisition's cost-center reference VALID — i.e. does it resolve to an
 * OPEN Finance cost center (contract §2)? A null/blank reference is "absent"
 * (the mandatory-field gate owns that refusal, not this check).
 *
 * @param {string} tenantId
 * @param {string|null} costCenterRef  the requisition's Finance-owned reference
 * @param {Date|null} [at]             "now" for the validFrom/validTo window
 * @returns {Promise<{mode: string, checked: boolean, valid: boolean|null,
 *   state?: string, costCenter?: object, reason?: string}>}
 *   valid: true (OPEN + inside window) | false (unknown/closed/outside window)
 *   | null (not checked or unreachable).
 */
export const checkCostCenterValidity = async (tenantId, costCenterRef, at = new Date()) => {
    const mode = FINANCE_MODE();
    if (mode === "off" || !financeApi) return unchecked(mode, "finance-service-not-configured");
    const ref = String(costCenterRef || "").trim();
    if (!ref) return unchecked(mode, "no-cost-center-reference");

    try {
        const res = await financeApi.get(`/api/v1/cost-centers/${encodeURIComponent(ref)}`, {
            headers: withInternalAuth(tenantId),
        });
        const cc = res.data ?? {};
        const windowOk =
            (!cc.validFrom || new Date(cc.validFrom) <= at) && (!cc.validTo || new Date(cc.validTo) >= at);
        const valid = cc.status === "OPEN" && windowOk;
        return {
            mode,
            checked: true,
            valid,
            state: valid ? "valid" : cc.status === "OPEN" ? "outside-validity-window" : `not-open-${String(cc.status).toLowerCase()}`,
            costCenter: { costCenterId: cc.costCenterId, name: cc.name, status: cc.status, currency: cc.currency },
        };
    } catch (err) {
        if (err?.response?.status === 404 || err?.response?.status === 410) {
            // A definitive Finance answer: the reference does not resolve. This is
            // an INVALID result, not an outage — enforce mode may block on it.
            return { mode, checked: true, valid: false, state: "unknown-to-finance" };
        }
        // Transport/auth/5xx — UNREACHABLE. Never treated as invalid.
        return { mode, checked: false, valid: null, state: "unverifiable", reason: err?.response ? `finance-${err.response.status}` : "finance-unreachable" };
    }
};

/**
 * Budget + headcount availability for a cost center (contract §3). Both answers
 * are ADVISORY by design: the budgetedAmount fail-closed amount gate and the
 * approval chain own the blocking decisions; this read ENRICHES the approval
 * snapshot. Meaningful nulls (unbudgeted / no workforce plan) pass through —
 * never zeroed, never unlimited.
 *
 * @returns {Promise<{mode: string, checked: boolean, budget?: object,
 *   headcount?: object, fiscalYear?: number, asOf?: string, reason?: string}>}
 */
export const fetchBudgetAndHeadcount = async (tenantId, costCenterRef, { fiscalYear } = {}) => {
    const mode = FINANCE_MODE();
    if (mode === "off" || !financeApi) return { mode, checked: false, reason: "finance-service-not-configured" };
    const ref = String(costCenterRef || "").trim();
    if (!ref) return { mode, checked: false, reason: "no-cost-center-reference" };

    try {
        const res = await financeApi.get("/api/v1/budgets", {
            headers: withInternalAuth(tenantId),
            params: { costCenterId: ref, ...(fiscalYear ? { fiscalYear } : {}), headcountPlan: 1 },
        });
        return { mode, checked: true, budget: res.data?.budget ?? null, headcount: res.data?.headcount ?? null, fiscalYear: res.data?.fiscalYear ?? null, asOf: res.data?.asOf ?? null };
    } catch (err) {
        return { mode, checked: false, reason: err?.response ? `finance-${err.response.status}` : "finance-unreachable" };
    }
};

/** Is enforce mode actually able to block? (off/unreachable never block.) */
export const financeValidityEnforced = () => {
    const mode = FINANCE_MODE();
    return mode === "enforce" && Boolean(financeApi);
};
